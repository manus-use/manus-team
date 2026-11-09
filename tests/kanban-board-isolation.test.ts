import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveBoard, block, createBoard, createTask, link } from '../src/db/kanban.js';
import { boardList, eventsOf, getRun, getTask, parentsOf } from '../src/db/kanban-read.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed, newTask } from './helpers/kanban.js';

/**
 * A board's tasks stay on it (spec §16): a parent and its child are on one
 * board, whether linked at creation, by a link, or by a dependency block; and a
 * task a run creates goes on its run's task's board.
 */

let h: TestDb;

beforeEach(() => {
  h = testDb();
  for (const name of ['web-app', 'billing']) {
    const r = createBoard(h.db, name, ALICE, NOW);
    if (!r.ok) throw new Error(r.message);
  }
});

afterEach(() => h.close());

function taskCount(): number {
  return h.db.prepare<[], { n: number }>('SELECT count(*) AS n FROM kanban_tasks').get()?.n ?? -1;
}

describe('creating a task on a board', () => {
  it('puts it on the board given, and refuses one that does not exist or is archived, writing nothing', () => {
    const made = newTask(h.db, { board: 'web-app' });
    expect(made.board).toBe('web-app');
    // Its created event records the board, as it records the workspace.
    expect(eventsOf(h.db, made.taskId)[0]?.payload).toMatchObject({ board: 'web-app' });
    const before = taskCount();
    expect(createTask(h.db, { title: 'x', board: 'nowhere', createdBy: ALICE, createdVia: VIA }, NOW)).toMatchObject({
      ok: false,
      code: 'unknown_board',
    });
    const old = createBoard(h.db, 'old', ALICE, NOW);
    expect(old.ok && archiveBoard(h.db, 'old', ALICE, NOW).ok).toBe(true);
    const r = createTask(h.db, { title: 'x', board: 'old', createdBy: ALICE, createdVia: VIA }, NOW);
    expect(r).toMatchObject({ ok: false, code: 'board_archived' });
    expect(r.ok ? '' : r.message).toBe('board old is archived; no task is added to it');
    expect(taskCount()).toBe(before);
  });

  it('refuses a parent on another board, writing nothing', () => {
    const parent = newTask(h.db, { board: 'web-app' });
    const before = taskCount();
    const r = createTask(
      h.db,
      { title: 'child', board: 'billing', parents: [parent.taskId], createdBy: ALICE, createdVia: VIA },
      NOW,
    );
    expect(r).toMatchObject({ ok: false, code: 'other_board' });
    expect(r.ok ? '' : r.message).toBe(
      `task ${parent.taskId} is on board web-app, not billing: a task and its parents are on one board`,
    );
    expect(taskCount()).toBe(before);
    expect(newTask(h.db, { board: 'web-app', parents: [parent.taskId] }).board).toBe('web-app');
  });

  it('refuses a key a task on another board was created with, and returns that task on its own board', () => {
    const first = newTask(h.db, { board: 'web-app', idempotencyKey: 'lark:om_1' });
    const before = taskCount();
    const again = createTask(h.db, { title: 'x', board: 'billing', idempotencyKey: 'lark:om_1', createdBy: ALICE, createdVia: VIA }, NOW);
    expect(again).toMatchObject({ ok: false, code: 'other_board' });
    expect(again.ok ? '' : again.message).toBe(
      `task ${first.taskId} was created with this idempotency key on board web-app, not billing`,
    );
    expect(createTask(h.db, { title: 'x', board: 'web-app', idempotencyKey: 'lark:om_1', createdBy: ALICE, createdVia: VIA }, NOW)).toMatchObject({
      ok: true,
      existing: true,
      task: { taskId: first.taskId },
    });
    expect(taskCount()).toBe(before);
  });

  it("puts a task a run creates on its run's task's board, whatever it asks for", () => {
    const task = newTask(h.db, { board: 'web-app' });
    const run = claimed(h.db, task.taskId);
    const r = createTask(
      h.db,
      { title: 'follow-up', board: 'billing', createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } },
      NOW,
    );
    expect(r).toMatchObject({ ok: true, task: { board: 'web-app', createdFromTask: task.taskId } });
  });
});

describe('links across boards', () => {
  it('refuses a link between tasks on two boards, and makes one on a board', () => {
    const web = newTask(h.db, { board: 'web-app' });
    const billing = newTask(h.db, { board: 'billing' });
    const r = link(h.db, web.taskId, billing.taskId, ALICE, NOW);
    expect(r).toMatchObject({ ok: false, code: 'other_board' });
    expect(link(h.db, billing.taskId, web.taskId, ALICE, NOW)).toMatchObject({ ok: false, code: 'other_board' });
    expect(parentsOf(h.db, billing.taskId)).toEqual([]);
    const next = newTask(h.db, { board: 'web-app' });
    expect(link(h.db, web.taskId, next.taskId, ALICE, NOW)).toEqual({ ok: true, added: true });
  });

  it("refuses a dependency block naming a task on another board, and leaves the run undecided", () => {
    const task = newTask(h.db, { board: 'web-app' });
    const elsewhere = newTask(h.db, { board: 'billing' });
    const run = claimed(h.db, task.taskId);
    const r = block(
      h.db,
      task.taskId,
      { kind: 'run', runId: run.runId },
      { kind: 'dependency', reason: 'needs billing first', parents: [elsewhere.taskId] },
      NOW,
    );
    expect(r).toMatchObject({ ok: false, code: 'other_board' });
    expect(getRun(h.db, run.runId)?.outcome).toBeNull();
    expect(getTask(h.db, task.taskId)?.phase).toBe('open');
  });
});

describe('a board’s list', () => {
  it('holds only its own tasks, and every task without a board given', () => {
    const a = newTask(h.db, { title: 'on default' });
    const b = newTask(h.db, { title: 'on web-app', board: 'web-app' });
    expect(boardList(h.db, 'web-app').map((e) => e.task.taskId)).toEqual([b.taskId]);
    expect(boardList(h.db, 'default').map((e) => e.task.taskId)).toEqual([a.taskId]);
    expect(boardList(h.db, 'billing')).toEqual([]);
    expect(boardList(h.db).map((e) => e.task.taskId)).toEqual([a.taskId, b.taskId]);
  });
});
