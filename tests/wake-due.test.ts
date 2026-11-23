import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advanceSubscription, advanceWake, archive, recordWake, setWake, unblock, wakeSubmitted } from '../src/db/kanban.js';
import { dueWakes, eventsOf, liftOf, pendingWakes, subscriptionsOf, unblockMessage } from '../src/db/kanban-read.js';
import { recordUnblockButtons } from '../src/db/kanban.js';
import { bindSession, revokeBindingsAt } from '../src/db/bindings.js';
import { createSession } from '../src/db/sessions.js';
import type { BindingKey } from '../src/types.js';
import type { TaskRow } from '../src/kanban/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, newTask } from './helpers/kanban.js';

/**
 * What the waker reads (wake spec §5.2, §5.3b): `liftOf`, the lift of a block,
 * shared with the unblock redraw; `dueWakes`, the subscriptions with wake on and
 * an event past the wake cursor and at or before the notice cursor, a
 * conversation with a pending row left out but for a stamped row whose session is
 * no longer bound; and `pendingWakes`.
 */

const APP = 'cli_app';
const VIA_THREAD = { kind: 'chat', channel: 'lark', appId: APP, conversationId: 'oc_chat', threadId: 'omt_1', rootId: 'om_root' } as const;
const KEY: BindingKey = { channel: 'lark', appId: APP, conversationId: 'oc_chat', threadId: 'omt_1' };

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

function comment(taskId: string): number {
  h.db.prepare("INSERT INTO kanban_events (task_id, kind, actor, payload, created_at) VALUES (?, 'commented', ?, jsonb('{}'), ?)").run(taskId, ALICE, NOW);
  return eventsOf(h.db, taskId).at(-1)?.id ?? 0;
}

function noticed(task: TaskRow): void {
  const last = eventsOf(h.db, task.taskId).at(-1)?.id ?? 0;
  for (const s of subscriptionsOf(h.db, task.taskId)) advanceSubscription(h.db, s.id, last);
}

function woken(): TaskRow {
  const task = newTask(h.db, { createdVia: VIA_THREAD });
  setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5 }, ALICE, APP, NOW);
  return task;
}

function blocked(task: TaskRow): number {
  h.db.prepare("UPDATE kanban_tasks SET phase = 'blocked', blocked_from = 'open', block_kind = 'needs_input' WHERE task_id = ?").run(task.taskId);
  h.db
    .prepare("INSERT INTO kanban_events (task_id, kind, actor, payload, created_at) VALUES (?, 'blocked', 'run:r_1', jsonb('{\"kind\":\"needs_input\",\"reason\":\"which?\"}'), ?)")
    .run(task.taskId, NOW);
  return eventsOf(h.db, task.taskId).at(-1)?.id ?? 0;
}

describe('liftOf', () => {
  it("answers the first unblock or archive past the block, and nothing before one", () => {
    const task = newTask(h.db);
    const block = blocked(task);
    expect(liftOf(h.db, task.taskId, block)).toBeUndefined();
    unblock(h.db, task.taskId, 'lark:on_bob', undefined, NOW + 5);
    const lift = eventsOf(h.db, task.taskId).at(-1);
    expect(liftOf(h.db, task.taskId, block)).toEqual({ eventId: lift?.id, kind: 'unblocked', actor: 'lark:on_bob', at: NOW + 5 });
  });

  it('counts an archive as a lift', () => {
    const task = newTask(h.db);
    const block = blocked(task);
    archive(h.db, task.taskId, ALICE, NOW + 7);
    expect(liftOf(h.db, task.taskId, block)).toMatchObject({ kind: 'archived', actor: ALICE, at: NOW + 7 });
  });

  it("agrees with the unblock redraw's reading of a button's lift", () => {
    const task = newTask(h.db);
    const block = blocked(task);
    recordUnblockButtons(h.db, { messageId: 'om_n', channel: 'lark', appId: APP, markdown: 'blocked', buttons: [{ taskId: task.taskId, blockEvent: block }] }, NOW);
    unblock(h.db, task.taskId, 'lark:on_bob', undefined, NOW + 5);
    expect(unblockMessage(h.db, APP, 'om_n')?.buttons[0]?.lift).toEqual(liftOf(h.db, task.taskId, block));
  });
});

