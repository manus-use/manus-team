import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deferButton, unblock } from '../src/db/kanban.js';
import { getSubscription, subscriptionsOf } from '../src/db/kanban-read.js';
import type { KanbanEvent, SubscriptionRow, TaskRow } from '../src/kanban/types.js';
import { clearSecrets } from '../src/secrets.js';
import { ALICE, NOW } from './helpers/kanban.js';
import { BOB, wakeHarness, type WakeHarness } from './helpers/waker.js';

/**
 * The waker's word on a block's Unblock button (wake spec §5.9): true when a
 * deferral is already written for it, whatever else holds, so the decision is
 * sticky; otherwise true only when the agent could lift the block: a run's
 * block of a task with wake on, past the wake cursor, in a conversation admitted
 * and not let go of, set by someone with talk and operate tier, below both
 * unblock limits. A read: it writes nothing.
 */

let h: WakeHarness;
let letGo: boolean;
let admitted: 'chat_not_allowed' | 'dm_disabled' | undefined;

beforeEach(() => {
  clearSecrets();
  letGo = false;
  admitted = undefined;
  h = wakeHarness({ letGo: () => letGo, admitsConversation: () => admitted });
});
afterEach(() => {
  clearSecrets();
  h.t.close();
});

function asEvent(h: WakeHarness, id: number): KanbanEvent {
  const e = h.db
    .prepare<[number], { id: number; task_id: string; run_id: string | null; kind: string; actor: string; payload: string; created_at: number }>(
      'SELECT id, task_id, run_id, kind, actor, json(payload) AS payload, created_at FROM kanban_events WHERE id = ?',
    )
    .get(id);
  if (e === undefined) throw new Error(`no event ${id}`);
  return { id: e.id, taskId: e.task_id, runId: e.run_id, kind: e.kind, actor: e.actor, payload: JSON.parse(e.payload), createdAt: e.created_at };
}

function subOf(task: TaskRow): SubscriptionRow {
  const s = subscriptionsOf(h.db, task.taskId)[0];
  if (s === undefined) throw new Error('no subscription');
  return getSubscription(h.db, s.id) ?? s;
}

function runBlock(task: TaskRow, extra: Record<string, unknown> = {}): KanbanEvent {
  h.db.prepare("UPDATE kanban_tasks SET phase = 'blocked', blocked_from = 'open', block_kind = 'needs_input' WHERE task_id = ?").run(task.taskId);
  return asEvent(h, h.event(task, 'blocked', 'run:r_1', { kind: 'needs_input', reason: 'which?', blockRecurrences: 1, ...extra }, false));
}

describe('Waker.wouldDefer', () => {
  it("says yes for a run's block the agent could lift", () => {
    const task = h.woken();
    const e = runBlock(task);
    expect(h.waker.wouldDefer(subOf(task), e)).toBe(true);
    // A read: nothing is written.
    expect(h.db.prepare<[], { n: number }>('SELECT count(*) AS n FROM kanban_deferred_buttons').get()?.n).toBe(0);
  });

  it("says yes for a run's end that blocks, and no for one that retries", () => {
    const task = h.woken();
    const blocks = asEvent(h, h.event(task, 'run_ended', 'run:r_1', { outcome: 'blocked', next: 'blocked', blockKind: 'gave_up', blockReason: 'tried twice' }, false));
    const retries = asEvent(h, h.event(task, 'run_ended', 'run:r_1', { outcome: 'failed', next: 'retry' }, false));
    expect(h.waker.wouldDefer(subOf(task), blocks)).toBe(true);
    expect(h.waker.wouldDefer(subOf(task), retries)).toBe(false);
  });

  it("says no for a person's block, a dependency, and a task with wake off", () => {
    const task = h.woken();
    const byPerson = asEvent(h, h.event(task, 'blocked', ALICE, { kind: 'needs_input', reason: 'mine' }, false));
    const dependency = asEvent(h, h.event(task, 'blocked', 'run:r_1', { kind: 'dependency', reason: 'parents' }, false));
    expect(h.waker.wouldDefer(subOf(task), byPerson)).toBe(false);
    expect(h.waker.wouldDefer(subOf(task), dependency)).toBe(false);
    const off = h.woken();
    h.db.prepare('UPDATE kanban_tasks SET wake_by = NULL WHERE task_id = ?').run(off.taskId);
    expect(h.waker.wouldDefer(subOf(off), runBlock(off))).toBe(false);
  });

  it('says no for an event at or before the wake cursor, which the waker will not read', () => {
    const task = h.woken();
    const e = runBlock(task);
    h.db.prepare('UPDATE kanban_subscriptions SET wake_cursor = ? WHERE task_id = ?').run(e.id, task.taskId);
    expect(h.waker.wouldDefer(subOf(task), e)).toBe(false);
  });

  it('says no for a conversation let go of, or not admitted', () => {
    const task = h.woken();
    const e = runBlock(task);
    letGo = true;
    expect(h.waker.wouldDefer(subOf(task), e)).toBe(false);
    letGo = false;
    admitted = 'chat_not_allowed';
    expect(h.waker.wouldDefer(subOf(task), e)).toBe(false);
  });

  it('says no when the setter lacks talk tier, or only operate tier is missing', () => {
    const talkOnly = h.woken(BOB);
    expect(h.waker.wouldDefer(subOf(talkOnly), runBlock(talkOnly))).toBe(false);
    const lapsed = h.woken();
    const e = runBlock(lapsed);
    h.talk.delete(ALICE);
    expect(h.waker.wouldDefer(subOf(lapsed), e)).toBe(false);
  });

  it('says no at the recurrence limit, and at the woken-unblock limit', () => {
    const recurring = h.woken();
    expect(h.waker.wouldDefer(subOf(recurring), runBlock(recurring, { blockRecurrences: 3 }))).toBe(false);
    const looped = h.woken();
    for (let i = 0; i < 5; i += 1) {
      runBlock(looped);
      const r = unblock(h.db, looped.taskId, ALICE, undefined, NOW + i, { wake: 1 });
      if (!r.ok) throw new Error(r.message);
    }
    expect(h.waker.wouldDefer(subOf(looped), runBlock(looped))).toBe(false);
  });

  it('says yes once a deferral is written, though nothing else holds any more: the decision is sticky', () => {
    const task = h.woken();
    const e = runBlock(task);
    const sub = subOf(task);
    expect(deferButton(h.db, { subscriptionId: sub.id, eventId: e.id }, NOW).ok).toBe(true);
    h.talk.delete(ALICE);
    letGo = true;
    h.db.prepare('UPDATE kanban_subscriptions SET wake_cursor = ? WHERE id = ?').run(e.id, sub.id);
    expect(h.waker.wouldDefer(subOf(task), e)).toBe(true);
  });
});
