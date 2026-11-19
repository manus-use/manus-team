import type { Channel } from '../channel/types.js';
import { formatWall } from '../cron/schedule.js';
import { unblockMessage, unblockMessagesDue } from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import { redactKnownSecrets } from '../secrets.js';
import { renderUnblockRedraw, type NameOf } from './chat-render.js';
import { REDRAW_MS } from './chat.js';
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
 * **Best effort, once.** A redraw is bounded by `redrawTimeoutMs`, and one that
 * fails or takes longer is said in the log; either way its rows are marked as
 * redrawn for that lift, and it is never tried again by the loop. A press on a
 * card whose block is lifted redraws it again, at once (`redrawMessage`).
 */

/** How often the loop looks for a lifted block whose message has not been redrawn. */
export const REDRAW_POLL_MS = 2_000;
/** Messages redrawn in one round; the rest wait for the next. */
export const ROUND_REDRAWS = 10;

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
  /** How long a redraw is waited for; `REDRAW_MS` unless a test says otherwise. */
  redrawTimeoutMs?: number;
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
  readonly #chains = new Map<string, Promise<void>>();
  readonly #pending = new Set<Promise<unknown>>();
  #round: Promise<number> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(deps: UnblockRedrawDeps) {
    this.#deps = deps;
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
  async idle(boundMs = this.#deps.redrawTimeoutMs ?? REDRAW_MS): Promise<boolean> {
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
    let tried = 0;
    for (const messageId of unblockMessagesDue(this.#deps.db, this.#deps.appId, ROUND_REDRAWS)) {
      if (this.#stopped) break;
      if (this.#chains.has(messageId)) continue;
      await this.#redraw(messageId);
      tried += 1;
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
    return this.#track(this.#redraw(messageId)).catch((err: unknown) => {
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

  /** A redraw of the message, once the one before it, if any, has settled; never rejects. */
  #redraw(messageId: string): Promise<void> {
    const before = this.#chains.get(messageId) ?? Promise.resolve();
    const step = before.then(() => this.#redrawNow(messageId)).catch((err: unknown) => {
      this.#note(`kanban: redrawing notice ${messageId} failed: ${message(err)}`);
    });
    this.#chains.set(messageId, step);
    void step.finally(() => {
      if (this.#chains.get(messageId) === step) this.#chains.delete(messageId);
    });
    return step;
  }

  /** Rebuild the message from its record and the log as they are now, redraw it within the bound, and mark what it was drawn for. */
  async #redrawNow(messageId: string): Promise<void> {
    const read = unblockMessage(this.#deps.db, this.#deps.appId, messageId);
    if (read === undefined) return;
    const lifts = read.buttons.flatMap((b) => (b.lift === undefined ? [] : [{ taskId: b.taskId, liftEvent: b.lift.eventId }]));
    try {
      const channel = this.#deps.channels.get(read.channel);
      if (channel === undefined) {
        this.#note(`kanban: notice ${messageId} cannot be redrawn: no channel ${read.channel}`);
        return;
      }
      const view = renderUnblockRedraw(
        this.#deps.appId,
        read.markdown,
        read.buttons,
        (ms) => this.#when(ms, read.sentAt),
        this.#deps.nameOf,
      );
      // A redraw that throws at once is a failed redraw, said like any other.
      await this.#bounded(messageId, Promise.resolve().then(() => channel.updateCard(messageId, { ...view, markdown: redactKnownSecrets(view.markdown) })));
    } finally {
      // Tried once, drawn or not: the loop never tries it again for these lifts.
      try {
        const r = this.#deps.service.markUnblockRedrawn(messageId, lifts);
        if (!r.ok) this.#note(`kanban: marking notice ${messageId} as redrawn failed: ${r.message}`);
      } catch (err) {
        this.#note(`kanban: marking notice ${messageId} as redrawn failed: ${message(err)}`);
      }
    }
  }

  /** HH:MM in the zone, or MM-DD HH:MM when the lift's day there is not the day the message was sent. */
  #when(ms: number, sentAt: number): string {
    const at = formatWall(this.#deps.zone, ms);
    return at.slice(0, 10) === formatWall(this.#deps.zone, sentAt).slice(0, 10) ? at.slice(11) : at.slice(5);
  }

  /** A redraw, waited for at most `redrawTimeoutMs`; a failure or a timeout is said, never thrown. */
  async #bounded(messageId: string, update: Promise<void>): Promise<void> {
    const ms = this.#deps.redrawTimeoutMs ?? REDRAW_MS;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), ms);
    });
    try {
      if ((await Promise.race([update.then(() => 'drawn' as const), late])) === 'late') {
        this.#note(`kanban: redrawing notice ${messageId} took longer than ${ms} ms; going on without it`);
      }
    } catch (err) {
      this.#note(`kanban: redrawing notice ${messageId} failed: ${message(err)}`);
    } finally {
      clearTimeout(timer);
      update.catch(() => undefined);
    }
  }
}
