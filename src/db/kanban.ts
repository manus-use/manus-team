import type { Db } from './open.js';
import { isBusy, txImmediate } from './open.js';
import { newRunId, newTaskId, newWorkflowId } from '../core/ids.js';
import { isResumableProviderId } from '../provider-id.js';
import { NAME_PATTERN, RESERVED_BOARD_NAMES, visible } from '../names.js';
import { redactKnownSecrets, redactValues } from '../secrets.js';
import { canonicalDag, maskDag, type Dag } from '../kanban/dag.js';
import { decide as decideRouting, fillText, handlerParagraph, INSTANCE_CAP, maskPlan, outputsText, resultOf, SKIPPED_TEXT, standInContract, triggerWords, valueSaid, type Decision, type Facts, type Plan, type PlanStep, type RouteFact, type StepFact, type Template } from '../kanban/routing.js';
import type { GateRun } from '../kanban/gates.js';
import { placeName, placeOf, resolveTaskWorkspace } from '../kanban/workspace.js';
import { worktreeId, worktreeOf } from './workspaces.js';
import { DEFAULT_BOARD, ENDED_OUTCOMES, GATE_LIMITS, REPORTED_OUTCOMES } from '../kanban/types.js';
import { cutToBytes, WORKER_LIMITS } from '../kanban/limits.js';
import { assignable, checkTask, isRecord, type TaskFacts } from '../kanban/task-checks.js';
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
  DeferredKey,
  DeferredState,
  DeferredWhy,
  EndedOutcome,
  Follow,
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
  SubscriptionRow,
  TaskRow,
  WakeRow,
} from '../kanban/types.js';
import {
  getBoard,
  getInstance,
  getRun,
  getTask,
  getTaskByKey,
  gatesOf,
  firstEventOf,
  latestBlockOf,
  latestCompletion,
  routesOf,
  pendingOf,
  plannedMemberOf,
  settledOf,
  triggersOf,
  hasRouting,
  hasWakeColumns,
  instanceByKey,
  membersWithTasks,
  memberOf,
  isFinished,
  membersOf,
  openAgentRunIn,
  openRunOf,
  parentsOf,
  runsOf,
  subscriptionsOf,
  getSubscription,
  getWake,
  wakeByUuid,
  CHATLESS,
  wakeEventsOf,
  type InstanceRow,
  type KeyedInstance,
  type MemberRow,
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

/** Why a routed start is refused on a database the gateway has not yet migrated (workflow routing spec §8). */
export const ROUTING_NOT_MIGRATED = 'the database is not yet migrated to version 15: start the gateway once, so it is migrated';

/** Why a wake is refused on a database the gateway has not yet migrated (wake spec §4.1). */
const NOT_MIGRATED = 'the database is not yet migrated to version 13: start the gateway once, so it is migrated';

/**
 * A refusal for a new task given a wake, or a depth, on a database not yet at
 * version 13, which has no column to hold it. A run's follow-up inherits its
 * creating task's, always off at depth 0 there, so it is never refused.
 */
function unmigratedWake(d: Db, wake: NewWake | undefined, via: CreatedVia): Refusal | undefined {
  if (via.kind === 'run' || wake === undefined || (wake.by === null && wake.depth === 0) || hasWakeColumns(d)) return undefined;
  return refuse('invalid', NOT_MIGRATED);
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
  // A workflow's instance, its name, and a member's ref and step (workflows spec §8); its item is a param's text, and masked.
  'workflow',
  'workflowName',
  'ref',
  'step',
  // A wake's setter, a principal, and the role it targets (wake spec §4.4, §19.1).
  'as',
  'role',
  // The task an inherited wake came from (wake spec §9.1).
  'from',
  // The task a handler was routed from, and a stand-in that archived the task it stood in for (workflow routing spec §7.4, §5.2).
  'routedFrom',
  'standIn',
]);

/** One row of the board's log, masked value by value. */
function record(
  d: Db,
  e: { taskId: string; runId?: string | null; kind: string; actor: string; payload: Record<string, unknown> },
  now: number,
): number {
  const { lastInsertRowid } = d
    .prepare(
      `INSERT INTO kanban_events (task_id, run_id, kind, actor, payload, created_at)
       VALUES (?, ?, ?, ?, jsonb(?), ?)`,
    )
    .run(e.taskId, e.runId ?? null, e.kind, e.actor, JSON.stringify(redactValues(e.payload, BOARD_KEYS)), now);
  return Number(lastInsertRowid);
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
  /** The chat a terminal named to follow it (kanban spec §22.1), checked by the service. */
  follow?: Follow;
  /** Its wake and its depth (wake spec §3.1, §9.1); wake off at depth 0 unless given. A run's follow-up inherits its creating task's instead. */
  wake?: NewWake;
}

/**
 * A new task's wake (wake spec §3.1, §3.4, §9.1): `by`, the principal its woken
 * turns run as, or null for wake off; `depth`, the woken turns in its making,
 * kept whether or not it has a wake; and `tooDeep`, set by the service when a
 * wake was asked at a depth of `kanban.wake.max_depth` or more, which makes it
 * with wake off and records why. `role`, with `by` set, names the role the
 * wake targets (wake spec §19.1): its outcomes make a reaction task for that
 * role, not a turn of the chat session; absent, the chat session.
 */
export interface NewWake {
  by: string | null;
  depth: number;
  tooDeep?: boolean;
  role?: string;
}

/**
 * Create a task, linked to its parents, in one transaction.
 *
 * A task with a `follow` gets one more event, after `created`:
 * `task_created_followed`, the "Created" line the notifier posts to that chat,
 * as a terminal has no Lark client to post it (kanban spec §22.1). A
 * workflow's members never get one: their instance's `workflow_started` names
 * them all.
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
    const unmigrated = unmigratedWake(d, t.wake, t.createdVia);
    if (unmigrated !== undefined) return unmigrated;
    const taskId = insertTask(d, { ...t, board, createdFromTask, parents }, now);
    if (t.follow !== undefined) record(d, { taskId, kind: 'task_created_followed', actor: t.createdBy, payload: { by: t.createdBy } }, now);
    return { ok: true, task: mustGet(d, taskId), existing: false };
  });
}

/** A task as `insertTask` writes it: its board and its creating task worked out, its parents checked. */
interface TaskInsert extends NewTask {
  board: string;
  createdFromTask: string | null;
  parents: readonly string[];
  /** A reaction task's (wake spec §19.3): its id, chosen first, and the wake that makes it. */
  reaction?: { taskId: string; wakeId: number };
  /**
   * Its subscriptions, copied as they are: a reaction task's one, from its batch's
   * conversation's (wake spec §19.3); a task a workflow's plan made late, its
   * instance's first member's (workflow routing spec §7.4). Given, they are the
   * task's only subscriptions.
   */
  copySubscriptions?: readonly SubscriptionRow[];
}

/**
 * The insert every task is made by, `createTask`'s and a workflow's alike (workflows spec
 * §8): the row, its links, its subscriptions and its `created` event, whose
 * payload gains `payload`'s keys. Inside the caller's transaction, which has
 * checked everything; answers the new task's id.
 */
function insertTask(d: Db, t: TaskInsert, now: number, payload: Record<string, unknown> = {}): string {
  const { board, createdFromTask, parents } = t;
  const taskId = t.reaction?.taskId ?? newTaskId();
  const wake = wakeOfInsert(d, t);
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
  if (wake.by !== null || wake.depth !== 0) {
    if (!hasWakeColumns(d)) throw new Error('the database is not yet migrated to version 13, so a task cannot be given a wake');
    d.prepare('UPDATE kanban_tasks SET wake_by = ?, wake_depth = ?, wake_role = ? WHERE task_id = ?').run(wake.by, wake.depth, wake.role, taskId);
  }
  // Made under a wake (wake spec §19.8): a reaction task is its own root; a run's
  // task of one passes its root on, workflow and DAG members of its start included.
  const root =
    t.reaction !== undefined
      ? taskId
      : t.createdVia.kind === 'run' && createdFromTask !== null
        ? mustGet(d, createdFromTask).wakeRoot
        : null;
  if (t.reaction !== undefined || root !== null) {
    d.prepare('UPDATE kanban_tasks SET reaction_of = ?, wake_root = ? WHERE task_id = ?').run(t.reaction?.wakeId ?? null, root, taskId);
  }
  const link = d.prepare('INSERT INTO kanban_links (parent_id, child_id, created_at) VALUES (?, ?, ?)');
  for (const parent of parents) link.run(parent, taskId, now);
  subscribe(d, taskId, t.createdVia, createdFromTask, now, t.follow, t.copySubscriptions);
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
        ...payload,
      },
    },
    now,
  );
  if (wake.event !== undefined) record(d, { taskId, kind: 'wake_set', actor: wake.event.actor, payload: wake.event.payload }, now);
  // The task's own cursor starts at its latest event whatever follows it (wake spec §19.16), so a task that reads
  // as chatless later, as when the bot's app id changes, replays none of its events: those it has now are no outcomes.
  if (wake.by !== null) setOwnWakeCursor(d, taskId);
  return taskId;
}

/** A task's own `wake_cursor` set to its latest event (wake spec §19.16): at a wake's insert, and at each `on`. */
function setOwnWakeCursor(d: Db, taskId: string): void {
  const latest = d.prepare<[string], { id: number }>('SELECT max(id) AS id FROM kanban_events WHERE task_id = ?').get(taskId)?.id ?? 0;
  d.prepare('UPDATE kanban_tasks SET wake_cursor = ? WHERE task_id = ?').run(latest, taskId);
}

/**
 * The wake a new task is made with (wake spec §3.1, §9.1): a run's follow-up
 * copies its creating task's `wake_by` and `wake_depth`, unchanged, whatever it
 * asked for, with an inherited `wake_set` when that task has wake on, by the run,
 * `from` the task; any other task takes the request's, its `wake_set` by its
 * creator, or the too-deep one with wake off (§3.4, §4.4). The role a wake
 * targets goes with its setter, copied with them, and named in the `wake_set`
 * as `role` (§19.1).
 */
function wakeOfInsert(
  d: Db,
  t: TaskInsert,
): { by: string | null; depth: number; role: string | null; event?: { actor: string; payload: Record<string, unknown> } } {
  if (t.createdVia.kind === 'run' && t.createdFromTask !== null) {
    const from = mustGet(d, t.createdFromTask);
    if (from.wakeBy === null) return { by: null, depth: from.wakeDepth, role: null };
    return {
      by: from.wakeBy,
      depth: from.wakeDepth,
      role: from.wakeRole,
      event: {
        actor: `run:${t.createdVia.runId}`,
        payload: { on: true, as: from.wakeBy, depth: from.wakeDepth, ...roleOf(from.wakeRole), from: from.taskId },
      },
    };
  }
  const w = t.wake;
  if (w === undefined) return { by: null, depth: 0, role: null };
  if (w.by === null) return { by: null, depth: w.depth, role: null };
  if (w.tooDeep === true) {
    return { by: null, depth: w.depth, role: null, event: { actor: t.createdBy, payload: { on: false, refused: 'too_deep', depth: w.depth } } };
  }
  const role = w.role ?? null;
  return { by: w.by, depth: w.depth, role, event: { actor: t.createdBy, payload: { on: true, as: w.by, depth: w.depth, ...roleOf(role) } } };
}

/** A `wake_set` payload's `role`, for a wake that targets one (wake spec §19.1). */
function roleOf(role: string | null): { role?: string } {
  return role === null ? {} : { role };
}

/**
 * The chats that follow a new task (spec §9.4, §7.3): the chat it was created
 * in; or, for a task a run created, every chat following the creating run's
 * task, so whoever follows that task hears about its follow-ups too, in its
 * thread, with its root (spec §19.4); or, for a terminal's, the chat it named,
 * `follow`, in Lark, for this bot (kanban spec §22.1). Each cursor starts at 0:
 * every event of the new task is newer than that, the waker's `wake_cursor`
 * too (wake spec §3.3). A root is written only with a
 * thread: at chat scope it comes from `threadSubscription` alone.
 *
 * Its chat's kind, `chat_type` (wake spec §2.1), is the command's for a chat's
 * task, copied for a run's follow-up, and null for a terminal's `--chat`, which
 * cannot ask Lark what it named. A database not yet migrated to 013 has no such
 * column, and the task is followed as before.
 */
