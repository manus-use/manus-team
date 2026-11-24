import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archive, deferButton, setWake, unblock } from '../src/db/kanban.js';
import { deferredButton, subscriptionsOf } from '../src/db/kanban-read.js';
import type { TaskRow } from '../src/kanban/types.js';
import { clearSecrets } from '../src/secrets.js';
import { ALICE, NOW } from './helpers/kanban.js';
import { WAKE_BACKOFF_MAX_MS, WAKE_REFUSALS } from '../src/kanban/waker.js';
import { APP, BOB, wakeHarness, type WakeHarness } from './helpers/waker.js';

/**
 * A deferred button released (wake spec §5.9): each round checks every `held`
 * row and makes it `due` at once whenever the agent will no longer get a real
 * try, `lifted` when its block is lifted or its task archived, and `failed` when
 * its task is gone; a row still held `hold_minutes` after its notice is made
 * due, `running` while its woken turn runs and `not_woken` otherwise; after a
 * restart a row whose wake an earlier boot delivered is due, `restart`; and a
 * waker built in release mode forms no wakes and makes every held row due.
 * A row made due is sent in the same round, its card going to people, so the
 * tests read it `sent`, with the why it was due for.
 */

const MINUTE = 60_000;

let admits: 'chat_not_allowed' | 'dm_disabled' | undefined;
let letGo: boolean;
let h: WakeHarness;
beforeEach(() => {
  clearSecrets();
  admits = undefined;
  letGo = false;
  h = wakeHarness({ admitsConversation: () => admits, letGo: () => letGo });
});
afterEach(() => {
  clearSecrets();
  h.t.close();
});

/** A run's block of a wake-on task, its notice sent without its button now: the deferral written. */
function deferredBlock(task: TaskRow): { sub: number; event: number } {
  h.db.prepare("UPDATE kanban_tasks SET phase = 'blocked', blocked_from = 'open', block_kind = 'needs_input' WHERE task_id = ?").run(task.taskId);
  const event = h.event(task, 'blocked', 'run:r_1', { kind: 'needs_input', reason: 'which speaker?', blockRecurrences: 1 });
  const sub = subscriptionsOf(h.db, task.taskId)[0]?.id ?? 0;
  const r = deferButton(h.db, { subscriptionId: sub, eventId: event }, h.clock.now());
  if (!r.ok) throw new Error(r.message);
  return { sub, event };
}

function state(b: { sub: number; event: number }): { state: string; why: string | null } | undefined {
  const r = deferredButton(h.db, b.sub, b.event);
  return r === undefined ? undefined : { state: r.state, why: r.why };
}

