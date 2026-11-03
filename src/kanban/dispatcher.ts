import type { SessionRegistry } from '../core/registry.js';
import type { Db } from '../db/open.js';
import { claimableTasks, getRun, getTask, openAgentRunCount, openRuns, runBySession } from '../db/kanban-read.js';
import { getSession } from '../db/sessions.js';
import type { Role } from '../roles.js';
import { systemClock, type Clock } from '../time.js';
import type { BindingKey, Principal, TurnTerminal } from '../types.js';
import { briefFor } from './brief.js';
import { classifyFailure } from './classify.js';
import { composePrompt } from './prompt.js';
import type { Claimed, KanbanService } from './service.js';
import { hadSideEffects, lastTurnOf, toolCallsOf } from './session-log.js';
import { KANBAN_CHANNEL } from './sink.js';
import type { RunRow } from './types.js';

/**
 * The dispatcher (spec §6): the one component that turns "a task became ready"
 * into "a session got a prompt", and a run's ended turn into a closed run.
 *
 * **One owner, in process.** There is exactly one: two would race to claim the
 * same task, and the one-open-run index would turn that race into errors instead
 * of two agents -- better, but still noise.
 *
 * **Supervision is the actor's** (spec §6.4). The dispatcher does not poll
 * processes or expire claims: the session actor owns the agent process and
 * resolves a submission with the turn's terminal, so a run's end is an event.
 *
 * **One agent run is one gateway session** (spec §3.3), created for the run,
 * bound on the `kanban` channel at (task id, run id), and archived when the run
 * closes: a retry or a rework is a new run in a new session.
 */

export interface DispatcherSettings {
  /** Open agent runs at once (spec §6.3). */
  maxRunning: number;
  /** A run's wall-clock limit unless its task sets one (spec §8.5). */
  defaultMaxRuntimeS: number;
  /** How long a task nobody can be given waits before it is reported stranded (spec §4.2). */
  strandedAfterS: number;
  /** How often the sweep runs (spec §6.1). */
  sweepIntervalS: number;
}

export interface DispatcherDeps {
  db: Db;
  service: KanbanService;
  sessions: SessionRegistry;
  /** The roles as loaded at startup: whose readOnlyTools a run's tool calls are read against. */
  roles: ReadonlyMap<string, Role>;
  appId: string;
  settings: DispatcherSettings;
  clock?: Clock;
  /** Metadata only: ids, outcomes, counts. Never task text or agent output. */
  note?: (line: string) => void;
}

/** Who a run's session belongs to: the board, not a person in a chat. */
export const KANBAN_OWNER: Principal = { openId: 'kanban', unionId: null, displayName: 'kanban' };

/** Where a run's session is bound (spec §7.1): the kanban channel, at the task and the run. */
export function runKey(appId: string, run: { taskId: string; runId: string }): BindingKey {
  return { channel: KANBAN_CHANNEL, appId, conversationId: run.taskId, threadId: run.runId };
}

/** An agent run this process started, by its session. */
interface OpenRun {
  runId: string;
  key: BindingKey;
  /** The run's environment, held only here (spec §2.4 item 3). */
  env: Readonly<Record<string, string>>;
  /** Its turn has been cancelled for running past its limit: once is enough. */
  cancelling: boolean;
  /** Its session has been released because its turn ignored the cancel. */
  released: boolean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Dispatcher {
  readonly #deps: DispatcherDeps;
  readonly #clock: Clock;
  readonly #note: (line: string) => void;
  /** Open agent runs this process started, by session id. */
  readonly #open = new Map<string, OpenRun>();
  /** Runs being started or waited on, so a test or a shutdown can wait for them. */
  readonly #inflight = new Set<Promise<void>>();
  /** What the last pass found nobody could be given, and why: the sweep's stranded candidates. */
  #unassignable = new Map<string, string>();
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(deps: DispatcherDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
    const note = deps.note ?? (() => undefined);
    // A note is told, never relied on: one that throws must not end a pass or
    // leave a run's promise rejected with nobody to catch it.
    this.#note = (line) => {
      try {
        note(line);
      } catch {
        // Nowhere left to say it.
      }
    };
  }

