import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import type { Db } from '../db/open.js';
import * as board from '../db/kanban.js';
import {
  boardList,
  boardSummaries,
  cardReading,
  chatBoardOf,
  gatesOf,
  getBoard,
  getRun,
  getTask,
  runsOf,
  taskView,
  type BoardEntry,
  type BoardSummary,
  type CardReading,
  type TaskView,
} from '../db/kanban-read.js';
import { buildEnv } from '../driver/env.js';
import { nameProblem, visible } from '../names.js';
import { redactKnownSecrets } from '../secrets.js';
import { roleLimit, type Role } from '../roles.js';
import { stripControl } from '../text.js';
import { systemClock, type Clock } from '../time.js';
import { commitReader, type CommitReader } from './commit.js';
import { gateEnv, runGates, spawnGate, type GateResult, type GateRunner } from './gates.js';
import { limitsReached, workspaceBusy } from './waiting.js';
import { isWorktreeId, worktreeId, worktreeOf } from '../db/workspaces.js';
import { placeName, placeOf, resolveTaskWorkspace } from './workspace.js';
import {
  BLOCK_KINDS,
  CONTRACT_FIELDS,
  DEFAULT_BOARD,
  GATE_LIMITS,
  type AgentSnapshot,
  type Assignee,
  type BoardRow,
  type ChatAt,
  type CommentRow,
  type Contract,
  type CreatedVia,
  type GateRow,
  type Refusal,
  type Rendering,
  type ReportedBlockKind,
  type Reporter,
  type Result,
  type RetryOnCrash,
  type RunRow,
  type TaskRow,
  type Waiting,
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
}

/** A report's options: aborted when the gateway stops, which kills its gates and applies nothing. */
export interface ReportOptions {
  signal?: AbortSignal;
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
}

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

/** A person's principal, as channels identify them. */
const PERSON = /^lark:[A-Za-z0-9_-]+$/;

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

