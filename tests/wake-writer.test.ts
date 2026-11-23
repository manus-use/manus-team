import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  advanceWake,
  dropWake,
  liftedWake,
  passWake,
  recordWake,
  setWake,
  wakeMarked,
  wakeRefused,
  wakeSubmitted,
  type NewWakeBatch,
} from '../src/db/kanban.js';
import { eventsOf, getWake, subscriptionsOf, wakeEventsOf } from '../src/db/kanban-read.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import type { TaskRow } from '../src/kanban/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, newTask } from './helpers/kanban.js';

/**
 * The wake rows' writers (wake spec §4.2, §4.3): a batch recorded with its
 * events in one transaction, its marker once, its attempt stamped and refused,
 * and settled once, delivered, dropped or lifted, each settling write moving the
 * subscriptions' `wake_cursor` forward only, and acting only on a pending row.
 */

const APP = 'cli_app';

let h: TestDb;
beforeEach(() => {
  clearSecrets();
  h = testDb();
});
afterEach(() => {
  clearSecrets();
  h.close();
});

function wokenTask(): { task: TaskRow; sub: number; events: number[] } {
  const task = newTask(h.db);
  setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5 }, ALICE, APP, NOW);
  const sub = subscriptionsOf(h.db, task.taskId)[0]?.id ?? 0;
  return { task, sub, events: eventsOf(h.db, task.taskId).map((e) => e.id) };
}

function batch(pairs: Array<{ subscriptionId: number; eventId: number; taskId: string }>, uuid = 'w-uuid-1'): NewWakeBatch {
  return { uuid, channel: 'lark', appId: APP, conversationId: 'oc_chat', threadId: 'omt_1', principal: ALICE, depth: 0, events: pairs };
}

function cursor(sub: number): number {
  return h.db.prepare<[number], { wake_cursor: number }>('SELECT wake_cursor FROM kanban_subscriptions WHERE id = ?').get(sub)?.wake_cursor ?? -1;
}

