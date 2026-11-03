import type { Db } from './open.js';
import { txImmediate } from './open.js';
import { newRunId, newTaskId } from '../core/ids.js';
import { redactKnownSecrets, redactValues } from '../secrets.js';
import { resolveTaskWorkspace } from '../kanban/workspace.js';
import type {
  AgentSnapshot,
  Assignee,
  CommentRow,
  Contract,
  CreatedVia,
  Refusal,
  RefusalCode,
  Result,
  RetryOnCrash,
  RunKind,
  RunRow,
  TaskRow,
} from '../kanban/types.js';
import {
  getRun,
  getTask,
  getTaskByKey,
  isFinished,
  openAgentRunIn,
  openRunOf,
  parentsOf,
  runsOf,
} from './kanban-read.js';

/**
 * The board's only writer (spec §4.1, WRITERS.md).
 *
 * `phase` is written only here, through named transitions, each of which reads
 * the task inside its transaction, checks the current phase and refuses an
 * illegal move. Every change writes one `kanban_events` row in the same
 * transaction.
 *
 * What this module checks is what the rows make true or false: phases, parents,
 * open runs, cycles. Whether a name is configured, or who may act, is the
 * service's (kanban/service.ts), which knows the team.
 *
 * Free text -- titles, bodies, the contract, summaries, metadata, reasons,
 * comments, errors, output -- and every event payload's string values are masked
 * before they are stored (spec §10.1 layer 3). Best effort: a secret split
 * across two writes matches neither; the escapers are the authoritative layer.
 * Ids, names and idempotency keys are not masked: they identify.
 */

export function refuse(code: RefusalCode, message: string): Refusal {
  return { ok: false, code, message };
}

/** Thrown inside a transaction to roll it back, and returned as the refusal it carries. */
class Rollback extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
  }
}

/**
 * txImmediate, for a change that may be refused: a refusal rolls back whatever
 * the change had written, so a refused change never leaves half of itself.
 */
function tx<T extends object>(db: Db, fn: (d: Db) => Result<T>): Result<T> {
  try {
    return txImmediate(db, (d) => {
      const r = fn(d);
      if (!r.ok) throw new Rollback(r);
      return r;
    });
  } catch (err) {
    if (err instanceof Rollback) return err.refusal;
    throw err;
  }
}

/**
 * Keys in the board's payloads that identify rather than say something: its ids,
 * and the names of who and where. Passed to redactValues for these payloads only:
 * session events and approvals carry agent-controlled keys, which must not be
 * exempted the same way.
 */
const BOARD_KEYS: ReadonlySet<string> = new Set([
  'taskId',
  'runId',
  'parentId',
  'childId',
  'createdFromTask',
  'seededFromRun',
  'assignee',
  'reviewer',
  'workspace',
]);

/** One row of the board's log, masked value by value. */
function record(
  d: Db,
  e: { taskId: string; runId?: string | null; kind: string; actor: string; payload: Record<string, unknown> },
  now: number,
): void {
  d.prepare(
    `INSERT INTO kanban_events (task_id, run_id, kind, actor, payload, created_at)
     VALUES (?, ?, ?, ?, jsonb(?), ?)`,
  ).run(e.taskId, e.runId ?? null, e.kind, e.actor, JSON.stringify(redactValues(e.payload, BOARD_KEYS)), now);
}

const mask = redactKnownSecrets;

function mustGet(d: Db, taskId: string): TaskRow {
  const task = getTask(d, taskId);
  if (task === undefined) throw new Error(`task ${taskId} vanished inside its own transaction`);
  return task;
}

// ---------------------------------------------------------------------------
// Creating tasks, and comments
// ---------------------------------------------------------------------------

export interface NewTask {
  title: string;
  body?: string;
  contract?: Contract;
  assignee?: Assignee | null;
  reviewer?: Assignee | null;
  workspace?: string | null;
  parents?: readonly string[];
  priority?: number;
  idempotencyKey?: string | null;
  failureLimit?: number | null;
  retryOnCrash?: RetryOnCrash;
  maxRuntimeS?: number | null;
  createdBy: string;
  createdVia: CreatedVia;
}

