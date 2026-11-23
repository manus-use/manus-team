import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTask } from '../src/db/kanban-read.js';
import { canonicalDag, checkDagShape } from '../src/kanban/dag.js';
import { KanbanService, type StartRequest, type WorkflowMade } from '../src/kanban/service.js';
import type { Result } from '../src/kanban/types.js';
import { readWorkflow } from '../src/kanban/workflow.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, VIA } from './helpers/kanban.js';

/**
 * A step's and a DAG task's role as a wake's target (wake spec §19.1):
 * `wake: { role: <name> }` in a step, checked as the step's other fields are and
 * carried into the DAG as `"wake": {"role": "<name>"}`; a start's members made
 * with that role as their wake's target, the start's own role first; and a role
 * the board cannot give work refused at the start.
 */

const FLOW = `steps:
  draft:
    title: Draft the agenda
    assignee: implementer
  book:
    parents: [draft]
    title: Book the venue
    assignee: implementer
    wake: { role: vi-coordinator }
`;

const ROLES = new Map([
  ['implementer', role('implementer')],
  ['vi-coordinator', role('vi-coordinator')],
]);
const FACTS = { roles: ROLES, workspaces: new Set(['default']), supervisedRoles: false };

let h: TestDb;
let dir: string;

beforeEach(() => {
  clearSecrets();
  h = testDb();
  dir = join(h.dir, 'workflows');
  mkdirSync(dir);
  writeFileSync(join(dir, 'flow.yaml'), FLOW);
});
afterEach(() => {
  clearSecrets();
  h.close();
});

function service(roles = ROLES): KanbanService {
  return new KanbanService({ db: h.db, roles, workspaces: new Set(['default']), workflowsDir: dir, wake: { enabled: true, maxDepth: 5 } });
}

function made(r: Result<object>): WorkflowMade {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r as unknown as WorkflowMade;
}

function start(s: KanbanService, over: Partial<StartRequest> = {}): Result<WorkflowMade> {
  return s.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA, ...over });
}

function targets(r: WorkflowMade): Array<[string, string | null, string | null]> {
  return r.tasks.map((t) => {
    const task = getTask(h.db, t.taskId);
    return [t.ref, task?.wakeBy ?? null, task?.wakeRole ?? null];
  });
}

describe("a step's role", () => {
  it('reads wake: { role }, and carries it into the DAG', () => {
    const r = readWorkflow(dir, 'flow', FACTS);
    if (!r.ok) throw new Error(r.message);
    expect(r.workflow.steps.map((s) => [s.name, s.wake])).toEqual([
      ['draft', false],
      ['book', { role: 'vi-coordinator' }],
    ]);
    const preview = service().previewWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA });
    if (!preview.ok) throw new Error(preview.message);
    expect(preview.dag.tasks.map((t) => t.wake)).toEqual([undefined, { role: 'vi-coordinator' }]);
    expect(canonicalDag(preview.dag)).toContain('"wake":{"role":"vi-coordinator"}');
  });

  it('refuses a wake that is no role, naming its place', () => {
    for (const [bad, said] of [
      ['wake: { role: "" }', 'steps.book.wake.role is a role\'s name'],
      ['wake: { name: x }', 'unknown setting steps.book.wake.name'],
      ['wake: maybe', 'steps.book.wake is true, false or { role: <name> }'],
    ] as const) {
      writeFileSync(join(dir, 'flow.yaml'), FLOW.replace('wake: { role: vi-coordinator }', bad));
      const r = readWorkflow(dir, 'flow', FACTS);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.message, bad).toContain(said);
    }
  });

  it("makes a start's asking member with the role as its wake's target, as the starter", () => {
    const r = made(start(service(), { wake: { by: ALICE, depth: 0, all: false } }));
    expect(targets(r)).toEqual([
      ['draft', null, null],
      ['book', ALICE, 'vi-coordinator'],
    ]);
  });

  it("gives a start's own role to every member, and a member its step's when the start names none", () => {
    expect(targets(made(start(service(), { wake: { by: ALICE, depth: 0, all: true, role: 'implementer' } })))).toEqual([
      ['draft', ALICE, 'implementer'],
      ['book', ALICE, 'implementer'],
    ]);
    expect(targets(made(start(service(), { idempotencyKey: 'again', wake: { by: ALICE, depth: 0, all: true } })))).toEqual([
      ['draft', ALICE, null],
      ['book', ALICE, 'vi-coordinator'],
    ]);
  });

  it('refuses a start whose step names a role the board cannot give work, and makes nothing', () => {
    const r = start(service(new Map([['implementer', role('implementer')]])), { wake: { by: ALICE, depth: 0, all: false } });
    expect(r).toEqual({ ok: false, code: 'invalid', message: 'role "vi-coordinator" is not configured' });
    expect(h.db.prepare('SELECT count(*) AS n FROM kanban_tasks').get()).toEqual({ n: 0 });
  });
});

describe("a DAG task's role", () => {
  const dag = (wake: unknown) => ({
    format: 1,
    tasks: [{ ref: 'a', title: 'Book the venue', assignee: 'implementer', wake }],
  });

  it('is {"role": "<name>"}, and nothing else of an object', () => {
    const on = checkDagShape(dag({ role: 'vi-coordinator' }), 'terminal');
    if (!on.ok) throw new Error(on.message);
    expect(on.dag.tasks[0]?.wake).toEqual({ role: 'vi-coordinator' });
    for (const bad of [{ role: '' }, { role: 'x', more: 1 }, { name: 'x' }]) {
      expect(checkDagShape(dag(bad), 'terminal')).toEqual({ ok: false, code: 'invalid', message: 'tasks[0] (a).wake is true, false or {"role": "<name>"}' });
    }
  });

  it("makes an apply's member with its role as its wake's target", () => {
    const r = made(
      service().applyDag({
        dag: { format: 1, tasks: [{ ref: 'a', title: 'A', wake: { role: 'vi-coordinator' } }, { ref: 'b', title: 'B' }] },
        createdBy: ALICE,
        createdVia: VIA,
        wake: { by: ALICE, depth: 0, all: false },
      }),
    );
    expect(targets(r)).toEqual([
      ['a', ALICE, 'vi-coordinator'],
      ['b', null, null],
    ]);
  });
});
