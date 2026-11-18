import type { Event } from '../types.js';
import type { CardParts, CardSession, Channel, SendTarget } from './types.js';
import { CARD_GONE_CODES, ChannelError } from './types.js';
import { cardText, renderCard, type RenderedCard } from './render.js';
import { backoffMs } from './lark/errors.js';
import type { Clock } from '../time.js';
import { systemClock } from '../time.js';

/**
 * The single writer for one binding's cards.
 *
 * **One card per turn.** A Feishu streaming card is one stream, and the terminal
 * that stops its typing indicator also closes it for good: `set` afterwards is
 * accepted and discarded (see `CardSession.finish`). A writer that kept one card
 * for the whole session therefore answered the first prompt and then swallowed
 * every later one -- no error to retry, cursor advancing, the user looking at a
 * frozen card and reporting "no response". Card identity is the turn the render
 * belongs to, so a new prompt gets a new card and each reply is a reply to one
 * question, the way a chat message is.
 *
 * Three further properties, none optional:
 *
 * 1. **Single-flight.** One request in flight per card, ever. The platform's write
 *    ordering does not decide which render is *current*, and delivery order is
 *    unpredictable -- so without this a stale render lands after a fresh one and
 *    overwrites the result of a user's click.
 * 2. **Latest-wins, and the queued item is an integer.** What is queued is a
 *    target `seq`, not a rendered payload. "Newest wins" then reduces to an
 *    integer comparison and cannot regress. Queueing payloads instead means
 *    comparing blobs, and getting that wrong shows up as flickering text.
 * 3. **The pending target survives failure.** On error the target is retained, so
 *    the retry renders the newest state rather than replaying the state that
 *    failed.
 *
 * Intermediate renders are droppable by construction, which is what makes
 * coalescing safe rather than lossy.
 */

/** Coalescing interval. Roughly one card write per second per session. */
export const CARD_COALESCE_MS = 1000;

/**
 * Consecutive card-write failures before the answer is delivered some other way.
 *
 * Retrying is right: most card failures are throttles, and the pending target is
 * retained so a retry renders the newest state. Retrying *forever* is not. A card
 * can fail permanently -- an entity the platform will not accept, a payload it
 * rejects -- and the old behaviour was to re-attempt every second for the life of
 * the process, silently, while the user watched a card that had stopped moving.
 * The bound is small because the coalescing window is a second: five attempts is
 * long enough to ride out a throttle and short enough that a real answer is not
 * held hostage to a broken card.
 */
export const CARD_FAILURE_LIMIT = 5;

/**
 * How long throttles may hold the card back before they count against
 * `CARD_FAILURE_LIMIT`: 30 seconds of waiting, summed. A throttle says the card
 * is fine and the platform is busy; five of them in a row, each answered at
 * once, used to end a working card inside a few seconds and send the answer a
 * second time as a plain message.
 */
export const CARD_THROTTLE_BUDGET_MS = 30_000;

/** Lark's throttles: its rate-limit code, and HTTP 429 with no code of its own. */
const THROTTLE_CODES: ReadonlySet<number> = new Set([99991400, 429]);

/**
 * How long after the last write one that changes only the tool line waits,
 * unless the turn is finishing: two seconds. Tool events come in bursts, each
 * a request to Lark, and the tool line is the part a reader needs least soon;
 * held, a burst is one write, and the card's request rate stays inside Lark's
 * limits for the answer (channel spec §4.5).
 */
export const TOOL_LINE_DELAY_MS = 2_000;

/**
 * Card entities expire after 14 days. We rotate before the edge rather than at
 * it, because the failure at the edge is an update that silently stops landing.
 */
export const CARD_MAX_AGE_MS = 13 * 24 * 60 * 60 * 1000;

export interface CardWriterDeps {
  channel: Channel;
  target: SendTarget;
  /** Read events `(afterSeq, throughSeq]`. Supplied by the core; the writer never touches the DB. */
  readEvents: (afterSeq: number, throughSeq: number) => readonly Event[];
  /** Persist the cursor once a render lands. Monotonic on the DB side too. */
  onRendered: (throughSeq: number) => void;
  /** Persist the active message id, or clear it. */
  onCardChanged: (messageId: string | null) => void;
  /** Derive the idempotency uuid for opening a card. */
  sendUuid: (eventSeq: number) => string;
  clock?: Clock;
  /**
   * Metadata-only progress hook. Never given agent text or user content.
   *
   * The card path had no voice at all until it had already lost two answers in
   * production, both times looking exactly like an idle agent. Everything the
   * writer swallows is reported here.
   */
  note?: (line: string) => void;
}