/**
 * Create a task, linked to its parents, in one transaction.
 *
 * A repeated idempotency key returns the existing task and changes nothing:
 * creation is retried by everything that can create -- Lark redelivers a
 * message, an agent re-runs a command whose output it did not see (spec §3.1).
 *
 * A task created by a run records that run's task as `created_from_task`, the
 * stand-in for parents when its workspace is resolved (spec §2.3). It is not a
 * link: the new task is not gated on its creator.
 */
export function createTask(db: Db, t: NewTask, now: number): Result<{ task: TaskRow; existing: boolean }> {
  return tx(db, (d) => {
    if (t.idempotencyKey !== undefined && t.idempotencyKey !== null) {
      const existing = getTaskByKey(d, t.idempotencyKey);
      if (existing !== undefined) return { ok: true, task: existing, existing: true };
    }
    const parents = [...new Set(t.parents ?? [])];
    for (const parent of parents) {
      if (getTask(d, parent) === undefined) return refuse('not_found', `no task ${parent} to be a parent`);
    }
    let createdFromTask: string | null = null;
    if (t.createdVia.kind === 'run') {
      const run = getRun(d, t.createdVia.runId);
      if (run === undefined) return refuse('not_found', `no run ${t.createdVia.runId}`);
      createdFromTask = run.taskId;
    }

    const taskId = newTaskId();
    d.prepare(
      `INSERT INTO kanban_tasks
         (task_id, title, body, contract, assignee_kind, assignee, reviewer_kind, reviewer,
          workspace, phase, priority, idempotency_key, failure_limit, retry_on_crash,
          max_runtime_s, created_by, created_via, created_at, created_from_task)
       VALUES (?, ?, ?, jsonb(?), ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, jsonb(?), ?, ?)`,
    ).run(
      taskId,
      mask(t.title),
      mask(t.body ?? ''),
      JSON.stringify(redactValues(t.contract ?? {})),
      t.assignee?.kind ?? null,
      t.assignee?.name ?? null,
      t.reviewer?.kind ?? null,
      t.reviewer?.name ?? null,
      t.workspace ?? null,
      t.priority ?? 0,
      t.idempotencyKey ?? null,
      t.failureLimit ?? null,
      t.retryOnCrash ?? 'always',
      t.maxRuntimeS ?? null,
      t.createdBy,
      JSON.stringify(t.createdVia),
      now,
      createdFromTask,
    );
    const link = d.prepare('INSERT INTO kanban_links (parent_id, child_id, created_at) VALUES (?, ?, ?)');
    for (const parent of parents) link.run(parent, taskId, now);
    record(
      d,
      {
        taskId,
        kind: 'created',
        actor: t.createdBy,
        payload: {
          title: t.title,
          assignee: t.assignee?.name ?? null,
          reviewer: t.reviewer?.name ?? null,
          workspace: t.workspace ?? null,
          parents,
          createdFromTask,
        },
      },
      now,
    );
    return { ok: true, task: mustGet(d, taskId), existing: false };
  });
}

/** A comment, on a task in any phase. Forwarding one to a run is plan C3's. */
export function addComment(
  db: Db,
  taskId: string,
  author: string,
  body: string,
  now: number,
): Result<{ comment: CommentRow }> {
  return tx(db, (d) => {
    if (getTask(d, taskId) === undefined) return refuse('not_found', `no task ${taskId}`);
    return { ok: true, comment: insertComment(d, taskId, author, body, now) };
  });
}

