import { ChannelError, personTarget, type Channel } from '../channel/types.js';
import { boardCardUuid } from '../core/ids.js';
import { cardsDue } from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import { redactKnownSecrets } from '../secrets.js';
import { systemClock, type Clock } from '../time.js';
import { renderReviewCard, renderTaskCard, type CardFacts, type NameOf } from './chat-render.js';
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
  /** How long a send is waited for; `CARD_SEND_MS` unless a test says otherwise. */
  sendTimeoutMs?: number;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class CardPoster {
  readonly #deps: CardPosterDeps;
  readonly #clock: Clock;
  readonly #note: (line: string) => void;
  /** Runs held back after a failed send, by run id: until when, and the pause that was. */
  readonly #backoff = new Map<string, { until: number; waitMs: number }>();
  /** Runs whose card was sent and could not be recorded: passed over until a restart. */
  readonly #unrecorded = new Set<string>();
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

  /** Send one run its card, and record it; true once it was sent. */
  async #post(run: RunRow): Promise<boolean> {
    const unionId = unionIdOf(run.assignee.name);
    if (unionId === undefined) {
      this.#refused(run, `${run.assignee.name} is not a person Lark can be asked to message`);
      return false;
    }
    if (this.#deps.canTalk !== undefined && !this.#deps.canTalk(run.assignee.name)) {
      this.#refused(run, `${run.assignee.name} no longer has talk tier on this gateway`);
      return false;
    }
    const view = this.#render(run);
    if (view === undefined) return false;
    let messageId: string;
    try {
      const sent = await this.#bounded(
        this.#deps.channel.sendCard(
          personTarget(unionId),
          // Masked once more as a whole, as every reply and notice is (spec §9.3).
          { ...view, markdown: redactKnownSecrets(view.markdown) },
          boardCardUuid(this.#deps.appId, run.runId),
        ),
      );
      messageId = sent.messageId;
    } catch (err) {
      if (err instanceof ChannelError && PERSON_UNREACHABLE_CODES.has(err.code)) {
        this.#refused(run, message(err));
      } else {
        this.#holdBack(run, message(err));
      }
      return false;
    }
    this.#backoff.delete(run.runId);
    let why: string | undefined;
    try {
      const recorded = this.#deps.service.recordCard(run.runId, { messageId });
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
   * The run's card, from the board as it is now; undefined when its task is gone,
   * or its run ended since the round read it: a card for it would be out of date
   * on arrival.
   */
  #render(run: RunRow): ReturnType<typeof renderTaskCard> | undefined {
    const reading = this.#deps.service.cardReading(run.runId);
    if (reading === undefined || reading.run.endedAt !== null) return undefined;
    const facts: CardFacts = { ...reading, ...(this.#deps.nameOf === undefined ? {} : { nameOf: this.#deps.nameOf }) };
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