export class CardWriter {
  readonly #deps: CardWriterDeps;
  readonly #clock: Clock;
  readonly #note: (line: string) => void;
  #session: CardSession | undefined;
  /** Highest seq we have been asked to render. The queue, as an integer. */
  #wanted = 0;
  /** Highest seq actually rendered. */
  #rendered = 0;
  #inFlight = false;
  /** Settles when the pass in flight ends. Unset with none in flight. */
  #pass: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #lastWriteAt = 0;
  #closed = false;
  /** Set by `close`: the last pass is not held for the tool line. */
  #closing = false;
  #finished = false;
  /** The `turnStartSeq` the open card belongs to. Meaningless while `#session` is unset. */
  #cardTurn = 0;
  /** The parts the open card was last given and took. Unset with no card. */
  #shownParts: CardParts | undefined;
  /** Consecutive failed writes. Reset by any success, checked against `CARD_FAILURE_LIMIT`. */
  #failures = 0;
  /** Consecutive failed writes of any kind, throttles among them: the backoff's attempt. */
  #attempts = 0;
  /** Waiting spent on throttles since the last write that landed, against `CARD_THROTTLE_BUDGET_MS`. */
  #throttledMs = 0;
  /** No pass starts before this, by the clock: the wait after a failure. */
  #notBefore = 0;
  /**
   * The turn whose card was given up on (`#fallback`), by its `turnStartSeq`:
   * kept plain to its end, with no card writes, so its answer is not sent again
   * and again by a card that fails again and again.
   */
  #plainTurn: number | undefined;
  /** What that turn's plain message carried, so its terminal sends only the rest. */
  #plainSent: CardParts | undefined;
  /** Whether that turn's rest has been sent, or needs none. */
  #plainDone = false;
  /** The turn whose card was last lost (`CARD_GONE_CODES`): one re-open a turn. */
  #goneTurn: number | undefined;
  /** Set when a lost card is dropped; the open that follows does not clear `#failures`. */
  #reopenAfterGone = false;
  /** Set by `#write` when the card it opened followed a lost one. */
  #openedAfterGone = false;

  constructor(deps: CardWriterDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
    this.#note = deps.note ?? (() => undefined);
  }

  /**
   * Resume after a restart.
   *
   * Only the cursor is adopted, never a card session -- the previous session died
   * with the process that owned it. The next render therefore opens a fresh card
   * and re-renders from the log. Nothing is lost, because the log is the system of
   * record and the render is a pure function of it.
   */
  resumeFrom(renderedThrough: number): void {
    this.#rendered = renderedThrough;
    this.#wanted = renderedThrough;
  }

