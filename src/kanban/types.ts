/**
 * The board's vocabulary (spec §3–§5): phases, block kinds, run outcomes, and
 * the rows db/kanban.ts reads and writes.
 *
 * Refusals are values, not exceptions, because nearly every one is something a
 * person in chat or an agent through `mt kanban` must be told, and act on: the
 * `code` is what an agent branches on, the `message` what a person reads.
 */

/** The only stored lifecycle state (spec §4.1). */
const PHASES = ['open', 'review', 'blocked', 'done', 'archived'] as const;
export type Phase = (typeof PHASES)[number];

/** The phases a block can return to. */
export type ActivePhase = 'open' | 'review';

/**
 * Why a task is blocked (spec §5.4). `dependency` never sits in `blocked`: the
 * task keeps its phase, open or review, and its next claim waits for the parents
 * the block names. `gave_up` is the breaker's.
 */
export const BLOCK_KINDS = ['dependency', 'needs_input', 'capability', 'transient', 'gave_up'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];
/** A block kind a worker or a person may report. */
export type ReportedBlockKind = Exclude<BlockKind, 'gave_up'>;

export type RunKind = 'work' | 'review';

/** Outcomes a run's own report sets (spec §5.2). */
export const REPORTED_OUTCOMES = ['completed', 'review_requested', 'changes_requested', 'blocked'] as const;
/**
 * Outcomes recorded when a run ends without a report: the classifier's (§8.1),
 * and the dispatcher's own (§6.4). Only ever written on an undecided run.
 */
export const ENDED_OUTCOMES = [
  'failed',
  'crashed',
  'timed_out',
  'protocol_violation',
  'rate_limited',
  'terminal_provider',
  'interrupted',
] as const;
/** Recorded by a person's action, not by the run: `/kanban task stop`, assign, archive. */
export const SUPERSEDING_OUTCOMES = ['cancelled', 'superseded'] as const;

export type ReportedOutcome = (typeof REPORTED_OUTCOMES)[number];
export type EndedOutcome = (typeof ENDED_OUTCOMES)[number];
export type RunOutcome = ReportedOutcome | EndedOutcome | (typeof SUPERSEDING_OUTCOMES)[number];

export type RetryOnCrash = 'always' | 'if-no-side-effects';

/** A role, by name, or a person, by principal (`lark:<union_id>`) (spec §4.2). */
export interface Assignee {
  kind: 'role' | 'human';
  name: string;
}

/** The completion contract (spec §4.3). Every field optional. */
export const CONTRACT_FIELDS = ['outcome', 'verification', 'constraints', 'boundaries', 'stop_when'] as const;
export type Contract = Partial<Record<(typeof CONTRACT_FIELDS)[number], string>>;

/**
 * Where a task came from (spec §3.1): the chat it was created in, the run that
 * created it, or an operator's `mt kanban task new` at a terminal, which no chat
 * follows. A chat's `rootId`, for a command typed in a thread, is the thread's
 * root message, which a send in the thread replies to (spec §19.4); never set at
 * chat scope.
 */
export type CreatedVia =
  | {
      kind: 'chat';
      channel: string;
      appId: string;
      conversationId: string;
      threadId: string;
      rootId?: string;
      /** The chat's kind, from the message (wake spec §2.1): written to the task's subscription, so a wake can tell a direct message. */
      chatType?: 'p2p' | 'group';
    }
  | { kind: 'run'; runId: string }
  | { kind: 'operator' };

/**
 * A chat the terminal names to follow what it makes (kanban spec §22.1,
 * workflows spec §18.1): this bot's app id, the chat, and the thread, `''` at
 * chat scope, with its root, the message every send in it replies to, null at
 * chat scope. Beside `createdVia`, which stays the operator's: a terminal's
 * task is not recorded as a chat's.
 */
export interface Follow {
  appId: string;
  chatId: string;
  threadId: string;
  rootId: string | null;
}

