import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveBoard, archiveWorkflow, createBoard } from '../src/db/kanban.js';
import { eventsOf, getInstance, getTask, parentsOf } from '../src/db/kanban-read.js';
import { dagFile, type Dag } from '../src/kanban/dag.js';
import { KanbanService, type ApplyRequest, type StartRequest, type WorkflowMade } from '../src/kanban/service.js';
import type { CreatedVia, Result } from '../src/kanban/types.js';
import type { Role } from '../src/roles.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, NOW, VIA, claimed, newTask } from './helpers/kanban.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * A start, a preview and an apply through the service (spec §21.6): the key
 * looked up first, the file read now, the checks, the one transaction, the
 * board in each path, the keys in their namespaces, a dry run, and what changes
 * between a preview and its apply.
 */

const SECRET = 'sk-live-1234567890';
const OPERATOR: CreatedVia = { kind: 'operator' };
const BOB = 'lark:on_bob';

let h: TestDb;
let dir: string;
let talks: Set<string>;
let roles: Map<string, Role>;
let service: KanbanService;

beforeEach(() => {
  clearSecrets();
  addSecrets([SECRET]);
  h = testDb();
  dir = join(h.dir, 'workflows');
  mkdirSync(dir);
  writeFileSync(join(dir, 'vendor-eval.yaml'), VENDOR_EVAL);
  talks = new Set([BOB]);
  roles = new Map([
    ['worker', role('worker')],
    ['reviewer', role('reviewer')],
    ['implementer', role('implementer')],
  ]);
  service = new KanbanService({
    db: h.db,
    roles,
    workspaces: new Set(['default', 'web']),
    people: { canTalk: (p) => talks.has(p) },
    supervisedRoles: true,
    workflowsDir: dir,
  });
});
afterEach(() => {
  clearSecrets();
  h.close();
});

const PARAMS = { from: 'json', params: { topic: 'log storage', vendors: ['acme', 'globex'] } } as const;

function start(over: Partial<StartRequest> = {}): Result<WorkflowMade> {
  return service.startWorkflow({ workflow: 'vendor-eval', params: PARAMS, createdBy: ALICE, createdVia: VIA, ...over });
}

function made(r: Result<object>): WorkflowMade {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  if (!('instance' in r)) throw new Error('a dry run');
  return r as unknown as WorkflowMade;
}

const tasks = (): number => (h.db.prepare('SELECT count(*) AS n FROM kanban_tasks').get() as { n: number }).n;
const instances = (): number => (h.db.prepare('SELECT count(*) AS n FROM kanban_workflow_instances').get() as { n: number }).n;

function preview(over: Partial<StartRequest> = {}): Dag {
  const r = service.previewWorkflow({ workflow: 'vendor-eval', params: PARAMS, createdBy: 'operator:me', createdVia: OPERATOR, ...over });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.dag;
}

function apply(dag: unknown, over: Partial<ApplyRequest> = {}) {
  return service.applyDag({ dag, createdBy: 'operator:me', createdVia: OPERATOR, ...over });
}

