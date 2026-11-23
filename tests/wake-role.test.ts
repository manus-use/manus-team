import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTask, setWake } from '../src/db/kanban.js';
import { eventsOf, getTask } from '../src/db/kanban-read.js';
import { KanbanService, type KanbanServiceDeps } from '../src/kanban/service.js';
import type { Role } from '../src/roles.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, WORKSPACES, claimed, newTask } from './helpers/kanban.js';

/**
 * A role as a wake's target, in the writer and the service (wake spec §19.1):
 * `wake_role` written with `wake_by` and cleared with it, the `wake_set`'s
 * `role`, a switch of target either way, a run's follow-up inheriting it, a
 * reaction task's wake never set, and the role checked by `assignable` when it
 * is set.
 */

const APP = 'cli_app';
const BOB = 'lark:on_bob';

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

function role(name: string, unsupervised = true): Role {
  return {
    name,
    source: 'directory',
    dir: undefined,
    description: undefined,
    workspace: undefined,
    agent: {
      driver: 'structured-cli',
      command: 'bytesec',
      args: [],
      env: {},
      unsupervised,
      passEnv: [],
      readOnlyTools: [],
      maskExempt: [],
    },
    roleMdPath: undefined,
    skills: [],
    secretValues: [],
  };
}

const ROLES: ReadonlyMap<string, Role> = new Map([
  ['implementer', role('implementer')],
  ['vi-coordinator', role('vi-coordinator')],
  ['watcher', role('watcher', false)],
]);

function service(extra: Partial<KanbanServiceDeps> = {}): KanbanService {
  return new KanbanService({ db: h.db, roles: ROLES, workspaces: WORKSPACES, clock: new ManualClock(), ...extra });
}

function wakeSets(taskId: string): unknown[] {
  return eventsOf(h.db, taskId)
    .filter((e) => e.kind === 'wake_set')
    .map((e) => e.payload);
}

describe('setWake with a role', () => {
  it('writes the role with the setter, and names it in the wake_set', () => {
    const task = newTask(h.db);
    const r = setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5, role: 'vi-coordinator' }, ALICE, APP, NOW);
    expect(r).toMatchObject({ ok: true, changed: true, task: { wakeBy: ALICE, wakeRole: 'vi-coordinator' } });
    expect(wakeSets(task.taskId)).toEqual([{ on: true, as: ALICE, depth: 0, role: 'vi-coordinator' }]);
  });

  it('switches the target both ways with the same setter, each a change with its wake_set', () => {
    const task = newTask(h.db);
    setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5 }, ALICE, APP, NOW);
    const toRole = setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5, role: 'vi-coordinator' }, ALICE, APP, NOW + 1);
    expect(toRole).toMatchObject({ ok: true, changed: true, task: { wakeRole: 'vi-coordinator' } });
    const again = setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5, role: 'vi-coordinator' }, ALICE, APP, NOW + 2);
    expect(again).toMatchObject({ ok: true, changed: false });
    const toSession = setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5 }, ALICE, APP, NOW + 3);
    expect(toSession).toMatchObject({ ok: true, changed: true, task: { wakeBy: ALICE, wakeRole: null } });
    expect(wakeSets(task.taskId)).toEqual([
      { on: true, as: ALICE, depth: 0 },
      { on: true, as: ALICE, depth: 0, role: 'vi-coordinator' },
      { on: true, as: ALICE, depth: 0 },
    ]);
  });

  it('clears the role with the setter when turned off', () => {
    const task = newTask(h.db);
    setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5, role: 'vi-coordinator' }, ALICE, APP, NOW);
    setWake(h.db, task.taskId, { on: false }, BOB, APP, NOW + 1);
    expect(getTask(h.db, task.taskId)).toMatchObject({ wakeBy: null, wakeRole: null });
  });

  it("refuses a reaction task's wake, which never wakes anyone", () => {
    const task = newTask(h.db);
    h.db.prepare('UPDATE kanban_tasks SET reaction_of = 1 WHERE task_id = ?').run(task.taskId);
    for (const change of [{ on: true, as: ALICE, maxDepth: 5 } as const, { on: false } as const]) {
      expect(setWake(h.db, task.taskId, change, ALICE, APP, NOW)).toEqual({
        ok: false,
        code: 'invalid',
        message: `\`${task.taskId}\` is a reaction task, which never wakes anyone`,
      });
    }
    expect(wakeSets(task.taskId)).toEqual([]);
  });
});

describe('a task made with a role as its wake', () => {
  it('records the role, and a follow-up of its run inherits it', () => {
    const parent = newTask(h.db, { wake: { by: ALICE, depth: 1, role: 'vi-coordinator' } });
    expect(parent).toMatchObject({ wakeBy: ALICE, wakeDepth: 1, wakeRole: 'vi-coordinator' });
    expect(wakeSets(parent.taskId)).toEqual([{ on: true, as: ALICE, depth: 1, role: 'vi-coordinator' }]);
    const run = claimed(h.db, parent.taskId);
    const r = createTask(h.db, { title: 'a follow-up', createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } }, NOW + 1);
    if (!r.ok) throw new Error(r.message);
    expect(r.task).toMatchObject({ wakeBy: ALICE, wakeDepth: 1, wakeRole: 'vi-coordinator' });
    expect(wakeSets(r.task.taskId)).toEqual([{ on: true, as: ALICE, depth: 1, role: 'vi-coordinator', from: parent.taskId }]);
  });
});

describe("the service's role check", () => {
  it('turns a role wake on for a configured, unsupervised role', () => {
    const s = service();
    const task = newTask(h.db);
    const r = s.setWake(task.taskId, { on: true, as: ALICE, role: 'vi-coordinator' }, ALICE, APP);
    expect(r).toMatchObject({ ok: true, changed: true, task: { wakeRole: 'vi-coordinator' } });
  });

  it("refuses a role that is not configured, or that assignable refuses, as invalid in assignable's words", () => {
    const s = service();
    const task = newTask(h.db);
    expect(s.setWake(task.taskId, { on: true, as: ALICE, role: 'nobody' }, ALICE, APP)).toEqual({
      ok: false,
      code: 'invalid',
      message: 'role "nobody" is not configured',
    });
    expect(s.setWake(task.taskId, { on: true, as: ALICE, role: 'watcher' }, ALICE, APP)).toEqual({
      ok: false,
      code: 'invalid',
      message: 'role "watcher" has a supervised agent; its approval requests would reach nobody until the board is in Lark',
    });
    expect(getTask(h.db, task.taskId)).toMatchObject({ wakeBy: null, wakeRole: null });
  });

  it("refuses a person's principal as a role", () => {
    const s = service({ people: { canTalk: () => true } });
    const task = newTask(h.db);
    const r = s.setWake(task.taskId, { on: true, as: ALICE, role: BOB }, ALICE, APP);
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('makes a task with a role as its wake, and refuses one with an unknown role', () => {
    const s = service();
    const made = s.create({ title: 'Book the venue', assignee: 'implementer', createdBy: ALICE, createdVia: VIA, wake: { by: ALICE, depth: 0, role: 'vi-coordinator' } });
    expect(made).toMatchObject({ ok: true, task: { wakeBy: ALICE, wakeRole: 'vi-coordinator' } });
    const refused = s.create({ title: 'Book the hall', assignee: 'implementer', createdBy: ALICE, createdVia: VIA, wake: { by: ALICE, depth: 0, role: 'nobody' } });
    expect(refused).toEqual({ ok: false, code: 'invalid', message: 'role "nobody" is not configured' });
  });
});
