import type { Db } from './open.js';
import { txImmediate } from './open.js';
import { newRunId, newTaskId } from '../core/ids.js';
import { isResumableProviderId } from '../provider-id.js';
import { NAME_PATTERN, RESERVED_BOARD_NAMES, visible } from '../names.js';
import { redactKnownSecrets, redactValues } from '../secrets.js';
import type { GateRun } from '../kanban/gates.js';
import { placeName, placeOf, resolveTaskWorkspace } from '../kanban/workspace.js';
import { worktreeId } from './workspaces.js';
import { DEFAULT_BOARD, ENDED_OUTCOMES, GATE_LIMITS, REPORTED_OUTCOMES } from '../kanban/types.js';
import type {
  ActivePhase,
  AgentSnapshot,
  Assignee,
  BlockKind,
  BoardRow,
  ChatAt,
  CommentRow,
  Contract,
  CreatedVia,
  EndedOutcome,
  GateRow,
  Phase,
  Refusal,
  RefusalCode,
  ReportedBlockKind,
  Rendering,
  Reporter,
  Result,
  RetryOnCrash,
  RunKind,
  RunOutcome,
  RunRow,
  TaskRow,
} from '../kanban/types.js';
import {
  getBoard,
  getRun,
  getTask,
  getTaskByKey,
  gatesOf,
  isFinished,
  openAgentRunIn,
  openRunOf,
  parentsOf,
  runsOf,
  subscriptionsOf,
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
 * comments, errors, output, reported commits -- and every event payload's string
 * values are masked before they are stored (spec §10.1 layer 3). Best effort: a secret split
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
 * the names of who and where, and a rendered package's content hash. Passed to redactValues for these payloads only:
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
  'assigneeKind',
  'reviewer',
  'reviewerKind',
  'workspace',
  'packageHash',
  'seedDropped',
  'board',
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

/**
 * A contract is flat text, so each value is masked as text. Not redactValues: it
 * leaves a value under a globally identifying key such as `workspace` alone.
 */
function maskContract(contract: Contract): Contract {
  return Object.fromEntries(Object.entries(contract).map(([field, value]) => [field, mask(value)]));
}

/**
 * A run's metadata is free-form JSON an agent shapes, so nothing in it identifies:
 * every string is masked whatever its key, and so is every key. Not redactValues,
 * which leaves a value under a globally identifying key such as `sessionId` alone.
 */
function maskDeep(value: unknown): unknown {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [mask(key), maskDeep(inner)]));
  }
  return value;
}

function mustGet(d: Db, taskId: string): TaskRow {
  const task = getTask(d, taskId);
  if (task === undefined) throw new Error(`task ${taskId} vanished inside its own transaction`);
  return task;
}

// ---------------------------------------------------------------------------
// Boards (spec §16)
// ---------------------------------------------------------------------------

function mustGetBoard(d: Db, name: string): BoardRow {
  const board = getBoard(d, name);
  if (board === undefined) throw new Error(`board ${name} vanished inside its own transaction`);
  return board;
}

/** Why a parent cannot hold back a child on another board (spec §16). */
function onOtherBoard(parentId: string, parentBoard: string, childBoard: string): string {
  return `task ${parentId} is on board ${parentBoard}, not ${childBoard}: a task and its parents are on one board`;
}

/** A board that exists and is not archived: what a task is added to, and a chat moved onto. */
function liveBoard(d: Db, name: string): Result<{ board: BoardRow }> {
  const board = getBoard(d, name);
  if (board === undefined) return refuse('unknown_board', `there is no board ${visible(name)}`);
  if (board.archivedAt !== null) return refuse('board_archived', `board ${name} is archived`);
  return { ok: true, board };
}

/**
 * A new board, with no max_running or workspace of its own. A name is never
 * reused, an archived board's included: tasks keep the name of the board they
 * were on, and a second board of that name would take them over.
 */
export function createBoard(db: Db, name: string, by: string, now: number): Result<{ board: BoardRow }> {
  // The service checks the name, and says why; this is the cheap check behind it.
  if (!NAME_PATTERN.test(name) || RESERVED_BOARD_NAMES.has(name)) {
    return refuse('invalid', `${visible(JSON.stringify(name))} is not a board name`);
  }
  return tx(db, (d) => {
    const existing = getBoard(d, name);
    if (existing !== undefined) {
      return refuse('invalid', `board ${name} exists already${existing.archivedAt === null ? '' : ', archived'}`);
    }
    d.prepare('INSERT INTO kanban_boards (name, created_by, created_at) VALUES (?, ?, ?)').run(name, by, now);
    return { ok: true, board: mustGetBoard(d, name) };
  });
}

/** A board's own settings (spec §16); a field left out is left as it is, and null clears it. */
export interface BoardChange {
  maxRunning?: number | null;
  workspace?: string | null;
}

/**
 * Set a board's max_running or workspace. The service has checked the values:
 * a max_running inside the gateway's, a configured workspace. A workspace set
 * here is used by the tasks claimed from now on whose workspace is still null.
 */
export function setBoard(db: Db, name: string, change: BoardChange, by: string, now: number): Result<{ board: BoardRow }> {
  return tx(db, (d) => {
    const live = liveBoard(d, name);
    if (!live.ok) return live;
    const next = {
      maxRunning: change.maxRunning === undefined ? live.board.maxRunning : change.maxRunning,
      workspace: change.workspace === undefined ? live.board.workspace : change.workspace,
    };
    d.prepare(
      'UPDATE kanban_boards SET max_running = ?, workspace = ?, updated_by = ?, updated_at = ? WHERE name = ?',
    ).run(next.maxRunning, next.workspace, by, now, name);
    return { ok: true, board: mustGetBoard(d, name) };
  });
}

/**
 * Archive a board: nothing is added to it from then on, and no chat moves onto
 * it. Refused while any of its tasks is still open, in review or blocked: its
 * work would have nowhere to go but a board nobody may add to. `default` is
 * never archived, as every chat starts on it.
 */
