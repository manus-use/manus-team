import { ChannelError, personTarget, type Channel, type SendResult, type SendTarget } from '../channel/types.js';
import { boardCardUuid } from '../core/ids.js';
import { cardsDue, subscriptionsOf, type CardReading } from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import { personOf } from '../db/people.js';
import { redactKnownSecrets } from '../secrets.js';
import { systemClock, type Clock } from '../time.js';
import { renderReviewCard, renderTaskCard, type CardFacts, type NameOf } from './chat-render.js';
import { Membership } from './members.js';
import { unionIdOf } from './people.js';
import type { KanbanService } from './service.js';
import type { RunRow } from './types.js';

/**
 * A person's cards (spec §9.2): when a person's run is claimed -- a task ready
 * for its assignee, or a review for its reviewer -- they are sent its card as a
 * direct message, by union_id, so they need not have opened a chat with the bot.
 *
 * **From the board, like the notices.** A round reads the open people's runs
 * that have no card recorded, sends each its card, and records `card_sent` with
 * the message, through the service. A run's card has one uuid, so one sent just
 * before a stop, and not yet recorded, is one message when it is sent again
 * after the restart. Every `CARD_POLL_MS`, one round at a time.
 *
 * **A card that cannot be sent.** Lark refusing because it cannot reach the
 * person -- one of `PERSON_UNREACHABLE_CODES` -- and a person who no longer has
 * talk tier, are recorded as `card_failed`, which the task's subscribers hear,
 * with how the person can answer from a chat instead; the run stays open, and is
 * never sent another card. Anything else -- any other refusal, a scope or token
 * Lark refuses among them, a network failure, a throttle that outlasted the
 * adapter's retries, a send not answered in `CARD_SEND_MS` -- is taken for the
 * gateway's problem, not the person's: the run is tried again after a pause that
 * doubles to five minutes, with a log line, for as long as it lasts.
 *
 * **A card sent and not recorded** is not sent again, in a loop that would
 * outlast the uuid's hour: the run is passed over until a restart, said once.
 *
 * **Where it goes** (spec §19.2), decided afresh at each try: in the task's
 * thread, mentioning the person, when the task has a thread with a root and
 * Lark's chat members API says they are in the group (`Membership`); by direct
 * message otherwise. A direct message that cannot reach them goes to the thread;
 * a card refused in the thread, whatever the code, goes by direct message, and
 * never to the top of the chat. One uuid per run, wherever it goes. `card_sent`
 * records where Lark's answer says it went. A task held while its "Created"
 * reply is under way (spec §19.4) is passed over, at each send.
 */

/** How often a round looks for cards to send. */
export const CARD_POLL_MS = 2_000;
/** The longest a run whose card could not be sent waits before it is tried again. */
export const CARD_BACKOFF_MAX_MS = 5 * 60_000;
/** The longest a send is waited for; past it, it counts as the gateway's failure. */
export const CARD_SEND_MS = 30_000;

/**
 * Lark's codes for a person a message cannot reach, which retrying cannot change:
 * the only refusals that record `card_failed`. 230013 is "the bot has no
 * availability to this user": the person is outside the app's availability. It
 * is from Lark's documentation of sending a message, not confirmed against
 * anything in this repository or its SDK.
 */
export const PERSON_UNREACHABLE_CODES: ReadonlySet<number> = new Set([230013]);

