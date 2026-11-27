import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { isBusy, type Db } from '../db/open.js';
import * as board from '../db/kanban.js';
import {
  boardList,
  boardSummaries,
  boardsOf,
  cardReading,
  chatBoardOf,
  gatesOf,
  getBoard,
  getInstance,
  getRun,
  getTask,
  getTaskByKey,
  hasRouting,
  hasWakeColumns,
  instanceByKey,
  instancesOn,
  memberOf,
  memberPhases,
  membersOf,
  membersWithTasks,
  phaseSince,
  pendingOf,
  latestCompletion,
  plannedMemberOf,
  reactsTo,
  routeFailureOf,
  routeOfHandler,
  routesOf,
  routingDue,
  routingFaulted,
  triggersOf,
  settledOf,
  unmadeOf,
  unmadeSteps,
  relatedTasks,
  runsOf,
  statusOf,
  subscriptionsOf,
  taskView,
  threadRootOf,
  wakeOutcomesOf,
  wokenUnblocksSince,
  type BoardEntry,
  type BoardSummary,
  type CardReading,
  type InstanceRow,
  type MemberRow,
  type TaskView,
  type ThreadAt,
} from '../db/kanban-read.js';
import { CHAT_ID, THREAD_ID } from '../core/lark-ids.js';
import { buildEnv } from '../driver/env.js';
import { nameProblem, visible } from '../names.js';
import { redactKnownSecrets } from '../secrets.js';
import { roleLimit, type Role } from '../roles.js';
import { systemClock, type Clock } from '../time.js';
import { commitReader, type CommitReader } from './commit.js';
import { checkDagShape, checkDagTasks, DAG_LIMITS, type Dag, type DagTask, type ShapedDag } from './dag.js';
import { checkOutputs, fillText, INSTANCE_CAP, itemPlaceholderOf, maskPlan, outputBounds, placeholderOf, standInContract, stepLines, triggerWords, type Plan, type PlanStep, type RouteView, type StepLine, type Template } from './routing.js';
import { holdsSecret } from './gate-command.js';
import { gateEnv, runGates, spawnGate, type GateResult, type GateRunner } from './gates.js';
import { assignable, checkTask, isRecord, isText, isTextList, type TaskFacts } from './task-checks.js';
import { limitsReached, workspaceBusy } from './waiting.js';
import { isBlockOutcome } from './waker.js';
import type { DisplayStatus } from './status.js';
import {
  archivedBoardProblem,
  expand,
  instanceStatus,
  listWorkflows,
  missingBoardProblem,
  readWorkflow,
  routedDagProblem,
  startBoard,
  usableMessage,
  withBoards,
  workflowBoard,
  workflowRouting,
  type BoardPath,
  type GivenParams,
  type InstanceState,
  type PersonOf,
  type Workflow,
  type WorkflowBoardRead,
  type WorkflowFacts,
  type WorkflowList,
} from './workflow.js';
import { isWorktreeId, worktreeId, worktreeOf } from '../db/workspaces.js';
import { placeName, placeOf, resolveTaskWorkspace } from './workspace.js';
import {
  BLOCK_KINDS,
  DEFAULT_BOARD,
  GATE_LIMITS,
  type AgentSnapshot,
  type Assignee,
  type BoardRow,
  type ChatAt,
  type CommentRow,
  type CreateRequest,
  type CreatedVia,
  type DeferredKey,
  type DeferredWhy,
  type Follow,
  type GateRow,
  type KanbanEvent,
  type Phase,
  type Refusal,
  type Rendering,
  type ReportedBlockKind,
  type Reporter,
  type Result,
  type RunRow,
  type SubscriptionRow,
  type TaskRow,
  type Waiting,
  type WakeRow,
} from './types.js';

/**
 * The board's service API (spec §4–§5): what plans C2, C3 and D call.
 *
 * It checks what the rows cannot: that a named role or workspace is configured,
 * that the board may hand work to it, and that input -- from chat, or from an
 * agent's JSON -- has the right shape. db/kanban.ts checks the rest, and is the
 * only writer.
 *
 * Without `people`, nothing can deliver a card to a person, so people cannot be
 * assigned or named as reviewers; without `supervisedRoles`, a role whose agent
 * is supervised is refused, as its approval cards would have nowhere to go (spec
 * §12). The gateway passes both from plan D2, which sends people their cards and
 * forwards approvals to the chat following a task. Who may act -- tiers, the
 * named assignee -- is the caller's: the worker CLI's token (plan C3), chat (D).
 */

/** How the board reaches people. Plan D's; absent, people cannot be given work. */
export interface People {
  /** Being assigned is permission to report, so it needs talk tier (spec §4.2). */
  canTalk(principal: string): boolean;
}

/**
 * What a report's checks need (spec §7.7, §7.8): where each workspace is, and the
 * gateway's own environment, of which a gate and git get only what an agent
 * would. The runner and the reader are injected so the unit tests start no
 * process; absent, they are the real ones.
 */
export interface ReportChecks {
  /** Each configured workspace's directory, by name. */
  workspaceDirs: ReadonlyMap<string, string>;
  env: Readonly<Record<string, string | undefined>>;
  runGate?: GateRunner;
  readCommit?: CommitReader;
  /**
   * Whether a workspace's directory is there to run gates in. Absent, the
   * filesystem says, for the real runner; a runner given in its place stands in
   * for the filesystem too.
   */
  isDirectory?: (dir: string) => boolean;
}

function directoryExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export interface KanbanServiceDeps {
  db: Db;
  roles: ReadonlyMap<string, Role>;
  /** The configured workspace names. */
  workspaces: ReadonlySet<string>;
  /** The isolated ones (spec §18), whose tasks each get a directory of their own; absent, none. */
  isolated?: ReadonlySet<string>;
  clock?: Clock;
  limits?: board.KanbanLimits;
  people?: People;
  /** Accept roles whose agent asks for approval. Plan D's, once approvals reach a subscriber. */
  supervisedRoles?: boolean;
  /**
   * How a report's gates run and its commit is read. Absent -- tests of the board
   * alone -- no commit is read, and a task with gates cannot complete.
   */
  checks?: ReportChecks;
  /**
   * The gateway's `kanban.max_running`: a board's own may not be above it (spec
   * §16). Absent -- tests of the board alone -- a board's is not bounded.
   */
  maxRunning?: number;
  /**
   * The gateway's `kanban.max_running_per_role`, for a role with none of its own:
   * so `show` can say a task is waiting on its role's limit (spec §6.3).
   */
  maxRunningPerRole?: number;
  /**
   * Where the workflow files are, `$MT_HOME/workflows` (workflows spec §1), read at each
   * preview and start. Absent -- tests of the board alone -- there are none.
   */
  workflowsDir?: string;
  /**
   * The gateway's `kanban.wake` switch and depth (wake spec §3.4, §5.4). Absent
   * -- tests of the board alone -- wakes are on, to `max_depth` 5.
   */
  wake?: { enabled: boolean; maxDepth: number };
  /**
   * Cancel a run's turn, as the dispatcher's `cancel` does (workflow routing spec
   * §9.5): for the runs a stand-in's archive superseded, on every path that
   * routes. Answers whether a turn was asked to stop. Absent -- tests of the
   * board alone -- none is cancelled, and the dispatcher's pass is the backstop.
   */
  cancelRun?: (runId: string) => boolean;
}

/** A report's options: aborted when the gateway stops, which kills its gates and applies nothing. */
export interface ReportOptions {
  signal?: AbortSignal;
}

/** Why a wake asked for is refused while wakes are off (wake spec §3.4). */
export const WAKES_OFF =
  'wakes are off on this gateway: an operator turns them on with kanban.wake.enabled: true in config.yaml, and a restart';

/**
 * A change of a task's wake, as chat or the terminal asks it (wake spec §3.1):
 * on as a principal, for the chat session or, with `role`, for that role
 * (§19.1); or off.
 */
export type WakeRequest = { on: true; as: string; role?: string } | { on: false };

/**
 * Who judges a woken turn's show and unblock (wake spec §9.2): the setter's tiers,
 * live, by `PeopleDirectory`; their name as the thread knows them, for the
 * refusals that name them; and `kanban.block_recurrence_limit`.
 */
export interface WakeJudge {
  canTalk(principal: string): boolean;
  canOperate(principal: string): boolean;
  nameOf(principal: string): string | undefined;
  blockRecurrenceLimit: number;
}

/** A woken turn's show of a task outside its wake (wake spec §9.2): the same words whether the task exists or not. */
export const NOT_IN_WAKE = 'a woken turn reads only the tasks whose events woke it';

/**
 * A member's wake, as a start resolves it (wake spec §3.1): every member's with
 * `all`, else only one whose step, or DAG task, asks, `ask`; the start's role,
 * else the member's own step's (§19.1), else the chat session; with no chat to
 * follow it, a member that would wake the chat session is notice-only (§19.16).
 */
function memberWake(ask: DagTask['wake'], wake: StartWakeOf | undefined): board.NewWake | undefined {
  if (wake === undefined || (!wake.all && ask === undefined)) return wake === undefined ? undefined : { by: null, depth: wake.depth };
  const role = wake.role ?? (typeof ask === 'object' ? ask.role : undefined);
  if (role === undefined && wake.rolesOnly === true) return { by: null, depth: wake.depth };
  return {
    by: wake.by,
    depth: wake.depth,
    ...(wake.tooDeep === true ? { tooDeep: true } : {}),
    ...(role === undefined ? {} : { role }),
  };
}

/** A refusal unless a new task's wake is a principal, or none, and a whole depth (wake spec §3.1). */
function wakeShapeRefused(wake: unknown): Refusal | undefined {
  if (wake === undefined) return undefined;
  if (
    !isRecord(wake) ||
    !(wake.by === null || (isText(wake.by) && wake.by.startsWith('lark:') && wake.by.length > 'lark:'.length)) ||
    !(wake.role === undefined || (isText(wake.role) && wake.by !== null)) ||
    typeof wake.depth !== 'number' ||
    !Number.isSafeInteger(wake.depth) ||
    wake.depth < 0
  ) {
    return board.refuse('invalid', 'a wake is a principal, lark:<union_id>, or none, and a depth of 0 or more');
  }
  return undefined;
}

/** Whose environment a task's gates run with when no agent has run on it (spec §7.7). */
const DEFAULT_ROLE = 'default';

/** A report the gateway stopped in the middle of: nothing was applied. */
const STOPPING =
  'the gateway is stopping, so the gates did not finish and the report was not applied; report again once it is back';

/** Why a gate refused the report, in a few words. */
function verdict(r: GateResult, timeoutS: number): string {
  if (r.timedOut) return `ran past its ${timeoutS} s`;
  if (r.exitCode !== null) return `exited ${r.exitCode}`;
  return r.signal === null ? 'could not start' : `was ended by ${r.signal}`;
}

/** A task to create: in types.ts, so the checks need nothing of the service; exported here too, as its callers name it. */
export type { CreateRequest } from './types.js';

/** A routing decision as the writer records it (workflow routing spec §12.2): exported here, as only the service reaches the writer. */
export type { RoutedLine } from '../db/kanban.js';

/** A workflow to start (workflows spec §6), as chat, the terminal or a run asks for it. Nothing is checked yet. */
export interface StartRequest {
  workflow: string;
  params: GivenParams;
  /** Chat's: a value starting with `@`, in a param that lands in a person field, as the principal it mentions. */
  personOf?: PersonOf;
  /** As a task's: chat's message, the terminal's `--key`, a run's `idempotency_key`; namespaced here. */
  idempotencyKey?: string;
  createdBy: string;
  createdVia: CreatedVia;
  /**
   * Chat's board, or the terminal's `--board` only when given; a run's is its
   * task's, whatever this says. A file's own board overrules chat's, and the
   * terminal's when absent (workflows spec §19.2).
   */
  board?: string;
  /** The chat that follows every member, named at the terminal (workflows spec §18.1); the operator's alone. */
  follow?: Follow;
  /**
   * Its wake (wake spec §3.1): `by`, the principal its members' woken turns run
   * as, at `depth`; every member's with `all` (chat's `wake`, the terminal's
   * `--wake`), else only those whose step, or DAG task, says `wake: true`. A
   * run's members inherit its task's, whatever this says.
   */
  wake?: StartWake;
}

/** A DAG to make (workflows spec §6), parsed but not yet checked: the terminal's file, or a run's `apply-dag` input without its own keys. */
export interface ApplyRequest {
  dag: unknown;
  idempotencyKey?: string;
  /** Every check, and nothing written (workflows spec §6). */
  dryRun?: boolean;
  createdBy: string;
  createdVia: CreatedVia;
  /** As a start's: not a key of the DAG, so its hash is the same wherever it is heard (workflows spec §18.1). */
  follow?: Follow;
  /**
   * Its wake (wake spec §3.1): `by`, the principal its members' woken turns run
   * as, at `depth`; every member's with `all` (chat's `wake`, the terminal's
   * `--wake`), else only those whose step, or DAG task, says `wake: true`. A
   * run's members inherit its task's, whatever this says.
   */
  wake?: StartWake;
}

/** A start's or an apply's wake (wake spec §3.1): its setter and depth, and whether every member wakes or only those that ask. */
export interface StartWake {
  /**
   * Null for none: the members keep `depth` alone, as a woken turn's shell makes
   * them (wake spec §9.1); at the terminal, an owner this bot has not seen
   * (§3.2), the asking members then notice-only, with a note (§19.16).
   */
  by: string | null;
  depth: number;
  all: boolean;
  /** The role every member that wakes targets (wake spec §19.1); absent, the chat session. */
  role?: string;
  /**
   * The note said when `by` is null because the terminal could not name the
   * owner for want of a setting (no app id, no owner), in place of
   * `OWNER_UNSEEN_NOTICE_ONLY`, which is for an owner not yet seen (§3.2, §19.16).
   */
  note?: string;
}

/** The note a start's answer ends with when its steps ask for a wake while wakes are off (wake spec §3.4). */
export const STEPS_NOTICE_ONLY = 'wakes are off on this gateway (kanban.wake.enabled), so the steps that ask for one are notice-only';

/**
 * A start's wake, as the writer's members take it: every member's, or the
 * asking steps'; `rolesOnly` with no chat to follow them, when only a role's
 * wake is kept (wake spec §19.16).
 */
type StartWakeOf = board.NewWake & { all: boolean; rolesOnly?: boolean };

/** The note a terminal's start or apply with no chat ends with when its steps ask for the chat session's wake (wake spec §19.16). */
export const NO_CHAT_NOTICE_ONLY = 'no chat follows this start (add --chat), so the steps that wake the chat session are notice-only';

/** The note a terminal's start or apply ends with when its steps ask for a wake and the owner is not yet known (wake spec §3.2, §19.16). */
export const OWNER_UNSEEN_NOTICE_ONLY = 'the owner has not used /kanban in Lark yet, so the steps that ask for a wake are notice-only';

