import type { ToolLine } from '../channel/render.js';
import { CARD_GONE_CODES, ChannelError, type CardView, type Channel, type SendTarget } from '../channel/types.js';
import { progressCardUuid } from '../core/ids.js';
import { lastAgentEventAt, lastEventBefore, lastSeq, readEvents, readEventsOfTypes } from '../db/events.js';
import {
  chatKindOf,
  getRun,
  getTask,
  openProgressCards,
  progressCard,
  progressDue,
  runEndedOf,
  stoppedOf,
  subscriptionsOf,
  type ProgressCardRow,
} from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import { redactKnownSecrets } from '../secrets.js';
import { stripControl } from '../text.js';
import { systemClock, type Clock } from '../time.js';
import type { Event, EventType } from '../types.js';
import { CARD_BACKOFF_MAX_MS, CARD_SEND_MS } from './cards.js';
import { progressState, renderProgressCard, type NameOf, type ProgressState } from './chat-render.js';
import { REDRAW_MS } from './chat.js';
import { UNREACHABLE_CODES } from './notices.js';
import type { KanbanService } from './service.js';
import type { RunRow, SubscriptionRow } from './types.js';

/**
 * Progress cards (progress cards spec): while an agent run on the board is
 * under way, the chat that follows its task, in a thread or a direct message,
 * gets one card that shows the run as it goes, redrawn from the run's session
 * log, and drawn final once the run has closed.
 *
 * **A loop over the session log** (spec §0, §7): every `PROGRESS_POLL_MS`, one
 * round at a time, it opens a card for each open run past `min_seconds` with
 * none, reads each open card's session past what it has folded, at most
 * `FOLD_EVENTS` a round, and redraws a card whose view changed, at most once
 * every `PROGRESS_PACE_MS`, at most `ROUND_DRAWS` draws a round, the longest
 * waiting first. A card is drawn only once its fold has caught up.
 *
 * **Errors** (spec §9): a refusal, `code !== 0 && !retryable`, counts, and ten
 * in a row let the first send go, leave a card as it is, or let a final draw
 * go; anything else -- code 0, a timeout, a throttle, a 5xx -- is held back,
 * never counted, at least its `retryAfterMs`. A card or chat that is gone
 * (`CARD_GONE_CODES`, or 230002) is let go of at once.
 *
 * **Presses** (spec §8): `KanbanChat` judges a Stop press and asks here for its
 * redraw, `redrawNow` after a stop, `redrawEnded` for a press on an ended run,
 * `refusedTier` for a press refused for operate tier, which bumps the Stop
 * button's `try`. A card's draws go one at a time, chained by its message.
 */

/** How often a round runs. */
export const PROGRESS_POLL_MS = 3_000;
/** No update is tried within this long of the card's last landed or tried draw. */
export const PROGRESS_PACE_MS = 5_000;
/** The longest a card whose update failed is held. */
export const UPDATE_HOLD_MAX_MS = 60_000;
/** Draws in one round. */
export const ROUND_DRAWS = 10;
/** Refusals in a row that let a send or a final go, or leave a card as it is. */
export const REFUSALS_LIMIT = 10;
/** Session events folded for one card in one round. */
export const FOLD_EVENTS = 5_000;
/** Session events a press's redraw folds, at most: the loop folds the rest. */
export const PRESS_FOLD_EVENTS = 4 * FOLD_EVENTS;
/**
 * The agent's latest text kept, in code points: far past the tail. The text is
 * masked before it is cut, so a secret known then is whole when masked, and
 * the kept text does not shrink at render to bring the cut into the tail.
 */
export const TEXT_KEEP = 8_000;

const TOOL_TYPES: readonly EventType[] = ['tool_call', 'tool_call_update'];

/** A run's session, folded: what a card draws (spec §5.1, §5.2). */
export interface RunProgress {
  /** The run's tool calls, by id, in the order first heard of. */
  tools: Map<string, ToolLine>;
  /** The latest turn's text, its last `TEXT_KEEP` code points. */
  text: string;
  /** A tool came since the text last grew: the next text starts a paragraph. */
  toolSinceText: boolean;
  /** Approvals asked for and not answered. */
  approvals: Set<string>;
  /** The last session seq read: each read moves it to its range's bound. */
  throughSeq: number;
  /** Any event folded. */
  seen: boolean;
}

