import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordUnblockButtons, unblock } from '../src/db/kanban.js';
import { commentsOf, eventsOf, unblockMessage } from '../src/db/kanban-read.js';
import { renderUnblockRedraw } from '../src/kanban/chat-render.js';
import type { TaskRow } from '../src/kanban/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { NOW, newTask } from './helpers/kanban.js';

/**
 * A woken turn's unblock (wake spec §9.3, §9.4): its `unblocked` event by the
 * wake's principal with `wake` in its payload, its comment steering the next run
 * as `(woken by the board) <comment>`, and the unblock redraw's line naming it
 * "(woken by the board)".
 */

const APP = 'cli_app';
const ZHIXI = 'lark:on_zhixi';

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

function blocked(): { task: TaskRow; block: number } {
  const task = newTask(h.db);
  h.db.prepare("UPDATE kanban_tasks SET phase = 'blocked', blocked_from = 'open', block_kind = 'needs_input' WHERE task_id = ?").run(task.taskId);
  h.db
    .prepare("INSERT INTO kanban_events (task_id, kind, actor, payload, created_at) VALUES (?, 'blocked', 'run:r_1', jsonb('{\"kind\":\"needs_input\",\"reason\":\"which?\"}'), ?)")
    .run(task.taskId, NOW);
  return { task, block: eventsOf(h.db, task.taskId).at(-1)?.id ?? 0 };
}

describe("a woken turn's unblock", () => {
  it("records the wake in the unblocked event, by the wake's principal, and its comment as the board's, steering", () => {
    const { task, block } = blocked();
    const r = unblock(h.db, task.taskId, ZHIXI, 'the second speaker', NOW + 1, { blockedAt: block, wake: 7 });
    expect(r).toMatchObject({ ok: true, task: { phase: 'open' } });
    expect(eventsOf(h.db, task.taskId).find((e) => e.kind === 'unblocked')).toMatchObject({ kind: 'unblocked', actor: ZHIXI, payload: { kind: 'needs_input', wake: 7 } });
    expect(commentsOf(h.db, task.taskId, { steering: true })).toEqual([
      expect.objectContaining({ author: ZHIXI, body: '(woken by the board) the second speaker' }),
    ]);
  });

  it("writes no wake for a person's unblock, and its comment as written", () => {
    const { task } = blocked();
    unblock(h.db, task.taskId, ZHIXI, 'go on', NOW + 1);
    expect(eventsOf(h.db, task.taskId).find((e) => e.kind === 'unblocked')?.payload).toEqual({ kind: 'needs_input' });
    expect(commentsOf(h.db, task.taskId)[0]?.body).toBe('go on');
  });

  it('writes no comment for a woken unblock without one', () => {
    const { task, block } = blocked();
    unblock(h.db, task.taskId, ZHIXI, undefined, NOW + 1, { blockedAt: block, wake: 7 });
    expect(commentsOf(h.db, task.taskId)).toEqual([]);
  });
});

describe('the unblock redraw of a woken lift', () => {
  it('reads the lift as woken, and draws "(woken by the board)"', () => {
    const { task, block } = blocked();
    recordUnblockButtons(h.db, { messageId: 'om_n', channel: 'lark', appId: APP, markdown: 'blocked', buttons: [{ taskId: task.taskId, blockEvent: block }] }, NOW);
    unblock(h.db, task.taskId, ZHIXI, undefined, NOW + 1, { blockedAt: block, wake: 7 });
    const read = unblockMessage(h.db, APP, 'om_n');
    expect(read?.buttons[0]?.lift).toMatchObject({ kind: 'unblocked', actor: ZHIXI, woken: true });
    const view = renderUnblockRedraw(APP, 'blocked', read?.buttons ?? [], () => '14:05', (p) => (p === ZHIXI ? 'Zhixi Sun' : undefined));
    expect(view.markdown).toBe(`blocked\n\n\`${task.taskId}\`: Unblocked by Zhixi Sun (woken by the board) at 14:05`);
    expect(view.buttons).toEqual([]);
  });

  it("reads a person's lift as not woken, and draws it as before", () => {
    const { task, block } = blocked();
    recordUnblockButtons(h.db, { messageId: 'om_n', channel: 'lark', appId: APP, markdown: 'blocked', buttons: [{ taskId: task.taskId, blockEvent: block }] }, NOW);
    unblock(h.db, task.taskId, ZHIXI, undefined, NOW + 1, { blockedAt: block });
    const read = unblockMessage(h.db, APP, 'om_n');
    expect(read?.buttons[0]?.lift).toMatchObject({ woken: false });
    const view = renderUnblockRedraw(APP, 'blocked', read?.buttons ?? [], () => '14:05', (p) => (p === ZHIXI ? 'Zhixi Sun' : undefined));
    expect(view.markdown).toBe(`blocked\n\n\`${task.taskId}\`: Unblocked by Zhixi Sun at 14:05`);
  });
});