/** What a start or an apply made, or found made with its key: the instance, and its members with their tasks. */
export interface WorkflowMade {
  instance: InstanceRow;
  tasks: Array<MemberRow & { task: TaskRow }>;
  existing: boolean;
  /** `STEPS_NOTICE_ONLY`, for a start whose steps asked for a wake while wakes are off (wake spec §3.4), or `NO_CHAT_NOTICE_ONLY`, with no chat to follow them (§19.16). */
  wakeNote?: string;
  /** For an instance with a plan, the steps still waiting to be made, by name, handlers not among them (workflow routing spec §12.3, §13.2). */
  waiting?: string[];
}

/** A dry run's answer (workflows spec §6): what the apply would make, or the instance its key already made; nothing written. */
export interface WorkflowDryRun {
  dryRun: true;
  existing: boolean;
  instanceId: string | null;
  board: string;
  tasks: DagTask[];
}

/** An instance as `instances` lists it: the row, and its status. */
export interface InstanceSummary extends InstanceState {
  instance: InstanceRow;
}

/** One instance as `show` gives it (workflows spec §10). */
export interface InstanceView extends InstanceState {
  instance: InstanceRow;
  /** The workflow file's description, while the file is there and usable; undefined otherwise. */
  description: string | undefined;
  members: Array<MemberRow & { task: TaskRow; status: DisplayStatus }>;
  /** Tasks that are not members, with a member as a parent or as their created_from_task, and not another instance's. */
  related: Array<{ task: TaskRow; status: DisplayStatus }>;
  /** Other instances whose members are related to this one, as a deciding step's start makes: one line each. */
  relatedInstances: Array<{ instanceId: string; name: string | null; tasks: number }>;
  /** For an instance with a plan, every step's line, real or pending, in the plan's order (workflow routing spec §12.1). */
  steps?: StepLine[];
  /** While its routing's fault is not reconciled: when, and the error (§9.4, §12.1). */
  routingFailed?: { at: number; error: string };
}

/** How many of a board's newest instances `instances` reads (workflows spec §7). */
export const INSTANCES_READ = 200;

/** How often a faulted instance's routing is retried, at most (workflow routing spec §9.4). */
export const RETRY_ROUTING_MS = 60_000;

/** How long `unknown_workflow`'s message may be, in bytes: a gate refusal's output's size (workflows spec §6). */
export const WORKFLOW_MESSAGE_BYTES = 4 * 1024;

/** A claim, with what was read for it. */
export interface Claimed {
  run: RunRow;
  task: TaskRow;
  /** The role.md whose hash the run records, for plan C2's prompt; undefined without one. */
  roleMd: string | undefined;
  /** The same role.md as the bytes that were hashed, which a native package is rendered from (plan R). */
  roleMdBytes?: Buffer;
  /**
   * The role the claim resolved, whose files were just checked: plan C2's prompt
   * uses its skills, not a later lookup's. Undefined for a person's run.
   */
  role: Role | undefined;
}

/** The kinds a worker or a person may report; gave_up is the breaker's. */
const REPORTABLE: readonly ReportedBlockKind[] = BLOCK_KINDS.filter((k): k is ReportedBlockKind => k !== 'gave_up');

/** What a run records of its agent (spec §3.3): never an environment value. */
export function agentSnapshot(role: Role): AgentSnapshot {
  return {
    driver: role.agent.driver,
    command: role.agent.command,
    args: [...role.agent.args],
    unsupervised: role.agent.unsupervised,
    envNames: Object.keys(role.agent.env).sort(),
  };
}

// Every entry point takes what an agent's JSON or chat sent, typed or not: a
// wrong type is refused as `invalid`, never thrown, and never reaches a write.

/** Throws unless the path is a regular file: a directory where role.md or a SKILL.md was is not one. */
function regularFile(path: string): void {
  if (!statSync(path).isFile()) throw new Error(`${path} is not a file`);
}

/** A refusal unless every id given is text. */
function idsRefused(...ids: unknown[]): Refusal | undefined {
  return ids.every(isText) ? undefined : board.refuse('invalid', 'task ids are text');
}

/** A commit id, abbreviated or whole, SHA-1 or SHA-256. */
const COMMIT = /^[0-9a-f]{7,64}$/;

/** A refusal unless the handoff has a text summary, and its report fields their types. */
function handoffRefused(by: Reporter, handoff: unknown): Refusal | undefined {
  if (!isRecord(handoff) || !isText(handoff.summary)) {
    return board.refuse('invalid', 'a report needs a summary, as text');
  }
  // An agent always says what it did; a person approving may say nothing.
  if (by.kind === 'run' && handoff.summary.trim() === '') {
    return board.refuse('invalid', 'a report needs a summary of what was done');
  }
  const { reportedCommit: commit, reportedDirty: dirty } = handoff;
  if (commit !== undefined && commit !== null && !(isText(commit) && COMMIT.test(commit))) {
    // Not echoed: it is the reporter's text, and may be anything.
    return board.refuse('invalid', 'reported_commit is a commit id: 7 to 64 lower-case hex digits');
  }
  if (dirty !== undefined && dirty !== null && typeof dirty !== 'boolean') {
    return board.refuse('invalid', 'reported_dirty is true or false');
  }
  return undefined;
}

/**
 * A worker's idempotency key is stored as `run-task:<its run's task>:<key>`, so
 * two runs' keys never collide, and neither can return a chat's task.
 */
const RUN_KEY = 'run-task:';
/** Chat's keys: the message that asked, `lark:<message_id>`. */
const CHAT_KEY = 'lark:';
/** The operator's `mt kanban task new --key <k>`, stored as `operator:<k>`, so it never meets chat's or a run's. */
const OPERATOR_KEY = 'operator:';
/** A reaction task's key, `wake:<uuid>` (wake spec §19.3): the waker's own namespace, which no other creator may use. */
const WAKE_KEY = 'wake:';
/** Why the service makes no task by a wake: the waker writes a reaction task itself (wake spec §19.3). */
const BY_A_WAKE = 'a task made by a wake is the waker\'s own: no other caller makes one';

/**
 * Why a `follow` is refused (kanban spec §22.1, workflows spec §18.1), or
 * undefined: only the terminal names a chat, as a chat follows what is made in
 * it and a run's work follows its task's chats; and it names one in Lark's
 * shapes, for a bot, with a thread's root, and none at chat scope.
 */
function followRefused(follow: unknown, via: CreatedVia): Refusal | undefined {
  if (follow === undefined) return undefined;
  if (via?.kind !== 'operator') {
    return board.refuse('invalid', "only the terminal names a chat to follow what it makes: a chat follows what is made in it, and a run's work its task's chats");
  }
  if (!isRecord(follow) || !isText(follow.appId) || follow.appId === '' || !isText(follow.chatId) || !CHAT_ID.test(follow.chatId)) {
    return board.refuse('invalid', "a chat to follow is the bot's app id and a chat id, oc_…");
  }
  const { threadId, rootId } = follow;
  if (!isText(threadId) || (threadId !== '' && !THREAD_ID.test(threadId))) return board.refuse('invalid', 'a thread to follow in is a thread id, omt_…, or none');
  if (threadId === '' ? rootId !== null : !isText(rootId) || rootId === '') {
    return board.refuse('invalid', 'a thread is followed with its root message, and a chat with none');
  }
  return undefined;
}

/**
 * A report refused while another on the task runs its gates: what to look at
 * meanwhile, typed as its reporter types it -- in chat for a person, the worker
 * CLI's own command for a run's agent, as its prompt names it.
 */
function inProgress(taskId: string, by: Reporter): string {
  const see = by.kind === 'person' ? `/kanban task show ${taskId}` : 'mt kanban show';
  return `task ${taskId} is being reported on already, and its gates are running; wait for that answer, or see ${see}`;
}

export class KanbanService {
  readonly #db: Db;
  readonly #roles: ReadonlyMap<string, Role>;
  readonly #workspaces: ReadonlySet<string>;
  readonly #isolated: ReadonlySet<string>;
  readonly #clock: Clock;
  readonly #limits: board.KanbanLimits;
  readonly #people: People | undefined;
  readonly #supervisedRoles: boolean;
  readonly #checks: ReportChecks | undefined;
  readonly #maxRunning: number;
  readonly #maxRunningPerRole: number | undefined;
  readonly #workflowsDir: string | undefined;
  readonly #wake: { enabled: boolean; maxDepth: number };
  readonly #cancelRun: ((runId: string) => boolean) | undefined;
  /**
   * Tasks a report is running its checks for, with where the gates run -- the
   * task's own directory, by its `wt:` id, or its workspace's shared one (spec
   * §18) -- and the report's end. One at a time per task: a second report would
   * run the same gates again, at once, in the same checkout. And no claim
   * meanwhile, of the task or of another working there, which would start an
   * agent in a checkout being tested.
   */
  readonly #reporting = new Map<string, { workspace: string | null; done: Promise<unknown> }>();
  /** When each faulted instance's routing was last retried, in this process (workflow routing spec §9.4); not stored. */
  readonly #retried = new Map<string, number>();
  /** The faulted instances whose retry has failed and been said once, until one succeeds. */
  readonly #retryFailed = new Set<string>();

  constructor(deps: KanbanServiceDeps) {
    this.#db = deps.db;
    this.#roles = deps.roles;
    this.#workspaces = deps.workspaces;
    this.#isolated = deps.isolated ?? new Set();
    this.#clock = deps.clock ?? systemClock;
    this.#limits = deps.limits ?? board.DEFAULT_LIMITS;
    this.#people = deps.people;
    this.#supervisedRoles = deps.supervisedRoles ?? false;
    this.#checks = deps.checks;
    this.#maxRunning = deps.maxRunning ?? Number.MAX_SAFE_INTEGER;
    this.#maxRunningPerRole = deps.maxRunningPerRole;
    this.#workflowsDir = deps.workflowsDir;
    this.#wake = deps.wake ?? { enabled: true, maxDepth: 5 };
    this.#cancelRun = deps.cancelRun;
  }

