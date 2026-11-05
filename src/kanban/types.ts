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
/** Recorded by a person's action, not by the run: `/kanban stop`, assign, archive. */
const SUPERSEDING_OUTCOMES = ['cancelled', 'superseded'] as const;

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

/** Where a task came from: the chat it was created in, or the run that created it (spec §3.1). */
export type CreatedVia =
  | { kind: 'chat'; channel: string; appId: string; conversationId: string; threadId: string }
  | { kind: 'run'; runId: string };

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
  cursor: number;
  createdAt: number;
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
  | 'report_in_progress';

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