describe('a held button released at once', () => {
  it("goes due, not_woken, when the setter's operate tier is lost after the deferral", async () => {
    const b = deferredBlock(h.woken());
    h.operate.delete(ALICE);
    await h.round();
    expect(state(b)).toEqual({ state: 'sent', why: 'not_woken' });
  });

  it("goes due, not_woken, when the setter's talk tier is lost", async () => {
    const b = deferredBlock(h.woken());
    h.talk.delete(ALICE);
    await h.round();
    expect(state(b)).toEqual({ state: 'sent', why: 'not_woken' });
  });

  it('goes due, not_woken, when wake is turned off', async () => {
    const task = h.woken();
    const b = deferredBlock(task);
    const off = setWake(h.db, task.taskId, { on: false }, ALICE, APP, NOW + 1);
    if (!off.ok) throw new Error(off.message);
    await h.round();
    expect(state(b)).toEqual({ state: 'sent', why: 'not_woken' });
  });

  it('goes due, not_woken, when another setter takes the wake over from the one its turn runs as', async () => {
    const task = h.woken();
    const b = deferredBlock(task);
    h.registry.actor('s_w1').answers.push('hold');
    await h.round();
    expect(h.wakes()[0]?.state).toBe('delivered');
    const over = setWake(h.db, task.taskId, { on: true, as: BOB, maxDepth: 5 }, BOB, APP, NOW + 1);
    if (!over.ok) throw new Error(over.message);
    await h.round();
    expect(state(b)).toEqual({ state: 'sent', why: 'not_woken' });
  });

  it('goes due, not_woken, when the notifier lets the conversation go, or the gateway no longer admits it', async () => {
    const b = deferredBlock(h.woken());
    letGo = true;
    await h.round();
    // Due, and then failed at its send: the notifier has let the conversation go.
    expect(state(b)).toEqual({ state: 'failed', why: 'not_woken' });
    letGo = false;
    const c = deferredBlock(h.woken());
    admits = 'chat_not_allowed';
    await h.round();
    expect(state(c)).toEqual({ state: 'sent', why: 'not_woken' });
  });

  it('goes due, not_woken, once its batch is dropped and its cursor moved past it', async () => {
    const b = deferredBlock(h.woken());
    h.registry.actor('s_w1').answers.push({ reject: new Error('mailbox full') });
    await h.round();
    const pending = h.wakes()[0];
    expect(pending?.state).toBe('pending');
    expect(state(b)?.state).toBe('held');
    const dropped = h.service.dropWake(pending?.wakeId ?? 0, 'dropped after its refusals');
    if (!dropped.ok) throw new Error(dropped.message);
    await h.round();
    expect(state(b)).toEqual({ state: 'sent', why: 'not_woken' });
  });

  it('goes due, not_woken, when its batch is dropped after ten refusals in a row', async () => {
    h.t.close();
    // A hold longer than the refusals' pauses, so only the drop releases it.
    h = wakeHarness({ settings: { perHour: 6, maxDepth: 5, holdMinutes: 60 } });
    const b = deferredBlock(h.woken());
    const held = new Error('session s_w1 is quarantined and will not be resumed automatically');
    for (let i = 0; i < WAKE_REFUSALS; i += 1) h.registry.actor('s_w1').answers.push({ reject: held });
    for (let i = 0; i < WAKE_REFUSALS - 1; i += 1) {
      await h.round();
      expect(state(b)?.state).toBe('held');
      await h.clock.delay(WAKE_BACKOFF_MAX_MS);
    }
    await h.round();
    expect(h.wakes()[0]?.state).toBe('dropped');
    await h.round();
    expect(state(b)).toEqual({ state: 'sent', why: 'not_woken' });
  });

  it("goes due, not_woken, when its pending row is dropped by the check before the submit, the setter's tier lost", async () => {
    const b = deferredBlock(h.woken());
    h.registry.actor('s_w1').answers.push({ reject: new Error('mailbox full') });
    await h.round();
    expect(h.wakes()[0]?.state).toBe('pending');
    h.talk.delete(ALICE);
    await h.clock.delay(WAKE_BACKOFF_MAX_MS);
    await h.round();
    expect(h.wakes()[0]).toMatchObject({ state: 'dropped' });
    expect(state(b)).toEqual({ state: 'sent', why: 'not_woken' });
    expect(h.registry.submits).toHaveLength(1);
  });

  it('goes lifted, owing no card, when its task is archived', async () => {
    const task = h.woken();
    const b = deferredBlock(task);
    const r = archive(h.db, task.taskId, ALICE, NOW + 1);
    if (!r.ok) throw new Error(r.message);
    await h.round();
    expect(state(b)?.state).toBe('lifted');
  });

  it('goes lifted when its block is lifted before the turn, and no turn is woken for it', async () => {
    const task = h.woken();
    const b = deferredBlock(task);
    const r = unblock(h.db, task.taskId, ALICE, undefined, NOW + 1, { blockedAt: b.event });
    if (!r.ok) throw new Error(r.message);
    expect(await h.round()).toBe(0);
    expect(state(b)?.state).toBe('lifted');
  });

  it('goes failed, with one log line and no card, when its task is deleted from the board', async () => {
    const task = h.woken();
    const b = deferredBlock(task);
    // As a task gone from the board: nothing in the gateway deletes one, so the test does it under the foreign keys.
    h.db.pragma('foreign_keys = OFF');
    h.db.prepare('DELETE FROM kanban_tasks WHERE task_id = ?').run(task.taskId);
    h.db.pragma('foreign_keys = ON');
    await h.round();
    expect(state(b)?.state).toBe('failed');
    expect(h.notes.filter((n) => n.includes(`deferred Unblock button of task ${task.taskId}`))).toEqual([
      `kanban: the deferred Unblock button of task ${task.taskId} (subscription ${b.sub}, event ${b.event}) is dropped: the task is not on the board`,
    ]);
    expect(h.lark.texts).toHaveLength(0);
  });

  it('goes failed, with one log line naming it and no card, when its subscription is gone', async () => {
    const task = h.woken();
    const b = deferredBlock(task);
    h.db.pragma('foreign_keys = OFF');
    h.db.prepare('DELETE FROM kanban_subscriptions WHERE id = ?').run(b.sub);
    h.db.pragma('foreign_keys = ON');
    await h.round();
    expect(state(b)?.state).toBe('failed');
    expect(h.notes.filter((n) => n.includes(`deferred Unblock button of task ${task.taskId}`))).toEqual([
      `kanban: the deferred Unblock button of task ${task.taskId} (subscription ${b.sub}, event ${b.event}) is dropped: subscription ${b.sub} is gone`,
    ]);
    expect(h.lark.texts).toHaveLength(0);
  });

  it('stays held while the agent still gets its try', async () => {
    const b = deferredBlock(h.woken());
    h.registry.actor('s_w1').answers.push('hold');
    await h.round();
    await h.round();
    expect(state(b)?.state).toBe('held');
  });
});