export function newProgress(): RunProgress {
  return { tools: new Map(), text: '', toolSinceText: false, approvals: new Set(), throughSeq: 0, seen: false };
}

function field(payload: unknown, key: string): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Fold session events into a run's progress (spec §5.1): the tools are the
 * whole run's, a non-empty title replacing the known one; the text is the
 * latest turn's. It does not move `throughSeq`: the reader does, to its
 * range's bound.
 */
export function foldProgress(p: RunProgress, events: readonly Event[]): void {
  for (const event of events) {
    p.seen = true;
    switch (event.type) {
      case 'agent_message_chunk': {
        const text = field(event.payload, 'text') ?? '';
        if (text === '') break;
        if (p.toolSinceText && p.text.trim() !== '' && !/\n\s*$/.test(p.text)) p.text += '\n\n';
        p.toolSinceText = false;
        p.text += text;
        // Cut now and then, not at every chunk: four keeps' worth before it is cut to one, masked first.
        if (p.text.length > TEXT_KEEP * 4) p.text = Array.from(redactKnownSecrets(stripControl(p.text))).slice(-TEXT_KEEP).join('');
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        p.toolSinceText = true;
        const id = field(event.payload, 'toolCallId') ?? '';
        const known = p.tools.get(id);
        const title = field(event.payload, 'title');
        const status = field(event.payload, 'status');
        p.tools.set(id, {
          title: title !== undefined && title !== '' ? title : (known?.title ?? (id === '' ? 'tool' : id)),
          status: status !== undefined && status !== '' ? status : (known?.status ?? 'pending'),
        });
        break;
      }
      case 'turn_submitted':
        p.text = '';
        p.toolSinceText = false;
        p.approvals.clear();
        break;
      case 'approval_requested':
        p.approvals.add(field(event.payload, 'approvalId') ?? '');
        break;
      case 'approval_resolved':
        p.approvals.delete(field(event.payload, 'approvalId') ?? '');
        break;
      default:
        break;
    }
  }
}

export interface ProgressCardsDeps {
  db: Db;
  service: KanbanService;
  /** Where a subscription's channel id sends: `lark` to the Lark adapter. */
  channels: ReadonlyMap<string, Channel>;
  /** This bot: only its subscriptions get cards here. */
  appId: string;
  /** `kanban.progress.min_seconds`. */
  minSeconds: number;
  /** `kanban.failure_limit`, for "run N of M" of a task with no limit of its own. */
  failureLimit: number;
  /**
   * When the gateway's `start()` began, asked at each final draw: a run started
   * before it and closed after was closed by the boot (spec §5.3). Undefined
   * before the start, or with no boot to tell.
   */
  bootedAt?: () => number | undefined;
  /** What a card calls a person: the people directory's chat name. */
  nameOf?: NameOf;
  /** Whether a task is held while its "Created" reply is under way: `KanbanChat`'s. */
  held?: (taskId: string) => boolean;
  clock?: Clock;
  /** Metadata only: ids and codes, never task text or agent output. */
  note?: (line: string) => void;
  /** How long a send is waited for; `CARD_SEND_MS` unless a test says otherwise. */
  sendTimeoutMs?: number;
  /** How long an update is waited for; `REDRAW_MS` unless a test says otherwise. */
  redrawTimeoutMs?: number;
}

/** A card's memory in this process: forgotten once it is final or let go of. */
interface Live {
  progress: RunProgress;
  /** What the last landed draw showed: its markdown, the run's state, the Stop button's try. */
  markdown?: string;
  state?: ProgressState;
  tried?: number;
  drawnAt?: number;
  /** When an update was last tried, landed or not. */
  lastTriedAt?: number;
  /** Held back after a failure, until, and the pause that was. */
  hold?: { until: number; waitMs: number };
  /** A send that landed and was not recorded: the card still drawn this boot. */
  messageId?: string;
  /** The ten refused updates said once. */
  leftSaid?: boolean;
  /** A draw failed since the last landed: the next is due whatever the cheap check says. */
  dirty?: boolean;
}

type Kind = 'send' | 'update' | 'final';

