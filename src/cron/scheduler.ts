import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { delimiter } from 'node:path';
import type { Channel, SendTarget } from '../channel/types.js';
import { cronUuid } from '../core/ids.js';
import type { SessionRegistry } from '../core/registry.js';
import { bindingsOnChannel } from '../db/bindings.js';
import {
  CRON_CHANNEL,
  attachFireSession,
  deleteLeftoverCronSession,
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
import { lastEventAt } from '../db/events.js';
import type { Db } from '../db/open.js';
import type { WorkerAccess } from '../kanban/dispatcher.js';
import { gateEnv, spawnGate, type GateExit, type GateRunner } from '../kanban/gates.js';
import { roleSections } from '../kanban/prompt.js';
import { turnText } from '../kanban/session-log.js';
import { nativeFor, PackagesInUse, renderNative, stepsDropped, sweepRole, sweepRoles, type Rendered } from '../render/native.js';
import type { Role } from '../roles.js';
import { redactKnownSecrets, withholdSecretSuffix } from '../secrets.js';
import { systemClock, type Clock } from '../time.js';
import type { BindingKey, TurnTerminal } from '../types.js';
import { CRON_OWNER } from './owner.js';
import { SCRIPT_PROMPT_BYTES, answerMessages, composeFirePrompt, isNothing, outcomeLine } from './prompt.js';
import { isOneOff, lateLimit, latestSlot, missedSlots, parseSchedule, runAfter, type Schedule } from './schedule.js';
import type { CronService } from './service.js';
import type { CronTokens } from './tokens.js';

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
/** A fire's script's time limit (§5.1): fixed, as a script gathers data for a prompt. */
export const SCRIPT_TIMEOUT_MS = 120_000;
/** Begins a script's output in the prompt when its start was cut (§5.1). */
const CUT_MARKER = '[earlier output cut]\n';

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
  /** The roles as loaded: whose environment a script gets, whose role.md and skills a fire's agent. */
  roles: ReadonlyMap<string, Role>;
  /** Workspace name to directory: where a fire's script runs. */
  workspaceDirs: ReadonlyMap<string, string>;
  /** The environment an agent's allowlist is taken from; the gateway's own, unless a test gives one. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Runs a fire's script; `spawnGate`, unless a test gives one. */
  runner?: GateRunner;
  /** Where roles are rendered as native agent packages, `$MT_HOME/rendered` (§5.2); absent, none is. */
  renderRoot?: string;
  /** The rendered packages in use, shared with the dispatcher (§5.2); absent, the scheduler's own. */
  packages?: PackagesInUse;
  /** Sweep the rendered packages at boot, as the dispatcher's boot does when the board is on (§13). */
  sweepRendersAtBoot?: boolean;
  /** The socket and the shim a fire's agent finds the gateway's mt through (§7.2); a script, the shim alone (§5.1). */
  worker?: WorkerAccess;
  /** The gateway's home, config file and database, which a fire's script is given (§5.1); absent, none are. */
  scriptHome?: ScriptHome;
  /** Mints a fire's token, `MT_CRON_TOKEN`, held while it runs (§7.2); absent, a fire gets none. */
  tokens?: CronTokens;
}

/**
 * Where the gateway's files are, as it resolved them (§5.1): its home, the config
 * file it read, if any, and the database it opened. Its own dep, not
 * `WorkerAccess`'s, which is the socket's and the launcher's.
 */
export interface ScriptHome {
  home: string;
  configPath: string | undefined;
  dbPath: string;
}

/** A PATH that finds the gateway's `mt` launcher first, then the role's own PATH, else the gateway's (§7.2). */
function mtFirst(role: Role, worker: WorkerAccess): string {
  const rest = role.agent.env['PATH'] ?? worker.path;
  return rest === undefined || rest === '' ? worker.mtDir : `${worker.mtDir}${delimiter}${rest}`;
}

/**
 * A fire's script's environment (§5.1): its role's, as a gate's (`gateEnv`),
 * then `PATH` with the gateway's `mt` launcher first, and `MT_HOME`, `MT_CONFIG`
 * and `MT_DB` the gateway's, set after the role's, so plain `mt` in a script
 * opens exactly this gateway's files. None is an agent's variable, so the
 * script is a terminal: the operator's commands work in it.
 */