export interface CardPosterDeps {
  db: Db;
  service: KanbanService;
  /** The Lark adapter: a person's direct messages. */
  channel: Channel;
  /** This bot: a card's uuid and its buttons' nonces are bound to it. */
  appId: string;
  /** What a card calls a person, by the name Lark last gave. */
  nameOf?: NameOf;
  /** Whether a person still has talk tier: one who lost it is sent no card (spec §4.2). */
  canTalk?: (principal: string) => boolean;
  clock?: Clock;
  /** Metadata only: ids, never task text. */
  note?: (line: string) => void;
  /** How long a send, or a members lookup, is waited for; `CARD_SEND_MS` unless a test says otherwise. */
  sendTimeoutMs?: number;
  /** Whether a task is held while its "Created" reply is under way (spec §19.4): `KanbanChat`'s. */
  held?: (taskId: string) => boolean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Lark refused it, and will again: not a failure that never reached Lark, nor one it marks retryable, nor a timeout. */
function refusal(err: unknown): err is ChannelError {
  return err instanceof ChannelError && err.code !== 0 && !err.retryable;
}

/** Where a card was tried, and what came of it. */
type Sent = { ok: true; sent: SendResult } | { ok: false; err: unknown };

export class CardPoster {
  readonly #deps: CardPosterDeps;
  readonly #clock: Clock;
  readonly #note: (line: string) => void;
  /** Runs held back after a failed send, by run id: until when, and the pause that was. */
  readonly #backoff = new Map<string, { until: number; waitMs: number }>();
  /** Runs whose card was sent and could not be recorded: passed over until a restart. */
  readonly #unrecorded = new Set<string>();
  /** Who is in each group, for a card in a task's thread (spec §19.3). */
  readonly #members: Membership;
  #round: Promise<number> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(deps: CardPosterDeps) {
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
    this.#members = new Membership({
      channel: deps.channel,
      appId: deps.appId,
      timeoutMs: deps.sendTimeoutMs ?? CARD_SEND_MS,
      clock: this.#clock,
      note: this.#note,
    });
  }

  /** Send every `CARD_POLL_MS`, starting now: the first round sends what a restart left unsent. */
  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setInterval(() => void this.deliver(), CARD_POLL_MS);
    this.#timer.unref();
    void this.deliver();
  }

  /** No more rounds; one under way stops after its current send. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Once the round under way, if any, is over, or `boundMs` has passed: for shutdown. */
  async idle(boundMs = this.#deps.sendTimeoutMs ?? CARD_SEND_MS): Promise<boolean> {
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

  /** One round, or the one already under way; resolves to the cards sent. Never rejects. */
  deliver(): Promise<number> {
    if (this.#round !== undefined) return this.#round;
    const round = this.#deliverOnce()
      .catch((err: unknown) => {
        this.#note(`kanban: sending cards failed: ${message(err)}`);
        return 0;
      })
      .finally(() => {
        this.#round = undefined;
      });
    this.#round = round;
    return round;
  }

  async #deliverOnce(): Promise<number> {
    let sent = 0;
    for (const run of cardsDue(this.#deps.db)) {
      if (this.#stopped) break;
      if (this.#unrecorded.has(run.runId)) continue;
      const held = this.#backoff.get(run.runId);
      if (held !== undefined && this.#clock.now() < held.until) continue;
      try {
        if (await this.#post(run)) sent += 1;
      } catch (err) {
        // One run's failure -- a read, a render -- is that run's.
        this.#holdBack(run, message(err));
      }
    }
    return sent;
  }

  /** Send one run its card, where spec §19.2 says, and record it; true once it was sent. */
  async #post(run: RunRow): Promise<boolean> {
    // Its "Created" reply under way: passed over, as an unrecorded run is, until a later round.
    if (this.#deps.held?.(run.taskId) === true) return false;
    const unionId = unionIdOf(run.assignee.name);
    if (unionId === undefined) {
      this.#refused(run, `${run.assignee.name} is not a person Lark can be asked to message`);
      return false;
    }
    if (this.#deps.canTalk !== undefined && !this.#deps.canTalk(run.assignee.name)) {
      this.#refused(run, `${run.assignee.name} no longer has talk tier on this gateway`);
      return false;
    }
    const reading = this.#reading(run);
    if (reading === undefined) return false;
    const thread = this.#thread(run.taskId);
    // Rules 1 and 2: the thread for a member, a direct message for anyone else, or when the lookup failed.
    const first = thread !== undefined && (await this.#members.isMember(thread.chatId, unionId)) ? 'thread' : 'dm';
    const tried = await this.#send(run, reading, first === 'thread' ? thread : undefined, unionId);
    if (tried.ok) return this.#sent(run, tried.sent);
    if (!refusal(tried.err)) {
      // Rule 5: held back, and routed afresh at its next try.
      this.#holdBack(run, message(tried.err));
      return false;
    }
    if (first === 'thread') {
      // Rule 4: refused in the thread, whatever the code, it goes by direct message.
      this.#note(`kanban: the card of run ${run.runId} was refused in its task's thread (${message(tried.err)}); sending it by direct message`);
      const again = await this.#send(run, reading, undefined, unionId);
      if (again.ok) return this.#sent(run, again.sent);
      // Never back to the thread it was refused in: 230013 is recorded, with both reasons; anything else held back.
      if (again.err instanceof ChannelError && PERSON_UNREACHABLE_CODES.has(again.err.code)) {
        this.#refused(run, `${message(tried.err)}; and by direct message: ${message(again.err)}`);
        return false;
      }
      this.#holdBack(run, message(again.err));
      return false;
    }
    if (thread !== undefined && tried.err instanceof ChannelError && PERSON_UNREACHABLE_CODES.has(tried.err.code)) {
      // Rule 3: a person a direct message cannot reach gets it in the thread, member or not.
      this.#note(`kanban: the card of run ${run.runId} cannot reach its person by direct message (${message(tried.err)}); sending it in its task's thread`);
      const again = await this.#send(run, reading, thread, unionId);
      if (again.ok) return this.#sent(run, again.sent);
      if (!refusal(again.err)) {
        this.#holdBack(run, message(again.err));
        return false;
      }
      this.#refused(run, `${message(tried.err)}; and in the task's thread: ${message(again.err)}`);
      return false;
    }
    return this.#notSent(run, tried.err);
  }

  /**
   * The task's thread a card can go to (spec §19.4): this bot's subscription of
   * it, on this channel, when it is in a thread whose root is known. A task has
   * at most one per bot.
   */
  #thread(taskId: string): SendTarget | undefined {
    const sub = subscriptionsOf(this.#deps.db, taskId).find((s) => s.appId === this.#deps.appId && s.channel === this.#deps.channel.id);
    if (sub === undefined || sub.threadId === '' || sub.rootMessageId === null) return undefined;
    // A card is never moved to the top of the chat (spec §19.2): a refusal comes back here.
    return { chatId: sub.conversationId, threadId: sub.threadId, root: sub.rootMessageId, stayInThread: true };
  }

  /**
   * The card sent to the thread, mentioning its person by the open_id this bot
   * last noted for them, or else by direct message; with the run's one uuid
   * either way.
   */
  async #send(run: RunRow, reading: CardReading, thread: SendTarget | undefined, unionId: string): Promise<Sent> {
    const mention = thread === undefined ? undefined : personOf(this.#deps.db, this.#deps.appId, unionId)?.openId;
    const view = this.#render(run, reading, mention);
    try {
      const sent = await this.#bounded(
        this.#deps.channel.sendCard(
          thread ?? personTarget(unionId),
          // Masked once more as a whole, the mention in it, as every reply and notice is (spec §9.3).
          { ...view, markdown: redactKnownSecrets(view.markdown) },
          boardCardUuid(this.#deps.appId, run.runId),
        ),
      );
      return { ok: true, sent };
    } catch (err) {
      return { ok: false, err };
    }
  }

  /** A direct message not sent, as before threads: one Lark says cannot reach the person is recorded, anything else held back. */
  #notSent(run: RunRow, err: unknown): boolean {
    if (err instanceof ChannelError && PERSON_UNREACHABLE_CODES.has(err.code)) this.#refused(run, message(err));
    else this.#holdBack(run, message(err));
    return false;
  }

  /** A card sent: recorded, where Lark's answer says it is -- a direct message never has a thread. */
  #sent(run: RunRow, sent: SendResult): boolean {
    const { messageId } = sent;
    this.#backoff.delete(run.runId);
    let why: string | undefined;
    try {
      const recorded = this.#deps.service.recordCard(run.runId, { messageId, in: sent.threadId === undefined ? 'dm' : 'thread' });
      if (!recorded.ok) why = recorded.code;
    } catch (err) {
      why = message(err);
    }
    if (why !== undefined) {
      this.#unrecorded.add(run.runId);
      this.#note(`kanban: the card of run ${run.runId} was sent, and not recorded (${why}); not sending it again until the gateway restarts`);
    }
    return true;
  }

  /**
   * What the run's card shows, from the board as it is now; undefined when its
   * task is gone, or its run ended since the round read it: a card for it would
   * be out of date on arrival.
   */
  #reading(run: RunRow): CardReading | undefined {
    const reading = this.#deps.service.cardReading(run.runId);
    return reading === undefined || reading.run.endedAt !== null ? undefined : reading;
  }

  /** The run's card, mentioning its person when it goes in a thread (spec §19.2). */
  #render(run: RunRow, reading: CardReading, mention: string | undefined): ReturnType<typeof renderTaskCard> {
    const facts: CardFacts = {
      ...reading,
      ...(this.#deps.nameOf === undefined ? {} : { nameOf: this.#deps.nameOf }),
      ...(mention === undefined ? {} : { mention }),
    };
    return run.kind === 'review' ? renderReviewCard(facts, this.#deps.appId) : renderTaskCard(facts, this.#deps.appId);
  }

  /** A card Lark will not take: recorded once, which its subscribers hear, and never sent again. */
  #refused(run: RunRow, why: string): void {
    this.#backoff.delete(run.runId);
    const recorded = this.#deps.service.recordCard(run.runId, { error: why });
    this.#note(
      !recorded.ok
        ? `kanban: the card of run ${run.runId} cannot be sent (${why}), and that was not recorded (${recorded.code})`
        : recorded.recorded
          ? `kanban: the card of run ${run.runId} cannot be sent (${why}); its subscribers are told`
          : `kanban: the card of run ${run.runId} cannot be sent (${why}); its run is over, or its card was recorded already, so nobody is told`,
    );
  }

  /** Held back for a pause that doubles from 2 s to five minutes, and said so. */
  #holdBack(run: RunRow, why: string): void {
    const waitMs = Math.min((this.#backoff.get(run.runId)?.waitMs ?? CARD_POLL_MS / 2) * 2, CARD_BACKOFF_MAX_MS);
    this.#backoff.set(run.runId, { until: this.#clock.now() + waitMs, waitMs });
    this.#note(`kanban: the card of run ${run.runId} was not sent (${why}); trying again in ${Math.round(waitMs / 1000)} s`);
  }

  /** A send, waited for at most `sendTimeoutMs`; a slow one may still land, which its uuid makes one message. */
  async #bounded<T>(send: Promise<T>): Promise<T> {
    const ms = this.#deps.sendTimeoutMs ?? CARD_SEND_MS;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      const took = ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
      timer = setTimeout(() => reject(new Error(`the send took longer than ${took}`)), ms);
    });
    try {
      return await Promise.race([send, late]);
    } finally {
      clearTimeout(timer);
      send.catch(() => undefined);
    }
  }
}
