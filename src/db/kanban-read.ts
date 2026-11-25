import type { Db } from './open.js';
import type { Dag } from '../kanban/dag.js';
import { displayStatus, type DisplayStatus } from '../kanban/status.js';
import { openTurns } from './turns.js';
import { worktreeOf } from './workspaces.js';
import type {
  ActivePhase,
  AgentSnapshot,
  Assignee,
  BoardRow,
  ChatAt,
  CommentRow,
  Contract,
  CreatedVia,
  GateRow,
  KanbanEvent,
  Phase,
  RetryOnCrash,
  RunKind,
  RunOutcome,
  RunRow,
  SubscriptionRow,
  TaskRow,
  Waiting,
  WakeEventRow,
  WakeRow,
  DeferredButtonRow,
  DeferredState,
  DeferredWhy,
  WakeState,
} from '../kanban/types.js';

/**
 * Reading the board. Reads only: every write is db/kanban.ts's (WRITERS.md).
 *
 * Each function takes a `Db`, so db/kanban.ts calls them with the connection of
 * its open transaction, and a read that a decision rests on is made under the
 * write lock.
 */

type Json = string | Buffer | Uint8Array;

function json(v: Json): unknown {
  return JSON.parse(typeof v === 'string' ? v : Buffer.from(v).toString('utf8')) as unknown;
}

function assignee(kind: string | null, name: string | null): Assignee | null {
  return kind === null || name === null ? null : { kind: kind as Assignee['kind'], name };
}

interface TaskRaw {
  task_id: string;
  title: string;
  body: string;
  contract: Json;
  assignee_kind: string | null;
  assignee: string | null;
  reviewer_kind: string | null;
  reviewer: string | null;
  workspace: string | null;
  phase: string;
  blocked_from: string | null;
  block_kind: string | null;
  block_reason: string | null;
  priority: number;
  idempotency_key: string | null;
  failure_limit: number | null;
  retry_on_crash: string;
  max_runtime_s: number | null;
  consecutive_failures: number;
  consecutive_transient: number;
  cooldown_until: number | null;
  block_recurrences: number;
  stranded_notified_at: number | null;
  created_by: string;
  created_via: Json;
  created_at: number;
  closed_at: number | null;
  created_from_task: string | null;
  board: string;
  worktree: string | null;
  wake_by: string | null;
  wake_depth: number;
  wake_role: string | null;
  reaction_of: number | null;
  wake_root: string | null;
  wake_cursor: number;
}

function decodeTask(r: TaskRaw): TaskRow {
  return {
    taskId: r.task_id,
    title: r.title,
    body: r.body,
    contract: json(r.contract) as Contract,
    assignee: assignee(r.assignee_kind, r.assignee),
    reviewer: assignee(r.reviewer_kind, r.reviewer),
    workspace: r.workspace,
    phase: r.phase as Phase,
    blockedFrom: r.blocked_from as ActivePhase | null,
    blockKind: r.block_kind as TaskRow['blockKind'],
    blockReason: r.block_reason,
    priority: r.priority,
    idempotencyKey: r.idempotency_key,
    failureLimit: r.failure_limit,
    retryOnCrash: r.retry_on_crash as RetryOnCrash,
    maxRuntimeS: r.max_runtime_s,
    consecutiveFailures: r.consecutive_failures,
    consecutiveTransient: r.consecutive_transient,
    cooldownUntil: r.cooldown_until,
    blockRecurrences: r.block_recurrences,
    strandedNotifiedAt: r.stranded_notified_at,
    createdBy: r.created_by,
    createdVia: json(r.created_via) as CreatedVia,
    createdAt: r.created_at,
    closedAt: r.closed_at,
    createdFromTask: r.created_from_task,
    board: r.board,
    worktree: r.worktree,
    wakeBy: r.wake_by,
    wakeDepth: r.wake_depth,
    wakeRole: r.wake_role,
    reactionOf: r.reaction_of,
    wakeRoot: r.wake_root,
    wakeCursor: r.wake_cursor,
  };
}

const TASK_COLS = `task_id, title, body, json(contract) AS contract, assignee_kind, assignee,
  reviewer_kind, reviewer, workspace, phase, blocked_from, block_kind, block_reason, priority,
  idempotency_key, failure_limit, retry_on_crash, max_runtime_s, consecutive_failures,
  consecutive_transient, cooldown_until, block_recurrences, stranded_notified_at, created_by,
  json(created_via) AS created_via, created_at, closed_at, created_from_task, board, worktree`;

/**
 * Whether the database has migration 013's columns (wake spec §4.1). The
 * terminal opens the gateway's database without migrating it, and reads one not
 * yet migrated as the workflows and the grants do (workflows spec §7, tier
 * grants spec §4.3): such a database's tasks have wake off, at depth 0, and its
 * subscriptions' wake cursors are at 0. `user_version` is read from the file's
 * header, so the check costs no table read.
 */
export function hasWakeColumns(db: Db): boolean {
  return Number(db.pragma('user_version', { simple: true })) >= 13;
}

/** A task's columns: the wake's, or what a database before migration 013 has for them. */
function taskCols(db: Db): string {
  return hasWakeColumns(db)
    ? `${TASK_COLS}, wake_by, wake_depth, wake_role, reaction_of, wake_root, wake_cursor`
    : `${TASK_COLS}, NULL AS wake_by, 0 AS wake_depth, NULL AS wake_role, NULL AS reaction_of, NULL AS wake_root, 0 AS wake_cursor`;
}

interface RunRaw {
  run_id: string;
  task_id: string;
  attempt: number;
  kind: string;
  assignee_kind: string;
  assignee: string;
  agent_config: Json | null;
  workspace: string | null;
  role_md_hash: string | null;
  session_id: string | null;
  seeded_from_run: string | null;
  token_hash: string | null;
  outcome: string | null;
  summary: string | null;
  metadata: Json | null;
  reported_commit: string | null;
  reported_dirty: number | null;
  error: string | null;
  last_output: string | null;
  submissions: number;
  started_at: number;
  ended_at: number | null;
}