describe('dueWakes', () => {
  it("lists a woken task's subscription once its notice cursor has passed an event past its wake cursor", () => {
    const task = woken();
    const event = comment(task.taskId);
    // The notice has not gone yet: nothing is due.
    expect(dueWakes(h.db, APP)).toEqual([]);
    noticed(task);
    expect(dueWakes(h.db, APP)).toEqual([expect.objectContaining({ taskId: task.taskId, oldestDue: event })]);
  });

  it('leaves out a task with wake off, and another bot', () => {
    const off = newTask(h.db, { createdVia: VIA_THREAD });
    comment(off.taskId);
    noticed(off);
    expect(dueWakes(h.db, APP)).toEqual([]);
    const task = woken();
    comment(task.taskId);
    noticed(task);
    expect(dueWakes(h.db, 'cli_other')).toEqual([]);
  });

  it('leaves out a conversation with a pending row, for every principal', () => {
    const a = woken();
    const b = newTask(h.db, { createdVia: VIA_THREAD });
    setWake(h.db, b.taskId, { on: true, as: 'lark:on_bob', maxDepth: 5 }, 'lark:on_bob', APP, NOW);
    const ea = comment(a.taskId);
    comment(b.taskId);
    noticed(a);
    noticed(b);
    const sub = subscriptionsOf(h.db, a.taskId)[0]?.id ?? 0;
    const r = recordWake(h.db, { uuid: 'u1', channel: 'lark', appId: APP, conversationId: 'oc_chat', threadId: 'omt_1', principal: ALICE, depth: 0, events: [{ subscriptionId: sub, eventId: ea, taskId: a.taskId }] }, NOW);
    if (!r.ok) throw new Error(r.message);
    expect(dueWakes(h.db, APP)).toEqual([]);
    expect(pendingWakes(h.db, APP).map((w) => w.wakeId)).toEqual([r.wake.wakeId]);
    // Once it is delivered, the conversation is read again.
    advanceWake(h.db, r.wake.wakeId, NOW + 1);
    expect(pendingWakes(h.db, APP)).toEqual([]);
    expect(dueWakes(h.db, APP).map((d) => d.taskId)).toEqual([b.taskId]);
  });

  it("holds the conversation for a stamped row while its session is still bound, and releases it once another is, without its events", () => {
    const a = woken();
    const ea = comment(a.taskId);
    noticed(a);
    const sub = subscriptionsOf(h.db, a.taskId)[0]?.id ?? 0;
    createSession(h.db, { id: 's_old', agentId: 'default', workspaceId: 'default', ownerPrincipal: ALICE }, NOW);
    bindSession(h.db, KEY, 's_old', NOW);
    const r = recordWake(h.db, { uuid: 'u1', channel: 'lark', appId: APP, conversationId: 'oc_chat', threadId: 'omt_1', principal: ALICE, depth: 0, events: [{ subscriptionId: sub, eventId: ea, taskId: a.taskId }] }, NOW);
    if (!r.ok) throw new Error(r.message);
    wakeSubmitted(h.db, r.wake.wakeId, 's_old', 'key-1', 'boot-a');
    expect(dueWakes(h.db, APP)).toEqual([]);
    // /new: another session is bound at the key.
    createSession(h.db, { id: 's_new', agentId: 'default', workspaceId: 'default', ownerPrincipal: ALICE }, NOW + 1);
    revokeBindingsAt(h.db, KEY, NOW + 1);
    bindSession(h.db, KEY, 's_new', NOW + 1);
    // Released, but the hung row's event is not read again.
    expect(dueWakes(h.db, APP)).toEqual([]);
    const later = comment(a.taskId);
    noticed(a);
    expect(dueWakes(h.db, APP)).toEqual([expect.objectContaining({ taskId: a.taskId, oldestDue: later })]);
  });

  it('counts only events past the wake cursor', () => {
    const task = woken();
    comment(task.taskId);
    noticed(task);
    const [d] = dueWakes(h.db, APP);
    expect(d?.oldestDue).toBeGreaterThan(subscriptionsOf(h.db, task.taskId)[0]?.wakeCursor ?? 0);
  });
});