describe('startWorkflow', () => {
  it("makes the expansion's tasks, links and gates, each created event carrying the instance, the chat following every one", () => {
    const r = made(start());
    expect(r.existing).toBe(false);
    expect(r.instance).toMatchObject({ name: 'vendor-eval', source: 'start', board: 'default' });
    expect(r.tasks.map((t) => [t.ref, t.task.title, t.task.assignee?.name])).toEqual([
      ['shortlist', 'Shortlist vendors for log storage', 'worker'],
      ['evaluate:1', 'Evaluate acme for log storage', 'worker'],
      ['evaluate:2', 'Evaluate globex for log storage', 'worker'],
      ['recommend', 'Recommend a vendor for log storage', 'worker'],
    ]);
    expect(r.tasks[3]?.task.reviewer).toEqual({ kind: 'role', name: 'reviewer' });
    expect(parentsOf(h.db, r.tasks[3]?.taskId ?? '').length).toBe(2);
    for (const t of r.tasks) {
      expect(eventsOf(h.db, t.taskId)[0]).toMatchObject({ kind: 'created', actor: ALICE, payload: { workflow: r.instance.instanceId, workflowName: 'vendor-eval', ref: t.ref, step: t.step, item: t.item } });
    }
  });

  it('refuses a broken file, an unknown workflow naming the usable ones, and one failure refuses the whole start, naming the task', () => {
    writeFileSync(join(dir, 'broken.yaml'), 'steps: {}\n');
    expect(start({ workflow: 'broken' })).toEqual({ ok: false, code: 'invalid', message: 'workflow broken is not usable: the file needs steps, at least one' });
    expect(start({ workflow: 'vendor-evl' })).toEqual({
      ok: false,
      code: 'unknown_workflow',
      message: 'there is no workflow vendor-evl; the usable ones are vendor-eval; their params: vendor-eval takes topic (required), vendors (list, required), reviewer (default reviewer)',
    });
    roles.delete('reviewer');
    expect(start()).toEqual({ ok: false, code: 'unknown_role', message: 'recommend: role "reviewer" is not configured' });
    roles.set('reviewer', role('reviewer'));
    writeFileSync(join(dir, 'vendor-eval.yaml'), VENDOR_EVAL.replace('    title: Evaluate {{item}} for {{topic}}\n    assignee: worker\n', '    title: Evaluate {{item}} for {{topic}}\n    assignee: "{{item}}"\n'));
    expect(start({ params: { from: 'json', params: { topic: 'x', vendors: ['worker', 'evaluator'] } } })).toEqual({
      ok: false,
      code: 'unknown_role',
      message: 'evaluate:2, step evaluate, item "evaluator": role "evaluator" is not configured',
    });
    expect([tasks(), instances()]).toEqual([0, 0]);
  });

  it('starts a usable workflow beside a file that cannot be read, and refuses that one invalid', () => {
    writeFileSync(join(dir, 'locked.yaml'), VENDOR_EVAL);
    chmodSync(join(dir, 'locked.yaml'), 0o000);
    expect(start({ workflow: 'locked' })).toEqual({ ok: false, code: 'invalid', message: 'workflow locked is not usable: the file cannot be read: EACCES' });
    expect(start({ workflow: 'nope' })).toMatchObject({ ok: false, code: 'unknown_workflow', message: expect.stringMatching(/the usable ones are vendor-eval;/) });
    expect(made(start()).tasks.length).toBeGreaterThan(0);
  });

  it('cuts the message of unknown_workflow at 4 KiB, the names first, saying what was left out', () => {
    for (let i = 0; i < 300; i += 1) writeFileSync(join(dir, `w${String(i).padStart(3, '0')}-${'x'.repeat(20)}.yaml`), VENDOR_EVAL);
    const r = start({ workflow: 'nope' });
    expect(r.ok).toBe(false);
    const message = r.ok ? '' : r.message;
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(4096);
    expect(message).toMatch(/^there is no workflow nope; the usable ones are vendor-eval, w000-x+, w001-x+, /);
    expect(message).toMatch(/ and \d+ more(; the params of \d+ more left out)?$/);
  });

  it('answers a repeated key before the file is read, even once it is removed or broken, and refuses it for another workflow', () => {
    const first = made(start({ idempotencyKey: 'lark:om_1' }));
    rmSync(join(dir, 'vendor-eval.yaml'));
    expect(made(start({ idempotencyKey: 'lark:om_1' }))).toMatchObject({ existing: true, instance: { instanceId: first.instance.instanceId } });
    writeFileSync(join(dir, 'vendor-eval.yaml'), 'steps: {}\n');
    talks.clear();
    expect(made(start({ idempotencyKey: 'lark:om_1' })).tasks.map((t) => t.taskId)).toEqual(first.tasks.map((t) => t.taskId));
    writeFileSync(join(dir, 'release.yaml'), 'steps:\n  ship: { title: Ship, assignee: worker }\n');
    expect(start({ workflow: 'release', idempotencyKey: 'lark:om_1' })).toEqual({
      ok: false,
      code: 'invalid',
      message: `this idempotency key was used to start workflow vendor-eval, as ${first.instance.instanceId}, not release`,
    });
    expect(instances()).toBe(1);
  });

  it("keeps each path's keys in their namespace, refusing another's, and another board's key other_board", () => {
    expect(start({ idempotencyKey: 'operator:x' })).toEqual({ ok: false, code: 'invalid', message: 'an idempotency key starting operator: is for the terminal' });
    expect(start({ createdVia: OPERATOR, createdBy: 'operator:me', idempotencyKey: 'lark:om_1' })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'an idempotency key starting lark: is for chat',
    });
    const term = made(start({ createdVia: OPERATOR, createdBy: 'operator:me', idempotencyKey: 'k' }));
    expect(term.instance.idempotencyKey).toBe('operator:k');
    createBoard(h.db, 'research', ALICE, NOW);
    expect(start({ createdVia: OPERATOR, createdBy: 'operator:me', idempotencyKey: 'k', board: 'research' })).toEqual({
      ok: false,
      code: 'other_board',
      message: `instance ${term.instance.instanceId} was made with this idempotency key on board default, not research`,
    });
    const planner = newTask(h.db, { assignee: { kind: 'role', name: 'implementer' } });
    const run = claimed(h.db, planner.taskId);
    const fromRun = made(start({ createdVia: { kind: 'run', runId: run.runId }, createdBy: `run:${run.runId}`, idempotencyKey: 'k' }));
    expect(fromRun.instance.idempotencyKey).toBe(`run-task:${planner.taskId}:k`);
  });

  it("puts a start on chat's or the terminal's board, refusing an archived one, and a run's on its task's, created from its task", () => {
    createBoard(h.db, 'research', ALICE, NOW);
    expect(made(start({ board: 'research' })).instance.board).toBe('research');
    createBoard(h.db, 'old', ALICE, NOW);
    archiveBoard(h.db, 'old', ALICE, NOW);
    expect(start({ board: 'old' })).toEqual({ ok: false, code: 'board_archived', message: 'board old is archived; nothing is added to it' });
    expect(start({ board: 'nowhere' })).toEqual({ ok: false, code: 'unknown_board', message: 'there is no board nowhere' });
    const planner = newTask(h.db, { assignee: { kind: 'role', name: 'implementer' } });
    const run = claimed(h.db, planner.taskId);
    const r = made(start({ createdVia: { kind: 'run', runId: run.runId }, createdBy: `run:${run.runId}`, board: 'research' }));
    expect(r.instance.board).toBe('default');
    for (const t of r.tasks) expect(t.task).toMatchObject({ board: 'default', createdFromTask: planner.taskId });
  });

  it('refuses any person at the terminal, and one without talk tier from chat', () => {
    const owned = 'params:\n  owner: { required: true }\nsteps:\n  a: { title: A, assignee: "{{owner}}" }\n';
    writeFileSync(join(dir, 'owned.yaml'), owned);
    const params = { from: 'json', params: { owner: BOB } } as const;
    expect(start({ workflow: 'owned', params, createdVia: OPERATOR, createdBy: 'operator:me' })).toEqual({
      ok: false,
      code: 'person_not_assignable',
      message: 'a: "lark:on_bob" is a person: give a person work from chat, by @-mention, where the gateway can check they have talk tier',
    });
    expect(made(start({ workflow: 'owned', params })).tasks[0]?.task.assignee).toEqual({ kind: 'human', name: BOB });
    talks.clear();
    expect(start({ workflow: 'owned', params })).toMatchObject({ ok: false, code: 'person_not_assignable', message: expect.stringMatching(/^a: "lark:on_bob" cannot be given work: being assigned/) });
  });
});