export function archiveBoard(db: Db, name: string, by: string, now: number): Result<{ board: BoardRow }> {
  return tx(db, (d) => {
    if (name === DEFAULT_BOARD) return refuse('invalid', `board ${DEFAULT_BOARD} is where every chat starts; it is never archived`);
    const live = liveBoard(d, name);
    if (!live.ok) return live;
    const unfinished =
      d
        .prepare<[string], { n: number }>(
          "SELECT count(*) AS n FROM kanban_tasks WHERE board = ? AND phase IN ('open', 'review', 'blocked')",
        )
        .get(name)?.n ?? 0;
    if (unfinished > 0) {
      return refuse(
        'illegal_transition',
        `board ${name} has ${unfinished} task${unfinished === 1 ? '' : 's'} not yet done or archived; finish or archive ${unfinished === 1 ? 'it' : 'them'} first`,
      );
    }
    d.prepare('UPDATE kanban_boards SET archived_at = ?, updated_by = ?, updated_at = ? WHERE name = ?').run(now, by, now, name);
    return { ok: true, board: mustGetBoard(d, name) };
  });
}

/** Move a chat onto a board (spec §16): its new tasks go there, and its list shows that board. */
export function useBoard(db: Db, at: ChatAt, name: string, by: string, now: number): Result<{ board: BoardRow }> {
  return tx(db, (d) => {
    const live = liveBoard(d, name);
    if (!live.ok) return live;
    d.prepare(
      `INSERT INTO kanban_chat_boards (channel, account_id, conversation_id, board, set_by, set_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (channel, account_id, conversation_id)
       DO UPDATE SET board = excluded.board, set_by = excluded.set_by, set_at = excluded.set_at`,
    ).run(at.channel, at.appId, at.conversationId, name, by, now);
    return { ok: true, board: live.board };
  });
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
  /** The board it goes on (spec §16); `default` unless given. */
  board?: string;
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
    let createdFromTask: string | null = null;
    let board = t.board ?? DEFAULT_BOARD;
    if (t.createdVia.kind === 'run') {
      const run = getRun(d, t.createdVia.runId);
      if (run === undefined) return refuse('not_found', `no run ${t.createdVia.runId}`);
      createdFromTask = run.taskId;
      // A run's follow-ups stay on its task's board, whatever it asked for (spec §16).
      board = mustGet(d, run.taskId).board;
    }
    if (t.idempotencyKey !== undefined && t.idempotencyKey !== null) {
      const existing = getTaskByKey(d, t.idempotencyKey);
      // A key on another board is not a repeat, however its task was created:
      // answering with that board's task would cross boards (spec §16.5).
      if (existing !== undefined && existing.board !== board) {
        return refuse(
          'other_board',
          `task ${existing.taskId} was created with this idempotency key on board ${existing.board}, not ${board}`,
        );
      }
      if (existing !== undefined) return { ok: true, task: existing, existing: true };
    }
    const live = liveBoard(d, board);
    if (!live.ok) return refuse(live.code, `${live.message}; no task is added to it`);
    const parents = [...new Set(t.parents ?? [])];
    for (const parent of parents) {
      const p = getTask(d, parent);
      if (p === undefined) return refuse('not_found', `no task ${parent} to be a parent`);
      if (p.board !== board) return refuse('other_board', onOtherBoard(parent, p.board, board));
    }

    const taskId = newTaskId();
    d.prepare(
      `INSERT INTO kanban_tasks
         (task_id, title, body, contract, assignee_kind, assignee, reviewer_kind, reviewer,
          workspace, phase, priority, idempotency_key, failure_limit, retry_on_crash,
          max_runtime_s, created_by, created_via, created_at, created_from_task, board)
       VALUES (?, ?, ?, jsonb(?), ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, jsonb(?), ?, ?, ?)`,
    ).run(
      taskId,
      mask(t.title),
      mask(t.body ?? ''),
      JSON.stringify(maskContract(t.contract ?? {})),
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
      board,
    );
    const link = d.prepare('INSERT INTO kanban_links (parent_id, child_id, created_at) VALUES (?, ?, ?)');
    for (const parent of parents) link.run(parent, taskId, now);
    subscribe(d, taskId, t.createdVia, createdFromTask, now);
    record(
      d,
      {
        taskId,
        kind: 'created',
        actor: t.createdBy,
        payload: {
          title: t.title,
          assignee: t.assignee?.name ?? null,
          assigneeKind: t.assignee?.kind ?? null,
          reviewer: t.reviewer?.name ?? null,
          reviewerKind: t.reviewer?.kind ?? null,
          workspace: t.workspace ?? null,
          parents,
          createdFromTask,
          board,
        },
      },
      now,
    );
    return { ok: true, task: mustGet(d, taskId), existing: false };
  });
}

/**
 * The chats that follow a new task (spec §9.4, §7.3): the chat it was created
 * in; or, for a task a run created, every chat following the creating run's
 * task, so whoever follows that task hears about its follow-ups too, in its
 * thread, with its root (spec §19.4). Each cursor starts at 0: every event of the
 * new task is newer than that. A root is written only with a thread: at chat
 * scope it comes from `threadSubscription` alone.
 */
