import { visible } from '../names.js';
import type { Role } from '../roles.js';
import { CONTRACT_FIELDS, type Assignee, type Contract, type CreateRequest, type Refusal, type Result } from './types.js';

/**
 * The checks a task gets before it is made (workflows spec §15): `KanbanService.create`'s,
 * moved out of the service with their messages unchanged, so that one function
 * judges a task however it is made -- by `create`, by a workflow's start or
 * apply, and by the terminal's preview, which opens no database. Pure: the team
 * and the people come as facts, and nothing here reads a database.
 */

/** What a task is checked against. No check reads the isolated workspaces, so they are not here. */
export interface TaskFacts {
  roles: ReadonlyMap<string, Role>;
  /** The configured workspace names. */
  workspaces: ReadonlySet<string>;
  /** Accept roles whose agent asks for approval. */
  supervisedRoles: boolean;
  /**
   * Whether a person has talk tier (spec §4.2). Absent, nothing can deliver a
   * card to a person, so no person can be given work.
   */
  canTalk?: (principal: string) => boolean;
}

/** A task to check: what `create` takes, but its key, which the service checks, as it reads the database. */
export type TaskRequest = Omit<CreateRequest, 'idempotencyKey'>;

/** A task's checked parts: its contract, and who it is for and reviewed by. */
export interface CheckedTask {
  contract: Contract;
  assignee: Assignee | undefined;
  reviewer: Assignee | undefined;
}

// Every check takes what an agent's JSON or chat sent, typed or not: a wrong
// type is refused as `invalid`, never thrown.

export function isText(v: unknown): v is string {
  return typeof v === 'string';
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isTextList(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every(isText);
}

/** Absent, or a whole number SQLite stores exactly, at least `min`. */
function isWhole(n: unknown, min: number): boolean {
  return n === undefined || (Number.isSafeInteger(n) && (n as number) >= min);
}

function refuse(code: Refusal['code'], message: string): Refusal {
  return { ok: false, code, message };
}

/** A person's principal, as channels identify them. */
const PERSON = /^lark:[A-Za-z0-9_-]+$/;

/**
 * What the terminal says of a name starting with `@` where a person may go
 * (kanban spec §22.2): a mention is resolved from the message Lark delivers,
 * which a terminal has not got.
 */
export const NO_MENTIONS = 'there are no @-mentions at the terminal: a person is lark:<union_id>, which mt kanban people lists';

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
          (via.rootId === undefined || isText(via.rootId)) &&
          (via.chatType === undefined || via.chatType === 'p2p' || via.chatType === 'group'));
  return fine ? undefined : refuse('invalid', 'created_via is a chat, with text fields, a run id, or the operator');
}

/** A contract has only the five fields, each text (spec §4.3). */
function contractOf(raw: unknown): Result<{ contract: Contract }> {
  if (raw === undefined) return { ok: true, contract: {} };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return refuse('invalid', 'a contract is an object of text fields');
  }
  const contract: Contract = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = CONTRACT_FIELDS.find((f) => f === key);
    if (field === undefined) return refuse('invalid', `unknown contract field ${JSON.stringify(key)}`);
    if (typeof value !== 'string') return refuse('invalid', `contract field ${field} must be text`);
    contract[field] = value;
  }
  return { ok: true, contract };
}

/**
 * A name the board may hand work to: a configured role whose agent runs
 * unsupervised, unless supervised roles are accepted, or a person with talk tier
 * once people can be reached. `assign`, `assignReviewer`, a named reviewer of
 * `requestReview`, and `create` all ask it.
 */
