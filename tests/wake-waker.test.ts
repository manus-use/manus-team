import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOOT_ID, replyUuid, turnIdempotencyKey } from '../src/core/ids.js';
import { getWake, subscriptionsOf, wakeEventsOf } from '../src/db/kanban-read.js';
import { setWake } from '../src/db/kanban.js';
import { ALICE, NOW, newTask } from './helpers/kanban.js';
import { APP, BOB, IN_THREAD, THREAD_KEY, wakeHarness, type WakeHarness } from './helpers/waker.js';

/**
 * The waker's round (wake spec §5.1, §5.2, §5.5, §8): the outcomes past each
 * subscription's wake cursor and at or before its notice cursor, batched by
 * conversation and principal, recorded, marked, and submitted to the
 * conversation's session, delivered when the prompt reaches the agent.
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
  it('sends the marker, then submits the prompt to the thread session, as the setter, and is delivered', async () => {
    const task = h.woken();
    const event = completed(task);
    expect(await h.round()).toBe(1);
    const [wake] = h.wakes();
    expect(wake).toMatchObject({ state: 'delivered', principal: ALICE, depth: 0, attempt: 1, conversationId: 'oc_chat', threadId: 'omt_1' });
    expect(wakeEventsOf(h.db, wake?.wakeId ?? 0).map((e) => e.eventId)).toEqual([event]);
    expect(h.lark.texts).toEqual([
      {
        target: { chatId: 'oc_chat', threadId: 'omt_1', root: 'om_root' },
        text: 'Waking the agent for 1 board update.',
        uuid: replyUuid(APP, `wake:${wake?.uuid}`, 'marker'),
      },
    ]);
    expect(getWake(h.db, wake?.wakeId ?? 0)?.markerAt).toBe(NOW);
    const [req] = h.registry.submits;
    expect(req?.messageId).toBe(`wake:${wake?.uuid}`);
    expect(req?.appId).toBe(APP);
    expect(req?.input.paths).toEqual([]);
    expect(req?.input.text.startsWith('Board update: you are woken because wake is on for these tasks (set by Alice).')).toBe(true);
    expect(req?.input.text).toContain(`${task.taskId}: a task\nOutcome: completed, by its run\nThe run wrote:\n> Booked.`);
    expect(req?.origin).toEqual({ wake: { id: wake?.wakeId, by: ALICE, name: 'Alice' } });
    expect(req?.replyTo).toBeUndefined();
    expect(wake?.sessionId).toBe('s_w1');
    expect(wake?.turnKey).toBe(turnIdempotencyKey(APP, `wake:${wake?.uuid}`));
    expect(wake?.submitBoot).toBe(BOOT_ID);
    expect(subscriptionsOf(h.db, task.taskId)[0]?.wakeCursor).toBe(event);
  });

  it('makes the thread a session owned by the setter when it has none', async () => {
    const task = h.woken();
    completed(task);
    await h.round();
    expect(h.registry.owners).toEqual([{ openId: 'ou_alice', unionId: 'on_alice', displayName: 'Alice' }]);
    expect(h.registry.actorFors).toEqual(['s_w1']);
  });

  it('records the turn without operate tier, whoever set the wake', async () => {
    const task = h.woken();
    completed(task);
    await h.round();
    const [wake] = h.wakes();
    expect(h.turnsSubmitted).toEqual([{ sessionId: 's_w1', key: wake?.turnKey, operate: false }]);
  });

  it('wakes each outcome once, and never again', async () => {
    const task = h.woken();
    completed(task);
    expect(await h.round()).toBe(1);
    expect(await h.round()).toBe(0);
    expect(h.registry.submits).toHaveLength(1);
    expect(h.lark.texts).toHaveLength(1);
  });

  it('waits for the notice: an event past the notice cursor is not read until the notice goes', async () => {
    const task = h.woken();
    completed(task, 'Booked.', false);
    expect(await h.round()).toBe(0);
    expect(h.wakes()).toEqual([]);
    h.noticed(task);
    expect(await h.round()).toBe(1);
  });

  it('wakes nothing for a task with wake off', async () => {
    const task = newTask(h.db, { createdVia: IN_THREAD });
    completed(task);
    expect(await h.round()).toBe(0);
    expect(h.registry.submits).toEqual([]);
  });

  it('does not replay an outcome from before wake was turned on', async () => {
    const task = newTask(h.db, { createdVia: IN_THREAD });
    completed(task);
    setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5 }, ALICE, APP, NOW);
    h.noticed(task);
    expect(await h.round()).toBe(0);
  });
});

describe('what wakes', () => {
  it.each([
    ['completed', 'run:r_1', { summary: 'done' }],
    ['changes_requested', ALICE, { reason: 'shorter' }],
    ['blocked', 'run:r_1', { kind: 'needs_input', reason: 'which?', blockRecurrences: 1 }],
    ['run_ended', 'gateway', { outcome: 'failed', next: 'blocked', blockKind: 'gave_up', blockReason: 'failed twice' }],
    ['stranded', 'gateway', { reason: 'its role is gone' }],
  ])('a %s wakes', async (kind, actor, payload) => {
    const task = h.woken();
    h.event(task, kind, actor, payload);
    expect(await h.round()).toBe(1);
  });

  it.each([
    ['a person block', 'blocked', ALICE, { kind: 'needs_input', reason: 'hold on' }],
    ['a stop', 'stopped', ALICE, {}],
    ['a dependency block', 'blocked', 'run:r_1', { kind: 'dependency', reason: 'parents' }],
    ['a retrying run end', 'run_ended', 'gateway', { outcome: 'failed', next: 'retry' }],
    ['a comment', 'commented', ALICE, {}],
  ])('%s does not wake, and is passed over', async (_what, kind, actor, payload) => {
    const task = h.woken();
    const event = h.event(task, kind, actor, payload);
    expect(await h.round()).toBe(0);
    expect(h.registry.submits).toEqual([]);
    expect(subscriptionsOf(h.db, task.taskId)[0]?.wakeCursor).toBe(event);
  });
});

describe('batches', () => {
  it("are one turn for a thread's outcomes of one setter, its prompt in event order", async () => {
    const a = h.woken();
    const b = h.woken();
    const c = h.woken();
    completed(a);
    completed(b);
    completed(c);
    expect(await h.round()).toBe(1);
    expect(h.registry.submits).toHaveLength(1);
    const text = h.registry.submits[0]?.input.text ?? '';
    expect(text.indexOf(a.taskId)).toBeLessThan(text.indexOf(b.taskId));
    expect(text.indexOf(b.taskId)).toBeLessThan(text.indexOf(c.taskId));
  });

  it('are one a setter: two setters in one thread get two turns, the older first, one a round', async () => {
    const bobs = h.woken(BOB);
    const alices = h.woken(ALICE);
    completed(bobs);
    completed(alices);
    expect(await h.round()).toBe(1);
    expect(h.wakes().map((w) => w.principal)).toEqual([BOB]);
    expect(await h.round()).toBe(1);
    expect(h.wakes().map((w) => w.principal)).toEqual([BOB, ALICE]);
    expect(h.registry.submits.map((r) => r.origin?.wake.by)).toEqual([BOB, ALICE]);
  });

  it('are one a conversation: two threads get a turn each in one round', async () => {
    const one = h.woken();
    const other = newTask(h.db, { createdVia: { ...IN_THREAD, threadId: 'omt_2', rootId: 'om_root2' } });
    setWake(h.db, other.taskId, { on: true, as: ALICE, maxDepth: 5 }, ALICE, APP, NOW);
    completed(one);
    completed(other);
    expect(await h.round()).toBe(2);
    expect(h.wakes().map((w) => w.threadId).sort()).toEqual(['omt_1', 'omt_2']);
  });
});

describe('the turn', () => {
  it('is delivered when the actor finds it already made', async () => {
    const task = h.woken();
    completed(task);
    h.registry.bindOrCreate(THREAD_KEY, { openId: 'ou_alice', unionId: 'on_alice', displayName: null });
    h.registry.actor('s_w1').answers.push('duplicate');
    await h.round();
    expect(h.wakes()[0]?.state).toBe('delivered');
  });

  it('is never waited for: the round ends, and idle settles, while the woken turn runs', async () => {
    const task = h.woken();
    completed(task);
    h.registry.bindOrCreate(THREAD_KEY, { openId: 'ou_alice', unionId: 'on_alice', displayName: null });
    h.registry.actor('s_w1').answers.push('hold');
    expect(await h.round()).toBe(1);
    expect(await h.waker.idle(100)).toBe(true);
    expect(h.wakes()[0]?.state).toBe('delivered');
    h.registry.actor('s_w1').release();
  });

  it('holds its conversation while its submit is under way, and submits nothing more there', async () => {
    const task = h.woken();
    completed(task);
    h.registry.bindOrCreate(THREAD_KEY, { openId: 'ou_alice', unionId: 'on_alice', displayName: null });
    const actor = h.registry.actor('s_w1');
    actor.answers.push('hang');
    await h.round();
    expect(h.wakes()[0]).toMatchObject({ state: 'pending', sessionId: 's_w1', submitBoot: BOOT_ID });
    completed(task, 'Again.');
    expect(await h.round()).toBe(0);
    expect(actor.submits).toHaveLength(1);
    actor.release('completed');
  });

  it('is tried again under its next attempt after a start that failed, with no second marker', async () => {
    const task = h.woken();
    completed(task);
    h.registry.bindOrCreate(THREAD_KEY, { openId: 'ou_alice', unionId: 'on_alice', displayName: null });
    const actor = h.registry.actor('s_w1');
    actor.answers.push('fail_start');
    await h.round();
    const [refused] = h.wakes();
    expect(refused).toMatchObject({ state: 'pending', attempt: 2, sessionId: null, turnKey: null, submitBoot: null });
    // Its conversation is paused 2 s after a refusal (§5.6).
    await h.clock.delay(2_000);
    await h.round();
    expect(actor.submits.map((r) => r.messageId)).toEqual([`wake:${refused?.uuid}`, `wake:${refused?.uuid}:2`]);
    expect(h.wakes()[0]?.state).toBe('delivered');
    expect(h.lark.texts).toHaveLength(1);
  });

  it('goes all the same when its marker fails', async () => {
    const task = h.woken();
    completed(task);
    h.lark.failNext('sendText', new Error('lark is down'));
    await h.round();
    expect(h.wakes()[0]).toMatchObject({ state: 'delivered', markerAt: NOW });
    expect(h.notes.some((n) => n.includes('marker') && n.includes('lark is down'))).toBe(true);
  });

  it('writes nothing for a callback that comes after the stop', async () => {
    const task = h.woken();
    completed(task);
    h.registry.bindOrCreate(THREAD_KEY, { openId: 'ou_alice', unionId: 'on_alice', displayName: null });
    const actor = h.registry.actor('s_w1');
    actor.answers.push('hang');
    await h.round();
    h.waker.stop();
    actor.release('failed');
    await new Promise((r) => setImmediate(r));
    expect(h.wakes()[0]).toMatchObject({ state: 'pending', attempt: 1, sessionId: 's_w1' });
  });
});

describe('the order of the marker and the submit', () => {
  it('submits nothing until the marker has been sent, and submits after it', async () => {
    const task = h.woken();
    completed(task);
    h.lark.hold();
    const round = h.waker.wake();
    await new Promise((r) => setImmediate(r));
    expect(h.lark.calls).toEqual(['sendText']);
    expect(h.registry.submits).toEqual([]);
    expect(h.registry.actorFors).toEqual([]);
    h.lark.release();
    expect(await round).toBe(1);
    expect(h.registry.submits).toHaveLength(1);
  });

  it('lets idle run out while a marker is held, and answers false', async () => {
    const task = h.woken();
    completed(task);
    h.lark.hold();
    const round = h.waker.wake();
    expect(await h.waker.idle(10)).toBe(false);
    h.lark.release();
    await round;
    expect(await h.waker.idle(10)).toBe(true);
  });
});

describe('the prompt of a block', () => {
  function blocked(task: { taskId: string }): number {
    return h.event(task as never, 'blocked', 'run:r_1', { kind: 'needs_input', reason: 'which?', blockRecurrences: 1 });
  }

  it('says the Unblock button is on its notice when one was recorded for that block', async () => {
    const task = h.woken();
    const event = blocked(task);
    h.service.recordUnblockButtons({ messageId: 'om_notice', channel: 'lark', appId: APP, markdown: 'blocked', buttons: [{ taskId: task.taskId, blockEvent: event }] });
    await h.round();
    expect(h.registry.submits[0]?.input.text).toContain('An Unblock button is on its notice in this thread.');
  });

  it('says its notice has no Unblock button when none was recorded', async () => {
    const task = h.woken();
    blocked(task);
    await h.round();
    expect(h.registry.submits[0]?.input.text).toContain('Its notice in this thread has no Unblock button; /kanban task unblock lifts it.');
  });
});

describe('a pending row whose every task is gone', () => {
  it('is dropped, saying its tasks are not on the board, and holds its conversation no longer', async () => {
    const gone = h.woken();
    completed(gone);
    h.registry.bindOrCreate(THREAD_KEY, { openId: 'ou_alice', unionId: 'on_alice', displayName: null });
    h.registry.actor('s_w1').answers.push('fail_start');
    await h.round();
    expect(h.wakes()[0]).toMatchObject({ state: 'pending', attempt: 2 });
    h.db.pragma('foreign_keys = OFF');
    h.db.prepare('DELETE FROM kanban_tasks WHERE task_id = ?').run(gone.taskId);
    await h.clock.delay(2_000);
    await h.round();
    expect(h.wakes()[0]).toMatchObject({ state: 'dropped', error: `task ${gone.taskId} is not on the board` });
    expect(h.notes.some((n) => n.includes(`wake ${h.wakes()[0]?.wakeId} dropped`) && n.includes('not on the board'))).toBe(true);
    const next = h.woken();
    completed(next);
    await h.round();
    expect(h.wakes()[1]).toMatchObject({ state: 'delivered' });
  });
});
