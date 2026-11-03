import type { Db } from './open.js';
import { txImmediate } from './open.js';
import { newRunId, newTaskId } from '../core/ids.js';
import { redactKnownSecrets, redactValues } from '../secrets.js';
import { resolveTaskWorkspace } from '../kanban/workspace.js';
import { REPORTED_OUTCOMES } from '../kanban/types.js';
import type {
  ActivePhase,
  AgentSnapshot,
  Assignee,
  BlockKind,
  CommentRow,
  Contract,
  CreatedVia,
  EndedOutcome,
  Phase,
  Refusal,
  RefusalCode,
  ReportedBlockKind,
  Reporter,
  Result,
  RetryOnCrash,
  RunKind,
  RunOutcome,
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

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * Make `parentId` a parent of `childId` (spec §3.2). Linking an existing pair
 * again changes nothing.
 *
 * Refused:
 * - a child past its parents gate -- in review, blocked from review, done or
 *   archived: the gate is evaluated when a task becomes ready, so a parent added
 *   now could never hold it back, and a review would wait on it forever;
 * - a child with an open run, for the same reason;
 * - a cycle, found by walking up from the parent: two tasks that can never become
 *   ready, and nothing would ever say why.
 */
export function link(db: Db, parentId: string, childId: string, by: string, now: number): Result<{ added: boolean }> {
  return tx(db, (d) => {
    if (getTask(d, parentId) === undefined) return refuse('not_found', `no task ${parentId}`);
    const child = getTask(d, childId);
    if (child === undefined) return refuse('not_found', `no task ${childId}`);
    if (child.phase !== 'open' && !(child.phase === 'blocked' && child.blockedFrom === 'open')) {
      return refuse(
        'illegal_transition',
        `task ${childId} is ${child.phase}; a parent added now could not hold it back`,
      );
    }
    return linkIn(d, parentId, childId, by, now);
  });
}

/**
 * The link itself, once the child's phase allows it. A dependency block calls it
 * directly (spec §5.4), on a task in `open` or `review`, with `blockingRun` the
 * run that has just reported the block: that run is decided, so the parents it
 * names hold back the next claim, not the run.
 */
function linkIn(
  d: Db,
  parentId: string,
  childId: string,
  by: string,
  now: number,
  blockingRun?: string,
): Result<{ added: boolean }> {
  if (getTask(d, parentId) === undefined) return refuse('not_found', `no task ${parentId}`);
  if (parentId === childId) return refuse('cycle', `task ${childId} cannot be its own parent`);
  const exists = d
    .prepare<[string, string], { n: number }>('SELECT 1 AS n FROM kanban_links WHERE parent_id = ? AND child_id = ?')
    .get(parentId, childId);
  if (exists !== undefined) return { ok: true, added: false };
  const cycle = d
    .prepare<[string, string], { n: number }>(
      `WITH RECURSIVE up(id) AS (
         SELECT ?
         UNION
         SELECT l.parent_id FROM kanban_links l JOIN up ON l.child_id = up.id
       )
       SELECT 1 AS n FROM up WHERE id = ? LIMIT 1`,
    )
    .get(parentId, childId);
  if (cycle !== undefined) {
    return refuse('cycle', `task ${childId} is already upstream of ${parentId}; the link would make a cycle`);
  }
  const open = openRunOf(d, childId);
  if (open !== undefined && open.runId !== blockingRun) {
    return refuse(
      'run_open',
      `task ${childId} has an open run, ${open.runId}; a parent added now could not hold it back`,
    );
  }
  d.prepare('INSERT INTO kanban_links (parent_id, child_id, created_at) VALUES (?, ?, ?)').run(parentId, childId, now);
  record(d, { taskId: childId, kind: 'linked', actor: by, payload: { parentId } }, now);
  return { ok: true, added: true };
}

// ---------------------------------------------------------------------------
// Reports: complete, review, changes
// ---------------------------------------------------------------------------

/** A worker's or a person's handoff (spec §7.3). */
export interface Handoff {
  summary: string;
  metadata?: unknown;
  /** For an agent's report in a git workspace (spec §7.8), captured before this transaction. */
  reportedCommit?: string | null;
  reportedDirty?: boolean | null;
}

export function actorOf(by: Reporter): string {
  return by.kind === 'run' ? `run:${by.runId}` : by.principal;
}

/**
 * The run a report decides, if any.
 *
 * A run reports only through its own run, while that is open and undecided: once
 * it has reported, a second report is `already_reported`; once anything else has
 * decided it, or it is closed, `run_superseded` (spec §7.2).
 *
 * A person's report decides the open human run, if there is one. While an agent
 * run is open it is refused (spec §5.1): gates would run against a checkout the
 * agent is still changing, and the agent's own later report would contradict
 * the person's.
 */
function reportingRun(d: Db, task: TaskRow, by: Reporter): Result<{ run: RunRow | undefined }> {
  if (by.kind === 'run') {
    const run = getRun(d, by.runId);
    if (run === undefined) return refuse('not_found', `no run ${by.runId}`);
    if (run.taskId !== task.taskId) {
      return refuse('wrong_task', `run ${run.runId} is on task ${run.taskId}, not ${task.taskId}`);
    }
    if (run.endedAt !== null) return refuse('run_superseded', `run ${run.runId} is over`);
    if (run.outcome !== null) {
      return (REPORTED_OUTCOMES as readonly string[]).includes(run.outcome)
        ? refuse('already_reported', `run ${run.runId} has already reported (${run.outcome})`)
        : refuse('run_superseded', `run ${run.runId} has ended (${run.outcome})`);
    }
    return { ok: true, run };
  }
  const open = openRunOf(d, task.taskId);
  if (open === undefined) return { ok: true, run: undefined };
  if (open.assignee.kind === 'role') {
    return refuse(
      'agent_run_open',
      open.outcome === null
        ? `task ${task.taskId} has an agent run working on it (${open.runId}); stop it first`
        : `task ${task.taskId}'s agent run ${open.runId} has reported and is finishing; wait for it to finish`,
    );
  }
  return { ok: true, run: open };
}

/** The phase a run of this kind works in. */
function phaseOfKind(kind: RunKind): ActivePhase {
  return kind === 'work' ? 'open' : 'review';
}

/**
 * Set an undecided run's outcome. A person's run is closed at the same moment:
 * there is no process to finish (spec §3.3). Any outcome but `rate_limited`
 * resets the task's throttling counter (spec §8.2).
 */
function decide(
  d: Db,
  run: RunRow,
  outcome: RunOutcome,
  fields: {
    summary?: string | null;
    metadata?: unknown;
    reportedCommit?: string | null;
    reportedDirty?: boolean | null;
    error?: string | null;
    lastOutput?: string | null;
  },
  now: number,
): void {
  const agent = run.agentConfig !== null;
  const changed = d
    .prepare(
      `UPDATE kanban_runs
          SET outcome = ?, summary = ?, metadata = jsonb(?), reported_commit = ?, reported_dirty = ?,
              error = ?, last_output = ?, ended_at = ?
        WHERE run_id = ? AND outcome IS NULL`,
    )
    .run(
      outcome,
      fields.summary === undefined || fields.summary === null ? null : mask(fields.summary),
      fields.metadata === undefined ? null : JSON.stringify(redactValues(fields.metadata)),
      agent ? (fields.reportedCommit ?? null) : null,
      agent && fields.reportedDirty !== undefined && fields.reportedDirty !== null
        ? Number(fields.reportedDirty)
        : null,
      fields.error === undefined || fields.error === null ? null : mask(fields.error),
      fields.lastOutput === undefined || fields.lastOutput === null ? null : mask(fields.lastOutput),
      agent ? null : now,
      run.runId,
    ).changes;
  if (changed !== 1) throw new Error(`run ${run.runId} was decided twice`);
  if (outcome !== 'rate_limited') {
    d.prepare('UPDATE kanban_tasks SET consecutive_transient = 0 WHERE task_id = ?').run(run.taskId);
  }
}

/**
 * Report on the task as the run or person given, after the checks every report
 * shares: the reporter may report, the task is in a phase this report applies
 * to, and a run's kind fits that phase.
 */
function reporting(
  d: Db,
  taskId: string,
  by: Reporter,
  phases: readonly ActivePhase[],
  what: string,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  const task = getTask(d, taskId);
  if (task === undefined) return refuse('not_found', `no task ${taskId}`);
  const r = reportingRun(d, task, by);
  if (!r.ok) return r;
  if (!(phases as readonly Phase[]).includes(task.phase)) {
    return refuse('illegal_transition', `task ${taskId} is ${task.phase}, so it cannot ${what}`);
  }
  if (r.run !== undefined && phaseOfKind(r.run.kind) !== task.phase) {
    return refuse('illegal_transition', `a ${r.run.kind} run cannot ${what}`);
  }
  return { ok: true, task, run: r.run };
}

/**
 * The one way to `done` (spec §5.1): an agent's or reviewer's `complete`, a
 * person's done or approval. Gates run before it, from plan C4.
 *
 * Completion resets the breaker's counters, and is the only report that does
 * (spec §3.1). A task whose parents are not all finished is refused: only a link
 * added after it started could cause that, which link() prevents; this is the
 * backstop.
 */
export function complete(
  db: Db,
  taskId: string,
  by: Reporter,
  handoff: Handoff,
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return tx(db, (d) => {
    const r = reporting(d, taskId, by, ['open', 'review'], 'be completed');
    if (!r.ok) return r;
    if (!parentsOf(d, taskId).every((p) => isFinished(p.phase))) {
      return refuse('parents_unfinished', `task ${taskId} has a parent that is not done`);
    }
    if (r.run !== undefined) decide(d, r.run, 'completed', handoff, now);
    d.prepare(
      `UPDATE kanban_tasks
          SET phase = 'done', closed_at = ?, consecutive_failures = 0, consecutive_transient = 0,
              block_recurrences = 0, cooldown_until = NULL
        WHERE task_id = ?`,
    ).run(now, taskId);
    record(
      d,
      {
        taskId,
        runId: r.run?.runId ?? null,
        kind: 'completed',
        actor: actorOf(by),
        payload: { summary: handoff.summary },
      },
      now,
    );
    return { ok: true, task: mustGet(d, taskId), run: r.run === undefined ? undefined : mustGetRun(d, r.run.runId) };
  });
}

/**
 * Same-task review (spec §5.3). A reviewer named in the report replaces the
 * task's; with none named anywhere it is refused, since a task in review with
 * nobody to review it is stranded under another label. Gates run before it,
 * from plan C4.
 */
export function requestReview(
  db: Db,
  taskId: string,
  by: Reporter,
  handoff: Handoff & { reviewer?: Assignee },
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return tx(db, (d) => {
    const r = reporting(d, taskId, by, ['open'], 'ask for review');
    if (!r.ok) return r;
    const reviewer = handoff.reviewer ?? r.task.reviewer;
    if (reviewer === null) return refuse('no_reviewer', `nobody is named to review task ${taskId}`);
    if (r.run !== undefined) decide(d, r.run, 'review_requested', handoff, now);
    d.prepare("UPDATE kanban_tasks SET phase = 'review', reviewer_kind = ?, reviewer = ? WHERE task_id = ?").run(
      reviewer.kind,
      reviewer.name,
      taskId,
    );
    record(
      d,
      {
        taskId,
        runId: r.run?.runId ?? null,
        kind: 'review_requested',
        actor: actorOf(by),
        payload: { summary: handoff.summary, reviewer: reviewer.name },
      },
      now,
    );
    return { ok: true, task: mustGet(d, taskId), run: r.run === undefined ? undefined : mustGetRun(d, r.run.runId) };
  });
}

/**
 * A reviewer's `changes` (spec §5.3): the task returns to open, and its next
 * claim is the rework. The reason is the review run's summary, which the
 * rework's prompt carries.
 */
export function requestChanges(
  db: Db,
  taskId: string,
  by: Reporter,
  reason: string,
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return tx(db, (d) => {
    const r = reporting(d, taskId, by, ['review'], 'have changes requested');
    if (!r.ok) return r;
    if (r.run !== undefined) decide(d, r.run, 'changes_requested', { summary: reason }, now);
    d.prepare("UPDATE kanban_tasks SET phase = 'open' WHERE task_id = ?").run(taskId);
    record(
      d,
      { taskId, runId: r.run?.runId ?? null, kind: 'changes_requested', actor: actorOf(by), payload: { reason } },
      now,
    );
    return { ok: true, task: mustGet(d, taskId), run: r.run === undefined ? undefined : mustGetRun(d, r.run.runId) };
  });
}

/**
 * Close a decided run: its session's last turn has ended, the agent process is
 * gone, and the workspace is free (spec §3.3). An undecided run is refused: what
 * ended it must be recorded first, by a report or by endRun().
 */
export function closeRun(db: Db, runId: string, now: number): Result<{ run: RunRow }> {
  return tx(db, (d) => {
    const run = getRun(d, runId);
    if (run === undefined) return refuse('not_found', `no run ${runId}`);
    if (run.endedAt !== null) return refuse('already_closed', `run ${runId} is already closed`);
    if (run.outcome === null) return refuse('undecided', `run ${runId} has no outcome yet; record one first`);
    d.prepare('UPDATE kanban_runs SET ended_at = ? WHERE run_id = ?').run(now, runId);
    record(
      d,
      { taskId: run.taskId, runId, kind: 'run_closed', actor: 'gateway', payload: { outcome: run.outcome } },
      now,
    );
    return { ok: true, run: mustGetRun(d, runId) };
  });
}

// ---------------------------------------------------------------------------
// Blocking, unblocking, stopping
// ---------------------------------------------------------------------------

export interface BlockReport {
  kind: ReportedBlockKind;
  reason: string;
  /** For `dependency`: the tasks it waits on, linked as parents in the same transaction. */
  parents?: readonly string[];
}

/**
 * Move a task to `blocked` (spec §5.4), remembering the phase it left. A block of
 * the same kind as the last one -- which survives unblock -- is a recurrence,
 * and recurrences are reset only by completion: resetting them on unblock is the
 * amnesia that lets a task bounce between blocked and unblocked forever.
 */
function enterBlocked(d: Db, task: TaskRow, kind: Exclude<BlockKind, 'dependency'>, reason: string): number {
  if (task.phase !== 'open' && task.phase !== 'review') throw new Error(`cannot block a ${task.phase} task`);
  const recurrences = task.blockRecurrences + (task.blockKind === kind ? 1 : 0);
  d.prepare(
    `UPDATE kanban_tasks
        SET phase = 'blocked', blocked_from = ?, block_kind = ?, block_reason = ?, block_recurrences = ?
      WHERE task_id = ?`,
  ).run(task.phase, kind, mask(reason), recurrences, task.taskId);
  return recurrences;
}

/**
 * A worker's or person's `block` (spec §5.1, §5.4).
 *
 * `dependency` never sits in `blocked`, since no person needs to act. The task
 * keeps its phase, and the parents the report names are linked here, so its next
 * claim waits for them:
 * - from a work run it stays `open`, shown as todo;
 * - from a review run it stays `review`, shown as todo, and the reviewer is
 *   claimed again once the parents are done. The implementer's work is done; only
 *   the review was waiting, so it is not redone.
 *
 * A dependency block that leaves nothing unfinished to wait on is refused: the
 * task would be claimable again at once.
 */
export function block(
  db: Db,
  taskId: string,
  by: Reporter,
  report: BlockReport,
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return tx(db, (d) => {
    const r = reporting(d, taskId, by, ['open', 'review'], 'be blocked');
    if (!r.ok) return r;
    if (r.run !== undefined) decide(d, r.run, 'blocked', { summary: report.reason }, now);
    const actor = actorOf(by);
    if (report.kind === 'dependency') {
      const parents = report.parents ?? [];
      for (const parent of parents) {
        const linked = linkIn(d, parent, taskId, actor, now, r.run?.runId);
        if (!linked.ok) return linked;
      }
      if (parentsOf(d, taskId).every((p) => isFinished(p.phase))) {
        return refuse('invalid', `a dependency block must name a task ${taskId} waits on that is not done`);
      }
      record(
        d,
        {
          taskId,
          runId: r.run?.runId ?? null,
          kind: 'blocked',
          actor,
          payload: { kind: report.kind, reason: report.reason, parents },
        },
        now,
      );
    } else {
      const recurrences = enterBlocked(d, r.task, report.kind, report.reason);
      record(
        d,
        {
          taskId,
          runId: r.run?.runId ?? null,
          kind: 'blocked',
          actor,
          payload: { kind: report.kind, reason: report.reason, blockRecurrences: recurrences },
        },
        now,
      );
    }
    return { ok: true, task: mustGet(d, taskId), run: r.run === undefined ? undefined : mustGetRun(d, r.run.runId) };
  });
}

/**
 * Return a blocked task to the phase it left (spec §5.4), optionally with a
 * comment the next run will read. The kind and reason are kept.
 *
 * Unblocking a `gave_up` task resets its failure count, and a `transient` one its
 * throttling count (spec §8.2): otherwise a person who fixed the cause would get
 * one attempt, or none, before the breaker tripped again.
 */
export function unblock(
  db: Db,
  taskId: string,
  by: string,
  comment: string | undefined,
  now: number,
): Result<{ task: TaskRow }> {
  return tx(db, (d) => {
    const task = getTask(d, taskId);
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    if (task.phase !== 'blocked') return refuse('illegal_transition', `task ${taskId} is ${task.phase}, not blocked`);
    d.prepare(
      `UPDATE kanban_tasks
          SET phase = blocked_from, blocked_from = NULL,
              consecutive_failures = CASE block_kind WHEN 'gave_up' THEN 0 ELSE consecutive_failures END,
              consecutive_transient = CASE block_kind WHEN 'transient' THEN 0 ELSE consecutive_transient END,
              cooldown_until = CASE block_kind WHEN 'transient' THEN NULL ELSE cooldown_until END
        WHERE task_id = ?`,
    ).run(taskId);
    record(d, { taskId, kind: 'unblocked', actor: by, payload: { kind: task.blockKind } }, now);
    if (comment !== undefined && comment !== '') insertComment(d, taskId, by, comment, now);
    return { ok: true, task: mustGet(d, taskId) };
  });
}

/**
 * `/kanban stop` (spec §5.1). An undecided run is cancelled and the task blocks
 * as `needs_input`, rather than staying ready and being dispatched again at once.
 * A run that has already reported keeps its outcome; nothing is written.
 *
 * The run returned still has `endedAt` null when it is an agent's: the caller
 * cancels its turn, and closes it when the turn ends.
 */
export function stop(db: Db, taskId: string, by: string, now: number): Result<{ task: TaskRow; run: RunRow }> {
  return tx(db, (d) => {
    const task = getTask(d, taskId);
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    const open = openRunOf(d, taskId);
    if (open === undefined) return refuse('no_open_run', `task ${taskId} has no open run to stop`);
    if (open.outcome !== null) return { ok: true, task, run: open };
    decide(d, open, 'cancelled', {}, now);
    const recurrences = enterBlocked(d, task, 'needs_input', `stopped by ${by}`);
    record(
      d,
      { taskId, runId: open.runId, kind: 'stopped', actor: by, payload: { blockRecurrences: recurrences } },
      now,
    );
    return { ok: true, task: mustGet(d, taskId), run: mustGetRun(d, open.runId) };
  });
}

// ---------------------------------------------------------------------------
// Runs that end without a report
// ---------------------------------------------------------------------------

/** The `kanban:` settings the breaker uses (spec §8.2). */
export interface KanbanLimits {
  /** Counted failures that block a task as gave_up, unless the task sets its own. */
  failureLimit: number;
  /** Consecutive throttled runs that block a task as transient. */
  transientLimit: number;
  /** The first cooldown after a throttled run; it doubles each time, up to an hour. */
  transientCooldownS: number;
}

export const DEFAULT_LIMITS: KanbanLimits = { failureLimit: 2, transientLimit: 10, transientCooldownS: 300 };

const MAX_COOLDOWN_S = 60 * 60;

export interface RunEnding {
  outcome: EndedOutcome;
  error?: string | null;
  lastOutput?: string | null;
  /**
   * The run made a tool call outside its role's readOnlyTools (spec §8.3). Plan
   * C2 reads the tool calls from the run's session log.
   */
  hadSideEffects?: boolean;
}

/** What happens to the task next: claimed again, claimed again after a cooldown, or blocked. */
export type NextStep = 'retry' | 'cooldown' | 'blocked';

/**
 * Record why an agent run ended without a report, and what it means for the task
 * (spec §5.1, §5.2, §8.2, §8.3). Plan C2 calls it with the classifier's outcome,
 * or with its own -- `timed_out`, `interrupted` -- having recorded it before it
 * cancels the turn.
 *
 * Only an undecided run: a decided run's outcome is never overwritten, so a
 * restart or a runtime limit arriving just after a report cannot turn a
 * completed task's run into a failure. The run stays open; closeRun() closes it
 * when its turn has ended.
 *
 * - `failed`, `crashed`, `timed_out`, `protocol_violation` are counted. At the
 *   task's failure limit it blocks as `gave_up`; below it, it is claimed again.
 * - `rate_limited` is not counted, so a long quota window cannot use up a task's
 *   retries. It holds the task in a cooldown that doubles each time, up to an
 *   hour, and blocks it as `transient` at the limit.
 * - `terminal_provider` blocks at once as `capability`: every retry would hit the
 *   same wall.
 * - `interrupted` is not counted: the task did nothing wrong.
 *
 * With `retry_on_crash: if-no-side-effects`, a run that changed things blocks as
 * `needs_input` instead of being retried, so a person looks first.
 */
export function endRun(
  db: Db,
  runId: string,
  ending: RunEnding,
  limits: KanbanLimits,
  now: number,
): Result<{ task: TaskRow; run: RunRow; next: NextStep }> {
  return tx(db, (d) => {
    const run = getRun(d, runId);
    if (run === undefined) return refuse('not_found', `no run ${runId}`);
    if (run.endedAt !== null) return refuse('already_closed', `run ${runId} is closed`);
    if (run.outcome !== null) {
      return refuse('already_decided', `run ${runId} already has its outcome (${run.outcome}), which stands`);
    }
    if (run.agentConfig === null) return refuse('invalid', `run ${runId} is a person's: it has no process to end`);
    const before = mustGet(d, run.taskId);
    decide(d, run, ending.outcome, { error: ending.error ?? null, lastOutput: ending.lastOutput ?? null }, now);

    const cautious = before.retryOnCrash === 'if-no-side-effects' && ending.hadSideEffects === true;
    const careful = `the run ended ${ending.outcome} after changing things; look before it is retried`;
    let next: NextStep = 'retry';
    let blockAs: { kind: Exclude<BlockKind, 'dependency'>; reason: string } | undefined;
    switch (ending.outcome) {
      case 'terminal_provider':
        blockAs = { kind: 'capability', reason: ending.error ?? 'the provider refused the credentials or the model' };
        break;
      case 'rate_limited': {
        const n = before.consecutiveTransient + 1;
        d.prepare('UPDATE kanban_tasks SET consecutive_transient = ? WHERE task_id = ?').run(n, run.taskId);
        if (n >= limits.transientLimit) {
          blockAs = { kind: 'transient', reason: `throttled ${n} times in a row` };
        } else if (cautious) {
          blockAs = { kind: 'needs_input', reason: careful };
        } else {
          const seconds = Math.min(limits.transientCooldownS * 2 ** (n - 1), MAX_COOLDOWN_S);
          d.prepare('UPDATE kanban_tasks SET cooldown_until = ? WHERE task_id = ?').run(
            now + seconds * 1000,
            run.taskId,
          );
          next = 'cooldown';
        }
        break;
      }
      case 'interrupted':
        if (cautious) blockAs = { kind: 'needs_input', reason: careful };
        break;
      case 'failed':
      case 'crashed':
      case 'timed_out':
      case 'protocol_violation': {
        const failures = before.consecutiveFailures + 1;
        d.prepare('UPDATE kanban_tasks SET consecutive_failures = ? WHERE task_id = ?').run(failures, run.taskId);
        if (failures >= (before.failureLimit ?? limits.failureLimit)) {
          blockAs = {
            kind: 'gave_up',
            reason: `failed ${failures} times; last ${ending.outcome}${ending.error ? `: ${ending.error}` : ''}`,
          };
        } else if (cautious) {
          blockAs = { kind: 'needs_input', reason: careful };
        }
        break;
      }
    }
    if (blockAs !== undefined) {
      enterBlocked(d, mustGet(d, run.taskId), blockAs.kind, blockAs.reason);
      next = 'blocked';
    }
    record(
      d,
      {
        taskId: run.taskId,
        runId,
        kind: 'run_ended',
        actor: 'gateway',
        payload: { outcome: ending.outcome, error: ending.error ?? null, next, blockKind: blockAs?.kind ?? null },
      },
      now,
    );
    return { ok: true, task: mustGet(d, run.taskId), run: mustGetRun(d, runId), next };
  });
}
