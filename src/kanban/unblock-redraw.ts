import { CARD_GONE_CODES, ChannelError, type Channel } from '../channel/types.js';
import { formatWall } from '../cron/schedule.js';
import { unblockMessage, unblockMessagesDue } from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import { redactKnownSecrets } from '../secrets.js';
import { systemClock, type Clock } from '../time.js';
import { renderUnblockRedraw, type NameOf } from './chat-render.js';
import { NOTICE_SEND_MS } from './notices.js';
import type { KanbanService } from './service.js';

/**
 * The unblock redraw (spec §9.2, amended): a message of notices whose Unblock
 * buttons the notifier recorded is redrawn once a block it offered Unblock for
 * is lifted, by any path -- a press, chat's `/kanban task unblock`, the
 * terminal's `mt kanban task unblock`, an agent's mt -- with a line in place of
 * that button, "Unblocked by <name> at HH:MM", and its other buttons as they were.
 * A task archived while blocked has its block cleared with no `unblocked`
 * event, so its archive counts as the lift: "Archived by <name> at HH:MM". The
 * time is MM-DD HH:MM when its day is not the day the message was sent.
 *
 * **A loop over the log, not a hook at each call site.** The terminal and an
 * agent's mt unblock from other processes, writing the database, so rather than
 * be told, the loop looks every `REDRAW_POLL_MS` for a recorded button whose
 * task has an `unblocked` event past the event that blocked it, and that has not
 * been redrawn for it. Each row's block event is its own cursor into the log, so
 * an unblock made while the gateway was down is redrawn after it starts, and a
 * message recorded after its block was lifted is redrawn too.
 *
 * **Rebuilt from the record.** The message's text is kept as it was sent, so the
 * redraw is that text, then a line for each block lifted; every button's value
 * is rebuilt from its task and block event, as the notifier made it.
 *
 * **One redraw a message at a time.** A press's redraw waits for the loop's of
 * the same message, and reads the record and the log only when its turn comes,
 * so the older view never lands last.
 *
 * **Tried again until it lands.** An update is bounded by `redrawTimeoutMs`,
 * `REDRAW_UPDATE_MS` unless a test says otherwise, and one that fails or takes
 * longer is said in the log. One that landed, or that Lark refused and will
 * refuse again (a nonzero code it does not mark retryable, or a card that is
 * gone), has its rows marked as redrawn for the lifts it drew, and the loop is
 * done with it. One that timed out, got no answer, or was refused as retryable
 * is left unmarked, and the loop tries it again after a pause, in memory, of
 * `RETRY_PAUSE_MS` doubling at each try, or the time Lark asked for when
 * longer; after `REDRAW_TRIES` in a row that did not land, it is marked, with a
 * line in the log. A press's redraw (`redrawMessage`) counts the same. An
 * error that is no ChannelError is our own fault, not Lark's, and is taken as a
 * refusal. A message whose rows are all marked already, as one redrawn again
 * for a press or over an older view that landed late, is not in the database's
 * due list, so the loop also tries the ones in memory whose pause is over.
 *
 * **A round stops at a timeout.** Once one update in a round times out, Lark
 * is taken to be hanging, and the rest of the round waits for the next, so a
 * round takes at most one bound, not `ROUND_REDRAWS` of them.
 *
 * **Once stopped**, nothing more is redrawn, and nothing is marked: an update
 * that lands after the stop, in its bound or late, is only said, and the next
 * boot finds its rows still due.
 *
 * **A late answer.** An update that timed out may land later: that is said
 * once, and a landing marks the lifts that update drew, and only those, passed
 * explicitly, so a lift made since stays due. A message is redrawn one at a
 * time, but a timed-out update no longer holds its turn, so a newer view may
 * be sent while it is out: should the older land after a newer one was sent,
 * the message is redrawn again, through its turn, so the newer view is the one
 * left on the card.
 */

/** How often the loop looks for a lifted block whose message has not been redrawn. */
export const REDRAW_POLL_MS = 2_000;
/** Messages redrawn in one round; the rest wait for the next. */
export const ROUND_REDRAWS = 10;
/** How long an update is waited for: as long as a notice's send. */
export const REDRAW_UPDATE_MS = NOTICE_SEND_MS;
/** The pause before a redraw that did not land is tried again, doubling at each try. */
export const RETRY_PAUSE_MS = 2_000;
/** Tries in a row that did not land, after which a redraw is marked done all the same. */
export const REDRAW_TRIES = 5;