function subscribe(d: Db, taskId: string, via: CreatedVia, createdFromTask: string | null, now: number): void {
  const insert = d.prepare(
    `INSERT OR IGNORE INTO kanban_subscriptions (task_id, channel, account_id, conversation_id, thread_id, root_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  if (via.kind === 'chat') {
    const root = via.threadId === '' || via.rootId === undefined || via.rootId === '' ? null : via.rootId;
    insert.run(taskId, via.channel, via.appId, via.conversationId, via.threadId, root, now);
    return;
  }
  if (createdFromTask === null) return;
  for (const s of subscriptionsOf(d, createdFromTask)) {
    insert.run(taskId, s.channel, s.appId, s.conversationId, s.threadId, s.rootMessageId, now);
  }
}

/**
 * Move a subscription's cursor to an event it has been told of, or passed over as
 * no notice (spec §9.4). Forward only, so a slower round cannot move it back and
 * have a notice sent twice. It writes no event: the cursor is the projection's
 * own, as a binding's `cursor_seq` is, and an event here would itself be a new
 * event past the cursor.
 */
export function advanceSubscription(db: Db, subscriptionId: number, cursor: number): Result<{ advanced: boolean }> {
  return tx(db, (d) => {
    const found = d.prepare<[number], { id: number }>('SELECT id FROM kanban_subscriptions WHERE id = ?').get(subscriptionId);
    if (found === undefined) return refuse('not_found', `no subscription ${subscriptionId}`);
    const { changes } = d
      .prepare('UPDATE kanban_subscriptions SET cursor = ? WHERE id = ? AND cursor < ?')
      .run(cursor, subscriptionId, cursor);
    return { ok: true, advanced: changes === 1 };
  });
}

/**
 * Move a task's subscription at a chat into the thread its "Created" reply
 * opened (spec §19.4): its `thread_id` from '' to the thread's, and its root to
 * the command message, in one transaction. Only a subscription of this task, at
 * this chat, for this bot, still at chat scope with no root, moves, so a second
 * call changes nothing. Its cursor moves with it: nothing already sent is sent
 * again, and nothing pending is lost. It writes no event, as a cursor's move
 * writes none.
 */
export function threadSubscription(db: Db, taskId: string, at: ChatAt, threadId: string, rootId: string): Result<{ moved: boolean }> {
  return tx(db, (d) => {
    if (threadId === '' || rootId === '') return refuse('invalid', 'a thread and its root are not empty');
    // OR IGNORE: a subscription of the task already in that thread is left as it is.
    const { changes } = d
      .prepare(
        `UPDATE OR IGNORE kanban_subscriptions SET thread_id = ?, root_message_id = ?
          WHERE task_id = ? AND channel = ? AND account_id = ? AND conversation_id = ?
            AND thread_id = '' AND root_message_id IS NULL`,
      )
      .run(threadId, rootId, taskId, at.channel, at.appId, at.conversationId);
    return { ok: true, moved: changes === 1 };
  });
}

/**
 * A comment, on a task in any phase. The dispatcher forwards a person's to an
 * undecided run (spec §7.5) -- if it `steers`: a talk-tier comment from chat is
 * stored for people to read, and never given to an agent (spec §9.1).
 */
export function addComment(
  db: Db,
  taskId: string,
  author: string,
  body: string,
  now: number,
  steers: boolean,
): Result<{ comment: CommentRow }> {
  return tx(db, (d) => {
    if (getTask(d, taskId) === undefined) return refuse('not_found', `no task ${taskId}`);
    return { ok: true, comment: insertComment(d, taskId, author, body, now, steers) };
  });
}

function insertComment(d: Db, taskId: string, author: string, body: string, now: number, steers: boolean): CommentRow {
  const masked = mask(body);
  const { lastInsertRowid } = d
    .prepare('INSERT INTO kanban_comments (task_id, author, body, created_at, steers) VALUES (?, ?, ?, ?, ?)')
    .run(taskId, author, masked, now, steers ? 1 : 0);
  // `steers` is recorded only when it is false, so a comment that steers reads as it always did.
  record(d, { taskId, kind: 'commented', actor: author, payload: steers ? { body } : { body, steers: false } }, now);
  return { id: Number(lastInsertRowid), taskId, author, body: masked, createdAt: now };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * Define a gate on a task (spec §7.7), for an operator: the service has checked
 * the command. Refused on a task that is done or archived, where nothing will
 * run it, and past GATE_LIMITS -- the count, and the timeouts together, checked
 * here, inside the transaction, so two operators adding at once cannot pass them.
 *
 * The command is stored as written: never masked, since a masked command would
 * run broken (spec §10.1). Its event carries it, masked as every payload is,
 * which changes nothing for a command the service let through.
 */
export function addGate(
  db: Db,
  taskId: string,
  gate: { command: string; timeoutS: number },
  by: string,
  now: number,
): Result<{ gate: GateRow }> {
  return tx(db, (d) => {
    const task = getTask(d, taskId);
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    if (task.phase === 'done' || task.phase === 'archived') {
      return refuse('illegal_transition', `task ${taskId} is ${task.phase}; a gate on it would never run`);
    }
    const gates = gatesOf(d, taskId);
    if (gates.length >= GATE_LIMITS.perTask) {
      return refuse('invalid', `task ${taskId} has ${gates.length} gates, the most a task may have`);
    }
    const total = gates.reduce((sum, g) => sum + g.timeoutS, 0) + gate.timeoutS;
    if (total > GATE_LIMITS.totalTimeoutS) {
      return refuse(
        'invalid',
        `task ${taskId}'s gates would take up to ${total} s together; at most ${GATE_LIMITS.totalTimeoutS} s, ` +
          'since a report waits for them',
      );
    }
    const { lastInsertRowid } = d
      .prepare('INSERT INTO kanban_gates (task_id, command, timeout_s, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, gate.command, gate.timeoutS, by, now);
    const id = Number(lastInsertRowid);
    record(
      d,
      { taskId, kind: 'gate_added', actor: by, payload: { gateId: id, command: gate.command, timeoutS: gate.timeoutS } },
      now,
    );
    return {
      ok: true,
      gate: { id, taskId, command: gate.command, timeoutS: gate.timeoutS, createdBy: by, createdAt: now },
    };
  });
}

/**
 * Remove one of a task's gates, for an operator. The row goes; its `gate_removed`
 * event keeps what it was and who removed it.
 */