function isText(v: unknown): v is string {
  return typeof v === 'string';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isTextList(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every(isText);
}

/** Absent, or a whole number SQLite stores exactly, at least `min`. */
function isWhole(n: unknown, min: number): boolean {
  return n === undefined || (Number.isSafeInteger(n) && (n as number) >= min);
}

/** Throws unless the path is a regular file: a directory where role.md or a SKILL.md was is not one. */
function regularFile(path: string): void {
  if (!statSync(path).isFile()) throw new Error(`${path} is not a file`);
}

/**
 * Whether a gate command holds a known secret (spec §10.1): as written, with its
 * control characters stripped, as the escapers match it, and with the shell's
 * quotes and backslashes taken out, so `sk\$x` or `'sk''x'` -- which the shell
 * runs as the secret -- count as well. A backslash-newline, which the shell
 * removes, is taken out first, and that form is matched with its control
 * characters stripped too.
 */
function holdsSecret(command: string): boolean {
  // A backslash-newline is a continuation the shell removes, so it goes before the quotes do.
  const unquoted = command.replace(/\\\r?\n/g, '').replace(/['"\\]/g, '');
  const forms = [command, stripControl(command), unquoted, stripControl(unquoted)];
  return forms.some((form) => redactKnownSecrets(form) !== form);
}

/** A refusal unless every id given is text. */
function idsRefused(...ids: unknown[]): Refusal | undefined {
  return ids.every(isText) ? undefined : board.refuse('invalid', 'task ids are text');
}

/** A commit id, abbreviated or whole, SHA-1 or SHA-256. */
const COMMIT = /^[0-9a-f]{7,64}$/;

/** A refusal unless createdVia is one of the three shapes, with text fields. */
function createdViaRefused(via: unknown): Refusal | undefined {
  const fine =
    isRecord(via) &&
    (via.kind === 'run'
      ? isText(via.runId)
      : via.kind === 'operator'
        ? Object.keys(via).length === 1
        : via.kind === 'chat' &&
          isText(via.channel) &&
          isText(via.appId) &&
          isText(via.conversationId) &&
          isText(via.threadId) &&
          (via.rootId === undefined || isText(via.rootId)));
  return fine ? undefined : board.refuse('invalid', 'created_via is a chat, with text fields, a run id, or the operator');
}

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
  /**
   * Tasks a report is running its checks for, with where the gates run -- the
   * task's own directory, by its `wt:` id, or its workspace's shared one (spec
   * §18) -- and the report's end. One at a time per task: a second report would
   * run the same gates again, at once, in the same checkout. And no claim
   * meanwhile, of the task or of another working there, which would start an
   * agent in a checkout being tested.
   */
  readonly #reporting = new Map<string, { workspace: string | null; done: Promise<unknown> }>();

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
    if (!isRecord(req)) return board.refuse('invalid', 'a task to create is an object');
    if (!isText(req.title) || req.title.trim() === '') return board.refuse('invalid', 'a task needs a title');
    if (!isText(req.createdBy)) return board.refuse('invalid', 'created_by is text');
    const via = createdViaRefused(req.createdVia);
    if (via !== undefined) return via;
    if (req.body !== undefined && !isText(req.body)) return board.refuse('invalid', 'a body is text');
    if (req.workspace !== undefined && !isText(req.workspace)) return board.refuse('invalid', 'a workspace is a name');
    if (req.board !== undefined && !isText(req.board)) return board.refuse('invalid', 'a board is a name');
    if (req.parents !== undefined && !isTextList(req.parents)) {
      return board.refuse('invalid', 'parents are a list of task ids');
    }
    const contract = this.#contract(req.contract);
    if (!contract.ok) return contract;
    if (req.workspace !== undefined && !this.#workspaces.has(req.workspace)) {
      return board.refuse('unknown_workspace', `workspace ${visible(JSON.stringify(req.workspace))} is not configured`);
    }
    if (
      !isWhole(req.priority, Number.MIN_SAFE_INTEGER) ||
      !isWhole(req.failureLimit, 1) ||
      !isWhole(req.maxRuntimeS, 1)
    ) {
      return board.refuse('invalid', 'priority must be a whole number, and failure_limit and max_runtime_s at least 1');
    }
    if (req.retryOnCrash !== undefined && req.retryOnCrash !== 'always' && req.retryOnCrash !== 'if-no-side-effects') {
      return board.refuse('invalid', 'retry_on_crash must be always or if-no-side-effects');
    }
    const assignee = req.assignee === undefined ? undefined : this.#assignable(req.assignee);
    if (assignee !== undefined && !assignee.ok) return assignee;
    const reviewer = req.reviewer === undefined ? undefined : this.#assignable(req.reviewer);
    if (reviewer !== undefined && !reviewer.ok) return reviewer;
    const key = this.#idempotencyKey(req);
    if (!key.ok) return key;
    return board.createTask(
      this.#db,
      {
        title: req.title,
        ...(req.body === undefined ? {} : { body: req.body }),
        contract: contract.contract,
        assignee: assignee?.assignee ?? null,
        reviewer: reviewer?.assignee ?? null,
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
      },
      this.#clock.now(),
    );
  }

  assign(taskId: string, assignee: string, by: string): Result<{ task: TaskRow; run: RunRow | undefined }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    const who = this.#assignable(assignee);
    if (!who.ok) return who;
    return board.assign(this.#db, taskId, who.assignee, by, this.#clock.now());
  }

  assignReviewer(taskId: string, reviewer: string, by: string): Result<{ task: TaskRow; run: RunRow | undefined }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    const who = this.#assignable(reviewer);
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
    return board.endRun(this.#db, runId, ending, this.#limits, this.#clock.now());
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
    return this.#report(taskId, by, 'complete', undefined, opts, (seen) =>
      board.complete(this.#db, taskId, by, { ...handoff, ...seen }, this.#clock.now()),
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
      const who = this.#assignable(reviewer);
      if (!who.ok) return who;
      named = who.assignee;
    }
    return this.#report(taskId, by, 'review', named, opts, (seen) =>
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
    opts: ReportOptions,
    apply: (seen: { reportedCommit?: string | null; reportedDirty?: boolean | null }) => Result<T>,
  ): Promise<Result<T>> {
    if (this.#reporting.has(taskId)) {
      return board.refuse('report_in_progress', inProgress(taskId, by));
    }
    const now = board.reportCheck(this.#db, taskId, by, kind, reviewer);
    if (!now.ok) return now;
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
    return board.block(
      this.#db,
      taskId,
      by,
      { kind, reason: report.reason, ...(report.parents === undefined ? {} : { parents: report.parents }) },
      this.#clock.now(),
    );
  }

  /**
   * `blockedAt`: an Unblock button's, the event that blocked the task as its
   * notice told it (spec §9.2); refused once that block has been lifted.
   */
  unblock(taskId: string, by: string, comment?: string, opts: { blockedAt?: number } = {}): Result<{ task: TaskRow }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (comment !== undefined && !isText(comment)) return board.refuse('invalid', 'a comment is text');
    if (opts.blockedAt !== undefined && !Number.isSafeInteger(opts.blockedAt)) {
      return board.refuse('invalid', 'a block is an event id, a whole number');
    }
    return board.unblock(this.#db, taskId, by, comment, this.#clock.now(), opts);
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

  stop(taskId: string, by: string): Result<{ task: TaskRow; run: RunRow }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    return board.stop(this.#db, taskId, by, this.#clock.now());
  }

  archive(taskId: string, by: string): Result<{ task: TaskRow; run: RunRow | undefined }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    return board.archive(this.#db, taskId, by, this.#clock.now());
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
   * A task's subscription at this chat moved into the thread its "Created" reply
   * opened, with the command message as its root (spec §19.4): `KanbanChat`'s,
   * once Lark answered the reply with its thread.
   */
  threadSubscription(taskId: string, at: ChatAt, threadId: string, rootId: string): Result<{ moved: boolean }> {
    const ids = idsRefused(taskId, threadId, rootId);
    if (ids !== undefined) return ids;
    if (!isRecord(at) || !isText(at.channel) || !isText(at.appId) || !isText(at.conversationId)) {
      return board.refuse('invalid', 'a chat is its channel, bot and conversation, as text');
    }
    return board.threadSubscription(this.#db, taskId, at, threadId, rootId);
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
   * A name the board may hand work to: a configured role whose agent runs
   * unsupervised, or a person with talk tier once people can be reached.
   */
  #assignable(name: unknown): Result<{ assignee: Assignee }> {
    if (!isText(name)) return board.refuse('invalid', 'an assignee or reviewer is a role name or a person, as text');
    if (name.trim() === '') return board.refuse('invalid', 'an assignee or reviewer needs a name');
    // Echoed quoted: a name is the caller's text, and may hold anything.
    const quoted = JSON.stringify(name);
    if (name.includes(':')) {
      if (!PERSON.test(name)) {
        return board.refuse('invalid', `${quoted} is neither a role name nor a person (lark:<union_id>)`);
      }
      if (this.#people === undefined) {
        return board.refuse(
          'person_not_assignable',
          `${quoted} cannot be given work yet: nothing can deliver a task card to a person until the board is in Lark`,
        );
      }
      if (!this.#people.canTalk(name)) {
        // Being assigned is permission to report on the task (spec §4.2). A person is
        // known by the open_id Lark last gave with their union_id, from chat.
        return board.refuse(
          'person_not_assignable',
          `${quoted} cannot be given work: being assigned lets a person report on the task, which needs talk tier, ` +
            'and this gateway does not know them to have it -- a person is known once they have used /kanban, or been @-mentioned in it',
        );
      }
      return { ok: true, assignee: { kind: 'human', name } };
    }
    const role = this.#roles.get(name);
    if (role === undefined) return board.refuse('unknown_role', `role ${quoted} is not configured`);
    if (!role.agent.unsupervised && !this.#supervisedRoles) {
      return board.refuse(
        'supervised_role',
        `role ${quoted} has a supervised agent; its approval requests would reach nobody until the board is in Lark`,
      );
    }
    return { ok: true, assignee: { kind: 'role', name } };
  }

  /**
   * The key the task is stored under (spec §3.1). A chat's key is the message's,
   * and only chat may use one; a run's is namespaced by the run's task, so a
   * worker repeating a command gets its own task back and nobody else's; the
   * operator's is namespaced as `operator:<key>`, so a script run again at a
   * terminal gets its own tasks back, never a chat's or a run's.
   */
  #idempotencyKey(req: CreateRequest): Result<{ key: string | null }> {
    const key: unknown = req.idempotencyKey;
    if (key === undefined) return { ok: true, key: null };
    if (!isText(key) || key === '') return board.refuse('invalid', 'an idempotency key is non-empty text');
    // Stored, and not masked: it identifies. So it may not carry a secret.
    if (redactKnownSecrets(key) !== key) return board.refuse('invalid', 'an idempotency key holds a known secret');
    if (key.startsWith(RUN_KEY)) {
      return board.refuse('invalid', `an idempotency key starting ${RUN_KEY} is the board's own`);
    }
    if (req.createdVia.kind !== 'chat' && key.startsWith(CHAT_KEY)) {
      return board.refuse('invalid', `an idempotency key starting ${CHAT_KEY} is for chat`);
    }
    if (req.createdVia.kind !== 'operator' && key.startsWith(OPERATOR_KEY)) {
      return board.refuse('invalid', `an idempotency key starting ${OPERATOR_KEY} is for the terminal`);
    }
    if (req.createdVia.kind === 'operator') return { ok: true, key: `${OPERATOR_KEY}${key}` };
    if (req.createdVia.kind !== 'run') return { ok: true, key };
    const run = getRun(this.#db, req.createdVia.runId);
    if (run === undefined) return board.refuse('not_found', `no run ${req.createdVia.runId}`);
    return { ok: true, key: `${RUN_KEY}${run.taskId}:${key}` };
  }

  /** A contract has only the five fields, each text (spec §4.3). */
  #contract(raw: unknown): Result<{ contract: Contract }> {
    if (raw === undefined) return { ok: true, contract: {} };
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return board.refuse('invalid', 'a contract is an object of text fields');
    }
    const contract: Contract = {};
    for (const [key, value] of Object.entries(raw)) {
      const field = CONTRACT_FIELDS.find((f) => f === key);
      if (field === undefined) return board.refuse('invalid', `unknown contract field ${JSON.stringify(key)}`);
      if (typeof value !== 'string') return board.refuse('invalid', `contract field ${field} must be text`);
      contract[field] = value;
    }
    return { ok: true, contract };
  }
}
