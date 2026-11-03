import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { link } from '../src/db/kanban.js';
import { eventsOf, parentsOf, taskView } from '../src/db/kanban-read.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, claimed, newTask } from './helpers/kanban.js';

let h: TestDb;

beforeEach(() => {
  h = testDb();
});

afterEach(() => h.close());

describe('link', () => {
  it('makes a parent hold its child back, and records it on the child', () => {
    const parent = newTask(h.db);
    const child = newTask(h.db);
    expect(link(h.db, parent.taskId, child.taskId, ALICE, NOW)).toEqual({ ok: true, added: true });
    expect(parentsOf(h.db, child.taskId).map((t) => t.taskId)).toEqual([parent.taskId]);
    expect(taskView(h.db, child.taskId)?.status).toBe('todo');
    expect(eventsOf(h.db, child.taskId).at(-1)).toMatchObject({
      kind: 'linked',
      actor: ALICE,
      payload: { parentId: parent.taskId },
    });
  });

  it('changes nothing when the pair is already linked', () => {
    const parent = newTask(h.db);
    const child = newTask(h.db, { parents: [parent.taskId] });
    expect(link(h.db, parent.taskId, child.taskId, ALICE, NOW)).toEqual({ ok: true, added: false });
    expect(eventsOf(h.db, child.taskId).map((e) => e.kind)).toEqual(['created']);
  });

  it('refuses a cycle, however long, and a task as its own parent', () => {
    const a = newTask(h.db);
    const b = newTask(h.db, { parents: [a.taskId] });
    const c = newTask(h.db, { parents: [b.taskId] });
    expect(link(h.db, c.taskId, a.taskId, ALICE, NOW)).toEqual({
      ok: false,
      code: 'cycle',
      message: `task ${a.taskId} is already upstream of ${c.taskId}; the link would make a cycle`,
    });
    expect(link(h.db, a.taskId, a.taskId, ALICE, NOW)).toMatchObject({ ok: false, code: 'cycle' });
    expect(parentsOf(h.db, a.taskId)).toEqual([]);
  });

  it('refuses a link onto a task with an open run', () => {
    const parent = newTask(h.db);
    const child = newTask(h.db);
    const run = claimed(h.db, child.taskId);
    expect(link(h.db, parent.taskId, child.taskId, ALICE, NOW)).toEqual({
      ok: false,
      code: 'run_open',
      message: `task ${child.taskId} has an open run, ${run.runId}; a parent added now could not hold it back`,
    });
  });

  it('refuses an unknown task on either side', () => {
    const task = newTask(h.db);
    expect(link(h.db, 'k_missing', task.taskId, ALICE, NOW)).toEqual({
      ok: false,
      code: 'not_found',
      message: 'no task k_missing',
    });
    expect(link(h.db, task.taskId, 'k_missing', ALICE, NOW)).toMatchObject({ ok: false, code: 'not_found' });
  });
});