export function scriptEnv(
  role: Role,
  env: Readonly<Record<string, string | undefined>>,
  worker: WorkerAccess | undefined,
  home: ScriptHome | undefined,
): Record<string, string> {
  const out = gateEnv(role, env);
  if (worker !== undefined) out['PATH'] = mtFirst(role, worker);
  if (home !== undefined) {
    out['MT_HOME'] = home.home;
    if (home.configPath === undefined) delete out['MT_CONFIG'];
    else out['MT_CONFIG'] = home.configPath;
    out['MT_DB'] = home.dbPath;
  }
  return out;
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
  /** The tick its idle cancel was sent in: it is released at a later one (§5.4). */
  cancelTick?: number;
  /** Aborts its script, for a removal or a stop (§5.1). */
  abort: AbortController;
  /** The native package its agent runs, held in the in-use set while it runs. */
  packageDir?: string;
  /** Its token, in the masker until it leaves the set. */
  token?: string | undefined;
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
  readonly #packages: PackagesInUse;
  /** Ticks so far: an idle cancel's release waits for the next one. */
  #tickNo = 0;
  /** The in-flight set: running fires this process started, by fire id. */
  readonly #entries = new Map<number, Entry>();
  /** Work in the background: fires, sends and archives, so `idle()` can wait for it. */
  readonly #inflight = new Set<Promise<void>>();
  /** Fires whose message is being sent: a second ask for one, from any path, waits for none and sends nothing. */
  readonly #sending = new Set<number>();
  /** Jobs whose schedule was noted as unreadable, so it is said once. */
  readonly #unreadable = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #ticking = false;
  #again = false;

  constructor(deps: CronSchedulerDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
    this.#packages = deps.packages ?? new PackagesInUse();
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
        continue;
      }
      try {
        // A purged job's fire whose own archive was refused: no fire names the session, so nothing else deletes it.
        if (deleteLeftoverCronSession(this.#deps.db, b.sessionId)) this.#note(`cron: session ${b.sessionId}, of no recorded fire, deleted after a restart`);
      } catch (err) {
        this.#note(`cron: deleting session ${b.sessionId} after a restart failed: ${message(err)}`);
      }
    }
    try {
      for (const job of dropStaleStamps(this.#deps.db, now - STAMP_MAX_AGE_MS, now)) {
        this.#note(`cron: a run of job ${job.jobId} asked for while the gateway was down was dropped`);
      }
    } catch (err) {
      this.#note(`cron: dropping old runs failed: ${message(err)}`);
    }
    // With the board off, the dispatcher's boot does not: nothing is in use at boot.
    const root = this.#deps.renderRoot;
    if (this.#deps.sweepRendersAtBoot === true && root !== undefined) {
      try {
        sweepRoles(root, new Set(this.#deps.roles.keys()));
      } catch (err) {
        this.#note(`cron: sweeping the rendered packages after a restart failed: ${message(err)}`);
      }
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
    for (const entry of [...this.#entries.values()]) {
      entry.abort.abort();
      if (!entry.archiving) entry.leave();
    }
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
        this.#tickNo += 1;
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

  /** A removal's stop (§4.2 (b)): the script aborted, or the turn cancelled and the archive started at once. */
  #stopFire(entry: Entry): void {
    entry.abort.abort();
    if (entry.sessionId === undefined) return;
    const actor = this.#deps.sessions.liveActor(entry.sessionId);
    if (actor !== undefined) void actor.cancel().catch(() => undefined);
    this.#archive(entry, undefined);
  }

  // -------------------------------------------------------------------------
  // Step 2: the idle limits (§5.4)

  /**
   * A fire whose session has had no event for `idle_timeout_s` is marked
   * `timed_out` and its turn cancelled; one marked so a tick ago and still not
   * archiving ignored the cancel, and its session is released by its archive.
   */
  #idleLimits(): void {
    const now = this.#clock.now();
    const limit = this.#deps.settings.idleTimeoutS * 1000;
    for (const entry of this.#entries.values()) {
      if (entry.sessionId === undefined || entry.archiving) continue;
      if (entry.mark === 'timed_out' && entry.cancelTick !== undefined) {
        if (this.#tickNo > entry.cancelTick) {
          this.#note(`cron: fire ${entry.fireId} ignored its cancel; releasing its session`);
          this.#archive(entry, undefined);
        }
        continue;
      }
      if (entry.mark !== undefined) continue;
      const last = lastEventAt(this.#deps.db, entry.sessionId);
      if (last === undefined || now - last < limit) continue;
      entry.mark = 'timed_out';
      entry.cancelTick = this.#tickNo;
      this.#note(`cron: fire ${entry.fireId} of job ${entry.jobId} had no activity for ${this.#deps.settings.idleTimeoutS} s; cancelling its turn`);
      const actor = this.#deps.sessions.liveActor(entry.sessionId);
      if (actor !== undefined) void actor.cancel().catch(() => undefined);
    }
  }

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
      // Stopped under it, the channel going: left pending, so the next boot sends it again with the same uuids (§5.6).
      if (this.#stopped) {
        this.#note(`cron: stopped while posting fire ${fireId} of job ${job.jobId}; the next boot posts it again`);
        return;
      }
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
   * and this tick will skip it as too late, when it is the newest slot if this
   * tick fires it, else the slot after (§4.3).
   */
  #nextShown(job: JobRow): number | null {
    const next = job.nextRunAt;
    const now = this.#clock.now();
    if (next === null || next >= now) return next;
    const schedule = parseSchedule(job.schedule);
    if (!schedule.ok || now - next <= lateLimit(schedule.schedule, job.tz, next)) return next;
    // The newest slot, if it is fresh, is fired by this tick in its place (§4.3).
    const latest = latestSlot(schedule.schedule, job.tz, next, now);
    if (latest > next && now - latest <= lateLimit(schedule.schedule, job.tz, latest)) return latest;
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
    // Once per job per process: it stays due, and a tick comes every TICK_MS.
    if (!this.#unreadable.has(job.jobId)) {
      this.#unreadable.add(job.jobId);
      this.#note(`cron: job ${job.jobId}'s schedule cannot be read: ${parsed.message}`);
    }
    return undefined;
  }

  #dueJob(job: JobRow, now: number): void {
    const schedule = this.#schedule(job);
    const due = job.nextRunAt;
    if (schedule === undefined || due === null) return;
    const base = { jobId: job.jobId, trigger: 'schedule' as const, schedule: job.schedule, tz: job.tz };
    const after = isOneOff(schedule) ? {} : { next: runAfter(schedule, job.tz, due, now) };
    if (runningFire(this.#deps.db, job.jobId) !== undefined) {
      skipFire(this.#deps.db, { ...base, ...after, slot: due, scheduledAt: due, outcome: 'skipped_running' }, now);
      return;
    }
    let slot = due;
    if (now - due > lateLimit(schedule, job.tz, due)) {
      // Too late (§4.3): the slots missed are one skip, but the newest at or before now is fired if it is still fresh.
      const latest = latestSlot(schedule, job.tz, due, now);
      const fresh = latest > due && now - latest <= lateLimit(schedule, job.tz, latest);
      const n = missedSlots(schedule, job.tz, due, now) - (fresh ? 1 : 0);
      const said = `${n} slot${n === 1 ? '' : 's'} missed`;
      const skipped = skipFire(this.#deps.db, { ...base, ...(fresh ? { next: latest } : after), slot: due, scheduledAt: due, outcome: 'skipped_missed', error: said }, now);
      this.#note(`cron: job ${job.jobId} skipped its slot at ${new Date(due).toISOString()} as too late: ${said}`);
      if (!fresh || !skipped.ok) return;
      slot = latest;
    }
    const expected = { ...base, ...after, slot };
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
      abort: new AbortController(),
      env: {},
      args: [],
      done: left,
      leave: () => {
        if (!this.#entries.delete(fire.fireId)) return;
        if (entry.packageDir !== undefined) this.#packages.release(entry.packageDir);
        if (entry.token !== undefined) this.#deps.tokens?.drop(entry.token);
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
    if (this.#stopped) return;
    if (entry.mark !== undefined || entry.archiving) {
      // Marked or archived while its actor was made: the archive's release found none, so this one is closed here.
      void this.#deps.sessions.release(sessionId).catch(() => undefined);
      return;
    }
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
   * What comes before the session (§5.1, §5.2): the script, then the role's
   * role.md, read and rendered; the fire's prompt, or undefined when the fire
   * was ended, or left for the next boot, on the way.
   */
  async #prepare(entry: Entry, job: JobRow, fire: FireRow): Promise<string | undefined> {
    const role = this.#deps.roles.get(job.role);
    if (role === undefined) {
      this.#endNow(entry, { fireId: entry.fireId, outcome: 'skipped_unavailable', error: `role ${job.role} is not configured`, message: true });
      return undefined;
    }
    let script: string | undefined;
    if (job.script !== null) {
      const exit = await this.#script(entry, job, role);
      if (this.#stopped) return undefined;
      // Marked while it ran: a removal aborted it, which is no script failure (§5.1).
      if (entry.mark !== undefined) {
        this.#endNow(entry, { fireId: entry.fireId, outcome: entry.mark, error: this.#markError(entry.mark), message: false });
        return undefined;
      }
      if (exit.timedOut || exit.exitCode !== 0) {
        this.#endNow(entry, { fireId: entry.fireId, outcome: 'script_failed', error: scriptFailure(exit), message: true });
        return undefined;
      }
      script = scriptOutput(exit.output);
    }
    let bytes: Buffer | undefined;
    try {
      if (role.roleMdPath !== undefined) {
        if (!statSync(role.roleMdPath).isFile()) throw new Error('not a file');
        bytes = readFileSync(role.roleMdPath);
      }
      for (const skill of role.skills) accessSync(skill.path, constants.R_OK);
    } catch {
      // Not run without its instructions (§5.2), as a task's role is unresolvable without them.
      this.#endNow(entry, { fireId: entry.fireId, outcome: 'skipped_unavailable', error: `role ${role.name}'s role.md cannot be read`, message: true });
      return undefined;
    }
    const rendered = this.#render(entry, role, bytes);
    entry.token = this.#deps.tokens?.mintFire(entry.fireId, job.jobId);
    entry.env = {
      ...rendered?.env,
      ...this.#workerEnv(role),
      MT_CRON_FIRE: String(entry.fireId),
      ...(entry.token === undefined ? {} : { MT_CRON_TOKEN: entry.token }),
    };
    entry.args = rendered?.args ?? [];
    const previous = lastResult(this.#deps.db, job.jobId);
    return composeFirePrompt({
      role: rendered === undefined ? roleSections(bytes?.toString('utf8'), role.skills) : [],
      job,
      scheduledAt: fire.scheduledAt,
      ...(script === undefined ? {} : { script }),
      ...(previous === undefined ? {} : { previous: { result: previous.result ?? '', at: previous.scheduledAt } }),
    });
  }

  /** The job's script, as a gate runs (§5.1): in the workspace, with the role's environment and the gateway's mt and home, killed at its limit. */
  async #script(entry: Entry, job: JobRow, role: Role): Promise<GateExit> {
    const cwd = this.#deps.workspaceDirs.get(job.workspace);
    const runner = this.#deps.runner ?? spawnGate;
    if (cwd === undefined) return { exitCode: null, signal: null, timedOut: false, output: `workspace ${job.workspace} has no directory` };
    return runner(job.script ?? '', {
      cwd,
      env: scriptEnv(role, this.#deps.env ?? process.env, this.#deps.worker, this.#deps.scriptHome),
      timeoutMs: SCRIPT_TIMEOUT_MS,
      signal: entry.abort.signal,
    }).catch((err: unknown): GateExit => ({ exitCode: null, signal: null, timedOut: false, output: `the script could not run: ${message(err)}` }));
  }

  /**
   * The role as its agent's own package (§5.2), or undefined: no render root, no
   * renderer, opted out, or a render that failed, which is noted. Held in the
   * shared in-use set while the fire runs, and swept against it.
   */
  #render(entry: Entry, role: Role, bytes: Buffer | undefined): Rendered | undefined {
    const root = this.#deps.renderRoot;
    if (root === undefined) return undefined;
    const native = nativeFor(role);
    if (!native.ok) return undefined;
    let rendered: Rendered;
    try {
      rendered = renderNative(root, role, native.renderer, bytes);
    } catch (err) {
      this.#note(`cron: fire ${entry.fireId}: rendering role ${role.name} for ${native.renderer.id} failed, so its role.md and skills go in the prompt${stepsDropped(role)}: ${message(err)}`);
      return undefined;
    }
    entry.packageDir = rendered.dir;
    this.#packages.hold(rendered.dir);
    try {
      sweepRole(root, role.name, this.#packages.keeping(rendered.dir));
    } catch (err) {
      this.#note(`cron: sweeping the old packages of role ${role.name} failed: ${message(err)}`);
    }
    return rendered;
  }

  /** The socket, and a PATH that finds the gateway's mt first (§7.2), as a run's. */
  #workerEnv(role: Role): Record<string, string> {
    const worker = this.#deps.worker;
    if (worker === undefined) return {};
    return { MT_KANBAN_SOCKET: worker.socket, PATH: mtFirst(role, worker) };
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

/** The last `max` UTF-8 bytes of `text`, cut on a character. */
function tailBytes(text: string, max: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return text;
  return buf.subarray(buf.length - max).toString('utf8').replace(/^�+/, '');
}

/**
 * A script's output for the prompt (§5.1): its raw tail masked, then its last
 * SCRIPT_PROMPT_BYTES, a cut window starting with the marker; masked before it
 * is cut, so a cut cannot leave the end of a secret showing.
 */
export function scriptOutput(raw: string): string {
  const masked = redactKnownSecrets(raw);
  if (Buffer.byteLength(masked, 'utf8') <= SCRIPT_PROMPT_BYTES) return masked;
  return `${CUT_MARKER}${withholdSecretSuffix(tailBytes(masked, SCRIPT_PROMPT_BYTES - CUT_MARKER.length))}`;
}

/** A script's failure, as its line says it (§5.6): how it ended, and the last 300 characters of its output, masked. */
export function scriptFailure(exit: GateExit): string {
  const how = exit.timedOut
    ? `timed out after ${SCRIPT_TIMEOUT_MS / 1000} s`
    : exit.signal !== null
      ? `killed by ${exit.signal}`
      : exit.exitCode === null
        ? 'it could not start'
        : `exit ${exit.exitCode}`;
  const tail = Array.from(redactKnownSecrets(exit.output).trim()).slice(-300).join('');
  return `the script failed (${how})${tail === '' ? '' : `: ${tail}`}`;
}
