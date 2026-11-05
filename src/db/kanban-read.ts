import type { Db } from './open.js';
import { displayStatus, type DisplayStatus } from '../kanban/status.js';
import type {
  ActivePhase,
  AgentSnapshot,
  Assignee,
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
  };
}

const TASK_COLS = `task_id, title, body, json(contract) AS contract, assignee_kind, assignee,
  reviewer_kind, reviewer, workspace, phase, blocked_from, block_kind, block_reason, priority,
  idempotency_key, failure_limit, retry_on_crash, max_runtime_s, consecutive_failures,
  consecutive_transient, cooldown_until, block_recurrences, stranded_notified_at, created_by,
  json(created_via) AS created_via, created_at, closed_at, created_from_task`;

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
  const row = db.prepare<[string], TaskRaw>(`SELECT ${TASK_COLS} FROM kanban_tasks WHERE task_id = ?`).get(taskId);
  return row === undefined ? undefined : decodeTask(row);
}

export function getTaskByKey(db: Db, idempotencyKey: string): TaskRow | undefined {
  const row = db
    .prepare<[string], TaskRaw>(`SELECT ${TASK_COLS} FROM kanban_tasks WHERE idempotency_key = ?`)
    .get(idempotencyKey);
  return row === undefined ? undefined : decodeTask(row);
}

export function parentsOf(db: Db, taskId: string): TaskRow[] {
  return db
    .prepare<[string], TaskRaw>(
      `SELECT ${TASK_COLS} FROM kanban_tasks
        WHERE task_id IN (SELECT parent_id FROM kanban_links WHERE child_id = ?)
        ORDER BY created_at, rowid`,
    )
    .all(taskId)
    .map(decodeTask);
}

export function childrenOf(db: Db, taskId: string): TaskRow[] {
  return db
    .prepare<[string], TaskRaw>(
      `SELECT ${TASK_COLS} FROM kanban_tasks
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
 * `/kanban show` gives them to people.
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
  cursor: number;
  created_at: number;
}

function decodeSubscription(r: SubscriptionRaw): SubscriptionRow {
  return {
    id: r.id,
    taskId: r.task_id,
    channel: r.channel,
    appId: r.account_id,
    conversationId: r.conversation_id,
    threadId: r.thread_id,
    cursor: r.cursor,
    createdAt: r.created_at,
  };
}

const SUBSCRIPTION_COLS = 'id, task_id, channel, account_id, conversation_id, thread_id, cursor, created_at';

/** The chats following a task, in the order they were subscribed (spec §9.4). */
export function subscriptionsOf(db: Db, taskId: string): SubscriptionRow[] {
  return db
    .prepare<[string], SubscriptionRaw>(
      `SELECT ${SUBSCRIPTION_COLS} FROM kanban_subscriptions WHERE task_id = ? ORDER BY id`,
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
         SELECT ${SUBSCRIPTION_COLS},
                (SELECT min(e.id) FROM kanban_events e WHERE e.task_id = s.task_id AND e.id > s.cursor) AS oldest_pending
           FROM kanban_subscriptions s
          WHERE s.account_id = ?)
        WHERE oldest_pending IS NOT NULL
        ORDER BY id`,
    )
    .all(appId)
    .map((r) => ({ ...decodeSubscription(r), oldestPending: r.oldest_pending ?? 0 }));
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

/** The task as `/kanban show` and `mt kanban show` present it. */
export interface TaskView {
  task: TaskRow;
  status: DisplayStatus;
  parents: TaskRow[];
  children: TaskRow[];
  runs: RunRow[];
  comments: CommentRow[];
}

export function taskView(db: Db, taskId: string): TaskView | undefined {
  const task = getTask(db, taskId);
  if (task === undefined) return undefined;
  const parents = parentsOf(db, taskId);
  const runs = runsOf(db, taskId);
  const undecided = runs.find((r) => r.outcome === null);
  return {
    task,
    status: displayStatus({
      phase: task.phase,
      parentsFinished: parents.every((p) => isFinished(p.phase)),
      undecidedRun: undecided?.kind,
    }),
    parents,
    children: childrenOf(db, taskId),
    runs,
    comments: commentsOf(db, taskId),
  };
}

/** A task on the board, with what a person sees of it (spec §4.1). */
export interface BoardEntry {
  task: TaskRow;
  status: DisplayStatus;
}

/**
 * Every task, with its display status, highest priority first, then oldest:
 * `/kanban list` (spec §9.1). The status is derived here, from the parents and
 * the runs, as `taskView` derives it.
 */
export function boardList(db: Db): BoardEntry[] {
  return db
    .prepare<[], TaskRaw>(`SELECT ${TASK_COLS} FROM kanban_tasks ORDER BY priority DESC, created_at, rowid`)
    .all()
    .map(decodeTask)
    .map((task) => ({
      task,
      status: displayStatus({
        phase: task.phase,
        parentsFinished: parentsOf(db, task.taskId).every((p) => isFinished(p.phase)),
        undecidedRun: runsOf(db, task.taskId).find((r) => r.outcome === null)?.kind,
      }),
    }));
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
      `SELECT ${TASK_COLS} FROM kanban_tasks t
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
 * A review run's summary is the reviewer's approval ("LGTM"), not the work: when
 * the completing run is a review, the handoff is the latest work run that asked
 * for review, as the reviewer was given it (spec §4.4).
 */
export function latestCompletion(db: Db, taskId: string): Completion | undefined {
  const event = db
    .prepare<[string], EventRaw>(
      `SELECT id, task_id, run_id, kind, actor, json(payload) AS payload, created_at
         FROM kanban_events WHERE task_id = ? AND kind = 'completed' ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId);
  if (event === undefined) return undefined;
  let run = event.run_id === null ? undefined : getRun(db, event.run_id);
  if (run?.kind === 'review') run = latestReviewRequested(db, taskId) ?? run;
  if (run !== undefined) return { summary: run.summary ?? '', metadata: run.metadata, runId: run.runId };
  const payload = json(event.payload) as { summary?: unknown };
  return { summary: typeof payload.summary === 'string' ? payload.summary : '', metadata: null, runId: null };
}

/** The task's latest work run that ended asking for review: the handoff a reviewer reviewed. */
function latestReviewRequested(db: Db, taskId: string): RunRow | undefined {
  const row = db
    .prepare<[string], RunRaw>(
      `SELECT ${RUN_COLS} FROM kanban_runs
        WHERE task_id = ? AND kind = 'work' AND outcome = 'review_requested'
        ORDER BY attempt DESC LIMIT 1`,
    )
    .get(taskId);
  return row === undefined ? undefined : decodeRun(row);
}
