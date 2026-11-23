import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionHeld } from '../src/core/session-actor.js';
import { setWake } from '../src/db/kanban.js';
import { eventsOf, subscriptionsOf, wakeEventsOf } from '../src/db/kanban-read.js';
import type { TaskRow } from '../src/kanban/types.js';
import { ALICE, NOW } from './helpers/kanban.js';
import { APP, BOB, THREAD_KEY, wakeHarness, type WakeHarness } from './helpers/waker.js';

/**
 * A pending row checked again before every submit (wake spec §5.3a), before its
 * marker and at the busy re-check, each failure dropping the row or, for one
 * task's, only that task's events; and a block lifted before the turn dropped
 * from its batch (§5.3b), a batch with nothing left never recorded, or closed
 * `lifted`.
 */

let h: WakeHarness;
let admits: 'chat_not_allowed' | 'dm_disabled' | undefined;
let letGo: boolean;

beforeEach(() => {
  admits = undefined;
  letGo = false;
  h = wakeHarness({ admitsConversation: () => admits, letGo: () => letGo });
});
afterEach(() => {
  h.waker.stop();
  h.t.close();
});

function completed(task: TaskRow, summary = 'Booked.'): number {
  return h.event(task, 'completed', 'run:r_1', { summary });
}

function blocked(task: TaskRow, reason = 'Which speaker?'): number {
  return h.event(task, 'blocked', 'run:r_1', { kind: 'needs_input', reason, blockRecurrences: 1 });
}

function unblocked(task: TaskRow): number {
  return h.event(task, 'unblocked', ALICE, { kind: 'needs_input' });
}

function cursorOf(task: TaskRow): number {
  return subscriptionsOf(h.db, task.taskId)[0]?.wakeCursor ?? -1;
}

function lastEvent(task: TaskRow): number {
  return eventsOf(h.db, task.taskId).at(-1)?.id ?? 0;
}

function actor(): ReturnType<WakeHarness['registry']['actor']> {
  return h.registry.actor(h.registry.bindOrCreate(THREAD_KEY, { openId: 'ou_alice', unionId: 'on_alice', displayName: null }).session.id);
}

/** A row left pending by one refusal, its pause run out by the next call. */
async function pendingRow(...tasks: TaskRow[]): Promise<ReturnType<typeof actor>> {
  const a = actor();
  a.answers.push({ reject: new SessionHeld('s_w1') });
  for (const t of tasks) completed(t);
  await h.round();
  expect(h.wakes().at(-1)?.state).toBe('pending');
  return a;
}

async function afterPause(): Promise<void> {
  await h.clock.delay(2_000);
  await h.round();
}

