import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import type { Db } from '../db/open.js';
import * as board from '../db/kanban.js';
import { getTask, taskView, type TaskView } from '../db/kanban-read.js';
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

function isWhole(n: number | undefined, min: number): boolean {
  return n === undefined || (Number.isInteger(n) && n >= min);
}

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
    if (req.title.trim() === '') return board.refuse('invalid', 'a task needs a title');
    const contract = this.#contract(req.contract);
    if (!contract.ok) return contract;
    if (req.workspace !== undefined && !this.#workspaces.has(req.workspace)) {
      return board.refuse('unknown_workspace', `workspace ${req.workspace} is not configured`);
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
        idempotencyKey: req.idempotencyKey ?? null,
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
    const who = this.#assignable(assignee);
    if (!who.ok) return who;
    return board.assign(this.#db, taskId, who.assignee, by, this.#clock.now());
  }

  assignReviewer(taskId: string, reviewer: string, by: string): Result<{ task: TaskRow; run: RunRow | undefined }> {
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
    return { ok: true, run: r.run, task: r.task, roleMd: resolved.ok ? resolved.roleMd : undefined };
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
    const done = getTask(this.#db, taskId);
    if (done === undefined) return board.refuse('not_found', `no task ${taskId}`);
    if (done.phase !== 'done') {
      return board.refuse('illegal_transition', `task ${taskId} is ${done.phase}; only a done task gets follow-ups`);
    }
    return this.create({ ...req, parents: [taskId, ...(req.parents ?? [])] });
  }

  link(parentId: string, childId: string, by: string): Result<{ added: boolean }> {
    return board.link(this.#db, parentId, childId, by, this.#clock.now());
  }

  /** Workspaces are named, never paths, and only configured ones (spec §2.3). */
  setWorkspace(taskId: string, workspace: string, by: string): Result<{ task: TaskRow }> {
    if (!this.#workspaces.has(workspace)) {
      return board.refuse('unknown_workspace', `workspace ${workspace} is not configured`);
    }
    return board.setWorkspace(this.#db, taskId, workspace, by, this.#clock.now());
  }

  comment(taskId: string, body: string, by: string): Result<{ comment: CommentRow }> {
    if (body.trim() === '') return board.refuse('invalid', 'a comment needs text');
    return board.addComment(this.#db, taskId, by, body, this.#clock.now());
  }

  /** Every path to done (spec §5.1). Gates run here first, from plan C4. */
  complete(taskId: string, by: Reporter, handoff: board.Handoff): Result<{ task: TaskRow; run: RunRow | undefined }> {
    return board.complete(this.#db, taskId, by, handoff, this.#clock.now());
  }

  /** A reviewer the report names is checked like any assignee (spec §5.3, §12). */
  requestReview(
    taskId: string,
    by: Reporter,
    handoff: board.Handoff & { reviewer?: string },
  ): Result<{ task: TaskRow; run: RunRow | undefined }> {
    const { reviewer, ...rest } = handoff;
    if (reviewer === undefined) return board.requestReview(this.#db, taskId, by, rest, this.#clock.now());
    const who = this.#assignable(reviewer);
    if (!who.ok) return who;
    return board.requestReview(this.#db, taskId, by, { ...rest, reviewer: who.assignee }, this.#clock.now());
  }

  requestChanges(taskId: string, by: Reporter, reason: string): Result<{ task: TaskRow; run: RunRow | undefined }> {
    if (reason.trim() === '') return board.refuse('invalid', 'changes need a reason the implementer can act on');
    return board.requestChanges(this.#db, taskId, by, reason, this.#clock.now());
  }

  /** `kind` arrives as text from an agent's JSON or from chat, so it is checked here. */
  block(
    taskId: string,
    by: Reporter,
    report: { kind: string; reason: string; parents?: readonly string[] },
  ): Result<{ task: TaskRow; run: RunRow | undefined }> {
    const kind = REPORTABLE.find((k) => k === report.kind);
    if (kind === undefined) {
      return board.refuse(
        'invalid',
        report.kind === 'gave_up'
          ? "gave_up is set by the board's breaker, never reported"
          : `unknown block kind ${report.kind} (one of ${REPORTABLE.join(', ')})`,
      );
    }
    if (report.reason.trim() === '') return board.refuse('invalid', 'a block needs a reason');
    return board.block(
      this.#db,
      taskId,
      by,
      { kind, reason: report.reason, ...(report.parents === undefined ? {} : { parents: report.parents }) },
      this.#clock.now(),
    );
  }

  unblock(taskId: string, by: string, comment?: string): Result<{ task: TaskRow }> {
    return board.unblock(this.#db, taskId, by, comment, this.#clock.now());
  }

  stop(taskId: string, by: string): Result<{ task: TaskRow; run: RunRow }> {
    return board.stop(this.#db, taskId, by, this.#clock.now());
  }

  archive(taskId: string, by: string): Result<{ task: TaskRow; run: RunRow | undefined }> {
    return board.archive(this.#db, taskId, by, this.#clock.now());
  }

  show(taskId: string): Result<{ view: TaskView }> {
    const view = taskView(this.#db, taskId);
    return view === undefined ? board.refuse('not_found', `no task ${taskId}`) : { ok: true, view };
  }

  /** Who the next claim is for, resolved against the team as it is now. */
  #claimant(task: TaskRow): Result<{ claimant: board.Claimant; roleMd: string | undefined }> {
    const who = task.phase === 'review' ? task.reviewer : task.assignee;
    if (who === null) {
      return board.refuse(
        'unassignable',
        `task ${task.taskId} has no ${task.phase === 'review' ? 'reviewer' : 'assignee'}`,
      );
    }
    if (who.kind === 'human') {
      if (this.#people === undefined) {
        return board.refuse('unassignable', `task ${task.taskId} is for ${who.name}, and people cannot take work yet`);
      }
      return {
        ok: true,
        claimant: { assignee: who, agentConfig: null, roleWorkspace: undefined, roleMdHash: null },
        roleMd: undefined,
      };
    }
    const role = this.#roles.get(who.name);
    if (role === undefined) return board.refuse('unassignable', `role ${who.name} is not configured`);
    if (!role.agent.unsupervised && !this.#supervisedRoles) {
      return board.refuse(
        'unassignable',
        `role ${who.name}'s agent is supervised, and its approvals could reach nobody`,
      );
    }
    let roleMd: string | undefined;
    try {
      roleMd = role.roleMdPath === undefined ? undefined : readFileSync(role.roleMdPath, 'utf8');
      for (const skill of role.skills) accessSync(skill.path, constants.R_OK);
    } catch (err) {
      // A file that existed at startup and is gone now: not a run without its instructions.
      return board.refuse('unassignable', `role ${who.name}'s files cannot be read: ${(err as Error).message}`);
    }
    return {
      ok: true,
      claimant: {
        assignee: who,
        agentConfig: agentSnapshot(role),
        roleWorkspace: role.workspace,
        roleMdHash: roleMd === undefined ? null : createHash('sha256').update(roleMd, 'utf8').digest('hex'),
      },
      roleMd,
    };
  }

  /**
   * A name the board may hand work to: a configured role whose agent runs
   * unsupervised, or a person with talk tier once people can be reached.
   */
  #assignable(name: string): Result<{ assignee: Assignee }> {
    if (name.includes(':')) {
      if (!PERSON.test(name)) {
        return board.refuse('invalid', `${JSON.stringify(name)} is neither a role name nor a person (lark:<union_id>)`);
      }
      if (this.#people === undefined) {
        return board.refuse(
          'person_not_assignable',
          `${name} cannot be given work yet: nothing can deliver a task card to a person until the board is in Lark`,
        );
      }
      if (!this.#people.canTalk(name)) {
        // Being assigned is permission to report on the task.
        return board.refuse('person_not_assignable', `${name} does not have talk tier, so cannot be given work`);
      }
      return { ok: true, assignee: { kind: 'human', name } };
    }
    const role = this.#roles.get(name);
    if (role === undefined) return board.refuse('unknown_role', `role ${name} is not configured`);
    if (!role.agent.unsupervised && !this.#supervisedRoles) {
      return board.refuse(
        'supervised_role',
        `role ${name}'s agent is supervised; its approval requests would reach nobody until the board is in Lark`,
      );
    }
    return { ok: true, assignee: { kind: 'role', name } };
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
      if (field === undefined) return board.refuse('invalid', `unknown contract field ${key}`);
      if (typeof value !== 'string') return board.refuse('invalid', `contract field ${key} must be text`);
      contract[field] = value;
    }
    return { ok: true, contract };
  }
}
