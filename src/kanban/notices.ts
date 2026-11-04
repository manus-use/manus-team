import { ChannelError, type Channel, type SendTarget } from '../channel/types.js';
import { noticeBatchUuid } from '../core/ids.js';
import { dueSubscriptions, eventsAfter, getTask, type DueSubscription } from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import { redactKnownSecrets } from '../secrets.js';
import { systemClock, type Clock } from '../time.js';
import { renderNotice } from './chat-render.js';
import type { KanbanService } from './service.js';
import type { KanbanEvent, SubscriptionRow } from './types.js';

/**
 * Subscriptions' notices (spec §9.4): what a chat following a task hears.
 *
 * **Delivery is a projection over `kanban_events`, from a cursor.** Each round
 * reads the subscriptions with an event past their cursor, groups them by the
 * conversation -- chat, or thread -- they deliver to, and sends each
 * conversation at most one message: that round's notices for all its
 * subscriptions, in event order, at most `BATCH_NOTICES` of them. Once the send
 * succeeded, each subscription's cursor moves past what the message covered,
 * and past the events that are no notice. After a restart the first round
 * starts from the cursors in the database, so catching up after an outage is the
 * same code as delivering in normal running.
 *
 * **At least once.** A send that fails moves no cursor. A batch's uuid is derived
 * from the set of (subscription, event) pairs it covers, so the same batch sent
 * again after a restart carries the same uuid, and a channel that deduplicates
 * by uuid shows it once. (The Lark adapter does not pass the uuid on yet; see
 * its note.)
 *
 * **A conversation that cannot be reached is let go of.** A send refused as
 * unreachable -- `UNREACHABLE_CODES`: the bot is not in the chat -- or failing
 * `DEAD_AFTER` times in a row at the longest pause, drops the notices it held,
 * says so once, and marks the conversation dead until the gateway restarts: its
 * later events are passed over without a send. A send that fails otherwise holds
 * the conversation back for a pause that doubles, up to five minutes, while the
 * others go on: a network failure, which the Lark adapter reports as code 0 and
 * not retryable, and a refusal of one bad batch, are not a dead chat. A send that
 * takes longer than `NOTICE_SEND_MS` counts as a failed one. A round sends to at
 * most `ROUND_SENDS` conversations, the longest waiting first, so a restart that finds many conversations due -- dead
 * ones among them -- spreads their sends over rounds rather than firing all at once.
 *
 * The board's writes come from chat, the worker socket and the dispatcher, so
 * rather than be told of each, the notifier looks every `NOTICE_POLL_MS`: a cheap
 * read when nothing is due.
 */

/** How often a round looks for notices to send. */
export const NOTICE_POLL_MS = 2_000;
/** The longest a conversation whose sends fail waits before it is tried again. */
export const NOTICE_BACKOFF_MAX_MS = 5 * 60_000;
/** Failures in a row at the longest pause after which a conversation is let go of. */
export const DEAD_AFTER = 3;
/** Notices in one message; the rest follow in the next round. */
export const BATCH_NOTICES = 20;
/** Characters in one message, so a batch is not cut by the channel. */
const BATCH_CHARS = 3_800;
/** Conversations sent to in one round. */
export const ROUND_SENDS = 10;
/** Events read for one subscription in one round; the rest wait for the next. */
export const ROUND_EVENTS = 100;
/** The longest a send is waited for; past it, it counts as failed. */
export const NOTICE_SEND_MS = 30_000;

/**
 * Lark's codes that mean this chat cannot be posted to by this bot, whatever is
 * sent: the only refusals that let a conversation go at once. 230002 is "the bot
 * is not in the chat". Lark has codes for a chat not found or disbanded too, but
 * they are not confirmed against anything in this repository or its SDK, so
 * they are left out: such a chat is let go of after `DEAD_AFTER` failures instead.
 */
export const UNREACHABLE_CODES: ReadonlySet<number> = new Set([230002]);