describe('a pending row checked again', () => {
  it("is dropped when its principal has lost talk tier, its cursors past all its events, with the tier line for each task", async () => {
    const one = h.woken();
    const two = h.woken();
    const a = await pendingRow(one, two);
    h.talk.delete(ALICE);
    await afterPause();
    const [wake] = h.wakes();
    expect(wake).toMatchObject({ state: 'dropped' });
    expect(wake?.error).toBe('lark:on_alice no longer has talk tier');
    expect(a.submits).toHaveLength(1);
    expect([cursorOf(one), cursorOf(two)]).toEqual([lastEvent(one), lastEvent(two)]);
    expect(h.lark.texts.map((t) => t.text).slice(1)).toEqual([
      `wake is off for \`${one.taskId}\`: Alice no longer has talk tier`,
      `wake is off for \`${two.taskId}\`: Alice no longer has talk tier`,
    ]);
  });

  it("is dropped, silently but for the log, when one task's wake is turned off; the other task's outcome is batched again", async () => {
    const off = h.woken();
    const kept = h.woken();
    const a = await pendingRow(off, kept);
    const first = h.wakes()[0];
    setWake(h.db, off.taskId, { on: false }, ALICE, APP, NOW);
    await afterPause();
    expect(h.wakes()[0]).toMatchObject({ state: 'dropped' });
    // Past that task's events in the row; its wake_set since is no outcome, passed later.
    expect(cursorOf(off)).toBe(wakeEventsOf(h.db, first?.wakeId ?? 0).find((e) => e.taskId === off.taskId)?.eventId);
    expect(h.notes.some((n) => n.includes(`wake ${first?.wakeId} dropped`) && n.includes(off.taskId))).toBe(true);
    // No line for the drop: only the new batch's marker, as the kept task is batched again.
    expect(h.lark.texts.map((t) => t.text)).toEqual(['Waking the agent for 2 board updates.', 'Waking the agent for 1 board update.']);
    const [, again] = h.wakes();
    expect(again?.uuid).not.toBe(first?.uuid);
    expect(wakeEventsOf(h.db, again?.wakeId ?? 0).map((e) => e.taskId)).toEqual([kept.taskId]);
    expect(a.submits.at(-1)?.input.text).toContain(kept.taskId);
    expect(a.submits.at(-1)?.input.text).not.toContain(off.taskId);
  });

  it('is dropped when another person has taken a task over', async () => {
    const taken = h.woken();
    await pendingRow(taken);
    setWake(h.db, taken.taskId, { on: true, as: BOB, maxDepth: 5 }, BOB, APP, NOW);
    h.noticed(taken);
    await afterPause();
    expect(h.wakes()[0]).toMatchObject({ state: 'dropped' });
  });

  it('is dropped for an archived task, and for one no longer on the board, the others batched again', async () => {
    const archived = h.woken();
    const gone = h.woken();
    const kept = h.woken();
    await pendingRow(archived, gone, kept);
    h.db.prepare("UPDATE kanban_tasks SET phase = 'archived' WHERE task_id = ?").run(archived.taskId);
    h.db.pragma('foreign_keys = OFF');
    h.db.prepare('DELETE FROM kanban_tasks WHERE task_id = ?').run(gone.taskId);
    await afterPause();
    expect(h.wakes()[0]?.state).toBe('dropped');
    expect(h.wakes()[0]?.error).toBe(`task ${archived.taskId} is archived; task ${gone.taskId} is not on the board`);
    await h.round();
    expect(wakeEventsOf(h.db, h.wakes()[1]?.wakeId ?? 0).map((e) => e.taskId)).toEqual([kept.taskId]);
  });

  it.each(['chat_not_allowed', 'dm_disabled'] as const)('is dropped when the conversation is no longer admitted (%s), with the log line', async (reason) => {
    const task = h.woken();
    await pendingRow(task);
    admits = reason;
    await afterPause();
    expect(h.wakes()[0]).toMatchObject({ state: 'dropped', error: `the conversation is not admitted (${reason})` });
    expect(cursorOf(task)).toBe(lastEvent(task));
    expect(h.notes.filter((n) => n.includes('not admitted'))).toHaveLength(1);
  });

  it('is dropped when the notifier has let the conversation go', async () => {
    const task = h.woken();
    await pendingRow(task);
    letGo = true;
    await afterPause();
    expect(h.wakes()[0]).toMatchObject({ state: 'dropped', error: 'the notifier has let the conversation go' });
  });

  it('is checked again after the marker and actorFor: a task archived meanwhile is not submitted', async () => {
    const task = h.woken();
    completed(task);
    const a = actor();
    const actorFor = h.registry.actorFor.bind(h.registry);
    h.registry.actorFor = async (sessionId, key) => {
      h.db.prepare("UPDATE kanban_tasks SET phase = 'archived' WHERE task_id = ?").run(task.taskId);
      return actorFor(sessionId, key);
    };
    await h.round();
    expect(a.submits).toEqual([]);
    expect(h.wakes()[0]?.state).toBe('dropped');
    expect(h.lark.texts.map((t) => t.text)).toEqual(['Waking the agent for 1 board update.']);
  });

  it("is checked again after the marker: a setter whose talk tier is lost while the marker is sent is not submitted", async () => {
    const task = h.woken();
    completed(task);
    const a = actor();
    const send = h.lark.sendText.bind(h.lark);
    h.lark.sendText = async (...args: Parameters<typeof send>) => {
      if (args[1].startsWith('Waking the agent')) h.talk.delete(ALICE);
      return send(...args);
    };
    await h.round();
    expect(a.submits).toEqual([]);
    expect(h.wakes()[0]).toMatchObject({ state: 'dropped', error: `${ALICE} no longer has talk tier` });
    expect(cursorOf(task)).toBe(lastEvent(task));
  });
});

describe('a block lifted before the turn', () => {
  it('alone in its batch: no row, no marker, no turn, its cursor moved', async () => {
    const task = h.woken();
    blocked(task);
    unblocked(task);
    expect(await h.round()).toBe(0);
    expect(h.wakes()).toEqual([]);
    expect(h.lark.texts).toEqual([]);
    expect(h.registry.submits).toEqual([]);
    expect(cursorOf(task)).toBe(lastEvent(task));
  });

  it('beside a completion: the completion wakes, the marker counts one, the prompt has no block, and the block passes with its batch', async () => {
    const done = h.woken();
    const stuck = h.woken();
    completed(done);
    const block = blocked(stuck, 'Which keynote?');
    unblocked(stuck);
    expect(await h.round()).toBe(1);
    const [wake] = h.wakes();
    expect(wakeEventsOf(h.db, wake?.wakeId ?? 0).map((e) => e.eventId)).toContain(block);
    expect(h.lark.texts.map((t) => t.text)).toEqual(['Waking the agent for 1 board update.']);
    const text = h.registry.submits[0]?.input.text ?? '';
    expect(text).toContain(done.taskId);
    expect(text).not.toContain('Which keynote?');
    expect(wake?.state).toBe('delivered');
    // The lifted block passes with its batch.
    expect(cursorOf(stuck)).toBe(block);
  });

  it('while its pending row waits: the row closed lifted, its cursors moved, no line', async () => {
    const task = h.woken();
    const a = actor();
    a.answers.push({ reject: new SessionHeld('s_w1') });
    blocked(task);
    await h.round();
    unblocked(task);
    await afterPause();
    expect(h.wakes()[0]).toMatchObject({ state: 'lifted' });
    expect(a.submits).toHaveLength(1);
    expect(cursorOf(task)).toBe(lastEvent(task));
    expect(h.lark.texts).toHaveLength(1);
  });

  it('between the marker and the busy re-check: the turn not submitted, the row closed lifted, the marker left standing', async () => {
    const task = h.woken();
    blocked(task);
    const a = actor();
    const actorFor = h.registry.actorFor.bind(h.registry);
    h.registry.actorFor = async (sessionId, key) => {
      unblocked(task);
      return actorFor(sessionId, key);
    };
    await h.round();
    expect(a.submits).toEqual([]);
    expect(h.wakes()[0]?.state).toBe('lifted');
    expect(h.lark.texts.map((t) => t.text)).toEqual(['Waking the agent for 1 board update.']);
  });
});
