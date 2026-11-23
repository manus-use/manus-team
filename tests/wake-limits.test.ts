import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replyUuid, wakeBatchUuid } from '../src/core/ids.js';
import { setWake } from '../src/db/kanban.js';
import { subscriptionsOf } from '../src/db/kanban-read.js';
import { createTurn, endTurn } from '../src/db/turns.js';
import { ROUND_MARKER_MS, ROUND_WAKES, wakeTime } from '../src/kanban/waker.js';
import type { TaskRow } from '../src/kanban/types.js';
import { ALICE, NOW, newTask } from './helpers/kanban.js';
import { APP, BOB, IN_THREAD, THREAD_KEY, wakeHarness, type WakeHarness } from './helpers/waker.js';

/**
 * The waker's limits (wake spec §5.4, §5.2 step 6, §5.5 steps 1, 3 and 5): a
 * busy session waits, by an open turn or a queued actor, at the first look and
 * again after the marker; the per-hour cap, with its line once; at most
 * `ROUND_WAKES` submits a round; and the round's marker budget.
 */

let h: WakeHarness;
beforeEach(() => {
  h = wakeHarness();
});
afterEach(() => {
  h.waker.stop();
  h.t.close();
});

const HOUR = 60 * 60_000;

function completed(task: TaskRow, summary = 'Booked.'): number {
  return h.event(task, 'completed', 'run:r_1', { summary });
}

function session(): string {
  return h.registry.bindOrCreate(THREAD_KEY, { openId: 'ou_alice', unionId: 'on_alice', displayName: null }).session.id;
}

describe('a busy session', () => {
  it('waits while the session has an open turn: nothing recorded, nothing moved, until it is idle', async () => {
    const task = h.woken();
    completed(task);
    const id = session();
    createTurn(h.db, { sessionId: id, turnId: 't_typed', generation: 0, idempotencyKey: 'k_typed' }, NOW);
    expect(await h.round()).toBe(0);
    expect(h.wakes()).toEqual([]);
    expect(h.lark.texts).toEqual([]);
    expect(subscriptionsOf(h.db, task.taskId)[0]?.wakeCursor).toBeLessThan(subscriptionsOf(h.db, task.taskId)[0]?.cursor ?? 0);
    endTurn(h.db, id, 't_typed', 'completed', NOW);
    expect(await h.round()).toBe(1);
    expect(h.wakes()[0]?.state).toBe('delivered');
  });

  it("waits while the session's live actor has anything queued", async () => {
    const task = h.woken();
    completed(task);
    const actor = h.registry.actor(session());
    actor.queued = 1;
    expect(await h.round()).toBe(0);
    expect(h.wakes()).toEqual([]);
    actor.queued = 0;
    expect(await h.round()).toBe(1);
  });

  it('busy again after the marker: the row stays pending with its marker sent, and the next round submits it without a second marker', async () => {
    const task = h.woken();
    completed(task);
    const actor = h.registry.actor(session());
    const actorFor = h.registry.actorFor.bind(h.registry);
    let first = true;
    h.registry.actorFor = async (sessionId, key) => {
      const a = await actorFor(sessionId, key);
      // A person's message arrives while the marker is sent and the actor is built.
      if (first) a.queued = 1;
      first = false;
      return a;
    };
    expect(await h.round()).toBe(0);
    expect(h.wakes()[0]).toMatchObject({ state: 'pending', markerAt: NOW, sessionId: null });
    expect(actor.submits).toEqual([]);
    actor.queued = 0;
    expect(await h.round()).toBe(1);
    expect(actor.submits).toHaveLength(1);
    expect(h.lark.texts.map((t) => t.text)).toEqual(['Waking the agent for 1 board update.']);
  });
});