  /**
   * A session's environment, for the registry to give its agent (spec §2.4 item
   * 3): an open run's `MT_KANBAN_RUN`, held in memory only. Plan C3 adds the
   * run's token, its socket and the `mt` binary's directory.
   *
   * An open run's session this process did not start has lost its environment
   * with the process that did. It is not rebuilt: the run ends `interrupted`, and
   * the build is refused, rather than prompting an agent that could not report.
   */
  envFor(sessionId: string): Readonly<Record<string, string>> | undefined {
    const open = this.#open.get(sessionId);
    if (open !== undefined) return open.env;
    const run = runBySession(this.#deps.db, sessionId);
    if (run === undefined || run.endedAt !== null) return undefined;
    this.#track(this.#endLost(run, 'its environment did not survive a restart'));
    throw new Error(
      `run ${run.runId} is being ended interrupted: its environment did not survive a restart, so its agent could not report`,
    );
  }

  /**
   * After a restart (spec §8.4 steps 3 and 4), before the first pass: every open
   * agent run's process died with the gateway. An undecided run ends
   * `interrupted` -- not counted, since the task did nothing wrong, and claimable
   * again subject to retry_on_crash. A decided one keeps its outcome. Either way
   * it is closed, its session archived and its binding revoked: never resumed, as
   * a new run gets a new session. A person's run holds no process, and is left.
   *
   * Never rejects: a run that fails is noted and the rest go on, since the
   * gateway's start -- chat included -- waits on this.
   */
  async boot(): Promise<void> {
    let runs: RunRow[];
    try {
      runs = openRuns(this.#deps.db);
    } catch (err) {
      this.#note(`kanban: reading the open runs after a restart failed: ${message(err)}`);
      return;
    }
    for (const run of runs) {
      if (run.agentConfig === null) continue;
      await this.#endLost(run, 'the gateway restarted; the run is over');
    }
  }

  /**
   * A run whose process is gone: archive its session, then end and close the run.
   * In that order, as #close does, so a process that dies between the two leaves
   * an open run the next boot sees, not a closed one whose session is still
   * bound. An archive that fails does not keep the run open; neither step throws.
   */
  async #endLost(run: RunRow, reason: string): Promise<void> {
    try {
      await this.#deps.sessions.archive(runKey(this.#deps.appId, run), reason);
    } catch {
      // The error is not quoted: it can carry an agent's stderr.
      this.#note(`kanban: run ${run.runId}: archiving its session ${run.sessionId ?? 'none'} failed after a restart`);
    }
    try {
      this.#interrupt(run);
    } catch (err) {
      this.#note(`kanban: ending run ${run.runId} after a restart failed: ${message(err)}`);
    }
  }

  /** End an open run whose process is gone, keeping a reported outcome, and close it. */
  #interrupt(run: RunRow): void {
    if (run.outcome === null) {
      this.#end(run.runId, {
        outcome: 'interrupted',
        error: 'the gateway restarted during the run',
        // A run whose session never started cannot have changed anything.
        ...(run.sessionId === null
          ? { hadSideEffects: false }
          : { lastOutput: lastTurnOf(this.#deps.db, run.sessionId).output, ...this.#sideEffects(run, run.sessionId) }),
      });
    }
    const closed = this.#deps.service.closeRun(run.runId);
    if (closed.ok) this.#note(`kanban: run ${run.runId} closed after a restart`);
    else this.#note(`kanban: run ${run.runId} not closed after a restart: ${closed.code}`);
  }

  /**
   * End an undecided run (spec §8.2). A refusal is noted rather than dropped: the
   * run then stays undecided, so closeRun refuses it too, and it holds its
   * workspace until the next boot ends it.
   */
  #end(runId: string, ending: Parameters<KanbanService['endRun']>[1]): void {
    const ended = this.#deps.service.endRun(runId, ending);
    if (!ended.ok) this.#note(`kanban: run ${runId} not ended: ${ended.code}`);
  }

  /** An open run's actor is never retired to make room (spec §2.4 item 3). */
  pinned(sessionId: string): boolean {
    return this.#open.has(sessionId);
  }