interface Due {
  runId: string;
  key: string;
  kind: Kind;
  since: number;
}

function message(err: unknown): string {
  return redactKnownSecrets(err instanceof Error ? err.message : String(err));
}

export class ProgressCards {
  readonly #deps: ProgressCardsDeps;
  readonly #clock: Clock;
  readonly #note: (line: string) => void;
  readonly #live = new Map<string, Live>();
  /** The Stop button's try, by run (spec §6.5): bumped by a press refused for tier. */
  readonly #tries = new Map<string, number>();
  /** Chat kinds found for a subscription with none, by channel and chat; a miss is not kept (spec §2). */
  readonly #kinds = new Map<string, 'p2p' | 'group'>();
  /** Chats looked up and not found this round: looked up again at the next. */
  readonly #missed = new Set<string>();
  /** Channels said to be missing, once a boot. */
  readonly #saidChannels = new Set<string>();
  /** A card's draws, chained by its message (or its run until it has one). */
  readonly #chains = new Map<string, Promise<void>>();
  /** When a press last redrew a message, for the presses' pace (spec §8.1, §8.4). */
  readonly #pressed = new Map<string, number>();
  readonly #pending = new Set<Promise<unknown>>();
  #round: Promise<number> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(deps: ProgressCardsDeps) {
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