describe('the per-hour cap', () => {
  it('lets six wake a conversation in an hour, pauses the seventh with its line once, and wakes when the oldest turns an hour old', async () => {
    const task = h.woken();
    for (let i = 0; i < 6; i += 1) {
      completed(task, `outcome ${i}`);
      expect(await h.round()).toBe(1);
      await h.clock.delay(60_000);
    }
    completed(task, 'seventh');
    expect(await h.round()).toBe(0);
    completed(task, 'eighth');
    expect(await h.round()).toBe(0);
    const until = NOW + HOUR;
    const paused = h.lark.texts.filter((t) => t.text.startsWith('wakes are paused'));
    expect(paused).toEqual([
      {
        target: { chatId: 'oc_chat', threadId: 'omt_1', root: 'om_root' },
        text: `wakes are paused here until ${wakeTime('UTC', until, h.clock.now())}: 6 this hour`,
        uuid: replyUuid(APP, `wake-cap:lark\u0000${APP}\u0000oc_chat\u0000omt_1`, String(until)),
      },
    ]);
    expect(paused[0]?.text).toBe('wakes are paused here until 09:53: 6 this hour');
    await h.clock.delay(until - h.clock.now() + 1);
    expect(await h.round()).toBe(1);
    const last = h.registry.submits.at(-1)?.input.text ?? '';
    expect(last).toContain('seventh');
    expect(last).toContain('eighth');
  });

  it('counts every principal together, and another conversation not at all', async () => {
    const alices = h.woken(ALICE);
    const bobs = h.woken(BOB);
    for (let i = 0; i < 3; i += 1) {
      completed(alices, `alice ${i}`);
      expect(await h.round()).toBe(1);
      completed(bobs, `bob ${i}`);
      expect(await h.round()).toBe(1);
    }
    expect(h.wakes().map((w) => w.principal)).toEqual([ALICE, BOB, ALICE, BOB, ALICE, BOB]);
    const other = newTask(h.db, { createdVia: { ...IN_THREAD, threadId: 'omt_2', rootId: 'om_root2' } });
    setWake(h.db, other.taskId, { on: true, as: ALICE, maxDepth: 5 }, ALICE, APP, NOW);
    completed(other);
    completed(alices, 'held');
    expect(await h.round()).toBe(1);
    expect(h.wakes().at(-1)?.threadId).toBe('omt_2');
    expect(h.wakes().filter((w) => w.threadId === 'omt_1')).toHaveLength(6);
  });

  it('says its line again once a wake is delivered there after the pause, and the cap is reached again', async () => {
    const task = h.woken();
    for (let i = 0; i < 6; i += 1) {
      completed(task, `outcome ${i}`);
      await h.round();
    }
    completed(task, 'over');
    await h.round();
    await h.round();
    expect(h.lark.texts.filter((t) => t.text.startsWith('wakes are paused'))).toHaveLength(1);
    await h.clock.delay(HOUR + 1);
    expect(await h.round()).toBe(1);
    for (let i = 0; i < 5; i += 1) {
      completed(task, `again ${i}`);
      expect(await h.round()).toBe(1);
    }
    completed(task, 'over again');
    expect(await h.round()).toBe(0);
    const paused = h.lark.texts.filter((t) => t.text.startsWith('wakes are paused'));
    expect(paused).toHaveLength(2);
    expect(paused[1]?.uuid).not.toBe(paused[0]?.uuid);
  });

  it('says its time as MM-DD HH:MM on another day', () => {
    expect(wakeTime('UTC', Date.UTC(2026, 10, 20, 15, 40), Date.UTC(2026, 10, 20, 9, 0))).toBe('15:40');
    expect(wakeTime('UTC', Date.UTC(2026, 10, 21, 0, 10), Date.UTC(2026, 10, 20, 23, 30))).toBe('11-21 00:10');
    expect(wakeTime('Asia/Shanghai', Date.UTC(2026, 10, 20, 16, 10), Date.UTC(2026, 10, 20, 15, 30))).toBe('11-21 00:10');
  });
});