function insertComment(d: Db, taskId: string, author: string, body: string, now: number): CommentRow {
  const masked = mask(body);
  const { lastInsertRowid } = d
    .prepare('INSERT INTO kanban_comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)')
    .run(taskId, author, masked, now);
  record(d, { taskId, kind: 'commented', actor: author, payload: { body } }, now);
  return { id: Number(lastInsertRowid), taskId, author, body: masked, createdAt: now };
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/** Who a claim is for, as the service resolved it from the team. */
export interface Claimant {
  /** The task's assignee for a work run, its reviewer for a review run. */
  assignee: Assignee;
  /** The role's effective agent; null for a person. */
  agentConfig: AgentSnapshot | null;
  /** The role's workspace, if it names one explicitly (spec §2.3 rule 2). */
  roleWorkspace: string | undefined;
  /** SHA-256 of the role.md the run is given (spec §2.1); null without one. */
  roleMdHash: string | null;
}

export interface ClaimInput {
  taskId: string;
  claimant: Claimant;
  /** SHA-256 of the run's worker token (plan C3); the token is never stored. */
  tokenHash?: string | null;
  /** The configured workspace names: an agent run in any other is unassignable. */
  workspaces: ReadonlySet<string>;
}

/**
 * Open a run on a task (spec §5.1, §6.2 step 3): a work run on a ready task, a
 * review run on a task in review with no open run.
 *
 * In one transaction, so that what the claim was decided on is still true when
 * the run is inserted: the phase, the parents, no open run (also enforced by the
 * partial unique index, so two racing claims fail at the database), the
 * assignee, the cooldown, and the workspace.
 *
 * A null workspace is resolved here (spec §2.3) and fixed on the task. Where it
 * cannot be -- the parents disagree -- an agent claim is refused as unassignable
 * before anything is written, and a person's run is opened with the workspace
 * still null. An agent run is also refused in a workspace no longer configured,
 * and in one that already has an open agent run (spec §6.3). A person's run
 * holds no workspace.
 */
export function claim(db: Db, input: ClaimInput, now: number): Result<{ run: RunRow; task: TaskRow }> {
  return tx(db, (d) => {
    const task = getTask(d, input.taskId);
    if (task === undefined) return refuse('not_found', `no task ${input.taskId}`);
    if (task.phase !== 'open' && task.phase !== 'review') {
      return refuse('illegal_transition', `task ${task.taskId} is ${task.phase}, so it cannot be claimed`);
    }
    const kind: RunKind = task.phase === 'open' ? 'work' : 'review';
    const open = openRunOf(d, task.taskId);
    if (open !== undefined) return refuse('run_open', `task ${task.taskId} already has an open run, ${open.runId}`);

    const who = kind === 'work' ? task.assignee : task.reviewer;
    if (who === null) {
      return refuse('unassignable', `task ${task.taskId} has no ${kind === 'work' ? 'assignee' : 'reviewer'}`);
    }
    if (who.kind !== input.claimant.assignee.kind || who.name !== input.claimant.assignee.name) {
      return refuse('stale', `task ${task.taskId} is now for ${who.name}, not ${input.claimant.assignee.name}`);
    }
    const agent = who.kind === 'role';
    if (agent !== (input.claimant.agentConfig !== null)) {
      throw new Error('a claim carries an agent exactly when it is for a role');
    }
    const parents = parentsOf(d, task.taskId);
    // A review waits on its parents too: a reviewer's dependency block adds them (spec §5.4).
    if (!parents.every((p) => isFinished(p.phase))) {
      return refuse('not_claimable', `task ${task.taskId} is waiting on a parent that is not done`);
    }
    if (task.cooldownUntil !== null && task.cooldownUntil > now) {
      return refuse('not_claimable', `task ${task.taskId} is cooling down after being throttled`);
    }

    let workspace = task.workspace;
    if (workspace === null) {
      const from = task.createdFromTask === null ? undefined : getTask(d, task.createdFromTask);
      const resolved = resolveTaskWorkspace({
        own: null,
        roleWorkspace: agent ? input.claimant.roleWorkspace : undefined,
        upstream: parents.length > 0 ? parents.map((p) => p.workspace) : from === undefined ? [] : [from.workspace],
      });
      if ('conflict' in resolved) {
        if (agent) {
          return refuse(
            'unassignable',
            `task ${task.taskId}'s parents are in different workspaces (${resolved.conflict.join(', ')}); ` +
              'set its workspace',
          );
        }
      } else {
        workspace = resolved.workspace;
      }
    }
    if (agent) {
      if (workspace === null || !input.workspaces.has(workspace)) {
        return refuse('unassignable', `task ${task.taskId}'s workspace ${String(workspace)} is not configured`);
      }
      const busy = openAgentRunIn(d, workspace);
      if (busy !== undefined) {
        return refuse('workspace_busy', `workspace ${workspace} has an open agent run, ${busy.runId}`);
      }
    }

    const runs = runsOf(d, task.taskId);
    const runId = newRunId();
    const attempt = (runs.at(-1)?.attempt ?? 0) + 1;
    const seededFromRun = kind === 'work' ? reworkSeed(d, runs, input.claimant.agentConfig) : null;
    d.prepare(
      `INSERT INTO kanban_runs
         (run_id, task_id, attempt, kind, assignee_kind, assignee, agent_config, workspace,
          role_md_hash, seeded_from_run, token_hash, started_at)
       VALUES (?, ?, ?, ?, ?, ?, jsonb(?), ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      task.taskId,
      attempt,
      kind,
      who.kind,
      who.name,
      input.claimant.agentConfig === null ? null : JSON.stringify(input.claimant.agentConfig),
      workspace,
      input.claimant.roleMdHash,
      seededFromRun,
      input.tokenHash ?? null,
      now,
    );
    // A claimed task is no longer stranded (spec §3.1).
    d.prepare('UPDATE kanban_tasks SET workspace = ?, stranded_notified_at = NULL WHERE task_id = ?').run(
      workspace,
      task.taskId,
    );
    record(
      d,
      {
        taskId: task.taskId,
        runId,
        kind: 'claimed',
        actor: 'gateway',
        payload: { kind, attempt, assignee: who.name, workspace, seededFromRun },
      },
      now,
    );
    return { ok: true, run: mustGetRun(d, runId), task: mustGet(d, task.taskId) };
  });
}

/**
 * The run a rework resumes (spec §5.3): only right after a reviewer's
 * `changes`, only from the last work run, only if it ran the same agent --
 * driver, command and arguments; environment names are not compared -- and only
 * if its session observed a provider session id to resume. Anything else starts
 * fresh, and the column stays null: it names the run actually resumed.
 */
function reworkSeed(d: Db, runs: readonly RunRow[], agent: AgentSnapshot | null): string | null {
  const last = runs.at(-1);
  if (agent === null || last?.kind !== 'review' || last.outcome !== 'changes_requested') return null;
  const work = runs.findLast((r) => r.kind === 'work');
  if (work === undefined || work.agentConfig === null || work.sessionId === null) return null;
  const before = work.agentConfig;
  const same =
    before.driver === agent.driver &&
    before.command === agent.command &&
    JSON.stringify(before.args) === JSON.stringify(agent.args);
  if (!same) return null;
  const seen = d
    .prepare<[string], { provider_session_id: string | null }>('SELECT provider_session_id FROM sessions WHERE id = ?')
    .get(work.sessionId);
  return seen?.provider_session_id ? work.runId : null;
}

function mustGetRun(d: Db, runId: string): RunRow {
  const run = getRun(d, runId);
  if (run === undefined) throw new Error(`run ${runId} vanished inside its own transaction`);
  return run;
}

/**
 * Record the gateway session an agent run runs in (spec §3.3: one run, one
 * session). Plan C2 calls it once the session is created, after the claim.
 */
export function attachSession(db: Db, runId: string, sessionId: string, now: number): Result<{ run: RunRow }> {
  return tx(db, (d) => {
    const run = getRun(d, runId);
    if (run === undefined) return refuse('not_found', `no run ${runId}`);
    if (run.endedAt !== null) return refuse('already_closed', `run ${runId} is closed`);
    if (run.agentConfig === null) return refuse('invalid', `run ${runId} is a person's, and has no session`);
    if (run.sessionId !== null) return refuse('invalid', `run ${runId} already has session ${run.sessionId}`);
    d.prepare('UPDATE kanban_runs SET session_id = ? WHERE run_id = ?').run(sessionId, runId);
    record(d, { taskId: run.taskId, runId, kind: 'session_attached', actor: 'gateway', payload: { sessionId } }, now);
    return { ok: true, run: mustGetRun(d, runId) };
  });
}
