import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setWake } from '../src/db/kanban.js';
import { eventsOf, getTask } from '../src/db/kanban-read.js';
import { renderNotice } from '../src/kanban/chat-render.js';
import type { KanbanEvent } from '../src/kanban/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, newTask } from './helpers/kanban.js';

/**
 * The too-deep notice (wake spec §3.4, §4.4): a `wake_set` refused as too deep
 * is a notice in the task's thread, or at chat scope, with §3.4's line; every
 * other `wake_set` is no notice, as the command's answer says it.
 */

const OPTS = { blockRecurrenceLimit: 3 };

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

function lastWakeSet(taskId: string): KanbanEvent {
  const e = eventsOf(h.db, taskId).filter((x) => x.kind === 'wake_set').at(-1);
  if (e === undefined) throw new Error('no wake_set');
  return e;
}

describe('renderNotice of wake_set', () => {
  it("says a task too deep stays notice-only, in a thread and at chat scope alike", () => {
    const task = newTask(h.db, { wake: { by: ALICE, depth: 5, tooDeep: true } });
    const line = `\`${task.taskId}\` is 5 tasks deep in woken turns, so it stays notice-only`;
    const t = getTask(h.db, task.taskId);
    if (t === undefined) throw new Error('gone');
    expect(renderNotice(lastWakeSet(task.taskId), t, { ...OPTS, where: 'thread' })).toBe(line);
    expect(renderNotice(lastWakeSet(task.taskId), t, { ...OPTS, where: 'chat' })).toBe(line);
  });

  it("says it for an existing task's wake refused as too deep", () => {
    const task = newTask(h.db, { wake: { by: null, depth: 6 } });
    setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5 }, ALICE, 'cli_app', NOW);
    const t = getTask(h.db, task.taskId);
    if (t === undefined) throw new Error('gone');
    expect(renderNotice(lastWakeSet(task.taskId), t, OPTS)).toBe(`\`${task.taskId}\` is 6 tasks deep in woken turns, so it stays notice-only`);
  });

  it('is no notice for a wake turned on, off, or inherited', () => {
    const task = newTask(h.db, { wake: { by: ALICE, depth: 0 } });
    const t = () => {
      const r = getTask(h.db, task.taskId);
      if (r === undefined) throw new Error('gone');
      return r;
    };
    expect(renderNotice(lastWakeSet(task.taskId), t(), OPTS)).toBeUndefined();
    setWake(h.db, task.taskId, { on: false }, ALICE, 'cli_app', NOW);
    expect(renderNotice(lastWakeSet(task.taskId), t(), OPTS)).toBeUndefined();
    const inherited: KanbanEvent = { ...lastWakeSet(task.taskId), actor: 'run:r_1', payload: { on: true, as: ALICE, depth: 0, from: 'k_x' } };
    expect(renderNotice(inherited, t(), OPTS)).toBeUndefined();
  });
});