describe('a round', () => {
  it(`submits at most ROUND_WAKES (${ROUND_WAKES}), the longest waiting first, and the rest in the next round`, async () => {
    const tasks: TaskRow[] = [];
    for (let i = 0; i < 7; i += 1) {
      const t = newTask(h.db, { createdVia: { ...IN_THREAD, threadId: `omt_r${i}`, rootId: `om_r${i}` } });
      setWake(h.db, t.taskId, { on: true, as: ALICE, maxDepth: 5 }, ALICE, APP, NOW);
      tasks.push(t);
    }
    for (const t of tasks) completed(t);
    expect(await h.round()).toBe(5);
    expect(h.wakes().map((w) => w.threadId)).toEqual(['omt_r0', 'omt_r1', 'omt_r2', 'omt_r3', 'omt_r4']);
    expect(await h.round()).toBe(2);
  });

  it('takes the longest waiting first by its oldest event, not by the order its thread was made', async () => {
    const tasks: TaskRow[] = [];
    for (let i = 0; i < 6; i += 1) {
      const t = newTask(h.db, { createdVia: { ...IN_THREAD, threadId: `omt_o${i}`, rootId: `om_o${i}` } });
      setWake(h.db, t.taskId, { on: true, as: ALICE, maxDepth: 5 }, ALICE, APP, NOW);
      tasks.push(t);
    }
    // The thread made last has the oldest outcome, the one made first the newest.
    for (const t of [...tasks].reverse()) completed(t);
    expect(await h.round()).toBe(5);
    expect(h.wakes().map((w) => w.threadId)).toEqual(['omt_o5', 'omt_o4', 'omt_o3', 'omt_o2', 'omt_o1']);
    expect(await h.round()).toBe(1);
    expect(h.wakes().at(-1)?.threadId).toBe('omt_o0');
  });

  it('gives its ROUND_WAKES to the pending rows first, and a new batch waits for the next round', async () => {
    const pending: TaskRow[] = [];
    for (let i = 0; i < 6; i += 1) {
      const t = newTask(h.db, { createdVia: { ...IN_THREAD, threadId: `omt_p${i}`, rootId: `om_p${i}` } });
      setWake(h.db, t.taskId, { on: true, as: ALICE, maxDepth: 5 }, ALICE, APP, NOW);
      pending.push(t);
    }
    const fresh = newTask(h.db, { createdVia: { ...IN_THREAD, threadId: 'omt_new', rootId: 'om_new' } });
    setWake(h.db, fresh.taskId, { on: true, as: ALICE, maxDepth: 5 }, ALICE, APP, NOW);
    for (const [i, t] of pending.entries()) {
      const event = completed(t);
      const sub = subscriptionsOf(h.db, t.taskId)[0];
      const r = h.service.recordWake({
        uuid: wakeBatchUuid(APP, [[sub?.id ?? 0, event]]),
        channel: 'lark',
        appId: APP,
        conversationId: 'oc_chat',
        threadId: `omt_p${i}`,
        principal: ALICE,
        depth: 0,
        events: [{ subscriptionId: sub?.id ?? 0, eventId: event, taskId: t.taskId }],
      });
      expect(r.ok).toBe(true);
    }
    completed(fresh);
    await h.clock.delay(3_000);
    expect(await h.round()).toBe(5);
    expect(h.wakes().filter((w) => w.state === 'delivered').map((w) => w.threadId)).toEqual(['omt_p0', 'omt_p1', 'omt_p2', 'omt_p3', 'omt_p4']);
    expect(h.wakes().some((w) => w.threadId === 'omt_new')).toBe(false);
    expect(await h.round()).toBe(2);
    expect(h.wakes().at(-1)?.threadId).toBe('omt_new');
  });

  it(`starts no marker once ROUND_MARKER_MS (${ROUND_MARKER_MS} ms) is spent, leaving that batch unrecorded for the next round`, async () => {
    const send = h.lark.sendText.bind(h.lark);
    h.lark.sendText = async (...args: Parameters<typeof send>) => {
      await h.clock.delay(20_000);
      return send(...args);
    };
    for (let i = 0; i < 3; i += 1) {
      const t = newTask(h.db, { createdVia: { ...IN_THREAD, threadId: `omt_m${i}`, rootId: `om_m${i}` } });
      setWake(h.db, t.taskId, { on: true, as: ALICE, maxDepth: 5 }, ALICE, APP, NOW);
      completed(t);
    }
    expect(await h.round()).toBe(2);
    expect(h.wakes().map((w) => w.threadId)).toEqual(['omt_m0', 'omt_m1']);
    expect(await h.round()).toBe(1);
    expect(h.wakes().map((w) => w.threadId)).toEqual(['omt_m0', 'omt_m1', 'omt_m2']);
  });
});
