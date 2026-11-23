import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { instanceText } from '../src/cli/plain.js';
import { renderInstance } from '../src/kanban/chat-render.js';
import { KanbanService } from '../src/kanban/service.js';
import { checkTask } from '../src/kanban/task-checks.js';
import type { CreatedVia } from '../src/kanban/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, VIA, WORKSPACES, claimed, newTask } from './helpers/kanban.js';

/**
 * A reaction task's making (wake spec §19.3, §19.12): `createdVia` of kind
 * `wake`, which the checks accept with a wake's whole id and the service refuses
 * from every caller, as only the waker's own write makes one; the key namespace
 * `wake:`, refused for every other creator; and how a thing made by a wake is
 * said, beside "by a run of".
 */

const BY_A_WAKE = "a task made by a wake is the waker's own: no other caller makes one";
const WAKE_KEY = "an idempotency key starting wake: is the waker's own";
const ROLES = new Map([['implementer', role('implementer')]]);
const FACTS = { roles: ROLES, workspaces: WORKSPACES, supervisedRoles: false };

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

function service(): KanbanService {
  return new KanbanService({ db: h.db, roles: ROLES, workspaces: WORKSPACES, clock: new ManualClock() });
}

describe("createdVia's kind wake", () => {
  it("is accepted by the checks with a wake's whole id, and nothing else", () => {
    const check = (createdVia: unknown) => checkTask({ title: 'React', createdBy: ALICE, createdVia: createdVia as CreatedVia }, FACTS);
    expect(check({ kind: 'wake', wakeId: 3 })).toMatchObject({ ok: true });
    for (const bad of [{ kind: 'wake', wakeId: 0 }, { kind: 'wake', wakeId: 'w1' }, { kind: 'wake', wakeId: 1.5 }, { kind: 'wake' }, { kind: 'wake', wakeId: 2, runId: 'r' }]) {
      expect(check(bad), JSON.stringify(bad)).toEqual({
        ok: false,
        code: 'invalid',
        message: 'created_via is a chat, with text fields, a run id, the operator, or a wake id',
      });
    }
  });

  it('is refused by the service from every caller: a task, a start and an apply', () => {
    const s = service();
    const via: CreatedVia = { kind: 'wake', wakeId: 1 };
    expect(s.create({ title: 'React', createdBy: ALICE, createdVia: via })).toEqual({ ok: false, code: 'invalid', message: BY_A_WAKE });
    expect(s.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: via })).toEqual({
      ok: false,
      code: 'invalid',
      message: BY_A_WAKE,
    });
    expect(s.applyDag({ dag: { format: 1, tasks: [{ ref: 'a', title: 'A' }] }, createdBy: ALICE, createdVia: via })).toEqual({
      ok: false,
      code: 'invalid',
      message: BY_A_WAKE,
    });
    expect(h.db.prepare('SELECT count(*) AS n FROM kanban_tasks').get()).toEqual({ n: 0 });
  });
});

describe('the key namespace wake:', () => {
  it('is refused for chat, the terminal and a run', () => {
    const s = service();
    const parent = newTask(h.db);
    const run = claimed(h.db, parent.taskId);
    const vias: CreatedVia[] = [VIA, { kind: 'operator' }, { kind: 'run', runId: run.runId }];
    for (const createdVia of vias) {
      expect(s.create({ title: 'React', createdBy: ALICE, createdVia, idempotencyKey: 'wake:abc' }), createdVia.kind).toEqual({
        ok: false,
        code: 'invalid',
        message: WAKE_KEY,
      });
    }
  });
});

describe('how a thing made by a wake is said', () => {
  const view = (kind: string) => ({
    instance: { instanceId: 'wf_one', name: 'flow', board: 'default', createdBy: ALICE, createdVia: { kind }, createdAt: 0, dag: { params: {} } },
    description: undefined,
    members: [{ step: 'a', item: null, task: { ...newTask(h.db), createdFromTask: 'k_source' }, status: 'ready' as const }],
    related: [],
    relatedInstances: [],
    status: 'ready',
    done: 0,
    total: 1,
    blocked: 0,
  });

  it('says "by a wake of" its task, as "by a run of" is said, in chat and at the terminal', () => {
    expect(renderInstance(view('wake'), 'default', () => 'nobody', () => undefined)).toContain('by a wake of `k_source`');
    expect(instanceText(view('wake')).join('\n')).toContain('by a wake of k_source');
    expect(instanceText(view('run')).join('\n')).toContain('by a run of k_source');
  });
});
