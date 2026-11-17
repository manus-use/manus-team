import type { Channel, SendTarget } from '../channel/types.js';
import { cronUuid } from '../core/ids.js';
import type { SessionRegistry } from '../core/registry.js';
import { bindingsOnChannel } from '../db/bindings.js';
import {
  CRON_CHANNEL,
  attachFireSession,
  dropStaleStamps,
  dueJobs,
  endFire,
  getFire,
  getJob,
  interruptOpenFires,
  lastResult,
  markDelivered,
  pendingDeliveries,
  purgeRemoved,
  removedJobs,
  runningFire,
  runningFires,
  skipFire,
  stampedJobs,
  startFire,
  type EndFire,
  type FireRow,
  type JobRow,
} from '../db/cron.js';
import type { Db } from '../db/open.js';
import { turnText } from '../kanban/session-log.js';
import { redactKnownSecrets } from '../secrets.js';
import { systemClock, type Clock } from '../time.js';
import type { BindingKey, TurnTerminal } from '../types.js';
import { CRON_OWNER } from './owner.js';
import { answerMessages, composeFirePrompt, isNothing, outcomeLine } from './prompt.js';
import { isOneOff, lateLimit, missedSlots, parseSchedule, runAfter, type Schedule } from './schedule.js';
import type { CronService } from './service.js';

/**
 * The scheduler (the cron spec, §4, §5): the one component that fires cron
 * jobs, in the gateway, behind its locks.
 *
 * **A tick** runs every TICK_MS, and once for each nudge: removed jobs' fires
 * stopped and the jobs purged; the idle limits of running fires; the pending
 * deliveries sent; then the due jobs, oldest first, and the pending stamps.
 * Synchronous up to each fire's start; the fires go on in the background.
 *
 * **One entry, one ending** (§4.2). Each running fire has one entry in memory:
 * `mark`, the outcome it is marked to end with, and `archiving`. Every path that
 * starts the archive of its session sets `archiving` first, and does nothing if
 * it is set already; a fire is ended once, when that archive settles, with its
 * mark if one is set, else with what its turn's end read; a fire with no
 * session yet is ended by the path that finds it marked. So a fire is never
 * ended by both a turn's end and a stop.
 *
 * **The in-flight set** is those entries: a fire leaves it once its end is
 * recorded and any send of it has ended, never on the turn's submit promise,
 * which a release may leave unsettled. A pending delivery of a fire in it is
 * not sent by the tick beside its own send, and a removed job with a fire in it
 * is not purged from under it.
 */

/** How often the scheduler ticks (§4.1). */
export const TICK_MS = 30_000;
/** A pending stamp older than this at a start is dropped (§4.4). */
export const STAMP_MAX_AGE_MS = 3_600_000;

export interface CronSettings {
  /** Fires at once (§10). */
  maxRunning: number;
  /** A fire's turn with no activity this long is cancelled (§5.4). */
  idleTimeoutS: number;
}

export interface CronSchedulerDeps {
  db: Db;
  service: CronService;
  sessions: SessionRegistry;
  /** By a delivery's channel id: `lark` to the Lark adapter. */
  channels: ReadonlyMap<string, Channel>;
  appId: string;
  settings: CronSettings;
  clock?: Clock;
  /** Metadata only: ids, outcomes, counts and times. */
  note?: (line: string) => void;
}

/** Where a fire's session is bound (§5.2): the cron channel, at the job and the fire. */
export function fireKey(appId: string, jobId: string, fireId: number): BindingKey {
  return { channel: CRON_CHANNEL, appId, conversationId: jobId, threadId: String(fireId) };
}

type Mark = 'timed_out' | 'interrupted';

