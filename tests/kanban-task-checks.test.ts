import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KanbanService, type CreateRequest } from '../src/kanban/service.js';
import { assignable, taskProblems, type TaskFacts } from '../src/kanban/task-checks.js';
import type { Role } from '../src/roles.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * `create`'s per-task checks, moved into a pure `taskProblems` (workflows spec §15):
 * the same refusals, each in today's order, through `create` and through the
 * function; and the pure `assignable` that `assign`, `assignReviewer`, a named
 * reviewer and `create` share.
 */

const ROLES: ReadonlyMap<string, Role> = new Map([
  ['implementer', role('implementer')],
  ['watched', role('watched', { agent: { ...role('watched').agent, unsupervised: false } })],
]);

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

const service = (people?: (p: string) => boolean): KanbanService =>
  new KanbanService({
    db: h.db,
    roles: ROLES,
    workspaces: WORKSPACES,
    ...(people === undefined ? {} : { people: { canTalk: people } }),
  });
const facts = (canTalk?: (p: string) => boolean): TaskFacts => ({
  roles: ROLES,
  workspaces: WORKSPACES,
  supervisedRoles: false,
  ...(canTalk === undefined ? {} : { canTalk }),
});

/** Every field wrong at once: each fix in turn uncovers the next refusal, in create's order. */
const WRONG = {
  title: ' ',
  createdBy: 7,
  createdVia: { kind: 'nowhere' },
  body: 1,
  workspace: 2,
  board: 3,
  parents: 'k_1',
  contract: { colour: 'red' },
  priority: 1.5,
  retryOnCrash: 'never',
  assignee: 'ghost',
  reviewer: 'watched',
} as unknown as CreateRequest;

const STEPS: Array<[Record<string, unknown>, string, string]> = [
  [{}, 'invalid', 'a task needs a title'],
  [{ title: 'Write the notes' }, 'invalid', 'created_by is text'],
  [{ createdBy: ALICE }, 'invalid', 'created_via is a chat, with text fields, a run id, or the operator'],
  [{ createdVia: VIA }, 'invalid', 'a body is text'],
  [{ body: 'The body.' }, 'invalid', 'a workspace is a name'],
  [{ workspace: 'nowhere' }, 'invalid', 'a board is a name'],
  [{ board: 'default' }, 'invalid', 'parents are a list of task ids'],
  [{ parents: [] }, 'invalid', 'unknown contract field "colour"'],
  [{ contract: { outcome: 7 } }, 'invalid', 'contract field outcome must be text'],
  [{ contract: { outcome: 'notes' } }, 'unknown_workspace', 'workspace "nowhere" is not configured'],
  [{ workspace: 'docs' }, 'invalid', 'priority must be a whole number, and failure_limit and max_runtime_s at least 1'],
  [{ priority: 2, failureLimit: 0 }, 'invalid', 'priority must be a whole number, and failure_limit and max_runtime_s at least 1'],
  [{ failureLimit: 3 }, 'invalid', 'retry_on_crash must be always or if-no-side-effects'],
  [{ retryOnCrash: 'if-no-side-effects' }, 'unknown_role', 'role "ghost" is not configured'],
  [
    { assignee: 'implementer' },
    'supervised_role',
    'role "watched" has a supervised agent; its approval requests would reach nobody until the board is in Lark',
  ],
];

