import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTask } from '../src/db/kanban.js';
import { eventsOf, getTask } from '../src/db/kanban-read.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, claimed, newTask } from './helpers/kanban.js';

/**
 * A task made with wake on (wake spec §3.1, §3.3, §4.4, §9.1): its `wake_by` and
 * `wake_depth`, and a `wake_set` event in its making's transaction; a run's
 * follow-up inheriting its creating task's wake and depth; and a task too deep
 * made with wake off, its `wake_set` saying why.
 */

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

function wakeSets(taskId: string): Array<{ actor: string; payload: unknown }> {
  return eventsOf(h.db, taskId)
    .filter((e) => e.kind === 'wake_set')
    .map((e) => ({ actor: e.actor, payload: e.payload }));
}

function followUp(parentId: string, extra: Record<string, unknown> = {}): string {
  const run = claimed(h.db, parentId);
  const r = createTask(h.db, { title: 'a follow-up', createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId }, ...extra }, NOW + 1);
  if (!r.ok) throw new Error(r.message);
  return r.task.taskId;
}

describe('a task made with wake on', () => {
  it('records its setter and depth, and one wake_set after its created event', () => {
    const task = newTask(h.db, { wake: { by: ALICE, depth: 0 } });
    expect(task).toMatchObject({ wakeBy: ALICE, wakeDepth: 0 });
    expect(eventsOf(h.db, task.taskId).map((e) => e.kind)).toEqual(['created', 'wake_set']);
    expect(wakeSets(task.taskId)).toEqual([{ actor: ALICE, payload: { on: true, as: ALICE, depth: 0 } }]);
  });

  it('keeps the depth it is given', () => {
    const task = newTask(h.db, { wake: { by: 'lark:on_bob', depth: 3 } });
    expect(task).toMatchObject({ wakeBy: 'lark:on_bob', wakeDepth: 3 });
    expect(wakeSets(task.taskId)).toEqual([{ actor: ALICE, payload: { on: true, as: 'lark:on_bob', depth: 3 } }]);
  });

  it('has wake off, depth 0 and no wake_set when none is asked', () => {
    const task = newTask(h.db);
    expect(task).toMatchObject({ wakeBy: null, wakeDepth: 0 });
    expect(wakeSets(task.taskId)).toEqual([]);
  });

  it('can be made at a depth with wake off, a task made in a woken shell without a wake', () => {
    const task = newTask(h.db, { wake: { by: null, depth: 2 } });
    expect(task).toMatchObject({ wakeBy: null, wakeDepth: 2 });
    expect(wakeSets(task.taskId)).toEqual([]);
  });

  it('is made with wake off when too deep, its wake_set saying so', () => {
    const task = newTask(h.db, { wake: { by: ALICE, depth: 5, tooDeep: true } });
    expect(task).toMatchObject({ wakeBy: null, wakeDepth: 5 });
    expect(wakeSets(task.taskId)).toEqual([{ actor: ALICE, payload: { on: false, refused: 'too_deep', depth: 5 } }]);
  });
});

describe("a run's follow-up", () => {
  it("inherits its creating task's wake and depth, its wake_set by the run, from that task", () => {
    const parent = newTask(h.db, { wake: { by: ALICE, depth: 2 } });
    const run = claimed(h.db, parent.taskId);
    const r = createTask(h.db, { title: 'a follow-up', createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } }, NOW + 1);
    if (!r.ok) throw new Error(r.message);
    expect(r.task).toMatchObject({ wakeBy: ALICE, wakeDepth: 2 });
    expect(wakeSets(r.task.taskId)).toEqual([{ actor: `run:${run.runId}`, payload: { on: true, as: ALICE, depth: 2, from: parent.taskId } }]);
  });

  it('inherits wake off, and its depth, with no wake_set', () => {
    const parent = newTask(h.db, { wake: { by: null, depth: 1 } });
    const child = followUp(parent.taskId);
    expect(getTask(h.db, child)).toMatchObject({ wakeBy: null, wakeDepth: 1 });
    expect(wakeSets(child)).toEqual([]);
  });

  it('takes the inherited wake whatever the run asked for', () => {
    const parent = newTask(h.db);
    const child = followUp(parent.taskId, { wake: { by: 'lark:on_mallory', depth: 0 } });
    expect(getTask(h.db, child)).toMatchObject({ wakeBy: null, wakeDepth: 0 });
    expect(wakeSets(child)).toEqual([]);
  });

  it('starts its wake cursor at 0, as its every event is new', () => {
    const parent = newTask(h.db, { wake: { by: ALICE, depth: 0 } });
    const child = followUp(parent.taskId);
    const cursors = h.db.prepare<[string], { wake_cursor: number }>('SELECT wake_cursor FROM kanban_subscriptions WHERE task_id = ?').all(child);
    expect(cursors).toEqual([{ wake_cursor: 0 }]);
  });
});