/** A running fire this process started (§4.2). */
interface Entry {
  fireId: number;
  jobId: string;
  key: BindingKey;
  sessionId?: string;
  /** The outcome it is marked to end with, by a removal or the idle limit. */
  mark?: Mark;
  /** The archive of its session has been started: by whichever path came first. */
  archiving: boolean;
  /** A fire marked timed out whose job was then removed: its line has no one to tell. */
  silent: boolean;
  /** Its session's environment, held only here. */
  env: Record<string, string>;
  /** Its agent's own arguments. */
  args: readonly string[];
  /** The fire's work in the background, until it leaves the set. */
  done: Promise<void>;
  leave: () => void;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class CronScheduler {
  readonly #deps: CronSchedulerDeps;
  readonly #clock: Clock;
  readonly #note: (line: string) => void;
  /** The in-flight set: running fires this process started, by fire id. */
  readonly #entries = new Map<number, Entry>();
  /** Work in the background: fires, sends and archives, so `idle()` can wait for it. */
  readonly #inflight = new Set<Promise<void>>();
  /** Fires whose message is being sent: a second ask for one, from any path, waits for none and sends nothing. */
  readonly #sending = new Set<number>();
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #ticking = false;
  #again = false;

  constructor(deps: CronSchedulerDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
    const note = deps.note ?? (() => undefined);
    this.#note = (line) => {
      try {
        note(redactKnownSecrets(line));
      } catch {
        // Nowhere left to say it.
      }
    };
  }

  /** A fire's session's environment, for the registry to give its agent; undefined for any other session. */
  envFor(sessionId: string): Readonly<Record<string, string>> | undefined {
    return this.#bySession(sessionId)?.env;
  }

  /** A fire's agent's own arguments. */
  argsFor(sessionId: string): readonly string[] | undefined {
    const args = this.#bySession(sessionId)?.args;
    return args === undefined || args.length === 0 ? undefined : args;
  }

  /** A running fire's actor is never retired to make room (§5.2). */
  pinned(sessionId: string): boolean {
    return this.#bySession(sessionId) !== undefined;
  }