describe('previewWorkflow', () => {
  it('makes nothing, refuses as a start would, and checks no key', () => {
    const dag = preview();
    expect(dag.tasks.map((t) => t.ref)).toEqual(['shortlist', 'evaluate:1', 'evaluate:2', 'recommend']);
    expect([tasks(), instances()]).toEqual([0, 0]);
    expect(service.previewWorkflow({ workflow: 'vendor-eval', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'workflow vendor-eval needs param topic: what is being bought',
    });
    made(start({ idempotencyKey: 'lark:om_1' }));
    expect(service.previewWorkflow({ workflow: 'vendor-eval', params: PARAMS, idempotencyKey: 'lark:om_1', createdBy: ALICE, createdVia: VIA }).ok).toBe(true);
  });
});

describe('applyDag', () => {
  it('makes what a start makes, from a preview, and stores the DAG with no file', () => {
    const dag = JSON.parse(dagFile(preview())) as unknown;
    const r = made(apply(dag));
    expect(r.instance).toMatchObject({ name: 'vendor-eval', source: 'apply' });
    expect(r.tasks.map((t) => [t.ref, t.task.title])).toEqual(made(start()).tasks.map((t) => [t.ref, t.task.title]));
    rmSync(join(dir, 'vendor-eval.yaml'));
    expect(getInstance(h.db, r.instance.instanceId)?.dag.tasks).toHaveLength(4);
  });

  it('refuses an unknown key, the wrong shape, before any existing answer, with a key already used', () => {
    const dag = JSON.parse(dagFile(preview())) as Record<string, unknown>;
    made(apply(dag, { idempotencyKey: 'k' }));
    expect(apply({ ...dag, colour: 'red' }, { idempotencyKey: 'k' })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'a DAG takes no key "colour" (it takes format, workflow, params, board, tasks)',
    });
  });

  it('answers a repeat of one DAG existing, refuses another DAG, and refuses a start\'s key and the reverse', () => {
    const dag = JSON.parse(dagFile(preview())) as Record<string, unknown>;
    const first = made(apply(dag, { idempotencyKey: 'k' }));
    const reindented = JSON.parse(JSON.stringify(dag, null, 9)) as unknown;
    expect(made(apply(reindented, { idempotencyKey: 'k' }))).toMatchObject({ existing: true, instance: { instanceId: first.instance.instanceId } });
    const other = JSON.parse(dagFile(preview({ params: { from: 'json', params: { topic: 'other', vendors: ['acme'] } } }))) as unknown;
    expect(apply(other, { idempotencyKey: 'k' })).toEqual({ ok: false, code: 'invalid', message: `this idempotency key was used to apply another DAG, as ${first.instance.instanceId}` });
    expect(start({ createdVia: OPERATOR, createdBy: 'operator:me', idempotencyKey: 'k' })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/^this idempotency key was used to apply a DAG/) });
    made(start({ createdVia: OPERATOR, createdBy: 'operator:me', idempotencyKey: 's' }));
    expect(apply(dag, { idempotencyKey: 's' })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/^this idempotency key was used to start a workflow/) });
  });

  it('with dryRun makes every check and writes nothing, answering what it would make, or the instance its key made', () => {
    const dag = JSON.parse(dagFile(preview())) as Record<string, unknown>;
    const dry = apply(dag, { dryRun: true });
    expect(dry).toMatchObject({ ok: true, dryRun: true, existing: false, instanceId: null, board: 'default' });
    expect(dry.ok && 'dryRun' in dry ? dry.tasks.map((t) => [t.ref, t.gates]) : []).toEqual([
      ['shortlist', []],
      ['evaluate:1', [{ command: 'test -s evaluation.md', timeout_s: 30 }]],
      ['evaluate:2', [{ command: 'test -s evaluation.md', timeout_s: 30 }]],
      ['recommend', []],
    ]);
    expect([tasks(), instances()]).toEqual([0, 0]);
    roles.delete('worker');
    expect(apply(dag, { dryRun: true })).toEqual({ ok: false, code: 'unknown_role', message: 'shortlist: role "worker" is not configured' });
    roles.set('worker', role('worker'));
    const first = made(apply(dag, { idempotencyKey: 'k' }));
    expect(apply(dag, { idempotencyKey: 'k', dryRun: true })).toMatchObject({ ok: true, dryRun: true, existing: true, instanceId: first.instance.instanceId });
  });

  it('checks again what changed since the preview: a role removed, a person without talk tier, a board archived', () => {
    createBoard(h.db, 'research', ALICE, NOW);
    const dag = JSON.parse(dagFile(preview({ board: 'research' }))) as Record<string, unknown>;
    roles.delete('reviewer');
    expect(apply(dag)).toEqual({ ok: false, code: 'unknown_role', message: 'recommend: role "reviewer" is not configured' });
    roles.set('reviewer', role('reviewer'));
    archiveBoard(h.db, 'research', ALICE, NOW);
    expect(apply(dag)).toEqual({ ok: false, code: 'board_archived', message: 'board research is archived; nothing is added to it' });
    const person = { format: 1, tasks: [{ ref: 'ask', title: 'Ask Bob', assignee: BOB }] };
    const planner = newTask(h.db, { assignee: { kind: 'role', name: 'implementer' } });
    const run = claimed(h.db, planner.taskId);
    const viaRun = { createdVia: { kind: 'run', runId: run.runId } as CreatedVia, createdBy: `run:${run.runId}` };
    expect(apply(person, viaRun).ok).toBe(true);
    talks.clear();
    expect(apply(person, viaRun)).toMatchObject({ ok: false, code: 'person_not_assignable' });
  });

  it('changes nothing for a file edited after its preview: the DAG is what is made', () => {
    const dag = JSON.parse(dagFile(preview())) as unknown;
    writeFileSync(join(dir, 'vendor-eval.yaml'), VENDOR_EVAL.replace('Shortlist vendors for', 'Shortlist suppliers for'));
    expect(made(apply(dag)).tasks[0]?.task.title).toBe('Shortlist vendors for log storage');
  });

  it("takes gates at the terminal, refuses one holding the mask, and from a run refuses gates and a board not its task's", () => {
    const gated = { format: 1, tasks: [{ ref: 'a', title: 'A', assignee: 'worker', gates: [{ command: 'npm test' }] }] };
    expect(made(apply(gated)).tasks[0]?.task.taskId).toMatch(/^k_/);
    expect(apply({ format: 1, tasks: [{ ref: 'a', title: 'A', gates: [{ command: `curl ${MASK}` }] }] })).toMatchObject({ ok: false, code: 'invalid' });
    const planner = newTask(h.db, { assignee: { kind: 'role', name: 'implementer' } });
    const run = claimed(h.db, planner.taskId);
    const viaRun = { createdVia: { kind: 'run', runId: run.runId } as CreatedVia, createdBy: `run:${run.runId}` };
    expect(apply(gated, viaRun)).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/apply-dag takes none/) });
    createBoard(h.db, 'research', ALICE, NOW);
    const plain = { format: 1, board: 'research', tasks: [{ ref: 'a', title: 'A', assignee: 'worker' }] };
    expect(apply(plain, viaRun)).toEqual({ ok: false, code: 'other_board', message: "the DAG is for board research, and a run's work stays on its task's board, default" });
    const none = made(apply({ ...plain, board: null }, viaRun));
    expect(none.instance).toMatchObject({ name: null, board: 'default' });
    expect(none.tasks[0]?.task.createdFromTask).toBe(planner.taskId);
    expect(made(apply({ ...plain, board: 'default' }, viaRun)).instance.board).toBe('default');
  });

  it('applies 100 tasks from the terminal, the last with 99 parents: no worker limit on parents holds here', () => {
    const dag = { format: 1, tasks: Array.from({ length: 100 }, (_, i) => ({ ref: `t${i}`, title: `Task ${i}`, assignee: 'worker', parents: Array.from({ length: i }, (_, j) => `t${j}`) })) };
    const r = made(apply(dag));
    expect(r.tasks).toHaveLength(100);
    expect((h.db.prepare('SELECT count(*) AS n FROM kanban_links').get() as { n: number }).n).toBe(4950);
    expect(parentsOf(h.db, r.tasks[99]?.taskId ?? '')).toHaveLength(99);
  });

  it("stores a DAG's texts masked but its gates, and an archived instance's key stays used", () => {
    const dag = { format: 1, params: {}, tasks: [{ ref: 'a', title: `Use ${SECRET}`, assignee: 'worker', gates: [{ command: 'test -s $OUT' }] }] };
    const r = made(apply(dag, { idempotencyKey: 'k' }));
    expect(getInstance(h.db, r.instance.instanceId)?.dag.tasks[0]).toMatchObject({ title: `Use ${MASK}`, gates: [{ command: 'test -s $OUT', timeout_s: 300 }] });
    expect(getTask(h.db, r.tasks[0]?.taskId ?? '')?.title).toBe(`Use ${MASK}`);
    archiveWorkflow(h.db, r.instance.instanceId, ALICE, NOW);
    expect(made(apply(dag, { idempotencyKey: 'k' })).existing).toBe(true);
  });
});