export function assignable(name: unknown, facts: TaskFacts): Result<{ assignee: Assignee }> {
  if (!isText(name)) return refuse('invalid', 'an assignee or reviewer is a role name or a person, as text');
  if (name.trim() === '') return refuse('invalid', 'an assignee or reviewer needs a name');
  // Echoed quoted: a name is the caller's text, and may hold anything.
  const quoted = JSON.stringify(name);
  if (name.includes(':')) {
    if (!PERSON.test(name)) {
      return refuse('invalid', `${quoted} is neither a role name nor a person (lark:<union_id>)`);
    }
    if (facts.canTalk === undefined) {
      return refuse(
        'person_not_assignable',
        `${quoted} cannot be given work yet: nothing can deliver a task card to a person until the board is in Lark`,
      );
    }
    if (!facts.canTalk(name)) {
      // Being assigned is permission to report on the task (spec §4.2). A person is
      // known by the open_id Lark last gave with their union_id, from chat.
      return refuse(
        'person_not_assignable',
        `${quoted} cannot be given work: being assigned lets a person report on the task, which needs talk tier, ` +
          'and this gateway does not know them to have it -- a person is known once they have used /kanban, or been @-mentioned in it',
      );
    }
    return { ok: true, assignee: { kind: 'human', name } };
  }
  const role = facts.roles.get(name);
  if (role === undefined) return refuse('unknown_role', `role ${quoted} is not configured`);
  if (!role.agent.unsupervised && !facts.supervisedRoles) {
    return refuse(
      'supervised_role',
      `role ${quoted} has a supervised agent; its approval requests would reach nobody until the board is in Lark`,
    );
  }
  return { ok: true, assignee: { kind: 'role', name } };
}

/**
 * A task's checks, in `create`'s order: the title, `createdBy`, `createdVia`, the
 * types of the body, workspace, board and parents, the contract, the workspace
 * being configured, the numbers, the crash rule, the assignee, the reviewer. The
 * first problem is the refusal; otherwise the checked contract and names.
 */
export function checkTask(req: TaskRequest, facts: TaskFacts): Result<CheckedTask> {
  if (!isRecord(req)) return refuse('invalid', 'a task to create is an object');
  if (!isText(req.title) || req.title.trim() === '') return refuse('invalid', 'a task needs a title');
  if (!isText(req.createdBy)) return refuse('invalid', 'created_by is text');
  const via = createdViaRefused(req.createdVia);
  if (via !== undefined) return via;
  if (req.body !== undefined && !isText(req.body)) return refuse('invalid', 'a body is text');
  if (req.workspace !== undefined && !isText(req.workspace)) return refuse('invalid', 'a workspace is a name');
  if (req.board !== undefined && !isText(req.board)) return refuse('invalid', 'a board is a name');
  if (req.parents !== undefined && !isTextList(req.parents)) {
    return refuse('invalid', 'parents are a list of task ids');
  }
  const contract = contractOf(req.contract);
  if (!contract.ok) return contract;
  if (req.workspace !== undefined && !facts.workspaces.has(req.workspace)) {
    return refuse('unknown_workspace', `workspace ${visible(JSON.stringify(req.workspace))} is not configured`);
  }
  if (!isWhole(req.priority, Number.MIN_SAFE_INTEGER) || !isWhole(req.failureLimit, 1) || !isWhole(req.maxRuntimeS, 1)) {
    return refuse('invalid', 'priority must be a whole number, and failure_limit and max_runtime_s at least 1');
  }
  if (req.retryOnCrash !== undefined && req.retryOnCrash !== 'always' && req.retryOnCrash !== 'if-no-side-effects') {
    return refuse('invalid', 'retry_on_crash must be always or if-no-side-effects');
  }
  const assignee = req.assignee === undefined ? undefined : assignable(req.assignee, facts);
  if (assignee !== undefined && !assignee.ok) return assignee;
  const reviewer = req.reviewer === undefined ? undefined : assignable(req.reviewer, facts);
  if (reviewer !== undefined && !reviewer.ok) return reviewer;
  return { ok: true, contract: contract.contract, assignee: assignee?.assignee, reviewer: reviewer?.assignee };
}

/** The first problem `checkTask` finds, or undefined for a task `create` would take, but for its key. */
export function taskProblems(req: TaskRequest, facts: TaskFacts): Refusal | undefined {
  const checked = checkTask(req, facts);
  return checked.ok ? undefined : checked;
}