  /** Whether a job has a fire in this process's in-flight set. */
  inFlight(jobId: string): boolean {
    return [...this.#entries.values()].some((e) => e.jobId === jobId);
  }

  #bySession(sessionId: string): Entry | undefined {
    for (const e of this.#entries.values()) if (e.sessionId === sessionId) return e;
    return undefined;
  }

  /**
   * Before the channel connects (§4.4): every fire left open ended
   * `interrupted`, every session still bound on the cron channel archived, and
   * the stamps older than an hour dropped. Never rejects.
   */
  async boot(): Promise<void> {
    const now = this.#clock.now();
    try {
      for (const fire of interruptOpenFires(this.#deps.db, now)) {
        this.#note(`cron: fire ${fire.fireId} of job ${fire.jobId} was interrupted by the restart`);
      }
    } catch (err) {
      this.#note(`cron: ending the open fires after a restart failed: ${message(err)}`);
    }
    let bound: ReturnType<typeof bindingsOnChannel> = [];
    try {
      bound = bindingsOnChannel(this.#deps.db, CRON_CHANNEL, this.#deps.appId);
    } catch (err) {
      this.#note(`cron: reading the cron bindings after a restart failed: ${message(err)}`);
    }
    for (const b of bound) {
      try {
        await this.#deps.sessions.archive(
          { channel: b.channel, appId: b.appId, conversationId: b.conversationId, threadId: b.threadId },
          'the cron fire is over',
        );
        this.#note(`cron: session ${b.sessionId} archived after a restart`);
      } catch {
        // Not quoted: it can carry an agent's stderr.
        this.#note(`cron: archiving session ${b.sessionId} failed after a restart`);
      }
    }
    try {
      for (const job of dropStaleStamps(this.#deps.db, now - STAMP_MAX_AGE_MS, now)) {
        this.#note(`cron: a run of job ${job.jobId} asked for while the gateway was down was dropped`);
      }
    } catch (err) {
      this.#note(`cron: dropping old runs failed: ${message(err)}`);
    }
  }

  /** Once connected (§4.4): the first tick, then one every TICK_MS. */
  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setInterval(() => this.tick(), TICK_MS);
    this.#timer.unref();
    this.tick();
  }

  /**
   * Stop: no more ticks, and nothing more recorded. Every running fire is left
   * open in the database, for the next boot to end `interrupted` (§5.4).
   */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    // Left open for the next boot; only an archive under way is still waited for, by idle().
    for (const entry of [...this.#entries.values()]) if (!entry.archiving) entry.leave();
  }

  /** Wait for the background work, or at most `boundMs`: true once drained. */
  async idle(boundMs?: number): Promise<boolean> {
    const drained = (async () => {
      while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
      return true;
    })();
    if (boundMs === undefined) return drained;
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

  #track(work: Promise<void>): void {
    const tracked = work.catch((err: unknown) => this.#note(`cron: ${message(err)}`));
    this.#inflight.add(tracked);
    tracked.finally(() => this.#inflight.delete(tracked)).catch(() => undefined);
  }

  /**
   * One tick (§4.2), each step's failure noted and the rest going on. One that
   * comes while the last is still going is merged into it.
   */
  tick(): void {
    if (this.#stopped) return;
    if (this.#ticking) {
      this.#again = true;
      return;
    }
    this.#ticking = true;
    try {
      do {
        this.#again = false;
        this.#step('stopping removed jobs', () => this.#removed());
        this.#step('checking idle fires', () => this.#idleLimits());
        this.#step('sending pending deliveries', () => this.#pending());
        this.#step('firing due jobs', () => this.#due());
      } while (this.#again && !this.#stopped);
    } finally {
      this.#ticking = false;
    }
  }

  #step(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.#note(`cron: ${what} failed: ${message(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Step 1: removed jobs

  #removed(): void {
    const removed = new Set(removedJobs(this.#deps.db).map((j) => j.jobId));
    for (const entry of this.#entries.values()) {
      if (!removed.has(entry.jobId)) continue;
      // Marked timed out already: it keeps its mark, and has no one to tell (§4.2).
      if (entry.mark === 'timed_out') entry.silent = true;
      if (entry.mark !== undefined || entry.archiving) continue;
      entry.mark = 'interrupted';
      this.#note(`cron: job ${entry.jobId} was removed; stopping its fire ${entry.fireId}`);
      this.#stopFire(entry);
    }
    purgeRemoved(this.#deps.db, (jobId) => this.inFlight(jobId));
  }

  /** A removal's stop (§4.2 (b)): the turn cancelled and the archive started at once. */
  #stopFire(entry: Entry): void {
    if (entry.sessionId === undefined) return;
    const actor = this.#deps.sessions.liveActor(entry.sessionId);
    if (actor !== undefined) void actor.cancel().catch(() => undefined);
    this.#archive(entry, undefined);
  }

  // -------------------------------------------------------------------------
  // Step 2: the idle limits (§5.4)

  #idleLimits(): void {}

  // -------------------------------------------------------------------------
  // Step 3: pending deliveries (§5.6)

  #pending(): void {
    for (const fire of pendingDeliveries(this.#deps.db)) {
      if (this.#entries.has(fire.fireId)) continue;
      this.#track(this.#send(fire.fireId));
    }
  }

  /**
   * Send a fire's message, built from its record and its session's log, with
   * its uuids, then mark it sent or failed, once at a time whoever asks: its
   * end, a skip, a tick or a nudge. Never throws.
   */
  async #send(fireId: number): Promise<void> {
    if (this.#sending.has(fireId)) return;
    this.#sending.add(fireId);
    try {
      await this.#sendOnce(fireId);
    } finally {
      this.#sending.delete(fireId);
    }
  }

  async #sendOnce(fireId: number): Promise<void> {
    const fire = getFire(this.#deps.db, fireId);
    if (fire === undefined || fire.delivery !== 'pending') return;
    const job = getJob(this.#deps.db, fire.jobId);
    const delivery = job?.delivery ?? null;
    const channel = delivery === null ? undefined : this.#deps.channels.get(delivery.channel);
    const parts = job === undefined ? [] : this.#messages(job, fire);
    if (job === undefined || delivery === null || channel === undefined || parts.length === 0) {
      markDelivered(this.#deps.db, fireId, 'failed');
      this.#note(`cron: fire ${fireId} of job ${fire.jobId} has nowhere to be posted`);
      return;
    }
    const target: SendTarget = { chatId: delivery.chat, threadId: delivery.thread, ...(delivery.root === null || delivery.thread === '' ? {} : { root: delivery.root }) };
    try {
      for (const [part, text] of parts.entries()) {
        await channel.sendText(target, redactKnownSecrets(text), cronUuid(this.#deps.appId, job.jobId, fireId, part));
      }
      markDelivered(this.#deps.db, fireId, 'sent');
    } catch {
      // Not quoted: a refusal can quote the message.
      markDelivered(this.#deps.db, fireId, 'failed');
      this.#note(`cron: posting fire ${fireId} of job ${job.jobId} failed; its result is in the job's history`);
    }
  }

  /** What a fire posts (§5.6): a posted answer read again from its session's log, or its one line. */
  #messages(job: JobRow, fire: FireRow): string[] {
    if (fire.outcome === 'posted') {
      const answer = fire.sessionId === null ? (fire.result ?? '') : turnText(this.#deps.db, fire.sessionId).output;
      return answerMessages(job, fire, answer);
    }
    const line = outcomeLine({ ...job, nextRunAt: this.#nextShown(job) }, fire);
    return line === undefined ? [] : [line];
  }

  /**
   * The next run a line names: the job's, unless the gateway was down past it
   * and this tick will skip it as too late, when it is the slot after (§4.3).
   */
  #nextShown(job: JobRow): number | null {
    const next = job.nextRunAt;
    const now = this.#clock.now();
    if (next === null || next >= now) return next;
    const schedule = parseSchedule(job.schedule);
    if (!schedule.ok || now - next <= lateLimit(schedule.schedule, job.tz, next)) return next;
    return runAfter(schedule.schedule, job.tz, next, now) ?? null;
  }

  // -------------------------------------------------------------------------
  // Step 4: due jobs and stamps (§4.2, §4.3)

  #due(): void {
    const now = this.#clock.now();
    for (const job of dueJobs(this.#deps.db, now)) {
      try {
        this.#dueJob(job, now);
      } catch (err) {
        this.#note(`cron: job ${job.jobId} could not be fired: ${message(err)}`);
      }
    }
    for (const job of stampedJobs(this.#deps.db)) {
      try {
        this.#stamped(job);
      } catch (err) {
        this.#note(`cron: a run of job ${job.jobId} could not be fired: ${message(err)}`);
      }
    }
  }

  #schedule(job: JobRow): Schedule | undefined {
    const parsed = parseSchedule(job.schedule);
    if (parsed.ok) return parsed.schedule;
    this.#note(`cron: job ${job.jobId}'s schedule cannot be read: ${parsed.message}`);
    return undefined;
  }

  #dueJob(job: JobRow, now: number): void {
    const schedule = this.#schedule(job);
    const slot = job.nextRunAt;
    if (schedule === undefined || slot === null) return;
    const expected = {
      jobId: job.jobId,
      trigger: 'schedule' as const,
      slot,
      schedule: job.schedule,
      tz: job.tz,
      ...(isOneOff(schedule) ? {} : { next: runAfter(schedule, job.tz, slot, now) }),
    };
    if (runningFire(this.#deps.db, job.jobId) !== undefined) {
      skipFire(this.#deps.db, { ...expected, scheduledAt: slot, outcome: 'skipped_running' }, now);
      return;
    }
    if (now - slot > lateLimit(schedule, job.tz, slot)) {
      const n = missedSlots(schedule, job.tz, slot, now);
      const said = `${n} slot${n === 1 ? '' : 's'} missed`;
      skipFire(this.#deps.db, { ...expected, scheduledAt: slot, outcome: 'skipped_missed', error: said }, now);
      this.#note(`cron: job ${job.jobId} skipped its slot at ${new Date(slot).toISOString()} as too late: ${said}`);
      return;
    }
    if (runningFires(this.#deps.db).length >= this.#deps.settings.maxRunning) return;
    const unavailable = this.#deps.service.unavailable(job.role, job.workspace);
    if (unavailable !== undefined) {
      this.#skipUnavailable(skipFire(this.#deps.db, { ...expected, scheduledAt: slot, outcome: 'skipped_unavailable', error: unavailable }, now), job);
      return;
    }
    const started = startFire(this.#deps.db, { ...expected, scheduledAt: slot, maxRunning: this.#deps.settings.maxRunning }, now);
    if (started.ok) this.#begin(job, started.fire);
  }

  #stamped(job: JobRow): void {
    const stamp = job.runRequestedAt;
    if (stamp === null) return;
    // A stamp that meets a running fire waits, as one at max_running does (§4.5).
    if (runningFire(this.#deps.db, job.jobId) !== undefined) return;
    if (runningFires(this.#deps.db).length >= this.#deps.settings.maxRunning) return;
    const now = this.#clock.now();
    const expected = { jobId: job.jobId, trigger: 'run' as const, schedule: job.schedule, tz: job.tz };
    const unavailable = this.#deps.service.unavailable(job.role, job.workspace);
    if (unavailable !== undefined) {
      this.#skipUnavailable(skipFire(this.#deps.db, { ...expected, scheduledAt: stamp, outcome: 'skipped_unavailable', error: unavailable }, now), job);
      return;
    }
    const started = startFire(this.#deps.db, { ...expected, scheduledAt: stamp, maxRunning: this.#deps.settings.maxRunning }, now);
    if (started.ok) this.#begin(job, started.fire);
  }

  /** A skip for an unavailable role or workspace (§2.3): noted, and its line sent. */
  #skipUnavailable(r: ReturnType<typeof skipFire>, job: JobRow): void {
    if (!r.ok) return;
    this.#note(`cron: job ${job.jobId} skipped: its role or workspace is not usable${r.paused ? '; paused after 3 failures in a row' : ''}`);
    if (r.fire.delivery === 'pending') this.#track(this.#send(r.fire.fireId));
  }

  // -------------------------------------------------------------------------
  // A fire (§5)

  /** Start a fire's work in the background, its entry in the in-flight set. */
  #begin(job: JobRow, fire: FireRow): void {
    let leave = (): void => undefined;
    const left = new Promise<void>((resolve) => {
      leave = resolve;
    });
    const entry: Entry = {
      fireId: fire.fireId,
      jobId: job.jobId,
      key: fireKey(this.#deps.appId, job.jobId, fire.fireId),
      archiving: false,
      silent: false,
      env: {},
      args: [],
      done: left,
      leave: () => {
        this.#entries.delete(fire.fireId);
        leave();
      },
    };
    this.#entries.set(fire.fireId, entry);
    this.#note(`cron: job ${job.jobId} fires (fire ${fire.fireId}, ${fire.trigger})`);
    // Not waited for by idle(): a turn a release leaves unsettled would hold it for ever. The fire's leaving is.
    void this.#run(entry, job, fire).catch((err: unknown) => this.#failed(entry, err));
    this.#track(left);
  }

  /** The fire's body: the session, its one turn, and the turn's end. */
  async #run(entry: Entry, job: JobRow, fire: FireRow): Promise<void> {
    const prompt = await this.#prepare(entry, job, fire);
    if (prompt === undefined) return;
    if (this.#stopped) return;
    // Marked while it was prepared, with no session yet: ended now, by this path (§4.2).
    if (entry.mark !== undefined) {
      this.#endNow(entry, { fireId: entry.fireId, outcome: entry.mark, error: this.#markError(entry.mark), message: false });
      return;
    }
    const sessionId = this.#deps.sessions.create(entry.key, CRON_OWNER, { role: job.role, workspace: job.workspace }).id;
    entry.sessionId = sessionId;
    attachFireSession(this.#deps.db, entry.fireId, sessionId);
    const actor = await this.#deps.sessions.actorFor(sessionId, entry.key);
    if (this.#stopped || entry.mark !== undefined || entry.archiving) return;
    let terminal: TurnTerminal;
    let thrown: string | undefined;
    try {
      terminal = await actor.submit({ messageId: `cron:${entry.fireId}`, appId: this.#deps.appId, input: { text: prompt, paths: [] } });
    } catch (err) {
      terminal = 'failed';
      thrown = message(err);
    }
    this.#turnEnded(entry, terminal, thrown);
  }

  /**
   * What comes before the session: the fire's prompt, or undefined when the fire
   * was ended or left on the way.
   */
  async #prepare(_entry: Entry, job: JobRow, fire: FireRow): Promise<string | undefined> {
    const previous = lastResult(this.#deps.db, job.jobId);
    return composeFirePrompt({
      role: [],
      job,
      scheduledAt: fire.scheduledAt,
      ...(previous === undefined ? {} : { previous: { result: previous.result ?? '', at: previous.scheduledAt } }),
    });
  }

  /** The turn has ended (§5.5): read from its terminal, unless marked, archiving, or stopped. */
  #turnEnded(entry: Entry, terminal: TurnTerminal, thrown: string | undefined): void {
    if (this.#stopped || entry.archiving) return;
    // Marked and not archiving: the turn's end starts the archive, which ends it with the mark (§4.2 (c)).
    if (entry.mark !== undefined) {
      this.#archive(entry, undefined);
      return;
    }
    const sessionId = entry.sessionId ?? '';
    const turn = turnText(this.#deps.db, sessionId);
    let ending: EndFire;
    if (terminal === 'completed') {
      ending = isNothing(turn.output)
        ? { fireId: entry.fireId, outcome: 'nothing', result: turn.output.trim(), message: false }
        : { fireId: entry.fireId, outcome: 'posted', result: turn.output, message: true };
    } else {
      const errors = thrown === undefined || turn.errors.includes(thrown) ? turn.errors : [...turn.errors, thrown];
      ending = { fireId: entry.fireId, outcome: 'agent_failed', error: errors.join('\n') || `the turn ended ${terminal}`, message: true };
    }
    this.#archive(entry, ending);
  }

  #markError(mark: Mark): string {
    return mark === 'interrupted' ? 'the job was removed' : `stopped after ${this.#deps.settings.idleTimeoutS} s with no activity`;
  }

  /**
   * Start the archive of a fire's session, once (§4.2 (a)), in the background;
   * when it settles, resolved or rejected, the fire is ended with its mark, else
   * with `ending`. After a stop, nothing is recorded.
   */
  #archive(entry: Entry, ending: EndFire | undefined): void {
    if (entry.archiving) return;
    entry.archiving = true;
    const settle = async (): Promise<void> => {
      try {
        await this.#deps.sessions.archive(entry.key, 'the cron fire is over');
      } catch {
        // Not quoted: it can carry an agent's stderr. The next boot archives what is left bound.
        this.#note(`cron: archiving the session of fire ${entry.fireId} failed; ending the fire anyway`);
      }
      if (this.#stopped) {
        entry.leave();
        return;
      }
      const mark = entry.mark;
      const end: EndFire =
        mark !== undefined
          ? { fireId: entry.fireId, outcome: mark, error: this.#markError(mark), message: mark === 'timed_out' && !entry.silent }
          : (ending ?? { fireId: entry.fireId, outcome: 'agent_failed', error: 'the fire ended with no outcome', message: true });
      await this.#finish(entry, end);
    };
    this.#track(settle());
  }

  /** End a fire with no session: at once, then its send. */
  #endNow(entry: Entry, end: EndFire): void {
    this.#track(this.#finish(entry, end));
  }

  /** The fire's end recorded, its message sent, and the fire out of the in-flight set. */
  async #finish(entry: Entry, end: EndFire): Promise<void> {
    try {
      const r = endFire(this.#deps.db, end, this.#clock.now());
      if (r.ok) {
        this.#note(`cron: fire ${entry.fireId} of job ${entry.jobId} ended ${end.outcome}${r.paused ? '; the job is paused after 3 failures in a row' : ''}`);
        if (r.fire.delivery === 'pending') await this.#send(entry.fireId);
      }
    } catch (err) {
      this.#note(`cron: ending fire ${entry.fireId} failed: ${message(err)}`);
    } finally {
      entry.leave();
    }
  }

  /** A fire whose work threw: ended `agent_failed`, its session archived first if it has one. */
  #failed(entry: Entry, err: unknown): void {
    if (entry.archiving) return;
    if (this.#stopped) {
      entry.leave();
      return;
    }
    const failure: EndFire = { fireId: entry.fireId, outcome: 'agent_failed', error: `the fire could not start: ${message(err)}`, message: true };
    if (entry.sessionId === undefined) {
      if (entry.mark !== undefined) this.#endNow(entry, { fireId: entry.fireId, outcome: entry.mark, error: this.#markError(entry.mark), message: false });
      else this.#endNow(entry, failure);
    } else this.#archive(entry, failure);
  }
}