  /**
   * One pass (spec §6.2): claim what can be claimed, in order, and start each run.
   * Synchronous up to each run's first prompt, so a pass sees the runs the one
   * before it opened. Runs go on in the background; `idle()` waits for them.
   */
  pass(): void {
    if (this.#stopped) return;
    let tasks: ReturnType<typeof claimableTasks>;
    try {
      tasks = claimableTasks(this.#deps.db, this.#clock.now());
    } catch (err) {
      this.#note(`kanban: reading the claimable tasks failed: ${message(err)}`);
      return;
    }
    const unassignable = new Map<string, string>();
    for (const task of tasks) {
      // One task's failure is that task's: the pass goes on to the next, and
      // never throws to the sweep, the boot or the run that called it.
      try {
        const who = task.phase === 'review' ? task.reviewer : task.assignee;
        // Counted from the board, so a run opened earlier in this pass counts. A
        // person's run holds no process, and is not limited (spec §6.3).
        if (who?.kind === 'role' && openAgentRunCount(this.#deps.db) >= this.#deps.settings.maxRunning) continue;
        const claimed = this.#deps.service.claim(task.taskId);
        // Refusals are the board's to record: the claim notes a task nobody can be
        // given; a busy workspace or a racing claim leaves it for the next pass.
        if (!claimed.ok) {
          if (claimed.code === 'unassignable') unassignable.set(task.taskId, claimed.message);
          continue;
        }
        this.#track(this.#run(claimed));
      } catch (err) {
        this.#note(`kanban: claiming ${task.taskId} failed: ${message(err)}`);
      }
    }
    this.#unassignable = unassignable;
  }

  /**
   * The sweep (spec §6.1), for what only time changes: runs past their runtime
   * limit, cooldowns that have ended -- the pass claims those -- and tasks that
   * have sat unclaimable long enough to be reported stranded.
   */
  sweep(): void {
    if (this.#stopped) return;
    this.#limitRuntimes();
    this.pass();
    this.#noteStranded();
  }

  /** Sweep every `sweepIntervalS`, starting now. */
  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setInterval(() => this.#sweepNoting(), this.#deps.settings.sweepIntervalS * 1000);
    this.#timer.unref();
    // Caught here too: the gateway calls start() after it has connected, and a
    // failed first sweep must not fail the start.
    this.#sweepNoting();
  }

  #sweepNoting(): void {
    try {
      this.sweep();
    } catch (err) {
      this.#note(`kanban: sweep failed: ${message(err)}`);
    }
  }

  /**
   * Stop: no more passes, and nothing more recorded. Open runs stay open; their
   * agents die with the gateway, and the next boot ends them (spec §8.4).
   */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Cancel the turn of a run past `max_runtime_s` (spec §8.5): wall-clock,
   * whatever it is doing, for the run that is busy and getting nowhere. An
   * undecided run ends `timed_out`, recorded before the turn is cancelled, so it
   * is the run's outcome and not the classifier's (spec §6.4). A decided run past
   * the limit keeps its outcome, and is closed once its turn ends.
   */
  #limitRuntimes(): void {
    const now = this.#clock.now();
    for (const [sessionId, open] of this.#open) {
      const run = getRun(this.#deps.db, open.runId);
      if (run === undefined || run.endedAt !== null) continue;
      if (open.cancelling) {
        // Cancelled a sweep ago and still open: its agent ignored the cancel, which
        // ACP leaves to the agent. Releasing the session ends the process; the run,
        // decided before the cancel, is closed, and its workspace freed.
        if (!open.released) {
          open.released = true;
          this.#note(`kanban: run ${run.runId} ignored its cancel; releasing its session`);
          this.#track(this.#release(sessionId, open));
        }
        continue;
      }
      const limitS = getTask(this.#deps.db, run.taskId)?.maxRuntimeS ?? this.#deps.settings.defaultMaxRuntimeS;
      if (now - run.startedAt < limitS * 1000) continue;
      if (run.outcome === null) {
        this.#end(run.runId, {
          outcome: 'timed_out',
          error: `the run passed its limit of ${limitS} s`,
          lastOutput: lastTurnOf(this.#deps.db, sessionId).output,
          ...this.#sideEffects(run, sessionId),
        });
      }
      // Only a running agent can be cancelled. One still starting is cancelled by
      // a later sweep, once it has a runtime.
      const actor = this.#deps.sessions.liveActor(sessionId);
      if (actor?.presence !== 'live') continue;
      open.cancelling = true;
      this.#note(`kanban: run ${run.runId} passed its runtime limit; cancelling its turn`);
      void actor.cancel();
    }
  }

  /** End a turn that ignored its cancel by releasing its session, and close its run. */
  async #release(sessionId: string, open: OpenRun): Promise<void> {
    await this.#deps.sessions.release(sessionId);
    await this.#close(open.runId, open.key, sessionId);
  }

  /** Tell, once, about each task the last pass found nobody to give to, if it has waited long enough (spec §4.2). */
  #noteStranded(): void {
    const cutoff = this.#clock.now() - this.#deps.settings.strandedAfterS * 1000;
    for (const [taskId, reason] of this.#unassignable) {
      const noted = this.#deps.service.noteStranded(taskId, reason, cutoff);
      if (noted.ok && noted.written) this.#note(`kanban: task ${taskId} is stranded`);
    }
  }

  /**
   * Wait until no run is being started or waited on, or at most `boundMs`. For
   * tests and shutdown: true once drained, false when the bound came first -- a
   * start that never returns is never drained (spec §6.4 leaves that to the actor).
   */
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
    const tracked = work.catch((err: unknown) => this.#note(`kanban: ${message(err)}`));
    this.#inflight.add(tracked);
    // Caught again: `finally` passes a rejection on, and nothing else awaits this chain.
    tracked.finally(() => this.#inflight.delete(tracked)).catch(() => undefined);
  }

  /**
   * Start an agent run (spec §7.1): a fresh session as the run's role, in the
   * task's workspace, bound at the run's key; then the task prompt, as the
   * session's first turn. Its end is handled when the turn ends (spec §7.4).
   */
  async #run(claimed: Claimed): Promise<void> {
    const { run } = claimed;
    // A person's run is sent a card, from plan D; it holds no session.
    if (run.assignee.kind !== 'role') return;
    const key = runKey(this.#deps.appId, run);
    let sessionId: string;
    try {
      if (run.workspace === null) throw new Error(`run ${run.runId} has no workspace`);
      const seed = this.#seed(run);
      sessionId = this.#deps.sessions.create(key, KANBAN_OWNER, {
        role: run.assignee.name,
        workspace: run.workspace,
        ...(seed === undefined ? {} : { seedProviderSessionId: seed }),
      }).id;
      const attached = this.#deps.service.attachSession(run.runId, sessionId);
      if (!attached.ok) throw new Error(attached.message);
    } catch (err) {
      // Nothing was started, so nothing was changed: an ordinary failure. A
      // session created before the failure is archived with the run.
      this.#end(run.runId, {
        outcome: 'failed',
        error: `the run could not start: ${message(err)}`,
        hadSideEffects: false,
      });
      this.#note(`kanban: run ${run.runId} could not start`);
      await this.#close(run.runId, key);
      return;
    }
    this.#open.set(sessionId, { runId: run.runId, key, env: { MT_KANBAN_RUN: run.runId }, cancelling: false, released: false });

