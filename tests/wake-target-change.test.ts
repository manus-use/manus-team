import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionHeld } from '../src/core/session-actor.js';
import { deferButton, setWake } from '../src/db/kanban.js';
import { deferredButton, subscriptionsOf } from '../src/db/kanban-read.js';
import type { TaskRow } from '../src/kanban/types.js';
import type { Role } from '../src/roles.js';
import { clearSecrets } from '../src/secrets.js';
import { role } from './helpers/dispatch.js';
import { ALICE, NOW } from './helpers/kanban.js';
import { APP, THREAD_KEY, wakeHarness, type WakeHarness } from './helpers/waker.js';

/**
 * A wake's target compared in the waker as the service compares it (wake spec
 * §5.3a, §5.9, §19.1): a task whose wake moved from the chat session to a role,
 * or back, with the same setter, is no longer the wake's, so a pending row
 * carrying it is dropped as taken over, and a held button of it is released.
 */

const ROLE = 'vi-coordinator';

let h: WakeHarness;
beforeEach(() => {
  clearSecrets();
  const roles: ReadonlyMap<string, Role> = new Map([[ROLE, role(ROLE)]]);
  h = wakeHarness({}, { roles });
});
afterEach(() => {
  h.waker.stop();
  clearSecrets();
  h.t.close();
});

function target(task: TaskRow, to: string | undefined, at: number): void {
  const r = setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5, ...(to === undefined ? {} : { role: to }) }, ALICE, APP, at);
  if (!r.ok) throw new Error(r.message);
  expect(r.changed).toBe(true);
}

/** A run's block of a wake-on task, its notice sent without its button: the deferral written. */
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

describe("a pending row whose task's wake changed target", () => {
  it('is dropped as taken over when the wake moved from the chat session to a role with the same setter', async () => {
    const task = h.woken();
    const a = h.registry.actor(h.registry.bindOrCreate(THREAD_KEY, { openId: 'ou_alice', unionId: 'on_alice', displayName: null }).session.id);
    a.answers.push({ reject: new SessionHeld('s_w1') });
    h.event(task, 'completed', 'run:r_1', { summary: 'Booked.' });
    await h.round();
    expect(h.wakes()[0]?.state).toBe('pending');
    target(task, ROLE, NOW + 1);
    await h.clock.delay(2_000);
    await h.round();
    expect(h.wakes()[0]).toMatchObject({ state: 'dropped', error: `task ${task.taskId}'s wake targets another now` });
    expect(a.submits).toHaveLength(1);
  });

  it('is kept when the wake moved to a role and back before the check, as its target is the same again', async () => {
    const task = h.woken();
    const a = h.registry.actor(h.registry.bindOrCreate(THREAD_KEY, { openId: 'ou_alice', unionId: 'on_alice', displayName: null }).session.id);
    a.answers.push({ reject: new SessionHeld('s_w1') });
    h.event(task, 'completed', 'run:r_1', { summary: 'Booked.' });
    await h.round();
    target(task, ROLE, NOW + 1);
    target(task, undefined, NOW + 2);
    await h.clock.delay(2_000);
    await h.round();
    expect(h.wakes()[0]?.state).toBe('delivered');
    expect(a.submits).toHaveLength(2);
  });
});

describe("a held button whose task's wake changed target", () => {
  it("goes due, not_woken, when the woken turn's task moves to a role with the same setter", async () => {
    const task = h.woken();
    const b = deferredBlock(task);
    h.registry.actor('s_w1').answers.push('hold');
    await h.round();
    expect(h.wakes()[0]?.state).toBe('delivered');
    target(task, ROLE, NOW + 1);
    await h.round();
    expect(state(b)).toEqual({ state: 'sent', why: 'not_woken' });
  });

  it("goes due, not_woken, when a role's wake moves back to the chat session before its reaction task runs", async () => {
    const task = h.woken();
    target(task, ROLE, NOW + 1);
    h.noticed(task);
    const b = deferredBlock(task);
    await h.round();
    expect(h.wakes()[0]?.reactionTask).not.toBeNull();
    expect(state(b)).toEqual({ state: 'held', why: null });
    target(task, undefined, NOW + 2);
    await h.round();
    expect(state(b)).toEqual({ state: 'sent', why: 'not_woken' });
  });
});
