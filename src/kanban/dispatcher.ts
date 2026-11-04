import { delimiter } from 'node:path';
import type { SessionRegistry } from '../core/registry.js';
import type { SessionActor } from '../core/session-actor.js';
import { bindingsOnChannel } from '../db/bindings.js';
import type { Db } from '../db/open.js';
import { claimableTasks, commentsOf, getRun, getTask, openAgentRunCount, openRuns, runBySession } from '../db/kanban-read.js';
import { getSession } from '../db/sessions.js';
import { nativeFor, renderNative, sweepRole, sweepRoles, type Rendered } from '../render/native.js';
import type { Role } from '../roles.js';
import { addSecrets, removeSecrets } from '../secrets.js';
import { systemClock, type Clock } from '../time.js';
import type { BindingKey, Principal, TurnTerminal } from '../types.js';
import { briefFor } from './brief.js';
import { classifyFailure } from './classify.js';
import { composeForwarded, composeNudge, composePrompt } from './prompt.js';
import type { Claimed, KanbanService } from './service.js';
import { hadSideEffects, lastTurnOf, toolCallsOf } from './session-log.js';
import { KANBAN_CHANNEL } from './sink.js';
import { hashToken, mintToken } from './token.js';
import type { CommentRow, RunKind, RunRow } from './types.js';

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
 *
 * **A role with a renderer runs natively** (plan R). Just after the claim, from
 * the role.md bytes the claim read, the role is rendered as its agent's own
 * package under `renderRoot`; the run is given the package through its
 * environment and arguments, and its prompt leaves role.md and the skills out.
 * A render that fails is noted and the run goes on with them in its prompt
 * instead (spec §7.1): the role's files were readable at the claim, so the run
 * can still be told everything, and failing it would count a disk problem
 * against the task.
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
  /** Reminders a run whose turn ended without a report is sent, before it is a protocol violation (spec §7.5). */
  nudgeLimit: number;
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
  /**
   * Where roles are rendered as native agent packages: `$MT_HOME/rendered`
   * (plan R). Absent, nothing is, and every run's role.md and skills go in its
   * prompt.
   */
  renderRoot?: string;
  /**
   * How a run reaches the worker API (spec §7.2): the socket it is given as
   * `MT_KANBAN_SOCKET`, and the directory of the `mt` shim, put first on its
   * PATH ahead of `path`, the PATH it would otherwise get. Absent, a run gets
   * neither, and its agent cannot report: tests that report through the service.
   */
  worker?: WorkerAccess;
}

export interface WorkerAccess {
  socket: string;
  mtDir: string;
  /** The gateway's own PATH, which an agent is otherwise given; a role's agent.env may replace it. */
  path: string | undefined;
}

/** Who a run's session belongs to: the board, not a person in a chat. */
export const KANBAN_OWNER: Principal = { openId: 'kanban', unionId: null, displayName: 'kanban' };

/** Where a run's session is bound (spec §7.1): the kanban channel, at the task and the run. */
export function runKey(appId: string, run: { taskId: string; runId: string }): BindingKey {
  return { channel: KANBAN_CHANNEL, appId, conversationId: run.taskId, threadId: run.runId };
}

/** A run this process is starting or has started, as its closing sees it. */
interface RunHandle {
  runId: string;
  key: BindingKey;
  /** Its session, once one was created. */
  sessionId?: string;
  /** Set by the first close, whoever asks: a run is closed at most once, and a later ask waits for that one. */
  closing: Promise<void> | undefined;
}

/** An agent run this process started, by its session. */
interface OpenRun extends RunHandle {
  sessionId: string;
  /** The run's environment, held only here (spec §2.4 item 3). */
  env: Readonly<Record<string, string>>;
  /** Its agent's own arguments: `--agent <role>` for a native run (plan R), else none. */
  args: readonly string[];
  /** The native package it runs, kept from the sweep while the run is open. */
  packageDir: string | undefined;
  /** Its turn has been cancelled for running past its limit: once is enough. */
  cancelling: boolean;
  /** Its session has been released because its turn ignored the cancel. */
  released: boolean;
  /** Its kind: which reports a nudge names. */
  kind: RunKind;
  /** Nudges sent so far (spec §7.5). */
  nudges: number;
  /** The newest comment its agent has been given, in its prompt or forwarded: later ones are forwarded. */
  seenComment: number;
  /**
   * For a turn `cancel()` asked to stop: not released before this time, a sweep
   * interval on, the grace a timed-out turn gets between two sweeps.
   */
  releaseAfter?: number;
}

