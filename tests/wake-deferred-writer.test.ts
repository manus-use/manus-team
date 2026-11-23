import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buttonDue,
  buttonFailed,
  buttonLifted,
  buttonSent,
  buttonTried,
  deferButton,
  recordUnblockButtons,
  setWake,
} from '../src/db/kanban.js';
import { deferredButton, deferredButtons, eventsOf, subscriptionsOf, unblockMessage } from '../src/db/kanban-read.js';
import type { TaskRow } from '../src/kanban/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, newTask } from './helpers/kanban.js';

/**
 * The deferred Unblock buttons' writers and reads (wake spec §4.3, §5.9): a row
 * `held` at most once a subscription and block, written after its notice's
 * send; its state moving forward only, each write only from the state it names;
 * and a buttonless notice recorded with `has_button` 0, read with its deferred
 * button's state, so the unblock redraw can add its lifted line.
 */

const APP = 'cli_app';
const VIA_THREAD = { kind: 'chat', channel: 'lark', appId: APP, conversationId: 'oc_chat', threadId: 'omt_1', rootId: 'om_root' } as const;

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

function blocked(): { task: TaskRow; sub: number; block: number } {
  const task = newTask(h.db, { createdVia: VIA_THREAD });
  setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5 }, ALICE, APP, NOW);
  h.db.prepare("UPDATE kanban_tasks SET phase = 'blocked', blocked_from = 'open', block_kind = 'needs_input' WHERE task_id = ?").run(task.taskId);
  h.db
    .prepare("INSERT INTO kanban_events (task_id, kind, actor, payload, created_at) VALUES (?, 'blocked', 'run:r_1', jsonb('{\"kind\":\"needs_input\",\"reason\":\"which?\"}'), ?)")
    .run(task.taskId, NOW);
  const block = eventsOf(h.db, task.taskId).at(-1)?.id ?? 0;
  return { task, sub: subscriptionsOf(h.db, task.taskId)[0]?.id ?? 0, block };
}