  /**
   * Request that the card show state through `seq`.
   *
   * Returns immediately. Coalescing and retry are internal, because a caller that
   * has to await a card write has coupled the agent's progress to Feishu's
   * latency.
   */
  want(seq: number): void {
    if (this.#closed) return;
    if (seq <= this.#wanted) return;
    this.#wanted = seq;
    this.#schedule();
  }

  #schedule(): void {
    if (this.#inFlight || this.#timer !== undefined || this.#closed) return;
    const now = this.#clock.now();
    const elapsed = now - this.#lastWriteAt;
    const delay = Math.max(0, CARD_COALESCE_MS - elapsed, this.#notBefore - now);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#drain();
    }, delay);
    this.#timer.unref();
  }

  async #drain(): Promise<void> {
    // After `close`, a timer left over must not start a pass. `close`'s own
    // drain runs before the flag is set.
    if (this.#closed) return;
    if (this.#inFlight) return;
    if (this.#wanted <= this.#rendered) return;

    this.#inFlight = true;
    let passEnded!: () => void;
    this.#pass = new Promise<void>((resolve) => {
      passEnded = resolve;
    });
    // Snapshotted before the await. `#wanted` may advance while we are writing;
    // that advance schedules the next pass, and must not silently change what
    // this pass claims to have rendered.
    const target = this.#wanted;

    try {
      // Held, not failed: the pass that follows renders the newest state.
      if (!(await this.#write(target))) return;
      this.#rendered = target;
      this.#lastWriteAt = this.#clock.now();
      // A card opened after one was lost is not yet a card that works: a card
      // lost on every write would otherwise reset the count each time.
      if (!this.#openedAfterGone) this.#failures = 0;
      this.#openedAfterGone = false;
      this.#attempts = 0;
      this.#throttledMs = 0;
      this.#deps.onRendered(target);
    } catch (err) {
      // The next pass waits: what the platform said, else a backoff. Retried at
      // once, a throttle is only met again, and a failing card spends the
      // limit in five seconds.
      this.#attempts += 1;
      // Floored at the backoff: a wait of 0 from Lark would otherwise retry at
      // once, forever, and never spend the throttle budget.
      const hinted = err instanceof ChannelError ? err.retryAfterMs : undefined;
      const wait = Math.max(hinted ?? 0, backoffMs(this.#attempts));
      this.#notBefore = this.#clock.now() + wait;
      const throttle = err instanceof ChannelError && THROTTLE_CODES.has(err.code);
      if (throttle && this.#throttledMs < CARD_THROTTLE_BUDGET_MS) {
        this.#throttledMs += wait;
        this.#note(`card write through ${target} throttled, waiting ${Math.ceil(wait / 1000)}s: ${describe(err)}`);
      } else {
        this.#failures += 1;
        this.#note(`card write through ${target} failed (${this.#failures}): ${describe(err)}`);
      }

      if (err instanceof ChannelError && CARD_GONE_CODES.has(err.code) && this.#session !== undefined) {
        // The card is gone. Drop the session and let the next pass open a fresh
        // one, continuing from the cursor -- the log still has everything. Once a
        // turn: a second card lost in the same turn is a card path that does not
        // work, and the answer goes as a plain message instead.
        const again = this.#goneTurn === this.#cardTurn;
        this.#goneTurn = this.#cardTurn;
        this.#session = undefined;
        this.#deps.onCardChanged(null);
        if (again) {
          this.#note(`card through ${target} lost twice in one turn`);
          this.#failures = CARD_FAILURE_LIMIT;
        } else {
          this.#reopenAfterGone = true;
        }
      }

      if (this.#failures >= CARD_FAILURE_LIMIT) {
        // Out of patience with this card. The answer still has to arrive, so it
        // goes out over the plain message path -- a different endpoint, which is
        // the point: it does not share whatever the card is failing on.
        // Guarded: `#drain` is called from a timer with no one to catch it, and
        // the last thing a failing card path should do is become an unhandled
        // rejection.
        await this.#fallback(target).catch((e: unknown) =>
          this.#note(`giving up on the card through ${target} failed: ${describe(e)}`),
        );
      }
      // Short of that, `#rendered` is deliberately not advanced, so
      // `#wanted > #rendered` still holds and the retry renders the newest state
      // rather than this stale one.
    } finally {
      this.#inFlight = false;
      this.#pass = undefined;
      passEnded();
      if (this.#wanted > this.#rendered && !this.#closed) this.#schedule();
    }
  }

  /**
   * Deliver a render as an ordinary message, the card having refused enough times.
   *
   * The cursor advances either way. If the plain path fails too there is nothing
   * left to try, and holding the cursor back would only re-attempt both failures
   * every second for the life of the process -- the behaviour this exists to end.
   * The content is in the log regardless; what is lost is a delivery, and that is
   * said out loud rather than retried into silence.
   */
  async #fallback(target: number): Promise<void> {
    // The state is settled *first*, and the reads and writes that can throw come
    // after. This runs on the path where something is already failing, so it has
    // to terminate the retry loop even if it cannot do anything else -- including
    // when the render itself throws, which is what a closed database looks like.
    const had = this.#session;
    this.#session = undefined;
    this.#failures = 0;
    this.#attempts = 0;
    this.#throttledMs = 0;
    this.#notBefore = 0;
    this.#rendered = target;
    this.#lastWriteAt = this.#clock.now();

    let view: RenderedCard | undefined;
    let sent = false;
    try {
      // The parts joined: the plain message reads as the card did.
      view = renderCard(this.#deps.readEvents(0, target));
      await this.#deps.channel.sendText(
        this.#deps.target,
        view.text,
        this.#deps.sendUuid(target),
      );
      sent = true;
      this.#note(`gave up on the card through ${target}; sent it as a plain message`);
    } catch (err) {
      this.#note(`card and plain message both failed through ${target}: ${describe(err)}`);
    }

    // The rest of the turn stays plain: no card for it, and at its terminal one
    // more message with what this one did not carry.
    if (view !== undefined) {
      this.#plainTurn = view.turnStartSeq;
      this.#plainSent = sent ? view.parts : { tools: '', answer: '', status: '' };
      this.#plainDone = view.finished;
    }

    // The card given up on is finished, as every card is: left streaming, it
    // shows its typing cursor until Lark gives up on it. Best effort; it may
    // be what was failing.
    //
    // The finish writes the parts first, and the card may refuse them for the
    // same reason it was given up on (too large, say), which is one wasted
    // request. Accepted: the finish then still turns streaming off, which is
    // what it is for, and a finish without the parts would be a second path to
    // keep. Only this turn's card: one from an earlier turn has its own end.
    if (had !== undefined && view !== undefined && !this.#finished && view.turnStartSeq === this.#cardTurn) {
      await had.finish(view.parts).catch((e: unknown) => this.#note(`finishing the card given up on through ${target} failed: ${describe(e)}`));
    }

    // Done with this card whichever way that went. The next turn opens a new one;
    // this one is not coming back.
    if (had !== undefined) this.#deps.onCardChanged(null);
    this.#deps.onRendered(target);
  }

  /** Write the render through `target`; false when it was held (`TOOL_LINE_DELAY_MS`). */
  async #write(target: number): Promise<boolean> {
    // Read from seq 0, not from the cursor: a render is a full replacement of the
    // card, not an append to it, and the renderer needs the whole turn to produce
    // one. It scopes the result to the current turn itself.
    const events = this.#deps.readEvents(0, target);
    const view = renderCard(events);

    // A turn given up on stays plain: no card, and its terminal sends the rest.
    if (this.#plainTurn !== undefined && view.turnStartSeq === this.#plainTurn) {
      if (view.finished && !this.#plainDone) await this.#sendRest(view, target);
      return true;
    }

    const existing = this.#session;
    const expired =
      existing !== undefined && this.#clock.now() - existing.createdAt > CARD_MAX_AGE_MS;
    // Compared, rather than inferred from `#finished`: coalescing can put one
    // turn's terminal and the next turn's answer in the same render, and that
    // render belongs on a new card even though it is already finished.
    const newTurn = existing !== undefined && view.turnStartSeq !== this.#cardTurn;

    let session = existing;
    if (session === undefined || expired || newTurn) {
      // The card being left behind may still be streaming, if this render is the
      // first sight of the new turn. Nothing will ever write to it again, so
      // freeze it here or its typing indicator spins forever.
      if (newTurn && !this.#finished && existing !== undefined) {
        const before = renderCard(this.#deps.readEvents(0, view.turnStartSeq - 1));
        try {
          await existing.finish(before.parts);
        } catch {
          // Best effort. Failing to tidy the old card must not cost the new one,
          // which is the card the answer is actually going onto.
        }
      }
      session = await this.#deps.channel.openCard(
        view.replyTo === undefined ? this.#deps.target : { ...this.#deps.target, replyTo: view.replyTo },
        view.parts,
        this.#deps.sendUuid(target),
      );
      // Only once the card is open: until then the card left behind is still
      // the one `#finished` speaks for.
      this.#finished = false;
      this.#openedAfterGone = this.#reopenAfterGone;
      this.#reopenAfterGone = false;
      this.#session = session;
      this.#cardTurn = view.turnStartSeq;
      this.#shownParts = view.parts;
      this.#deps.onCardChanged(session.messageId);
      // The initial text was already delivered by `openCard`, so a `set` here
      // would be a redundant round-trip -- but a finished view still has to be
      // frozen.
      if (view.finished) {
        await session.finish(view.parts);
        this.#finished = true;
      }
      return true;
    }

    if (!view.finished && !this.#closing && toolLineOnly(this.#shownParts, view.parts) && this.#clock.now() - this.#lastWriteAt < TOOL_LINE_DELAY_MS) {
      this.#notBefore = this.#lastWriteAt + TOOL_LINE_DELAY_MS;
      return false;
    }

    if (view.finished) {
      await session.finish(view.parts);
      this.#finished = true;
    } else {
      await session.set(view.parts);
    }
    this.#shownParts = view.parts;
    return true;
  }

  /**
   * Send what a plain turn's first message did not carry, once: the answer's
   * new end, and the tool line and the status where they changed. When the
   * answer does not start with what was sent (a secret learnt late, the
   * budget), the whole of it goes again, as the only text that reads right.
   * Best effort, as the fallback is: a failure is said, not retried.
   */
  async #sendRest(view: RenderedCard, target: number): Promise<void> {
    this.#plainDone = true;
    const text = restText(this.#plainSent ?? { tools: '', answer: '', status: '' }, view.parts);
    if (text === '') return;
    try {
      await this.#deps.channel.sendText(this.#deps.target, text, this.#deps.sendUuid(target));
      this.#note(`sent the rest of the turn through ${target} as a plain message`);
    } catch (err) {
      this.#note(`sending the rest of the turn through ${target} failed: ${describe(err)}`);
    }
  }

  /**
   * Flush anything outstanding and stop.
   *
   * Awaits the final write, unlike `want`. This is the one place where blocking is
   * correct: teardown that returns before the last card write lands leaves the
   * user looking at a partial answer with no indication more was coming.
   */
  async close(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    // The last pass writes what it has, a tool line among it, unheld.
    this.#closing = true;
    // A pass in flight is waited for, or the finish below would overlap its
    // write on the same card.
    if (this.#pass !== undefined) await this.#pass;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    // Drained before the closed flag is set, so a `want` that arrived during
    // shutdown is not silently dropped.
    await this.#drain();
    this.#closed = true;
    // A failed pass in the drain may have scheduled another.
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }

    // A plain turn cut short still sends its rest.
    if (this.#plainTurn !== undefined && !this.#plainDone) {
      try {
        const view = renderCard(this.#deps.readEvents(0, this.#rendered));
        if (view.turnStartSeq === this.#plainTurn) await this.#sendRest(view, this.#rendered);
      } catch (err) {
        this.#note(`sending the rest of the turn on close failed: ${describe(err)}`);
      }
    }

    // A card left un-frozen keeps its typing indicator forever. If the render
    // never reported a terminal, freeze it anyway on the way out.
    const session = this.#session;
    if (session !== undefined && !this.#finished) {
      const view = renderCard(this.#deps.readEvents(0, this.#rendered));
      try {
        await session.finish(view.parts);
        this.#finished = true;
      } catch {
        // Teardown is best-effort. A card that stays open is a cosmetic defect;
        // throwing here would abort the rest of the shutdown.
      }
    }
  }

  /** For tests: force an immediate pass without waiting out the coalesce window. */
  async flushNow(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#drain();
  }

  get messageId(): string | undefined {
    return this.#session?.messageId;
  }

  get renderedThrough(): number {
    return this.#rendered;
  }
}

/**
 * What a plain turn's terminal message carries, given what its first one did:
 * the answer's new end, and the tool line and the status where they changed;
 * the whole card's text when the answer no longer starts with what was sent.
 */
function restText(sent: CardParts, final: CardParts): string {
  if (!final.answer.startsWith(sent.answer)) return cardText(final);
  return cardText({
    tools: final.tools === sent.tools ? '' : final.tools,
    answer: final.answer.slice(sent.answer.length).replace(/^\s+/, ''),
    status: final.status === sent.status ? '' : final.status,
  });
}

/** Whether `next` differs from `shown` in its tool line alone. */
function toolLineOnly(shown: CardParts | undefined, next: CardParts): boolean {
  return shown !== undefined && shown.answer === next.answer && shown.status === next.status && shown.tools !== next.tools;
}

/**
 * One line of operational detail about a failure.
 *
 * Platform metadata only -- a code, a retry hint, the platform's own wording. The
 * render is never in here: a log that quotes the card body is a second copy of the
 * conversation with none of the retention rules that apply to the first.
 */
function describe(err: unknown): string {
  if (err instanceof ChannelError) {
    return err.retryable ? `${err.message}, retryable` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
