import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import type { Db } from '../db/open.js';
import * as board from '../db/kanban.js';
import { getRun, getTask, taskView, type TaskView } from '../db/kanban-read.js';
import { redactKnownSecrets } from '../secrets.js';
import type { Role } from '../roles.js';
import { systemClock, type Clock } from '../time.js';
import {
  BLOCK_KINDS,
  CONTRACT_FIELDS,
  type AgentSnapshot,
  type Assignee,
  type CommentRow,
  type Contract,
  type CreatedVia,
  type Refusal,
  type ReportedBlockKind,
  type Reporter,
  type Result,
  type RetryOnCrash,
  type RunRow,
  type TaskRow,
} from './types.js';

/**
 * The board's service API (spec §4–§5): what plans C2, C3 and D call.
 *
 * It checks what the rows cannot: that a named role or workspace is configured,
 * that the board may hand work to it, and that input -- from chat, or from an
 * agent's JSON -- has the right shape. db/kanban.ts checks the rest, and is the
 * only writer.
 *
 * Until plan D nothing can deliver a card to a person, so people cannot be
 * assigned or named as reviewers, and a role whose agent is supervised is
 * refused: its approval cards would have nowhere to go (spec §12). Plan D passes
 * `people` and `supervisedRoles` to turn them on. Who may act -- tiers, the
 * named assignee -- is the caller's: the worker CLI's token (plan C3), chat (D).
 */

/** How the board reaches people. Plan D's; absent, people cannot be given work. */
export interface People {
  /** Being assigned is permission to report, so it needs talk tier (spec §4.2). */
  canTalk(principal: string): boolean;
}

export interface KanbanServiceDeps {
  db: Db;
  roles: ReadonlyMap<string, Role>;
  /** The configured workspace names. */
  workspaces: ReadonlySet<string>;
  clock?: Clock;
  limits?: board.KanbanLimits;
  people?: People;
  /** Accept roles whose agent asks for approval. Plan D's, once approvals reach a subscriber. */
  supervisedRoles?: boolean;
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
}

/** A claim, with what was read for it. */
export interface Claimed {
  run: RunRow;
  task: TaskRow;
  /** The role.md whose hash the run records, for plan C2's prompt; undefined without one. */
  roleMd: string | undefined;
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

/** A refusal unless every id given is text. */
function idsRefused(...ids: unknown[]): Refusal | undefined {
  return ids.every(isText) ? undefined : board.refuse('invalid', 'task ids are text');
}

/** A commit id, abbreviated or whole, SHA-1 or SHA-256. */
const COMMIT = /^[0-9a-f]{7,64}$/;

/** A refusal unless createdVia is one of the two shapes, with text fields. */
function createdViaRefused(via: unknown): Refusal | undefined {
  const fine =
    isRecord(via) &&
    (via.kind === 'run'
      ? isText(via.runId)
      : via.kind === 'chat' &&
        isText(via.channel) &&
        isText(via.appId) &&
        isText(via.conversationId) &&
        isText(via.threadId));
  return fine ? undefined : board.refuse('invalid', 'created_via is a chat, with text fields, or a run id');
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

export class KanbanService {
  readonly #db: Db;
  readonly #roles: ReadonlyMap<string, Role>;
  readonly #workspaces: ReadonlySet<string>;
  readonly #clock: Clock;
  readonly #limits: board.KanbanLimits;
  readonly #people: People | undefined;
  readonly #supervisedRoles: boolean;

  constructor(deps: KanbanServiceDeps) {
    this.#db = deps.db;
    this.#roles = deps.roles;
    this.#workspaces = deps.workspaces;
    this.#clock = deps.clock ?? systemClock;
    this.#limits = deps.limits ?? board.DEFAULT_LIMITS;
    this.#people = deps.people;
    this.#supervisedRoles = deps.supervisedRoles ?? false;
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
    if (req.parents !== undefined && !isTextList(req.parents)) {
      return board.refuse('invalid', 'parents are a list of task ids');
    }
    const contract = this.#contract(req.contract);
    if (!contract.ok) return contract;
    if (req.workspace !== undefined && !this.#workspaces.has(req.workspace)) {
      return board.refuse('unknown_workspace', `workspace ${JSON.stringify(req.workspace)} is not configured`);
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
    const resolved = this.#claimant(task);
    const r = resolved.ok
      ? board.claim(
          this.#db,
          { taskId, claimant: resolved.claimant, tokenHash: opts.tokenHash ?? null, workspaces: this.#workspaces },
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
      role: resolved.ok ? resolved.role : undefined,
    };
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

  /**
   * New work on a done task is a new task with it as a parent, never a reopening
   * (spec §4.4): the done task's summary is what its children were given as their
   * handoff, and reopening it would rewrite the input to work that already ran.
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
    return this.create({ ...req, parents: [taskId, ...(req.parents ?? [])] });
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
      return board.refuse('unknown_workspace', `workspace ${JSON.stringify(workspace)} is not configured`);
    }
    return board.setWorkspace(this.#db, taskId, workspace, by, this.#clock.now());
  }

  comment(taskId: string, body: string, by: string): Result<{ comment: CommentRow }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (!isText(body) || body.trim() === '') return board.refuse('invalid', 'a comment needs text');
    return board.addComment(this.#db, taskId, by, body, this.#clock.now());
  }

  /** Every path to done (spec §5.1). Gates run here first, from plan C4. */
  complete(taskId: string, by: Reporter, handoff: board.Handoff): Result<{ task: TaskRow; run: RunRow | undefined }> {
    const refused = idsRefused(taskId) ?? handoffRefused(by, handoff);
    if (refused !== undefined) return refused;
    return board.complete(this.#db, taskId, by, handoff, this.#clock.now());
  }

  /** A reviewer the report names is checked like any assignee (spec §5.3, §12). */
  requestReview(
    taskId: string,
    by: Reporter,
    handoff: board.Handoff & { reviewer?: string },
  ): Result<{ task: TaskRow; run: RunRow | undefined }> {
    const refused = idsRefused(taskId) ?? handoffRefused(by, handoff);
    if (refused !== undefined) return refused;
    const { reviewer, ...rest } = handoff;
    if (reviewer === undefined) return board.requestReview(this.#db, taskId, by, rest, this.#clock.now());
    const who = this.#assignable(reviewer);
    if (!who.ok) return who;
    return board.requestReview(this.#db, taskId, by, { ...rest, reviewer: who.assignee }, this.#clock.now());
  }

  requestChanges(taskId: string, by: Reporter, reason: string): Result<{ task: TaskRow; run: RunRow | undefined }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (!isText(reason) || reason.trim() === '') {
      return board.refuse('invalid', 'changes need a reason the implementer can act on');
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

  unblock(taskId: string, by: string, comment?: string): Result<{ task: TaskRow }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (comment !== undefined && !isText(comment)) return board.refuse('invalid', 'a comment is text');
    return board.unblock(this.#db, taskId, by, comment, this.#clock.now());
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
    return view === undefined ? board.refuse('not_found', `no task ${taskId}`) : { ok: true, view };
  }

  /** Who the next claim is for, resolved against the team as it is now. */
  #claimant(task: TaskRow): Result<{ claimant: board.Claimant; roleMd: string | undefined; role: Role | undefined }> {
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
        // Being assigned is permission to report on the task.
        return board.refuse('person_not_assignable', `${quoted} does not have talk tier, so cannot be given work`);
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
   * worker repeating a command gets its own task back and nobody else's.
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