  /**
   * The turns of the runs a routing superseded, cancelled (workflow routing spec
   * §9.5): one place for every caller, chat, the worker API, the dispatcher, the
   * reconciliations; a caller that cancels too cancels an already-cancelled run,
   * which does nothing.
   */
  #cancelled<T>(r: T): T {
    const superseded = (r as { ok?: boolean; superseded?: RunRow[] }).superseded;
    for (const run of superseded ?? []) {
      try {
        this.#cancelRun?.(run.runId);
      } catch {
        // Its turn is the dispatcher's: its pass cancels a superseded run's turn too.
      }
    }
    return r;
  }

  /**
   * A new board (spec §16), named in the grammar of roles and workspaces: a name
   * typed in chat, kept in the database, and never renamed.
   */
  createBoard(name: string, by: string): Result<{ board: BoardRow }> {
    if (!isText(name)) return board.refuse('invalid', 'a board is a name, as text');
    const problem = nameProblem('board', name);
    if (problem !== undefined) return board.refuse('invalid', problem);
    return board.createBoard(this.#db, name, by, this.#clock.now());
  }

  /**
   * A board's own max_running, from 1 to the gateway's, or its workspace, a
   * configured one; null clears either (spec §16).
   */
  setBoard(name: string, change: board.BoardChange, by: string): Result<{ board: BoardRow }> {
    if (!isText(name) || typeof change !== 'object' || change === null) {
      return board.refuse('invalid', 'a board is a name, and a change an object');
    }
    const { maxRunning, workspace } = change;
    if (maxRunning === undefined && workspace === undefined) {
      return board.refuse('invalid', "a board's change sets its max_running, its workspace, or both");
    }
    const within = (n: number) => Number.isSafeInteger(n) && n >= 1 && n <= this.#maxRunning;
    if (maxRunning !== undefined && maxRunning !== null && !within(maxRunning)) {
      return board.refuse(
        'invalid',
        `a board's max_running is a whole number from 1 to the gateway's kanban.max_running, ${this.#maxRunning}`,
      );
    }
    if (workspace !== undefined && workspace !== null && (!isText(workspace) || !this.#workspaces.has(workspace))) {
      return board.refuse('unknown_workspace', `workspace ${visible(JSON.stringify(workspace))} is not configured`);
    }
    return board.setBoard(this.#db, name, change, by, this.#clock.now());
  }

  /** Archive a board whose tasks are all done or archived; never `default` (spec §16). */
  archiveBoard(name: string, by: string): Result<{ board: BoardRow }> {
    if (!isText(name)) return board.refuse('invalid', 'a board is a name, as text');
    return board.archiveBoard(this.#db, name, by, this.#clock.now());
  }

  /** Move a chat onto a board: its new tasks go there, and `/kanban task list` shows it (spec §16). */
  useBoard(at: ChatAt, name: string, by: string): Result<{ board: BoardRow }> {
    if (!isText(name)) return board.refuse('invalid', 'a board is a name, as text');
    return board.useBoard(this.#db, at, name, by, this.#clock.now());
  }

  /** The board a chat is on: the one it last used, else `default`. */
  chatBoard(at: ChatAt): BoardRow {
    const found = getBoard(this.#db, chatBoardOf(this.#db, at) ?? DEFAULT_BOARD);
    if (found === undefined) throw new Error(`board ${DEFAULT_BOARD} is missing: the database is not migrated`);
    return found;
  }

  /** The boards, with their tasks by phase: `/kanban board list`. `including`: a chat's own board, archived or not. */
  boards(opts: { archived?: boolean; including?: string } = {}): BoardSummary[] {
    return boardSummaries(this.#db, opts);
  }

  /**
   * Create a task. Unknown names are refused here, at creation (spec §9.1): a typo
   * should fail while the person is still looking, not strand the task later.
   */
  create(req: CreateRequest): Result<{ task: TaskRow; existing: boolean }> {
    // The checks a task gets however it is made (workflows spec §15), then its key, which reads the database.
    const checked = checkTask(req, this.#facts());
    if (!checked.ok) return checked;
    if (req.createdVia.kind === 'wake') return board.refuse('invalid', BY_A_WAKE);
    const follow = followRefused(req.follow, req.createdVia);
    if (follow !== undefined) return follow;
    const wake = this.#newWake(req);
    if (!wake.ok) return wake;
    const key = this.#idempotencyKey(req.idempotencyKey, req.createdVia);
    if (!key.ok) return key;
    return board.createTask(
      this.#db,
      {
        title: req.title,
        ...(req.body === undefined ? {} : { body: req.body }),
        contract: checked.contract,
        assignee: checked.assignee ?? null,
        reviewer: checked.reviewer ?? null,
        workspace: req.workspace ?? null,
        ...(req.parents === undefined ? {} : { parents: req.parents }),
        ...(req.priority === undefined ? {} : { priority: req.priority }),
        idempotencyKey: key.key,
        failureLimit: req.failureLimit ?? null,
        ...(req.retryOnCrash === undefined ? {} : { retryOnCrash: req.retryOnCrash }),
        maxRuntimeS: req.maxRuntimeS ?? null,
        createdBy: req.createdBy,
        createdVia: req.createdVia,
        ...(req.board === undefined ? {} : { board: req.board }),
        ...(req.follow === undefined ? {} : { follow: req.follow }),
        ...(wake.wake === undefined ? {} : { wake: wake.wake }),
      },
      this.#clock.now(),
    );
  }

  /**
   * A new task's wake, checked (wake spec §3.1, §3.4): refused while wakes are
   * off, and for a terminal's task no chat follows; made with wake off, as a
   * note, at `max_depth` or more. A run's follow-up inherits its creating
   * task's in the writer, whatever was asked, so nothing is refused for it.
   */
  #newWake(req: CreateRequest): Result<{ wake?: board.NewWake }> {
    const shape = wakeShapeRefused(req.wake);
    if (shape !== undefined) return shape;
    const w = req.wake;
    if (w === undefined || req.createdVia?.kind === 'run') return { ok: true };
    if (w.by === null) return { ok: true, wake: { by: null, depth: w.depth } };
    if (!this.#wake.enabled) return board.refuse('wake_off', WAKES_OFF);
    // A role's wake needs no chat (wake spec §19.16); the chat session's does.
    if (req.createdVia?.kind === 'operator' && req.follow === undefined && w.role === undefined) {
      return board.refuse('invalid', 'a wake needs a chat that follows the task: add --chat');
    }
    const role = this.#wakeRole(w.role);
    if (!role.ok) return role;
    return {
      ok: true,
      wake: { by: w.by, depth: w.depth, ...(w.depth >= this.#wake.maxDepth ? { tooDeep: true } : {}), ...role.role },
    };
  }

  /**
   * The role a wake targets, checked when it is set (wake spec §19.1): configured,
   * and taken by `assignable` as an assignee, which judges the role alone; refused
   * `invalid` in `assignable`'s words, as `task assign` would refuse it. A
   * person's principal is not a role.
   */
  #wakeRole(role: string | undefined): Result<{ role: { role?: string } }> {
    if (role === undefined) return { ok: true, role: {} };
    const who = assignable(role, this.#facts());
    if (!who.ok) return board.refuse('invalid', who.message);
    if (who.assignee.kind !== 'role') return board.refuse('invalid', `${JSON.stringify(role)} is not a role: a wake targets a role, or the chat session`);
    return { ok: true, role: { role } };
  }

  /**
   * Turn a task's wake on or off (wake spec §3.1, §3.4), for this bot's
   * subscriptions: on runs its woken turns as `as`, set by `by`. Refused while
   * wakes are off, though off still works; a task too deep is left with wake
   * off, `tooDeep`, for the caller's note; one already on there, `max_depth`
   * lowered since, keeps its wake, `kept` as well (§5.4). Who may ask is the
   * caller's.
   */
  setWake(taskId: string, change: WakeRequest, by: string, appId: string): Result<{ task: TaskRow; changed: boolean; tooDeep: boolean; kept: boolean }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (change.on && !this.#wake.enabled) return board.refuse('wake_off', WAKES_OFF);
    const role = change.on ? this.#wakeRole(change.role) : { ok: true as const, role: {} };
    if (!role.ok) return role;
    const writerChange: board.WakeChange = change.on ? { on: true, as: change.as, maxDepth: this.#wake.maxDepth, ...role.role } : { on: false };
    return board.setWake(this.#db, taskId, writerChange, by, appId, this.#clock.now());
  }

  /**
   * Whether a role can be given work now (wake spec §19.2), as it is checked when
   * a wake names it: the waker's live check of a role's wake.
   */
  wakeRoleUsable(role: string): Result<object> {
    return this.#wakeRole(role);
  }

  /**
   * The waker's record of a role's batch (wake spec §19.3): its reaction task,
   * made with `createTask`'s checks against the team as it is now. The waker's
   * own write, the only one that makes a task by a wake.
   */
  recordRoleWake(batch: board.NewRoleWake): Result<board.RoleWakeMade> {
    return board.recordRoleWake(this.#db, batch, this.#facts(), this.#clock.now());
  }

  /** The waker's record of a batch (wake spec §5.5 step 2), through the writer. */
  recordWake(batch: board.NewWakeBatch): ReturnType<typeof board.recordWake> {
    return board.recordWake(this.#db, batch, this.#clock.now());
  }

  /** A wake's marker sent, or tried (wake spec §5.5 step 3). */
  wakeMarked(wakeId: number): Result<{ marked: boolean }> {
    return board.wakeMarked(this.#db, wakeId, this.#clock.now());
  }

  /** A wake's current attempt submitted, by this boot (wake spec §5.5 step 6). */
  wakeSubmitted(wakeId: number, sessionId: string, turnKey: string, boot: string): Result<{ submitted: boolean }> {
    return board.wakeSubmitted(this.#db, wakeId, sessionId, turnKey, boot);
  }

  /** A wake's attempt refused by its session (wake spec §5.6). */
  wakeRefused(wakeId: number, error: string): Result<{ refused: boolean; attempt: number }> {
    return board.wakeRefused(this.#db, wakeId, error);
  }

  /** A wake delivered, its cursors moved (wake spec §5.5 step 9). */
  advanceWake(wakeId: number): Result<{ delivered: boolean }> {
    return board.advanceWake(this.#db, wakeId, this.#clock.now());
  }

  /** A wake dropped, its cursors moved past all its events or only `tasks`' (wake spec §5.3a, §5.6). */
  dropWake(wakeId: number, error: string, opts: { tasks?: readonly string[] } = {}): Result<{ dropped: boolean }> {
    return board.dropWake(this.#db, wakeId, error, this.#clock.now(), opts);
  }

  /** A pending wake with nothing left once its lifted blocks are dropped (wake spec §5.3b). */
  liftedWake(wakeId: number): Result<{ lifted: boolean }> {
    return board.liftedWake(this.#db, wakeId, this.#clock.now());
  }

  /** A subscription's wake cursor moved past events the waker passes over (wake spec §5.2 step 3). */
  passWake(subscriptionId: number, cursor: number): Result<{ advanced: boolean }> {
    if (!Number.isSafeInteger(subscriptionId) || !Number.isSafeInteger(cursor) || cursor < 0) {
      return board.refuse('invalid', 'a subscription and its cursor are whole numbers');
    }
    return board.passWake(this.#db, subscriptionId, cursor);
  }

  /** A task's own wake cursor moved past events the waker passes over, for a role's wake with no chat (wake spec §19.16). */
  passTaskWake(taskId: string, cursor: number): Result<{ advanced: boolean }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (!Number.isSafeInteger(cursor) || cursor < 0) return board.refuse('invalid', 'a cursor is a whole number');
    return board.passTaskWake(this.#db, taskId, cursor);
  }

  /**
   * The root of a thread, as the notifier finds it (spec §19.7): the message a
   * subscription in it recorded, or undefined for none, or at chat scope. The
   * terminal's `--thread` follows only a thread whose root is known (kanban spec §22.1).
   */
  threadRoot(at: ThreadAt): string | undefined {
    return threadRootOf(this.#db, at);
  }

  /**
   * Whether a key has made its task, or its instance, already: the terminal
   * looks a thread's root up only for what is not made yet, so a repeat is
   * answered even once its thread's root is lost (kanban spec §22.1). Namespaced
   * as `create` and a start namespace it; false for a key they would refuse.
   */
  keyMade(key: string, via: CreatedVia, what: 'task' | 'instance'): boolean {
    const k = this.#idempotencyKey(key, via);
    if (!k.ok || k.key === null) return false;
    return what === 'task' ? getTaskByKey(this.#db, k.key) !== undefined : instanceByKey(this.#db, k.key) !== undefined;
  }

  /**
   * The chat that follows a task for this bot, as stored: its first Lark
   * subscription, the thread null at chat scope; null with none. A repeat's
   * answer names it, never the `--chat` given now (kanban spec §22.1).
   */
  followOf(taskId: string, appId: string): { chat: string; thread: string | null } | null {
    const s = subscriptionsOf(this.#db, taskId).find((x) => x.channel === 'lark' && x.appId === appId);
    return s === undefined ? null : { chat: s.conversationId, thread: s.threadId === '' ? null : s.threadId };
  }

  /**
   * Every chat that follows a task for this bot, as stored, the thread null at
   * chat scope: each subscription a wake set on it would wake (wake spec §3.1,
   * §3.2a), so a wake's caller checks them all, not only the first.
   */
  followsOf(taskId: string, appId: string): Array<{ chat: string; thread: string | null }> {
    return subscriptionsOf(this.#db, taskId)
      .filter((x) => x.appId === appId)
      .map((s) => ({ chat: s.conversationId, thread: s.threadId === '' ? null : s.threadId }));
  }

  assign(taskId: string, assignee: string, by: string): Result<{ task: TaskRow; run: RunRow | undefined }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    const who = assignable(assignee, this.#facts());
    if (!who.ok) return who;
    return board.assign(this.#db, taskId, who.assignee, by, this.#clock.now());
  }

  assignReviewer(taskId: string, reviewer: string, by: string): Result<{ task: TaskRow; run: RunRow | undefined }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    const who = assignable(reviewer, this.#facts());
    if (!who.ok) return who;
    return board.assignReviewer(this.#db, taskId, who.assignee, by, this.#clock.now());
  }

  /**
   * Claim the task's next run (spec §6.2 step 3), for whoever it is for now: its
   * assignee in `open`, its reviewer in `review`. Plan C2's dispatcher calls it.
   *
   * The role is resolved at the claim: its directory may have been removed since
   * the task was created, and its role.md is read again now, so an edit takes
   * effect from the next run (spec §2.1). Anything that does not resolve leaves
   * the task unassignable -- written once, never sent to a fallback (spec §4.2).
   */
  claim(taskId: string, opts: { tokenHash?: string } = {}): Result<Claimed> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    const now = this.#clock.now();
    const task = getTask(this.#db, taskId);
    if (task === undefined) return board.refuse('not_found', `no task ${taskId}`);
    if (task.phase !== 'open' && task.phase !== 'review') {
      return board.refuse('illegal_transition', `task ${taskId} is ${task.phase}, so it cannot be claimed`);
    }
    if (this.#reporting.has(taskId)) {
      return board.refuse('not_claimable', `task ${taskId} is being reported on: its gates are running`);
    }
    const place = this.#placeFor(task);
    const testing = place === null ? undefined : this.#reportingIn(place);
    if (testing !== undefined) {
      return board.refuse(
        'not_claimable',
        `${placeName(place ?? '')} is running the gates of a report on task ${testing}`,
      );
    }
    const resolved = this.#claimant(task);
    const r = resolved.ok
      ? board.claim(
          this.#db,
          {
            taskId,
            claimant: resolved.claimant,
            tokenHash: opts.tokenHash ?? null,
            workspaces: this.#workspaces,
            isolated: this.#isolated,
            reportingIn: this.#reportingWorkspaces(),
          },
          now,
        )
      : resolved;
    if (!r.ok) {
      if (r.code === 'unassignable') board.noteUnassignable(this.#db, taskId, r.message, now);
      return r;
    }
    return {
      ok: true,
      run: r.run,
      task: r.task,
      roleMd: resolved.ok ? resolved.roleMd : undefined,
      ...(resolved.ok && resolved.roleMdBytes !== undefined ? { roleMdBytes: resolved.roleMdBytes } : {}),
      role: resolved.ok ? resolved.role : undefined,
    };
  }

  /**
   * Once no report on the task is running its checks: at once, if none is. The
   * dispatcher waits for it before it decides a run whose turn ended, since the
   * report may be about to decide it.
   */
  async settled(taskId: string): Promise<void> {
    await this.#reporting.get(taskId)?.done.catch(() => undefined);
  }

  /** Each workspace a report is running its checks in, with the task reported on. */
  #reportingWorkspaces(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [taskId, r] of this.#reporting) if (r.workspace !== null) out.set(r.workspace, taskId);
    return out;
  }

  /** A task whose report is running its checks in this workspace, if any. */
  #reportingIn(workspace: string): string | undefined {
    for (const [taskId, r] of this.#reporting) if (r.workspace === workspace) return taskId;
    return undefined;
  }

  /** Record how the run's role reached its agent, once the dispatcher has rendered it or not (plan R). */
  recordRendering(runId: string, rendering: Rendering): Result<{ run: RunRow }> {
    return board.recordRendering(this.#db, runId, rendering, this.#clock.now());
  }

  /** Record the run's gateway session, once plan C2 has created it. */
  attachSession(runId: string, sessionId: string): Result<{ run: RunRow }> {
    return board.attachSession(this.#db, runId, sessionId, this.#clock.now());
  }

  /**
   * An agent run ended without a report (spec §5.2, §8): the classifier's
   * outcome, or the dispatcher's own, recorded before it cancels the turn.
   */
  endRun(runId: string, ending: board.RunEnding): Result<{ task: TaskRow; run: RunRow; next: board.NextStep }> {
    return this.#cancelled(board.endRun(this.#db, runId, ending, this.#limits, this.#clock.now(), this.#facts()));
  }

  /** The run's last turn has ended: it is closed, and its workspace free. */
  closeRun(runId: string): Result<{ run: RunRow }> {
    return board.closeRun(this.#db, runId, this.#clock.now());
  }

  /** Count a prompt sent into a run's session; `n` is the count before it, for its key. */
  countSubmission(runId: string): Result<{ n: number }> {
    return board.countSubmission(this.#db, runId, this.#clock.now());
  }

  /**
   * Tell a task's subscribers, once, that nobody can be given it (spec §4.2),
   * if it has been sitting unclaimable since `cutoff`. Plan C2's sweep calls it.
   */
  noteStranded(taskId: string, reason: string, cutoff: number): Result<{ written: boolean }> {
    return board.noteStranded(this.#db, taskId, reason, cutoff, this.#clock.now());
  }

  /**
   * New work on a done task is a new task with it as a parent, never a reopening
   * (spec §4.4): the done task's summary is what its children were given as their
   * handoff, and reopening it would rewrite the input to work that already ran.
   * It goes on the done task's board, as a parent and its child are on one (spec §16).
   */
  followUp(taskId: string, req: CreateRequest): Result<{ task: TaskRow; existing: boolean }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (!isRecord(req)) return board.refuse('invalid', 'a task to create is an object');
    if (req.parents !== undefined && !isTextList(req.parents)) {
      return board.refuse('invalid', 'parents are a list of task ids');
    }
    const done = getTask(this.#db, taskId);
    if (done === undefined) return board.refuse('not_found', `no task ${taskId}`);
    if (done.phase !== 'done') {
      return board.refuse('illegal_transition', `task ${taskId} is ${done.phase}; only a done task gets follow-ups`);
    }
    // The done task's board unless the request names one; one that names another
    // board is refused `other_board` by the parent check, rather than moved quietly.
    return this.create({ board: done.board, ...req, parents: [taskId, ...(req.parents ?? [])] });
  }

  link(parentId: string, childId: string, by: string): Result<{ added: boolean }> {
    const ids = idsRefused(parentId, childId);
    if (ids !== undefined) return ids;
    return board.link(this.#db, parentId, childId, by, this.#clock.now());
  }

  /** Workspaces are named, never paths, and only configured ones (spec §2.3). */
  setWorkspace(taskId: string, workspace: string, by: string): Result<{ task: TaskRow }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (!isText(workspace)) return board.refuse('invalid', 'a workspace is a name');
    if (!this.#workspaces.has(workspace)) {
      return board.refuse('unknown_workspace', `workspace ${visible(JSON.stringify(workspace))} is not configured`);
    }
    return board.setWorkspace(this.#db, taskId, workspace, by, this.#clock.now());
  }

  /**
   * Define a gate on a task (spec §7.7): a shell command that must exit 0 before
   * the task may complete or go to review. It is an operator action (spec §10):
   * the caller checks the tier, as it does for the board's other operator
   * actions. Plan D's chat command calls it; until then only tests do, as
   * nothing can create a task either.
   *
   * The command is stored and run as written, so one that holds a known secret is
   * refused rather than masked (spec §10.1): a masked command would run broken.
   * The value belongs in the environment of the role whose agent runs the task,
   * which is what gates run with, and the command names it.
   */
  addGate(taskId: string, gate: { command: string; timeoutS?: number }, by: string): Result<{ gate: GateRow }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (!isText(by) || by.trim() === '') return board.refuse('invalid', 'who defines a gate is text, not blank');
    if (!isRecord(gate) || !isText(gate.command) || gate.command.trim() === '') {
      return board.refuse('invalid', 'a gate is a command, as text');
    }
    const { command } = gate;
    if (command.includes('\0')) return board.refuse('invalid', 'a gate command cannot hold a NUL');
    const size = Buffer.byteLength(command, 'utf8');
    if (size > GATE_LIMITS.commandBytes) {
      return board.refuse('invalid', `a gate command is ${size} bytes; it may be at most ${GATE_LIMITS.commandBytes}`);
    }
    if (holdsSecret(command)) {
      // Not echoed: the refusal would carry the secret.
      return board.refuse(
        'invalid',
        "the gate's command holds a known secret, and a gate is stored and run as written; " +
          "pass the value through the agent's environment instead -- the role's .env, or agent.passEnv -- " +
          'and name it in the command, as $NAME',
      );
    }
    const timeoutS = gate.timeoutS ?? GATE_LIMITS.defaultTimeoutS;
    if (!Number.isSafeInteger(timeoutS) || timeoutS < 1 || timeoutS > GATE_LIMITS.maxTimeoutS) {
      return board.refuse('invalid', `a gate's timeout is a whole number of seconds, from 1 to ${GATE_LIMITS.maxTimeoutS}`);
    }
    return board.addGate(this.#db, taskId, { command, timeoutS }, by, this.#clock.now());
  }

  /** The task's gates, in the order they run. */
  listGates(taskId: string): Result<{ gates: GateRow[] }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (getTask(this.#db, taskId) === undefined) return board.refuse('not_found', `no task ${taskId}`);
    return { ok: true, gates: gatesOf(this.#db, taskId) };
  }

  /**
   * Remove one of a task's gates: an operator action, as defining one is. A report
   * already running the task's gates runs the ones it read.
   */
  removeGate(taskId: string, gateId: number, by: string): Result<{ gate: GateRow }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (!isText(by) || by.trim() === '') return board.refuse('invalid', 'who removes a gate is text, not blank');
    if (!Number.isSafeInteger(gateId) || gateId < 1) return board.refuse('invalid', 'a gate id is a whole number');
    return board.removeGate(this.#db, taskId, gateId, by, this.#clock.now());
  }

  /**
   * A comment (spec §7.5). `steers: false` -- a talk-tier person's, from chat --
   * is stored and shown to people, and never given to an agent (spec §9.1). A
   * run's, and an operator's, steer. Every caller says which: there is no default
   * to fall back on when a new caller forgets.
   */
  comment(taskId: string, body: string, by: string, opts: { steers: boolean }): Result<{ comment: CommentRow }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (!isText(body) || body.trim() === '') return board.refuse('invalid', 'a comment needs text');
    if (!isRecord(opts) || typeof opts.steers !== 'boolean') return board.refuse('invalid', 'a comment says whether it steers');
    return board.addComment(this.#db, taskId, by, body, this.#clock.now(), opts.steers);
  }

  /**
   * Every path to done (spec §5.1). Asynchronous, as a report's checks run
   * processes -- the task's gates, and reading the reported commit -- and the
   * gateway must not stop for them: chat runs on the same event loop.
   *
   * On a task that names a reviewer, a work report's `complete` asks for review
   * instead, with the same handoff (spec §5.3): the task comes back in `review`,
   * and its run, if any, `review_requested`. Its gates run once, as for a review.
   */
  async complete(
    taskId: string,
    by: Reporter,
    handoff: board.Handoff,
    opts: ReportOptions = {},
  ): Promise<Result<{ task: TaskRow; run: RunRow | undefined }>> {
    const refused = idsRefused(taskId) ?? handoffRefused(by, handoff);
    if (refused !== undefined) return refused;
    return this.#report(taskId, by, 'complete', undefined, handoff.metadata, opts, (seen) =>
      this.#cancelled(board.complete(this.#db, taskId, by, { ...handoff, ...seen }, this.#clock.now(), this.#facts())),
    );
  }

  /**
   * A reviewer the report names is checked like any assignee (spec §5.3, §12).
   * Asynchronous, as complete is: an assignee's review runs the gates too.
   */
  async requestReview(
    taskId: string,
    by: Reporter,
    handoff: board.Handoff & { reviewer?: string },
    opts: ReportOptions = {},
  ): Promise<Result<{ task: TaskRow; run: RunRow | undefined }>> {
    const refused = idsRefused(taskId) ?? handoffRefused(by, handoff);
    if (refused !== undefined) return refused;
    const { reviewer, ...rest } = handoff;
    let named: Assignee | undefined;
    if (reviewer !== undefined) {
      const who = assignable(reviewer, this.#facts());
      if (!who.ok) return who;
      named = who.assignee;
    }
    return this.#report(taskId, by, 'review', named, rest.metadata, opts, (seen) =>
      board.requestReview(
        this.#db,
        taskId,
        by,
        { ...rest, ...seen, ...(named === undefined ? {} : { reviewer: named }) },
        this.#clock.now(),
      ),
    );
  }

  /**
   * A work report's outputs (workflow routing spec §2.2), after the board's own
   * check of the report, so another run's is refused as ever, and before its
   * gates: on a member of an instance with a plan whose step declares outputs, a
   * `complete` from `open` or a `review`, never a reviewer's approval, whose
   * metadata is checked against them, `invalid` naming the first problem, so the
   * run reports again. A stand-in's are its step's, and held to what reads its
   * step's. One indexed read for any task, nothing more for one with no plan.
   */
  #outputsRefused(task: TaskRow, kind: 'complete' | 'review', metadata: unknown): Refusal | undefined {
    const taskId = task.taskId;
    const planned = plannedMemberOf(this.#db, taskId);
    const plan = planned?.instance.plan;
    if (planned === undefined || plan === null || plan === undefined) return undefined;
    const entry = plan.steps.find((s) => s.step === planned.member.step);
    if (entry === undefined || Object.keys(entry.outputs).length === 0) return undefined;
    if (kind === 'complete' && task.phase !== 'open') return undefined;
    // A handler stands in only for the step it was routed from: helping another, its result is its own step's (§5.2).
    let read = entry.step;
    if (entry.handler === true && entry.stands_in_for !== undefined) {
      const route = routeOfHandler(this.#db, taskId);
      if (route !== undefined && memberOf(this.#db, route.fromTask)?.step === entry.stands_in_for) read = entry.stands_in_for;
    }
    const problem = checkOutputs(entry.outputs, metadata, outputBounds(plan, read));
    if (problem !== undefined) return board.refuse('invalid', problem);
    return this.#reserved(planned.instance.instanceId, plan, read, metadata as Record<string, unknown>);
  }

  /**
   * The instance's 500, reserved at the report whose list a fan-out will read
   * (workflow routing spec §2.2): its members, handlers among them, plus this
   * list's items for each fan-out over it still waiting, plus what each other
   * step still waiting makes, a fan-out over a list param its items, any other
   * one, at most 500, else `too_large`, while the agent can still shorten its
   * list. The writer never refuses for the cap; what passes it later is skipped
   * (§9.4).
   */
  #reserved(instanceId: string, plan: Plan, step: string, metadata: Record<string, unknown>): Refusal | undefined {
    const waiting = new Set(pendingOf(this.#db, instanceId).filter((p) => p.state === 'waiting').map((p) => p.step));
    const members = membersOf(this.#db, instanceId).length;
    const makes = (s: PlanStep): number => s.templates?.length ?? 1;
    let others = plan.steps.filter((s) => waiting.has(s.step)).reduce((n, s) => n + makes(s), 0);
    for (const s of plan.steps) {
      const f = s.for_each;
      if (f === undefined || !('step' in f) || f.step !== step || !waiting.has(s.step)) continue;
      const list = metadata[f.output];
      if (!Array.isArray(list)) continue;
      others -= makes(s);
      if (members + list.length + others > INSTANCE_CAP) {
        return board.refuse('too_large', `output ${f.output} would make ${list.length} tasks, and instance ${instanceId} has ${members} of its ${INSTANCE_CAP}`);
      }
      others += list.length;
    }
    return undefined;
  }

  /**
   * A report's checks, then the report (spec §7.7, §7.8). First whether the board
   * would take it now, so a report it would refuse runs nothing; then, for an
   * agent's report, the state of its workspace, read before anything else can
   * change it; then the task's gates, each recorded, and any failure refusing the
   * report with the run left undecided, so the agent can fix it and report again.
   * Then the transition, which checks everything again in its own transaction:
   * the run may have been decided while the gates ran.
   */
  async #report<T extends object>(
    taskId: string,
    by: Reporter,
    kind: 'complete' | 'review',
    reviewer: Assignee | undefined,
    metadata: unknown,
    opts: ReportOptions,
    apply: (seen: { reportedCommit?: string | null; reportedDirty?: boolean | null }) => Result<T>,
  ): Promise<Result<T>> {
    if (this.#reporting.has(taskId)) {
      return board.refuse('report_in_progress', inProgress(taskId, by));
    }
    const now = board.reportCheck(this.#db, taskId, by, kind, reviewer);
    if (!now.ok) return now;
    const outputs = this.#outputsRefused(now.task, kind, metadata);
    if (outputs !== undefined) return outputs;
    // A complete the board will take as a review request runs the gates as one.
    const checkedAs = kind === 'complete' && board.completeAsksReview(now.task) ? 'review' : kind;
    // One report's checks in a checkout at a time: two reports' gates in one would trip over each other.
    const place = placeOf(now.task);
    const other = place === null ? undefined : this.#reportingIn(place);
    if (other !== undefined) {
      return board.refuse(
        'report_in_progress',
        `${placeName(place ?? '')} is running the gates of a report on another task, ${other}; ` +
          'wait for that answer, then report again',
      );
    }
    const checked = (async (): Promise<Result<T>> => {
      const seen = await this.#observe(now.run, opts.signal);
      const gates = await this.#gates(now.task, by, now.run, checkedAs, opts.signal);
      if (!gates.ok) return gates;
      // Stopped while the commit was read, with no gate to notice: what was read may be cut short.
      if (opts.signal?.aborted === true) return board.refuse('gates_cannot_run', STOPPING);
      return apply(seen);
    })();
    this.#reporting.set(taskId, { workspace: place, done: checked });
    try {
      return await checked;
    } finally {
      this.#reporting.delete(taskId);
    }
  }

  /**
   * The reported commit (spec §7.8): for an agent's report, the HEAD of the
   * directory its run works in -- the task's own, or its workspace's (spec §18)
   * -- and whether the tree had uncommitted changes; neither when that is not a
   * git repository. A person's report records neither: there is no agent state
   * to pin.
   */
  async #observe(
    run: RunRow | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ reportedCommit?: string | null; reportedDirty?: boolean | null }> {
    const checks = this.#checks;
    if (checks === undefined || run === undefined || run.agentConfig === null || run.workspace === null) return {};
    const dir = this.#dirOf(run.workspace);
    if (dir === undefined) return {};
    const read = checks.readCommit ?? commitReader();
    const state = await read(dir, { env: buildEnv(checks.env), ...(signal === undefined ? {} : { signal }) });
    return { reportedCommit: state.commit, reportedDirty: state.dirty };
  }

  /**
   * Run the task's gates, if it has any (spec §7.7): in its workspace, with the
   * environment of the role of its latest agent run -- the reporting run's, if it
   * is an agent's -- or of the role default if no agent has run on it. A gate that
   * cannot run -- no workspace, a workspace or role no longer configured -- refuses
   * the report with the reason, rather than running elsewhere or as someone else.
   */
  async #gates(
    task: TaskRow,
    by: Reporter,
    run: RunRow | undefined,
    kind: 'complete' | 'review',
    signal: AbortSignal | undefined,
  ): Promise<Result<object>> {
    const gates = gatesOf(this.#db, task.taskId);
    if (gates.length === 0) return { ok: true };
    const id = task.taskId;
    const checks = this.#checks;
    if (checks === undefined) return board.refuse('gates_cannot_run', `task ${id} has gates, and this gateway runs none`);
    if (task.workspace === null) {
      return board.refuse('gates_cannot_run', `task ${id} has gates and no workspace to run them in; set its workspace first`);
    }
    if (!checks.workspaceDirs.has(task.workspace)) {
      return board.refuse(
        'gates_cannot_run',
        `task ${id}'s workspace ${JSON.stringify(task.workspace)} is no longer configured, so its gates cannot run`,
      );
    }
    // In the task's own directory, if it has one (spec §18).
    const cwd = this.#dirOf(placeOf(task) ?? task.workspace);
    if (cwd === undefined) {
      return board.refuse(
        'gates_cannot_run',
        `task ${id}'s own directory has not been made yet, so its gates cannot run; it is made before its next agent run`,
      );
    }
    const latest = runsOf(this.#db, id).findLast((r) => r.agentConfig !== null);
    const name = latest?.assignee.name ?? DEFAULT_ROLE;
    const role = this.#roles.get(name);
    if (role === undefined) {
      return board.refuse(
        'gates_cannot_run',
        `task ${id}'s gates run with the environment of role ${JSON.stringify(name)}, which is no longer configured`,
      );
    }
    const isDirectory = checks.isDirectory ?? (checks.runGate === undefined ? directoryExists : () => true);
    if (!isDirectory(cwd)) {
      // Said plainly: the runner would only report /bin/sh missing.
      return board.refuse('gates_cannot_run', `task ${id}'s workspace directory ${cwd} does not exist`);
    }
    const ran = await runGates(gates, {
      cwd,
      env: gateEnv(role, checks.env),
      runner: checks.runGate ?? spawnGate,
      clock: this.#clock,
      ...(signal === undefined ? {} : { signal }),
    });
    board.recordGates(
      this.#db,
      id,
      { runId: run?.runId ?? null, actor: by.kind === 'run' ? `run:${by.runId}` : by.principal },
      kind,
      ran,
      this.#clock.now(),
    );
    if (ran.passed) return { ok: true };
    if (ran.aborted) return board.refuse('gates_cannot_run', STOPPING);
    const failed = ran.results.at(-1);
    if (failed === undefined) throw new Error('gates that did not pass ran none');
    const timeoutS = gates.find((g) => g.id === failed.gateId)?.timeoutS ?? 0;
    return {
      ok: false,
      code: 'gate_failed',
      // Masked before it is quoted: quoting escapes a `"` or `\` in a secret, and
      // the escaped form no longer matches it.
      message:
        `gate ${JSON.stringify(redactKnownSecrets(failed.command))} ${verdict(failed, timeoutS)}; ` +
        'the report was not applied: fix it and report again',
      gate: {
        command: failed.command,
        exitCode: failed.exitCode,
        signal: failed.signal,
        timedOut: failed.timedOut,
        output: failed.output,
      },
    };
  }

  /**
   * Where a claim of the task now would put its run (spec §18.2): its own
   * directory, the one its first agent claim in an isolated workspace would give
   * it, or its workspace's shared one; null while its workspace is not fixed,
   * which the claim's own transaction checks once it is.
   */
  #placeFor(task: TaskRow): string | null {
    if (task.worktree !== null || task.workspace === null) return placeOf(task);
    const who = task.phase === 'review' ? task.reviewer : task.assignee;
    const fresh =
      who?.kind === 'role' &&
      this.#isolated.has(task.workspace) &&
      !runsOf(this.#db, task.taskId).some((r) => r.agentConfig !== null);
    return fresh ? worktreeId(task.taskId) : task.workspace;
  }

  /** A place's directory: a task's own, as recorded once it was made (spec §18), or a configured workspace's. */
  #dirOf(place: string): string | undefined {
    if (isWorktreeId(place)) return worktreeOf(this.#db, place)?.rootPath;
    return this.#checks?.workspaceDirs.get(place);
  }

  requestChanges(taskId: string, by: Reporter, reason: string): Result<{ task: TaskRow; run: RunRow | undefined }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (!isText(reason) || reason.trim() === '') {
      return board.refuse('invalid', 'changes need a reason the assignee can act on');
    }
    // Not while a report on the task runs its gates, as for complete: that report,
    // the reviewer's own approval perhaps, is answered first (spec §5.1).
    if (this.#reporting.has(taskId)) {
      return board.refuse('report_in_progress', inProgress(taskId, by));
    }
    return board.requestChanges(this.#db, taskId, by, reason, this.#clock.now());
  }

  /** `kind` arrives as text from an agent's JSON or from chat, so it is checked here. */
  block(
    taskId: string,
    by: Reporter,
    report: { kind: string; reason: string; parents?: readonly string[] },
  ): Result<{ task: TaskRow; run: RunRow | undefined }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (!isRecord(report)) return board.refuse('invalid', 'a block is an object with a kind and a reason');
    const kind = REPORTABLE.find((k) => k === report.kind);
    if (kind === undefined) {
      return board.refuse(
        'invalid',
        report.kind === 'gave_up'
          ? "gave_up is set by the board's breaker, never reported"
          : `unknown block kind ${JSON.stringify(report.kind)} (one of ${REPORTABLE.join(', ')})`,
      );
    }
    if (!isText(report.reason) || report.reason.trim() === '') {
      return board.refuse('invalid', 'a block needs a reason');
    }
    if (report.parents !== undefined && !isTextList(report.parents)) {
      return board.refuse('invalid', 'parents are a list of task ids');
    }
    if (report.parents !== undefined && kind !== 'dependency') {
      return board.refuse('invalid', `only a dependency block names parents, not ${kind}`);
    }
    return this.#cancelled(
      board.block(
        this.#db,
        taskId,
        by,
        { kind, reason: report.reason, ...(report.parents === undefined ? {} : { parents: report.parents }) },
        this.#clock.now(),
        this.#facts(),
      ),
    );
  }

  /**
   * `blockedAt`: an Unblock button's, the event that blocked the task as its
   * notice told it (spec §9.2); refused once that block has been lifted.
   */
  unblock(taskId: string, by: string, comment?: string, opts: { blockedAt?: number; wake?: number } = {}): Result<{ task: TaskRow }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (comment !== undefined && !isText(comment)) return board.refuse('invalid', 'a comment is text');
    if (opts.blockedAt !== undefined && !Number.isSafeInteger(opts.blockedAt)) {
      return board.refuse('invalid', 'a block is an event id, a whole number');
    }
    return board.unblock(this.#db, taskId, by, comment, this.#clock.now(), opts);
  }
  /**
   * A handler's run's `mt kanban unblock` (workflow routing spec §5.4): only its
   * work run, and only for the task its route was made from, found by its route
   * row, whatever its body says; while that task is still blocked by the route's
   * event, `stale` once anyone else lifted it. Its authority is the operator's
   * file, with no tier. A repeat of the same run's own unblock answers
   * `changed: false`. Its comment, if any, steers the next run, prefixed with
   * the handler's ref.
   */
  unblockFromHandler(run: RunRow, taskId: string, comment?: string): Result<{ task: TaskRow; changed: boolean }> {
    if (comment !== undefined && !isText(comment)) return board.refuse('invalid', 'a comment is text');
    const route = routeOfHandler(this.#db, run.taskId);
    if (route === undefined || run.kind !== 'work' || !isText(taskId) || route.fromTask !== taskId) {
      return board.refuse('wrong_task', `run ${run.runId} may unblock only the task its handler was routed from`);
    }
    const lifted = this.#db
      .prepare<[string, number], { actor: string }>("SELECT actor FROM kanban_events WHERE task_id = ? AND kind = 'unblocked' AND id > ? ORDER BY id LIMIT 1")
      .get(taskId, route.eventId);
    if (lifted?.actor === `run:${run.runId}`) {
      const task = getTask(this.#db, taskId);
      if (task === undefined) return board.refuse('not_found', `no task ${taskId}`);
      return { ok: true, task, changed: false };
    }
    const ref = memberOf(this.#db, run.taskId)?.ref ?? route.handler;
    const r = board.unblock(this.#db, taskId, `run:${run.runId}`, comment, this.#clock.now(), { blockedAt: route.eventId, handler: ref });
    return r.ok ? { ok: true, task: r.task, changed: true } : r;
  }

  /**
   * A woken turn's `task show` (wake spec §9.2), given its delivered wake: a task
   * with an event among the wake's, of any kind, while the setter has talk tier.
   * Any other task is `unauthorized`, in words that do not say whether it exists.
   * Writes nothing.
   */
  showForWake(wake: WakeRow, taskId: string, judge: WakeJudge): Result<{ view: TaskView; gates: GateRow[] }> {
    if (!isText(taskId) || !wakeOutcomesOf(this.#db, wake.wakeId).some((o) => o.event.taskId === taskId)) {
      return board.refuse('unauthorized', NOT_IN_WAKE);
    }
    // A wake turned off or taken over since: the task is no longer this wake's.
    if (!stillWakes(getTask(this.#db, taskId), wake)) return board.refuse('unauthorized', NOT_IN_WAKE);
    if (!judge.canTalk(wake.principal)) {
      return board.refuse('needs_talk', `${setterName(wake, judge)}, who set this wake, does not have talk tier, which task show needs`);
    }
    const shown = this.show(taskId);
    if (!shown.ok) return shown;
    return { ok: true, view: shown.view, gates: gatesOf(this.#db, taskId) };
  }

  /**
   * A woken turn's `task unblock` (wake spec §9.2, §9.3), given its delivered
   * wake, checked in the spec's order: the task's block among the wake's events,
   * the latest when it has two; the setter's operate tier, live; the block's
   * recurrences below the limit; fewer than `max_depth` woken unblocks since the
   * task last completed; then the board's own, bound to that block, by the setter,
   * with the wake in its event.
   */
  unblockForWake(wake: WakeRow, taskId: string, comment: string | undefined, judge: WakeJudge): Result<{ task: TaskRow; setter: string }> {
    const blocks = isText(taskId)
      ? wakeOutcomesOf(this.#db, wake.wakeId).filter((o) => o.event.taskId === taskId && isBlockOutcome(o.event))
      : [];
    const block = blocks.at(-1)?.event;
    if (block === undefined) {
      return board.refuse('not_this_wake', `\`${visible(taskId)}\` did not wake this turn: a woken turn unblocks only the tasks whose blocks woke it`);
    }
    if (!stillWakes(getTask(this.#db, taskId), wake)) {
      return board.refuse(
        'not_this_wake',
        `\`${taskId}\`'s wake has been turned off or taken over since it woke this turn, so this turn does not unblock it`,
      );
    }
    const setter = setterName(wake, judge);
    if (!judge.canOperate(wake.principal)) {
      return board.refuse(
        'needs_operator',
        `${setter}, who set this wake, does not have operate tier, which unblocking needs: ask in the thread for someone who can`,
      );
    }
    const recurrences = (block.payload as Record<string, unknown>)['blockRecurrences'];
    if (typeof recurrences === 'number' && recurrences >= judge.blockRecurrenceLimit) {
      return board.refuse(
        'recurring',
        `\`${taskId}\` has been blocked ${recurrences} times in a row: a person decides whether it is unblocked again`,
      );
    }
    const woken = wokenUnblocksSince(this.#db, taskId);
    const limit = this.#wake.maxDepth;
    if (woken >= limit) {
      return board.refuse(
        'woken_unblock_limit',
        `\`${taskId}\` has been unblocked by woken turns ${woken} times since it last completed: a person decides whether it is unblocked again`,
      );
    }
    const r = this.unblock(taskId, wake.principal, comment, { blockedAt: block.id, wake: wake.wakeId });
    return r.ok ? { ok: true, task: r.task, setter } : r;
  }


  /** What a person's card for this run shows of the board (spec §9.2); undefined for a run not on it. */
  cardReading(runId: string): CardReading | undefined {
    return isText(runId) ? cardReading(this.#db, runId) : undefined;
  }

  /** A person's run was sent its card, or the channel refused it for good (spec §9.2). */
  recordCard(runId: string, card: board.CardOutcome): Result<{ recorded: boolean }> {
    if (!isText(runId)) return board.refuse('invalid', 'a run id is text');
    return board.recordCard(this.#db, runId, card, this.#clock.now());
  }

  /** A message of notices was sent with Unblock buttons (spec §9.2, amended by the unblock redraw): the notifier records it. */
  recordUnblockButtons(message: board.UnblockMessage): Result<{ recorded: number }> {
    if (!isText(message.messageId) || message.buttons.some((b) => !isText(b.taskId) || !Number.isSafeInteger(b.blockEvent))) {
      return board.refuse('invalid', 'a message id and a task id are text, and a block an event id');
    }
    return board.recordUnblockButtons(this.#db, message, this.#clock.now());
  }

  /**
   * A notice rendered without a block's Unblock button, at the waker's word, has
   * been sent (wake spec §5.9): the notifier writes the deferral, `held` since the
   * send, before its cursor moves, with the notice's message id when it went as
   * a card, null as text. A row already there stands.
   */
  deferButton(sub: SubscriptionRow, event: KanbanEvent, sentAt: number, noticeId: string | null = null): Result<{ deferred: boolean }> {
    return board.deferButton(this.#db, { subscriptionId: sub.id, eventId: event.id }, sentAt, noticeId);
  }

  /** A held deferred button made due, with why (wake spec §5.9). */
  buttonDue(key: DeferredKey, why: DeferredWhy): Result<{ changed: boolean }> {
    return board.buttonDue(this.#db, key, why);
  }

  /** A deferred button whose block was lifted, or whose task was archived: no card (wake spec §5.9). */
  buttonLifted(key: DeferredKey): Result<{ changed: boolean }> {
    return board.buttonLifted(this.#db, key, this.#clock.now());
  }

  /** A due button's card sent (wake spec §5.9). */
  buttonSent(key: DeferredKey, messageId: string): Result<{ changed: boolean }> {
    if (!isText(messageId) || messageId === '') return board.refuse('invalid', 'a message id is text');
    return board.buttonSent(this.#db, key, messageId, this.#clock.now());
  }

  /** A deferred button given up (wake spec §5.9). */
  buttonFailed(key: DeferredKey): Result<{ changed: boolean }> {
    return board.buttonFailed(this.#db, key, this.#clock.now());
  }

  /** One more send of a due button's card tried (wake spec §5.9). */
  buttonTried(key: DeferredKey): Result<{ attempts: number }> {
    return board.buttonTried(this.#db, key);
  }

  /** A run found due a progress card gets its row (progress cards spec §4). */
  openProgressCard(runId: string, appId: string, channel: string, failureLimit: number): Result<{ opened: boolean }> {
    if (!isText(runId) || !isText(appId) || !isText(channel) || !Number.isSafeInteger(failureLimit)) {
      return board.refuse('invalid', 'a run id, an app id and a channel are text, and a failure limit a whole number');
    }
    return board.openProgressCard(this.#db, { runId, appId, channel, failureLimit }, this.#clock.now());
  }

  /** A progress card's first send landed. */
  progressCardSent(runId: string, messageId: string, readSeq: number): Result<{ changed: boolean }> {
    if (!isText(runId) || !isText(messageId) || messageId === '' || !Number.isSafeInteger(readSeq)) {
      return board.refuse('invalid', 'a run id and a message id are text, and a seq a whole number');
    }
    return board.progressCardSent(this.#db, runId, messageId, readSeq, this.#clock.now());
  }

  /** An update of a progress card landed. */
  progressCardDrawn(runId: string, readSeq: number): Result<{ changed: boolean }> {
    if (!isText(runId) || !Number.isSafeInteger(readSeq)) return board.refuse('invalid', 'a run id is text, and a seq a whole number');
    return board.progressCardDrawn(this.#db, runId, readSeq, this.#clock.now());
  }

  /** Lark refused a progress card's send or update; answers how many in a row. */
  progressCardRefused(runId: string): Result<{ failures: number }> {
    if (!isText(runId)) return board.refuse('invalid', 'a run id is text');
    return board.progressCardRefused(this.#db, runId);
  }

  /** A progress card drawn final. */
  progressCardFinal(runId: string, readSeq: number): Result<{ changed: boolean }> {
    if (!isText(runId) || !Number.isSafeInteger(readSeq)) return board.refuse('invalid', 'a run id is text, and a seq a whole number');
    return board.progressCardFinal(this.#db, runId, readSeq, this.#clock.now());
  }

  /** A progress card let go of. */
  progressCardLetGo(runId: string): Result<{ changed: boolean }> {
    if (!isText(runId)) return board.refuse('invalid', 'a run id is text');
    return board.progressCardLetGo(this.#db, runId);
  }

  /** A recorded message's buttons were redrawn, or the redraw tried, for these lifts: never tried again. */
  markUnblockRedrawn(messageId: string, lifts: ReadonlyArray<{ taskId: string; liftEvent: number }>): Result<{ marked: number }> {
    return board.markUnblockRedrawn(this.#db, messageId, lifts);
  }

  /** Stop the task's open run; given `runId`, only while that run is the open one (progress cards spec §8.2). */
  stop(taskId: string, by: string, opts: { runId?: string } = {}): Result<{ task: TaskRow; run: RunRow }> {
    const ids = opts.runId === undefined ? idsRefused(taskId) : idsRefused(taskId, opts.runId);
    if (ids !== undefined) return ids;
    return board.stop(this.#db, taskId, by, this.#clock.now(), opts.runId);
  }

  archive(taskId: string, by: string): Result<{ task: TaskRow; run: RunRow | undefined }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    return this.#cancelled(board.archive(this.#db, taskId, by, this.#clock.now(), this.#facts()));
  }

  /** The tasks a reaction task's wake carried, in event order (wake spec §19.9); null for any other task. */
  reactsTo(taskId: string): string[] | null {
    return hasWakeColumns(this.#db) ? reactsTo(this.#db, taskId) : null;
  }

  show(taskId: string): Result<{ view: TaskView }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    const view = taskView(this.#db, taskId);
    if (view === undefined) return board.refuse('not_found', `no task ${taskId}`);
    const waiting = this.#waiting(view);
    const withWaiting = waiting.length === 0 ? view : { ...view, waiting };
    return { ok: true, view: this.#unmade(view) ? { ...withWaiting, workdir: { path: null, branch: null, first: true } } : withWaiting };
  }

  /**
   * A task that can still run, in an isolated workspace, fixed or as its next
   * claim would resolve it, that no agent has taken up: its first agent claim
   * gives it a directory of its own (spec §18.2).
   */
  #unmade(view: TaskView): boolean {
    const { task } = view;
    if (task.worktree !== null || task.phase === 'done' || task.phase === 'archived') return false;
    if (view.runs.some((r) => r.agentConfig !== null)) return false;
    const who = task.phase === 'review' ? task.reviewer : task.assignee;
    const workspace = this.#claimWorkspace(view, who?.kind === 'role' ? this.#roles.get(who.name) : undefined);
    return workspace !== undefined && this.#isolated.has(workspace);
  }

  /**
   * The workspace a claim of the task now would give it: its own, or, while it
   * has none, as the claim resolves it (spec §2.3) for a run of `role`, or of a
   * person when undefined; undefined when its parents' workspaces conflict.
   */
  #claimWorkspace(view: TaskView, role: Role | undefined): string | undefined {
    const { task } = view;
    if (task.workspace !== null) return task.workspace;
    const from = task.createdFromTask === null ? undefined : getTask(this.#db, task.createdFromTask);
    const resolved = resolveTaskWorkspace({
      own: null,
      roleWorkspace: role?.workspace,
      upstream: view.parents.length > 0 ? view.parents.map((p) => p.workspace) : from === undefined ? [] : [from.workspace],
      boardWorkspace: getBoard(this.#db, task.board)?.workspace ?? null,
    });
    return 'conflict' in resolved ? undefined : resolved.workspace;
  }

  /**
   * Why a task the dispatcher would try is not claimed yet (spec §6.2, §6.3,
   * §16): a ready task, or one in review with nobody reviewing yet, with no open
   * run and no cooldown, for a role. The gateway's `kanban.max_running`, its
   * board's and its role's, and a workspace held by another task's agent run:
   * every one that holds, by the dispatcher's own checks (`waiting.ts`) and the
   * claim's own query. Nothing is said of a task the claim would refuse
   * whatever the limits: one whose role is not configured or cannot be read,
   * whose workspace, fixed or as it would be resolved (spec §2.3), is not
   * configured, or whose parents are in different workspaces.
   */
  #waiting(view: TaskView): Waiting[] {
    const { task } = view;
    if (view.status !== 'ready' && view.status !== 'review') return [];
    if (view.runs.some((r) => r.endedAt === null)) return [];
    if (task.cooldownUntil !== null && task.cooldownUntil > this.#clock.now()) return [];
    const who = task.phase === 'review' ? task.reviewer : task.assignee;
    if (who?.kind !== 'role') return [];
    // As the claim reads the role: not configured, or its files unreadable, is no wait.
    const claimant = this.#claimant(task);
    if (!claimant.ok) return [];
    const role = claimant.role;
    // The workspace the claim would give it, resolved as the claim resolves it.
    const workspace = this.#claimWorkspace(view, role);
    if (workspace === undefined || !this.#workspaces.has(workspace)) return [];
    const reached = limitsReached(this.#db, {
      maxRunning: this.#maxRunning,
      board: task.board,
      boardMaxRunning: getBoard(this.#db, task.board)?.maxRunning ?? null,
      role: who.name,
      roleMaxRunning: role === undefined ? undefined : roleLimit(role, this.#maxRunningPerRole)?.limit,
    });
    // A task with a directory of its own, or about to get one, holds no shared directory (spec §18).
    const own =
      task.worktree !== null || (this.#isolated.has(workspace) && !view.runs.some((r) => r.agentConfig !== null));
    const busy = own ? undefined : workspaceBusy(this.#db, workspace);
    return busy === undefined ? reached : [...reached, busy];
  }

  /** Every task on a board -- or on every board -- with its display status (spec §4.1): `/kanban task list`. */
  list(onBoard?: string): BoardEntry[] {
    return boardList(this.#db, onBoard);
  }

  /** When each of a board's tasks last changed phase, in one read (kanban spec §22.3): `mt kanban task list`'s times. */
  phaseSince(onBoard: string): ReadonlyMap<string, number> {
    return phaseSince(this.#db, onBoard);
  }

  /**
   * A subscription has been told of every event up to `cursor`, or passed over
   * those that are no notice (spec §9.4). The notifier calls it after each send.
   */
  advanceSubscription(subscriptionId: number, cursor: number): Result<{ advanced: boolean }> {
    if (!Number.isSafeInteger(subscriptionId) || !Number.isSafeInteger(cursor) || cursor < 0) {
      return board.refuse('invalid', 'a subscription and its cursor are whole numbers');
    }
    return board.advanceSubscription(this.#db, subscriptionId, cursor);
  }

  /**
   * The tasks' subscriptions at this chat moved into the thread their "Created"
   * reply opened, with the command message as its root, in one call (spec
   * §19.4, workflows spec §9): `KanbanChat`'s, once Lark answered the reply with its thread.
   * One task for `/kanban task new`; every member for a workflow's start.
   */
  threadSubscriptions(taskIds: readonly string[], at: ChatAt, threadId: string, rootId: string): Result<{ moved: number }> {
    if (!isTextList(taskIds)) return board.refuse('invalid', 'task ids are text');
    const ids = idsRefused(threadId, rootId);
    if (ids !== undefined) return ids;
    if (!isRecord(at) || !isText(at.channel) || !isText(at.appId) || !isText(at.conversationId)) {
      return board.refuse('invalid', 'a chat is its channel, bot and conversation, as text');
    }
    return board.threadSubscriptions(this.#db, taskIds, at, threadId, rootId);
  }

  // -------------------------------------------------------------------------
  // Workflows (workflows spec §6)
  // -------------------------------------------------------------------------

  /** The team, as a workflow file is checked against it (workflows spec §4). */
  #workflowFacts(): WorkflowFacts {
    return { roles: this.#roles, workspaces: this.#workspaces, supervisedRoles: this.#supervisedRoles };
  }

  /**
   * A workflow, read now (workflows spec §4), or the refusal a start gets: for no
   * usable file of that name, `unknown_workflow`, naming the usable ones and
   * their params, cut at 4 KiB, the names first.
   */
  #workflow(name: unknown): Result<{ workflow: Workflow }> {
    const dir = this.#workflowsDir;
    const read =
      dir === undefined ? board.refuse('unknown_workflow', `there is no workflow ${visible(JSON.stringify(String(name)))}`) : readWorkflow(dir, name as string, this.#workflowFacts());
    if (read.ok || read.code !== 'unknown_workflow') return read;
    return board.refuse('unknown_workflow', this.#usable(read.message));
  }

  /** `message`, then the usable workflows and their params, at most 4 KiB. */
  #usable(message: string): string {
    const usable = this.workflows().usable;
    return usableMessage(message, usable, WORKFLOW_MESSAGE_BYTES);
  }

  /** The board a start or an apply goes on (workflows spec §6): a run's task's, whatever else; otherwise the one asked for, else `default`. */
  #boardFor(via: CreatedVia, asked: string | null | undefined): Result<{ board: string; run?: RunRow }> {
    if (via.kind !== 'run') return { ok: true, board: asked ?? DEFAULT_BOARD };
    const run = getRun(this.#db, via.runId);
    if (run === undefined) return board.refuse('not_found', `no run ${via.runId}`);
    const task = getTask(this.#db, run.taskId);
    if (task === undefined) return board.refuse('not_found', `no task ${run.taskId}`);
    return { ok: true, board: task.board, run };
  }

  /**
   * Step 2 of an apply (workflows spec §6): the board as the database has it now, then
   * every task checked as `create` would, every gate as `addGate`, every name,
   * against the team and the people as this process holds them, just before the
   * transaction, so a refusal costs none.
   */
  #checkDag(dag: Dag, onBoard: string, createdBy: string, createdVia: CreatedVia, workflow?: string): Refusal | undefined {
    const found = getBoard(this.#db, onBoard);
    // A file's own board is refused naming the workflow (workflows spec §19.4).
    if (found === undefined) {
      return board.refuse('unknown_board', workflow === undefined ? `there is no board ${visible(onBoard)}` : `workflow ${workflow} is not usable: ${missingBoardProblem(onBoard)}`);
    }
    if (found.archivedAt !== null) {
      return board.refuse(
        'board_archived',
        workflow === undefined ? `board ${onBoard} is archived; nothing is added to it` : `workflow ${workflow} is not usable: ${archivedBoardProblem(onBoard)}`,
      );
    }
    return checkDagTasks(dag, { facts: this.#facts(), createdBy, createdVia });
  }

  /** The writer's members of a checked DAG: each task's fields, its parents as earlier positions, its gates. */
  #members(dag: Dag, wake?: StartWakeOf): board.NewMember[] {
    const at = new Map(dag.tasks.map((t, i) => [t.ref, i]));
    const wakeOf = (t: DagTask): board.NewWake | undefined => memberWake(t.wake, wake);
    const as = (name: string | null): Assignee | null => (name === null ? null : { kind: name.includes(':') ? 'human' : 'role', name });
    return dag.tasks.map((t) => ({
      task: {
        title: t.title,
        ...(t.body === null ? {} : { body: t.body }),
        contract: t.contract,
        assignee: as(t.assignee),
        reviewer: as(t.reviewer),
        workspace: t.workspace,
        priority: t.priority,
        failureLimit: t.failure_limit,
        retryOnCrash: t.retry_on_crash,
        maxRuntimeS: t.max_runtime_s,
        ...(wakeOf(t) === undefined ? {} : { wake: wakeOf(t) as board.NewWake }),
      },
      ref: t.ref,
      step: t.step,
      item: t.item,
      parents: t.parents.map((p) => at.get(p) ?? -1),
      gates: t.gates.map((g) => ({ command: g.command, timeoutS: g.timeout_s })),
    }));
  }

  /** A start's expansion (workflows spec §6 step 1): the file read now, its params, the DAG made, shaped and measured. */
  #expanded(req: StartRequest, onBoard: string): Result<ShapedDag & { workflow: Workflow; board: string; fromFile: boolean; plan: Plan | null }> {
    if (!isRecord(req)) return board.refuse('invalid', 'a start is an object');
    if (!isText(req.workflow)) return board.refuse('invalid', "a workflow is a workflow's name, as text");
    const read = this.#workflow(req.workflow);
    if (!read.ok) return read;
    // The board, now the file is read (workflows spec §19.2): chat's is overruled by the file, the terminal's only when not asked for.
    const kind = req.createdVia?.kind;
    const path: BoardPath = kind === 'chat' ? { kind: 'chat', board: onBoard } : kind === 'run' ? { kind: 'run', board: onBoard } : { kind: 'terminal', board: req.board };
    const routed = startBoard(read.workflow, path);
    if (!routed.ok) return routed;
    // The start's kind, for an `@` with no mention to resolve it by: the terminal's refusal, or a run's (workflows spec §18.3).
    const expanded = expand(read.workflow, req.params, routed.board, req.personOf, kind);
    if (!expanded.ok) return expanded;
    const shaped = checkDagShape(expanded.dag, 'expansion');
    if (!shaped.ok) return shaped;
    return { ...shaped, workflow: read.workflow, board: routed.board, fromFile: routed.fromFile, plan: expanded.plan };
  }

  /**
   * What a start checks of its plan beyond the file (workflow routing spec §6, §8):
   * a database migrated to 015; no step with outputs whose assignee, as the
   * params named it, is a person (§2.1); and each template of a step made later
   * checked as `create` would check it, every reference to a result filled with
   * its type's widest form, a stand-in with its step's reviewer, gates and
   * contract (§5.2), so a template too long already is refused now, not cut later.
   */
  #checkPlan(plan: Plan | null, createdBy: string, createdVia: CreatedVia): Refusal | undefined {
    if (plan === null) return undefined;
    if (!hasRouting(this.#db)) return board.refuse('invalid', board.ROUTING_NOT_MIGRATED);
    const byName = new Map(plan.steps.map((s) => [s.step, s]));
    const templatesOf = (s: PlanStep): Array<Template & { item: string | null }> => s.templates ?? (s.template === undefined ? [] : [{ ...s.template, item: null }]);
    const tasks: DagTask[] = [];
    for (const s of plan.steps) {
      for (const t of templatesOf(s)) {
        if (Object.keys(s.outputs).length > 0 && t.assignee !== null && t.assignee.includes(':')) {
          return board.refuse('invalid', `steps.${s.step} declares outputs, which a role's run reports in its metadata, and its assignee is a person: a person's done gives none`);
        }
      }
      if (s.made === 'start') continue;
      const source = s.for_each !== undefined && 'step' in s.for_each ? byName.get(s.for_each.step)?.outputs[s.for_each.output] : undefined;
      const item = s.for_each !== undefined && 'step' in s.for_each ? itemPlaceholderOf(source) : s.handler === true ? itemPlaceholderOf(undefined) : undefined;
      const fill = (text: string): string => fillText(text, (step, output) => placeholderOf(byName.get(step)?.outputs[output]), item);
      // A stand-in is checked with each template of its step: its reviewer, its gates before its own, its contract merged (§5.2).
      const stood = s.stands_in_for === undefined ? undefined : byName.get(s.stands_in_for);
      const against: Array<Template | undefined> = stood === undefined ? [undefined] : templatesOf(stood);
      for (const [n, t] of templatesOf(s).entries()) {
        for (const theirs of against) {
          tasks.push({
            ref: templatesOf(s).length > 1 ? `${s.step}:${n + 1}` : s.step,
            step: s.step,
            item: t.item,
            title: fill(t.title),
            body: t.body === null ? null : fill(t.body),
            assignee: t.assignee,
            reviewer: theirs === undefined ? t.reviewer : theirs.reviewer,
            workspace: t.workspace,
            priority: t.priority,
            contract: theirs === undefined ? t.contract : standInContract(s.stands_in_for ?? '', theirs.contract, t.contract),
            failure_limit: t.failure_limit,
            retry_on_crash: t.retry_on_crash,
            max_runtime_s: t.max_runtime_s,
            parents: [],
            gates: theirs === undefined ? t.gates : [...theirs.gates, ...t.gates],
          });
        }
      }
    }
    if (tasks.length === 0) return undefined;
    return checkDagTasks({ format: 1, workflow: null, params: {}, board: null, tasks }, { facts: this.#facts(), createdBy, createdVia });
  }

  /** The wakes the steps made later ask for (wake spec §3.1, §19.1), one a step: the DAG holds only the plain steps', and a start checks these as it checks theirs. */
  #plannedAsks(plan: Plan | null, w: Workflow): Array<true | { role: string } | undefined> {
    if (plan === null) return [];
    const later = new Set(plan.steps.filter((s) => s.made !== 'start').map((s) => s.step));
    return w.steps.filter((s) => later.has(s.name)).map((s) => (s.wake === true ? (true as const) : s.wake === false ? undefined : { role: s.wake.role }));
  }

  /** The plan with each template's wake, as the start resolved it for its step (workflow routing spec §7.3); a run's start's late members inherit theirs at the making. */
  #plannedWakes(plan: Plan | null, w: Workflow, wake: StartWakeOf | undefined): Plan | null {
    if (plan === null) return null;
    const asks = new Map(w.steps.map((s) => [s.name, s.wake === true ? (true as const) : s.wake === false ? undefined : { role: s.wake.role }]));
    const withWake = <T extends Template>(t: T, step: string): T => {
      const resolved = memberWake(asks.get(step), wake);
      return {
        ...t,
        wake:
          resolved === undefined
            ? null
            : { by: resolved.by, depth: resolved.depth, ...(resolved.tooDeep === true ? { tooDeep: true as const } : {}), ...(resolved.role === undefined ? {} : { role: resolved.role }) },
      };
    };
    return {
      ...plan,
      steps: plan.steps.map((s) => ({
        ...s,
        ...(s.template === undefined ? {} : { template: withWake(s.template, s.step) }),
        ...(s.templates === undefined ? {} : { templates: s.templates.map((t) => withWake(t, s.step)) }),
      })),
    };
  }

  /**
   * What a start would make, making nothing (workflows spec §6): every check a start
   * makes before its transaction, the board's and the people's included, but
   * not the key's, as a preview has none of its own.
   */
  previewWorkflow(req: StartRequest): Result<{ dag: Dag; workflow: Workflow; plan: Plan | null }> {
    const on = this.#boardFor(req.createdVia, req.board);
    if (!on.ok) return on;
    const shaped = this.#expanded(req, on.board);
    if (!shaped.ok) return shaped;
    const refused =
      this.#checkDag(shaped.dag, shaped.board, req.createdBy, req.createdVia, shaped.fromFile ? shaped.workflow.name : undefined) ??
      this.#checkPlan(shaped.plan, req.createdBy, req.createdVia);
    if (refused !== undefined) return refused;
    return { ok: true, dag: shaped.dag, workflow: shaped.workflow, plan: shaped.plan };
  }

  /**
   * Start a workflow (workflows spec §6): its key looked up first, read-only, so a
   * repeat is answered whatever the file says now; then the expansion, the
   * checks, and the one transaction. The caller tells the dispatcher.
   */
  startWorkflow(req: StartRequest): Result<WorkflowMade> {
    if (!isRecord(req)) return board.refuse('invalid', 'a start is an object');
    if (!isText(req.workflow)) return board.refuse('invalid', "a workflow is a workflow's name, as text");
    if (req.createdVia?.kind === 'wake') return board.refuse('invalid', BY_A_WAKE);
    const follow = followRefused(req.follow, req.createdVia);
    if (follow !== undefined) return follow;
    const on = this.#boardFor(req.createdVia, req.board);
    if (!on.ok) return on;
    const key = this.#idempotencyKey(req.idempotencyKey, req.createdVia);
    if (!key.ok) return key;
    // A chat's board, or an unasked terminal one, is one the file may overrule (workflows spec §19.2).
    const overruled = req.createdVia?.kind === 'chat' || (req.createdVia?.kind === 'operator' && req.board === undefined);
    const repeat = key.key === null ? undefined : this.#repeat(key.key, { board: on.board, source: 'start', name: req.workflow }, overruled ? req.workflow : undefined);
    if (repeat !== undefined) return repeat;
    const shaped = this.#expanded(req, on.board);
    if (!shaped.ok) return shaped;
    const refused =
      this.#checkDag(shaped.dag, shaped.board, req.createdBy, req.createdVia, shaped.fromFile ? shaped.workflow.name : undefined) ??
      this.#checkPlan(shaped.plan, req.createdBy, req.createdVia);
    if (refused !== undefined) return refused;
    const wake = this.#startWake(req, [...shaped.dag.tasks.map((t) => t.wake), ...this.#plannedAsks(shaped.plan, shaped.workflow)]);
    if (!wake.ok) return wake;
    const plan = this.#plannedWakes(shaped.plan, shaped.workflow, wake.wake);
    // The expansion measured the plan as it filled it; the stored form, masked and with its wakes, is measured again (§7.3).
    const size = plan === null ? 0 : Buffer.byteLength(JSON.stringify(maskPlan(plan, redactKnownSecrets)), 'utf8');
    if (size > DAG_LIMITS.bytes) {
      return board.refuse('too_large', `workflow ${shaped.workflow.name}'s plan is ${size} bytes with these params; it may be at most ${DAG_LIMITS.bytes}`);
    }
    return this.#write(shaped, {
      plan,
      ...(wake.wake === undefined ? {} : { wake: wake.wake }),
      ...(wake.wakeNote === undefined ? {} : { wakeNote: wake.wakeNote }),
      name: shaped.workflow.name,
      source: 'start',
      board: shaped.board,
      key: key.key,
      createdBy: req.createdBy,
      createdVia: req.createdVia,
      ...(req.follow === undefined ? {} : { follow: req.follow }),
    });
  }

  /**
   * Make a DAG (workflows spec §6), at the terminal or from a run: read already, it is
   * shaped, made canonical and measured first, as an unknown key or the wrong
   * shape is no DAG at all; then its key is looked up, compared by the DAG's
   * hash; then the checks, and with `dryRun` nothing more; else the one
   * transaction. A run's DAG takes no gates, and its board is its task's.
   */
  applyDag(req: ApplyRequest): Result<WorkflowMade | WorkflowDryRun> {
    if (!isRecord(req)) return board.refuse('invalid', 'an apply is an object');
    if (req.createdVia?.kind === 'wake') return board.refuse('invalid', BY_A_WAKE);
    const shaped = checkDagShape(req.dag, req.createdVia?.kind === 'run' ? 'run' : 'terminal');
    if (!shaped.ok) return shaped;
    const follow = followRefused(req.follow, req.createdVia);
    if (follow !== undefined) return follow;
    const on = this.#boardFor(req.createdVia, shaped.dag.board);
    if (!on.ok) return on;
    if (on.run !== undefined && shaped.dag.board !== null && shaped.dag.board !== on.board) {
      return board.refuse(
        'other_board',
        `the DAG is for board ${visible(shaped.dag.board)}, and a run's work stays on its task's board, ${on.board}`,
      );
    }
    const key = this.#idempotencyKey(req.idempotencyKey, req.createdVia);
    if (!key.ok) return key;
    const want = { board: on.board, source: 'apply' as const, name: shaped.dag.workflow, sha256: shaped.sha256 };
    const repeat = key.key === null ? undefined : this.#repeat(key.key, want);
    if (repeat !== undefined) {
      if (!repeat.ok || req.dryRun !== true) return repeat;
      return { ok: true, dryRun: true, existing: true, instanceId: repeat.instance.instanceId, board: on.board, tasks: shaped.dag.tasks };
    }
    // A DAG labelled with a file that uses routing keys is refused: only a start keeps its checks and routes (workflow routing spec §13.5).
    if (req.createdVia?.kind !== 'run' && shaped.dag.workflow !== null && this.#workflowsDir !== undefined) {
      const routed = workflowRouting(this.#workflowsDir, shaped.dag.workflow);
      if (routed.file === 'read' && routed.keys.length > 0) return board.refuse('invalid', routedDagProblem(shaped.dag.workflow, routed.keys));
    }
    // A DAG that names a workflow whose file names a board is held to it, by the file as it is now (workflows spec §19.3).
    let fromFile: string | undefined;
    if (req.createdVia?.kind !== 'run' && shaped.dag.workflow !== null) {
      const read = this.workflowBoard(shaped.dag.workflow);
      if (read.file === 'read' && read.board !== undefined) {
        const asked = shaped.dag.board ?? DEFAULT_BOARD;
        if (asked !== read.board) {
          return board.refuse('other_board', `the DAG names workflow ${shaped.dag.workflow}, which puts its tasks on board ${read.board}, not ${visible(asked)}`);
        }
        fromFile = shaped.dag.workflow;
      }
    }
    const refused = this.#checkDag(shaped.dag, on.board, req.createdBy, req.createdVia, fromFile);
    if (refused !== undefined) return refused;
    const wake = this.#startWake(req, shaped.dag.tasks.map((t) => t.wake));
    if (!wake.ok) return wake;
    if (req.dryRun === true) return { ok: true, dryRun: true, existing: false, instanceId: null, board: on.board, tasks: shaped.dag.tasks };
    return this.#write(shaped, {
      ...(wake.wake === undefined ? {} : { wake: wake.wake }),
      ...(wake.wakeNote === undefined ? {} : { wakeNote: wake.wakeNote }),
      name: shaped.dag.workflow,
      source: 'apply',
      board: on.board,
      key: key.key,
      createdBy: req.createdBy,
      createdVia: req.createdVia,
      ...(req.follow === undefined ? {} : { follow: req.follow }),
    });
  }

  /** A key's instance, read-only (workflows spec §6 step 0): the repeat's answer, or why the key is another's; undefined for a key not used. */
  #repeat(key: string, want: Parameters<typeof board.keyRefused>[1], fileOf?: string): Result<WorkflowMade> | undefined {
    const keyed = instanceByKey(this.#db, key);
    if (keyed === undefined) return undefined;
    let refused = board.keyRefused(keyed, want);
    // The instance on another board than the path's: a repeat when the file names that board, or cannot be
    // read, only the board's comparison waived; the source and the name still refuse (workflows spec §19.2).
    if (refused?.code === 'other_board' && fileOf !== undefined && keyed.instance.board !== want.board) {
      const read = this.workflowBoard(fileOf);
      if (read.file === 'unreadable' || read.board === keyed.instance.board) refused = board.keyRefused(keyed, { ...want, board: keyed.instance.board });
    }
    if (refused !== undefined) return refused;
    return { ok: true, instance: keyed.instance, tasks: membersWithTasks(this.#db, keyed.instance.instanceId), existing: true, ...this.#waitingOf(keyed.instance) };
  }

  /** An instance's steps still waiting, for one with a plan (workflow routing spec §12.3). */
  #waitingOf(instance: InstanceRow): { waiting?: string[] } {
    if (instance.plan === null) return {};
    const waiting = new Set(pendingOf(this.#db, instance.instanceId).filter((p) => p.state === 'waiting').map((p) => p.step));
    return { waiting: instance.plan.steps.filter((s) => waiting.has(s.step)).map((s) => s.step) };
  }

  /**
   * A start's or an apply's wake, checked (wake spec §3.1, §3.4): a wake for
   * every member is refused while wakes are off, and at the terminal with no
   * chat to follow them; a start whose steps ask for one while wakes are off,
   * or at the terminal with no chat (§19.16), still starts, those members
   * notice-only, with the note. A run's members
   * inherit its task's in the writer, so nothing is asked for them. `asks` is
   * every member's ask, a routed start's steps made later included.
   */
  #startWake(req: StartRequest | ApplyRequest, asks: ReadonlyArray<true | { role: string } | undefined>): Result<{ wake?: StartWakeOf; wakeNote?: string }> {
    const w = req.wake;
    if (w === undefined || req.createdVia?.kind === 'run') return { ok: true };
    const shape = wakeShapeRefused({ by: w.by, depth: w.depth });
    if (shape !== undefined) return shape;
    // A woken shell's members that ask for none keep its depth alone (§9.1); a null setter with asking steps is an owner not yet seen.
    const asked = w.all || asks.some((a) => a !== undefined);
    if (!asked) return { ok: true, wake: { by: null, depth: w.depth, all: false } };
    if (!this.#wake.enabled) {
      if (w.all) return board.refuse('wake_off', WAKES_OFF);
      return { ok: true, wake: { by: null, depth: w.depth, all: false }, wakeNote: STEPS_NOTICE_ONLY };
    }
    // No chat follows the members (§19.16): a role's wake needs none, the chat session's is notice-only, with a note.
    const chatless = req.createdVia?.kind === 'operator' && req.follow === undefined;
    if (chatless && w.all && w.role === undefined) return board.refuse('invalid', 'a wake needs a chat that follows the task: add --chat');
    // An owner the terminal could not name: the members that ask are notice-only, with one note (§19.16), which wins over the no-chat note.
    if (w.by === null) return { ok: true, wake: { by: null, depth: w.depth, all: false }, wakeNote: w.note ?? OWNER_UNSEEN_NOTICE_ONLY };
    const sessionSteps = chatless && !w.all && asks.some((a) => a === true);
    const chatlessOf = chatless ? { rolesOnly: true } : {};
    const noChatNote = sessionSteps ? { wakeNote: NO_CHAT_NOTICE_ONLY } : {};
    const role = this.#wakeRole(w.role);
    if (!role.ok) return role;
    // A step's own role is checked as the start's is, when its member will wake (wake spec §19.1).
    if (w.role === undefined) {
      for (const a of asks) {
        if (typeof a !== 'object') continue;
        const own = this.#wakeRole(a.role);
        if (!own.ok) return own;
      }
    }
    return {
      ok: true,
      wake: { by: w.by, depth: w.depth, all: w.all, ...(w.depth >= this.#wake.maxDepth ? { tooDeep: true } : {}), ...role.role, ...chatlessOf },
      ...noChatNote,
    };
  }

  /** The one transaction (workflows spec §6 step 3). */
  #write(
    shaped: ShapedDag,
    i: {
      name: string | null;
      source: 'start' | 'apply';
      board: string;
      key: string | null;
      createdBy: string;
      createdVia: CreatedVia;
      follow?: Follow;
      wake?: StartWakeOf;
      wakeNote?: string;
      plan?: Plan | null;
    },
  ): Result<WorkflowMade> {
    const r = board.applyDag(
      this.#db,
      {
        name: i.name,
        dag: shaped.dag,
        sha256: shaped.sha256,
        source: i.source,
        board: i.board,
        createdBy: i.createdBy,
        createdVia: i.createdVia,
        idempotencyKey: i.key,
        ...(i.follow === undefined ? {} : { follow: i.follow }),
        ...(i.plan === undefined || i.plan === null ? {} : { plan: i.plan }),
      },
      this.#members(shaped.dag, i.wake),
      this.#clock.now(),
    );
    if (!r.ok) return r;
    return {
      ok: true,
      instance: r.instance,
      tasks: r.members,
      existing: r.existing,
      ...(i.wakeNote === undefined ? {} : { wakeNote: i.wakeNote }),
      ...this.#waitingOf(r.instance),
    };
  }

  /** A workflow file's board alone, by the light read (workflows spec §19.3); unreadable with no directory. */
  workflowBoard(name: string): WorkflowBoardRead {
    return this.#workflowsDir === undefined ? { file: 'unreadable' } : workflowBoard(this.#workflowsDir, name);
  }

  /** The workflow files as the directory holds them now (workflows spec §10): `list`'s. */
  workflows(): WorkflowList {
    if (this.#workflowsDir === undefined) return { usable: [], broken: [], ignored: [] };
    // Judged against the boards, as the startup judges them (workflows spec §19.4).
    const boards = new Map(boardsOf(this.#db, { archived: true }).map((b) => [b.name, b.archivedAt !== null]));
    return withBoards(listWorkflows(this.#workflowsDir, this.#workflowFacts()), boards);
  }

  /** A board by its name, archived or not, or undefined (workflows spec §19.5): chat's `task list board:`. */
  boardNamed(name: string): BoardRow | undefined {
    return getBoard(this.#db, name);
  }

  /**
   * A board's instances, newest first (workflows spec §10): of its 200 most recent, the
   * running and blocked ones, or with `all` every one, each with its status; and
   * how many the board has in all.
   */
  instances(onBoard: string, all = false): { instances: InstanceSummary[]; total: number; read: number } {
    if (!isText(onBoard)) return { instances: [], total: 0, read: 0 };
    const { instances, total } = instancesOn(this.#db, onBoard, INSTANCES_READ);
    // Every status from one aggregate query of the members' phases, not a read of each member.
    const phases = memberPhases(this.#db, onBoard, INSTANCES_READ);
    // And one over the pending rows, for a routed instance's steps not made (workflow routing spec §12.4).
    const unmade = unmadeSteps(this.#db, onBoard, INSTANCES_READ);
    const summaries = instances.map((instance) => ({
      instance,
      ...instanceStatus(
        (phases.get(instance.instanceId) ?? []).flatMap(({ phase, n }) => Array<Phase>(n).fill(phase)),
        unmade.get(instance.instanceId),
      ),
    }));
    return {
      instances: all ? summaries : summaries.filter((s) => s.status === 'running' || s.status === 'blocked'),
      total,
      read: instances.length,
    };
  }

  /**
   * One instance in detail, on any board, by id (workflows spec §10): its members, in
   * position order, with their display status; its description, while its file
   * is still there; and its related tasks, apart, a member of another instance
   * among them shown as that instance.
   */
  instance(instanceId: string): Result<{ view: InstanceView }> {
    if (!isText(instanceId)) return board.refuse('invalid', 'an instance id is text');
    const instance = getInstance(this.#db, instanceId);
    if (instance === undefined) return board.refuse('not_found', `no workflow instance ${visible(instanceId)}`);
    const members = membersWithTasks(this.#db, instanceId).map((m) => ({ ...m, status: statusOf(this.#db, m.task) }));
    const related: InstanceView['related'] = [];
    const others = new Map<string, { instanceId: string; name: string | null; tasks: number }>();
    for (const task of relatedTasks(this.#db, instanceId)) {
      const member = memberOf(this.#db, task.taskId);
      if (member === undefined) {
        related.push({ task, status: statusOf(this.#db, task) });
        continue;
      }
      const seen = others.get(member.instanceId) ?? { instanceId: member.instanceId, name: member.name, tasks: 0 };
      seen.tasks += 1;
      others.set(member.instanceId, seen);
    }
    const file = instance.name === null || this.#workflowsDir === undefined ? undefined : readWorkflow(this.#workflowsDir, instance.name, this.#workflowFacts());
    const steps = instance.plan === null ? undefined : this.#stepLines(instance.instanceId, instance.plan, members);
    const failed = instance.routingFailedAt === null ? undefined : { at: instance.routingFailedAt, error: routeFailureOf(this.#db, instanceId) ?? '' };
    return {
      ok: true,
      view: {
        instance,
        description: file?.ok === true ? file.workflow.description : undefined,
        members,
        related,
        relatedInstances: [...others.values()],
        ...(steps === undefined ? {} : { steps }),
        ...(failed === undefined ? {} : { routingFailed: failed }),
        ...instanceStatus(
          members.map((m) => m.task.phase),
          unmadeOf(pendingOf(this.#db, instanceId), settledOf(this.#db, instanceId)),
        ),
      },
    };
  }

  /** A routed instance's step lines (workflow routing spec §12.1): from its pending, settled and route rows, and its settled steps' results. */
  #stepLines(instanceId: string, plan: Plan, members: ReadonlyArray<MemberRow & { task: TaskRow }>): StepLine[] {
    const settled = settledOf(this.#db, instanceId);
    const step = new Map(members.map((m) => [m.taskId, m.step]));
    const routes: RouteView[] = routesOf(this.#db, instanceId).map((r) => {
      const t = triggersOf(this.#db, r.fromTask).find((x) => x.eventId === r.eventId);
      const throttles = Number(/throttled (\d+) times/.exec(t?.reason ?? '')?.[1] ?? 0);
      return {
        handler: r.handler,
        fromTask: r.fromTask,
        fromStep: step.get(r.fromTask) ?? '',
        outcome: r.outcome,
        taskId: r.taskId,
        words: t === undefined ? 'blocked' : triggerWords(t, throttles),
      };
    });
    const results = new Map<string, Readonly<Record<string, unknown>> | null>();
    for (const s of settled) {
      if (s.ref !== s.step || s.taskId === null || Object.keys(plan.steps.find((p) => p.step === s.step)?.outputs ?? {}).length === 0) continue;
      const metadata = latestCompletion(this.#db, s.taskId)?.metadata;
      results.set(s.step, isRecord(metadata) ? metadata : null);
    }
    return stepLines(
      plan,
      members.map((m) => ({ step: m.step, ref: m.ref, taskId: m.taskId, phase: m.task.phase })),
      pendingOf(this.#db, instanceId),
      settled,
      routes,
      results,
    );
  }

  /**
   * Archive every member of an instance not already archived, in one transaction
   * (workflows spec §10): an undecided run superseded, whose turn the caller cancels; a
   * done task keeps the time it was done; related tasks are left alone. Who may
   * is the caller's: an operator, as for archiving a task.
   */
  archiveWorkflow(instanceId: string, by: string): Result<{ instance: InstanceRow; archived: TaskRow[]; runs: RunRow[] }> {
    if (!isText(instanceId)) return board.refuse('invalid', 'an instance id is text');
    if (!isText(by) || by.trim() === '') return board.refuse('invalid', 'who archives is text, not blank');
    return board.archiveWorkflow(this.#db, instanceId, by, this.#clock.now());
  }

  /**
   * Reconcile an instance (workflow routing spec §11): what is due decided and
   * made, in a transaction of its own, against the team as it is now.
   */
  reconcileWorkflow(instanceId: string): Result<board.Reconciled> {
    if (!isText(instanceId)) return board.refuse('invalid', 'an instance id is text');
    try {
      return this.#cancelled(board.reconcileWorkflow(this.#db, instanceId, this.#clock.now(), this.#facts()));
    } catch (err) {
      // A database busy past txImmediate's retries is no fault (§9.4): nothing is marked, and the caller may try again.
      if (isBusy(err)) throw err;
      // Its transaction rolled back: the fault is marked and said in one of its own, then thrown to the caller.
      try {
        board.reconcileFailed(this.#db, instanceId, err, this.#clock.now());
      } catch {
        // The database refused that too: the caller's error is the reconciliation's.
      }
      throw err;
    }
  }

  /**
   * The startup's reconciliation (workflow routing spec §11): every instance with a
   * plan that may have something due, a waiting step, a skipped step not yet
   * settled, a blocked member, or a fault not reconciled, reconciled once; a
   * handler never makes an instance due. Answers how many instances had a
   * decision, and how many decisions; one that faults keeps its mark.
   */
  reconcileAll(note?: (line: string) => void): { instances: number; steps: number } {
    let instances = 0;
    let steps = 0;
    // An instance whose plan cannot be read stops no start: it is said, and nothing is reconciled.
    let due: string[];
    try {
      due = routingDue(this.#db);
    } catch (err) {
      note?.(`workflows: reading the instances to reconcile failed: ${redactKnownSecrets(err instanceof Error ? err.message : String(err))}`);
      return { instances, steps };
    }
    for (const id of due) {
      try {
        const r = this.reconcileWorkflow(id);
        if (r.ok && r.decisions.length > 0) {
          instances += 1;
          steps += r.decisions.length;
        }
      } catch {
        // Marked by reconcileWorkflow, if it was not: the dispatcher's pass retries it.
      }
    }
    return { instances, steps };
  }

  /**
   * The dispatcher's hook (workflow routing spec §9.4): every instance whose routing
   * faulted reconciled, each at most once a minute; a reconciliation that faults
   * again leaves its mark for the next, its first such failure said by `note`.
   * Answers how many were reconciled. The time each was last tried is this
   * process's, kept only while it is faulted: after a restart, the startup's
   * reconciliation tries every one.
   */
  retryRouting(note?: (line: string) => void): number {
    const now = this.#clock.now();
    let reconciled = 0;
    const faulted = routingFaulted(this.#db);
    // An instance no longer faulted, cleared by a reconciliation of anyone's, is forgotten.
    const still = new Set(faulted);
    for (const id of [...this.#retried.keys()]) if (!still.has(id)) this.#retried.delete(id);
    for (const id of [...this.#retryFailed]) if (!still.has(id)) this.#retryFailed.delete(id);
    for (const id of faulted) {
      const last = this.#retried.get(id);
      if (last !== undefined && now - last < RETRY_ROUTING_MS) continue;
      this.#retried.set(id, now);
      try {
        if (this.reconcileWorkflow(id).ok) {
          reconciled += 1;
          this.#retried.delete(id);
          this.#retryFailed.delete(id);
        }
      } catch (err) {
        // Still faulted: its mark stays, and the next pass after a minute tries again; said once, not every minute.
        if (!this.#retryFailed.has(id)) {
          this.#retryFailed.add(id);
          note?.(`kanban: the routing of ${id} failed again: ${redactKnownSecrets(err instanceof Error ? err.message : String(err))}; it is tried each minute`);
        }
      }
    }
    return reconciled;
  }

  /** Who the next claim is for, resolved against the team as it is now. */
  #claimant(
    task: TaskRow,
  ): Result<{ claimant: board.Claimant; roleMd: string | undefined; roleMdBytes?: Buffer; role: Role | undefined }> {
    const who = task.phase === 'review' ? task.reviewer : task.assignee;
    if (who === null) {
      return board.refuse(
        'unassignable',
        `task ${task.taskId} has no ${task.phase === 'review' ? 'reviewer' : 'assignee'}`,
      );
    }
    if (who.kind === 'human') {
      if (this.#people === undefined) {
        return board.refuse(
          'unassignable',
          `task ${task.taskId} is for ${JSON.stringify(who.name)}, and people cannot take work yet`,
        );
      }
      return {
        ok: true,
        claimant: { assignee: who, agentConfig: null, roleWorkspace: undefined, roleMdHash: null },
        roleMd: undefined,
        role: undefined,
      };
    }
    const name = JSON.stringify(who.name);
    const role = this.#roles.get(who.name);
    if (role === undefined) return board.refuse('unassignable', `role ${name} is not configured`);
    if (!role.agent.unsupervised && !this.#supervisedRoles) {
      return board.refuse('unassignable', `role ${name} has a supervised agent, whose approvals could reach nobody`);
    }
    let bytes: Buffer | undefined;
    try {
      if (role.roleMdPath !== undefined) {
        regularFile(role.roleMdPath);
        bytes = readFileSync(role.roleMdPath);
      }
      for (const skill of role.skills) {
        regularFile(skill.path);
        accessSync(skill.path, constants.R_OK);
      }
    } catch (err) {
      // A file that existed at startup and is gone now: not a run without its instructions.
      return board.refuse('unassignable', `the files of role ${name} cannot be read: ${(err as Error).message}`);
    }
    return {
      ok: true,
      claimant: {
        assignee: who,
        agentConfig: agentSnapshot(role),
        roleWorkspace: role.workspace,
        // The bytes the agent is given, not a decoding of them.
        roleMdHash: bytes === undefined ? null : createHash('sha256').update(bytes).digest('hex'),
      },
      roleMd: bytes?.toString('utf8'),
      ...(bytes === undefined ? {} : { roleMdBytes: bytes }),
      role,
    };
  }

  /**
   * What a task is checked against (workflows spec §15): the team as this process holds
   * it, and the people, who need talk tier, once people can be reached.
   */
  #facts(): TaskFacts {
    const people = this.#people;
    return {
      roles: this.#roles,
      workspaces: this.#workspaces,
      supervisedRoles: this.#supervisedRoles,
      ...(people === undefined ? {} : { canTalk: (principal: string) => people.canTalk(principal) }),
    };
  }

  /**
   * The key the task is stored under (spec §3.1). A chat's key is the message's,
   * and only chat may use one; a run's is namespaced by the run's task, so a
   * worker repeating a command gets its own task back and nobody else's; the
   * operator's is namespaced as `operator:<key>`, so a script run again at a
   * terminal gets its own tasks back, never a chat's or a run's. A workflow's
   * instance is keyed the same way (workflows spec §6).
   */
  #idempotencyKey(key: unknown, via: CreatedVia): Result<{ key: string | null }> {
    if (key === undefined) return { ok: true, key: null };
    if (!isText(key) || key === '') return board.refuse('invalid', 'an idempotency key is non-empty text');
    // Stored, and not masked: it identifies. So it may not carry a secret.
    if (redactKnownSecrets(key) !== key) return board.refuse('invalid', 'an idempotency key holds a known secret');
    if (key.startsWith(RUN_KEY)) {
      return board.refuse('invalid', `an idempotency key starting ${RUN_KEY} is the board's own`);
    }
    if (key.startsWith(WAKE_KEY)) {
      return board.refuse('invalid', `an idempotency key starting ${WAKE_KEY} is the waker's own`);
    }
    if (via.kind !== 'chat' && key.startsWith(CHAT_KEY)) {
      return board.refuse('invalid', `an idempotency key starting ${CHAT_KEY} is for chat`);
    }
    if (via.kind !== 'operator' && key.startsWith(OPERATOR_KEY)) {
      return board.refuse('invalid', `an idempotency key starting ${OPERATOR_KEY} is for the terminal`);
    }
    if (via.kind === 'operator') return { ok: true, key: `${OPERATOR_KEY}${key}` };
    if (via.kind !== 'run') return { ok: true, key };
    const run = getRun(this.#db, via.runId);
    if (run === undefined) return board.refuse('not_found', `no run ${via.runId}`);
    return { ok: true, key: `${RUN_KEY}${run.taskId}:${key}` };
  }
}

/**
 * Whether a task still wakes as the wake that woke a turn did (wake spec §9.2):
 * the same setter and the same target. A wake turned off, or taken over by
 * another setter, since the turn was woken leaves the task outside that wake.
 */
function stillWakes(task: TaskRow | undefined, wake: WakeRow): boolean {
  return task !== undefined && task.wakeBy === wake.principal && (task.wakeRole ?? null) === (wake.targetRole ?? null);
}

/** The setter of a wake, as the thread names them, else by principal. */
function setterName(wake: WakeRow, judge: WakeJudge): string {
  return judge.nameOf(wake.principal) ?? wake.principal;
}