/**
 * Who is reporting. A run reports through its token (plan C3); a person through
 * chat (plan D). Who may act is checked by the caller; what the rows allow, here.
 *
 * A person's report from chat is bound to what the caller checked (spec §9.1,
 * §9.2), and the board checks it again inside its transaction, so nothing that
 * changed in between -- while the report's gates ran -- lets it decide work that
 * is no longer the person's:
 * - `runId`: the run the report is on -- a card's run, or the task's open run
 *   when a typed report was checked -- or `null` when none was open then, so
 *   that a run opened since refuses it. Left out, any open person's run is decided.
 * - `as`: what the person reports as. `assignee`: the task must still be theirs,
 *   and open. `reviewer`: still in review, and still theirs to review.
 *   `operator`: still in review, whoever reviews it (an operator may answer any
 *   review). Left out, nobody named is checked.
 * Either refusal is `run_superseded`: the task has moved on.
 */
export type Reporter =
  | { kind: 'run'; runId: string }
  | { kind: 'person'; principal: string; runId?: string | null; as?: PersonReportsAs };

/** What a person reports as (`Reporter.as`). */
export type PersonReportsAs = 'assignee' | 'reviewer' | 'operator';

export interface TaskRow {
  taskId: string;
  title: string;
  body: string;
  contract: Contract;
  assignee: Assignee | null;
  reviewer: Assignee | null;
  /** Fixed once non-null (spec §2.3). */
  workspace: string | null;
  phase: Phase;
  blockedFrom: ActivePhase | null;
  blockKind: Exclude<BlockKind, 'dependency'> | null;
  blockReason: string | null;
  priority: number;
  idempotencyKey: string | null;
  failureLimit: number | null;
  retryOnCrash: RetryOnCrash;
  maxRuntimeS: number | null;
  consecutiveFailures: number;
  consecutiveTransient: number;
  cooldownUntil: number | null;
  blockRecurrences: number;
  strandedNotifiedAt: number | null;
  createdBy: string;
  createdVia: CreatedVia;
  createdAt: number;
  closedAt: number | null;
  createdFromTask: string | null;
  /** The board the task is on (spec §16): fixed at creation, and its follow-ups' too. */
  board: string;
  /**
   * Its own directory's id, `wt:<task_id>`, for a task in an isolated workspace
   * (spec §18): decided at its first agent claim and fixed; null, the workspace's
   * shared directory.
   */
  worktree: string | null;
  /**
   * The principal its woken turns run as, `lark:<union_id>` (wake spec §3.2,
   * migration 013); null: wake off.
   */
  wakeBy: string | null;
  /** Woken turns in its making (wake spec §5.4): 0 for a person's or the terminal's task. */
  wakeDepth: number;
  /** The role its wake targets (wake spec §19.1); null: the conversation's chat session. Only with `wakeBy` set. */
  wakeRole: string | null;
  /** For a reaction task (wake spec §19.3): the wake that made it; null for every other task. */
  reactionOf: number | null;
  /** Made under a wake (wake spec §19.8): the root reaction task's id, its own for a reaction task; null otherwise. */
  wakeRoot: string | null;
  /**
   * A role's wake on a task no chat follows (wake spec §19.16): the last event the
   * waker has covered for it, from the task's own cursor; unused while a chat follows it.
   */
  wakeCursor: number;
}

/** The board every task was on before there were others, and every chat starts on (spec §16). */
export const DEFAULT_BOARD = 'default';

/**
 * A board (spec §16): a queue of tasks, with its own list in chat and its own
 * turn in each dispatcher pass. One database and one dispatcher serve them all.
 */
export interface BoardRow {
  /** The role grammar (spec §2.1); never renamed. */
  name: string;
  /** Open agent runs on this board at once, inside the gateway's `kanban.max_running`; null for no limit of its own. */
  maxRunning: number | null;
  /** The workspace of a task on this board that no other rule gives one (spec §2.3 rule 4); null for `default`. */
  workspace: string | null;
  createdBy: string;
  createdAt: number;
  updatedBy: string | null;
  updatedAt: number | null;
  /** Set once archived: no task is added to it, and no chat moves onto it. */
  archivedAt: number | null;
}