/** The newest comment's id, or 0 for none. */
function newest(comments: readonly CommentRow[]): number {
  return comments.reduce((max, c) => Math.max(max, c.id), 0);
}

/** A protocol violation's error: how many times the run was asked. */
function unreported(nudges: number): string {
  const base = 'the run ended its turn without reporting';
  return nudges === 0 ? base : `${base}, and again after ${nudges} reminder${nudges === 1 ? '' : 's'}`;
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
   * 3): an open run's `MT_KANBAN_RUN` and `MT_KANBAN_TOKEN` (spec §7.2), held in
   * memory only.
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
   * Then any session still bound on the kanban channel at a closed run, or at
   * none, is archived: an archive that failed before is retried here.
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
    await this.#archiveLeftovers();
    this.#sweepRenders();
  }

  /**
   * After a restart nothing is open, so no package is in use: those of roles no
   * longer configured, and any half-written one, are removed (plan R).
   */
  #sweepRenders(): void {
    const root = this.#deps.renderRoot;
    if (root === undefined) return;
    try {
      sweepRoles(root, new Set(this.#deps.roles.keys()));
    } catch (err) {
      this.#note(`kanban: sweeping the rendered packages after a restart failed: ${message(err)}`);
    }
  }

  /**
   * A session still bound on the kanban channel at a run that is closed, or at
   * none: its archive failed when the run closed, or the process died in
   * between. Archived now, which a failed archive is never retried otherwise.
   * Read from the board and the bindings; the registry revokes them.
   */
  async #archiveLeftovers(): Promise<void> {
    let bound: ReturnType<typeof bindingsOnChannel>;
    try {
      bound = bindingsOnChannel(this.#deps.db, KANBAN_CHANNEL, this.#deps.appId);
    } catch (err) {
      this.#note(`kanban: reading the kanban bindings after a restart failed: ${message(err)}`);
      return;
    }
    for (const b of bound) {
      const run = getRun(this.#deps.db, b.threadId);
      if (run !== undefined && run.endedAt === null) continue;
      try {
        await this.#deps.sessions.archive(
          { channel: b.channel, appId: b.appId, conversationId: b.conversationId, threadId: b.threadId },
          run === undefined ? 'the session is bound at no run' : 'the run is over',
        );
        const why = run === undefined ? 'bound at no run' : `run ${run.runId} is closed`;
        this.#note(`kanban: session ${b.sessionId} archived after a restart: ${why}`);
      } catch {
        // The error is not quoted: it can carry an agent's stderr.
        this.#note(`kanban: archiving session ${b.sessionId} failed after a restart`);
      }
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

  /**
   * A session's own arguments, for the registry to give its agent: an open
   * native run's `--agent <role>` (plan R). Asked after `envFor`, which has
   * already refused a run this process did not start.
   */
  argsFor(sessionId: string): readonly string[] | undefined {
    const args = this.#open.get(sessionId)?.args;
    return args === undefined || args.length === 0 ? undefined : args;
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
        // An agent run gets a token (spec §7.2); a person's run reports through chat.
        const token = who?.kind === 'role' ? mintToken() : undefined;
        const claimed = this.#claim(task.taskId, token);
        // Refusals are the board's to record: the claim notes a task nobody can be
        // given; a busy workspace or a racing claim leaves it for the next pass.
        if (!claimed.ok) {
          if (claimed.code === 'unassignable') unassignable.set(task.taskId, claimed.message);
          continue;
        }
        this.#track(this.#run(claimed, token));
      } catch (err) {
        this.#note(`kanban: claiming ${task.taskId} failed: ${message(err)}`);
      }
    }
    this.#unassignable = unassignable;
  }

  /**
   * Claim with the run's token, which joins the masker first (spec §10.1): from
   * the moment the run exists, anything that prints the token -- its agent, an
   * error, a note -- is masked. Only its hash reaches the board. A claim that is
   * refused, or throws, takes the token back out.
   */
  #claim(taskId: string, token: string | undefined): ReturnType<KanbanService['claim']> {
    if (token === undefined) return this.#deps.service.claim(taskId);
    addSecrets([token]);
    let claimed: ReturnType<KanbanService['claim']> | undefined;
    try {
      claimed = this.#deps.service.claim(taskId, { tokenHash: hashToken(token) });
      return claimed;
    } finally {
      if (claimed?.ok !== true) removeSecrets([token]);
    }
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
        if (!open.released && (open.releaseAfter === undefined || now >= open.releaseAfter)) {
          open.released = true;
          this.#note(`kanban: run ${run.runId} ignored its cancel; releasing its session`);
          this.#track(this.#close(open, { releaseFirst: true }));
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

  /**
   * Cancel the turn of a run the board decided without it: a reassignment or an
   * archive superseded it, or a person stopped it (spec §5.1). Its workspace and
   * its max_running slot come back now, not whenever its agent stops. Plan D
   * calls it after the service's assign, assignReviewer, stop and archive.
   *
   * The outcome is the board's already, so the turn's end only closes the run.
   * An undecided run is not cancelled here: what ended it must be recorded first
   * (spec §6.4). A turn that ignores the cancel has its session released by the
   * first sweep once `sweep_interval_s` has passed since the cancel, the grace a
   * timed-out turn gets. The run is marked cancelling even when there is no live
   * turn to stop yet -- false is returned then -- so a run still starting gets no
   * prompt, and is released the same way if its start never ends. True when a
   * running turn was asked to stop.
   */
  cancel(runId: string): boolean {
    const open = [...this.#open.values()].find((o) => o.runId === runId);
    if (open === undefined || open.cancelling) return false;
    const outcome = getRun(this.#deps.db, runId)?.outcome;
    if (outcome === null || outcome === undefined) return false;
    open.cancelling = true;
    open.releaseAfter = this.#clock.now() + this.#deps.settings.sweepIntervalS * 1000;
    const actor = this.#deps.sessions.liveActor(open.sessionId);
    if (actor?.presence !== 'live') return false;
    this.#note(`kanban: run ${runId} was decided ${outcome} by the board; cancelling its turn`);
    void actor.cancel();
    return true;
  }

  /** Tell, once, about each task the last pass found nobody to give to
```, if it has waited long enough (spec §4.2). */
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
  async #run(claimed: Claimed, token: string | undefined): Promise<void> {
    const { run } = claimed;
    const handle: RunHandle = { runId: run.runId, key: runKey(this.#deps.appId, run), closing: undefined };
    try {
      // A person's run is sent a card, from plan D; it holds no session.
      if (run.assignee.kind === 'role' && token !== undefined) await this.#drive(claimed, handle, token);
    } finally {
      // The run's one cleanup, once its close -- by whoever asked for it -- is
      // over: everything that must happen exactly once per run goes here. The
      // token leaves the masker last: its run is closed, and its agent gone.
      await handle.closing?.catch(() => undefined);
      if (handle.sessionId !== undefined) this.#open.delete(handle.sessionId);
      if (token !== undefined) removeSecrets([token]);
    }
  }

  /** The body of `#run`: start the session, send the prompt, and handle the turn's end. */
  async #drive(claimed: Claimed, handle: RunHandle, token: string): Promise<void> {
    const { run } = claimed;
    const key = handle.key;
    // Before the session, and synchronously up to the run's entry in #open, so
    // the sweep of another run's render sees this one's package as in use.
    const rendered = this.#render(claimed);
    // On the run, once decided: C4 and E will seed only from a run with the
    // same native-ness and package hash. A refusal is noted, and the run goes on.
    const recorded = this.#deps.service.recordRendering(
      run.runId,
      rendered === undefined ? { native: false } : { native: true, packageHash: rendered.hash },
    );
    if (!recorded.ok) this.#note(`kanban: run ${run.runId}: recording how its role was given failed: ${recorded.code}`);
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
      await this.#close(handle);
      return;
    }
    handle.sessionId = sessionId;
    const open: OpenRun = Object.assign(handle, {
      sessionId,
      env: { ...rendered?.env, ...this.#workerEnv(claimed.role), MT_KANBAN_RUN: run.runId, MT_KANBAN_TOKEN: token },
      args: rendered?.args ?? [],
      packageDir: rendered?.dir,
      cancelling: false,
      released: false,
      kind: run.kind,
      nudges: 0,
      seenComment: 0,
    });
    this.#open.set(sessionId, open);

    let terminal: TurnTerminal | 'decided';
    let thrown: string | undefined;
    try {
      const brief = briefFor(this.#deps.db, claimed, { native: rendered !== undefined });
      open.seenComment = newest(brief.comments);
      const prompt = composePrompt(brief);
      const actor = await this.#deps.sessions.actorFor(sessionId, key);
      // Stopped while the actor was built: start no agent the shutdown will not close.
      if (this.#stopped) return;
      terminal = await this.#submit(open, actor, prompt);
      // No report, and the turn completed: a person's comment, else a nudge, in
      // the same session, until the run reports or the nudges run out (spec §7.5).
      while (terminal === 'completed') {
        const next = this.#followUp(open);
        if (next === undefined) break;
        terminal = await this.#submit(open, actor, next);
      }
    } catch (err) {
      terminal = 'failed';
      thrown = message(err);
    }
    if (terminal === 'decided') {
      this.#note(`kanban: run ${run.runId} was decided while its agent was being built; no prompt was sent`);
      await this.#close(open);
      return;
    }
    await this.#turnEnded(sessionId, terminal, thrown);
  }

  /**
   * Submit one prompt into the run's session, unless the run was decided
   * meanwhile -- a sweep found it past its limit, a person stopped it -- when
   * there is nothing for its agent to do, and none is sent. Each prompt is
   * counted, and keyed by the count before it (spec §7.5): the actor
   * deduplicates turns on the key, so each needs its own.
   */
  async #submit(open: OpenRun, actor: SessionActor, text: string): Promise<TurnTerminal | 'decided'> {
    if (getRun(this.#deps.db, open.runId)?.outcome !== null) return 'decided';
    const counted = this.#deps.service.countSubmission(open.runId);
    if (!counted.ok) throw new Error(counted.message);
    return actor.submit({
      messageId: `kanban:${open.runId}:${counted.n}`,
      appId: this.#deps.appId,
      input: { text, paths: [] },
    });
  }

  /**
   * What to send a run whose turn completed without a report (spec §7.5), or
   * undefined to end it: people's comments since its last prompt, which do not
   * use up a nudge; else the next nudge, while any are left. Nothing for a run
   * that is decided -- by its own report, or a sweep -- or released, or once the
   * dispatcher has stopped. The comments of runs, its own included, are not
   * forwarded: a person's word is what beats a reminder.
   */
  #followUp(open: OpenRun): string | undefined {
    if (this.#stopped || open.released || open.cancelling) return undefined;
    const run = getRun(this.#deps.db, open.runId);
    if (run === undefined || run.outcome !== null) return undefined;
    const fresh = commentsOf(this.#deps.db, run.taskId).filter(
      (c) => c.id > open.seenComment && !c.author.startsWith('run:'),
    );
    if (fresh.length > 0) {
      open.seenComment = newest(fresh);
      this.#note(`kanban: run ${run.runId} ended its turn without reporting; forwarding ${fresh.length} comment(s)`);
      return composeForwarded(open.kind, fresh);
    }
    const limit = this.#deps.settings.nudgeLimit;
    if (open.nudges >= limit) return undefined;
    open.nudges += 1;
    this.#note(`kanban: run ${run.runId} ended its turn without reporting; nudge ${open.nudges} of ${limit}`);
    return composeNudge(open.kind, open.nudges, limit);
  }

  /**
   * The socket, and a PATH that finds the gateway's `mt` first (spec §7.2): the
   * shim's directory, then the PATH the agent would have had -- its role's own,
   * if its agent.env sets one, else the gateway's.
   */
  #workerEnv(role: Role | undefined): Record<string, string> {
    const worker = this.#deps.worker;
    if (worker === undefined) return {};
    const rest = role?.agent.env['PATH'] ?? worker.path;
    return {
      MT_KANBAN_SOCKET: worker.socket,
      PATH: rest === undefined || rest === '' ? worker.mtDir : `${worker.mtDir}${delimiter}${rest}`,
    };
  }

  /**
   * Render the run's role as its agent's native package (plan R), or undefined
   * when it is not rendered: no render root, a person's run, a role with no
   * renderer or one that opted out -- or a render that failed, which is noted.
   * Then the role's packages that neither this run nor an open one uses are
   * removed, so a role keeps its newest package and those still running.
   */
  #render(claimed: Claimed): Rendered | undefined {
    const root = this.#deps.renderRoot;
    const role = claimed.role;
    if (root === undefined || role === undefined) return undefined;
    const native = nativeFor(role);
    if (!native.ok) return undefined;
    const runId = claimed.run.runId;
    let rendered: Rendered;
    try {
      rendered = renderNative(root, role, native.renderer, claimed.roleMdBytes);
    } catch (err) {
      this.#note(
        `kanban: run ${runId}: rendering role ${role.name} for ${native.renderer.id} failed, ` +
          `so its role.md and skills go in the prompt: ${message(err)}`,
      );
      return undefined;
    }
    const inUse = new Set([rendered.dir]);
    for (const open of this.#open.values()) if (open.packageDir !== undefined) inUse.add(open.packageDir);
    try {
      sweepRole(root, role.name, inUse);
    } catch (err) {
      this.#note(`kanban: sweeping the old packages of role ${role.name} failed: ${message(err)}`);
    }
    this.#note(`kanban: run ${runId} runs role ${role.name} as a native ${native.renderer.id} agent`);
    return rendered;
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
    // Released because it ignored its cancel: that release ended this turn, the
    // run was decided before it, and the release closes it.
    if (open.released) return;
    const run = getRun(this.#deps.db, open.runId);
    if (run !== undefined && run.outcome === null) {
      const turn = lastTurnOf(this.#deps.db, sessionId);
      // A refusal the actor rethrew is in the log already; one from before the turn is not.
      const errors = thrown === undefined || turn.errors.includes(thrown) ? turn.errors : [...turn.errors, thrown];
      const error = errors.join('\n');
      const ending =
        terminal === 'completed'
          ? // No report, and the turn completed, after any nudges (spec §7.5).
            { outcome: 'protocol_violation' as const, error: unreported(open.nudges) }
          : // Classified only here, for a turn nobody cancelled: a run the
            // dispatcher cancels is decided before it asks (spec §6.4).
            { outcome: classifyFailure(terminal, error), error: error === '' ? `the turn ended ${terminal}` : error };
      this.#end(run.runId, { ...ending, lastOutput: turn.output, ...this.#sideEffects(run, sessionId) });
    }
    await this.#close(open);
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
   *
   * At most once per run, whoever asks -- the turn's end, a release, a failed
   * start: a later ask gets the first one's promise. `releaseFirst` is for a turn
   * that ignored its cancel, whose session is released to end its process.
   */
  #close(run: RunHandle, opts: { releaseFirst?: boolean } = {}): Promise<void> {
    if (run.closing !== undefined) return run.closing;
    run.closing = this.#closeOnce(run, opts.releaseFirst === true);
    return run.closing;
  }

  async #closeOnce(handle: RunHandle, releaseFirst: boolean): Promise<void> {
    const { runId, key, sessionId } = handle;
    if (releaseFirst && sessionId !== undefined) {
      // Not quoted, as below; the archive releases it again, and closes the run either way.
      await this.#deps.sessions.release(sessionId).catch(() => {
        this.#note(`kanban: run ${runId}: releasing its session ${sessionId} failed`);
      });
    }
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
    this.pass();
  }
}
