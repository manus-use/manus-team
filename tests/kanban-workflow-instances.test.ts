import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { archive, block, closeRun, complete, createTask } from '../src/db/kanban.js';
import { getRun, getTask, membersWithTasks } from '../src/db/kanban-read.js';
import { KanbanService, type WorkflowMade } from '../src/kanban/service.js';
import type { Phase, Result } from '../src/kanban/types.js';
import { instanceStatus } from '../src/kanban/workflow.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * Seeing and managing workflows (workflows spec §10): the derived status, `list`,
 * `instances`, `show`'s members and related tasks, and `archive`.
 */

let h: TestDb;
let dir: string;
let service: KanbanService;

beforeEach(() => {
  clearSecrets();
  h = testDb();
  dir = join(h.dir, 'workflows');
  mkdirSync(dir);
  writeFileSync(join(dir, 'vendor-eval.yaml'), VENDOR_EVAL);
  service = new KanbanService({
    db: h.db,
    roles: new Map([
      ['worker', role('worker')],
      ['reviewer', role('reviewer')],
    ]),
    workspaces: new Set(['default']),
    supervisedRoles: true,
    workflowsDir: dir,
  });
});
afterEach(() => {
  clearSecrets();
  h.close();
});

function start(key?: string): WorkflowMade {
  const r: Result<WorkflowMade> = service.startWorkflow({
    workflow: 'vendor-eval',
    params: { from: 'json', params: { topic: 'logs', vendors: ['acme', 'globex'] } },
    createdBy: ALICE,
    createdVia: VIA,
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r;
}

/** A member done, through its run. */
function finish(taskId: string): void {
  const run = claimed(h.db, taskId);
  const r = complete(h.db, taskId, { kind: 'run', runId: run.runId }, { summary: 'done' }, NOW);
  if (!r.ok) throw new Error(r.message);
  // Its turn over: the workspace is free for the next.
  if (!closeRun(h.db, run.runId, NOW).ok) throw new Error(`run ${run.runId} did not close`);
}

describe('instanceStatus', () => {
  it('is archived, done, blocked with its count, or running, counting an archived member as finished', () => {
    const of = (...phases: Phase[]) => instanceStatus(phases);
    expect(of('archived', 'archived')).toEqual({ status: 'archived', done: 2, total: 2, blocked: 0 });
    expect(of('done', 'archived', 'done')).toEqual({ status: 'done', done: 3, total: 3, blocked: 0 });
    expect(of('done', 'blocked', 'blocked', 'open')).toEqual({ status: 'blocked', done: 1, total: 4, blocked: 2 });
    expect(of('done', 'open', 'review')).toEqual({ status: 'running', done: 1, total: 3, blocked: 0 });
  });
});

describe('workflows', () => {
  it('lists the usable files and each broken one with why, read at each call', () => {
    writeFileSync(join(dir, 'broken.yaml'), 'steps: {}\n');
    const list = service.workflows();
    expect(list.usable.map((w) => w.name)).toEqual(['vendor-eval']);
    expect(list.broken).toEqual([{ name: 'broken', problem: 'the file needs steps, at least one' }]);
    rmSync(join(dir, 'broken.yaml'));
    expect(service.workflows().broken).toEqual([]);
  });
});

describe('instances', () => {
  it('lists the running and blocked by default, newest first, and every one with all', () => {
    const a = start();
    for (const t of a.tasks) archive(h.db, t.taskId, ALICE, NOW);
    const b = start();
    const c = start();
    const r = block(h.db, c.tasks[0]?.taskId ?? '', { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason: 'which logs?' }, NOW);
    expect(r.ok).toBe(true);
    const ids = (all: boolean) => service.instances('default', all).instances.map((i) => [i.instance.instanceId, i.status]);
    expect(ids(false)).toEqual(
      expect.arrayContaining([
        [b.instance.instanceId, 'running'],
        [c.instance.instanceId, 'blocked'],
      ]),
    );
    expect(ids(false)).toHaveLength(2);
    expect(ids(true)).toHaveLength(3);
    expect(service.instances('default', true)).toMatchObject({ total: 3, read: 3 });
    expect(service.instances('elsewhere', true)).toEqual({ instances: [], total: 0, read: 0 });
  });

  it("reads every instance's status in one aggregate query, however many members and instances there are", () => {
    const prepared = (): number => {
      const spy = vi.spyOn(h.db, 'prepare');
      try {
        service.instances('default', true);
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };
    const first = start();
    block(h.db, first.tasks[0]?.taskId ?? '', { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason: 'which logs?' }, NOW);
    const one = prepared();
    for (let n = 0; n < 4; n += 1) start();
    expect(prepared()).toBe(one);
    expect(service.instances('default', true).instances.map((i) => [i.status, i.done, i.total, i.blocked])).toEqual([
      ...Array.from({ length: 4 }, () => ['running', 0, 4, 0]),
      ['blocked', 0, 4, 1],
    ]);
  });
});

describe('membersWithTasks', () => {
  it("gives an instance's members in position order, each with its task, in two queries however many there are", () => {
    const r = start();
    const spy = vi.spyOn(h.db, 'prepare');
    const members = membersWithTasks(h.db, r.instance.instanceId);
    expect(spy.mock.calls.length).toBe(2);
    spy.mockRestore();
    expect(members.map((m) => [m.position, m.ref, m.task.taskId])).toEqual(r.tasks.map((t) => [t.position, t.ref, t.taskId]));
    expect(members.map((m) => m.task)).toEqual(r.tasks.map((t) => getTask(h.db, t.taskId)));
    expect(membersWithTasks(h.db, 'w_none')).toEqual([]);
  });
});

describe('instance', () => {
  it("gives the members in position order with their status, the file's description, and the related tasks apart", () => {
    const r = start();
    const shortlist = r.tasks[0]?.taskId ?? '';
    finish(shortlist);
    const run = claimed(h.db, r.tasks[1]?.taskId ?? '');
    const follow = createTask(h.db, { title: 'Follow-up', createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } }, NOW);
    if (!follow.ok) throw new Error(follow.message);
    const shown = service.instance(r.instance.instanceId);
    if (!shown.ok) throw new Error(shown.message);
    const v = shown.view;
    expect(v.description).toBe('Shortlist vendors, evaluate each in parallel, then recommend one');
    expect(v.members.map((m) => [m.ref, m.item, m.status])).toEqual([
      ['shortlist', null, 'done'],
      ['evaluate:1', 'acme', 'running'],
      ['evaluate:2', 'globex', 'ready'],
      ['recommend', null, 'todo'],
    ]);
    expect(v.related.map((x) => x.task.taskId)).toEqual([follow.task.taskId]);
    expect(v).toMatchObject({ status: 'running', done: 1, total: 4, blocked: 0, relatedInstances: [] });
    rmSync(join(dir, 'vendor-eval.yaml'));
    expect(service.instance(r.instance.instanceId)).toMatchObject({ ok: true, view: { description: undefined } });
    expect(service.instance('w_none')).toEqual({ ok: false, code: 'not_found', message: 'no workflow instance w_none' });
  });

  it('shows another instance its deciding step started as one related line', () => {
    const first = start();
    const decider = first.tasks[0]?.taskId ?? '';
    const run = claimed(h.db, decider);
    const second = service.startWorkflow({
      workflow: 'vendor-eval',
      params: { from: 'json', params: { topic: 'more', vendors: ['initech'] } },
      createdBy: `run:${run.runId}`,
      createdVia: { kind: 'run', runId: run.runId },
    });
    if (!second.ok) throw new Error(second.message);
    const shown = service.instance(first.instance.instanceId);
    expect(shown.ok && shown.view.related).toEqual([]);
    expect(shown.ok && shown.view.relatedInstances).toEqual([{ instanceId: second.instance.instanceId, name: 'vendor-eval', tasks: 3 }]);
  });
});

describe('archiveWorkflow', () => {
  it('archives every member, superseding an undecided run, a done task keeping its time, and a second archive changes nothing', () => {
    const r = start();
    const shortlist = r.tasks[0]?.taskId ?? '';
    finish(shortlist);
    const doneAt = getTask(h.db, shortlist)?.closedAt;
    const run = claimed(h.db, r.tasks[1]?.taskId ?? '');
    const done = service.archiveWorkflow(r.instance.instanceId, ALICE);
    if (!done.ok) throw new Error(done.message);
    expect(done.archived).toHaveLength(4);
    expect(done.runs.map((x) => x.runId)).toEqual([run.runId]);
    expect(getRun(h.db, run.runId)?.outcome).toBe('superseded');
    expect(getTask(h.db, shortlist)).toMatchObject({ phase: 'archived', closedAt: doneAt });
    expect(service.instance(r.instance.instanceId)).toMatchObject({ ok: true, view: { status: 'archived', done: 4 } });
    expect(service.archiveWorkflow(r.instance.instanceId, ALICE)).toMatchObject({ ok: true, archived: [], runs: [] });
    expect(service.archiveWorkflow(r.instance.instanceId, ' ')).toEqual({ ok: false, code: 'invalid', message: 'who archives is text, not blank' });
  });

  it('counts a member archived by hand among done ones as finished', () => {
    const r = start();
    for (const t of r.tasks.slice(0, 3)) finish(t.taskId);
    archive(h.db, r.tasks[3]?.taskId ?? '', ALICE, NOW);
    expect(service.instance(r.instance.instanceId)).toMatchObject({ ok: true, view: { status: 'done', done: 4, total: 4 } });
  });
});