type Lift = { taskId: string; liftEvent: number };

/** What came of an update within its bound. */
type Outcome = { kind: 'drawn' } | { kind: 'failed'; err: unknown } | { kind: 'late'; ms: number };

/**
 * Lark refused it, and will again (as the card poster's and progress cards' refusal), or its card
 * is gone; or the update threw something that is no ChannelError, a fault of ours a retry would
 * only meet again.
 */
function refusal(err: unknown): boolean {
  if (!(err instanceof ChannelError)) return true;
  return (err.code !== 0 && !err.retryable) || CARD_GONE_CODES.has(err.code);
}

export interface UnblockRedrawDeps {
  db: Db;
  service: KanbanService;
  /** Where a recorded message's channel id redraws: `lark` to the Lark adapter. */
  channels: ReadonlyMap<string, Channel>;
  /** This bot: only its messages are redrawn here. */
  appId: string;
  /** What the line calls a person: the people directory's chat name. */
  nameOf?: NameOf;
  /** The zone HH:MM is said in: `cron.tz`, else the process's. */
  zone: string;
  /** Metadata only: ids, never task text. */
  note?: (line: string) => void;
  /** How long an update is waited for; `REDRAW_UPDATE_MS` unless a test says otherwise. */
  redrawTimeoutMs?: number;
  /** When a redraw's pause is over. */
  clock?: Clock;
}

function message(err: unknown): string {
  return redactKnownSecrets(err instanceof Error ? err.message : String(err));
}