  /** A round every `PROGRESS_POLL_MS`, starting now: the first finishes what a restart left open. */
  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setInterval(() => void this.round(), PROGRESS_POLL_MS);
    this.#timer.unref();
    void this.round();
  }

  /** No more rounds; one under way ends after its current draw. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Once no draw is under way, or `boundMs` has passed: true once drained. */
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

  /** One round, or the one under way: resolves to the draws it made. Never rejects. */
  round(): Promise<number> {
    if (this.#round !== undefined) return this.#round;
    const round = this.#track(this.#roundOnce())
      .catch((err: unknown) => {
        this.#note(`kanban: drawing progress cards failed: ${message(err)}`);
        return 0;
      })
      .finally(() => {
        this.#round = undefined;
      });
    this.#round = round;
    return round;
  }

  /** A stop was written (spec §8.3): the card redrawn at once, outside the pace. Never rejects. */
  redrawNow(runId: string): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    const row = progressCard(this.#deps.db, runId);
    if (row === undefined) return Promise.resolve();
    return this.#chain(this.#keyOf(row), () => this.#pressDraw(runId, false));
  }

  /**
   * A press on a card whose run has ended (spec §8.4): drawn final, with "This
   * run has ended.", whatever the row's state; one a message every 5 s.
   */
  redrawEnded(messageId: string, runId: string): Promise<void> {
    if (this.#stopped || !this.#mayPress(messageId)) return Promise.resolve();
    if (progressCard(this.#deps.db, runId) === undefined) return Promise.resolve();
    return this.#chain(messageId, () => this.#pressDraw(runId, true, messageId));
  }

  /**
   * A press refused for operate tier (spec §8.1): the Stop button's try one
   * higher, and the card redrawn with it, one a message every 5 s; a bump
   * whose redraw was paced away makes the card due at the pace's end.
   */
  refusedTier(messageId: string, runId: string): Promise<void> {
    if (progressCard(this.#deps.db, runId) === undefined) return Promise.resolve();
    this.#tries.set(runId, (this.#tries.get(runId) ?? 0) + 1);
    // A card held after a failure is not drawn: the loop draws the bumped try once the hold ends.
    const hold = this.#live.get(runId)?.hold;
    if (hold !== undefined && hold.until > this.#clock.now()) return Promise.resolve();
    if (this.#stopped || !this.#mayPress(messageId)) return Promise.resolve();
    return this.#chain(messageId, () => this.#pressDraw(runId, false, messageId));
  }

  /** The Stop button's try for a run: what its next draw carries. */
  tryOf(runId: string): number {
    return this.#tries.get(runId) ?? 0;
  }

  #mayPress(messageId: string): boolean {
    const now = this.#clock.now();
    const last = this.#pressed.get(messageId);
    if (last !== undefined && now - last < PROGRESS_PACE_MS) return false;
    // Bounded: a message's entry is dropped once its pace is past.
    for (const [m, at] of this.#pressed) if (now - at >= PROGRESS_PACE_MS) this.#pressed.delete(m);
    this.#pressed.set(messageId, now);
    return true;
  }

  #track<T>(work: Promise<T>): Promise<T> {
    this.#pending.add(work);
    void work.then(
      () => this.#pending.delete(work),
      () => this.#pending.delete(work),
    );
    return work;
  }

  /** A card's draw, once the one before it has settled; never rejects. */
  #chain(key: string, work: () => Promise<void>): Promise<void> {
    const before = this.#chains.get(key) ?? Promise.resolve();
    const step = before.then(work).catch((err: unknown) => {
      this.#note(`kanban: drawing a progress card failed: ${message(err)}`);
    });
    this.#chains.set(key, step);
    void step.finally(() => {
      if (this.#chains.get(key) === step) this.#chains.delete(key);
    });
    return this.#track(step);
  }

  #keyOf(row: ProgressCardRow): string {
    return row.messageId ?? this.#live.get(row.runId)?.messageId ?? `run:${row.runId}`;
  }

  #liveOf(runId: string): Live {
    let live = this.#live.get(runId);
    if (live === undefined) {
      live = { progress: newProgress() };
      this.#live.set(runId, live);
    }
    return live;
  }

  #forget(runId: string): void {
    this.#live.delete(runId);
    this.#tries.delete(runId);
  }

  async #roundOnce(): Promise<number> {
    if (this.#stopped) return 0;
    const now = this.#clock.now();
    this.#missed.clear();
    this.#openDue(now);
    const due: Due[] = [];
    for (const row of openProgressCards(this.#deps.db, this.#deps.appId)) {
      try {
        const d = this.#dueOf(row, now);
        if (d !== undefined) due.push(d);
      } catch (err) {
        this.#note(`kanban: reading the progress card of run ${row.runId} failed: ${message(err)}`);
      }
    }
    // The longest waiting first, so a busy card cannot keep a quiet one waiting.
    due.sort((a, b) => a.since - b.since);
    // Only a draw tried counts to the ten: not a card that had not caught up, nor one whose view had not changed.
    let drawn = 0;
    for (const d of due) {
      if (this.#stopped || drawn >= ROUND_DRAWS) break;
      let tried = false;
      await this.#chain(d.key, async () => {
        tried = await this.#draw(d.runId, d.kind);
      });
      if (tried) drawn += 1;
    }
    return drawn;
  }

  /** Step 1 of a round (spec §7.2): a row for each run due a card. */
  #openDue(now: number): void {
    const { db, appId, channels } = this.#deps;
    for (const { run, sub } of progressDue(db, appId, now - this.#deps.minSeconds * 1000)) {
      if (this.#stopped) return;
      if (this.#deps.held?.(run.taskId) === true) continue;
      if (!channels.has(sub.channel)) {
        if (!this.#saidChannels.has(sub.channel)) {
          this.#saidChannels.add(sub.channel);
          this.#note(`kanban: progress cards cannot go to channel ${sub.channel}, which this gateway has not got`);
        }
        continue;
      }
      if (!this.#cardGoes(sub)) continue;
      const r = this.#deps.service.openProgressCard(run.runId, appId, sub.channel, this.#deps.failureLimit);
      if (!r.ok) this.#note(`kanban: the progress card of run ${run.runId} was not opened (${r.code})`);
    }
  }

  /**
   * Whether a card goes to this subscription (spec §2, rule 6): a thread, a
   * direct message, or a chat of unknown kind another subscription says is a
   * direct message. A found kind is kept; a miss is looked up again at most
   * once a round.
   */
  #cardGoes(sub: SubscriptionRow): boolean {
    if (sub.threadId !== '') return true;
    if (sub.chatType !== null) return sub.chatType === 'p2p';
    const key = `${sub.channel}\u0000${sub.conversationId}`;
    const known = this.#kinds.get(key);
    if (known !== undefined) return known === 'p2p';
    if (this.#missed.has(key)) return false;
    const kind = chatKindOf(this.#deps.db, this.#deps.appId, sub.channel, sub.conversationId);
    if (kind === undefined) {
      this.#missed.add(key);
      return false;
    }
    this.#kinds.set(key, kind);
    return kind === 'p2p';
  }

  /** Where a card of the task goes now: this bot's subscription on the row's channel, replying to a thread's root. */
  #target(row: ProgressCardRow): SendTarget | undefined {
    const sub = subscriptionsOf(this.#deps.db, row.taskId).find((s) => s.appId === this.#deps.appId && s.channel === row.channel);
    if (sub === undefined || !this.#cardGoes(sub)) return undefined;
    const root = sub.threadId === '' || sub.rootMessageId === null ? {} : { root: sub.rootMessageId };
    return { chatId: sub.conversationId, threadId: sub.threadId, ...root };
  }

  /** Step 2 of a round (spec §7.2): what, if anything, this card is due. */
  #dueOf(row: ProgressCardRow, now: number): Due | undefined {
    const key = this.#keyOf(row);
    if (this.#chains.has(key)) return undefined;
    const run = getRun(this.#deps.db, row.runId);
    if (run === undefined) {
      this.#letGo(row.runId);
      return undefined;
    }
    const live = this.#liveOf(row.runId);
    if (live.hold !== undefined && now < live.hold.until) return undefined;
    const messageId = row.messageId ?? live.messageId;
    if (messageId === undefined || messageId === null) {
      // Ended, or followed no longer, before a send landed: let go of, quietly.
      if (run.endedAt !== null || this.#target(row) === undefined) {
        this.#letGo(row.runId);
        return undefined;
      }
      return { runId: row.runId, key, kind: 'send', since: row.openedAt };
    }
    const drawnAt = live.drawnAt ?? row.drawnAt ?? row.openedAt;
    if (now - Math.max(drawnAt, live.lastTriedAt ?? 0) < PROGRESS_PACE_MS) return undefined;
    if (run.endedAt !== null) return { runId: row.runId, key, kind: 'final', since: drawnAt };
    if (row.failures >= REFUSALS_LIMIT) return undefined;
    if (this.#unchanged(row, run, live, now, drawnAt)) return undefined;
    return { runId: row.runId, key, kind: 'update', since: drawnAt };
  }

  /**
   * The cheap check (spec §7.2): nothing new in the session past what was
   * drawn, the shown minute, the run's state and the Stop button's try as last
   * drawn.
   */
  #unchanged(row: ProgressCardRow, run: RunRow, live: Live, now: number, drawnAt: number): boolean {
    const seq = run.sessionId === null ? 0 : lastSeq(this.#deps.db, run.sessionId);
    const minute = (at: number): number => Math.floor((at - run.startedAt) / 60_000);
    if (live.dirty === true || live.markdown === undefined) return false;
    return (
      seq <= Math.max(row.readSeq, live.progress.throughSeq) &&
      minute(now) === minute(drawnAt) &&
      live.state === progressState(run) &&
      live.tried === this.tryOf(row.runId)
    );
  }

  /**
   * One capped read of the run's session (spec §5.2): at most `FOLD_EVENTS`,
   * `throughSeq` moved to the range's bound whatever types came back. True once
   * caught up with the session's last seq.
   */
  #read(live: Live, run: RunRow, toolsOnly: boolean): boolean {
    if (run.sessionId === null) return true;
    const last = lastSeq(this.#deps.db, run.sessionId);
    const p = live.progress;
    if (p.throughSeq >= last) return true;
    const upTo = Math.min(last, p.throughSeq + FOLD_EVENTS);
    const events = toolsOnly
      ? readEventsOfTypes(this.#deps.db, run.sessionId, TOOL_TYPES, p.throughSeq, upTo)
      : readEvents(this.#deps.db, run.sessionId, p.throughSeq, upTo);
    foldProgress(p, events);
    if (toolsOnly && upTo > p.throughSeq) p.seen = true;
    p.throughSeq = upTo;
    return upTo >= last;
  }

  /** A press's redraw reads at most `PRESS_FOLD_EVENTS`: true once caught up; the loop folds the rest. */
  #readPress(live: Live, run: RunRow, toolsOnly: boolean): boolean {
    for (let read = 0; read < PRESS_FOLD_EVENTS; read += FOLD_EVENTS) {
      if (this.#read(live, run, toolsOnly)) return true;
    }
    return run.sessionId === null || live.progress.throughSeq >= lastSeq(this.#deps.db, run.sessionId);
  }

  /** A run's total time (spec §5.3): to its close, or, closed by the boot, to its agent's last output. */
  #ranMs(run: RunRow): number | null {
    if (run.endedAt === null) return null;
    const boot = this.#deps.bootedAt?.();
    const byBoot = boot !== undefined && run.startedAt < boot && boot <= run.endedAt;
    if (!byBoot) return run.endedAt - run.startedAt;
    if (run.sessionId === null) return null;
    const end = lastAgentEventAt(this.#deps.db, run.sessionId) ?? lastEventBefore(this.#deps.db, run.sessionId, boot);
    return end === undefined ? null : Math.max(0, end - run.startedAt);
  }

  #view(row: ProgressCardRow, run: RunRow, live: Live, extra: { pressedEnded?: boolean } = {}): CardView | undefined {
    const task = getTask(this.#deps.db, run.taskId);
    if (task === undefined) return undefined;
    const state = progressState(run);
    const stoppedBy = state === 'stopping' ? stoppedOf(this.#deps.db, run.taskId, run.runId)?.actor : undefined;
    const runEnded = run.outcome === null ? undefined : runEndedOf(this.#deps.db, run.taskId, run.runId);
    const view = renderProgressCard(
      {
        task,
        run,
        tryNumber: row.tryNumber,
        tryLimit: row.tryLimit,
        tools: [...live.progress.tools.values()],
        text: live.progress.text,
        approvalWaiting: live.progress.approvals.size > 0,
        started: run.sessionId !== null && live.progress.seen,
        now: this.#clock.now(),
        ...(runEnded === undefined ? {} : { runEnded }),
        ...(stoppedBy === undefined ? {} : { stoppedBy }),
        ...(state === 'ended' ? { ranMs: this.#ranMs(run) } : {}),
        ...(extra.pressedEnded === true ? { pressedEnded: true } : {}),
        attempt: this.tryOf(run.runId),
        ...(this.#deps.nameOf === undefined ? {} : { nameOf: this.#deps.nameOf }),
      },
      this.#deps.appId,
    );
    // Masked once more as a whole, as every card is (spec §6.8).
    return { ...view, markdown: redactKnownSecrets(view.markdown) };
  }

  /** A draw the round decided on, made with the board and the session as they are now: true once a send or an update was tried. */
  async #draw(runId: string, kind: Kind): Promise<boolean> {
    if (this.#stopped) return false;
    const row = progressCard(this.#deps.db, runId);
    if (row === undefined || row.state !== 'open') return false;
    const run = getRun(this.#deps.db, runId);
    if (run === undefined) return false;
    const live = this.#liveOf(runId);
    if (kind === 'send') return this.#send(row, run, live);
    if (kind === 'final' || run.endedAt !== null) return this.#final(row, run, live, { force: false });
    return this.#update(row, run, live, false);
  }

  /**
   * A press's redraw: final for an ended run or a row not open, else an update
   * now. A row not open, which the loop never reads again, is forgotten once
   * drawn, landed or not: its fold, and its try once its run has ended (an open
   * run's card still has its Stop button, whose next refusal must draw a higher try).
   */
  async #pressDraw(runId: string, pressedEnded: boolean, pressedOn?: string): Promise<void> {
    const row = progressCard(this.#deps.db, runId);
    if (row === undefined) return;
    const run = getRun(this.#deps.db, runId);
    if (run === undefined) return;
    try {
      const live = this.#liveOf(runId);
      const messageId = pressedOn ?? row.messageId ?? live.messageId;
      if (messageId === undefined || messageId === null) return;
      if (pressedEnded || run.endedAt !== null || row.state !== 'open') {
        await this.#final(row, run, live, { force: true, messageId, pressedEnded });
        return;
      }
      await this.#update(row, run, live, true, messageId);
    } finally {
      if (row.state !== 'open') {
        if (run.endedAt !== null) this.#forget(runId);
        else this.#live.delete(runId);
      }
    }
  }

  async #send(row: ProgressCardRow, run: RunRow, live: Live): Promise<boolean> {
    if (run.endedAt !== null) {
      this.#letGo(row.runId);
      return false;
    }
    const target = this.#target(row);
    const channel = this.#deps.channels.get(row.channel);
    if (target === undefined || channel === undefined) {
      this.#letGo(row.runId);
      return false;
    }
    if (!this.#read(live, run, false)) return false;
    const view = this.#view(row, run, live);
    if (view === undefined) return false;
    let messageId: string;
    try {
      const sent = await this.#bounded(
        Promise.resolve().then(() => channel.sendCard(target, view, progressCardUuid(this.#deps.appId, row.runId))),
        this.#deps.sendTimeoutMs ?? CARD_SEND_MS,
      );
      messageId = sent.messageId;
    } catch (err) {
      this.#failed(row, live, err, 'send', target.chatId);
      return true;
    }
    this.#landed(live, view, run);
    let why: string | undefined;
    try {
      const r = this.#deps.service.progressCardSent(row.runId, messageId, live.progress.throughSeq);
      if (!r.ok) why = r.code;
    } catch (err) {
      why = message(err);
    }
    if (why !== undefined) {
      live.messageId = messageId;
      this.#note(`kanban: the progress card of run ${row.runId} was sent as ${messageId}, and not recorded (${why})`);
    }
    return true;
  }

  async #update(row: ProgressCardRow, run: RunRow, live: Live, force: boolean, pressedOn?: string): Promise<boolean> {
    const messageId = pressedOn ?? row.messageId ?? live.messageId;
    const channel = this.#deps.channels.get(row.channel);
    if (messageId === undefined || messageId === null || channel === undefined) return false;
    if (force) this.#readPress(live, run, false);
    else if (!this.#read(live, run, false)) return false;
    const view = this.#view(row, run, live);
    if (view === undefined) return false;
    const state = progressState(run);
    if (!force && view.markdown === live.markdown && state === live.state && this.tryOf(row.runId) === live.tried) return false;
    live.lastTriedAt = this.#clock.now();
    try {
      await this.#bounded(Promise.resolve().then(() => channel.updateCard(messageId, view)), this.#deps.redrawTimeoutMs ?? REDRAW_MS);
    } catch (err) {
      this.#failed(row, live, err, 'update');
      return true;
    }
    this.#landed(live, view, run);
    try {
      const r = this.#deps.service.progressCardDrawn(row.runId, live.progress.throughSeq);
      if (!r.ok) this.#note(`kanban: the progress card of run ${row.runId} was drawn, and not recorded (${r.code})`);
    } catch (err) {
      this.#note(`kanban: the progress card of run ${row.runId} was drawn, and not recorded (${message(err)})`);
    }
    return true;
  }

  /**
   * The final draw (spec §6.6): once every tool event is folded, read by type;
   * an `open` row marked `final` when it lands, any other left as it is. A
   * press's draws what its capped read folded; a row it left behind is not
   * marked, and the loop folds the rest and draws it final.
   */
  async #final(row: ProgressCardRow, run: RunRow, live: Live, opts: { force: boolean; messageId?: string; pressedEnded?: boolean }): Promise<boolean> {
    const messageId = opts.messageId ?? row.messageId ?? live.messageId;
    const channel = this.#deps.channels.get(row.channel);
    if (messageId === undefined || messageId === null || channel === undefined) return false;
    const caughtUp = opts.force ? this.#readPress(live, run, true) : this.#read(live, run, true);
    if (!caughtUp && !opts.force) return false;
    const view = this.#view(row, run, live, opts.pressedEnded === true ? { pressedEnded: true } : {});
    if (view === undefined) return false;
    live.lastTriedAt = this.#clock.now();
    try {
      await this.#bounded(Promise.resolve().then(() => channel.updateCard(messageId, view)), this.#deps.redrawTimeoutMs ?? REDRAW_MS);
    } catch (err) {
      if (row.state === 'open') this.#failed(row, live, err, 'final');
      else this.#note(`kanban: the progress card of run ${row.runId} (message ${messageId}) was not redrawn (${message(err)})`);
      return true;
    }
    this.#landed(live, view, run);
    if (row.state !== 'open' || run.endedAt === null || !caughtUp) return true;
    try {
      const r = this.#deps.service.progressCardFinal(row.runId, live.progress.throughSeq);
      if (!r.ok) this.#note(`kanban: the progress card of run ${row.runId} was drawn final, and not recorded (${r.code})`);
    } catch (err) {
      this.#note(`kanban: the progress card of run ${row.runId} was drawn final, and not recorded (${message(err)})`);
    }
    this.#forget(row.runId);
    return true;
  }

  #landed(live: Live, view: CardView, run: RunRow): void {
    live.markdown = view.markdown;
    live.state = progressState(run);
    live.tried = this.tryOf(run.runId);
    live.drawnAt = this.#clock.now();
    delete live.hold;
    delete live.dirty;
  }

  /**
   * A draw that failed (spec §9): a card or chat that is gone is let go of; a
   * refusal counts, ten in a row letting a send or a final go and leaving a
   * card as it is; anything else is held back, never counted.
   */
  #failed(row: ProgressCardRow, live: Live, err: unknown, kind: Kind, chatId?: string): void {
    live.dirty = true;
    const why = message(err);
    const code = err instanceof ChannelError ? err.code : 0;
    const gone = err instanceof ChannelError && (UNREACHABLE_CODES.has(code) || (kind !== 'send' && CARD_GONE_CODES.has(code)));
    if (gone) {
      this.#letGo(row.runId);
      this.#note(
        kind === 'send'
          ? `kanban: the progress card of run ${row.runId} cannot reach ${chatId ?? 'its chat'} (${why}); the run goes without one`
          : `kanban: the progress card of run ${row.runId} (message ${row.messageId ?? live.messageId ?? 'none'}) is gone (${why}); letting it go`,
      );
      return;
    }
    const refused = err instanceof ChannelError && err.code !== 0 && !err.retryable;
    if (refused) {
      let failures = 0;
      try {
        const r = this.#deps.service.progressCardRefused(row.runId);
        failures = r.ok ? r.failures : 0;
      } catch {
        // Counted again at the next refusal.
      }
      if (failures >= REFUSALS_LIMIT) {
        if (kind === 'update') {
          if (live.leftSaid !== true) {
            live.leftSaid = true;
            this.#note(
              `kanban: the progress card of run ${row.runId} (message ${row.messageId ?? live.messageId ?? 'none'}) was refused ${REFUSALS_LIMIT} updates in a row (${why}); it is left as it is, and drawn final if Lark takes it`,
            );
          }
          return;
        }
        this.#letGo(row.runId);
        this.#note(
          kind === 'send'
            ? `kanban: the progress card of run ${row.runId} was refused ${REFUSALS_LIMIT} times (${why}); the run goes without one`
            : `kanban: the progress card of run ${row.runId} was refused its final draw ${REFUSALS_LIMIT} times in a row (${why}); letting it go`,
        );
        return;
      }
    }
    const retryAfter = err instanceof ChannelError ? (err.retryAfterMs ?? 0) : 0;
    const base = kind === 'send' ? 2_000 : PROGRESS_PACE_MS;
    const max = kind === 'send' ? CARD_BACKOFF_MAX_MS : UPDATE_HOLD_MAX_MS;
    const waitMs = Math.min((live.hold?.waitMs ?? base / 2) * 2, max);
    live.hold = { until: this.#clock.now() + Math.max(waitMs, retryAfter), waitMs };
    this.#note(
      `kanban: the progress card of run ${row.runId} was not ${kind === 'send' ? 'sent' : 'drawn'} (${why}); trying again in ${Math.round(Math.max(waitMs, retryAfter) / 1000)} s`,
    );
  }

  #letGo(runId: string): void {
    try {
      this.#deps.service.progressCardLetGo(runId);
    } catch (err) {
      this.#note(`kanban: letting go of the progress card of run ${runId} failed: ${message(err)}`);
    }
    this.#forget(runId);
  }

  /** A draw, waited for at most `ms`: past it, it fails, held and not counted. */
  async #bounded<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      const took = ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
      timer = setTimeout(() => reject(new Error(`the draw took longer than ${took}`)), ms);
    });
    try {
      return await Promise.race([work, late]);
    } finally {
      clearTimeout(timer);
      work.catch(() => undefined);
    }
  }
}