export interface NotifierDeps {
  db: Db;
  service: KanbanService;
  /** Where a subscription's channel id sends: `lark` to the Lark adapter. */
  channels: ReadonlyMap<string, Channel>;
  /** This bot: only its subscriptions are delivered here. */
  appId: string;
  /** `kanban.block_recurrence_limit` (spec §5.4). */
  blockRecurrenceLimit: number;
  clock?: Clock;
  /** Metadata only: ids and counts, never task text. */
  note?: (line: string) => void;
  /** How long a send is waited for; `NOTICE_SEND_MS` unless a test says otherwise. */
  sendTimeoutMs?: number;
}

/** One conversation's due subscriptions, and what each has to say this round. */
interface Conversation {
  key: string;
  channel: string;
  target: SendTarget;
  subs: DueSubscription[];
}

/** A subscription's events this round, and the notices among them. */
interface Pending {
  sub: SubscriptionRow;
  events: KanbanEvent[];
  notices: Array<{ event: KanbanEvent; text: string }>;
}

function conversationKey(sub: SubscriptionRow): string {
  return [sub.channel, sub.conversationId, sub.threadId].join('\u0000');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Notifier {
  readonly #deps: NotifierDeps;
  readonly #clock: Clock;
  readonly #note: (line: string) => void;
  /** Held back after a failure: by conversation key, or by subscription id for one that could not be read. */
  readonly #backoff = new Map<string, { until: number; waitMs: number; atMax: number }>();
  /** Conversations let go of until the gateway restarts. */
  readonly #dead = new Set<string>();
  #round: Promise<number> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(deps: NotifierDeps) {
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

  /** Deliver every `NOTICE_POLL_MS`, starting now: the first round is the catch-up after a restart. */
  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setInterval(() => void this.deliver(), NOTICE_POLL_MS);
    this.#timer.unref();
    void this.deliver();
  }

  /** No more rounds; one under way stops after its current send. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Once the round under way, if any, is over, or `boundMs` has passed: for
   * shutdown, before the channel disconnects and the database closes. True once
   * the round is over.
   */
  async idle(boundMs = this.#deps.sendTimeoutMs ?? NOTICE_SEND_MS): Promise<boolean> {
    const round = this.#round;
    if (round === undefined) return true;
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), boundMs);
    });
    try {
      return await Promise.race([round.then(() => true), bound]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One round, or the one already under way: never two at once, which could send
   * a notice twice. Resolves to the notices sent. Never rejects: a failure is
   * noted, and the next round tries again.
   */
  deliver(): Promise<number> {
    if (this.#round !== undefined) return this.#round;
    const round = this.#deliverOnce()
      .catch((err: unknown) => {
        this.#note(`kanban: delivering notices failed: ${message(err)}`);
        return 0;
      })
      .finally(() => {
        this.#round = undefined;
      });
    this.#round = round;
    return round;
  }

  async #deliverOnce(): Promise<number> {
    if (this.#stopped) return 0;
    const byKey = new Map<string, Conversation>();
    for (const sub of dueSubscriptions(this.#deps.db, this.#deps.appId)) {
      const key = conversationKey(sub);
      const c = byKey.get(key) ?? {
        key,
        channel: sub.channel,
        target: { chatId: sub.conversationId, threadId: sub.threadId },
        subs: [],
      };
      c.subs.push(sub);
      byKey.set(key, c);
    }
    // The longest waiting first, so a busy conversation cannot keep a quiet one waiting.
    const conversations = [...byKey.values()].sort((a, b) => oldest(a) - oldest(b));
    let sent = 0;
    let sends = 0;
    for (const c of conversations) {
      if (this.#stopped) break;
      if (this.#held(c.key)) continue;
      try {
        const r = await this.#deliverTo(c, sends < ROUND_SENDS);
        sent += r.notices;
        if (r.sent) sends += 1;
      } catch (err) {
        // One conversation's failure -- a read, a render -- is that conversation's.
        this.#fail(c, err);
      }
    }
    return sent;
  }

  /**
   * One conversation: its subscriptions' notices in event order, sent as one
   * message when `maySend`, and every cursor moved past what that covered.
   */
  async #deliverTo(c: Conversation, maySend: boolean): Promise<{ notices: number; sent: boolean }> {
    const pending: Pending[] = [];
    for (const sub of c.subs) {
      if (this.#held(`sub:${sub.id}`)) continue;
      try {
        pending.push(this.#read(sub));
      } catch (err) {
        // One subscription that cannot be read does not hold up its neighbours.
        this.#holdBack(`sub:${sub.id}`, `subscription ${sub.id} of task ${sub.taskId}`, message(err));
      }
    }
    // A subscription read only its first ROUND_EVENTS: events past the last it read
    // may come after another's notices, so nothing past that point goes this round.
    const capped = pending.filter((p) => p.events.length >= ROUND_EVENTS).map((p) => p.events.at(-1)?.id ?? 0);
    const readTo = capped.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...capped);
    const all = pending
      .flatMap((p) => p.notices.map((n) => ({ ...n, sub: p.sub })))
      .filter((n) => n.event.id <= readTo)
      .sort((a, b) => a.event.id - b.event.id);
    if (this.#dead.has(c.key)) {
      // Let go of until a restart: passed over, without a send.
      this.#advanceAll(pending, readTo);
      return { notices: 0, sent: false };
    }
    if (all.length === 0) {
      this.#advanceAll(pending, readTo);
      return { notices: 0, sent: false };
    }
    const channel = this.#deps.channels.get(c.channel);
    if (channel === undefined) {
      this.#holdBack(c.key, describe(c), `no channel ${c.channel}`);
      return { notices: 0, sent: false };
    }
    if (!maySend) return { notices: 0, sent: false };
    const batch: typeof all = [];
    let chars = 0;
    for (const n of all) {
      if (batch.length >= BATCH_NOTICES || (batch.length > 0 && chars + n.text.length + 2 > BATCH_CHARS)) break;
      batch.push(n);
      chars += n.text.length + 2;
    }
    const more = all.length - batch.length;
    const text = [...batch.map((n) => n.text), ...(more > 0 ? [`… and ${more} more, in the next message.`] : [])].join('\n\n');
    // The last event the message covers: each cursor moves to it, notices or not.
    const upTo = more > 0 ? (batch.at(-1)?.event.id ?? 0) : readTo;
    try {
      await this.#bounded(
        channel.sendText(
          c.target,
          redactKnownSecrets(text),
          noticeBatchUuid(
            this.#deps.appId,
            batch.map((n) => [n.sub.id, n.event.id]),
          ),
        ),
      );
    } catch (err) {
      this.#sendFailed(c, pending, err);
      return { notices: 0, sent: true };
    }
    this.#backoff.delete(c.key);
    this.#advanceAll(pending, upTo);
    return { notices: batch.length, sent: true };
  }

  /**
   * A send, waited for at most `sendTimeoutMs`. A send that takes longer fails
   * here, and its batch is sent again later with the same uuid; the slow one may
   * still land, so at least once, as ever.
   */
  async #bounded<T>(send: Promise<T>): Promise<T> {
    const ms = this.#deps.sendTimeoutMs ?? NOTICE_SEND_MS;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      const took = ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
      timer = setTimeout(() => reject(new Error(`the send took longer than ${took}`)), ms);
    });
    try {
      return await Promise.race([send, late]);
    } finally {
      clearTimeout(timer);
      // A send that loses the race may still fail later; nobody is waiting for it.
      send.catch(() => undefined);
    }
  }

  /** A subscription's events past its cursor, and the notices among them. */
  #read(sub: SubscriptionRow): Pending {
    const task = getTask(this.#deps.db, sub.taskId);
    if (task === undefined) throw new Error(`task ${sub.taskId} is not on the board`);
    const events = eventsAfter(this.#deps.db, sub.taskId, sub.cursor, ROUND_EVENTS);
    const notices: Pending['notices'] = [];
    for (const event of events) {
      const text = renderNotice(event, task, { blockRecurrenceLimit: this.#deps.blockRecurrenceLimit });
      if (text !== undefined) notices.push({ event, text });
    }
    return { sub, events, notices };
  }

  /** Move each subscription's cursor to its last event at or before `upTo`. */
  #advanceAll(pending: readonly Pending[], upTo: number): void {
    for (const p of pending) {
      const last = p.events.filter((e) => e.id <= upTo).at(-1);
      if (last === undefined) continue;
      const moved = this.#deps.service.advanceSubscription(p.sub.id, last.id);
      if (!moved.ok) this.#holdBack(`sub:${p.sub.id}`, `subscription ${p.sub.id} of task ${p.sub.taskId}`, moved.message);
    }
  }

  /**
   * A send that failed: a refusal that will not change, or the last of
   * `DEAD_AFTER` at the longest pause, lets the conversation go -- its notices
   * dropped, said once -- and anything else holds it back for a while.
   */
  #sendFailed(c: Conversation, pending: readonly Pending[], err: unknown): void {
    // Only a refusal that names the chat as unreachable; code 0 is a network failure.
    const permanent = err instanceof ChannelError && UNREACHABLE_CODES.has(err.code);
    if (!permanent && next(this.#backoff.get(c.key)).atMax < DEAD_AFTER) {
      this.#holdBack(c.key, describe(c), message(err));
      return;
    }
    this.#dead.add(c.key);
    this.#backoff.delete(c.key);
    const dropped = pending.flatMap((p) => p.notices.map((n) => `${p.sub.taskId}#${n.event.id}`));
    this.#note(
      `kanban: ${describe(c)} cannot be reached (${message(err)}); dropping ${dropped.length} notice(s) ` +
        `(${dropped.join(', ')}) and passing over its notices until the gateway restarts`,
    );
    this.#advanceAll(pending, Number.POSITIVE_INFINITY);
  }

  #fail(c: Conversation, err: unknown): void {
    this.#holdBack(c.key, describe(c), message(err));
  }

  #held(key: string): boolean {
    const held = this.#backoff.get(key);
    return held !== undefined && this.#clock.now() < held.until;
  }

  /** Hold a conversation or a subscription back for a while, doubling each time, and say so. */
  #holdBack(key: string, what: string, why: string): void {
    const { waitMs, atMax } = next(this.#backoff.get(key));
    this.#backoff.set(key, { until: this.#clock.now() + waitMs, waitMs, atMax });
    this.#note(`kanban: notices for ${what} were not sent (${why}); trying again in ${Math.round(waitMs / 1000)} s`);
  }
}

/**
 * The pause after one more failure, doubling from 2 s to `NOTICE_BACKOFF_MAX_MS`,
 * and how many failures in a row have come at that longest pause.
 */
function next(held: { waitMs: number; atMax: number } | undefined): { waitMs: number; atMax: number } {
  const waitMs = Math.min((held?.waitMs ?? NOTICE_POLL_MS / 2) * 2, NOTICE_BACKOFF_MAX_MS);
  return { waitMs, atMax: waitMs === NOTICE_BACKOFF_MAX_MS ? (held?.atMax ?? 0) + 1 : 0 };
}

/** How long a conversation has waited: its oldest pending event's id. */
function oldest(c: Conversation): number {
  return Math.min(...c.subs.map((s) => s.oldestPending));
}

/** A conversation, by ids only: never task text. */
function describe(c: Conversation): string {
  const where = c.target.threadId === '' ? c.target.chatId : `${c.target.chatId}/${c.target.threadId}`;
  return `${where} (task${c.subs.length === 1 ? '' : 's'} ${c.subs.map((s) => s.taskId).join(', ')})`;
}
