import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boardList, dueSubscriptions, getTask, subscriptionsOf } from '../src/db/kanban-read.js';
import { migrate, openDb } from '../src/db/open.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { NOW, newTask } from './helpers/kanban.js';

/**
 * A task's and a subscription's wake columns, as the reads give them (wake spec
 * §4.1, migration 013): wake off at depth 0 for every task until something sets
 * it, the waker's cursor at 0, and no chat type.
 */

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

describe('the wake columns, read', () => {
  it('reads a new task with wake off, at depth 0, targeting no role, made under no wake', () => {
    const task = newTask(h.db);
    expect(getTask(h.db, task.taskId)).toMatchObject({ wakeBy: null, wakeDepth: 0, wakeRole: null, reactionOf: null, wakeRoot: null, wakeCursor: 0 });
  });

  it('reads what the columns hold', () => {
    const task = newTask(h.db);
    h.db
      .prepare("UPDATE kanban_tasks SET wake_by = 'lark:on_alice', wake_depth = 2, wake_role = 'coordinator', reaction_of = 7, wake_root = 'k_root', wake_cursor = 5 WHERE task_id = ?")
      .run(task.taskId);
    expect(getTask(h.db, task.taskId)).toMatchObject({
      wakeBy: 'lark:on_alice',
      wakeDepth: 2,
      wakeRole: 'coordinator',
      reactionOf: 7,
      wakeRoot: 'k_root',
      wakeCursor: 5,
    });
  });

  it("reads a subscription's wake cursor and chat type, in its reads and in what is due", () => {
    const task = newTask(h.db);
    expect(subscriptionsOf(h.db, task.taskId)).toEqual([expect.objectContaining({ wakeCursor: 0, chatType: null })]);
    h.db.prepare("UPDATE kanban_subscriptions SET wake_cursor = 1, chat_type = 'group' WHERE task_id = ?").run(task.taskId);
    expect(subscriptionsOf(h.db, task.taskId)).toEqual([expect.objectContaining({ wakeCursor: 1, chatType: 'group' })]);
    expect(dueSubscriptions(h.db, 'cli_app')).toEqual([expect.objectContaining({ taskId: task.taskId, wakeCursor: 1, chatType: 'group' })]);
  });

  it('reads a database not yet migrated to 013, as the terminal may open one, as wake off with its cursors at 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-wake-rows-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) {
        if (/^0(0[1-9]|1[0-2])_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      }
      const d = openDb(join(dir, 'team.db'));
      try {
        expect(migrate(d, only)).toBe(12);
        d.prepare(
          `INSERT INTO kanban_tasks (task_id, title, contract, phase, created_by, created_via, created_at)
           VALUES ('k_old', 'from before', jsonb('{}'), 'open', 'lark:on_alice', jsonb('{}'), ?)`,
        ).run(NOW);
        d.prepare(
          `INSERT INTO kanban_subscriptions (task_id, channel, account_id, conversation_id, created_at)
           VALUES ('k_old', 'lark', 'cli_app', 'oc_chat', ?)`,
        ).run(NOW);
        expect(getTask(d, 'k_old')).toMatchObject({ wakeBy: null, wakeDepth: 0, wakeRole: null, reactionOf: null, wakeRoot: null, wakeCursor: 0 });
        expect(boardList(d).map((e) => e.task)).toEqual([expect.objectContaining({ taskId: 'k_old', wakeBy: null })]);
        expect(subscriptionsOf(d, 'k_old')).toEqual([expect.objectContaining({ wakeCursor: 0, chatType: null })]);
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