export function removeGate(db: Db, taskId: string, gateId: number, by: string, now: number): Result<{ gate: GateRow }> {
  return tx(db, (d) => {
    if (getTask(d, taskId) === undefined) return refuse('not_found', `no task ${taskId}`);
    const gate = gatesOf(d, taskId).find((g) => g.id === gateId);
    if (gate === undefined) return refuse('not_found', `task ${taskId} has no gate ${gateId}`);
    d.prepare('DELETE FROM kanban_gates WHERE id = ?').run(gateId);
    record(d, { taskId, kind: 'gate_removed', actor: by, payload: { gateId, command: gate.command } }, now);
    return { ok: true, gate };
  });
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
  /**
   * The isolated workspaces (spec §18): a task's first agent claim in one gives
   * the task a directory of its own. Absent, none is.
   */
  isolated?: ReadonlySet<string>;
  /**
   * The places -- a workspace's shared directory, by name, or a task's own, by
   * its `wt:` id -- whose gates a report is running now, each with the task
   * reported on. A task's workspace may be resolved only here, so a claim whose
   * place resolves to one of them is refused here, in the transaction.
   */
  reportingIn?: ReadonlyMap<string, string>;
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
 *
 * The task's first agent claim in an isolated workspace gives it a directory of
 * its own (spec §18), fixed on the task as `worktree`: its runs, this one on,
 * record that as theirs, and the one-agent limit of the workspace's shared
 * directory does not apply to them. A task that has had an agent run in the
 * shared directory keeps it, and so does a task whose workspace is no longer
 * isolated.
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
        boardWorkspace: getBoard(d, task.board)?.workspace ?? null,
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
    const runs = runsOf(d, task.taskId);
    const worktree =
      task.worktree ??
      (agent && workspace !== null && input.isolated?.has(workspace) === true && !runs.some((r) => r.agentConfig !== null)
        ? worktreeId(task.taskId)
        : null);
    // Where the run works, and the task's gates run: its own directory, else its workspace's.
    const place = placeOf({ workspace, worktree });
    const testing = place === null ? undefined : input.reportingIn?.get(place);
    if (testing !== undefined) {
      return refuse('not_claimable', `${placeName(place ?? '')} is running the gates of a report on task ${testing}`);
    }
    if (agent) {
      if (workspace === null || !input.workspaces.has(workspace)) {
        return refuse('unassignable', `task ${task.taskId}'s workspace ${String(workspace)} is not configured`);
      }
      // One agent at a time in a shared directory; a task's own holds only its own runs.
      const busy = worktree === null ? openAgentRunIn(d, workspace) : undefined;
      if (busy !== undefined) {
        return refuse('workspace_busy', `workspace ${workspace} has an open agent run, ${busy.runId}`);
      }
    }

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
      place,
      input.claimant.roleMdHash,
      seededFromRun,
      input.tokenHash ?? null,
      now,
    );
    // A claimed task is no longer stranded (spec §3.1).
    d.prepare('UPDATE kanban_tasks SET workspace = ?, worktree = ?, stranded_notified_at = NULL WHERE task_id = ?').run(
      workspace,
      worktree,
      task.taskId,
    );
    record(
      d,
      {
        taskId: task.taskId,
        runId,
        kind: 'claimed',
        actor: 'gateway',
        // The kind, so a person's claim can be told as one: the group's one line (spec §9.2).
        payload: {
          kind,
          attempt,
          assignee: who.name,
          assigneeKind: who.kind,
          workspace,
          seededFromRun,
          ...(worktree === null ? {} : { worktree }),
        },
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
  // A `cli:` id names a runtime, not a provider session: nothing to resume.
  return isResumableProviderId(seen?.provider_session_id) ? work.runId : null;
}

function mustGetRun(d: Db, runId: string): RunRow {
  const run = getRun(d, runId);
  if (run === undefined) throw new Error(`run ${runId} vanished inside its own transaction`);
  return run;
}

/** A package's content hash: sha256, in lower-case hex. */
const PACKAGE_HASH = /^[0-9a-f]{64}$/;

/**
 * Record how an agent run's role reached its agent (plan R): as a native
 * package, by its content hash, or in the prompt. It goes into the run's
 * `agent_config`, beside the agent it ran, since it is part of what ran.
 * Written once, on an open agent run.
 *
 * It also settles a rework's seed (spec §5.3). The claim chose it before the
 * render, from the agent alone; a conversation resumes only under the same
 * system prompt, so the seed is kept only if the work run it resumes ran the
 * same way -- natively from the same package, or both in the prompt -- and
 * dropped otherwise, so that `seeded_from_run` names a run whose provider session
 * is really resumed. A run from before plan R records neither key, and counts as
 * not native. The dispatcher creates the session after this, from the run as it
 * is now.
 */
export function recordRendering(db: Db, runId: string, rendering: Rendering, now: number): Result<{ run: RunRow }> {
  return tx(db, (d) => {
    const run = getRun(d, runId);
    if (run === undefined) return refuse('not_found', `no run ${runId}`);
    if (run.endedAt !== null) return refuse('already_closed', `run ${runId} is closed`);
    if (run.agentConfig === null) return refuse('invalid', `run ${runId} is a person's: nothing renders for it`);
    if (run.agentConfig.native !== undefined) return refuse('invalid', `run ${runId}'s rendering is already recorded`);
    const fine = rendering.native ? PACKAGE_HASH.test(rendering.packageHash) : !('packageHash' in rendering);
    if (!fine) {
      return refuse('invalid', 'a native run records its package hash, 64 lower-case hex digits; any other run records none');
    }
    const recorded = rendering.native ? { native: true, packageHash: rendering.packageHash } : { native: false };
    const seed = run.seededFromRun === null ? undefined : getRun(d, run.seededFromRun)?.agentConfig;
    const sameWay =
      seed !== undefined &&
      seed !== null &&
      (seed.native === true) === rendering.native &&
      (!rendering.native || seed.packageHash === rendering.packageHash);
    const dropped = run.seededFromRun !== null && !sameWay ? run.seededFromRun : undefined;
    d.prepare('UPDATE kanban_runs SET agent_config = jsonb(?), seeded_from_run = ? WHERE run_id = ?').run(
      JSON.stringify({ ...run.agentConfig, ...recorded }),
      dropped === undefined ? run.seededFromRun : null,
      runId,
    );
    record(
      d,
      {
        taskId: run.taskId,
        runId,
        kind: 'run_rendered',
        actor: 'gateway',
        payload: dropped === undefined ? recorded : { ...recorded, seedDropped: dropped },
      },
      now,
    );
    return { ok: true, run: mustGetRun(d, runId) };
  });
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
 * again changes nothing, whatever either task's phase: that is checked first.
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
    if (linked(d, parentId, childId)) return { ok: true, added: false };
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

function linked(d: Db, parentId: string, childId: string): boolean {
  return (
    d
      .prepare<[string, string], { n: number }>('SELECT 1 AS n FROM kanban_links WHERE parent_id = ? AND child_id = ?')
      .get(parentId, childId) !== undefined
  );
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
  const parent = getTask(d, parentId);
  if (parent === undefined) return refuse('not_found', `no task ${parentId}`);
  if (parentId === childId) return refuse('cycle', `task ${childId} cannot be its own parent`);
  if (linked(d, parentId, childId)) return { ok: true, added: false };
  // Boards are separate queues: a task on one never waits for a task on another (spec §16).
  const child = mustGet(d, childId);
  if (parent.board !== child.board) return refuse('other_board', onOtherBoard(parentId, parent.board, child.board));
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

function actorOf(by: Reporter): string {
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
 * the person's. One exception (spec §5.1), for `answer` only: an operator's answer to a review
 * whose open run is a role reviewer's, still undecided, takes the review from
 * it -- `supersedes` -- and the answer's transaction ends that run `superseded`.
 * The reviewer does not change the work under review, and its later report is
 * refused, its run being over.
 */
function reportingRun(
  d: Db,
  task: TaskRow,
  by: Reporter,
  answer: boolean,
): Result<{ run: RunRow | undefined; supersedes?: boolean }> {
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
  // A card is for one run: pressed once that run is over, it does nothing (spec §9.2).
  // A typed report is for the run open when it was checked, or for none.
  if (by.runId !== undefined && (open?.runId ?? null) !== by.runId) {
    return refuse(
      'run_superseded',
      by.runId === null
        ? `task ${task.taskId} has a run open (${open?.runId ?? ''}) that it had not when this report was made: the task has moved on since`
        : `run ${by.runId} of task ${task.taskId} is over: the task has moved on since this report was made`,
    );
  }
  const named = namedRefused(task, by);
  if (named !== undefined) return named;
  if (open === undefined) return { ok: true, run: undefined };
  if (open.assignee.kind === 'role') {
    if (answer && by.as === 'operator' && task.phase === 'review' && open.kind === 'review' && open.outcome === null) {
      return { ok: true, run: open, supersedes: true };
    }
    return refuse(
      'agent_run_open',
      open.outcome === null
        ? `task ${task.taskId} has an agent run working on it (${open.runId}); stop it first`
        : `task ${task.taskId}'s agent run ${open.runId} has reported and is finishing; wait for it to finish`,
    );
  }
  return { ok: true, run: open };
}

/**
 * Whether the person still reports as what the caller checked them as
 * (`Reporter.as`): the task's assignee, while it is open; its reviewer, or an
 * operator, while it is in review. Checked in the transaction, after anything
 * that ran before it -- the gates -- so a task reassigned meanwhile is refused.
 */
function namedRefused(task: TaskRow, by: Extract<Reporter, { kind: 'person' }>): Refusal | undefined {
  if (by.as === undefined) return undefined;
  const moved = (now: string) =>
    refuse('run_superseded', `task ${task.taskId} ${now}: the task has moved on since this report was made`);
  const whom = (a: Assignee | null) => (a === null ? 'nobody' : a.kind === 'role' ? `role ${a.name}` : a.name);
  const theirs = (a: Assignee | null) => a?.kind === 'human' && a.name === by.principal;
  if (by.as === 'assignee') {
    if (!theirs(task.assignee)) return moved(`is now for ${whom(task.assignee)}`);
    if (task.phase !== 'open') return moved(`is ${task.phase}`);
    return undefined;
  }
  if (task.phase !== 'review') return moved(`is ${task.phase}, not waiting for review`);
  if (by.as === 'reviewer' && !theirs(task.reviewer)) return moved(`is now for ${whom(task.reviewer)} to review`);
  return undefined;
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
      fields.metadata === undefined ? null : JSON.stringify(maskDeep(fields.metadata)),
      // The service accepts only a commit id; masked anyway, should another caller not.
      agent && fields.reportedCommit !== undefined && fields.reportedCommit !== null
        ? mask(fields.reportedCommit)
        : null,
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
 * to, and a run's kind fits that phase. `answer`: an answer to a review, approve
 * or changes, which alone may take the review from a role reviewer's open run.
 */
function reporting(
  d: Db,
  taskId: string,
  by: Reporter,
  phases: readonly ActivePhase[],
  what: string,
  opts: { answer?: boolean } = {},
): Result<{ task: TaskRow; run: RunRow | undefined; supersedes: boolean }> {
  const task = getTask(d, taskId);
  if (task === undefined) return refuse('not_found', `no task ${taskId}`);
  const r = reportingRun(d, task, by, opts.answer === true);
  if (!r.ok) return r;
  if (!(phases as readonly Phase[]).includes(task.phase)) {
    return refuse('illegal_transition', `task ${taskId} is ${task.phase}, so it cannot ${what}`);
  }
  if (r.run !== undefined && phaseOfKind(r.run.kind) !== task.phase) {
    return refuse('illegal_transition', `a ${r.run.kind} run cannot ${what}`);
  }
  return { ok: true, task, run: r.run, supersedes: r.supersedes === true };
}

/**
 * Whether a `complete` on the task asks for review instead (spec §5.3): a work
 * report -- an agent's, or its person assignee's -- on a task that names a
 * reviewer. A named reviewer is never skipped, so the only way such a task is
 * done is its reviewer's approval, or an operator's.
 */
export function completeAsksReview(task: TaskRow): boolean {
  return task.phase === 'open' && task.reviewer !== null;
}

/**
 * Whether a report would be accepted now, checked as complete() and
 * requestReview() check it, and writing nothing: the service asks before it runs
 * a report's gates, so that a report the board would refuse -- a second report, a
 * person's while an agent works -- runs none. The transition checks it all again
 * in its own transaction, after the gates, since anything can change while they
 * run: the run may be decided, the task archived.
 */
export function reportCheck(
  db: Db,
  taskId: string,
  by: Reporter,
  kind: 'complete' | 'review',
  reviewer?: Assignee,
): Result<{ task: TaskRow; run: RunRow | undefined; supersedes: boolean }> {
  const r =
    kind === 'complete'
      ? reporting(db, taskId, by, ['open', 'review'], 'be completed', { answer: true })
      : reporting(db, taskId, by, ['open'], 'ask for review');
  if (!r.ok) return r;
  if (!parentsOf(db, taskId).every((p) => isFinished(p.phase))) {
    return refuse('parents_unfinished', `task ${taskId} has a parent that is not done`);
  }
  if (kind === 'review' && (reviewer ?? r.task.reviewer) === null) {
    return refuse('no_reviewer', `nobody is named to review task ${taskId}`);
  }
  // A person's run holds no workspace (spec §6.3), so another task's agent may be
  // changing the checkout the gates would test (spec §7.7). Asked here, before the
  // gates: once they start, no agent is claimed into the workspace until they end.
  // Its own directory, if it has one (spec §18): no other task's agent works there.
  const workspace = placeOf(r.task);
  if (by.kind === 'person' && workspace !== null && gatesOf(db, taskId).length > 0) {
    const busy = openAgentRunIn(db, workspace);
    // The reviewer run an operator's answer supersedes is not another agent's.
    if (busy !== undefined && !(r.supersedes && busy.runId === r.run?.runId)) {
      return refuse(
        'workspace_busy',
        `task ${taskId}'s gates run in ${placeName(workspace)}, where task ${busy.taskId}'s agent run ${busy.runId} is open; ` +
          'report again once it has finished',
      );
    }
  }
  return r;
}

/**
 * Record a report's run of the task's gates (spec §7.7), passed or not: each is
 * an event, whether the report then goes through or not. The output is masked,
 * as every payload is.
 */
export function recordGates(
  db: Db,
  taskId: string,
  by: { runId: string | null; actor: string },
  kind: 'complete' | 'review',
  ran: GateRun,
  now: number,
): void {
  txImmediate(db, (d) =>
    record(
      d,
      {
        taskId,
        runId: by.runId,
        kind: 'gates_ran',
        actor: by.actor,
        payload: { for: kind, passed: ran.passed, aborted: ran.aborted, notRun: ran.notRun, results: ran.results },
      },
      now,
    ),
  );
}

/**
 * The one way to `done` (spec §5.1): an agent's or reviewer's `complete`, a
 * person's done or approval. The service runs the task's gates before it.
 *
 * On a task that names a reviewer, a work report's `complete` is taken as a
 * review request with the same handoff (spec §5.3), and the task goes to
 * `review`, not `done`. An operator answering a review whose role reviewer's
 * run is still open ends that run `superseded` here, in the same transaction.
 *
 * Completion resets the breaker's counters, block recurrences included; work
 * handed to review resets the failure counts only (spec §3.1, §8.2). A task whose parents are not all finished is refused: only a link
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
    const r = reporting(d, taskId, by, ['open', 'review'], 'be completed', { answer: true });
    if (!r.ok) return r;
    if (!parentsOf(d, taskId).every((p) => isFinished(p.phase))) {
      return refuse('parents_unfinished', `task ${taskId} has a parent that is not done`);
    }
    const reviewer = r.task.reviewer;
    if (completeAsksReview(r.task) && reviewer !== null) return enterReview(d, r.task, r.run, by, handoff, reviewer, now);
    if (r.run !== undefined) {
      if (r.supersedes) decide(d, r.run, 'superseded', {}, now);
      else decide(d, r.run, 'completed', handoff, now);
    }
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
 * nobody to review it is stranded under another label. A task whose parents are
 * not all finished is refused, as complete() refuses it: the work being reviewed
 * was meant to wait for them. The service runs the task's gates before it.
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
    if (!parentsOf(d, taskId).every((p) => isFinished(p.phase))) {
      return refuse('parents_unfinished', `task ${taskId} has a parent that is not done`);
    }
    const reviewer = handoff.reviewer ?? r.task.reviewer;
    if (reviewer === null) return refuse('no_reviewer', `nobody is named to review task ${taskId}`);
    return enterReview(d, r.task, r.run, by, handoff, reviewer, now);
  });
}

/**
 * The work run, if any, ends asking for review, and the task waits for its
 * reviewer (spec §5.3). Work handed to review is work that succeeded, so the
 * breaker's counters start again (spec §8.2): failures in one review cycle are
 * not added to the next one's. Block recurrences are kept, as only completion
 * resets them.
 */
function enterReview(
  d: Db,
  task: TaskRow,
  run: RunRow | undefined,
  by: Reporter,
  handoff: Handoff,
  reviewer: Assignee,
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  const { taskId } = task;
  if (run !== undefined) decide(d, run, 'review_requested', handoff, now);
  d.prepare(
    `UPDATE kanban_tasks
        SET phase = 'review', reviewer_kind = ?, reviewer = ?, consecutive_failures = 0, consecutive_transient = 0
      WHERE task_id = ?`,
  ).run(
    reviewer.kind,
    reviewer.name,
    taskId,
  );
  record(
    d,
    {
      taskId,
      runId: run?.runId ?? null,
      kind: 'review_requested',
      actor: actorOf(by),
      payload: { summary: handoff.summary, reviewer: reviewer.name, reviewerKind: reviewer.kind },
    },
    now,
  );
  return { ok: true, task: mustGet(d, taskId), run: run === undefined ? undefined : mustGetRun(d, run.runId) };
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
    const r = reporting(d, taskId, by, ['review'], 'have changes requested', { answer: true });
    if (!r.ok) return r;
    if (r.run !== undefined) {
      // An operator's changes in place of a role reviewer's run: the reason is the event's, as a person's is.
      if (r.supersedes) decide(d, r.run, 'superseded', {}, now);
      else decide(d, r.run, 'changes_requested', { summary: reason }, now);
    }
    d.prepare("UPDATE kanban_tasks SET phase = 'open' WHERE task_id = ?").run(taskId);
    // A run's actor is the run: its reviewer, as it was, is the notice's (spec §9.4).
    const reviewer =
      by.kind === 'run' && r.run !== undefined ? { reviewer: r.run.assignee.name, reviewerKind: r.run.assignee.kind } : {};
    record(
      d,
      { taskId, runId: r.run?.runId ?? null, kind: 'changes_requested', actor: actorOf(by), payload: { reason, ...reviewer } },
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
  opts: { blockedAt?: number } = {},
): Result<{ task: TaskRow }> {
  return tx(db, (d) => {
    const task = getTask(d, taskId);
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    // An Unblock button is for the block its notice told of (spec §9.2): once that
    // has been lifted, the task may be blocked again for another reason. A run's
    // end is a block only when the task blocked there, not when it was retried.
    if (opts.blockedAt !== undefined) {
      const blocking = d
        .prepare<[string, number], { id: number }>(
          `SELECT id FROM kanban_events
            WHERE task_id = ? AND id = ?
              AND (kind IN ('blocked', 'stopped') OR (kind = 'run_ended' AND json_extract(payload, '$.next') = 'blocked'))`,
        )
        .get(taskId, opts.blockedAt);
      if (blocking === undefined) return refuse('invalid', `event ${opts.blockedAt} is no block of task ${taskId}`);
      const since = d
        .prepare<[string, number], { id: number }>(
          "SELECT id FROM kanban_events WHERE task_id = ? AND kind = 'unblocked' AND id > ? LIMIT 1",
        )
        .get(taskId, opts.blockedAt);
      if (since !== undefined) {
        return refuse('stale', `the block of task ${taskId} this button was for has been lifted already`);
      }
    }
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
    // An unblock is an operator's, so its comment steers the next run.
    if (comment !== undefined && comment !== '') insertComment(d, taskId, by, comment, now, true);
    return { ok: true, task: mustGet(d, taskId) };
  });
}

/**
 * `/kanban task stop` (spec §5.1). An undecided run is cancelled and the task blocks
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
   * C2 reads the tool calls from the run's session log. Absent means unknown,
   * which is taken as true: an if-no-side-effects task then stops for a person
   * rather than being retried blind.
   */
  hadSideEffects?: boolean;
  /**
   * For a `failed` run that could not start for a reason only a person can put
   * right -- its task's directory could not be made (spec §18): the run is not
   * counted, and the task blocks as `needs_input` with this reason.
   */
  block?: string;
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
 * With `retry_on_crash: if-no-side-effects`, a run that changed things, or may
 * have, blocks as `needs_input` instead of being retried, so a person looks first.
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
    // Checked at runtime too: a report's outcome recorded here would skip that report's checks.
    if (!(ENDED_OUTCOMES as readonly unknown[]).includes(ending.outcome)) {
      return refuse('invalid', `${JSON.stringify(ending.outcome)} is not an outcome a run ends with unreported`);
    }
    if (ending.block !== undefined && ending.outcome !== 'failed') {
      return refuse('invalid', 'only a failed run blocks its task for a person');
    }
    const before = mustGet(d, run.taskId);
    decide(d, run, ending.outcome, { error: ending.error ?? null, lastOutput: ending.lastOutput ?? null }, now);

    const cautious = before.retryOnCrash === 'if-no-side-effects' && ending.hadSideEffects !== false;
    const careful =
      ending.hadSideEffects === true
        ? `the run ended ${ending.outcome} after changing things; look before it is retried`
        : `the run ended ${ending.outcome}, and may have changed things; look before it is retried`;
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
        // Nothing ran: not the task's failure, and nothing a retry would change.
        if (ending.block !== undefined) {
          blockAs = { kind: 'needs_input', reason: ending.block };
          break;
        }
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
    let recurrences: number | null = null;
    if (blockAs !== undefined) {
      recurrences = enterBlocked(d, mustGet(d, run.taskId), blockAs.kind, blockAs.reason);
      next = 'blocked';
    }
    record(
      d,
      {
        taskId: run.taskId,
        runId,
        kind: 'run_ended',
        actor: 'gateway',
        payload: {
          outcome: ending.outcome,
          error: ending.error ?? null,
          next,
          blockKind: blockAs?.kind ?? null,
          // For the blocked notice (spec §9.4): why, and how often it has recurred, as of now.
          blockReason: blockAs?.reason ?? null,
          blockRecurrences: recurrences,
        },
      },
      now,
    );
    return { ok: true, task: mustGet(d, run.taskId), run: mustGetRun(d, runId), next };
  });
}

// ---------------------------------------------------------------------------
// Assigning, workspaces, archiving
// ---------------------------------------------------------------------------

/**
 * The open run a change takes the task away from: an undecided one ends
 * `superseded`; a decided one keeps its outcome (spec §3.3). Either way the run
 * is returned so the caller can cancel an agent's turn and close it.
 */
function supersede(d: Db, open: RunRow | undefined, now: number): RunRow | undefined {
  if (open === undefined) return undefined;
  if (open.outcome === null) decide(d, open, 'superseded', {}, now);
  return mustGetRun(d, open.runId);
}

function reassign(
  db: Db,
  taskId: string,
  role: 'assignee' | 'reviewer',
  who: Assignee,
  by: string,
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return tx(db, (d) => {
    const task = getTask(d, taskId);
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    if (task.phase === 'done' || task.phase === 'archived') {
      return refuse('illegal_transition', `task ${taskId} is ${task.phase}; it cannot be reassigned`);
    }
    const current = task[role];
    if (current !== null && current.kind === who.kind && current.name === who.name) {
      return { ok: true, task, run: undefined };
    }
    const open = openRunOf(d, taskId);
    const run = open?.kind === (role === 'assignee' ? 'work' : 'review') ? supersede(d, open, now) : undefined;
    d.prepare(`UPDATE kanban_tasks SET ${role}_kind = ?, ${role} = ? WHERE task_id = ?`).run(
      who.kind,
      who.name,
      taskId,
    );
    record(
      d,
      {
        taskId,
        runId: run?.runId ?? null,
        kind: `${role}_set`,
        actor: by,
        payload: { [role]: who.name, [`${role}Kind`]: who.kind },
      },
      now,
    );
    return { ok: true, task: mustGet(d, taskId), run };
  });
}

/**
 * `/kanban task assign` (spec §5.1): the phase is unchanged, and the next work claim
 * goes to the new assignee. An open work run is superseded.
 */
export function assign(
  db: Db,
  taskId: string,
  assignee: Assignee,
  by: string,
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return reassign(db, taskId, 'assignee', assignee, by, now);
}

/** The same, for the reviewer: the next review claim goes to them. An open review run is superseded. */
export function assignReviewer(
  db: Db,
  taskId: string,
  reviewer: Assignee,
  by: string,
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return reassign(db, taskId, 'reviewer', reviewer, by, now);
}

/**
 * `/kanban task workspace` (spec §2.3): set a task's workspace while it is null, in any
 * phase. Refused once fixed, not merely once claimed, so a null workspace -- a
 * person's task whose parents disagreed -- can always be set.
 */
export function setWorkspace(
  db: Db,
  taskId: string,
  workspace: string,
  by: string,
  now: number,
): Result<{ task: TaskRow }> {
  return tx(db, (d) => {
    const task = getTask(d, taskId);
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    if (task.workspace !== null) {
      return refuse('workspace_fixed', `task ${taskId} works in ${task.workspace}; a fixed workspace does not change`);
    }
    d.prepare('UPDATE kanban_tasks SET workspace = ? WHERE task_id = ?').run(workspace, taskId);
    record(d, { taskId, kind: 'workspace_set', actor: by, payload: { workspace } }, now);
    return { ok: true, task: mustGet(d, taskId) };
  });
}

/**
 * Archive a task from any phase but archived (spec §5.1). An undecided run ends
 * `superseded`. A done task keeps the time it was done. An archived parent no
 * longer holds its children back.
 */
export function archive(
  db: Db,
  taskId: string,
  by: string,
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return tx(db, (d) => {
    const task = getTask(d, taskId);
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    if (task.phase === 'archived') return refuse('illegal_transition', `task ${taskId} is already archived`);
    const run = supersede(d, openRunOf(d, taskId), now);
    d.prepare(
      `UPDATE kanban_tasks SET phase = 'archived', blocked_from = NULL, closed_at = coalesce(closed_at, ?)
        WHERE task_id = ?`,
    ).run(now, taskId);
    record(d, { taskId, runId: run?.runId ?? null, kind: 'archived', actor: by, payload: { from: task.phase } }, now);
    return { ok: true, task: mustGet(d, taskId), run };
  });
}

/**
 * A ready task nobody can be given (spec §4.2) is never dropped and never sent to
 * a fallback: it is recorded, once -- until something else happens to the task,
 * so a dispatcher pass every minute does not fill its log.
 *
 * Only a task that could otherwise be claimed now: in open or review, its parents
 * finished, no cooldown, no open run. A task still waiting gets no event; it is
 * noted when it is ready, if nobody can take it then.
 */
export function noteUnassignable(db: Db, taskId: string, reason: string, now: number): Result<{ written: boolean }> {
  return tx(db, (d) => {
    const task = getTask(d, taskId);
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    const claimable =
      (task.phase === 'open' || task.phase === 'review') &&
      openRunOf(d, taskId) === undefined &&
      (task.cooldownUntil === null || task.cooldownUntil <= now) &&
      parentsOf(d, taskId).every((p) => isFinished(p.phase));
    if (!claimable) return { ok: true, written: false };
    const last = d
      .prepare<[string], { kind: string }>('SELECT kind FROM kanban_events WHERE task_id = ? ORDER BY id DESC LIMIT 1')
      .get(taskId);
    // A stranded notice follows the skip it is about, and says the same thing.
    if (last?.kind === 'skipped_unassignable' || last?.kind === 'stranded') return { ok: true, written: false };
    record(d, { taskId, kind: 'skipped_unassignable', actor: 'gateway', payload: { reason } }, now);
    return { ok: true, written: true };
  });
}

/**
 * A task nobody can be given has waited too long (spec §4.2): its subscribers are
 * told it is stranded and why, once. The `stranded` event is the notice, which
 * plan D delivers; `stranded_notified_at` records that it went out, and a claim
 * clears it.
 *
 * Only while the task's latest event is the skip that found nobody to give it to,
 * written at or before `cutoff`: anything since -- a claim, a comment, a new
 * assignee -- means it has not been sitting unclaimable all that time.
 */
export function noteStranded(
  db: Db,
  taskId: string,
  reason: string,
  cutoff: number,
  now: number,
): Result<{ written: boolean }> {
  return tx(db, (d) => {
    const task = getTask(d, taskId);
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    if (task.strandedNotifiedAt !== null || (task.phase !== 'open' && task.phase !== 'review')) {
      return { ok: true, written: false };
    }
    const last = d
      .prepare<[string], { kind: string; created_at: number }>(
        'SELECT kind, created_at FROM kanban_events WHERE task_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(taskId);
    if (last?.kind !== 'skipped_unassignable' || last.created_at > cutoff) return { ok: true, written: false };
    d.prepare('UPDATE kanban_tasks SET stranded_notified_at = ? WHERE task_id = ?').run(now, taskId);
    record(d, { taskId, kind: 'stranded', actor: 'gateway', payload: { reason } }, now);
    return { ok: true, written: true };
  });
}

/**
 * What became of a person's card (spec §9.2): sent, as this message, in the
 * task's thread or by direct message as Lark's answer said (spec §19.2), or
 * refused for good by the channel.
 */
export type CardOutcome = { messageId: string; in: 'thread' | 'dm' } | { error: string };

/**
 * Record that a person's run was sent its card, or that the channel refused it
 * (spec §9.2): `card_sent`, or `card_failed`, which its subscribers hear. Once
 * per run, while it is open: a run that has either is not sent another.
 */
export function recordCard(db: Db, runId: string, card: CardOutcome, now: number): Result<{ recorded: boolean }> {
  return tx(db, (d) => {
    const run = getRun(d, runId);
    if (run === undefined) return refuse('not_found', `no run ${runId}`);
    if (run.agentConfig !== null) return refuse('invalid', `run ${runId} is an agent's, and gets no card`);
    if (run.endedAt !== null) return { ok: true, recorded: false };
    const had = d
      .prepare<[string, string], { id: number }>(
        "SELECT id FROM kanban_events WHERE task_id = ? AND run_id = ? AND kind IN ('card_sent', 'card_failed') LIMIT 1",
      )
      .get(run.taskId, runId);
    if (had !== undefined) return { ok: true, recorded: false };
    const base = { kind: run.kind, to: run.assignee.name };
    record(
      d,
      'messageId' in card
        ? { taskId: run.taskId, runId, kind: 'card_sent', actor: 'gateway', payload: { ...base, messageId: card.messageId, in: card.in } }
        : { taskId: run.taskId, runId, kind: 'card_failed', actor: 'gateway', payload: { ...base, error: card.error } },
      now,
    );
    return { ok: true, recorded: true };
  });
}

/**
 * Count a prompt sent into an agent run's session (spec §3.3): the task prompt,
 * and from plan C3 each nudge or forwarded comment. Returns the count before this
 * one, which keys the submission as `kanban:<run_id>:<n>` (spec §7.5): the actor
 * deduplicates turns on that key, so each prompt needs its own.
 */
export function countSubmission(db: Db, runId: string, now: number): Result<{ n: number }> {
  return tx(db, (d) => {
    const run = getRun(d, runId);
    if (run === undefined) return refuse('not_found', `no run ${runId}`);
    if (run.endedAt !== null) return refuse('already_closed', `run ${runId} is closed`);
    if (run.agentConfig === null) return refuse('invalid', `run ${runId} is a person's, and has no session to prompt`);
    d.prepare('UPDATE kanban_runs SET submissions = submissions + 1 WHERE run_id = ?').run(runId);
    record(d, { taskId: run.taskId, runId, kind: 'submitted', actor: 'gateway', payload: { n: run.submissions } }, now);
    return { ok: true, n: run.submissions };
  });
}