describe('recordWake', () => {
  it('writes the row pending at attempt 1, with its events, in one transaction', () => {
    const a = wokenTask();
    const r = recordWake(h.db, batch(a.events.map((eventId) => ({ subscriptionId: a.sub, eventId, taskId: a.task.taskId }))), NOW);
    if (!r.ok) throw new Error(r.message);
    expect(r.existing).toBe(false);
    expect(r.wake).toMatchObject({
      uuid: 'w-uuid-1',
      conversationId: 'oc_chat',
      threadId: 'omt_1',
      principal: ALICE,
      depth: 0,
      state: 'pending',
      attempt: 1,
      sessionId: null,
      turnKey: null,
      submitBoot: null,
      markerAt: null,
      createdAt: NOW,
      targetRole: null,
    });
    expect(wakeEventsOf(h.db, r.wake.wakeId).map((e) => e.eventId)).toEqual(a.events);
  });

  it('answers the row already recorded for its uuid, and writes nothing more', () => {
    const a = wokenTask();
    const pairs = [{ subscriptionId: a.sub, eventId: a.events[0] ?? 0, taskId: a.task.taskId }];
    const first = recordWake(h.db, batch(pairs), NOW);
    const again = recordWake(h.db, batch(pairs), NOW + 1);
    expect(again).toMatchObject({ ok: true, existing: true, wake: { wakeId: first.ok ? first.wake.wakeId : -1 } });
    expect(h.db.prepare('SELECT count(*) AS n FROM kanban_wakes').get()).toEqual({ n: 1 });
  });

  it('refuses a batch with no events', () => {
    expect(recordWake(h.db, batch([]), NOW)).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe("a pending row's attempt", () => {
  it('marks the marker once', () => {
    const a = wokenTask();
    const r = recordWake(h.db, batch([{ subscriptionId: a.sub, eventId: a.events[0] ?? 0, taskId: a.task.taskId }]), NOW);
    if (!r.ok) throw new Error(r.message);
    expect(wakeMarked(h.db, r.wake.wakeId, NOW + 1)).toEqual({ ok: true, marked: true });
    expect(wakeMarked(h.db, r.wake.wakeId, NOW + 2)).toEqual({ ok: true, marked: false });
    expect(getWake(h.db, r.wake.wakeId)?.markerAt).toBe(NOW + 1);
  });

  it('is stamped with its session, key and boot, and a refusal clears all three, adds one to the attempt and keeps the reason, masked and cut', () => {
    addSecrets(['sk-secret-123456']);
    const a = wokenTask();
    const r = recordWake(h.db, batch([{ subscriptionId: a.sub, eventId: a.events[0] ?? 0, taskId: a.task.taskId }]), NOW);
    if (!r.ok) throw new Error(r.message);
    const id = r.wake.wakeId;
    expect(wakeSubmitted(h.db, id, 's_one', 'key-1', 'boot-a')).toEqual({ ok: true, submitted: true });
    expect(getWake(h.db, id)).toMatchObject({ sessionId: 's_one', turnKey: 'key-1', submitBoot: 'boot-a', attempt: 1 });
    expect(wakeRefused(h.db, id, `session s_one is closed sk-secret-123456 ${'x'.repeat(600)}`)).toEqual({ ok: true, refused: true, attempt: 2 });
    const row = getWake(h.db, id);
    expect(row).toMatchObject({ sessionId: null, turnKey: null, submitBoot: null, attempt: 2, state: 'pending' });
    expect(row?.error?.startsWith(`session s_one is closed ${MASK}`)).toBe(true);
    expect(row?.error?.length).toBeLessThanOrEqual(500);
    // A refusal moves no cursor.
    expect(cursor(a.sub)).toBe(a.events.at(-1));
  });
});

describe('settling a wake', () => {
  function recorded(): { a: ReturnType<typeof wokenTask>; b: ReturnType<typeof wokenTask>; id: number } {
    const a = wokenTask();
    const b = wokenTask();
    // Each task's events past its cursor: two comments each.
    for (const t of [a, b]) {
      for (let i = 0; i < 2; i += 1) {
        h.db.prepare("INSERT INTO kanban_events (task_id, kind, actor, payload, created_at) VALUES (?, 'commented', ?, jsonb('{}'), ?)").run(t.task.taskId, ALICE, NOW);
      }
      t.events = eventsOf(h.db, t.task.taskId).map((e) => e.id);
    }
    const pairs = [a, b].flatMap((t) => t.events.slice(-2).map((eventId) => ({ subscriptionId: t.sub, eventId, taskId: t.task.taskId })));
    const r = recordWake(h.db, batch(pairs), NOW);
    if (!r.ok) throw new Error(r.message);
    return { a, b, id: r.wake.wakeId };
  }

  it('delivered moves each subscription to the last event the batch covered, once', () => {
    const { a, b, id } = recorded();
    expect(advanceWake(h.db, id, NOW + 5)).toEqual({ ok: true, delivered: true });
    expect(getWake(h.db, id)).toMatchObject({ state: 'delivered', deliveredAt: NOW + 5, closedAt: null });
    expect([cursor(a.sub), cursor(b.sub)]).toEqual([a.events.at(-1), b.events.at(-1)]);
    // A late callback changes nothing.
    expect(advanceWake(h.db, id, NOW + 6)).toEqual({ ok: true, delivered: false });
    expect(dropWake(h.db, id, 'late', NOW + 6)).toEqual({ ok: true, dropped: false });
    expect(wakeRefused(h.db, id, 'late')).toEqual({ ok: true, refused: false, attempt: 1 });
    expect(getWake(h.db, id)).toMatchObject({ state: 'delivered', deliveredAt: NOW + 5, error: null });
  });

  it('dropped moves every cursor past its events and records why', () => {
    const { a, b, id } = recorded();
    expect(dropWake(h.db, id, 'talk tier lost', NOW + 5)).toEqual({ ok: true, dropped: true });
    expect(getWake(h.db, id)).toMatchObject({ state: 'dropped', closedAt: NOW + 5, deliveredAt: null, error: 'talk tier lost' });
    expect([cursor(a.sub), cursor(b.sub)]).toEqual([a.events.at(-1), b.events.at(-1)]);
    expect(advanceWake(h.db, id, NOW + 6)).toEqual({ ok: true, delivered: false });
  });

  it("dropped for some of its tasks moves only those tasks' cursors", () => {
    const { a, b, id } = recorded();
    const before = cursor(b.sub);
    expect(dropWake(h.db, id, 'wake turned off', NOW + 5, { tasks: [a.task.taskId] })).toEqual({ ok: true, dropped: true });
    expect([cursor(a.sub), cursor(b.sub)]).toEqual([a.events.at(-1), before]);
  });

  it('lifted closes the row and moves every cursor past its events', () => {
    const { a, b, id } = recorded();
    expect(liftedWake(h.db, id, NOW + 5)).toEqual({ ok: true, lifted: true });
    expect(getWake(h.db, id)).toMatchObject({ state: 'lifted', closedAt: NOW + 5 });
    expect([cursor(a.sub), cursor(b.sub)]).toEqual([a.events.at(-1), b.events.at(-1)]);
    expect(liftedWake(h.db, id, NOW + 6)).toEqual({ ok: true, lifted: false });
  });

  it('never moves a cursor back', () => {
    const { a, id } = recorded();
    expect(passWake(h.db, a.sub, (a.events.at(-1) ?? 0) + 100)).toEqual({ ok: true, advanced: true });
    advanceWake(h.db, id, NOW + 5);
    expect(cursor(a.sub)).toBe((a.events.at(-1) ?? 0) + 100);
  });

  it('refuses an unknown wake', () => {
    expect(advanceWake(h.db, 999, NOW)).toEqual({ ok: false, code: 'not_found', message: 'no wake 999' });
  });
});

describe('passWake', () => {
  it('moves a cursor forward only, and refuses an unknown subscription', () => {
    const a = wokenTask();
    const at = cursor(a.sub);
    expect(passWake(h.db, a.sub, at + 3)).toEqual({ ok: true, advanced: true });
    expect(passWake(h.db, a.sub, at + 1)).toEqual({ ok: true, advanced: false });
    expect(cursor(a.sub)).toBe(at + 3);
    expect(passWake(h.db, 999, 1)).toEqual({ ok: false, code: 'not_found', message: 'no subscription 999' });
  });
});