/** A chat, for the board it is on: a conversation, for one bot, with all its threads (spec §16). */
export interface ChatAt {
  channel: string;
  appId: string;
  conversationId: string;
}

/** An agent run's agent, as it was at the claim. Environment names only, never values. */
export interface AgentSnapshot {
  driver: string;
  command: string;
  args: readonly string[];
  unsupervised: boolean;
  envNames: readonly string[];
  /**
   * Whether the run's role reached its agent as a native package (plan R).
   * Recorded once, by the dispatcher, just after the claim, when the render has
   * been decided: rendered, or put in the prompt. Absent on a run claimed before
   * plan R, or one whose start stopped before it was recorded.
   */
  native?: boolean;
  /** The native package's content hash: its directory's name under `$MT_HOME/rendered/<role>/`. */
  packageHash?: string;
}

/** How a run's role reached its agent (plan R): as a native package, or in the prompt. */
export type Rendering = { native: true; packageHash: string } | { native: false };

export interface RunRow {
  runId: string;
  taskId: string;
  attempt: number;
  kind: RunKind;
  /** A snapshot at the claim: reassigning the task does not rewrite it. */
  assignee: Assignee;
  /** Null for a person's run. */
  agentConfig: AgentSnapshot | null;
  workspace: string | null;
  roleMdHash: string | null;
  sessionId: string | null;
  seededFromRun: string | null;
  tokenHash: string | null;
  /** Null until decided. */
  outcome: RunOutcome | null;
  summary: string | null;
  metadata: unknown;
  reportedCommit: string | null;
  reportedDirty: boolean | null;
  error: string | null;
  lastOutput: string | null;
  submissions: number;
  startedAt: number;
  /** Null while open. */
  endedAt: number | null;
}

/**
 * A quality gate (spec §7.7): a shell command that must exit 0, in the task's
 * workspace, before the task may complete or go to review. Defined by an
 * operator, never by a run; stored as written, never masked, since a masked
 * command would run broken -- one that holds a known secret is refused instead
 * (spec §10.1).
 */
export interface GateRow {
  id: number;
  taskId: string;
  command: string;
  timeoutS: number;
  /** Who defined it (spec §10). */
  createdBy: string;
  createdAt: number;
}

/** What a task's gates may be: each command, timeout, and all of them together. */
export const GATE_LIMITS = {
  /** A command's size, in UTF-8 bytes. */
  commandBytes: 4 * 1024,
  /** A gate's timeout when none is given, as the schema's default. */
  defaultTimeoutS: 300,
  /** The longest one gate may run. */
  maxTimeoutS: 600,
  /**
   * The longest all of a task's gates may run, one after another: a report waits
   * for them, and `mt kanban` waits 15 minutes for its answer.
   */
  totalTimeoutS: 600,
  /** Gates on one task. */
  perTask: 20,
} as const;

export interface CommentRow {
  id: number;
  taskId: string;
  author: string;
  body: string;
  createdAt: number;
}

export interface KanbanEvent {
  id: number;
  taskId: string;
  runId: string | null;
  kind: string;
  actor: string;
  payload: unknown;
  createdAt: number;
}

/** Where a woken turn stands (wake spec §4.2): `pending` until it is delivered, dropped, or closed with its blocks lifted. */
export type WakeState = 'pending' | 'delivered' | 'dropped' | 'lifted';

/**
 * A woken turn (wake spec §4.2): one row a batch, its events in
 * `kanban_wake_events`, fixed once recorded; the current attempt's session, turn
 * key and boot while it is submitted.
 */