describe('deferButton', () => {
  it('writes the row held, with its task, its bot and the send time, at most once a subscription and block', () => {
    const b = blocked();
    const key = { subscriptionId: b.sub, eventId: b.block };
    expect(deferButton(h.db, key, NOW + 10)).toEqual({ ok: true, deferred: true });
    expect(deferredButton(h.db, b.sub, b.block)).toEqual({
      subscriptionId: b.sub,
      eventId: b.block,
      taskId: b.task.taskId,
      appId: APP,
      heldAt: NOW + 10,
      state: 'held',
      why: null,
      attempts: 0,
      messageId: null,
      endedAt: null,
    });
    // A notice sent again, after a restart or a failed record: the first row stands.
    expect(deferButton(h.db, key, NOW + 99)).toEqual({ ok: true, deferred: false });
    expect(deferredButton(h.db, b.sub, b.block)?.heldAt).toBe(NOW + 10);
  });

  it('refuses a subscription that does not exist, or an event of another task', () => {
    const b = blocked();
    const other = newTask(h.db);
    expect(deferButton(h.db, { subscriptionId: 9999, eventId: b.block }, NOW)).toMatchObject({ ok: false, code: 'not_found' });
    const otherEvent = eventsOf(h.db, other.taskId)[0]?.id ?? 0;
    expect(deferButton(h.db, { subscriptionId: b.sub, eventId: otherEvent }, NOW)).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('the deferred button moves forward only', () => {
  it('goes held to due with its why, then due to sent with the card, ended once', () => {
    const b = blocked();
    const key = { subscriptionId: b.sub, eventId: b.block };
    deferButton(h.db, key, NOW);
    expect(buttonSent(h.db, key, 'om_card', NOW + 1)).toEqual({ ok: true, changed: false });
    expect(buttonDue(h.db, key, 'tried')).toEqual({ ok: true, changed: true });
    expect(buttonDue(h.db, key, 'running')).toEqual({ ok: true, changed: false });
    expect(deferredButton(h.db, b.sub, b.block)).toMatchObject({ state: 'due', why: 'tried', endedAt: null });
    expect(buttonTried(h.db, key)).toEqual({ ok: true, attempts: 1 });
    expect(buttonTried(h.db, key)).toEqual({ ok: true, attempts: 2 });
    expect(buttonSent(h.db, key, 'om_card', NOW + 5)).toEqual({ ok: true, changed: true });
    expect(deferredButton(h.db, b.sub, b.block)).toMatchObject({ state: 'sent', messageId: 'om_card', endedAt: NOW + 5, attempts: 2 });
    // Ended: nothing moves it again.
    expect(buttonLifted(h.db, key, NOW + 6)).toEqual({ ok: true, changed: false });
    expect(buttonFailed(h.db, key, NOW + 6)).toEqual({ ok: true, changed: false });
    expect(buttonTried(h.db, key)).toEqual({ ok: true, attempts: 2 });
  });

  it('lifts or fails a held row and a due one, but never a sent one', () => {
    const one = blocked();
    const two = blocked();
    const held = { subscriptionId: one.sub, eventId: one.block };
    const due = { subscriptionId: two.sub, eventId: two.block };
    deferButton(h.db, held, NOW);
    deferButton(h.db, due, NOW);
    buttonDue(h.db, due, 'not_woken');
    expect(buttonLifted(h.db, held, NOW + 3)).toEqual({ ok: true, changed: true });
    expect(buttonFailed(h.db, due, NOW + 4)).toEqual({ ok: true, changed: true });
    expect(deferredButton(h.db, one.sub, one.block)).toMatchObject({ state: 'lifted', endedAt: NOW + 3 });
    expect(deferredButton(h.db, two.sub, two.block)).toMatchObject({ state: 'failed', endedAt: NOW + 4, why: 'not_woken' });
  });

  it('lists the held and due rows of this bot, oldest held first, and no ended one', () => {
    const one = blocked();
    const two = blocked();
    const three = blocked();
    deferButton(h.db, { subscriptionId: two.sub, eventId: two.block }, NOW + 1);
    deferButton(h.db, { subscriptionId: one.sub, eventId: one.block }, NOW + 2);
    deferButton(h.db, { subscriptionId: three.sub, eventId: three.block }, NOW + 3);
    buttonDue(h.db, { subscriptionId: one.sub, eventId: one.block }, 'restart');
    buttonLifted(h.db, { subscriptionId: three.sub, eventId: three.block }, NOW + 4);
    expect(deferredButtons(h.db, APP).map((r) => [r.taskId, r.state])).toEqual([
      [two.task.taskId, 'held'],
      [one.task.taskId, 'due'],
    ]);
    expect(deferredButtons(h.db, 'cli_other')).toEqual([]);
  });
});

describe('a buttonless notice, recorded for the redraw', () => {
  it('records has_button 0 beside a real button, and reads each with its deferred state', () => {
    const deferred = blocked();
    const real = blocked();
    deferButton(h.db, { subscriptionId: deferred.sub, eventId: deferred.block }, NOW);
    const r = recordUnblockButtons(
      h.db,
      {
        messageId: 'om_n',
        channel: 'lark',
        appId: APP,
        markdown: 'two blocks',
        buttons: [
          { taskId: deferred.task.taskId, blockEvent: deferred.block, hasButton: false },
          { taskId: real.task.taskId, blockEvent: real.block },
        ],
      },
      NOW,
    );
    expect(r).toEqual({ ok: true, recorded: 2 });
    const read = unblockMessage(h.db, APP, 'om_n');
    expect(read?.buttons.map((b) => [b.taskId, b.hasButton, b.deferred])).toEqual([
      [deferred.task.taskId, false, 'held'],
      [real.task.taskId, true, undefined],
    ]);
    buttonDue(h.db, { subscriptionId: deferred.sub, eventId: deferred.block }, 'tried');
    buttonSent(h.db, { subscriptionId: deferred.sub, eventId: deferred.block }, 'om_card', NOW + 1);
    expect(unblockMessage(h.db, APP, 'om_n')?.buttons[0]?.deferred).toBe('sent');
  });

  it('records every row of a message as a button when none says otherwise, as before', () => {
    const b = blocked();
    recordUnblockButtons(h.db, { messageId: 'om_m', channel: 'lark', appId: APP, markdown: 'one', buttons: [{ taskId: b.task.taskId, blockEvent: b.block }] }, NOW);
    expect(h.db.prepare<[], { has_button: number }>("SELECT has_button FROM kanban_unblock_buttons WHERE message_id = 'om_m'").get()?.has_button).toBe(1);
    expect(unblockMessage(h.db, APP, 'om_m')?.buttons[0]).toMatchObject({ hasButton: true });
  });
});