function decodeRun(r: RunRaw): RunRow {
  return {
    runId: r.run_id,
    taskId: r.task_id,
    attempt: r.attempt,
    kind: r.kind as RunKind,
    assignee: { kind: r.assignee_kind as Assignee['kind'], name: r.assignee },
    agentConfig: r.agent_config === null ? null : (json(r.agent_config) as AgentSnapshot),
    workspace: r.workspace,
    roleMdHash: r.role_md_hash,
    sessionId: r.session_id,
    seededFromRun: r.seeded_from_run,
    tokenHash: r.token_hash,
    outcome: r.outcome as RunOutcome | null,
    summary: r.summary,
    metadata: r.metadata === null ? null : json(r.metadata),
    reportedCommit: r.reported_commit,
    reportedDirty: r.reported_dirty === null ? null : r.reported_dirty === 1,
    error: r.error,
    lastOutput: r.last_output,
    submissions: r.submissions,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

const RUN_COLS = `run_id, task_id, attempt, kind, assignee_kind, assignee,
  json(agent_config) AS agent_config, workspace, role_md_hash, session_id, seeded_from_run,
  token_hash, outcome, summary, json(metadata) AS metadata, reported_commit, reported_dirty,
  error, last_output, submissions, started_at, ended_at`;

interface CommentRaw {
  id: number;
  task_id: string;
  author: string;
  body: string;
  created_at: number;
}

function decodeComment(r: CommentRaw): CommentRow {
  return { id: r.id, taskId: r.task_id, author: r.author, body: r.body, createdAt: r.created_at };
}

interface EventRaw {
  id: number;
  task_id: string;
  run_id: string | null;
  kind: string;
  actor: string;
  payload: Json;
  created_at: number;
}

function decodeEvent(r: EventRaw): KanbanEvent {
  return {
    id: r.id,
    taskId: r.task_id,
    runId: r.run_id,
    kind: r.kind,
    actor: r.actor,
    payload: json(r.payload),
    createdAt: r.created_at,
  };
}

export function getTask(db: Db, taskId: string): TaskRow | undefined {
  const row = db.prepare<[string], TaskRaw>(`SELECT ${taskCols(db)} FROM kanban_tasks WHERE task_id = ?`).get(taskId);
  return row === undefined ? undefined : decodeTask(row);
}

export function getTaskByKey(db: Db, idempotencyKey: string): TaskRow | undefined {
  const row = db
    .prepare<[string], TaskRaw>(`SELECT ${taskCols(db)} FROM kanban_tasks WHERE idempotency_key = ?`)
    .get(idempotencyKey);
  return row === undefined ? undefined : decodeTask(row);
}

export function parentsOf(db: Db, taskId: string): TaskRow[] {
  return db
    .prepare<[string], TaskRaw>(
      `SELECT ${taskCols(db)} FROM kanban_tasks
        WHERE task_id IN (SELECT parent_id FROM kanban_links WHERE child_id = ?)
        ORDER BY created_at, rowid`,
    )
    .all(taskId)
    .map(decodeTask);
}

/** The task's parents in the order they were linked: the order a fan-in merges their branches in (spec §18.5). */
export function parentsInLinkOrder(db: Db, taskId: string): TaskRow[] {
  return db
    .prepare<[string], TaskRaw>(
      `SELECT ${taskCols(db)} FROM kanban_tasks
         JOIN (SELECT parent_id, rowid AS link FROM kanban_links WHERE child_id = ?) ON parent_id = task_id
        ORDER BY link`,
    )
    .all(taskId)
    .map(decodeTask);
}

export function childrenOf(db: Db, taskId: string): TaskRow[] {
  return db
    .prepare<[string], TaskRaw>(
      `SELECT ${taskCols(db)} FROM kanban_tasks
        WHERE task_id IN (SELECT child_id FROM kanban_links WHERE parent_id = ?)
        ORDER BY created_at, rowid`,
    )
    .all(taskId)
    .map(decodeTask);
}

/** Done or archived: a parent that no longer holds its children back (spec §4.1). */
export function isFinished(phase: Phase): boolean {
  return phase === 'done' || phase === 'archived';
}

export function getRun(db: Db, runId: string): RunRow | undefined {
  const row = db.prepare<[string], RunRaw>(`SELECT ${RUN_COLS} FROM kanban_runs WHERE run_id = ?`).get(runId);
  return row === undefined ? undefined : decodeRun(row);
}

/** Every run on the task, oldest attempt first. */
export function runsOf(db: Db, taskId: string): RunRow[] {
  return db
    .prepare<[string], RunRaw>(`SELECT ${RUN_COLS} FROM kanban_runs WHERE task_id = ? ORDER BY attempt`)
    .all(taskId)
    .map(decodeRun);
}

/** The task's open run, if any: at most one, by the partial unique index. */
export function openRunOf(db: Db, taskId: string): RunRow | undefined {
  const row = db
    .prepare<[string], RunRaw>(`SELECT ${RUN_COLS} FROM kanban_runs WHERE task_id = ? AND ended_at IS NULL`)
    .get(taskId);
  return row === undefined ? undefined : decodeRun(row);
}

/** The open agent run in a workspace, if any: the one-per-workspace limit (spec §6.3). */
export function openAgentRunIn(db: Db, workspace: string): RunRow | undefined {
  const row = db
    .prepare<[string], RunRaw>(
      `SELECT ${RUN_COLS} FROM kanban_runs
        WHERE workspace = ? AND ended_at IS NULL AND assignee_kind = 'role'`,
    )
    .get(workspace);
  return row === undefined ? undefined : decodeRun(row);
}

/**
 * The task's comments, oldest first. `steering`: only those that may steer an
 * agent -- a run's, or an operator's -- which are what a run's prompt and a
 * forwarded comment carry (spec §7.5, §9.1). Without it, every comment, as
 * `/kanban task show` gives them to people.
 */
export function commentsOf(db: Db, taskId: string, opts: { steering?: boolean } = {}): CommentRow[] {
  return db
    .prepare<[string], CommentRaw>(
      `SELECT id, task_id, author, body, created_at FROM kanban_comments
        WHERE task_id = ?${opts.steering === true ? ' AND steers = 1' : ''} ORDER BY id`,
    )
    .all(taskId)
    .map(decodeComment);
}

interface GateRaw {
  id: number;
  task_id: string;
  command: string;
  timeout_s: number;
  created_by: string;
  created_at: number;
}

/** The task's gates, in the order they were defined: the order they run in (spec §7.7). */
export function gatesOf(db: Db, taskId: string): GateRow[] {
  return db
    .prepare<[string], GateRaw>(
      'SELECT id, task_id, command, timeout_s, created_by, created_at FROM kanban_gates WHERE task_id = ? ORDER BY id',
    )
    .all(taskId)
    .map((r) => ({
      id: r.id,
      taskId: r.task_id,
      command: r.command,
      timeoutS: r.timeout_s,
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
}

export function eventsOf(db: Db, taskId: string): KanbanEvent[] {
  return db
    .prepare<[string], EventRaw>(
      `SELECT id, task_id, run_id, kind, actor, json(payload) AS payload, created_at
         FROM kanban_events WHERE task_id = ? ORDER BY id`,
    )
    .all(taskId)
    .map(decodeEvent);
}

/** The task's events after the given id, oldest first, at most `limit`: what a subscription has yet to hear. */
export function eventsAfter(db: Db, taskId: string, after: number, limit: number): KanbanEvent[] {
  return db
    .prepare<[string, number, number], EventRaw>(
      `SELECT id, task_id, run_id, kind, actor, json(payload) AS payload, created_at
         FROM kanban_events WHERE task_id = ? AND id > ? ORDER BY id LIMIT ?`,
    )
    .all(taskId, after, limit)
    .map(decodeEvent);
}

interface SubscriptionRaw {
  id: number;
  task_id: string;
  channel: string;
  account_id: string;
  conversation_id: string;
  thread_id: string;
  root_message_id: string | null;
  cursor: number;
  created_at: number;
  wake_cursor: number;
  chat_type: string | null;
}

function decodeSubscription(r: SubscriptionRaw): SubscriptionRow {
  return {
    id: r.id,
    taskId: r.task_id,
    channel: r.channel,
    appId: r.account_id,
    conversationId: r.conversation_id,
    threadId: r.thread_id,
    rootMessageId: r.root_message_id,
    cursor: r.cursor,
    createdAt: r.created_at,
    wakeCursor: r.wake_cursor,
    chatType: r.chat_type as SubscriptionRow['chatType'],
  };
}

const SUBSCRIPTION_COLS = 'id, task_id, channel, account_id, conversation_id, thread_id, root_message_id, cursor, created_at';

/** A subscription's columns: the wake's, or what a database before migration 013 has for them. */
function subscriptionCols(db: Db): string {
  return hasWakeColumns(db) ? `${SUBSCRIPTION_COLS}, wake_cursor, chat_type` : `${SUBSCRIPTION_COLS}, 0 AS wake_cursor, NULL AS chat_type`;
}

/** The chats following a task, in the order they were subscribed (spec §9.4). */
export function subscriptionsOf(db: Db, taskId: string): SubscriptionRow[] {
  return db
    .prepare<[string], SubscriptionRaw>(
      `SELECT ${subscriptionCols(db)} FROM kanban_subscriptions WHERE task_id = ? ORDER BY id`,
    )
    .all(taskId)
    .map(decodeSubscription);
}

/** A subscription with something to deliver, and the id of its oldest event past the cursor. */
export interface DueSubscription extends SubscriptionRow {
  oldestPending: number;
}

/**
 * This bot's subscriptions with an event past their cursor, in subscription
 * order: what a round of delivery has to do (spec §9.4). Read from the cursors,
 * so a round after a restart catches up exactly as a round in normal running
 * does. Each carries its oldest pending event's id, which the events' `(task_id,
 * id)` index finds at once, so the notifier can serve the longest-waiting first.
 */
export function dueSubscriptions(db: Db, appId: string): DueSubscription[] {
  return db
    .prepare<[string], SubscriptionRaw & { oldest_pending: number | null }>(
      `SELECT * FROM (
         SELECT ${subscriptionCols(db)},
                (SELECT min(e.id) FROM kanban_events e WHERE e.task_id = s.task_id AND e.id > s.cursor) AS oldest_pending
           FROM kanban_subscriptions s
          WHERE s.account_id = ?)
        WHERE oldest_pending IS NOT NULL
        ORDER BY id`,
    )
    .all(appId)
    .map((r) => ({ ...decodeSubscription(r), oldestPending: r.oldest_pending ?? 0 }));
}

/** A thread a bot's subscriptions deliver to: its channel, the bot, the chat, and the thread. */
export interface ThreadAt {
  channel: string;
  appId: string;
  conversationId: string;
  threadId: string;
}

/**
 * The root of a thread, from the first of its subscriptions that knows one,
 * whether or not that one has anything due (spec §19.7): a thread has one root,
 * so a task from before threads had roots is replied to it as well. None at chat
 * scope, or when no subscription in the thread knows it.
 */
export function threadRootOf(db: Db, at: ThreadAt): string | undefined {
  if (at.threadId === '') return undefined;
  const r = db
    .prepare<[string, string, string, string], { root_message_id: string }>(
      `SELECT root_message_id FROM kanban_subscriptions
        WHERE channel = ? AND account_id = ? AND conversation_id = ? AND thread_id = ? AND root_message_id IS NOT NULL
        ORDER BY id LIMIT 1`,
    )
    .get(at.channel, at.appId, at.conversationId, at.threadId);
  return r?.root_message_id;
}

/** A report's run of the task's gates, as its `gates_ran` event recorded it (spec §7.7). */
export interface LastGateRun {
  /** The run that reported; null for a person. */
  runId: string | null;
  actor: string;
  for: 'complete' | 'review';
  passed: boolean;
  aborted: boolean;
  notRun: number;
  results: Array<{
    gateId: number;
    command: string;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    durationMs: number;
    output: string;
  }>;
  at: number;
}

/** The latest run of the task's gates, if they ever ran: the prompt's "last gate run" (spec §7.1). */
export function lastGateRun(db: Db, taskId: string): LastGateRun | undefined {
  const row = db
    .prepare<[string], EventRaw>(
      `SELECT id, task_id, run_id, kind, actor, json(payload) AS payload, created_at
         FROM kanban_events WHERE task_id = ? AND kind = 'gates_ran' ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId);
  if (row === undefined) return undefined;
  const payload = json(row.payload) as Omit<LastGateRun, 'runId' | 'actor' | 'at'>;
  return { ...payload, runId: row.run_id, actor: row.actor, at: row.created_at };
}

/** A request for same-task review (spec §5.3): the handoff a reviewer reviews, and a rework revises. */
export interface ReviewRequest {
  /** The work run that asked; null for a person. */
  runId: string | null;
  actor: string;
  summary: string;
  metadata: unknown;
  /** What the run's report recorded of its workspace (spec §7.8); null for a person's. */
  reportedCommit: string | null;
  reportedDirty: boolean | null;
}

/**
 * The task's latest request for review: its `review_requested` event, and the
 * work run's handoff when a run asked. A person's request has only the event's
 * summary.
 */
export function latestReviewRequest(db: Db, taskId: string): ReviewRequest | undefined {
  const event = latestOf(db, taskId, ['review_requested']);
  if (event === undefined) return undefined;
  const run = event.run_id === null ? undefined : getRun(db, event.run_id);
  if (run !== undefined) {
    return {
      runId: run.runId,
      actor: event.actor,
      summary: run.summary ?? '',
      metadata: run.metadata,
      reportedCommit: run.reportedCommit,
      reportedDirty: run.reportedDirty,
    };
  }
  const payload = json(event.payload) as { summary?: unknown };
  return {
    runId: null,
    actor: event.actor,
    summary: typeof payload.summary === 'string' ? payload.summary : '',
    metadata: null,
    reportedCommit: null,
    reportedDirty: null,
  };
}

/** Changes a reviewer asked for and nobody has yet answered with another review request: what a rework is for. */
export interface ChangesAsked {
  reason: string;
  /** Who asked: a review run (`run:<id>`) or a person. */
  actor: string;
}

/**
 * The changes the task's next work run is to make (spec §5.3), if its latest
 * review ended in them: the latest `changes_requested` event, unless a review
 * was asked for since. Read from the event, which has the reason whether a review
 * run or a person asked (C1 Decision 7).
 */
export function changesAsked(db: Db, taskId: string): ChangesAsked | undefined {
  const event = latestOf(db, taskId, ['review_requested', 'changes_requested']);
  if (event?.kind !== 'changes_requested') return undefined;
  const payload = json(event.payload) as { reason?: unknown };
  return { reason: typeof payload.reason === 'string' ? payload.reason : '', actor: event.actor };
}

/** The task's latest event of one of these kinds. */
function latestOf(db: Db, taskId: string, kinds: readonly string[]): EventRaw | undefined {
  return db
    .prepare<string[], EventRaw>(
      `SELECT id, task_id, run_id, kind, actor, json(payload) AS payload, created_at
         FROM kanban_events WHERE task_id = ? AND kind IN (${kinds.map(() => '?').join(', ')})
        ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId, ...kinds);
}

/** The task as `/kanban task show` and `mt kanban task show` present it. */
export interface TaskView {
  task: TaskRow;
  status: DisplayStatus;
  parents: TaskRow[];
  children: TaskRow[];
  /** The parents' and the children's display statuses, by task id: what a person sees of them, as of this one. */
  statuses: ReadonlyMap<string, DisplayStatus>;
  runs: RunRow[];
  comments: CommentRow[];
  /**
   * Why a claimable task is not claimed yet: the limits a pass skips it for, and
   * a busy workspace (spec §6.2, §6.3, §16). Set by the service's `show`, which
   * knows the limits; never by `taskView`. Absent when it waits on none of them.
   */
  waiting?: readonly Waiting[];
  /**
   * For a task with a directory of its own (spec §18): where it is, and its
   * branch for a git worktree. `path` is null until the directory is made,
   * before the task's next agent run. `first`: no agent has taken up the task
   * yet, in an isolated workspace, so its first agent claim gives it one; set by
   * the service's `show`, which knows the isolated workspaces.
   */
  workdir?: { path: string | null; branch: string | null; first?: true };
  /** The workflow's instance the task is a member of (workflows spec §10), with its step and item; absent for a task that is none's. */
  member?: { instanceId: string; name: string | null; step: string; item: string | null };
  /** When the task's latest delivered wake was delivered (wake spec §10); absent before its first. */
  lastWoke?: number;
  /** The reaction tasks its outcomes made (wake spec §19.9), newest first, with their display statuses; absent when none. */
  reactions?: ReadonlyArray<{ taskId: string; status: DisplayStatus }>;
  /** For a reaction task (wake spec §19.9): the tasks its wake carried, in event order, its role and its setter. */
  reactsTo?: { tasks: readonly string[]; role: string; principal: string };
}

/** A task's display status (spec §4.1), derived from its parents and its runs. */
export function statusOf(db: Db, task: TaskRow): DisplayStatus {
  return displayStatus({
    phase: task.phase,
    parentsFinished: parentsOf(db, task.taskId).every((p) => isFinished(p.phase)),
    undecidedRun: runsOf(db, task.taskId).find((r) => r.outcome === null)?.kind,
  });
}

export function taskView(db: Db, taskId: string): TaskView | undefined {
  const task = getTask(db, taskId);
  if (task === undefined) return undefined;
  const parents = parentsOf(db, taskId);
  const children = childrenOf(db, taskId);
  const runs = runsOf(db, taskId);
  const undecided = runs.find((r) => r.outcome === null);
  // Read only when the members table is there: a database not yet migrated has none (workflows spec §7).
  const member = memberOf(db, taskId);
  // None on a database not yet migrated to 013, which lastWokeOf reads as no wakes (wake spec §4).
  const lastWoke = lastWokeOf(db, taskId);
  const reactions = hasWakeColumns(db) ? reactionsOf(db, taskId).map((t) => ({ taskId: t.taskId, status: statusOf(db, t) })) : [];
  const wake = hasWakeColumns(db) ? wakeOfReaction(db, taskId) : undefined;
  const carried = wake === undefined ? undefined : reactsTo(db, taskId);
  return {
    task,
    status: displayStatus({
      phase: task.phase,
      parentsFinished: parents.every((p) => isFinished(p.phase)),
      undecidedRun: undecided?.kind,
    }),
    parents,
    children,
    statuses: new Map([...parents, ...children].map((t) => [t.taskId, statusOf(db, t)])),
    runs,
    comments: commentsOf(db, taskId),
    ...(task.worktree === null ? {} : { workdir: workdirOf(db, task.worktree) }),
    ...(member === undefined ? {} : { member: { instanceId: member.instanceId, name: member.name, step: member.step, item: member.item } }),
    ...(lastWoke === undefined ? {} : { lastWoke }),
    ...(reactions.length === 0 ? {} : { reactions }),
    ...(wake === undefined || wake.targetRole === null || carried === null || carried === undefined
      ? {}
      : { reactsTo: { tasks: carried, role: wake.targetRole, principal: wake.principal } }),
  };
}

function workdirOf(db: Db, worktree: string): { path: string | null; branch: string | null } {
  const made = worktreeOf(db, worktree);
  return { path: made?.rootPath ?? null, branch: made?.branch ?? null };
}

/** A task on the board, with what a person sees of it (spec §4.1). */
export interface BoardEntry {
  task: TaskRow;
  status: DisplayStatus;
}

/**
 * Every task on a board -- on every board, with none given -- with its display
 * status, highest priority first, then oldest: `/kanban task list` (spec §9.1, §16).
 * The status is derived here, from the parents and the runs, as `taskView`
 * derives it.
 */
export function boardList(db: Db, board?: string): BoardEntry[] {
  const where = board === undefined ? '' : 'WHERE board = ?';
  return db
    .prepare<string[], TaskRaw>(`SELECT ${taskCols(db)} FROM kanban_tasks ${where} ORDER BY priority DESC, created_at, rowid`)
    .all(...(board === undefined ? [] : [board]))
    .map(decodeTask)
    .map((task) => ({ task, status: statusOf(db, task) }));
}

/**
 * When each task of a board last changed phase (kanban spec §22.3): the time of
 * its newest event among those that set one, as db/kanban.ts writes them --
 * `created`, `review_requested`, `changes_requested`, `completed`, `blocked`
 * unless a dependency block, which keeps the phase, `stopped`, `run_ended` whose
 * `next` blocked the task, `unblocked` and `archived`. One query for the board,
 * by the events' `(task_id, id)` index; a task with none is not in the map.
 */
export function phaseSince(db: Db, board: string): Map<string, number> {
  const rows = db
    .prepare<[string], { task_id: string; at: number; newest: number }>(
      `SELECT e.task_id AS task_id, e.created_at AS at, max(e.id) AS newest
         FROM kanban_events e JOIN kanban_tasks t ON t.task_id = e.task_id
        WHERE t.board = ?
          AND (e.kind IN ('created', 'review_requested', 'changes_requested', 'completed', 'stopped', 'unblocked', 'archived')
               OR (e.kind = 'blocked' AND coalesce(json_extract(e.payload, '$.kind'), '') <> 'dependency')
               OR (e.kind = 'run_ended' AND json_extract(e.payload, '$.next') = 'blocked'))
        GROUP BY e.task_id`,
    )
    .all(board);
  return new Map(rows.map((r) => [r.task_id, r.at]));
}

// ---------------------------------------------------------------------------
// What the dispatcher reads (plan C2)
// ---------------------------------------------------------------------------

/** Every open run, oldest first: what a restart closes (spec §8.4). */
export function openRuns(db: Db): RunRow[] {
  return db
    .prepare<[], RunRaw>(`SELECT ${RUN_COLS} FROM kanban_runs WHERE ended_at IS NULL ORDER BY started_at, rowid`)
    .all()
    .map(decodeRun);
}

/**
 * The people's runs whose card is still to be sent (spec §9.2): open, a
 * person's, with neither a `card_sent` nor a `card_failed` event, oldest first.
 */
export function cardsDue(db: Db): RunRow[] {
  return db
    .prepare<[], RunRaw>(
      `SELECT ${RUN_COLS} FROM kanban_runs r
        WHERE r.ended_at IS NULL AND r.assignee_kind = 'human'
          AND NOT EXISTS (
            SELECT 1 FROM kanban_events e
             WHERE e.task_id = r.task_id AND e.run_id = r.run_id AND e.kind IN ('card_sent', 'card_failed'))
        ORDER BY r.started_at, r.rowid`,
    )
    .all()
    .map(decodeRun);
}

/**
 * What a person's card shows of the board (spec §9.2), read for the run it is
 * for: the task, its parents' latest completions as its children are given them
 * (spec §4.4), and for a work run the changes a review asked for, for a review
 * run the handoff under review. Undefined for a run, or a task, not on the board.
 */
export interface CardReading {
  task: TaskRow;
  run: RunRow;
  parents: Array<{ task: TaskRow; summary: string }>;
  changes?: ChangesAsked;
  handoff?: ReviewRequest;
}

export function cardReading(db: Db, runId: string): CardReading | undefined {
  const run = getRun(db, runId);
  const task = run === undefined ? undefined : getTask(db, run.taskId);
  if (run === undefined || task === undefined) return undefined;
  const parents = parentsOf(db, task.taskId).map((p) => ({ task: p, summary: latestCompletion(db, p.taskId)?.summary ?? '' }));
  if (run.kind === 'review') {
    const handoff = latestReviewRequest(db, task.taskId);
    return handoff === undefined ? { task, run, parents } : { task, run, parents, handoff };
  }
  const changes = changesAsked(db, task.taskId);
  return changes === undefined ? { task, run, parents } : { task, run, parents, changes };
}

/** The run a gateway session belongs to: at most one, by the unique index on session_id. */
export function runBySession(db: Db, sessionId: string): RunRow | undefined {
  const row = db.prepare<[string], RunRaw>(`SELECT ${RUN_COLS} FROM kanban_runs WHERE session_id = ?`).get(sessionId);
  return row === undefined ? undefined : decodeRun(row);
}

/**
 * The run a worker token belongs to, by the token's hash (spec §7.2): at most
 * one, by the unique index on token_hash. Open or closed: what a closed run's
 * token may still do is the worker API's to decide.
 */
export function runByTokenHash(db: Db, tokenHash: string): RunRow | undefined {
  const row = db.prepare<[string], RunRaw>(`SELECT ${RUN_COLS} FROM kanban_runs WHERE token_hash = ?`).get(tokenHash);
  return row === undefined ? undefined : decodeRun(row);
}

/**
 * Open agent runs, decided or not: what `kanban.maxRunning` counts (spec §6.3).
 * A run that has reported still has its process, and its live session.
 */
export function openAgentRunCount(db: Db): number {
  const row = db
    .prepare<[], { n: number }>(
      "SELECT count(*) AS n FROM kanban_runs WHERE ended_at IS NULL AND assignee_kind = 'role'",
    )
    .get();
  return row?.n ?? 0;
}

/** Open agent runs on one board's tasks: what a board's own max_running counts (spec §16). */
export function openAgentRunCountOn(db: Db, board: string): number {
  const row = db
    .prepare<[string], { n: number }>(
      `SELECT count(*) AS n FROM kanban_runs r JOIN kanban_tasks t ON t.task_id = r.task_id
        WHERE r.ended_at IS NULL AND r.assignee_kind = 'role' AND t.board = ?`,
    )
    .get(board);
  return row?.n ?? 0;
}

/**
 * Open agent runs as one role, decided or not: what a role's max_running counts
 * (spec §6.3). A run counts as the role it runs as, its snapshot of the
 * assignee: a work run's assignee role, a review run's reviewer role. A
 * person's run is never counted.
 */
export function openAgentRunCountAs(db: Db, role: string): number {
  const row = db
    .prepare<[string], { n: number }>(
      "SELECT count(*) AS n FROM kanban_runs WHERE ended_at IS NULL AND assignee_kind = 'role' AND assignee = ?",
    )
    .get(role);
  return row?.n ?? 0;
}

/**
 * Tasks a pass may try to claim (spec §6.2 step 1), highest priority first, then
 * oldest: in open or review, with no open run of any kind, every parent finished,
 * and no cooldown still running. A task in its cooldown shows as ready (spec
 * §4.1), so the cooldown is checked here rather than left to the claim to refuse.
 *
 * Whether someone can take it -- the assignee, the workspace -- is the claim's to
 * decide, inside its transaction.
 */
export function claimableTasks(db: Db, now: number): TaskRow[] {
  return db
    .prepare<[number], TaskRaw>(
      `SELECT ${taskCols(db)} FROM kanban_tasks t
        WHERE t.phase IN ('open', 'review')
          AND (t.cooldown_until IS NULL OR t.cooldown_until <= ?)
          AND NOT EXISTS (SELECT 1 FROM kanban_runs r WHERE r.task_id = t.task_id AND r.ended_at IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM kanban_links l JOIN kanban_tasks p ON p.task_id = l.parent_id
             WHERE l.child_id = t.task_id AND p.phase NOT IN ('done', 'archived'))
        ORDER BY t.priority DESC, t.created_at, t.rowid`,
    )
    .all(now)
    .map(decodeTask);
}

/** A task's completion, as its children are given it: the handoff (spec §7.1). */
export interface Completion {
  summary: string;
  metadata: unknown;
  /** The run that completed it; null for a person's completion. */
  runId: string | null;
}

/**
 * The task's latest completion: its `completed` event, and the run's summary and
 * metadata when a run completed it. A person's completion has no run, and its
 * summary is the event's. Undefined if the task was never completed.
 *
 * A review run's summary is the reviewer's approval ("LGTM"), not the work, and
 * a person's approval is a comment: when the completion is a review run's, or
 * has no run, and the task was ever sent for review, the handoff is the latest
 * review request, as the reviewer was given it (spec §4.4).
 */
export function latestCompletion(db: Db, taskId: string): Completion | undefined {
  const event = db
    .prepare<[string], EventRaw>(
      `SELECT id, task_id, run_id, kind, actor, json(payload) AS payload, created_at
         FROM kanban_events WHERE task_id = ? AND kind = 'completed' ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId);
  if (event === undefined) return undefined;
  const run = event.run_id === null ? undefined : getRun(db, event.run_id);
  // An approval -- a review run's, or a person's with no run of their own -- hands off what was reviewed.
  if (run === undefined || run.kind === 'review') {
    const asked = latestOf(db, taskId, ['review_requested']);
    if (asked !== undefined) return handedOff(db, asked);
  }
  return handedOff(db, event);
}

/** What an event handed off: its run's summary and metadata, or, with no run, the event's summary. */
function handedOff(db: Db, event: EventRaw): Completion {
  const run = event.run_id === null ? undefined : getRun(db, event.run_id);
  if (run !== undefined) return { summary: run.summary ?? '', metadata: run.metadata, runId: run.runId };
  const payload = json(event.payload) as { summary?: unknown };
  return { summary: typeof payload.summary === 'string' ? payload.summary : '', metadata: null, runId: null };
}

// ---------------------------------------------------------------------------
// Boards (spec §16)
// ---------------------------------------------------------------------------

interface BoardRaw {
  name: string;
  max_running: number | null;
  workspace: string | null;
  created_by: string;
  created_at: number;
  updated_by: string | null;
  updated_at: number | null;
  archived_at: number | null;
}

function decodeBoard(r: BoardRaw): BoardRow {
  return {
    name: r.name,
    maxRunning: r.max_running,
    workspace: r.workspace,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
  };
}

const BOARD_COLS = 'name, max_running, workspace, created_by, created_at, updated_by, updated_at, archived_at';

export function getBoard(db: Db, name: string): BoardRow | undefined {
  const row = db.prepare<[string], BoardRaw>(`SELECT ${BOARD_COLS} FROM kanban_boards WHERE name = ?`).get(name);
  return row === undefined ? undefined : decodeBoard(row);
}

/** Which boards to read: archived ones too, or one board whatever it is, as a chat's own board is. */
export interface BoardsWanted {
  archived?: boolean;
  including?: string;
}

/** The boards, `default` first, then by name; archived ones only when asked for, or when `including` names one. */
export function boardsOf(db: Db, opts: BoardsWanted = {}): BoardRow[] {
  return db
    .prepare<[string], BoardRaw>(
      `SELECT ${BOARD_COLS} FROM kanban_boards
        ${opts.archived === true ? '' : 'WHERE archived_at IS NULL OR name = ?'}
        ORDER BY name <> 'default', name`,
    )
    .all(...((opts.archived === true ? [] : [opts.including ?? '']) as [string]))
    .map(decodeBoard);
}

/** A board, and how many of its tasks are in each phase: what `/kanban board list` shows. */
export interface BoardSummary {
  board: BoardRow;
  counts: Record<Phase, number>;
}

export function boardSummaries(db: Db, opts: BoardsWanted = {}): BoardSummary[] {
  const counted = db
    .prepare<[], { board: string; phase: Phase; n: number }>(
      'SELECT board, phase, count(*) AS n FROM kanban_tasks GROUP BY board, phase',
    )
    .all();
  return boardsOf(db, opts).map((board) => {
    const counts: Record<Phase, number> = { open: 0, review: 0, blocked: 0, done: 0, archived: 0 };
    for (const c of counted) if (c.board === board.name) counts[c.phase] = c.n;
    return { board, counts };
  });
}

/** The board a chat was moved onto, if it ever was: a chat with none is on `default` (spec §16). */
export function chatBoardOf(db: Db, at: ChatAt): string | undefined {
  return db
    .prepare<[string, string, string], { board: string }>(
      'SELECT board FROM kanban_chat_boards WHERE channel = ? AND account_id = ? AND conversation_id = ?',
    )
    .get(at.channel, at.appId, at.conversationId)?.board;
}

/** Whether the database has the board's tables: one migrated before the board has none (spec §20.3). */
export function hasBoard(db: Db): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kanban_runs'").get() !== undefined;
}

// ---------------------------------------------------------------------------
// Workflows (workflows spec §7, §10)
// ---------------------------------------------------------------------------

/** One start of a workflow, or one apply of a DAG (workflows spec §7). */
export interface InstanceRow {
  instanceId: string;
  /** The workflow's name, or null for a DAG with none. */
  name: string | null;
  /** The DAG it was made from, as stored: masked but for its gates. */
  dag: Dag;
  source: 'start' | 'apply';
  board: string;
  createdBy: string;
  createdVia: CreatedVia;
  idempotencyKey: string | null;
  createdAt: number;
}

/** A task an instance made: its ref and step in the DAG, its item, and its place in the DAG's array. */
export interface MemberRow {
  taskId: string;
  instanceId: string;
  ref: string;
  step: string;
  item: string | null;
  position: number;
}

interface InstanceRaw {
  instance_id: string;
  name: string | null;
  dag: string;
  dag_sha256: string;
  source: string;
  board: string;
  created_by: string;
  created_via: string;
  idempotency_key: string | null;
  created_at: number;
}

interface MemberRaw {
  task_id: string;
  instance_id: string;
  ref: string;
  step: string;
  item: string | null;
  position: number;
}

const INSTANCE_COLS = 'instance_id, name, dag, dag_sha256, source, board, created_by, created_via, idempotency_key, created_at';
const MEMBER_COLS = 'task_id, instance_id, ref, step, item, position';

/**
 * An instance found by its key, with the hash of its DAG's canonical form,
 * unmasked: how a repeated key tells the same DAG from another (workflows spec §6). Only
 * `keyRefused` reads the hash; it is never printed, so no `InstanceRow` holds it.
 */
export interface KeyedInstance {
  instance: InstanceRow;
  dagSha256: string;
}

function decodeInstance(r: InstanceRaw): InstanceRow {
  return {
    instanceId: r.instance_id,
    name: r.name,
    dag: JSON.parse(r.dag) as Dag,
    source: r.source as InstanceRow['source'],
    board: r.board,
    createdBy: r.created_by,
    createdVia: JSON.parse(r.created_via) as CreatedVia,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
  };
}

function decodeMember(r: MemberRaw): MemberRow {
  return { taskId: r.task_id, instanceId: r.instance_id, ref: r.ref, step: r.step, item: r.item, position: r.position };
}

/** Whether the database has the workflows' tables: one not yet migrated to 009 has none (workflows spec §7). */
export function hasWorkflows(db: Db): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kanban_workflow_tasks'").get() !== undefined;
}

export function getInstance(db: Db, instanceId: string): InstanceRow | undefined {
  const row = db.prepare<[string], InstanceRaw>(`SELECT ${INSTANCE_COLS} FROM kanban_workflow_instances WHERE instance_id = ?`).get(instanceId);
  return row === undefined ? undefined : decodeInstance(row);
}

export function instanceByKey(db: Db, idempotencyKey: string): KeyedInstance | undefined {
  const row = db
    .prepare<[string], InstanceRaw>(`SELECT ${INSTANCE_COLS} FROM kanban_workflow_instances WHERE idempotency_key = ?`)
    .get(idempotencyKey);
  return row === undefined ? undefined : { instance: decodeInstance(row), dagSha256: row.dag_sha256 };
}

/** An instance's members, in their DAG's order. */
export function membersOf(db: Db, instanceId: string): MemberRow[] {
  return db
    .prepare<[string], MemberRaw>(`SELECT ${MEMBER_COLS} FROM kanban_workflow_tasks WHERE instance_id = ? ORDER BY position`)
    .all(instanceId)
    .map(decodeMember);
}

/**
 * An instance's members in their DAG's order, each with its task, in two
 * queries whatever their number. A member's task is never missing: the members
 * table's foreign key holds it, and no task is ever deleted. Were one missing,
 * its member would be left out, so a read never throws on it.
 */
export function membersWithTasks(db: Db, instanceId: string): Array<MemberRow & { task: TaskRow }> {
  const tasks = new Map(
    db
      .prepare<[string], TaskRaw>(
        `SELECT ${taskCols(db)} FROM kanban_tasks WHERE task_id IN (SELECT task_id FROM kanban_workflow_tasks WHERE instance_id = ?)`,
      )
      .all(instanceId)
      .map((r) => [r.task_id, decodeTask(r)]),
  );
  return membersOf(db, instanceId).flatMap((m) => {
    const task = tasks.get(m.taskId);
    return task === undefined ? [] : [{ ...m, task }];
  });
}

/**
 * The phases of the members of a board's newest `limit` instances, as
 * `instancesOn` reads them, in one aggregate query: by instance, how many
 * members are in each phase. An instance with no member is absent.
 */
export function memberPhases(db: Db, board: string, limit: number): Map<string, Array<{ phase: Phase; n: number }>> {
  const rows = db
    .prepare<[string, number], { instance_id: string; phase: Phase; n: number }>(
      `SELECT m.instance_id, t.phase, count(*) AS n
         FROM kanban_workflow_tasks m JOIN kanban_tasks t ON t.task_id = m.task_id
        WHERE m.instance_id IN (SELECT instance_id FROM kanban_workflow_instances WHERE board = ?
                                 ORDER BY created_at DESC, rowid DESC LIMIT ?)
        GROUP BY m.instance_id, t.phase`,
    )
    .all(board, limit);
  const out = new Map<string, Array<{ phase: Phase; n: number }>>();
  for (const r of rows) out.set(r.instance_id, [...(out.get(r.instance_id) ?? []), { phase: r.phase, n: r.n }]);
  return out;
}

/**
 * The instance a task is a member of, with the instance's workflow name, for
 * `task show`'s line (workflows spec §10); undefined for a task that is none's, and on
 * a database not yet migrated, which has no members table.
 */
export function memberOf(db: Db, taskId: string): (MemberRow & { name: string | null }) | undefined {
  if (!hasWorkflows(db)) return undefined;
  const row = db
    .prepare<[string], MemberRaw & { name: string | null }>(
      `SELECT m.task_id, m.instance_id, m.ref, m.step, m.item, m.position, i.name
         FROM kanban_workflow_tasks m JOIN kanban_workflow_instances i ON i.instance_id = m.instance_id
        WHERE m.task_id = ?`,
    )
    .get(taskId);
  return row === undefined ? undefined : { ...decodeMember(row), name: row.name };
}

/** A board's instances, newest first, at most `limit` (workflows spec §10), and how many it has in all. */
export function instancesOn(db: Db, board: string, limit: number): { instances: InstanceRow[]; total: number } {
  const instances = db
    .prepare<[string, number], InstanceRaw>(
      `SELECT ${INSTANCE_COLS} FROM kanban_workflow_instances WHERE board = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(board, limit)
    .map(decodeInstance);
  const total = db.prepare<[string], { n: number }>('SELECT count(*) AS n FROM kanban_workflow_instances WHERE board = ?').get(board)?.n ?? 0;
  return { instances, total };
}

/**
 * An instance's related tasks (workflows spec §10): tasks that are not its members and
 * have a member as a parent, or as their `created_from_task`, oldest first.
 */
export function relatedTasks(db: Db, instanceId: string): TaskRow[] {
  return db
    .prepare<[string, string, string], TaskRaw>(
      `SELECT ${taskCols(db)} FROM kanban_tasks
        WHERE task_id NOT IN (SELECT task_id FROM kanban_workflow_tasks WHERE instance_id = ?)
          AND (created_from_task IN (SELECT task_id FROM kanban_workflow_tasks WHERE instance_id = ?)
               OR task_id IN (SELECT l.child_id FROM kanban_links l JOIN kanban_workflow_tasks m ON m.task_id = l.parent_id
                               WHERE m.instance_id = ?))
        ORDER BY created_at, rowid`,
    )
    .all(instanceId, instanceId, instanceId)
    .map(decodeTask);
}

/** One Unblock button of a recorded message, and the `unblocked` or `archived` event that lifted its block, if one has. */
export interface UnblockButtonReading {
  taskId: string;
  blockEvent: number;
  /** The event it was last redrawn for; null until then. */
  redrawnFor: number | null;
  /** False for a block the message told of without its button, deferred by the waker (wake spec §5.9). */
  hasButton: boolean;
  /** For a row with no button: its deferred button's state, if its row was written. */
  deferred?: DeferredState;
  /** A deferred button sent, whose card Lark took as text: no button came, so the typed command lifts it (wake spec §5.9). */
  deferredAsText?: boolean;
  /**
   * The first `unblocked` or `archived` event of the task after its block: how,
   * who lifted it, and when. An archive clears a block with no `unblocked` event.
   */
  lift?: Lift;
}

/** A recorded message of notices with Unblock buttons (spec §9.2, amended by the unblock redraw), its buttons in the order sent. */
export interface UnblockMessageReading {
  messageId: string;
  channel: string;
  appId: string;
  markdown: string;
  /** When it was sent, unix ms. */
  sentAt: number;
  buttons: UnblockButtonReading[];
}

interface UnblockButtonRaw {
  message_id: string;
  channel: string;
  app_id: string;
  task_id: string;
  block_event: number;
  markdown: string;
  sent_at: number;
  redrawn_for: number | null;
  lift_id: number | null;
  lift_kind: string | null;
  lift_actor: string | null;
  lift_at: number | null;
  lift_woken: number | null;
  has_button: number;
  deferred_state: string | null;
  deferred_text: number | null;
}

/**
 * The id of a block's lift, as SQL over two column expressions: the first
 * `unblocked` or `archived` event of the task past the event that blocked it, an
 * archive clearing a block without an unblock (kanban spec §9.2, amended by the
 * unblock redraw). The one reading of a lift, the unblock redraw's and the
 * waker's (wake spec §5.3b), so the two cannot disagree.
 */
function liftIdOf(taskId: string, blockEvent: string): string {
  return `SELECT min(id) FROM kanban_events WHERE task_id = ${taskId} AND kind IN ('unblocked', 'archived') AND id > ${blockEvent}`;
}

/** A block's lift: the event that lifted it, its kind, who, when, and whether a woken turn did it (wake spec §9.3). */
export interface Lift {
  eventId: number;
  kind: 'unblocked' | 'archived';
  actor: string;
  at: number;
  woken: boolean;
}

/** The lift of a task's block (wake spec §5.3b), or none while it stands. */
export function liftOf(db: Db, taskId: string, blockEvent: number): Lift | undefined {
  const r = db
    .prepare<[string, number], { id: number; kind: string; actor: string; created_at: number; woken: number }>(
      `SELECT id, kind, actor, created_at, json_extract(payload, '$.wake') IS NOT NULL AS woken
         FROM kanban_events WHERE id = (${liftIdOf('?', '?')})`,
    )
    .get(taskId, blockEvent);
  return r === undefined
    ? undefined
    : { eventId: r.id, kind: r.kind === 'archived' ? 'archived' : 'unblocked', actor: r.actor, at: r.created_at, woken: r.woken === 1 };
}

/**
 * A recorded message of notices, with each button's lift read from the log:
 * the first `unblocked` event of its task after the event that blocked it, as
 * the board's unblock reads it when it refuses a stale press, or the task's
 * archive, which clears a block without one. Undefined for a
 * message with no record, or another bot's.
 */
export function unblockMessage(db: Db, appId: string, messageId: string): UnblockMessageReading | undefined {
  // `has_button` and the deferred buttons (migration 013) only where they exist: every row before them is a button.
  // A deferred row is this message's by its notice_id: a task followed in two threads has a notice, and a row, in each.
  const deferred = hasWakeColumns(db)
    ? `b.has_button,
              (SELECT d.state FROM kanban_deferred_buttons d
                WHERE d.app_id = b.app_id AND d.notice_id = b.message_id AND d.event_id = b.block_event) AS deferred_state,
              (SELECT d.state = 'sent' AND NOT EXISTS (
                        SELECT 1 FROM kanban_unblock_buttons c
                         WHERE c.message_id = d.message_id AND c.app_id = d.app_id AND c.task_id = d.task_id)
                 FROM kanban_deferred_buttons d
                WHERE d.app_id = b.app_id AND d.notice_id = b.message_id AND d.event_id = b.block_event) AS deferred_text`
    : '1 AS has_button, NULL AS deferred_state, NULL AS deferred_text';
  const rows = db
    .prepare<[string, string], UnblockButtonRaw>(
      `SELECT b.message_id, b.channel, b.app_id, b.task_id, b.block_event, b.markdown, b.sent_at, b.redrawn_for,
              e.id AS lift_id, e.kind AS lift_kind, e.actor AS lift_actor, e.created_at AS lift_at,
              json_extract(e.payload, '$.wake') IS NOT NULL AS lift_woken,
              ${deferred}
         FROM kanban_unblock_buttons b
         LEFT JOIN kanban_events e ON e.id = (${liftIdOf('b.task_id', 'b.block_event')})
        WHERE b.message_id = ? AND b.app_id = ?
        ORDER BY b.block_event`,
    )
    .all(messageId, appId);
  const first = rows[0];
  if (first === undefined) return undefined;
  return {
    messageId: first.message_id,
    channel: first.channel,
    appId: first.app_id,
    markdown: first.markdown,
    sentAt: first.sent_at,
    buttons: rows.map((r) => ({
      taskId: r.task_id,
      blockEvent: r.block_event,
      redrawnFor: r.redrawn_for,
      hasButton: r.has_button !== 0,
      ...(r.has_button === 0 && r.deferred_state !== null ? { deferred: r.deferred_state as DeferredState } : {}),
      ...(r.has_button === 0 && r.deferred_text === 1 ? { deferredAsText: true } : {}),
      ...(r.lift_id === null || r.lift_actor === null || r.lift_at === null
        ? {}
        : {
            lift: {
              eventId: r.lift_id,
              kind: r.lift_kind === 'archived' ? ('archived' as const) : ('unblocked' as const),
              actor: r.lift_actor,
              at: r.lift_at,
              woken: r.lift_woken === 1,
            },
          }),
    })),
  };
}

/**
 * The messages with a button whose block has been lifted since it was sent, by
 * an unblock or the task's archive, and that has not been redrawn for it, oldest
 * first, at most `limit`. Each row's
 * `block_event` is its own cursor into the log: only `unblocked` and `archived` events past it
 * count, so an unblock written by any process, the terminal's included, is found
 * however long after, and a row recorded after its block was lifted too.
 */
export function unblockMessagesDue(db: Db, appId: string, limit: number): string[] {
  return db
    .prepare<[string, number], { message_id: string }>(
      `SELECT b.message_id FROM kanban_unblock_buttons b
        WHERE b.app_id = ? AND b.redrawn_for IS NULL
          AND EXISTS (SELECT 1 FROM kanban_events e WHERE e.task_id = b.task_id AND e.kind IN ('unblocked', 'archived') AND e.id > b.block_event)
        GROUP BY b.message_id
        ORDER BY min(b.sent_at), b.message_id
        LIMIT ?`,
    )
    .all(appId, limit)
    .map((r) => r.message_id);
}

// ---------------------------------------------------------------------------
// Wakes (wake spec §4.2)
// ---------------------------------------------------------------------------

interface WakeRaw {
  wake_id: number;
  uuid: string;
  channel: string;
  app_id: string;
  conversation_id: string;
  thread_id: string;
  principal: string;
  depth: number;
  state: string;
  attempt: number;
  session_id: string | null;
  turn_key: string | null;
  submit_boot: string | null;
  marker_at: number | null;
  created_at: number;
  delivered_at: number | null;
  closed_at: number | null;
  error: string | null;
  target_role: string | null;
  reaction_task: string | null;
}

function decodeWake(r: WakeRaw): WakeRow {
  return {
    wakeId: r.wake_id,
    uuid: r.uuid,
    channel: r.channel,
    appId: r.app_id,
    conversationId: r.conversation_id,
    threadId: r.thread_id,
    principal: r.principal,
    depth: r.depth,
    state: r.state as WakeState,
    attempt: r.attempt,
    sessionId: r.session_id,
    turnKey: r.turn_key,
    submitBoot: r.submit_boot,
    markerAt: r.marker_at,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
    closedAt: r.closed_at,
    error: r.error,
    targetRole: r.target_role,
    reactionTask: r.reaction_task,
  };
}

export function getWake(db: Db, wakeId: number): WakeRow | undefined {
  const r = db.prepare<[number], WakeRaw>('SELECT * FROM kanban_wakes WHERE wake_id = ?').get(wakeId);
  return r === undefined ? undefined : decodeWake(r);
}

export function wakeByUuid(db: Db, uuid: string): WakeRow | undefined {
  const r = db.prepare<[string], WakeRaw>('SELECT * FROM kanban_wakes WHERE uuid = ?').get(uuid);
  return r === undefined ? undefined : decodeWake(r);
}

/** The reaction tasks a task's outcomes made (wake spec §19.9): those whose wake carried an event of it, newest first. */
export function reactionsOf(db: Db, taskId: string): TaskRow[] {
  return db
    .prepare<[string], TaskRaw>(
      `SELECT ${taskCols(db)} FROM kanban_tasks
        WHERE reaction_of IN (SELECT wake_id FROM kanban_wake_events WHERE task_id = ?)
        ORDER BY created_at DESC, rowid DESC`,
    )
    .all(taskId)
    .map(decodeTask);
}

/**
 * The tasks a reaction task's wake carried (wake spec §19.9), each once, in the
 * order of their first event; null for a task that is no reaction task.
 */
export function reactsTo(db: Db, taskId: string): string[] | null {
  const task = getTask(db, taskId);
  if (task === undefined || task.reactionOf === null) return null;
  return [...new Set(wakeEventsOf(db, task.reactionOf).sort((a, b) => a.eventId - b.eventId).map((e) => e.taskId))];
}

/** A reaction task's wake (wake spec §19.8): the `kanban_wakes` row its `reaction_of` names; none for any other task. */
export function wakeOfReaction(db: Db, taskId: string): WakeRow | undefined {
  const task = getTask(db, taskId);
  return task === undefined || task.reactionOf === null ? undefined : getWake(db, task.reactionOf);
}

/** A woken turn's events, in event order. */
export function wakeEventsOf(db: Db, wakeId: number): WakeEventRow[] {
  return db
    .prepare<[number], { wake_id: number; subscription_id: number; event_id: number; task_id: string }>(
      'SELECT wake_id, subscription_id, event_id, task_id FROM kanban_wake_events WHERE wake_id = ? ORDER BY event_id, subscription_id',
    )
    .all(wakeId)
    .map((r) => ({ wakeId: r.wake_id, subscriptionId: r.subscription_id, eventId: r.event_id, taskId: r.task_id }));
}

/** A subscription with outcomes for the waker, and the id of its oldest due event. */
export interface DueWake extends SubscriptionRow {
  oldestDue: number;
}

/**
 * This bot's subscriptions the waker has something for (wake spec §5.2 step 2):
 * a task with wake on, or no longer on the board, with an event past its
 * `wake_cursor` and at or before its notice `cursor`, so the notice always goes
 * first (§5.8); each with its oldest such event. An event already in a pending
 * row is never due again, so no event is in two pending rows; and a conversation
 * with a pending row is left out altogether, every principal's batch in it,
 * stamped rows of this boot included, but for a stamped row whose session is no
 * longer the one bound at its key, as after `/new` or `/attach`.
 */
export function dueWakes(db: Db, appId: string): DueWake[] {
  return db
    .prepare<[string], SubscriptionRaw & { oldest_due: number | null }>(
      `SELECT * FROM (
         SELECT ${subscriptionCols(db)},
                (SELECT min(e.id) FROM kanban_events e
                  WHERE e.task_id = s.task_id AND e.id > s.wake_cursor AND e.id <= s.cursor
                    AND NOT EXISTS (
                      SELECT 1 FROM kanban_wake_events we JOIN kanban_wakes w ON w.wake_id = we.wake_id
                       WHERE w.state = 'pending' AND we.subscription_id = s.id AND we.event_id = e.id)) AS oldest_due
           FROM kanban_subscriptions s
          WHERE s.account_id = ?
            AND (SELECT t.wake_by IS NOT NULL FROM kanban_tasks t WHERE t.task_id = s.task_id) IS NOT 0
            AND NOT EXISTS (
              SELECT 1 FROM kanban_wakes w
               WHERE w.state = 'pending' AND w.app_id = s.account_id AND w.channel = s.channel
                 AND w.conversation_id = s.conversation_id AND w.thread_id = s.thread_id
                 AND (w.session_id IS NULL OR w.session_id IS (
                   SELECT b.session_id FROM channel_bindings b
                    WHERE b.channel = w.channel AND b.account_id = w.app_id AND b.conversation_id = w.conversation_id
                      AND b.thread_id = w.thread_id AND b.revoked_at IS NULL))))
        WHERE oldest_due IS NOT NULL
        ORDER BY id`,
    )
    .all(appId)
    // `WHERE oldest_due IS NOT NULL` keeps only rows with a due event, so it is never null here.
    .map((r) => ({ ...decodeSubscription(r), oldestDue: r.oldest_due as number }));
}

/**
 * The subscription id of a role's wake's events with no chat (wake spec
 * §19.16): no subscription has it, as ids start at 1, and its cursor is the
 * task's own `wake_cursor`.
 */
export const CHATLESS = 0;

/** A task with a role's wake and no chat (wake spec §19.16), due: its oldest event past its own cursor. */
export type DueTaskWake = TaskRow & { oldestDue: number };

/**
 * The tasks with a role's wake that no chat of this bot follows, with an event
 * past their own `wake_cursor` (wake spec §19.16), oldest first: read as soon
 * as written, as no notice comes first.
 */
export function dueTaskWakes(db: Db, appId: string): DueTaskWake[] {
  if (!hasWakeColumns(db)) return [];
  return db
    .prepare<[string], TaskRaw & { oldest_due: number }>(
      `SELECT * FROM (
         SELECT ${taskCols(db)},
                (SELECT min(e.id) FROM kanban_events e WHERE e.task_id = kanban_tasks.task_id AND e.id > kanban_tasks.wake_cursor) AS oldest_due
           FROM kanban_tasks
          WHERE wake_by IS NOT NULL AND wake_role IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM kanban_subscriptions s WHERE s.task_id = kanban_tasks.task_id AND s.account_id = ?))
        WHERE oldest_due IS NOT NULL
        ORDER BY oldest_due`,
    )
    .all(appId)
    .map((r) => ({ ...decodeTask(r), oldestDue: r.oldest_due }));
}

/**
 * The delivery times of a board's role wakes with no chat in the hour before
 * `now`, oldest first (wake spec §19.16): the per-hour cap of a wake with no
 * thread is the board's, its reaction tasks' board.
 */
export function boardWakesInLastHour(db: Db, appId: string, board: string, now: number): number[] {
  return db
    .prepare<[string, string, number], { delivered_at: number }>(
      `SELECT w.delivered_at FROM kanban_wakes w JOIN kanban_tasks t ON t.task_id = w.reaction_task
        WHERE w.app_id = ? AND w.conversation_id = '' AND w.state = 'delivered' AND t.board = ? AND w.delivered_at > ?
        ORDER BY w.delivered_at`,
    )
    .all(appId, board, now - 60 * 60_000)
    .map((r) => r.delivered_at);
}

/** This bot's pending wakes, oldest first (wake spec §5.2 step 1). */
export function pendingWakes(db: Db, appId: string): WakeRow[] {
  return db
    .prepare<[string], WakeRaw>("SELECT * FROM kanban_wakes WHERE app_id = ? AND state = 'pending' ORDER BY wake_id")
    .all(appId)
    .map(decodeWake);
}

/**
 * The delivery times of a conversation's delivered wakes in the hour before
 * `now`, oldest first (wake spec §5.4): the per-hour cap's count, all principals
 * together, and when the oldest of them turns an hour old.
 */
export function wakesInLastHour(db: Db, at: ThreadAt, now: number): number[] {
  return db
    .prepare<[string, string, string, string, number], { delivered_at: number }>(
      `SELECT delivered_at FROM kanban_wakes
        WHERE app_id = ? AND channel = ? AND conversation_id = ? AND thread_id = ? AND state = 'delivered' AND delivered_at > ?
        ORDER BY delivered_at`,
    )
    .all(at.appId, at.channel, at.conversationId, at.threadId, now - 60 * 60_000)
    .map((r) => r.delivered_at);
}

/**
 * The woken turn a shell is in (wake spec §9.1): the delivered wake whose session
 * is the shell's marker's and whose turn key is that session's running turn's,
 * the one open turn past `pending`, as the actor runs one at a time. None for a
 * turn a person typed, between turns, and for a wake not yet delivered.
 */
export function wakeOfShell(db: Db, sessionId: string): WakeRow | undefined {
  if (!hasWakeColumns(db)) return undefined;
  const running = openTurns(db, sessionId).find((t) => t.state !== 'pending');
  if (running === undefined) return undefined;
  const r = db
    .prepare<[string, string], WakeRaw>("SELECT * FROM kanban_wakes WHERE session_id = ? AND turn_key = ? AND state = 'delivered'")
    .get(sessionId, running.idempotencyKey);
  return r === undefined ? undefined : decodeWake(r);
}

/**
 * How many tasks have wake on (wake spec §11): what the startup line says stay
 * notice-only while wakes are off. None on a database before migration 013.
 */
export function tasksWithWakeOn(db: Db): number {
  if (!hasWakeColumns(db)) return 0;
  return db.prepare<[], { n: number }>('SELECT count(*) AS n FROM kanban_tasks WHERE wake_by IS NOT NULL').get()?.n ?? 0;
}

/** When a task's latest delivered wake was delivered (wake spec §10), or none. */
export function lastWokeOf(db: Db, taskId: string): number | undefined {
  if (!hasWakeColumns(db)) return undefined;
  const r = db
    .prepare<[string], { at: number | null }>(
      `SELECT max(w.delivered_at) AS at FROM kanban_wake_events we JOIN kanban_wakes w ON w.wake_id = we.wake_id
        WHERE we.task_id = ? AND w.state = 'delivered'`,
    )
    .get(taskId);
  return r?.at ?? undefined;
}

/**
 * A task's unblocks by woken turns since it last completed, or since it was made
 * (wake spec §9.2): its `unblocked` events with `wake` in their payload, whatever
 * the block's kind.
 */
export function wokenUnblocksSince(db: Db, taskId: string): number {
  return (
    db
      .prepare<[string, string], { n: number }>(
        `SELECT count(*) AS n FROM kanban_events
          WHERE task_id = ? AND kind = 'unblocked' AND json_extract(payload, '$.wake') IS NOT NULL
            AND id > coalesce((SELECT max(id) FROM kanban_events WHERE task_id = ? AND kind = 'completed'), 0)`,
      )
      .get(taskId, taskId)?.n ?? 0
  );
}

/** A subscription by its id. */
export function getSubscription(db: Db, subscriptionId: number): SubscriptionRow | undefined {
  const r = db.prepare<[number], SubscriptionRaw>(`SELECT ${subscriptionCols(db)} FROM kanban_subscriptions WHERE id = ?`).get(subscriptionId);
  return r === undefined ? undefined : decodeSubscription(r);
}

/** A wake's outcomes (wake spec §4.2): each pair's subscription and its event, in event order. */
export function wakeOutcomesOf(db: Db, wakeId: number): Array<{ subscriptionId: number; event: KanbanEvent }> {
  return db
    .prepare<[number], EventRaw & { subscription_id: number }>(
      `SELECT we.subscription_id, e.id, e.task_id, e.run_id, e.kind, e.actor, json(e.payload) AS payload, e.created_at
         FROM kanban_wake_events we JOIN kanban_events e ON e.id = we.event_id
        WHERE we.wake_id = ? ORDER BY e.id, we.subscription_id`,
    )
    .all(wakeId)
    .map((r) => ({ subscriptionId: r.subscription_id, event: decodeEvent(r) }));
}

/** Whether a message of notices carries an Unblock button for this block event (wake spec §7), as recorded. */
export function hasUnblockButton(db: Db, appId: string, taskId: string, blockEvent: number): boolean {
  const button = hasWakeColumns(db) ? ' AND has_button = 1' : '';
  return (
    db
      .prepare<[string, string, number], { n: number }>(
        `SELECT count(*) AS n FROM kanban_unblock_buttons WHERE app_id = ? AND task_id = ? AND block_event = ?${button}`,
      )
      .get(appId, taskId, blockEvent)?.n !== 0
  );
}

// ---------------------------------------------------------------------------
// Deferred Unblock buttons (wake spec §5.9)
// ---------------------------------------------------------------------------

interface DeferredButtonRaw {
  subscription_id: number;
  event_id: number;
  task_id: string;
  app_id: string;
  held_at: number;
  notice_id: string | null;
  state: string;
  why: string | null;
  attempts: number;
  message_id: string | null;
  ended_at: number | null;
}

const DEFERRED_COLS = 'subscription_id, event_id, task_id, app_id, held_at, notice_id, state, why, attempts, message_id, ended_at';

function decodeDeferred(r: DeferredButtonRaw): DeferredButtonRow {
  return {
    subscriptionId: r.subscription_id,
    eventId: r.event_id,
    taskId: r.task_id,
    appId: r.app_id,
    heldAt: r.held_at,
    noticeId: r.notice_id,
    state: r.state as DeferredState,
    why: r.why as DeferredWhy | null,
    attempts: r.attempts,
    messageId: r.message_id,
    endedAt: r.ended_at,
  };
}

/** A deferred button, by its subscription and block event; none on a database before migration 013. */
export function deferredButton(db: Db, subscriptionId: number, eventId: number): DeferredButtonRow | undefined {
  if (!hasWakeColumns(db)) return undefined;
  const r = db
    .prepare<[number, number], DeferredButtonRaw>(`SELECT ${DEFERRED_COLS} FROM kanban_deferred_buttons WHERE subscription_id = ? AND event_id = ?`)
    .get(subscriptionId, eventId);
  return r === undefined ? undefined : decodeDeferred(r);
}

/**
 * The wakes that carry a subscription's event and may still tell the agent of
 * it, `pending` or `delivered`, the newest first (wake spec §5.9): what a held
 * deferred button waits on.
 */
export function wakesOfEvent(db: Db, subscriptionId: number, eventId: number): WakeRow[] {
  return db
    .prepare<[number, number], WakeRaw>(
      `SELECT w.* FROM kanban_wakes w JOIN kanban_wake_events we ON we.wake_id = w.wake_id
        WHERE we.subscription_id = ? AND we.event_id = ? AND w.state IN ('pending', 'delivered')
        ORDER BY w.wake_id DESC`,
    )
    .all(subscriptionId, eventId)
    .map(decodeWake);
}

/** This bot's deferred buttons still `held` or `due` (wake spec §5.9), the oldest held first: what each round releases and sends. */
export function deferredButtons(db: Db, appId: string): DeferredButtonRow[] {
  if (!hasWakeColumns(db)) return [];
  return db
    .prepare<[string], DeferredButtonRaw>(
      `SELECT ${DEFERRED_COLS} FROM kanban_deferred_buttons WHERE app_id = ? AND state IN ('held', 'due') ORDER BY held_at, subscription_id, event_id`,
    )
    .all(appId)
    .map(decodeDeferred);
}

// ---------------------------------------------------------------------------
// Progress cards (progress cards spec §2, §4, §5)
// ---------------------------------------------------------------------------

export type ProgressCardState = 'open' | 'final' | 'let_go';

/** One board run's progress card, as `kanban_progress_cards` records it (migration 014). */
export interface ProgressCardRow {
  runId: string;
  taskId: string;
  appId: string;
  channel: string;
  messageId: string | null;
  readSeq: number;
  drawnAt: number | null;
  failures: number;
  state: ProgressCardState;
  tryNumber: number;
  tryLimit: number;
  openedAt: number;
}

interface ProgressCardRaw {
  run_id: string;
  task_id: string;
  app_id: string;
  channel: string;
  message_id: string | null;
  read_seq: number;
  drawn_at: number | null;
  failures: number;
  state: string;
  try_number: number;
  try_limit: number;
  opened_at: number;
}

function decodeProgressCard(r: ProgressCardRaw): ProgressCardRow {
  return {
    runId: r.run_id,
    taskId: r.task_id,
    appId: r.app_id,
    channel: r.channel,
    messageId: r.message_id,
    readSeq: r.read_seq,
    drawnAt: r.drawn_at,
    failures: r.failures,
    state: r.state as ProgressCardState,
    tryNumber: r.try_number,
    tryLimit: r.try_limit,
    openedAt: r.opened_at,
  };
}

const PROGRESS_COLS = 'run_id, task_id, app_id, channel, message_id, read_seq, drawn_at, failures, state, try_number, try_limit, opened_at';

/** A run's progress card, in any state. */
export function progressCard(db: Db, runId: string): ProgressCardRow | undefined {
  const r = db.prepare<[string], ProgressCardRaw>(`SELECT ${PROGRESS_COLS} FROM kanban_progress_cards WHERE run_id = ?`).get(runId);
  return r === undefined ? undefined : decodeProgressCard(r);
}

/** This bot's progress cards still `open`, the oldest first: what each round draws. */
export function openProgressCards(db: Db, appId: string): ProgressCardRow[] {
  return db
    .prepare<[string], ProgressCardRaw>(
      `SELECT ${PROGRESS_COLS} FROM kanban_progress_cards WHERE app_id = ? AND state = 'open' ORDER BY opened_at, rowid`,
    )
    .all(appId)
    .map(decodeProgressCard);
}

/** How many progress cards are still `open`, any bot's: what the startup line says is left with the switch off. */
export function countOpenProgressCards(db: Db): number {
  return db.prepare<[], { n: number }>("SELECT count(*) AS n FROM kanban_progress_cards WHERE state = 'open'").get()?.n ?? 0;
}

/** A run due a progress card, with the subscription of this bot its card would go to. */
export interface ProgressDue {
  run: RunRow;
  sub: SubscriptionRow;
}

/**
 * The runs due a progress card (progress cards spec §2, §7.2): open, undecided
 * agent runs started by `startedBy`, with no row yet, oldest first, each with
 * its task's first subscription of this bot, when that is in a thread, at chat
 * scope in a direct message, or at chat scope with a null `chat_type`, which
 * the loop judges through `chatKindOf`. A group's chat scope is none.
 */
export function progressDue(db: Db, appId: string, startedBy: number): ProgressDue[] {
  const runs = db
    .prepare<[number], RunRaw>(
      `SELECT ${RUN_COLS} FROM kanban_runs r
        WHERE r.ended_at IS NULL AND r.outcome IS NULL AND r.assignee_kind = 'role' AND r.started_at <= ?
          AND NOT EXISTS (SELECT 1 FROM kanban_progress_cards c WHERE c.run_id = r.run_id)
        ORDER BY r.started_at, r.rowid`,
    )
    .all(startedBy)
    .map(decodeRun);
  const due: ProgressDue[] = [];
  for (const run of runs) {
    const sub = subscriptionsOf(db, run.taskId).find((s) => s.appId === appId);
    if (sub === undefined) continue;
    if (sub.threadId !== '' || sub.chatType !== 'group') due.push({ run, sub });
  }
  return due;
}

/** The run's latest event of `kind`: its `run_ended`, or its `stopped`. */
function lastEventOfRun(db: Db, taskId: string, runId: string, kind: string): KanbanEvent | undefined {
  const r = db
    .prepare<[string, string, string], EventRaw>(
      `SELECT id, task_id, run_id, kind, actor, json(payload) AS payload, created_at
         FROM kanban_events WHERE task_id = ? AND run_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId, runId, kind);
  return r === undefined ? undefined : decodeEvent(r);
}

/** A run's `run_ended`, which says what came after a failure: retried, or blocked, and how (spec §9.4). */
export function runEndedOf(db: Db, taskId: string, runId: string): KanbanEvent | undefined {
  return lastEventOfRun(db, taskId, runId, 'run_ended');
}

/** A run's `stopped`, whose actor asked for the stop. */
export function stoppedOf(db: Db, taskId: string, runId: string): KanbanEvent | undefined {
  return lastEventOfRun(db, taskId, runId, 'stopped');
}

/**
 * A chat's kind, from any subscription of this bot on this channel at that chat
 * that knows it (progress cards spec §2): for a subscription whose own
 * `chat_type` is null. Never written back.
 */
export function chatKindOf(db: Db, appId: string, channel: string, conversationId: string): 'p2p' | 'group' | undefined {
  if (!hasWakeColumns(db)) return undefined;
  const r = db
    .prepare<[string, string, string], { chat_type: string }>(
      `SELECT chat_type FROM kanban_subscriptions
        WHERE account_id = ? AND channel = ? AND conversation_id = ? AND chat_type IS NOT NULL LIMIT 1`,
    )
    .get(appId, channel, conversationId);
  return r?.chat_type === 'p2p' || r?.chat_type === 'group' ? r.chat_type : undefined;
}
