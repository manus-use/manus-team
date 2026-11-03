import type { Db } from './open.js';
import { txImmediate } from './open.js';
import { newTaskId } from '../core/ids.js';
import { redactKnownSecrets, redactValues } from '../secrets.js';
import type {
  Assignee,
  CommentRow,
  Contract,
  CreatedVia,
  Refusal,
  RefusalCode,
  Result,
  RetryOnCrash,
  TaskRow,
} from '../kanban/types.js';
import { getRun, getTask, getTaskByKey } from './kanban-read.js';

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