    let terminal: TurnTerminal | 'decided';
    let thrown: string | undefined;
    try {
      const counted = this.#deps.service.countSubmission(run.runId);
      if (!counted.ok) throw new Error(counted.message);
      const prompt = composePrompt(briefFor(this.#deps.db, claimed));
      const actor = await this.#deps.sessions.actorFor(sessionId, key);
      // Stopped while the actor was built: start no agent the shutdown will not close.
      if (this.#stopped) return;
      // Decided while the actor was built -- a sweep found it past its limit --
      // so there is nothing for its agent to do: no prompt is sent.
      if (getRun(this.#deps.db, run.runId)?.outcome !== null) {
        terminal = 'decided';
      } else {
        // Its own key per prompt (spec §7.5): the actor deduplicates turns on it.
        terminal = await actor.submit({
          messageId: `kanban:${run.runId}:${counted.n}`,
          appId: this.#deps.appId,
          input: { text: prompt, paths: [] },
        });
      }
    } catch (err) {
      terminal = 'failed';
      thrown = message(err);
    }
    if (terminal === 'decided') {
      this.#note(`kanban: run ${run.runId} was decided while its agent was being built; no prompt was sent`);
      await this.#close(run.runId, key, sessionId);
      return;
    }
    await this.#turnEnded(sessionId, terminal, thrown);
  }

  /**
   * The provider session a rework resumes (spec §2.4 item 5, §5.3): the one the
   * claim chose to seed from. A hint, which the agent replaces with what it reports.
   */
  #seed(run: RunRow): string | undefined {
    if (run.seededFromRun === null) return undefined;
    const from = getRun(this.#deps.db, run.seededFromRun);
    if (from?.sessionId === null || from?.sessionId === undefined) return undefined;
    return getSession(this.#deps.db, from.sessionId)?.providerSessionId ?? undefined;
  }

  /**
   * The run's turn has ended (spec §7.4). A run already decided -- by its own
   * report, or by the dispatcher before it cancelled the turn -- keeps that
   * outcome: the board's truth is what the worker reported, not how its process
   * exited afterwards. An undecided one is ended here.
   */
  async #turnEnded(sessionId: string, terminal: TurnTerminal, thrown: string | undefined): Promise<void> {
    const open = this.#open.get(sessionId);
    // Stopped: the gateway is shutting down, and the next boot ends the run.
    if (open === undefined || this.#stopped) return;
    const run = getRun(this.#deps.db, open.runId);
    if (run !== undefined && run.outcome === null) {
      const turn = lastTurnOf(this.#deps.db, sessionId);
      // A refusal the actor rethrew is in the log already; one from before the turn is not.
      const errors = thrown === undefined || turn.errors.includes(thrown) ? turn.errors : [...turn.errors, thrown];
      const error = errors.join('\n');
      const ending =
        terminal === 'completed'
          ? // No report, and the turn completed. Plan C3 nudges first.
            { outcome: 'protocol_violation' as const, error: 'the run ended its turn without reporting' }
          : // Classified only here, for a turn nobody cancelled: a run the
            // dispatcher cancels is decided before it asks (spec §6.4).
            { outcome: classifyFailure(terminal, error), error: error === '' ? `the turn ended ${terminal}` : error };
      this.#end(run.runId, { ...ending, lastOutput: turn.output, ...this.#sideEffects(run, sessionId) });
    }
    await this.#close(open.runId, open.key, sessionId);
  }

  /**
   * Whether the run made a tool call outside its role's readOnlyTools (spec
   * §8.3), read from its session's log. Left out -- unknown, which the board
   * takes as yes -- when the role is no longer configured.
   */
  #sideEffects(run: RunRow, sessionId: string): { hadSideEffects?: boolean } {
    const role = this.#deps.roles.get(run.assignee.name);
    if (role === undefined) return {};
    return { hadSideEffects: hadSideEffects(toolCallsOf(this.#deps.db, sessionId), role.agent.readOnlyTools) };
  }

  /**
   * Archive the run's session, then close the run, and look for the next claim:
   * its workspace is free. Archived first, so a process that dies between the two
   * leaves a decided run open, which the next boot closes (spec §8.4), rather
   * than a closed run whose session is still bound. Stopped in between, the run is
   * left for that boot too: the database may be closing.
   *
   * An archive that fails -- the agent would not close, the workspace would not
   * release -- does not keep the run open: its outcome is decided, and an open run
   * would hold its workspace, a max_running slot and its pin until a restart. It
   * is noted by id, its session released if it is still live, and the run closed.
   */
  async #close(runId: string, key: BindingKey, sessionId?: string): Promise<void> {
    try {
      await this.#deps.sessions.archive(key, 'the run is over');
    } catch {
      // The error is not quoted: it can carry an agent's stderr.
      this.#note(`kanban: run ${runId}: archiving its session ${sessionId ?? 'none'} failed; closing the run anyway`);
      if (sessionId !== undefined) await this.#deps.sessions.release(sessionId).catch(() => undefined);
    }
    if (this.#stopped) return;
    const closed = this.#deps.service.closeRun(runId);
    if (closed.ok) this.#note(`kanban: run ${runId} closed, ${closed.run.outcome ?? 'undecided'}`);
    else if (closed.code === 'undecided') {
      this.#note(`kanban: run ${runId} not closed: undecided; it stays open until the gateway restarts`);
    } else this.#note(`kanban: run ${runId} not closed: ${closed.code}`);
    if (sessionId !== undefined) this.#open.delete(sessionId);
    this.pass();
  }
}
