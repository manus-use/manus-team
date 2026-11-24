import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advanceWake, recordWake, setWake, wakeSubmitted } from '../src/db/kanban.js';
import { eventsOf, lastWokeOf, subscriptionsOf, wakeOfShell, wakesInLastHour, wokenUnblocksSince } from '../src/db/kanban-read.js';
import { createSession } from '../src/db/sessions.js';
import { createTurn, endTurn, setTurnState } from '../src/db/turns.js';
import type { TaskRow } from '../src/kanban/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, newTask } from './helpers/kanban.js';

/**
 * The waker's and the woken shell's other reads (wake spec §5.4, §9.1, §9.2,
 * §10): the delivered wakes of a conversation in the last hour, a session's
 * running woken turn, a task's last wake, and its woken unblocks since it last
 * completed.
 */

const APP = 'cli_app';
const AT = { channel: 'lark', appId: APP, conversationId: 'oc_chat', threadId: 'omt_1' };
const HOUR = 60 * 60_000;

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

function woken(): TaskRow {
  const task = newTask(h.db, { createdVia: { kind: 'chat', ...AT, rootId: 'om_root' } });
  setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5 }, ALICE, APP, NOW);
  return task;
}

function event(taskId: string, kind: string, payload: Record<string, unknown> = {}): number {
  h.db.prepare('INSERT INTO kanban_events (task_id, kind, actor, payload, created_at) VALUES (?, ?, ?, jsonb(?), ?)').run(taskId, kind, ALICE, JSON.stringify(payload), NOW);
  return eventsOf(h.db, taskId).at(-1)?.id ?? 0;
}

let uuids = 0;
function wake(task: TaskRow, opts: { at?: Partial<typeof AT>; deliveredAt?: number; session?: [string, string] } = {}): number {
  uuids += 1;
  const sub = subscriptionsOf(h.db, task.taskId)[0]?.id ?? 0;
  const r = recordWake(
    h.db,
    { uuid: `u${uuids}`, ...AT, ...opts.at, principal: ALICE, depth: 0, events: [{ subscriptionId: sub, eventId: event(task.taskId, 'completed'), taskId: task.taskId }] },
    NOW,
  );
  if (!r.ok) throw new Error(r.message);
  if (opts.session !== undefined) wakeSubmitted(h.db, r.wake.wakeId, opts.session[0], opts.session[1], 'boot');
  if (opts.deliveredAt !== undefined) advanceWake(h.db, r.wake.wakeId, opts.deliveredAt);
  return r.wake.wakeId;
}

describe('wakesInLastHour', () => {
  it("gives the delivery times of the conversation's wakes in the hour before now, oldest first", () => {
    const task = woken();
    const now = NOW + 2 * HOUR;
    wake(task, { deliveredAt: now - HOUR - 1 });
    wake(task, { deliveredAt: now - 30 * 60_000 });
    wake(task, { deliveredAt: now - 10 * 60_000 });
    wake(task);
    wake(task, { at: { threadId: 'omt_2' }, deliveredAt: now - 60_000 });
    expect(wakesInLastHour(h.db, AT, now)).toEqual([now - 30 * 60_000, now - 10 * 60_000]);
  });
});

describe('wakeOfShell', () => {
  it("answers the delivered wake of the session's running turn, and none for a typed turn or between turns", () => {
    createSession(h.db, { id: 's_1', agentId: 'default', workspaceId: 'default', ownerPrincipal: ALICE }, NOW);
    const task = woken();
    const id = wake(task, { session: ['s_1', 'key-wake'], deliveredAt: NOW + 1 });
    expect(wakeOfShell(h.db, 's_1')).toBeUndefined();
    createTurn(h.db, { sessionId: 's_1', turnId: 't_1', generation: 0, idempotencyKey: 'key-wake' }, NOW);
    // Pending: not yet running.
    expect(wakeOfShell(h.db, 's_1')).toBeUndefined();
    setTurnState(h.db, 's_1', 't_1', 'running');
    expect(wakeOfShell(h.db, 's_1')).toMatchObject({ wakeId: id, state: 'delivered' });
    endTurn(h.db, 's_1', 't_1', 'completed', NOW + 2);
    expect(wakeOfShell(h.db, 's_1')).toBeUndefined();
    createTurn(h.db, { sessionId: 's_1', turnId: 't_2', generation: 0, idempotencyKey: 'key-typed' }, NOW + 3);
    setTurnState(h.db, 's_1', 't_2', 'running');
    expect(wakeOfShell(h.db, 's_1')).toBeUndefined();
  });

  it('answers none for a wake still pending', () => {
    createSession(h.db, { id: 's_1', agentId: 'default', workspaceId: 'default', ownerPrincipal: ALICE }, NOW);
    wake(woken(), { session: ['s_1', 'key-wake'] });
    createTurn(h.db, { sessionId: 's_1', turnId: 't_1', generation: 0, idempotencyKey: 'key-wake' }, NOW);
    setTurnState(h.db, 's_1', 't_1', 'running');
    expect(wakeOfShell(h.db, 's_1')).toBeUndefined();
  });
});

describe('lastWokeOf', () => {
  it("gives when the task's latest delivered wake was delivered, or none", () => {
    const task = woken();
    expect(lastWokeOf(h.db, task.taskId)).toBeUndefined();
    wake(task, { deliveredAt: NOW + 10 });
    wake(task, { deliveredAt: NOW + 20 });
    wake(task);
    expect(lastWokeOf(h.db, task.taskId)).toBe(NOW + 20);
    expect(lastWokeOf(h.db, woken().taskId)).toBeUndefined();
  });
});

describe('wokenUnblocksSince', () => {
  it('counts the woken unblocks since the task last completed, or since it was made', () => {
    const task = woken();
    expect(wokenUnblocksSince(h.db, task.taskId)).toBe(0);
    event(task.taskId, 'unblocked', { kind: 'needs_input', wake: 1 });
    event(task.taskId, 'unblocked', { kind: 'needs_input' });
    event(task.taskId, 'unblocked', { kind: 'capability', wake: 2 });
    expect(wokenUnblocksSince(h.db, task.taskId)).toBe(2);
    event(task.taskId, 'completed', {});
    expect(wokenUnblocksSince(h.db, task.taskId)).toBe(0);
    event(task.taskId, 'unblocked', { kind: 'needs_input', wake: 3 });
    expect(wokenUnblocksSince(h.db, task.taskId)).toBe(1);
  });
});