function subscribe(
  d: Db,
  taskId: string,
  via: CreatedVia,
  createdFromTask: string | null,
  now: number,
  follow?: Follow,
  copy?: readonly SubscriptionRow[],
): void {
  const wake = hasWakeColumns(d);
  const insert = d.prepare(
    wake
      ? `INSERT OR IGNORE INTO kanban_subscriptions (task_id, channel, account_id, conversation_id, thread_id, root_message_id, created_at, chat_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      : `INSERT OR IGNORE INTO kanban_subscriptions (task_id, channel, account_id, conversation_id, thread_id, root_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const run = (channel: string, appId: string, chatId: string, threadId: string, root: string | null, chatType: string | null): void => {
    if (wake) insert.run(taskId, channel, appId, chatId, threadId, root, now, chatType);
    else insert.run(taskId, channel, appId, chatId, threadId, root, now);
  };
  if (follow !== undefined) {
    run('lark', follow.appId, follow.chatId, follow.threadId, follow.threadId === '' ? null : follow.rootId, null);
  }
  // A reaction task follows its batch's conversation, a copy of its subscription (wake spec §19.3); a late
  // member of a workflow, its instance's first member's, as they are now (workflow routing spec §7.4).
  if (copy !== undefined || via.kind === 'wake') {
    for (const c of copy ?? []) run(c.channel, c.appId, c.conversationId, c.threadId, c.rootMessageId, c.chatType);
    return;
  }
  if (via.kind === 'chat') {
    const root = via.threadId === '' || via.rootId === undefined || via.rootId === '' ? null : via.rootId;
    run(via.channel, via.appId, via.conversationId, via.threadId, root, via.chatType ?? null);
    return;
  }
  if (createdFromTask === null) return;
  for (const s of subscriptionsOf(d, createdFromTask)) {
    run(s.channel, s.appId, s.conversationId, s.threadId, s.rootMessageId, s.chatType);
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
 * Move the tasks' subscriptions at a chat into the thread their "Created" reply
 * opened (spec §19.4, workflows spec §9): each one's `thread_id` from '' to the thread's,
 * and its root to the command message, all in one transaction: one task for
 * `/kanban task new`, every member of an instance for a workflow's start. Only
 * a subscription of these tasks, at this chat, for this bot, still at chat
 * scope with no root, moves, so a second call changes nothing. Its cursor moves
 * with it: nothing already sent is sent again, and nothing pending is lost. It
 * writes no event, as a cursor's move writes none. Answers how many moved.
 */
export function threadSubscriptions(
  db: Db,
  taskIds: readonly string[],
  at: ChatAt,
  threadId: string,
  rootId: string,
): Result<{ moved: number }> {
  return tx(db, (d) => {
    if (threadId === '' || rootId === '') return refuse('invalid', 'a thread and its root are not empty');
    // OR IGNORE: a subscription of the task already in that thread is left as it is.
    const move = d.prepare(
      `UPDATE OR IGNORE kanban_subscriptions SET thread_id = ?, root_message_id = ?
        WHERE task_id = ? AND channel = ? AND account_id = ? AND conversation_id = ?
          AND thread_id = '' AND root_message_id IS NULL`,
    );
    let moved = 0;
    for (const taskId of new Set(taskIds)) {
      moved += move.run(threadId, rootId, taskId, at.channel, at.appId, at.conversationId).changes;
    }
    return { ok: true, moved };
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
    return insertGate(d, taskId, gate, by, now);
  });
}

/**
 * The insert every gate is added by, `addGate`'s and a workflow's alike (workflows spec
 * §8): GATE_LIMITS checked against the task's gates so far, inside the
 * caller's transaction, then the row and its `gate_added` event, whose payload
 * gains `payload`'s keys.
 */
function insertGate(
  d: Db,
  taskId: string,
  gate: { command: string; timeoutS: number },
  by: string,
  now: number,
  payload: Record<string, unknown> = {},
): Result<{ gate: GateRow }> {
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
    {
      taskId,
      kind: 'gate_added',
      actor: by,
      payload: { gateId: id, command: gate.command, timeoutS: gate.timeoutS, ...payload },
    },
    now,
  );
  return {
    ok: true,
    gate: { id, taskId, command: gate.command, timeoutS: gate.timeoutS, createdBy: by, createdAt: now },
  };
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
  team?: RouteTeam,
): Result<{ task: TaskRow; run: RunRow | undefined; superseded?: RunRow[] }> {
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
    const completed = record(
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
    // Done is a settling: what its plan's steps read may have changed (workflow routing spec §9.1).
    const superseded = routeAfter(d, taskId, 'completed', completed, now, team);
    return { ok: true, ...withSuperseded({ task: mustGet(d, taskId), run: r.run === undefined ? undefined : mustGetRun(d, r.run.runId) }, superseded) };
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
  team?: RouteTeam,
): Result<{ task: TaskRow; run: RunRow | undefined; superseded?: RunRow[] }> {
  return tx(db, (d) => {
    const r = reporting(d, taskId, by, ['open', 'review'], 'be blocked');
    let superseded: RunRow[] = [];
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
      const blocked = record(
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
      // A run's block from its work is a trigger (workflow routing spec §5.1); a person's, or a review's, routes nothing.
      if (by.kind === 'run' && r.task.phase === 'open') superseded = routeAfter(d, taskId, 'blocked', blocked, now, team);
    }
    return { ok: true, ...withSuperseded({ task: mustGet(d, taskId), run: r.run === undefined ? undefined : mustGetRun(d, r.run.runId) }, superseded) };
  });
}

/**
 * Return a blocked task to the phase it left (spec §5.4), optionally with a
 * comment the next run will read. The kind and reason are kept.
 *
 * Unblocking a `gave_up` task resets its failure count, and a `transient` one its
 * throttling count (spec §8.2): otherwise a person who fixed the cause would get
 * one attempt, or none, before the breaker tripped again.
 *
 * `wake`, for a woken turn's unblock (wake spec §9.3), is the wake's id, written
 * into the event's payload; `by` is then the wake's principal.
 */
export function unblock(
  db: Db,
  taskId: string,
  by: string,
  comment: string | undefined,
  now: number,
  opts: { blockedAt?: number; wake?: number; handler?: string } = {},
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
        // A handler's unblock is for the block it was routed from (workflow routing spec §5.4), not a button's.
        const whose = opts.handler === undefined ? 'this button was for' : `the handler ${opts.handler} was routed from`;
        return refuse('stale', `the block of task ${taskId} ${whose} has been lifted already`);
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
    // A woken turn's unblock names its wake, so the redraw says who lifted it truly (wake spec §9.3).
    record(d, { taskId, kind: 'unblocked', actor: by, payload: { kind: task.blockKind, ...(opts.wake === undefined ? {} : { wake: opts.wake }) } }, now);
    // An unblock is an operator's, so its comment steers the next run; a woken
    // turn's says it was the board's, on that person's authority (wake spec §9.4).
    if (comment !== undefined && comment !== '') {
      // A handler's says which, on the operator's file's authority (workflow routing spec §5.4).
      const prefix = opts.wake !== undefined ? '(woken by the board) ' : opts.handler !== undefined ? `(by the handler ${opts.handler}) ` : '';
      insertComment(d, taskId, by, `${prefix}${comment}`, now, true);
    }
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
 *
 * Given `runId`, the stop is for that run only (progress cards spec §8.2): a
 * task whose open run is another refuses `run_superseded`, inside the
 * transaction, so a press on an ended run's card never stops its retry.
 */
export function stop(db: Db, taskId: string, by: string, now: number, runId?: string): Result<{ task: TaskRow; run: RunRow }> {
  return tx(db, (d) => {
    const task = getTask(d, taskId);
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    const open = openRunOf(d, taskId);
    if (open === undefined) return refuse('no_open_run', `task ${taskId} has no open run to stop`);
    if (runId !== undefined && open.runId !== runId) {
      return refuse('run_superseded', `run ${runId} of task ${taskId} is over; its open run is ${open.runId}`);
    }
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
  team?: RouteTeam,
): Result<{ task: TaskRow; run: RunRow; next: NextStep; superseded?: RunRow[] }> {
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
    const ended = record(
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
    // A run's end that blocked the task from its work is a trigger (workflow routing spec §5.1).
    let superseded: RunRow[] = [];
    if (blockAs !== undefined && before.phase === 'open') {
      const cause: RouteCause = blockAs.kind === 'gave_up' ? 'gave_up' : blockAs.kind === 'transient' ? 'throttled' : 'blocked';
      superseded = routeAfter(d, run.taskId, cause, ended, now, team);
    }
    return { ok: true, ...withSuperseded({ task: mustGet(d, run.taskId), run: mustGetRun(d, runId), next }, superseded) };
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
  team?: RouteTeam,
): Result<{ task: TaskRow; run: RunRow | undefined; superseded?: RunRow[] }> {
  return tx(db, (d) => {
    const task = getTask(d, taskId);
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    if (task.phase === 'archived') return refuse('illegal_transition', `task ${taskId} is already archived`);
    const archived = archiveIn(d, task, by, now);
    // An archive settles: as done when it was done, or as skipped by archive (workflow routing spec §9.1).
    const superseded = routeAfter(d, taskId, 'archived', archived.eventId, now, team);
    return { ok: true, ...withSuperseded({ task: mustGet(d, taskId), run: archived.run }, superseded) };
  });
}

/**
 * The body every archive runs, `archive`'s and a workflow's alike (workflows spec §8),
 * inside the caller's transaction, on a task not yet archived: its open run
 * superseded if undecided, the task archived, keeping the time it was done, and
 * its `archived` event, whose payload gains `payload`'s keys.
 */
function archiveIn(
  d: Db,
  task: TaskRow,
  by: string,
  now: number,
  payload: Record<string, unknown> = {},
): { task: TaskRow; run: RunRow | undefined; eventId: number } {
  const run = supersede(d, openRunOf(d, task.taskId), now);
  d.prepare(
    `UPDATE kanban_tasks SET phase = 'archived', blocked_from = NULL, closed_at = coalesce(closed_at, ?)
      WHERE task_id = ?`,
  ).run(now, task.taskId);
  const eventId = record(
    d,
    { taskId: task.taskId, runId: run?.runId ?? null, kind: 'archived', actor: by, payload: { from: task.phase, ...payload } },
    now,
  );
  return { task: mustGet(d, task.taskId), run, eventId };
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

// ---------------------------------------------------------------------------
// Workflows (workflows spec §7, §8)
// ---------------------------------------------------------------------------

/** An instance to make: its name, its checked DAG and that DAG's hash, unmasked, and who makes it, how. */
export interface NewInstance {
  name: string | null;
  dag: Dag;
  sha256: string;
  source: 'start' | 'apply';
  /** The board it goes on; a run's goes on its task's, whatever this says. */
  board: string;
  createdBy: string;
  createdVia: CreatedVia;
  /** Namespaced as a task's (spec §3.1), or null for none. */
  idempotencyKey: string | null;
  /** The chat a terminal named to follow every member (workflows spec §18.1), beside the DAG, not in it. */
  follow?: Follow;
  /** Its plan (workflow routing spec §7.3), for a start of a file using a routing key; absent or null for none. */
  plan?: Plan | null;
}

/** The members a `workflow_started` payload lists: the start's reply lists at most 30 (workflows spec §9, §18.2). */
const STARTED_TASKS = 30;

/** One of the DAG's tasks, as the writer makes it: its fields, its member fields, its parents as earlier positions, and its gates. */
export interface NewMember {
  task: Pick<
    NewTask,
    'title' | 'body' | 'contract' | 'assignee' | 'reviewer' | 'workspace' | 'priority' | 'failureLimit' | 'retryOnCrash' | 'maxRuntimeS' | 'wake'
  >;
  ref: string;
  step: string;
  item: string | null;
  /** The positions of its parents, each earlier in the array than it. */
  parents: readonly number[];
  gates: readonly { command: string; timeoutS: number }[];
}

/** What an apply made, or found made with its key: the instance, and its members with their tasks, in position order. */
export interface AppliedDag {
  instance: InstanceRow;
  members: Array<MemberRow & { task: TaskRow }>;
  existing: boolean;
}

/**
 * Why a key's instance is not this start's or apply's (workflows spec §6 step 0), or
 * undefined when it is a repeat: another board's is `other_board`; another
 * kind's, another workflow's, or another DAG's, `invalid`, naming it.
 */
export function keyRefused(
  keyed: KeyedInstance,
  want: { board: string; source: 'start' | 'apply'; name: string | null; sha256?: string },
): Refusal | undefined {
  const existing = keyed.instance;
  const id = existing.instanceId;
  if (existing.board !== want.board) {
    return refuse('other_board', `instance ${id} was made with this idempotency key on board ${existing.board}, not ${want.board}`);
  }
  if (existing.source !== want.source) {
    return refuse(
      'invalid',
      `this idempotency key was used ${existing.source === 'start' ? 'to start a workflow' : 'to apply a DAG'}, as ${id}; ` +
        'a key used by a start is not used by an apply, nor the reverse',
    );
  }
  if (want.source === 'start' && existing.name !== want.name) {
    return refuse('invalid', `this idempotency key was used to start workflow ${existing.name ?? '(no workflow)'}, as ${id}, not ${want.name ?? '(no workflow)'}`);
  }
  if (want.source === 'apply' && want.sha256 !== undefined && keyed.dagSha256 !== want.sha256) {
    return refuse('invalid', `this idempotency key was used to apply another DAG, as ${id}`);
  }
  return undefined;
}

/**
 * Make a checked DAG on the board, in one transaction (workflows spec §8): the board
 * worked out (a run's task's for a run), the key looked up again, the guard
 * against two racing, the board checked live; then the instance with its DAG,
 * masked but for its gates; then each task through `insertTask`, with its
 * subscriptions and its `created` event carrying the instance, its links, its
 * gates through `insertGate`, and its member row. A refusal, or a member's
 * repeated ref, rolls everything back: all of it is made, or none. With a
 * `follow`, every member's insert subscribes it, and one `workflow_started` on
 * the first member, after the member rows, holds the start's reply for the
 * notifier to post (workflows spec §18.2): the facts, not the text, which the
 * notifier makes, masked and worded as every notice is.
 */
export function applyDag(db: Db, instance: NewInstance, members: readonly NewMember[], now: number): Result<AppliedDag> {
  return tx(db, (d) => {
    let board = instance.board;
    let createdFromTask: string | null = null;
    if (instance.createdVia.kind === 'run') {
      const run = getRun(d, instance.createdVia.runId);
      if (run === undefined) return refuse('not_found', `no run ${instance.createdVia.runId}`);
      createdFromTask = run.taskId;
      // A run's work stays on its task's board (spec §16.5).
      board = mustGet(d, run.taskId).board;
    }
    if (instance.idempotencyKey !== null) {
      const keyed = instanceByKey(d, instance.idempotencyKey);
      if (keyed !== undefined) {
        const refused = keyRefused(keyed, { board, source: instance.source, name: instance.name, sha256: instance.sha256 });
        if (refused !== undefined) return refused;
        return { ok: true, instance: keyed.instance, members: membersWithTasks(d, keyed.instance.instanceId), existing: true };
      }
    }
    const live = liveBoard(d, board);
    if (!live.ok) return refuse(live.code, `${live.message}; nothing is added to it`);
    for (const m of members) {
      const unmigrated = unmigratedWake(d, m.task.wake, instance.createdVia);
      if (unmigrated !== undefined) return unmigrated;
    }
    const plan = instance.plan ?? null;
    if (plan !== null && !hasRouting(d)) return refuse('invalid', ROUTING_NOT_MIGRATED);
    const instanceId = newWorkflowId();
    d.prepare(
      `INSERT INTO kanban_workflow_instances
         (instance_id, name, dag, dag_sha256, source, board, created_by, created_via, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      instanceId,
      instance.name,
      canonicalDag(maskDag(instance.dag)),
      instance.sha256,
      instance.source,
      board,
      instance.createdBy,
      JSON.stringify(instance.createdVia),
      instance.idempotencyKey,
      now,
    );
    if (plan !== null) {
      // The plan, frozen, masked but for what decides and what runs; one waiting row a pending step, none a handler (workflow routing spec §7.2, §7.3).
      d.prepare('UPDATE kanban_workflow_instances SET plan = ? WHERE instance_id = ?').run(JSON.stringify(maskPlan(plan, mask)), instanceId);
      const waiting = d.prepare("INSERT INTO kanban_workflow_pending (instance_id, step, state) VALUES (?, ?, 'waiting')");
      for (const s of plan.steps) if (s.made === 'decide') waiting.run(instanceId, s.step);
    }
    const member = d.prepare(
      'INSERT INTO kanban_workflow_tasks (task_id, instance_id, ref, step, item, position) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const ids: string[] = [];
    for (const [position, m] of members.entries()) {
      const parents = m.parents.map((p) => {
        const id = ids[p];
        if (id === undefined) throw new Error(`member ${m.ref} names a parent at ${p}, which is not earlier`);
        return id;
      });
      const taskId = insertTask(
        d,
        {
          ...m.task,
          board,
          createdFromTask,
          parents,
          idempotencyKey: null,
          createdBy: instance.createdBy,
          createdVia: instance.createdVia,
          ...(instance.follow === undefined ? {} : { follow: instance.follow }),
        },
        now,
        { workflow: instanceId, workflowName: instance.name, ref: m.ref, step: m.step, item: m.item },
      );
      for (const gate of m.gates) {
        // The apply put it on the task, for whoever made the instance (workflows spec §8).
        const added = insertGate(d, taskId, gate, instance.createdBy, now, { workflow: instanceId });
        if (!added.ok) return refuse(added.code, `${m.ref}: ${added.message}`);
      }
      member.run(taskId, instanceId, m.ref, m.step, m.item === null ? null : mask(m.item), position);
      ids.push(taskId);
    }
    const first = ids[0];
    if (instance.follow !== undefined && first !== undefined) {
      const human = (a: Assignee | null | undefined): boolean => a?.kind === 'human';
      record(
        d,
        {
          taskId: first,
          kind: 'workflow_started',
          actor: instance.createdBy,
          payload: {
            workflow: instanceId,
            workflowName: instance.name,
            board,
            by: instance.createdBy,
            count: members.length,
            people: members.some((m) => human(m.task.assignee) || human(m.task.reviewer)),
            tasks: members.slice(0, STARTED_TASKS).map((m, i) => ({
              taskId: ids[i],
              title: m.task.title,
              assignee: m.task.assignee?.name ?? null,
              assigneeKind: m.task.assignee?.kind ?? null,
            })),
          },
        },
        now,
      );
    }
    const made = getInstance(d, instanceId);
    if (made === undefined) throw new Error(`instance ${instanceId} vanished inside its own transaction`);
    return { ok: true, instance: made, members: membersWithTasks(d, instanceId), existing: false };
  });
}

/**
 * Archive an instance (workflows spec §8, §10): every member not already archived,
 * in one transaction, through `archiveIn`, each `archived` event carrying the
 * instance; and, for one with a plan, every waiting step skipped, `the instance
 * was archived`, deciding nothing (workflow routing spec §9.1). Answers the
 * members it archived, and the runs it decided, whose turns the caller cancels;
 * none for an instance wholly archived already.
 */
export function archiveWorkflow(
  db: Db,
  instanceId: string,
  by: string,
  now: number,
): Result<{ instance: InstanceRow; archived: TaskRow[]; runs: RunRow[] }> {
  return tx(db, (d) => {
    const instance = getInstance(d, instanceId);
    if (instance === undefined) return refuse('not_found', `no workflow instance ${instanceId}`);
    const archived: TaskRow[] = [];
    const runs: RunRow[] = [];
    for (const m of membersOf(d, instanceId)) {
      const task = mustGet(d, m.taskId);
      if (task.phase === 'archived') continue;
      const r = archiveIn(d, task, by, now, { workflow: instanceId });
      archived.push(r.task);
      if (r.run !== undefined) runs.push(r.run);
    }
    // Cancelling a case (workflow routing spec §9.1): every waiting step skipped, without deciding, so nothing more is made.
    if (hasRouting(d)) {
      d.prepare(
        `UPDATE kanban_workflow_pending SET state = 'skipped', reason = ?, decided_at = ? WHERE instance_id = ? AND state = 'waiting'`,
      ).run(JSON.stringify({ by: 'instance', why: 'the instance was archived' }), now, instanceId);
    }
    return { ok: true, instance, archived, runs };
  });
}

/** A message of notices that carries Unblock buttons (spec §9.2, amended by the unblock redraw): what its redraw is rebuilt from. */
export interface UnblockMessage {
  /** The message, as the channel answered its send. */
  messageId: string;
  channel: string;
  appId: string;
  /** Its text as sent, masked. */
  markdown: string;
  /**
   * One for each button: the task, and the event that blocked it, which the
   * button's `event` names. `hasButton` false for a block the message told of
   * without its button, deferred by the waker (wake spec §5.9): recorded only so
   * the redraw can add its lifted line.
   */
  buttons: ReadonlyArray<{ taskId: string; blockEvent: number; hasButton?: boolean }>;
}

/**
 * Record the Unblock buttons a message of notices carries (spec §9.2, amended
 * by the unblock redraw), one row a button, in one transaction. A batch sent
 * again, which the channel answers with the same message, records nothing
 * more. It writes no event: the rows are the notifier's own, as its cursors are.
 */
export function recordUnblockButtons(db: Db, message: UnblockMessage, now: number): Result<{ recorded: number }> {
  return tx(db, (d) => {
    // `has_button` (migration 013) only where it exists: every row before it is a button.
    const withFlag = hasWakeColumns(d);
    if (!withFlag && message.buttons.some((b) => b.hasButton === false)) {
      return refuse('invalid', 'a notice with no button is recorded only on a database at version 13');
    }
    const insert = d.prepare(
      withFlag
        ? `INSERT INTO kanban_unblock_buttons (message_id, channel, app_id, task_id, block_event, markdown, sent_at, has_button)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (message_id, task_id) DO NOTHING`
        : `INSERT INTO kanban_unblock_buttons (message_id, channel, app_id, task_id, block_event, markdown, sent_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (message_id, task_id) DO NOTHING`,
    );
    let recorded = 0;
    for (const b of message.buttons) {
      const values = [message.messageId, message.channel, message.appId, b.taskId, b.blockEvent, mask(message.markdown), now];
      recorded += insert.run(...values, ...(withFlag ? [b.hasButton === false ? 0 : 1] : [])).changes;
    }
    return { ok: true, recorded };
  });
}

/**
 * A message's buttons have been redrawn for the `unblocked` or `archived` events given, by
 * task: each row's `redrawn_for` is written once, once the redraw landed, was
 * refused, or was given up on, and is never written again (spec §9.2, amended
 * by the unblock redraw).
 */
export function markUnblockRedrawn(db: Db, messageId: string, lifts: ReadonlyArray<{ taskId: string; liftEvent: number }>): Result<{ marked: number }> {
  return tx(db, (d) => {
    const update = d.prepare(
      'UPDATE kanban_unblock_buttons SET redrawn_for = ? WHERE message_id = ? AND task_id = ? AND redrawn_for IS NULL',
    );
    let marked = 0;
    for (const l of lifts) marked += update.run(l.liftEvent, messageId, l.taskId).changes;
    return { ok: true, marked };
  });
}

// ---------------------------------------------------------------------------
// Progress cards (progress cards spec §4)
// ---------------------------------------------------------------------------

/** A run found due a progress card: this bot, the channel it goes by, and the gateway's `kanban.failure_limit`. */
export interface ProgressCardOpening {
  runId: string;
  appId: string;
  channel: string;
  failureLimit: number;
}

/**
 * The row of a run due a progress card, written before its first send
 * (progress cards spec §4.1): "run N of M" read by the insert itself from the
 * task, N its `consecutive_failures` + 1 and M its `failure_limit` or the
 * gateway's, so the count is the database's at the insert. Only an open,
 * undecided run gets one, and only once.
 */
export function openProgressCard(db: Db, o: ProgressCardOpening, now: number): Result<{ opened: boolean }> {
  return tx(db, (d) => {
    const { changes } = d
      .prepare(
        `INSERT OR IGNORE INTO kanban_progress_cards (run_id, task_id, app_id, channel, try_number, try_limit, opened_at)
         SELECT r.run_id, r.task_id, ?, ?, t.consecutive_failures + 1, COALESCE(t.failure_limit, ?), ?
           FROM kanban_runs r JOIN kanban_tasks t ON t.task_id = r.task_id
          WHERE r.run_id = ? AND r.ended_at IS NULL AND r.outcome IS NULL`,
      )
      .run(o.appId, o.channel, o.failureLimit, now, o.runId);
    return { ok: true, opened: changes === 1 };
  });
}

/** A progress card's first send landed: its message, once, with what it showed and when. */
export function progressCardSent(db: Db, runId: string, messageId: string, readSeq: number, now: number): Result<{ changed: boolean }> {
  return tx(db, (d) => {
    const { changes } = d
      .prepare(
        `UPDATE kanban_progress_cards SET message_id = ?, read_seq = ?, drawn_at = ?, failures = 0
          WHERE run_id = ? AND state = 'open' AND message_id IS NULL`,
      )
      .run(messageId, readSeq, now, runId);
    return { ok: true, changed: changes === 1 };
  });
}

/** An update of a progress card landed. */
export function progressCardDrawn(db: Db, runId: string, readSeq: number, now: number): Result<{ changed: boolean }> {
  return tx(db, (d) => {
    const { changes } = d
      .prepare(
        `UPDATE kanban_progress_cards SET read_seq = ?, drawn_at = ?, failures = 0
          WHERE run_id = ? AND state = 'open' AND message_id IS NOT NULL`,
      )
      .run(readSeq, now, runId);
    return { ok: true, changed: changes === 1 };
  });
}

/** Lark refused a progress card's send or update: one more in a row. Answers the count, 0 for a row not open. */
export function progressCardRefused(db: Db, runId: string): Result<{ failures: number }> {
  return tx(db, (d) => {
    d.prepare("UPDATE kanban_progress_cards SET failures = failures + 1 WHERE run_id = ? AND state = 'open'").run(runId);
    const row = d
      .prepare<[string], { failures: number }>("SELECT failures FROM kanban_progress_cards WHERE run_id = ? AND state = 'open'")
      .get(runId);
    return { ok: true, failures: row?.failures ?? 0 };
  });
}

/** A progress card drawn final: `open` to `final`, once. */
export function progressCardFinal(db: Db, runId: string, readSeq: number, now: number): Result<{ changed: boolean }> {
  return tx(db, (d) => {
    const { changes } = d
      .prepare("UPDATE kanban_progress_cards SET state = 'final', read_seq = ?, drawn_at = ?, failures = 0 WHERE run_id = ? AND state = 'open'")
      .run(readSeq, now, runId);
    return { ok: true, changed: changes === 1 };
  });
}

/** A progress card let go of: `open` to `let_go`, once. */
export function progressCardLetGo(db: Db, runId: string): Result<{ changed: boolean }> {
  return tx(db, (d) => {
    const { changes } = d.prepare("UPDATE kanban_progress_cards SET state = 'let_go' WHERE run_id = ? AND state = 'open'").run(runId);
    return { ok: true, changed: changes === 1 };
  });
}

// ---------------------------------------------------------------------------
// Wakes (wake spec §3, §4)
// ---------------------------------------------------------------------------

/**
 * A wake turned on, as `as`, refused as too deep at `maxDepth` or more, for the
 * chat session or, with `role`, for that role (wake spec §19.1); or turned off
 * (wake spec §3.1, §3.4).
 */
export type WakeChange = { on: true; as: string; maxDepth: number; role?: string } | { on: false };

/**
 * Turn a task's wake on or off (wake spec §3.1, §3.3), with its `wake_set`
 * event by `by`, the setter, in one transaction.
 *
 * On sets `wake_by` to `as`, replacing another setter, and moves the cursor of
 * each of the task's subscriptions of this bot to the `wake_set` itself, the
 * task's latest event, so no older outcome is replayed. The same setter again
 * changes nothing and writes nothing (`changed` false: "already on"). A task no
 * chat of this bot follows cannot be woken, and is refused; a task whose depth
 * is `maxDepth` or more is left as it is, with the too-deep `wake_set`, its note
 * (`tooDeep`, §3.4); one already on there, `max_depth` lowered since, keeps its
 * wake and records nothing (`kept`, §5.4). Off clears `wake_by`, needs no chat, and leaves the cursor
 * where it is: the waker reads only tasks with wake on, and a later on sets it
 * again. Off on a task with wake off changes nothing.
 *
 * On names the wake's target (wake spec §19.1): `wake_role` is the role, or null
 * for the chat session, written with `wake_by` and cleared with it by off; a
 * switch of target with the same setter is a change, its `wake_set` naming the
 * `role`. A reaction task's wake is never set: it never wakes anyone (§19.3).
 */
export function setWake(
  db: Db,
  taskId: string,
  change: WakeChange,
  by: string,
  appId: string,
  now: number,
): Result<{ task: TaskRow; changed: boolean; tooDeep: boolean; kept: boolean }> {
  return tx(db, (d) => {
    const task = getTask(d, taskId);
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    if (task.reactionOf !== null) return refuse('invalid', `\`${taskId}\` is a reaction task, which never wakes anyone`);
    if (!change.on) {
      if (task.wakeBy === null) return { ok: true, task, changed: false, tooDeep: false, kept: false };
      d.prepare('UPDATE kanban_tasks SET wake_by = NULL, wake_role = NULL WHERE task_id = ?').run(taskId);
      record(d, { taskId, kind: 'wake_set', actor: by, payload: { on: false } }, now);
      return { ok: true, task: mustGet(d, taskId), changed: true, tooDeep: false, kept: false };
    }
    if (!hasWakeColumns(d)) return refuse('invalid', NOT_MIGRATED);
    const subs = subscriptionsOf(d, taskId).filter((s) => s.appId === appId);
    const role = change.role ?? null;
    // A role's wake needs no chat: it is read through the task's own cursor (wake spec §19.16).
    if (subs.length === 0 && role === null) {
      return refuse('invalid', `a wake needs a chat that follows the task, and no chat follows ${taskId}: a chat is chosen when a task is made`);
    }
    if (task.wakeBy === change.as && task.wakeRole === role) return { ok: true, task, changed: false, tooDeep: false, kept: false };
    if (task.wakeDepth >= change.maxDepth) {
      // A wake already set stays as it is, though max_depth was lowered since (wake spec §5.4): nothing is recorded.
      if (task.wakeBy !== null) return { ok: true, task, changed: false, tooDeep: true, kept: true };
      record(d, { taskId, kind: 'wake_set', actor: by, payload: { on: false, refused: 'too_deep', depth: task.wakeDepth } }, now);
      return { ok: true, task: mustGet(d, taskId), changed: false, tooDeep: true, kept: false };
    }
    d.prepare('UPDATE kanban_tasks SET wake_by = ?, wake_role = ? WHERE task_id = ?').run(change.as, role, taskId);
    record(d, { taskId, kind: 'wake_set', actor: by, payload: { on: true, as: change.as, depth: task.wakeDepth, ...roleOf(role) } }, now);
    const latest = d.prepare<[string], { id: number }>('SELECT max(id) AS id FROM kanban_events WHERE task_id = ?').get(taskId)?.id ?? 0;
    const move = d.prepare('UPDATE kanban_subscriptions SET wake_cursor = ? WHERE id = ?');
    for (const s of subs) move.run(latest, s.id);
    // The task's own cursor too, whatever chat follows it, so it never replays once it reads as chatless (§19.16).
    setOwnWakeCursor(d, taskId);
    return { ok: true, task: mustGet(d, taskId), changed: true, tooDeep: false, kept: false };
  });
}

/** A batch of outcomes to wake a conversation with, as the waker formed it (wake spec §4.2, §5.2). */
export interface NewWakeBatch {
  /** `wakeBatchUuid` of its (subscription, event) pairs. */
  uuid: string;
  channel: string;
  appId: string;
  conversationId: string;
  threadId: string;
  /** `lark:<union_id>`: the turn runs as them. */
  principal: string;
  /** The highest `wake_depth` of its tasks. */
  depth: number;
  events: ReadonlyArray<{ subscriptionId: number; eventId: number; taskId: string }>;
}

/** A wake's error: masked, cut at 500 (wake spec §4.2). */
function wakeError(error: string): string {
  return mask(error).slice(0, 500);
}

/**
 * Each subscription a wake covers, moved past the last of its events in the
 * wake, forward only (wake spec §4.3): all of them, or only `tasks`' events.
 */
function moveWakeCursors(d: Db, wakeId: number, tasks?: readonly string[]): void {
  const only = tasks === undefined ? undefined : new Set(tasks);
  const last = new Map<number, number>();
  for (const e of wakeEventsOf(d, wakeId)) {
    if (only !== undefined && !only.has(e.taskId)) continue;
    last.set(e.subscriptionId, Math.max(last.get(e.subscriptionId) ?? 0, e.eventId));
  }
  const move = d.prepare('UPDATE kanban_subscriptions SET wake_cursor = ? WHERE id = ? AND wake_cursor < ?');
  for (const [sub, eventId] of last) if (sub !== CHATLESS) move.run(eventId, sub, eventId);
  // A role's wake with no chat (wake spec §19.16): its events are of no subscription, and its tasks' own cursors move.
  const own = d.prepare('UPDATE kanban_tasks SET wake_cursor = ? WHERE task_id = ? AND wake_cursor < ?');
  const lastOfTask = new Map<string, number>();
  for (const e of wakeEventsOf(d, wakeId)) {
    if (e.subscriptionId !== CHATLESS || (only !== undefined && !only.has(e.taskId))) continue;
    lastOfTask.set(e.taskId, Math.max(lastOfTask.get(e.taskId) ?? 0, e.eventId));
  }
  for (const [taskId, eventId] of lastOfTask) own.run(eventId, taskId, eventId);
}


/**
 * Record a batch as one woken turn, `pending` at attempt 1, with its events, in
 * one transaction, before its marker and its first submit (wake spec §4.2,
 * §5.5 step 2): from here the batch is fixed. A uuid already recorded answers
 * that row and writes nothing, as a batch's uuid is its events'.
 */
export function recordWake(db: Db, batch: NewWakeBatch, now: number): Result<{ wake: WakeRow; existing: boolean }> {
  return tx(db, (d) => {
    if (batch.events.length === 0) return refuse('invalid', 'a wake covers at least one event');
    const existing = wakeByUuid(d, batch.uuid);
    if (existing !== undefined) return { ok: true, wake: existing, existing: true };
    const { lastInsertRowid } = d
      .prepare(
        `INSERT INTO kanban_wakes (uuid, channel, app_id, conversation_id, thread_id, principal, depth, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(batch.uuid, batch.channel, batch.appId, batch.conversationId, batch.threadId, batch.principal, batch.depth, now);
    const wakeId = Number(lastInsertRowid);
    const insert = d.prepare('INSERT OR IGNORE INTO kanban_wake_events (wake_id, subscription_id, event_id, task_id) VALUES (?, ?, ?, ?)');
    for (const e of batch.events) insert.run(wakeId, e.subscriptionId, e.eventId, e.taskId);
    const wake = getWake(d, wakeId);
    if (wake === undefined) throw new Error(`wake ${wakeId} vanished inside its own transaction`);
    return { ok: true, wake, existing: false };
  });
}

/** A role's batch, as the waker formed it (wake spec §19.3): the batch, the role, and the reaction task's words. */
export interface NewRoleWake extends NewWakeBatch {
  role: string;
  title: string;
  /** The prompt (wake spec §7, §19.5), masked. */
  body: string;
}

/** What `recordRoleWake` did: made its task, found it made, or skipped the wake, saying why. */
export type RoleWakeMade =
  | { wake: WakeRow; task: TaskRow; existing: boolean }
  | { skipped: 'board' | 'role' | 'turn' | 'subscription'; reason: string };

/**
 * A role's wake (wake spec §19.3): the `kanban_wakes` row, already `delivered`,
 * with its role and its reaction task, its events, every covered
 * subscription's `wake_cursor` moved, and the reaction task, made by
 * `insertTask` as `createTask` makes any, with its subscription, a copy of the
 * batch's conversation's, all in one transaction. It makes `createTask`'s
 * checks, none bypassed, in its order: the key `wake:<uuid>` first, whose task
 * answers a repeat and writes nothing; the board, by `liveBoard`, and the role,
 * by `assignable` as it is now, each a skip, with nothing written; the checked
 * fields, with the title and body cut to their limits, never refused for
 * length, any other refusal rolling everything back.
 *
 * The task is the batch's oldest event's task's: its board, and its
 * `created_from_task`, so the role's workspace is resolved from it; by the
 * setter, its wake off, its depth the batch's + 1, its `wake_root` its own id.
 */
export function recordRoleWake(db: Db, batch: NewRoleWake, facts: TaskFacts, now: number): Result<RoleWakeMade> {
  return tx(db, (d) => {
    if (batch.events.length === 0) return refuse('invalid', 'a wake covers at least one event');
    const key = `wake:${batch.uuid}`;
    // The repeat first, by its wake row: a uuid is its batch's, whichever target recorded it.
    const recorded = wakeByUuid(d, batch.uuid);
    if (recorded !== undefined) {
      // A uuid a chat turn recorded is that turn's batch: skipped, as waiting would never change it.
      if (recorded.reactionTask === null) {
        return { ok: true, skipped: 'turn', reason: `wake ${batch.uuid} is recorded already, as a turn of the chat session, and makes no reaction task` };
      }
      const made = getTaskByKey(d, key) ?? getTask(d, recorded.reactionTask);
      if (made === undefined) throw new Error(`wake ${batch.uuid} names reaction task ${recorded.reactionTask}, which is not on the board`);
      return { ok: true, wake: recorded, task: made, existing: true };
    }
    const oldest = [...batch.events].sort((a, b) => a.eventId - b.eventId)[0];
    if (oldest === undefined) return refuse('invalid', 'a wake covers at least one event');
    const source = mustGet(d, oldest.taskId);
    const live = liveBoard(d, source.board);
    if (!live.ok) return { ok: true, skipped: 'board', reason: live.message };
    const who = assignable(batch.role, facts);
    if (!who.ok) return { ok: true, skipped: 'role', reason: who.message };
    // A batch of a conversation follows its subscription: one gone is skipped, as no later try would find it. One of no chat has none (§19.16),
    // and subscription 0 stands for no chat only with no conversation: a conversation's batch naming it is refused.
    const chatless = oldest.subscriptionId === CHATLESS;
    if (chatless && (batch.conversationId !== '' || batch.threadId !== '')) {
      return refuse('invalid', `a batch of conversation ${batch.conversationId}/${batch.threadId} names no subscription`);
    }
    const sub = chatless ? undefined : getSubscription(d, oldest.subscriptionId);
    if (!chatless && sub === undefined) return { ok: true, skipped: 'subscription', reason: `no subscription ${oldest.subscriptionId} for the reaction task to follow` };
    const taskId = newTaskId();
    const { lastInsertRowid } = d
      .prepare(
        `INSERT INTO kanban_wakes (uuid, channel, app_id, conversation_id, thread_id, principal, depth, state, created_at, delivered_at,
                                   target_role, reaction_task)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?, ?, ?)`,
      )
      .run(batch.uuid, batch.channel, batch.appId, batch.conversationId, batch.threadId, batch.principal, batch.depth, now, now, batch.role, taskId);
    const wakeId = Number(lastInsertRowid);
    const insert = d.prepare('INSERT OR IGNORE INTO kanban_wake_events (wake_id, subscription_id, event_id, task_id) VALUES (?, ?, ?, ?)');
    for (const e of batch.events) insert.run(wakeId, e.subscriptionId, e.eventId, e.taskId);
    const createdVia: CreatedVia = { kind: 'wake', wakeId };
    const title = cutToBytes(batch.title, WORKER_LIMITS.title);
    const body = cutToBytes(batch.body, WORKER_LIMITS.body);
    const checked = checkTask({ title, body, assignee: batch.role, createdBy: batch.principal, createdVia }, facts);
    if (!checked.ok) return checked;
    insertTask(
      d,
      {
        title,
        body,
        contract: checked.contract,
        assignee: checked.assignee ?? null,
        idempotencyKey: key,
        createdBy: batch.principal,
        createdVia,
        board: source.board,
        createdFromTask: source.taskId,
        parents: [],
        wake: { by: null, depth: batch.depth + 1 },
        reaction: { taskId, wakeId },
        ...(sub === undefined ? {} : { copySubscriptions: [sub] }),
      },
      now,
    );
    moveWakeCursors(d, wakeId);
    const wake = getWake(d, wakeId);
    if (wake === undefined) throw new Error(`wake ${wakeId} vanished inside its own transaction`);
    return { ok: true, wake, task: mustGet(d, taskId), existing: false };
  });
}

/** Its marker sent, or tried (wake spec §5.5 step 3): `marker_at`, written once. */
export function wakeMarked(db: Db, wakeId: number, now: number): Result<{ marked: boolean }> {
  return tx(db, (d) => {
    if (getWake(d, wakeId) === undefined) return refuse('not_found', `no wake ${wakeId}`);
    const { changes } = d.prepare('UPDATE kanban_wakes SET marker_at = ? WHERE wake_id = ? AND marker_at IS NULL').run(now, wakeId);
    return { ok: true, marked: changes === 1 };
  });
}

/**
 * The current attempt submitted (wake spec §5.5 step 6): its session, its turn's
 * idempotency key and this process's boot, set together, on a pending row only.
 */
export function wakeSubmitted(db: Db, wakeId: number, sessionId: string, turnKey: string, boot: string): Result<{ submitted: boolean }> {
  return tx(db, (d) => {
    if (getWake(d, wakeId) === undefined) return refuse('not_found', `no wake ${wakeId}`);
    const { changes } = d
      .prepare("UPDATE kanban_wakes SET session_id = ?, turn_key = ?, submit_boot = ? WHERE wake_id = ? AND state = 'pending'")
      .run(sessionId, turnKey, boot, wakeId);
    return { ok: true, submitted: changes === 1 };
  });
}

/**
 * The current attempt refused (wake spec §5.6): one added to `attempt`, its
 * session, key and boot cleared together, and the reason kept, masked and cut,
 * in one transaction, on a pending row only, so the next attempt has a key of
 * its own and nothing names the refused one's turn. No cursor moves. Answers the
 * attempt the row is now on.
 */
export function wakeRefused(db: Db, wakeId: number, error: string): Result<{ refused: boolean; attempt: number }> {
  return tx(db, (d) => {
    const wake = getWake(d, wakeId);
    if (wake === undefined) return refuse('not_found', `no wake ${wakeId}`);
    const { changes } = d
      .prepare(
        `UPDATE kanban_wakes SET attempt = attempt + 1, session_id = NULL, turn_key = NULL, submit_boot = NULL, error = ?
          WHERE wake_id = ? AND state = 'pending'`,
      )
      .run(wakeError(error), wakeId);
    return { ok: true, refused: changes === 1, attempt: changes === 1 ? wake.attempt + 1 : wake.attempt };
  });
}

/**
 * Delivered (wake spec §5.5 step 9): the prompt reached the agent, or the turn
 * was found made. The row `delivered`, and each subscription it covers moved to
 * the last of its events in the batch, notices or not, in one transaction; on a
 * pending row only, so a late callback cannot undo a row another path settled.
 */
export function advanceWake(db: Db, wakeId: number, now: number): Result<{ delivered: boolean }> {
  return tx(db, (d) => {
    if (getWake(d, wakeId) === undefined) return refuse('not_found', `no wake ${wakeId}`);
    const { changes } = d
      .prepare("UPDATE kanban_wakes SET state = 'delivered', delivered_at = ? WHERE wake_id = ? AND state = 'pending'")
      .run(now, wakeId);
    if (changes === 1) moveWakeCursors(d, wakeId);
    return { ok: true, delivered: changes === 1 };
  });
}

/**
 * Dropped (wake spec §5.3a, §5.6): the row `dropped`, with why, and the cursors
 * moved past its events, in one transaction, on a pending row only: every
 * task's, or only `tasks`', whose wake was turned off or taken over, or which
 * left the board, so the others' outcomes are read again into a new batch.
 */
export function dropWake(db: Db, wakeId: number, error: string, now: number, opts: { tasks?: readonly string[] } = {}): Result<{ dropped: boolean }> {
  return tx(db, (d) => {
    if (getWake(d, wakeId) === undefined) return refuse('not_found', `no wake ${wakeId}`);
    const { changes } = d
      .prepare("UPDATE kanban_wakes SET state = 'dropped', closed_at = ?, error = ? WHERE wake_id = ? AND state = 'pending'")
      .run(now, wakeError(error), wakeId);
    if (changes === 1) moveWakeCursors(d, wakeId, opts.tasks);
    return { ok: true, dropped: changes === 1 };
  });
}

/**
 * Closed with every block in it lifted before its turn (wake spec §5.3b): the
 * row `lifted`, its cursors moved past its events, in one transaction, on a
 * pending row only.
 */
export function liftedWake(db: Db, wakeId: number, now: number): Result<{ lifted: boolean }> {
  return tx(db, (d) => {
    if (getWake(d, wakeId) === undefined) return refuse('not_found', `no wake ${wakeId}`);
    const { changes } = d
      .prepare("UPDATE kanban_wakes SET state = 'lifted', closed_at = ? WHERE wake_id = ? AND state = 'pending'")
      .run(now, wakeId);
    if (changes === 1) moveWakeCursors(d, wakeId);
    return { ok: true, lifted: changes === 1 };
  });
}

/**
 * A subscription's `wake_cursor` moved past events the waker passes over, with no
 * wake (wake spec §5.2 step 3): forward only, and no event, as the notifier's
 * cursor writes none.
 */
export function passWake(db: Db, subscriptionId: number, cursor: number): Result<{ advanced: boolean }> {
  return tx(db, (d) => {
    const found = d.prepare<[number], { id: number }>('SELECT id FROM kanban_subscriptions WHERE id = ?').get(subscriptionId);
    if (found === undefined) return refuse('not_found', `no subscription ${subscriptionId}`);
    const { changes } = d
      .prepare('UPDATE kanban_subscriptions SET wake_cursor = ? WHERE id = ? AND wake_cursor < ?')
      .run(cursor, subscriptionId, cursor);
    return { ok: true, advanced: changes === 1 };
  });
}

/**
 * Move a task's own wake cursor to an event the waker passed over (wake spec
 * §19.16): a role's wake with no chat, whose task has no subscription to hold
 * one. Forward only, writing no event, as `passWake`.
 */
export function passTaskWake(db: Db, taskId: string, cursor: number): Result<{ advanced: boolean }> {
  return tx(db, (d) => {
    if (getTask(d, taskId) === undefined) return refuse('not_found', `no task ${taskId}`);
    const { changes } = d.prepare('UPDATE kanban_tasks SET wake_cursor = ? WHERE task_id = ? AND wake_cursor < ?').run(cursor, taskId, cursor);
    return { ok: true, advanced: changes === 1 };
  });
}

// ---------------------------------------------------------------------------
// Deferred Unblock buttons (wake spec §5.9)
// ---------------------------------------------------------------------------

/**
 * A block's Unblock button deferred for the agent's try (wake spec §5.9):
 * written `held`, at most once a subscription and block event (`INSERT OR
 * IGNORE`), by the notifier once a notice it rendered without that button has
 * been sent, as a card or as text, `heldAt` the send's time, `noticeId` that
 * notice's message id, null when it went as text: the notice that is redrawn
 * once the button's card is sent, a task followed in two threads having one a
 * thread. A batch sent again finds the row already there, and the first stands.
 * Writes no event: the row is the waker's own, as a cursor is the notifier's.
 */
export function deferButton(db: Db, key: DeferredKey, heldAt: number, noticeId: string | null = null): Result<{ deferred: boolean }> {
  return tx(db, (d) => {
    const sub = d
      .prepare<[number], { task_id: string; account_id: string }>('SELECT task_id, account_id FROM kanban_subscriptions WHERE id = ?')
      .get(key.subscriptionId);
    if (sub === undefined) return refuse('not_found', `no subscription ${key.subscriptionId}`);
    const event = d.prepare<[number], { task_id: string }>('SELECT task_id FROM kanban_events WHERE id = ?').get(key.eventId);
    if (event === undefined || event.task_id !== sub.task_id) {
      return refuse('invalid', `event ${key.eventId} is not of task ${sub.task_id}, which subscription ${key.subscriptionId} follows`);
    }
    const { changes } = d
      .prepare(
        `INSERT OR IGNORE INTO kanban_deferred_buttons (subscription_id, event_id, task_id, app_id, held_at, notice_id, state)
         VALUES (?, ?, ?, ?, ?, ?, 'held')`,
      )
      .run(key.subscriptionId, key.eventId, sub.task_id, sub.account_id, heldAt, noticeId);
    return { ok: true, deferred: changes === 1 };
  });
}

/** One move of a deferred button, only from the states named: answers whether it moved. */
function moveButton(db: Db, key: DeferredKey, from: readonly DeferredState[], set: string, values: readonly unknown[]): Result<{ changed: boolean }> {
  return tx(db, (d) => {
    const { changes } = d
      .prepare(
        `UPDATE kanban_deferred_buttons SET ${set}
          WHERE subscription_id = ? AND event_id = ? AND state IN (${from.map(() => '?').join(', ')})`,
      )
      .run(...values, key.subscriptionId, key.eventId, ...from);
    return { ok: true, changed: changes === 1 };
  });
}

/** A held button made due, with why (wake spec §5.9): the agent has had its try, or will get none. */
export function buttonDue(db: Db, key: DeferredKey, why: DeferredWhy): Result<{ changed: boolean }> {
  return moveButton(db, key, ['held'], "state = 'due', why = ?", [why]);
}

/** A held or due button whose block was lifted, by any path, or whose task was archived: no card is owed. */
export function buttonLifted(db: Db, key: DeferredKey, now: number): Result<{ changed: boolean }> {
  return moveButton(db, key, ['held', 'due'], "state = 'lifted', ended_at = ?", [now]);
}

/** A due button's card sent, with its message id. */
export function buttonSent(db: Db, key: DeferredKey, messageId: string, now: number): Result<{ changed: boolean }> {
  return moveButton(db, key, ['due'], "state = 'sent', message_id = ?, ended_at = ?", [messageId, now]);
}

/** A held or due button given up: its task is gone, or its card could not be sent. */
export function buttonFailed(db: Db, key: DeferredKey, now: number): Result<{ changed: boolean }> {
  return moveButton(db, key, ['held', 'due'], "state = 'failed', ended_at = ?", [now]);
}

/** One more send of a due button's card tried; answers the attempts so far. An ended row is not counted. */
export function buttonTried(db: Db, key: DeferredKey): Result<{ attempts: number }> {
  return tx(db, (d) => {
    d.prepare(
      "UPDATE kanban_deferred_buttons SET attempts = attempts + 1 WHERE subscription_id = ? AND event_id = ? AND state IN ('held', 'due')",
    ).run(key.subscriptionId, key.eventId);
    const row = d
      .prepare<[number, number], { attempts: number }>('SELECT attempts FROM kanban_deferred_buttons WHERE subscription_id = ? AND event_id = ?')
      .get(key.subscriptionId, key.eventId);
    if (row === undefined) return refuse('not_found', `no deferred button for subscription ${key.subscriptionId} and event ${key.eventId}`);
    return { ok: true, attempts: row.attempts };
  });
}

// ---------------------------------------------------------------------------
// Workflow routing (workflow routing spec §9)
// ---------------------------------------------------------------------------

/** The team, as the service holds it, against which a task made late is checked (§7.4, §9.3); absent in the writer's own tests. */
export type RouteTeam = TaskFacts;

/** Which transition decided, for its notice (§12.2): a completion, a block, a give-up or the transient limit's block, an archive, or a reconciliation. */
export type RouteCause = 'completed' | 'blocked' | 'gave_up' | 'throttled' | 'archived' | 'reconciled';

/** One decision of a transaction, as `workflow_routed` lists it for its notice (§12.2). */
export interface RoutedLine {
  step: string;
  outcome: 'made' | 'skipped' | 'fanned_out' | 'routed' | 'over_limit' | 'over_cap' | 'stood_in' | 'unread';
  why: string;
  taskIds: string[];
  items?: string[];
  count?: number;
  by?: string;
  /** A route's handler, and whether it stands in. */
  handler?: string;
  standsIn?: boolean;
}

/** The most items a `workflow_routed` line names; its count says the rest (§12.2). */
const ROUTED_ITEMS = 20;

/** An instance with a plan, as the routing reads it in its transaction: the row, the plan, and its members with their tasks. */
interface Routed {
  instance: InstanceRow;
  plan: Plan;
  members: Array<MemberRow & { task: TaskRow }>;
}

/** A name a template gives, as the writer stores it: a person by their principal, else a role. */
function assigneeOf(name: string | null): Assignee | null {
  return name === null ? null : { kind: name.includes(':') ? 'human' : 'role', name };
}

/** A step's facts, read inside the transaction (§9.2 step 3): its rows, its tasks' trigger events, and its winner's accepted result. */
function routingFacts(d: Db, r: Routed): Facts {
  const settled = settledOf(d, r.instance.instanceId);
  const pending = new Map(pendingOf(d, r.instance.instanceId).map((p) => [p.step, p]));
  const steps = new Map<string, StepFact>();
  // Only a `state` clause reads what a step's tasks entered: the others' events are not read. Every member is read,
  // settled or not, as a state clause holds for a task that entered the state ever (§3.2).
  const stated = new Set(
    r.plan.steps.flatMap((s) => (s.when ?? []).flatMap((w) => ('any' in w ? w.any : [w])).flatMap((c) => ('state' in c ? [c.step] : []))),
  );
  for (const s of r.plan.steps) {
    const own = settled.find((x) => x.step === s.step && x.ref === s.step);
    const items = new Map(settled.filter((x) => x.step === s.step && x.ref !== s.step).map((x) => [x.ref, { how: x.how, taskId: x.taskId, eventId: x.eventId }]));
    const triggers = stated.has(s.step) ? r.members.filter((m) => m.step === s.step).flatMap((m) => triggersOf(d, m.taskId)) : [];
    const row = pending.get(s.step);
    const winner = own?.taskId ?? null;
    const metadata = winner === null || (own?.how !== 'done' && own?.how !== 'stood_in') ? undefined : latestCompletion(d, winner)?.metadata;
    steps.set(s.step, {
      step: s.step,
      row: row?.state ?? null,
      skippedBy: row?.reason?.by ?? null,
      settled: own === undefined ? null : { how: own.how, taskId: own.taskId, eventId: own.eventId },
      items,
      entered: { blocked: triggers.some((t) => t.kind === 'blocked'), gaveUp: triggers.some((t) => t.kind === 'gave_up') },
      result: isRecord(metadata) ? metadata : null,
    });
  }
  return { steps, due: dueRoutes(d, r), members: r.members.length, cap: INSTANCE_CAP };
}

/**
 * The routes due (§5.3): each member's task blocked now from its work by a trigger
 * event, its latest block, with no route row for that event yet; and how many
 * routes were made from it. A block lifted before its route was made routes
 * nothing, as the task is no longer blocked by it.
 */
function dueRoutes(d: Db, r: Routed): RouteFact[] {
  const routes = routesOf(d, r.instance.instanceId);
  const handlers = new Set(r.plan.steps.filter((s) => s.handler === true).map((s) => s.step));
  return r.members.flatMap((m): RouteFact[] => {
    if (handlers.has(m.step) || m.task.phase !== 'blocked' || m.task.blockedFrom !== 'open') return [];
    const latest = latestBlockOf(d, m.taskId);
    const t = triggersOf(d, m.taskId).find((x) => x.eventId === latest);
    if (t === undefined || routes.some((x) => x.fromTask === m.taskId && x.eventId === t.eventId)) return [];
    return [
      {
        taskId: m.taskId,
        step: m.step,
        ref: m.ref,
        item: m.item,
        eventId: t.eventId,
        kind: t.kind,
        throttled: t.throttled,
        blockKind: t.blockKind,
        reason: t.reason,
        routes: routes.filter((x) => x.fromTask === m.taskId && x.outcome === 'made').length,
      },
    ];
  });
}

/** Insert a settled row into its key (§8): a later attempt finds the key taken and changes nothing. True when it added the row. */
function settle(d: Db, instanceId: string, step: string, ref: string, how: string, taskId: string | null, eventId: number, now: number): boolean {
  return (
    d
      .prepare('INSERT OR IGNORE INTO kanban_workflow_settled (instance_id, step, ref, how, task_id, event_id, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(instanceId, step, ref, how, taskId, eventId, now).changes === 1
  );
}

/** What a sweep did beyond its rows (§5.2, §9.5): its lines, and the runs its stand-ins' archives superseded. */
interface Swept {
  lines: RoutedLine[];
  superseded: RunRow[];
}

/**
 * The sweep (§9.2 step 2): each member with a settling fact gets its settled row,
 * its winner the earliest fact by event id, among its own task's `completed`
 * event, each of its stand-ins' `completed` events, and its own `archived`
 * event when that archive was not from `done`; each fan-out whose items all have
 * rows, its own, `archived` when every item was archived undone. Plain steps
 * included; a handler's task is no step's member here. Only once a row is
 * written for a stand-in is the routed task archived, unless it is already, its
 * superseded run returned; and only when a row is written for the task's own
 * completion is each stand-in left open told its result will not be read.
 */
function sweep(d: Db, r: Routed, now: number): Swept {
  const id = r.instance.instanceId;
  const out: Swept = { lines: [], superseded: [] };
  const handlers = new Map(r.plan.steps.filter((s) => s.handler === true).map((s) => [s.step, s]));
  const routes = routesOf(d, id);
  const taken = new Set(settledOf(d, id).map((x) => `${x.step}\u0000${x.ref}`));
  for (const m of r.members) {
    if (handlers.has(m.step) || taken.has(`${m.step}\u0000${m.ref}`)) continue;
    const completed = firstEventOf(d, m.taskId, 'completed');
    const archived = firstEventOf(d, m.taskId, 'archived');
    const archive = archived !== undefined && isRecord(archived.payload) && archived.payload['from'] !== 'done' ? archived : undefined;
    // Its stand-ins: the handlers routed from its task that stand in for its step (§5.2).
    const standIns = routes.filter((x) => x.fromTask === m.taskId && x.outcome === 'made' && x.taskId !== null && handlers.get(x.handler)?.stands_in_for === m.step);
    const facts = [
      ...(completed === undefined ? [] : [{ how: 'done', taskId: m.taskId as string | null, eventId: completed.id, handler: undefined as string | undefined }]),
      ...(archive === undefined ? [] : [{ how: 'archived', taskId: null, eventId: archive.id, handler: undefined }]),
      ...standIns.flatMap((x) => {
        const done = firstEventOf(d, x.taskId as string, 'completed');
        return done === undefined ? [] : [{ how: 'stood_in', taskId: x.taskId, eventId: done.id, handler: x.handler }];
      }),
    ].sort((a, b) => a.eventId - b.eventId);
    const winner = facts[0];
    if (winner === undefined) continue;
    if (!settle(d, id, m.step, m.ref, winner.how, winner.taskId, winner.eventId, now)) continue;
    taken.add(`${m.step}\u0000${m.ref}`);
    if (winner.how === 'stood_in' && winner.taskId !== null) standingIn(d, r, m, winner.taskId, winner.handler ?? '', now, out);
    if (winner.how === 'done') {
      for (const x of standIns) {
        const left = getTask(d, x.taskId as string);
        if (left === undefined || left.phase === 'done' || left.phase === 'archived') continue;
        insertComment(d, left.taskId, 'gateway', `${m.step} was completed by its own task ${m.taskId}; this handler's result will not be read: finish or archive it`, now, false);
        out.lines.push({ step: m.step, outcome: 'unread', why: `${m.step} was completed by its own task`, taskIds: [left.taskId], handler: x.handler });
      }
    }
  }
  const pending = new Map(pendingOf(d, id).map((p) => [p.step, p]));
  for (const s of r.plan.steps) {
    if (s.for_each === undefined || taken.has(`${s.step}\u0000${s.step}`)) continue;
    if (s.made === 'decide' && pending.get(s.step)?.state !== 'made') continue;
    const items = settledOf(d, id).filter((x) => x.step === s.step && x.ref !== s.step);
    const all = r.members.filter((m) => m.step === s.step);
    if (all.length === 0 || items.length < all.length) continue;
    const how = items.every((x) => x.how === 'archived') ? 'archived' : 'done';
    settle(d, id, s.step, s.step, how, null, Math.max(...items.map((x) => x.eventId)), now);
  }
  return out;
}

/**
 * A stand-in won its member (§5.2): the routed task archived, unless it is
 * already, from whatever phase it is in, its undecided run superseded, the
 * archive naming the instance and the stand-in, with a comment that does not
 * steer; and the line saying it stood in, with its outputs.
 */
function standingIn(d: Db, r: Routed, m: MemberRow & { task: TaskRow }, standIn: string, handler: string, now: number, out: Swept): void {
  const ref = memberOf(d, standIn)?.ref ?? handler;
  const routed = mustGet(d, m.taskId);
  const outputs = r.plan.steps.find((s) => s.step === m.step)?.outputs ?? {};
  const metadata = latestCompletion(d, standIn)?.metadata;
  const said = outputsText(outputs, isRecord(metadata) ? metadata : null);
  out.lines.push({ step: m.step, outcome: 'stood_in', why: said, taskIds: [m.taskId], handler });
  if (routed.phase === 'archived') return;
  // Only a run the archive itself ended: one that had reported, and is finishing, is left to end its own turn.
  const undecided = openRunOf(d, routed.taskId)?.outcome === null;
  const archived = archiveIn(d, routed, 'gateway', now, { workflow: r.instance.instanceId, standIn });
  if (undecided && archived.run !== undefined) out.superseded.push(archived.run);
  insertComment(d, m.taskId, 'gateway', `Stood in for by ${ref} (${standIn}), whose result is read in ${m.step}'s place.`, now, false);
}

/** The text a template's reference to a result fills (§7.4): the step's accepted value, a list's items joined, or `(skipped)`. */
function filled(plan: Plan, facts: Facts, text: string, item?: string): string {
  return fillText(
    text,
    (step, output) => {
      // A step not settled at the making, as the ancestor a `when: { state: gave_up }` step is made on, has no
      // accepted value yet: it fills `(skipped)` too, and the text is never filled again once it settles.
      const value = resultOf(plan, facts, step, output);
      return value === undefined ? SKIPPED_TEXT : valueSaid(value);
    },
    item,
  );
}

/**
 * Make one task of a step late (§7.4), as the start would have: through
 * `insertTask`, its fields from its template, the references filled, its title
 * and body cut to their limits; the instance's creator and board, and a run's
 * start's `created_from_task`; its links to its effective parents; its first
 * member's subscriptions; its gates by the instance's creator; its member row
 * at the next position; and its `created` event with the instance. With the
 * team, a task whose assignee, reviewer or workspace no longer passes is made
 * and blocked at once, by the gateway, as `needs_input`.
 */
function makeLate(
  d: Db,
  r: Routed,
  facts: Facts,
  made: { step: string; ref: string; item: string | null; template: Template; parents: readonly string[]; payload?: Record<string, unknown>; paragraph?: string },
  now: number,
  team: RouteTeam | undefined,
): string {
  const t = made.template;
  const first = r.members[0];
  const title = cutToBytes(filled(r.plan, facts, t.title, made.item ?? undefined), WORKER_LIMITS.title);
  // A handler's paragraph is kept whole: only the file's part of its body is cut (§5.2).
  const after = made.paragraph === undefined ? '' : made.paragraph;
  const room = WORKER_LIMITS.body - (after === '' ? 0 : Buffer.byteLength(after) + (t.body === null ? 0 : 2));
  const own = t.body === null ? '' : cutToBytes(filled(r.plan, facts, t.body, made.item ?? undefined), room);
  const body = after === '' ? own : own === '' ? after : `${own}\n\n${after}`;
  const assignee = assigneeOf(t.assignee);
  const reviewer = assigneeOf(t.reviewer);
  const wake = t.wake === null ? undefined : { by: t.wake.by, depth: t.wake.depth, ...(t.wake.tooDeep === true ? { tooDeep: true } : {}), ...(t.wake.role === undefined ? {} : { role: t.wake.role }) };
  const taskId = insertTask(
    d,
    {
      title,
      ...(body === '' ? {} : { body }),
      contract: t.contract,
      assignee,
      reviewer,
      workspace: t.workspace,
      priority: t.priority,
      failureLimit: t.failure_limit,
      retryOnCrash: t.retry_on_crash,
      maxRuntimeS: t.max_runtime_s,
      idempotencyKey: null,
      createdBy: r.instance.createdBy,
      createdVia: r.instance.createdVia,
      board: r.instance.board,
      createdFromTask: first?.task.createdFromTask ?? null,
      parents: made.parents,
      copySubscriptions: first === undefined ? [] : subscriptionsOf(d, first.taskId),
      ...(wake === undefined ? {} : { wake }),
    },
    now,
    { workflow: r.instance.instanceId, workflowName: r.instance.name, ref: made.ref, step: made.step, item: made.item, ...made.payload },
  );
  for (const gate of t.gates) {
    const added = insertGate(d, taskId, { command: gate.command, timeoutS: gate.timeout_s }, r.instance.createdBy, now, { workflow: r.instance.instanceId });
    if (!added.ok) throw new Error(`${made.ref}: ${added.message}`);
  }
  const position = (d.prepare<[string], { p: number | null }>('SELECT max(position) AS p FROM kanban_workflow_tasks WHERE instance_id = ?').get(r.instance.instanceId)?.p ?? -1) + 1;
  d.prepare('INSERT INTO kanban_workflow_tasks (task_id, instance_id, ref, step, item, position) VALUES (?, ?, ?, ?, ?, ?)').run(
    taskId,
    r.instance.instanceId,
    made.ref,
    made.step,
    made.item === null ? null : mask(made.item),
    position,
  );
  if (team !== undefined) {
    const refused = lateRefused(t, title, r.instance, team);
    if (refused !== undefined) {
      const reason = `${refused}, so this step's task cannot be given to it: /kanban task assign ${taskId} <role>`;
      const recurrences = enterBlocked(d, mustGet(d, taskId), 'needs_input', reason);
      record(d, { taskId, kind: 'blocked', actor: 'gateway', payload: { kind: 'needs_input', reason, blockRecurrences: recurrences } }, now);
    }
  }
  return taskId;
}

/** Why a task made late no longer passes the team's checks (§7.4), or undefined: a role named not configured, said plainly, or `checkTask`'s words. */
function lateRefused(t: Template, title: string, instance: InstanceRow, team: RouteTeam): string | undefined {
  for (const name of [t.assignee, t.reviewer]) {
    if (name !== null && !name.includes(':') && !team.roles.has(name)) return `role ${name} is not configured`;
  }
  const checked = checkTask(
    {
      title,
      contract: t.contract,
      ...(t.assignee === null ? {} : { assignee: t.assignee }),
      ...(t.reviewer === null ? {} : { reviewer: t.reviewer }),
      ...(t.workspace === null ? {} : { workspace: t.workspace }),
      createdBy: instance.createdBy,
      createdVia: instance.createdVia,
    },
    team,
  );
  return checked.ok ? undefined : checked.message;
}

/** A step's templates, one an item of its list param, or its one. */
function templatesFor(s: PlanStep): Array<Template & { item: string | null }> {
  return s.templates ?? (s.template === undefined ? [] : [{ ...s.template, item: null }]);
}

/** A pending row moved from `waiting`, once (§9.2): false when another attempt decided it first, and then nothing is made. */
function decided(d: Db, instanceId: string, step: string, state: 'made' | 'skipped', reason: Record<string, unknown>, causeEvent: number | null, now: number, items?: unknown): boolean {
  const masked = Object.fromEntries(Object.entries(reason).map(([k, v]) => [k, typeof v === 'string' ? mask(v) : v]));
  return (
    d
      .prepare(
        `UPDATE kanban_workflow_pending SET state = ?, reason = ?, items = ?, cause_event = ?, decided_at = ?
          WHERE instance_id = ? AND step = ? AND state = 'waiting'`,
      )
      .run(state, JSON.stringify(masked), items === undefined ? null : JSON.stringify(items), causeEvent, now, instanceId, step).changes === 1
  );
}

/** One decision applied (§9.2 step 4); answers its line for the notice, or undefined for one that is none. */
function apply(d: Db, r: Routed, facts: Facts, dec: Decision, causeEvent: number | null, now: number, team: RouteTeam | undefined): RoutedLine | undefined {
  const id = r.instance.instanceId;
  const s = r.plan.steps.find((x) => x.step === dec.step);
  if (s === undefined) return undefined;
  if (dec.outcome === 'settled') {
    settle(d, id, dec.step, dec.step, dec.how, null, dec.eventId, now);
    return undefined;
  }
  if (dec.outcome === 'skipped') {
    return decided(d, id, dec.step, 'skipped', { by: dec.by, why: dec.why }, causeEvent, now) ? { step: dec.step, outcome: 'skipped', why: dec.why, taskIds: [], by: dec.by } : undefined;
  }
  if (dec.outcome === 'route' || dec.outcome === 'over_limit' || dec.outcome === 'over_cap') return route(d, r, facts, dec, now, team);
  if (dec.outcome !== 'made' && dec.outcome !== 'fanned_out') return undefined;
  // The instance's board, live: an archived one skips the step, never refusing the transition (§13.1).
  const live = liveBoard(d, r.instance.board);
  if (!live.ok) {
    const why = `board ${r.instance.board} is archived`;
    return decided(d, id, dec.step, 'skipped', { by: 'board', why }, causeEvent, now) ? { step: dec.step, outcome: 'skipped', why, taskIds: [], by: 'board' } : undefined;
  }
  const templates = templatesFor(s);
  if (dec.outcome === 'made') {
    if (!decided(d, id, dec.step, 'made', { why: dec.why }, causeEvent, now)) return undefined;
    const t = templates[0];
    if (t === undefined) return undefined;
    const taskId = makeLate(d, r, facts, { step: dec.step, ref: dec.step, item: null, template: t, parents: dec.parents }, now, team);
    return { step: dec.step, outcome: 'made', why: dec.why, taskIds: [taskId] };
  }
  const made = dec.items.map((item, n) => ({ item, ref: `${dec.step}:${n + 1}`, template: templates.find((t) => t.item === item) ?? templates[0] }));
  if (!decided(d, id, dec.step, 'made', { why: dec.why }, causeEvent, now)) return undefined;
  const taskIds = made.flatMap((m) =>
    m.template === undefined ? [] : [makeLate(d, r, facts, { step: dec.step, ref: m.ref, item: m.item, template: m.template, parents: dec.parents }, now, team)],
  );
  const marker = made.map((m, n) => ({ item: mask(m.item), taskId: taskIds[n], ref: m.ref }));
  d.prepare('UPDATE kanban_workflow_pending SET items = ? WHERE instance_id = ? AND step = ?').run(JSON.stringify(marker), id, dec.step);
  return { step: dec.step, outcome: 'fanned_out', why: dec.why, taskIds, items: dec.items.slice(0, ROUTED_ITEMS), count: dec.items.length };
}

/**
 * A route applied (§5.3): its row, keyed on the trigger event, so a replay makes
 * no second handler; for a route made, the handler's task, made as any late
 * task but with no link, its ref `<handler>:<n>`, its item the routed item's,
 * its body gaining its paragraph, in the routed task's fixed workspace when its
 * step and role name none, its `created` event naming the routed task. On a
 * board found archived nothing is made and no row written (§13.1): the board
 * takes no new task, and the routed task waits as with no route.
 */
function route(
  d: Db,
  r: Routed,
  facts: Facts,
  dec: Extract<Decision, { outcome: 'route' | 'over_limit' | 'over_cap' }>,
  now: number,
  team: RouteTeam | undefined,
): RoutedLine | undefined {
  const id = r.instance.instanceId;
  const from = dec.from;
  const taken = d.prepare('SELECT 1 FROM kanban_workflow_routes WHERE instance_id = ? AND handler = ? AND event_id = ?').get(id, dec.handler, from.eventId);
  if (taken !== undefined) return undefined;
  const routed = mustGet(d, from.taskId);
  const why = triggerWords(from, routed.consecutiveTransient);
  const row = d.prepare('INSERT INTO kanban_workflow_routes (instance_id, handler, event_id, from_task, outcome, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  if (dec.outcome !== 'route') {
    row.run(id, dec.handler, from.eventId, from.taskId, dec.outcome, null, now);
    return { step: from.step, outcome: dec.outcome, why, taskIds: [from.taskId], handler: dec.handler };
  }
  const hs = r.plan.steps.find((s) => s.step === dec.handler);
  const t = hs?.template;
  if (hs === undefined || t === undefined || !liveBoard(d, r.instance.board).ok) return undefined;
  const n = routesOf(d, id).filter((x) => x.handler === dec.handler && x.outcome === 'made').length + 1;
  // Where it works (§5.2): its step's, its role's, or else the routed task's, when that is fixed.
  const roleWorkspace = t.assignee === null || t.assignee.includes(':') ? undefined : team?.roles.get(t.assignee)?.workspace;
  const workspace = t.workspace ?? (roleWorkspace === undefined ? routed.workspace : null);
  // A stand-in takes its step's reviewer, gates and contract from the frozen plan, so its result is accepted as the step's would be (§5.2).
  const stood = dec.standsIn ? r.plan.steps.find((s) => s.step === from.step) : undefined;
  const theirs = stood === undefined ? undefined : (stood.templates?.find((x) => x.item === from.item) ?? stood.template);
  const fields =
    theirs === undefined
      ? { workspace }
      : { workspace, reviewer: theirs.reviewer, gates: [...theirs.gates, ...t.gates], contract: standInContract(from.step, theirs.contract, t.contract) };
  const paragraph = handlerParagraph({
    taskId: from.taskId,
    step: from.step,
    item: from.item,
    from,
    throttles: routed.consecutiveTransient,
    dir: routed.worktree === null ? undefined : worktreeOf(d, routed.worktree)?.rootPath,
    standsIn: dec.standsIn,
  });
  const taskId = makeLate(
    d,
    r,
    facts,
    { step: dec.handler, ref: `${dec.handler}:${n}`, item: from.item, template: { ...t, ...fields }, parents: [], payload: { routedFrom: from.taskId }, paragraph },
    now,
    team,
  );
  row.run(id, dec.handler, from.eventId, from.taskId, 'made', taskId, now);
  return { step: from.step, outcome: 'routed', why, taskIds: [taskId], handler: dec.handler, standsIn: dec.standsIn };
}

/** An instance with a plan, its members read now. */
function routedOf(d: Db, instance: InstanceRow): Routed | undefined {
  return instance.plan === null ? undefined : { instance, plan: instance.plan, members: membersWithTasks(d, instance.instanceId) };
}

/**
 * Decide what is due, until nothing more is (§9.2 steps 2 to 5): the sweep, the
 * facts, `decide`, each decision applied, again on the new facts, at most once a
 * step of the plan; answers the lines of every decision made.
 */
function decideAll(d: Db, instance: InstanceRow, causeEvent: number | null, now: number, team: RouteTeam | undefined): Swept {
  const out: Swept = { lines: [], superseded: [] };
  const first = routedOf(d, instance);
  if (first === undefined) return out;
  for (let round = 0; round <= first.plan.steps.length; round += 1) {
    const r = routedOf(d, instance) as Routed;
    const swept = sweep(d, r, now);
    out.lines.push(...swept.lines);
    out.superseded.push(...swept.superseded);
    const facts = routingFacts(d, r);
    const decisions = decideRouting(r.plan, facts);
    if (decisions.length === 0 && swept.lines.length === 0) break;
    for (const dec of decisions) {
      const line = apply(d, r, facts, dec, causeEvent, now, team);
      if (line !== undefined) out.lines.push(line);
    }
  }
  return out;
}

/** How long a fault's error may be in its event, in characters (§9.4). */
const FAULT_CHARS = 500;

/**
 * The routing of a transition (§9.2), inside its transaction, after its own rows
 * and event, in a savepoint of its own (§9.4): one read finds the task's member
 * row and its instance's plan, and a task that is no member of an instance with
 * a plan pays nothing more; then what is due is decided, and one
 * `workflow_routed` event on the task lists the decisions, for the notice. A
 * fault never loses the transition: the savepoint rolls back alone, and the
 * instance's `routing_failed_at` and one `workflow_route_failed` event say so,
 * `first` when it set the mark; unless the transaction itself is gone, as
 * SQLite rolls one back on some errors, when the error is the transition's,
 * or the database is busy, when txImmediate retries the whole transition.
 */
function routeAfter(d: Db, taskId: string, cause: RouteCause, eventId: number, now: number, team?: RouteTeam): RunRow[] {
  if (!hasRouting(d)) return [];
  try {
    return d.transaction(() => routeIn(d, taskId, cause, eventId, now, team))();
  } catch (err) {
    if (!d.inTransaction || isBusy(err)) throw err;
    routingFault(d, taskId, err, now);
    return [];
  }
}

/** A transition's result with the runs its routing superseded (§9.5), when there are any. */
function withSuperseded<T extends object>(result: T, superseded: readonly RunRow[]): T & { superseded?: RunRow[] } {
  return superseded.length === 0 ? result : { ...result, superseded: [...superseded] };
}

/** A routing fault recorded, outside the savepoint that rolled back (§9.4): the mark set from null, and its event, masked and cut. */
function routingFault(d: Db, taskId: string, err: unknown, now: number): void {
  const row = d
    .prepare<[string], { instance_id: string; name: string | null }>(
      `SELECT m.instance_id, i.name FROM kanban_workflow_tasks m JOIN kanban_workflow_instances i ON i.instance_id = m.instance_id WHERE m.task_id = ?`,
    )
    .get(taskId);
  if (row === undefined) return;
  const first = d.prepare('UPDATE kanban_workflow_instances SET routing_failed_at = ? WHERE instance_id = ? AND routing_failed_at IS NULL').run(now, row.instance_id).changes === 1;
  const said = mask(err instanceof Error ? err.message : String(err));
  record(
    d,
    {
      taskId,
      kind: 'workflow_route_failed',
      actor: 'gateway',
      payload: { workflow: row.instance_id, workflowName: row.name, error: said.length <= FAULT_CHARS ? said : said.slice(0, FAULT_CHARS), first },
    },
    now,
  );
}

/** The routing's body, inside its savepoint: answers the runs it superseded. */
function routeIn(d: Db, taskId: string, cause: RouteCause, eventId: number, now: number, team?: RouteTeam): RunRow[] {
  const planned = plannedMemberOf(d, taskId);
  if (planned === undefined) return [];
  const { lines, superseded } = decideAll(d, planned.instance, eventId, now, team);
  if (lines.length === 0) return superseded;
  record(
    d,
    {
      taskId,
      kind: 'workflow_routed',
      actor: 'gateway',
      payload: { workflow: planned.instance.instanceId, workflowName: planned.instance.name, step: planned.member.step, cause, decisions: lines },
    },
    now,
  );
  return superseded;
}

/** A reconciliation's answer (§11): the instance, each decision it made, and the runs a stand-in's archive superseded. */
export interface Reconciled {
  instance: InstanceRow;
  decisions: RoutedLine[];
  superseded?: RunRow[];
}

/**
 * The member a reconciliation's `workflow_routed` goes on (§11): the
 * latest-settled ancestor its first decision's step reads, so the notice reaches
 * the instance's chat as any would; the first member when none has a task.
 */
function reconciledOn(d: Db, r: Routed, step: string): string | undefined {
  const parents = new Map(r.plan.steps.map((s) => [s.step, s.parents]));
  const ancestors = new Set<string>();
  const walk = (name: string): void => {
    for (const p of parents.get(name) ?? []) {
      if (ancestors.has(p)) continue;
      ancestors.add(p);
      walk(p);
    }
  };
  walk(step);
  const latest = settledOf(d, r.instance.instanceId)
    .filter((x) => ancestors.has(x.step) && x.taskId !== null)
    .sort((a, b) => b.eventId - a.eventId)[0];
  return latest?.taskId ?? r.members[0]?.taskId;
}

/**
 * Reconcile an instance (§11): the routing given no transitioning task, in one
 * transaction of its own, deciding what is due and making it, its
 * `workflow_routed` on the member whose settling decided the first decision;
 * and its fault mark cleared, as it succeeded. The keys of §9.2 make one that
 * races the gateway decide nothing twice. A fault is thrown: nothing is written,
 * and the mark stays.
 */
export function reconcileWorkflow(db: Db, instanceId: string, now: number, team?: RouteTeam): Result<Reconciled> {
  return tx(db, (d) => {
    const instance = getInstance(d, instanceId);
    if (instance === undefined) return refuse('not_found', `no workflow instance ${instanceId}`);
    const r = routedOf(d, instance);
    if (r === undefined) return { ok: true, instance, decisions: [] };
    const { lines: decisions, superseded } = decideAll(d, instance, null, now, team);
    const first = decisions[0];
    const on = first === undefined ? undefined : reconciledOn(d, routedOf(d, instance) as Routed, first.step);
    if (on !== undefined) {
      record(
        d,
        {
          taskId: on,
          kind: 'workflow_routed',
          actor: 'gateway',
          payload: { workflow: instanceId, workflowName: instance.name, step: memberOf(d, on)?.step ?? null, cause: 'reconciled', decisions },
        },
        now,
      );
    }
    d.prepare('UPDATE kanban_workflow_instances SET routing_failed_at = NULL WHERE instance_id = ?').run(instanceId);
    return { ok: true, ...withSuperseded({ instance: getInstance(d, instanceId) as InstanceRow, decisions }, superseded) };
  });
}