export interface WakeRow {
  wakeId: number;
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
  state: WakeState;
  /** The submit it is on; a refusal adds one. */
  attempt: number;
  sessionId: string | null;
  turnKey: string | null;
  submitBoot: string | null;
  markerAt: number | null;
  createdAt: number;
  deliveredAt: number | null;
  closedAt: number | null;
  /** The last refusal, or the check a drop failed, masked. */
  error: string | null;
  /** A role's wake (wake spec §19): the role, and the reaction task it made; null for a chat turn. */
  targetRole: string | null;
  reactionTask: string | null;
}

/** Where a deferred Unblock button stands (wake spec §5.9): `held` for the agent, `due` to people, then ended once. */
export type DeferredState = 'held' | 'due' | 'sent' | 'lifted' | 'failed';

/** Why a deferred button is due (wake spec §5.9), which its card's text says. */
export type DeferredWhy = 'tried' | 'not_woken' | 'turn_failed' | 'running' | 'restart';

/** A deferred button's key: the subscription whose notice left it out, and the block event (wake spec §4.2). */
export interface DeferredKey {
  subscriptionId: number;
  eventId: number;
}

/**
 * A block's Unblock button the waker deferred (wake spec §5.9): written `held`
 * once its notice, without the button, was sent; `due` once the agent has had
 * its try or will get none; then `sent`, with its card, `lifted`, or `failed`.
 */
export interface DeferredButtonRow extends DeferredKey {
  taskId: string;
  appId: string;
  /** When its notice, without the button, was sent. */
  heldAt: number;
  state: DeferredState;
  why: DeferredWhy | null;
  /** Sends of the button card tried. */
  attempts: number;
  /** The button card, once sent. */
  messageId: string | null;
  endedAt: number | null;
}

/** One outcome a woken turn was told of (wake spec §4.2). */
export interface WakeEventRow {
  wakeId: number;
  subscriptionId: number;
  eventId: number;
  taskId: string;
}

/**
 * A chat following a task (spec §9.4): the binding key its notices go to, and
 * the last `kanban_events` id delivered there, or passed over as no notice.
 */
export interface SubscriptionRow {
  id: number;
  taskId: string;
  channel: string;
  /** The bot's app id: the schema's `account_id`. */
  appId: string;
  conversationId: string;
  threadId: string;
  /**
   * The thread's root message, which a send in the thread replies to (spec §19.4,
   * migration 008); null at chat scope, in a direct message, and for a thread
   * whose root was never recorded. Only a subscription with one is a thread a
   * person's card can go to.
   */
  rootMessageId: string | null;
  cursor: number;
  createdAt: number;
  /**
   * The waker's cursor (wake spec §4.1, migration 013): the last event it has
   * covered, woken, skipped or passed over, beside `cursor`, the notifier's.
   */
  wakeCursor: number;
  /** The chat's kind, from the command that made the task (wake spec §2.1); null: not known. */
  chatType: 'p2p' | 'group' | null;
}