export class UnblockRedraws {
  readonly #deps: UnblockRedrawDeps;
  readonly #note: (line: string) => void;
  /**
   * The latest redraw of each message under way, which the next of that message
   * waits for: one at a time a message, each reading the record and the log
   * when its turn comes, so a newer view never lands before an older one. The
   * loop passes over a message with one under way; a press waits its turn.
   */
  readonly #chains = new Map<string, Promise<unknown>>();
  readonly #pending = new Set<Promise<unknown>>();
  /** Each message whose last redraw did not land: its tries in a row, and when it is due again. */
  readonly #retries = new Map<string, { tries: number; dueAt: number }>();
  /** The latest update sent of each message with one out past its bound: what an older late landing is held up against. */
  readonly #sent = new Map<string, { seq: number; card: string; late: number }>();
  #seq = 0;
  readonly #clock: Clock;
  #round: Promise<number> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(deps: UnblockRedrawDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
    const note = deps.note ?? (() => undefined);
    this.#note = (line) => {
      try {
        note(line);
      } catch {
        // Nowhere left to say it.
      }
    };
  }

  /** Redraw every `REDRAW_POLL_MS`, starting now: the first round catches up after a restart. */
  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setInterval(() => void this.redrawDue(), REDRAW_POLL_MS);
    this.#timer.unref();
    void this.redrawDue();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Once no redraw is under way, or `boundMs` has passed: true once drained. */
  async idle(boundMs = this.#timeoutMs()): Promise<boolean> {
    const drained = (async () => {
      while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
      return true;
    })();
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), boundMs);
    });
    try {
      return await Promise.race([drained, bound]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One round, or the one under way: every recorded message with a block lifted
   * since it was last drawn, at most `ROUND_REDRAWS`, redrawn one at a time.
   * Resolves to how many were tried. Never rejects.
   */
  redrawDue(): Promise<number> {
    if (this.#round !== undefined) return this.#round;
    const round = this.#track(this.#redrawDueOnce())
      .catch((err: unknown) => {
        this.#note(`kanban: redrawing unblocked notices failed: ${message(err)}`);
        return 0;
      })
      .finally(() => {
        this.#round = undefined;
      });
    this.#round = round;
    return round;
  }

  async #redrawDueOnce(): Promise<number> {
    if (this.#stopped) return 0;
    const now = this.#clock.now();
    const passed = (messageId: string): boolean => this.#chains.has(messageId) || (this.#retries.get(messageId)?.dueAt ?? 0) > now;
    // Read past the ones passed over, so they never hold back the ones after them; at most a round is tried.
    const due = unblockMessagesDue(this.#deps.db, this.#deps.appId, ROUND_REDRAWS + this.#retries.size + this.#chains.size);
    // And a retry whose rows are all marked, which that list never holds: redrawn again for a press, or over an older view.
    const inDue = new Set(due);
    const retries = [...this.#retries.keys()].filter((m) => !inDue.has(m));
    let tried = 0;
    for (const messageId of [...due, ...retries]) {
      if (this.#stopped || tried >= ROUND_REDRAWS) break;
      if (passed(messageId)) continue;
      const timedOut = await this.#redraw(messageId);
      tried += 1;
      // Lark is hanging: the rest wait for the next round.
      if (timedOut) break;
    }
    return tried;
  }

  /**
   * Redraw one recorded message now, as its blocks stand: for a press of one of
   * its Unblock buttons, which lifted its block or found it lifted already.
   * Nothing for a message with no record, nor once stopped. Never rejects.
   */
  redrawMessage(messageId: string): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    return this.#track(this.#redraw(messageId).then(() => undefined)).catch((err: unknown) => {
      this.#note(`kanban: redrawing notice ${messageId} failed: ${message(err)}`);
    });
  }

  #track<T>(work: Promise<T>): Promise<T> {
    this.#pending.add(work);
    void work.then(
      () => this.#pending.delete(work),
      () => this.#pending.delete(work),
    );
    return work;
  }

  /** A redraw of the message, once the one before it, if any, has settled: whether its update timed out. Never rejects. */
  #redraw(messageId: string): Promise<boolean> {
    const before = this.#chains.get(messageId) ?? Promise.resolve();
    const step = before.then(() => this.#redrawNow(messageId)).catch((err: unknown) => {
      this.#note(`kanban: redrawing notice ${messageId} failed: ${message(err)}`);
      return false;
    });
    this.#chains.set(messageId, step);
    void step.finally(() => {
      if (this.#chains.get(messageId) === step) this.#chains.delete(messageId);
    });
    return step;
  }

  /** Rebuild the message from its record and the log as they are now, redraw it within the bound, and mark it once it is done with. */
  async #redrawNow(messageId: string): Promise<boolean> {
    if (this.#stopped) return false;
    const read = unblockMessage(this.#deps.db, this.#deps.appId, messageId);
    if (read === undefined) {
      this.#retries.delete(messageId);
      return false;
    }
    const lifts = read.buttons.flatMap((b) => (b.lift === undefined ? [] : [{ taskId: b.taskId, liftEvent: b.lift.eventId }]));
    const channel = this.#deps.channels.get(read.channel);
    if (channel === undefined) {
      this.#note(`kanban: notice ${messageId} cannot be redrawn: no channel ${read.channel}`);
      this.#done(messageId, lifts);
      return false;
    }
    let card;
    try {
      const view = renderUnblockRedraw(
        this.#deps.appId,
        read.markdown,
        read.buttons,
        (ms) => this.#when(ms, read.sentAt),
        this.#deps.nameOf,
      );
      card = { ...view, markdown: redactKnownSecrets(view.markdown) };
    } catch (err) {
      this.#note(`kanban: redrawing notice ${messageId} failed: ${message(err)}`);
      this.#done(messageId, lifts);
      return false;
    }
    const seq = ++this.#seq;
    const drawn = JSON.stringify(card);
    const out = this.#sent.get(messageId);
    if (out !== undefined) {
      out.seq = seq;
      out.card = drawn;
    }
    const startedAt = this.#clock.now();
    // An update that throws at once is a failed update, said like any other.
    const update = Promise.resolve().then(() => channel.updateCard(messageId, card));
    const outcome = await this.#bounded(update);
    if (outcome.kind === 'late') {
      this.#note(`kanban: redrawing notice ${messageId} took longer than ${outcome.ms} ms; trying it again later`);
      this.#late(messageId, update, { seq, card: drawn, startedAt, lifts });
      if (!this.#stopped) this.#notLanded(messageId, lifts, `took longer than ${outcome.ms} ms`);
      return true;
    }
    if (outcome.kind === 'failed') this.#note(`kanban: redrawing notice ${messageId} failed: ${message(outcome.err)}`);
    // Once stopped, the database may be closing: the next boot finds it still due.
    if (this.#stopped) return false;
    if (outcome.kind === 'drawn' || refusal(outcome.err)) this.#done(messageId, lifts);
    else this.#notLanded(messageId, lifts, message(outcome.err), outcome.err instanceof ChannelError ? outcome.err.retryAfterMs : undefined);
    return false;
  }

  /** Landed, refused, or given up on: its rows marked for the lifts drawn, and the loop done with it for them. */
  #done(messageId: string, lifts: readonly Lift[]): void {
    this.#retries.delete(messageId);
    this.#mark(messageId, lifts);
  }

  /** Not landed: tried again by the loop after its pause, or, after `REDRAW_TRIES` in a row, marked all the same. */
  #notLanded(messageId: string, lifts: readonly Lift[], why: string, retryAfterMs?: number): void {
    // Nothing lifted, nothing the loop would try it again for.
    if (lifts.length === 0) {
      this.#retries.delete(messageId);
      return;
    }
    const tries = (this.#retries.get(messageId)?.tries ?? 0) + 1;
    if (tries >= REDRAW_TRIES) {
      this.#note(`kanban: notice ${messageId} was not redrawn after ${tries} tries: ${why}`);
      this.#done(messageId, lifts);
      return;
    }
    const pause = Math.max(RETRY_PAUSE_MS * 2 ** (tries - 1), retryAfterMs ?? 0);
    this.#retries.set(messageId, { tries, dueAt: this.#clock.now() + pause });
  }

  /**
   * An update past its bound, said once it settles. A landing marks the lifts
   * it drew, and only those; and should a newer view of the message have been
   * sent since, the message is redrawn again through its turn, as the older
   * view may have landed over it.
   */
  #late(messageId: string, update: Promise<void>, sent: { seq: number; card: string; startedAt: number; lifts: readonly Lift[] }): void {
    const out = this.#sent.get(messageId) ?? { seq: sent.seq, card: sent.card, late: 0 };
    out.late += 1;
    this.#sent.set(messageId, out);
    const settled = (): void => {
      out.late -= 1;
      if (out.late === 0 && this.#sent.get(messageId) === out) this.#sent.delete(messageId);
    };
    update.then(
      () => {
        this.#note(`kanban: redrawing notice ${messageId} landed after ${this.#clock.now() - sent.startedAt} ms`);
        const newer = out.seq > sent.seq && out.card !== sent.card;
        settled();
        // Once stopped, the database may be closing: the next boot finds it still due.
        if (this.#stopped) return;
        this.#done(messageId, sent.lifts);
        if (newer) void this.redrawMessage(messageId);
      },
      (err: unknown) => {
        this.#note(`kanban: redrawing notice ${messageId} failed after timing out: ${message(err)}`);
        settled();
      },
    );
  }

  #mark(messageId: string, lifts: readonly Lift[]): void {
    if (lifts.length === 0) return;
    try {
      const r = this.#deps.service.markUnblockRedrawn(messageId, lifts);
      if (!r.ok) this.#note(`kanban: marking notice ${messageId} as redrawn failed: ${r.message}`);
    } catch (err) {
      this.#note(`kanban: marking notice ${messageId} as redrawn failed: ${message(err)}`);
    }
  }

  #timeoutMs(): number {
    return this.#deps.redrawTimeoutMs ?? REDRAW_UPDATE_MS;
  }

  /** HH:MM in the zone, or MM-DD HH:MM when the lift's day there is not the day the message was sent. */
  #when(ms: number, sentAt: number): string {
    const at = formatWall(this.#deps.zone, ms);
    return at.slice(0, 10) === formatWall(this.#deps.zone, sentAt).slice(0, 10) ? at.slice(11) : at.slice(5);
  }

  /** An update, waited for at most `redrawTimeoutMs`: what came of it, never thrown. */
  async #bounded(update: Promise<void>): Promise<Outcome> {
    const ms = this.#timeoutMs();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'late', ms }), ms);
    });
    try {
      return await Promise.race([update.then((): Outcome => ({ kind: 'drawn' })), late]);
    } catch (err) {
      return { kind: 'failed', err };
    } finally {
      clearTimeout(timer);
      update.catch(() => undefined);
    }
  }
}
