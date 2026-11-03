import type { SessionRegistry } from '../core/registry.js';
import type { Db } from '../db/open.js';
import { claimableTasks, getRun } from '../db/kanban-read.js';
import { getSession } from '../db/sessions.js';
import type { Role } from '../roles.js';
import { systemClock, type Clock } from '../time.js';
import type { BindingKey, Principal, TurnTerminal } from '../types.js';
import { briefFor } from './brief.js';
import { composePrompt } from './prompt.js';
import type { Claimed, KanbanService } from './service.js';
import { lastTurnOf } from './session-log.js';
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

  constructor(deps: DispatcherDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
    this.#note = deps.note ?? (() => undefined);
  }

  /**
   * A session's environment, for the registry to give its agent (spec §2.4 item
   * 3): an open run's `MT_KANBAN_RUN`, held in memory only. Plan C3 adds the
   * run's token, its socket and the `mt` binary's directory.
   */
  envFor(sessionId: string): Readonly<Record<string, string>> | undefined {
    return this.#open.get(sessionId)?.env;
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
    for (const task of claimableTasks(this.#deps.db, this.#clock.now())) {
      const claimed = this.#deps.service.claim(task.taskId);
      // Refusals are the board's to record: the claim notes a task nobody can be
      // given; a busy workspace or a racing claim leaves it for the next pass.
      if (!claimed.ok) continue;
      this.#track(this.#run(claimed));
    }
  }

  /** Wait until no run is being started or waited on. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  #track(work: Promise<void>): void {
    const tracked = work.catch((err: unknown) => this.#note(`kanban: ${message(err)}`));
    this.#inflight.add(tracked);
    void tracked.finally(() => this.#inflight.delete(tracked));
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
      this.#deps.service.endRun(run.runId, {
        outcome: 'failed',
        error: `the run could not start: ${message(err)}`,
        hadSideEffects: false,
      });
      this.#note(`kanban: run ${run.runId} could not start`);
      await this.#close(run.runId, key);
      return;
    }
    this.#open.set(sessionId, { runId: run.runId, key, env: { MT_KANBAN_RUN: run.runId } });

    let terminal: TurnTerminal;
    let thrown: string | undefined;
    try {
      const counted = this.#deps.service.countSubmission(run.runId);
      if (!counted.ok) throw new Error(counted.message);
      const prompt = composePrompt(briefFor(this.#deps.db, claimed));
      const actor = await this.#deps.sessions.actorFor(sessionId, key);
      // Its own key per prompt (spec §7.5): the actor deduplicates turns on it.
      terminal = await actor.submit({
        messageId: `kanban:${run.runId}:${counted.n}`,
        appId: this.#deps.appId,
        input: { text: prompt, paths: [] },
      });
    } catch (err) {
      terminal = 'failed';
      thrown = message(err);
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
    if (open === undefined) return;
    const run = getRun(this.#deps.db, open.runId);
    if (run !== undefined && run.outcome === null) {
      const turn = lastTurnOf(this.#deps.db, sessionId);
      const error = [...turn.errors, ...(thrown === undefined ? [] : [thrown])].join('\n');
      this.#deps.service.endRun(
        run.runId,
        terminal === 'completed'
          ? // No report, and the turn completed. Plan C3 nudges first.
            { outcome: 'protocol_violation', error: 'the run ended its turn without reporting', lastOutput: turn.output }
          : { outcome: 'failed', error: error === '' ? `the turn ended ${terminal}` : error, lastOutput: turn.output },
      );
    }
    await this.#close(open.runId, open.key, sessionId);
  }

  /**
   * Archive the run's session, then close the run, and look for the next claim:
   * its workspace is free. Archived first, so a process that dies between the two
   * leaves a decided run open, which the next boot closes (spec §8.4), rather
   * than a closed run whose session is still bound.
   */
  async #close(runId: string, key: BindingKey, sessionId?: string): Promise<void> {
    await this.#deps.sessions.archive(key, 'the run is over');
    const closed = this.#deps.service.closeRun(runId);
    if (closed.ok) this.#note(`kanban: run ${runId} closed, ${closed.run.outcome ?? 'undecided'}`);
    if (sessionId !== undefined) this.#open.delete(sessionId);
    this.pass();
  }
}
