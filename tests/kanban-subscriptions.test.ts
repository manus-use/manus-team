import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advanceSubscription, createTask, endRun, DEFAULT_LIMITS } from '../src/db/kanban.js';
import {
  boardList,
  dueSubscriptions,
  eventsAfter,
  eventsOf,
  subscriptionsOf,
} from '../src/db/kanban-read.js';
import type { CreatedVia } from '../src/kanban/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed, newTask } from './helpers/kanban.js';

/**
 * Subscriptions (spec §9.4): the chat a task is created in follows it, and the
 * chats following a task follow the tasks its runs create. A cursor moves only
 * forward, and writes no event of its own.
 */

let h: TestDb;

beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

const THREAD: CreatedVia = { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' };
const OTHER_BOT: CreatedVia = { kind: 'chat', channel: 'lark', appId: 'cli_other', conversationId: 'oc_chat', threadId: '' };

describe('subscriptions', () => {
  it('subscribes the chat a task is created in, at cursor 0, writing no event of its own', () => {
    const task = newTask(h.db, { createdVia: THREAD });
    expect(subscriptionsOf(h.db, task.taskId)).toEqual([
      {
        id: expect.any(Number) as number,
        taskId: task.taskId,
        channel: 'lark',
        appId: 'cli_app',
        conversationId: 'oc_team',
        threadId: 'omt_topic',
        cursor: 0,
        createdAt: NOW,
      },
    ]);
    expect(eventsOf(h.db, task.taskId).map((e) => e.kind)).toEqual(['created']);
  });

  it('subscribes nothing twice when a create is repeated with its key', () => {
    const first = newTask(h.db, { idempotencyKey: 'lark:om_1' });
    const again = createTask(
      h.db,
      { title: 'a task', idempotencyKey: 'lark:om_1', createdBy: ALICE, createdVia: VIA },
      NOW,
    );
    expect(again).toMatchObject({ ok: true, existing: true, task: { taskId: first.taskId } });
    expect(subscriptionsOf(h.db, first.taskId)).toHaveLength(1);
  });

  it("gives a task a run creates every subscription of the run's task", () => {
    const parent = newTask(h.db, { createdVia: THREAD });
    // A second chat following the same task: a subscription is per chat and thread.
    h.db
      .prepare(
        `INSERT INTO kanban_subscriptions (task_id, channel, account_id, conversation_id, thread_id, created_at)
         VALUES (?, 'lark', 'cli_app', 'oc_other', '', ?)`,
      )
      .run(parent.taskId, NOW);
    const run = claimed(h.db, parent.taskId);
    const child = createTask(
      h.db,
      { title: 'a follow-up', createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } },
      NOW,
    );
    if (!child.ok) throw new Error(child.message);
    expect(subscriptionsOf(h.db, child.task.taskId).map((s) => [s.conversationId, s.threadId, s.cursor])).toEqual([
      ['oc_team', 'omt_topic', 0],
      ['oc_other', '', 0],
    ]);
  });

  it('moves a cursor forward only, and refuses a subscription that does not exist', () => {
    const task = newTask(h.db);
    const [sub] = subscriptionsOf(h.db, task.taskId);
    if (sub === undefined) throw new Error('not subscribed');
    expect(advanceSubscription(h.db, sub.id, 5)).toEqual({ ok: true, advanced: true });
    expect(advanceSubscription(h.db, sub.id, 3)).toEqual({ ok: true, advanced: false });
    expect(subscriptionsOf(h.db, task.taskId)[0]?.cursor).toBe(5);
    expect(eventsOf(h.db, task.taskId).map((e) => e.kind)).toEqual(['created']);
    expect(advanceSubscription(h.db, 999, 1)).toEqual({ ok: false, code: 'not_found', message: 'no subscription 999' });
  });

  it("lists this bot's subscriptions with events past their cursor, and the events after a cursor in order", () => {
    const a = newTask(h.db);
    const b = newTask(h.db);
    newTask(h.db, { createdVia: OTHER_BOT });
    const [subA] = subscriptionsOf(h.db, a.taskId);
    const [subB] = subscriptionsOf(h.db, b.taskId);
    if (subA === undefined || subB === undefined) throw new Error('not subscribed');
    expect(dueSubscriptions(h.db, 'cli_app').map((s) => s.taskId)).toEqual([a.taskId, b.taskId]);
    // Each with its oldest event past the cursor: how long it has waited.
    expect(dueSubscriptions(h.db, 'cli_app').map((s) => s.oldestPending)).toEqual([
      eventsOf(h.db, a.taskId)[0]?.id,
      eventsOf(h.db, b.taskId)[0]?.id,
    ]);
    const created = eventsOf(h.db, b.taskId)[0]?.id ?? 0;
    expect(advanceSubscription(h.db, subB.id, created).ok).toBe(true);
    expect(dueSubscriptions(h.db, 'cli_app').map((s) => s.taskId)).toEqual([a.taskId]);
    claimed(h.db, b.taskId);
    expect(dueSubscriptions(h.db, 'cli_app').map((s) => s.taskId)).toEqual([a.taskId, b.taskId]);
    expect(eventsAfter(h.db, b.taskId, created, 10).map((e) => e.kind)).toEqual(['claimed']);
    expect(eventsAfter(h.db, b.taskId, 0, 1).map((e) => e.kind)).toEqual(['created']);
  });

  it('records why a run that ended unreported blocked its task, for the notice', () => {
    const task = newTask(h.db, { failureLimit: 1 });
    const run = claimed(h.db, task.taskId);
    expect(endRun(h.db, run.runId, { outcome: 'failed', error: 'exit 1' }, DEFAULT_LIMITS, NOW).ok).toBe(true);
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({
      kind: 'run_ended',
      payload: { next: 'blocked', blockKind: 'gave_up', blockReason: 'failed 1 times; last failed: exit 1', blockRecurrences: 0 },
    });
  });
});

describe('the board, as /kanban list reads it', () => {
  it('gives every task its derived status, highest priority first, then oldest', () => {
    const parent = newTask(h.db, { title: 'parent' });
    newTask(h.db, { title: 'child', parents: [parent.taskId] });
    const urgent = newTask(h.db, { title: 'urgent', priority: 5 });
    claimed(h.db, urgent.taskId);
    expect(boardList(h.db).map((e) => [e.task.title, e.status])).toEqual([
      ['urgent', 'running'],
      ['parent', 'ready'],
      ['child', 'todo'],
    ]);
  });
});