export type RefusalCode =
  /** No such task or run. */
  | 'not_found'
  /** The input itself is wrong: an empty title, an unknown contract field. */
  | 'invalid'
  /** The task's phase does not allow this. */
  | 'illegal_transition'
  /** The role is not configured, or its agent is supervised. */
  | 'unknown_role'
  | 'supervised_role'
  /** A person was named, and people cannot be assigned work (yet, or this one). */
  | 'person_not_assignable'
  | 'unknown_workspace'
  | 'workspace_fixed'
  /** A link would close a cycle, or lands on a task with an open run (spec §3.2). */
  | 'cycle'
  | 'run_open'
  /** A person acting while an agent run is open (spec §5.1). */
  | 'agent_run_open'
  /** A run reporting on a task that is not its own. */
  | 'wrong_task'
  /** The run has reported already (spec §7.2). */
  | 'already_reported'
  /** The run was decided by someone else, or is closed (spec §7.2). */
  | 'run_superseded'
  | 'no_reviewer'
  | 'parents_unfinished'
  /** A claim that cannot be made now: a parent not done, or a cooldown. */
  | 'not_claimable'
  | 'workspace_busy'
  /** Nobody the board may hand the task to (spec §4.2). */
  | 'unassignable'
  /** The claim's view of the task is out of date: it was reassigned meanwhile. */
  | 'stale'
  /** A run outcome or close that does not fit the run's state. */
  | 'already_decided'
  | 'undecided'
  | 'already_closed'
  | 'no_open_run'
  /** A gate exited non-zero or ran past its timeout: the report was not applied (spec §7.7). */
  | 'gate_failed'
  /** The task has gates that cannot run now: no workspace, or no role to run them as, or the gateway stopping. */
  | 'gates_cannot_run'
  /** A report on the task is still running its gates. */
  | 'report_in_progress'
  /** No board of that name (spec §16). */
  | 'unknown_board'
  /** The board is archived: nothing is added to it, and no chat moves onto it. */
  | 'board_archived'
  /** A parent and its child would be on different boards (spec §16). */
  | 'other_board'
  /** Something over its size: a DAG, the params, a value or a task's field (workflows spec §5). */
  | 'too_large'
  /** No usable workflow file of that name (workflows spec §6). */
  | 'unknown_workflow'
  /** A wake asked for while `kanban.wake.enabled` is false (wake spec §3.4). */
  | 'wake_off'
  /** A woken turn's show or unblock (wake spec §9.2): a token never held, or a task outside its wake for a show. */
  | 'unauthorized'
  /** A stale wake token, or a session with no running turn the board woke (wake spec §9.2). */
  | 'not_woken'
  /** A woken turn's unblock of a task whose block did not wake it (wake spec §9.2). */
  | 'not_this_wake'
  /** The wake's setter lacks the tier the act needs, checked live (wake spec §9.2). */
  | 'needs_operator'
  | 'needs_talk'
  /** A block that has recurred `kanban.block_recurrence_limit` times: a person decides (wake spec §9.2). */
  | 'recurring'
  /** A task unblocked by woken turns `kanban.wake.max_depth` times since it last completed (wake spec §9.2). */
  | 'woken_unblock_limit';

/** The gate that refused a report, as the reporter is shown it (spec §7.7). */
export interface FailedGate {
  command: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** The end of its output, masked. */
  output: string;
}

export interface Refusal {
  ok: false;
  code: RefusalCode;
  message: string;
  /** For `gate_failed`: the gate, its exit and the end of its output. */
  gate?: FailedGate;
}

export type Result<T extends object> = ({ ok: true } & T) | Refusal;

/**
 * Why a claimable agent task is not claimed yet (spec §6.2, §6.3, §16): the
 * limits a pass holds it to, and the busy workspace its claim refuses.
 */
export type Waiting =
  | { kind: 'gateway'; maxRunning: number }
  | { kind: 'board'; board: string; maxRunning: number }
  | { kind: 'role'; role: string; maxRunning: number }
  | { kind: 'workspace'; workspace: string; taskId: string; runId: string };

/** A task to create, as a person or a worker asks for it. Names are not yet checked. */
export interface CreateRequest {
  title: string;
  body?: string;
  contract?: Contract;
  /** A role name, or a person's principal `lark:<union_id>`. */
  assignee?: string;
  reviewer?: string;
  workspace?: string;
  parents?: readonly string[];
  priority?: number;
  idempotencyKey?: string;
  failureLimit?: number;
  retryOnCrash?: RetryOnCrash;
  maxRuntimeS?: number;
  createdBy: string;
  createdVia: CreatedVia;
  /** The board it goes on (spec §16): chat's is the chat's board. A run's task's follow-ups go on its board, whatever this says. */
  board?: string;
  /** The chat that follows it, named at the terminal (kanban spec §22.1); the operator's alone. */
  follow?: Follow;
  /**
   * Its wake (wake spec §3.1, §9.1): `by`, the principal its woken turns run
   * as, or null for none; `depth`, the woken turns in its making. A run's
   * follow-up inherits its creating task's, whatever this says. `role`, with
   * `by`, names the role it targets (wake spec §19.1).
   */
  wake?: { by: string | null; depth: number; role?: string };
}