describe('the hold, bounded by hold_minutes', () => {
  it('makes a row whose wake still waits due, not_woken, at the limit and not before', async () => {
    const b = deferredBlock(h.woken());
    h.registry.actor('s_w1').answers.push({ reject: new Error('mailbox full') }, { reject: new Error('mailbox full') });
    await h.round();
    h.clock.advance(10 * MINUTE - 1);
    await h.round();
    expect(state(b)?.state).toBe('held');
    h.clock.advance(1);
    await h.round();
    expect(state(b)).toEqual({ state: 'sent', why: 'not_woken' });
  });

  it('makes a row whose woken turn still runs due, running', async () => {
    const b = deferredBlock(h.woken());
    h.registry.actor('s_w1').answers.push('hold');
    await h.round();
    h.clock.advance(10 * MINUTE);
    await h.round();
    expect(state(b)).toEqual({ state: 'sent', why: 'running' });
    // A turn that ends after that changes nothing: the button has gone.
    h.registry.actor('s_w1').release('completed');
    await h.round();
    expect(state(b)).toEqual({ state: 'sent', why: 'running' });
  });

  it('counts in the minutes kanban.wake.hold_minutes gives', async () => {
    h.t.close();
    h = wakeHarness({ settings: { perHour: 6, maxDepth: 5, holdMinutes: 15 } });
    const b = deferredBlock(h.woken());
    h.registry.actor('s_w1').answers.push('hold');
    await h.round();
    h.clock.advance(10 * MINUTE);
    await h.round();
    expect(state(b)?.state).toBe('held');
    h.clock.advance(5 * MINUTE);
    await h.round();
    expect(state(b)).toEqual({ state: 'sent', why: 'running' });
  });
});

describe('after a restart', () => {
  it('makes a row whose wake an earlier boot delivered due, restart, at the first round', async () => {
    const b = deferredBlock(h.woken());
    h.registry.actor('s_w1').answers.push('hold');
    await h.round();
    expect(h.wakes()[0]?.state).toBe('delivered');
    h.rebuild();
    await h.round();
    expect(state(b)).toEqual({ state: 'sent', why: 'restart' });
  });

  it('leaves a row whose wake is pending waiting within its limit, and makes one past it due at once', async () => {
    const b = deferredBlock(h.woken());
    h.registry.actor('s_w1').answers.push({ reject: new Error('mailbox full') }, 'hold');
    await h.round();
    h.rebuild();
    h.registry.actor('s_w1').answers.length = 0;
    h.registry.actor('s_w1').answers.push({ reject: new Error('mailbox full') });
    await h.round();
    expect(state(b)?.state).toBe('held');
    h.rebuild();
    h.clock.advance(10 * MINUTE);
    await h.round();
    expect(state(b)).toEqual({ state: 'sent', why: 'not_woken' });
  });
});

describe('release mode', () => {
  it('forms no wakes, and makes every held row due, not_woken, leaving a due row as it was', async () => {
    h.t.close();
    h = wakeHarness({ releaseOnly: true });
    const b = deferredBlock(h.woken());
    const c = deferredBlock(h.woken());
    h.db.prepare("UPDATE kanban_deferred_buttons SET state = 'due', why = 'tried' WHERE event_id = ?").run(c.event);
    expect(await h.round()).toBe(0);
    expect(h.wakes()).toEqual([]);
    expect(h.registry.submits).toEqual([]);
    expect(state(b)).toEqual({ state: 'sent', why: 'not_woken' });
    expect(state(c)).toEqual({ state: 'sent', why: 'tried' });
  });
});