describe("create's refusals, and taskProblems's", () => {
  it('are the same, each in its order, until the task is made', () => {
    const board = service();
    let req: Record<string, unknown> = { ...WRONG };
    for (const [fix, code, message] of STEPS) {
      req = { ...req, ...fix };
      const refusal = { ok: false, code, message };
      expect(board.create(req as unknown as CreateRequest)).toEqual(refusal);
      expect(taskProblems(req as unknown as CreateRequest, facts())).toEqual(refusal);
    }
    req = { ...req, reviewer: 'implementer' };
    expect(taskProblems(req as unknown as CreateRequest, facts())).toBeUndefined();
    const made = board.create(req as unknown as CreateRequest);
    expect(made).toMatchObject({ ok: true, existing: false, task: { title: 'Write the notes', workspace: 'docs', priority: 2 } });
  });

  it('refuses a request that is no object, as create does', () => {
    const refusal = { ok: false, code: 'invalid', message: 'a task to create is an object' };
    expect(service().create(null as unknown as CreateRequest)).toEqual(refusal);
    expect(taskProblems(null as unknown as CreateRequest, facts())).toEqual(refusal);
  });

  it('refuses a person without a talk check, and checks their tier with one', () => {
    const req: CreateRequest = { title: 'T', assignee: 'lark:on_bob', createdBy: ALICE, createdVia: VIA };
    const yet = {
      ok: false,
      code: 'person_not_assignable',
      message: '"lark:on_bob" cannot be given work yet: nothing can deliver a task card to a person until the board is in Lark',
    };
    expect(service().create(req)).toEqual(yet);
    expect(taskProblems(req, facts())).toEqual(yet);
    const noTier = {
      ok: false,
      code: 'person_not_assignable',
      message:
        '"lark:on_bob" cannot be given work: being assigned lets a person report on the task, which needs talk tier, ' +
        'and this gateway does not know them to have it -- a person is known once they have used /kanban, or been @-mentioned in it',
    };
    expect(service(() => false).create(req)).toEqual(noTier);
    expect(taskProblems(req, facts(() => false))).toEqual(noTier);
    expect(taskProblems(req, facts((p) => p === 'lark:on_bob'))).toBeUndefined();
    expect(service((p) => p === 'lark:on_bob').create(req)).toMatchObject({ ok: true, task: { assignee: { kind: 'human', name: 'lark:on_bob' } } });
  });

  it('leaves the key to the service: one in chat\'s namespace from the terminal is refused only by create', () => {
    const req: CreateRequest = { title: 'T', assignee: 'implementer', createdBy: 'operator:me', createdVia: { kind: 'operator' }, idempotencyKey: 'lark:x' };
    expect(taskProblems(req, facts())).toBeUndefined();
    expect(service().create(req)).toEqual({ ok: false, code: 'invalid', message: 'an idempotency key starting lark: is for chat' });
  });
});

describe('assignable', () => {
  it('refuses for assign, assignReviewer and a named reviewer as before', async () => {
    const board = service();
    const made = board.create({ title: 'T', assignee: 'implementer', createdBy: ALICE, createdVia: VIA });
    if (!made.ok) throw new Error(made.message);
    const id = made.task.taskId;
    const cases: Array<[unknown, string, string]> = [
      [7, 'invalid', 'an assignee or reviewer is a role name or a person, as text'],
      ['  ', 'invalid', 'an assignee or reviewer needs a name'],
      ['lark:bad name', 'invalid', '"lark:bad name" is neither a role name nor a person (lark:<union_id>)'],
      ['ghost', 'unknown_role', 'role "ghost" is not configured'],
      ['watched', 'supervised_role', 'role "watched" has a supervised agent; its approval requests would reach nobody until the board is in Lark'],
    ];
    for (const [name, code, message] of cases) {
      const refusal = { ok: false, code, message };
      expect(assignable(name, facts())).toEqual(refusal);
      expect(board.assign(id, name as string, ALICE)).toEqual(refusal);
      expect(board.assignReviewer(id, name as string, ALICE)).toEqual(refusal);
      expect(await board.requestReview(id, { kind: 'person', principal: ALICE }, { summary: 'done', reviewer: name as string })).toEqual(refusal);
    }
    expect(assignable('implementer', facts())).toEqual({ ok: true, assignee: { kind: 'role', name: 'implementer' } });
    expect(assignable('watched', { ...facts(), supervisedRoles: true })).toEqual({ ok: true, assignee: { kind: 'role', name: 'watched' } });
  });
});
