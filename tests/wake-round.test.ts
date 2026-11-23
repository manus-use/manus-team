import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replyUuid } from '../src/core/ids.js';
import { getWake, subscriptionsOf, wakeEventsOf } from '../src/db/kanban-read.js';
import { setWake } from '../src/db/kanban.js';
import { markerText } from '../src/kanban/waker.js';
import { ALICE, NOW, newTask } from './helpers/kanban.js';
import { APP, BOB, IN_THREAD, wakeHarness, type WakeHarness } from './helpers/waker.js';

/**
 * The waker's round, to its marker (wake spec §5.1, §5.2, §5.5 steps 2 and 3,
 * §8): the outcomes past each subscription's wake cursor and at or before its
 * notice cursor, batched by conversation and principal, recorded as a wake
 * row, and marked once, in the thread, before anything reaches the session.
 */

let h: WakeHarness;
beforeEach(() => {
  h = wakeHarness();
});
afterEach(() => {
  h.waker.stop();
  h.t.close();
});

function completed(task: { taskId: string }, summary = 'Booked.', noticed = true): number {
  return h.event(task as never, 'completed', 'run:r_1', { summary }, noticed);
}

describe('a completion with wake on', () => {
  it('is recorded as a wake of the thread, as its setter, and marked once in the thread', async () => {
    const task = h.woken();
    const event = completed(task);
    await h.round();
    const [wake] = h.wakes();
    expect(wake).toMatchObject({ principal: ALICE, depth: 0, attempt: 1, conversationId: 'oc_chat', threadId: 'omt_1', markerAt: NOW });
    expect(wakeEventsOf(h.db, wake?.wakeId ?? 0).map((e) => e.eventId)).toEqual([event]);
    expect(h.lark.texts).toEqual([
      {
        target: { chatId: 'oc_chat', threadId: 'omt_1', root: 'om_root' },
        text: 'Waking the agent for 1 board update.',
        uuid: replyUuid(APP, `wake:${wake?.uuid}`, 'marker'),
      },
    ]);
    expect(getWake(h.db, wake?.wakeId ?? 0)?.markerAt).toBe(NOW);
  });

  it('records each outcome once, and marks it once', async () => {
    const task = h.woken();
    completed(task);
    await h.round();
    await h.round();
    expect(h.wakes()).toHaveLength(1);
    expect(h.lark.texts).toHaveLength(1);
  });

  it('waits for the notice: an event past the notice cursor is not read until the notice goes', async () => {
    const task = h.woken();
    completed(task, 'Booked.', false);
    await h.round();
    expect(h.wakes()).toEqual([]);
    expect(h.lark.texts).toEqual([]);
    h.noticed(task);
    await h.round();
    expect(h.wakes()).toHaveLength(1);
  });

  it('records nothing for a task with wake off', async () => {
    const task = newTask(h.db, { createdVia: IN_THREAD });
    completed(task);
    await h.round();
    expect(h.wakes()).toEqual([]);
  });

  it('does not replay an outcome from before wake was turned on', async () => {
    const task = newTask(h.db, { createdVia: IN_THREAD });
    completed(task);
    setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5 }, ALICE, APP, NOW);
    h.noticed(task);
    await h.round();
    expect(h.wakes()).toEqual([]);
  });

  it('records a wake of the highest depth among its tasks', async () => {
    const shallow = h.woken();
    const deep = newTask(h.db, { createdVia: IN_THREAD, wake: { by: ALICE, depth: 3 } });
    h.noticed(deep);
    completed(shallow);
    completed(deep);
    await h.round();
    expect(h.wakes().map((w) => w.depth)).toEqual([3]);
  });

  it('keeps its marker when the send fails, and records it as sent', async () => {
    const task = h.woken();
    completed(task);
    h.lark.failNext('sendText', new Error('lark is down'));
    await h.round();
    expect(h.wakes()[0]?.markerAt).toBe(NOW);
    expect(h.notes.some((n) => n.includes('marker') && n.includes('lark is down'))).toBe(true);
  });
});

describe('what is recorded', () => {
  it.each([
    ['completed', 'run:r_1', { summary: 'done' }],
    ['changes_requested', ALICE, { reason: 'shorter' }],
    ['blocked', 'run:r_1', { kind: 'needs_input', reason: 'which?', blockRecurrences: 1 }],
    ['run_ended', 'gateway', { outcome: 'failed', next: 'blocked', blockKind: 'gave_up', blockReason: 'failed twice' }],
    ['stranded', 'gateway', { reason: 'its role is gone' }],
  ])('a %s is an outcome', async (kind, actor, payload) => {
    const task = h.woken();
    h.event(task, kind, actor, payload);
    await h.round();
    expect(h.wakes()).toHaveLength(1);
  });

  it.each([
    ['a person block', 'blocked', ALICE, { kind: 'needs_input', reason: 'hold on' }],
    ['a stop', 'stopped', ALICE, {}],
    ['a dependency block', 'blocked', 'run:r_1', { kind: 'dependency', reason: 'parents' }],
    ['a retrying run end', 'run_ended', 'gateway', { outcome: 'failed', next: 'retry' }],
    ['a comment', 'commented', ALICE, {}],
  ])('%s is no outcome, and is passed over', async (_what, kind, actor, payload) => {
    const task = h.woken();
    const event = h.event(task, kind, actor, payload);
    await h.round();
    expect(h.wakes()).toEqual([]);
    expect(h.lark.texts).toEqual([]);
    expect(subscriptionsOf(h.db, task.taskId)[0]?.wakeCursor).toBe(event);
  });
});

describe('batches', () => {
  it("are one row for a thread's outcomes of one setter, in event order, with one marker", async () => {
    const a = h.woken();
    const b = h.woken();
    const c = h.woken();
    const ea = completed(a);
    const eb = completed(b);
    const ec = completed(c);
    await h.round();
    const [wake] = h.wakes();
    expect(h.wakes()).toHaveLength(1);
    expect(wakeEventsOf(h.db, wake?.wakeId ?? 0).map((e) => e.eventId)).toEqual([ea, eb, ec]);
    expect(h.lark.texts.map((t) => t.text)).toEqual(['Waking the agent for 3 board updates.']);
  });

  it('are one a setter: two setters in one thread get a row each, the older first, one a round', async () => {
    const bobs = h.woken(BOB);
    const alices = h.woken(ALICE);
    completed(bobs);
    completed(alices);
    await h.round();
    expect(h.wakes().map((w) => w.principal)).toEqual([BOB]);
  });

  it('are one a conversation: two threads get a row each in one round', async () => {
    const one = h.woken();
    const other = newTask(h.db, { createdVia: { ...IN_THREAD, threadId: 'omt_2', rootId: 'om_root2' } });
    setWake(h.db, other.taskId, { on: true, as: ALICE, maxDepth: 5 }, ALICE, APP, NOW);
    completed(one);
    completed(other);
    await h.round();
    expect(h.wakes().map((w) => w.threadId).sort()).toEqual(['omt_1', 'omt_2']);
  });

  it('count a batch in the marker', () => {
    expect(markerText(1)).toBe('Waking the agent for 1 board update.');
    expect(markerText(2)).toBe('Waking the agent for 2 board updates.');
  });
});
