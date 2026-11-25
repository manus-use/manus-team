import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb } from '../src/db/open.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { NOW, newTask } from './helpers/kanban.js';

/**
 * Migration 013 (wake spec §4, §5.9, §19): a task's wake and its depth, a
 * subscription's wake cursor and chat type, the woken turns and their events,
 * the deferred Unblock buttons, and a notice recorded without its button.
 */

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

const indexes = (table: string): string[] =>
  h.db
    .prepare<[string], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name LIKE 'idx_%' ORDER BY name")
    .all(table)
    .map((r) => r.name);

const columns = (table: string): Array<{ name: string; dflt_value: string | null; notnull: number }> =>
  h.db.prepare<[string], { name: string; dflt_value: string | null; notnull: number }>('SELECT name, dflt_value, "notnull" FROM pragma_table_info(?)').all(table);

function insert(table: string, row: Record<string, unknown>): number {
  const cols = Object.keys(row);
  return Number(
    h.db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row)).lastInsertRowid,
  );
}

let uuids = 0;
function wake(extra: Record<string, unknown> = {}): number {
  uuids += 1;
  return insert('kanban_wakes', {
    uuid: `u_${uuids}`,
    channel: 'lark',
    app_id: 'cli_app',
    conversation_id: 'oc_chat',
    principal: 'lark:on_alice',
    depth: 0,
    state: 'pending',
    created_at: NOW,
    ...extra,
  });
}

function button(extra: Record<string, unknown> = {}): void {
  insert('kanban_deferred_buttons', {
    subscription_id: 1,
    event_id: 1,
    task_id: 'k_1',
    app_id: 'cli_app',
    held_at: NOW,
    state: 'held',
    ...extra,
  });
}

describe('migration 013', () => {
  it('is migrated past version 13, its three tables STRICT, with their indexes', () => {
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(14);
    expect(h.db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 14 });
    const strict = h.db
      .prepare<[], { name: string; strict: number }>(
        "SELECT name, strict FROM pragma_table_list WHERE name IN ('kanban_wakes', 'kanban_wake_events', 'kanban_deferred_buttons') ORDER BY name",
      )
      .all();
    expect(strict).toEqual([
      { name: 'kanban_deferred_buttons', strict: 1 },
      { name: 'kanban_wake_events', strict: 1 },
      { name: 'kanban_wakes', strict: 1 },
    ]);
    expect(indexes('kanban_wakes')).toEqual(['idx_kanban_wakes_hour', 'idx_kanban_wakes_pending', 'idx_kanban_wakes_reaction', 'idx_kanban_wakes_turn']);
    expect(indexes('kanban_wake_events')).toEqual(['idx_kanban_wake_events_task']);
    expect(indexes('kanban_deferred_buttons')).toEqual(['idx_kanban_deferred_buttons_open']);
  });

  it("gives a task wake off at depth 0, and a subscription its wake cursor at 0 and no chat type", () => {
    const task = newTask(h.db);
    expect(
      h.db.prepare('SELECT wake_by, wake_depth, wake_role, reaction_of, wake_root, wake_cursor FROM kanban_tasks WHERE task_id = ?').get(task.taskId),
    ).toEqual({ wake_by: null, wake_depth: 0, wake_role: null, reaction_of: null, wake_root: null, wake_cursor: 0 });
    expect(columns('kanban_tasks').find((c) => c.name === 'wake_cursor')).toMatchObject({ dflt_value: '0', notnull: 1 });
    expect(h.db.prepare('SELECT wake_cursor, chat_type FROM kanban_subscriptions WHERE task_id = ?').get(task.taskId)).toEqual({
      wake_cursor: 0,
      chat_type: null,
    });
    const sub = columns('kanban_subscriptions').find((c) => c.name === 'wake_cursor');
    expect(sub).toMatchObject({ dflt_value: '0', notnull: 1 });
    expect(columns('kanban_unblock_buttons').find((c) => c.name === 'has_button')).toMatchObject({ dflt_value: '1', notnull: 1 });
  });

  it("checks a subscription's chat type", () => {
    const task = newTask(h.db);
    const set = (type: string): unknown => h.db.prepare('UPDATE kanban_subscriptions SET chat_type = ? WHERE task_id = ?').run(type, task.taskId);
    set('p2p');
    set('group');
    expect(() => set('topic')).toThrow(/CHECK constraint failed/);
  });

  it("checks a wake's state and its stamps", () => {
    wake();
    wake({ state: 'delivered', delivered_at: NOW });
    wake({ state: 'dropped', closed_at: NOW });
    wake({ state: 'lifted', closed_at: NOW });
    wake({ session_id: 's_1', turn_key: 'k', submit_boot: 'b_1' });
    expect(() => wake({ state: 'woken' })).toThrow(/CHECK constraint failed/);
    expect(() => wake({ state: 'delivered' })).toThrow(/CHECK constraint failed/);
    expect(() => wake({ delivered_at: NOW })).toThrow(/CHECK constraint failed/);
    expect(() => wake({ state: 'dropped' })).toThrow(/CHECK constraint failed/);
    expect(() => wake({ closed_at: NOW })).toThrow(/CHECK constraint failed/);
    expect(() => wake({ session_id: 's_1', submit_boot: 'b_1' })).toThrow(/CHECK constraint failed/);
    expect(() => wake({ session_id: 's_1', turn_key: 'k' })).toThrow(/CHECK constraint failed/);
    expect(() => wake({ turn_key: 'k' })).toThrow(/CHECK constraint failed/);
    expect(() => wake({ uuid: 'u_1' })).toThrow(/UNIQUE constraint failed/);
    expect(() => wake({ depth: 'deep' })).toThrow(/cannot store TEXT value in INTEGER column/);
  });

  it("checks a role's wake: a role and its reaction task together, delivered, with no session, one wake a reaction task", () => {
    wake({ state: 'delivered', delivered_at: NOW, target_role: 'coordinator', reaction_task: 'k_r1' });
    expect(() => wake({ state: 'delivered', delivered_at: NOW, target_role: 'coordinator' })).toThrow(/CHECK constraint failed/);
    expect(() => wake({ state: 'delivered', delivered_at: NOW, reaction_task: 'k_r2' })).toThrow(/CHECK constraint failed/);
    expect(() => wake({ target_role: 'coordinator', reaction_task: 'k_r3' })).toThrow(/CHECK constraint failed/);
    expect(() =>
      wake({ state: 'delivered', delivered_at: NOW, target_role: 'coordinator', reaction_task: 'k_r4', session_id: 's_1', turn_key: 'k', submit_boot: 'b' }),
    ).toThrow(/CHECK constraint failed/);
    expect(() => wake({ state: 'delivered', delivered_at: NOW, target_role: 'coordinator', reaction_task: 'k_r1' })).toThrow(/UNIQUE constraint failed/);
  });

  it("keys a wake's events by the wake, the subscription and the event, and refuses a wake that is not there", () => {
    const id = wake();
    insert('kanban_wake_events', { wake_id: id, subscription_id: 1, event_id: 7, task_id: 'k_1' });
    insert('kanban_wake_events', { wake_id: id, subscription_id: 2, event_id: 7, task_id: 'k_2' });
    expect(() => insert('kanban_wake_events', { wake_id: id, subscription_id: 1, event_id: 7, task_id: 'k_1' })).toThrow(/UNIQUE constraint failed/);
    expect(() => insert('kanban_wake_events', { wake_id: id + 100, subscription_id: 1, event_id: 8, task_id: 'k_1' })).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it("checks a deferred button's state, its ending and its card", () => {
    button();
    button({ event_id: 2, state: 'due', why: 'tried' });
    button({ event_id: 3, state: 'sent', message_id: 'om_1', ended_at: NOW });
    button({ event_id: 4, state: 'lifted', ended_at: NOW });
    button({ event_id: 5, state: 'failed', ended_at: NOW });
    expect(() => button({ event_id: 6, state: 'gone' })).toThrow(/CHECK constraint failed/);
    expect(() => button({ event_id: 7, state: 'sent', message_id: 'om_2' })).toThrow(/CHECK constraint failed/);
    expect(() => button({ event_id: 8, state: 'sent', ended_at: NOW })).toThrow(/CHECK constraint failed/);
    expect(() => button({ event_id: 9, ended_at: NOW })).toThrow(/CHECK constraint failed/);
    expect(() => button({ event_id: 10, state: 'lifted', message_id: 'om_3', ended_at: NOW })).toThrow(/CHECK constraint failed/);
    expect(() => button()).toThrow(/UNIQUE constraint failed/);
  });

  it("gives a deferred button its notice's message id, null for a notice that went as text", () => {
    expect(columns('kanban_deferred_buttons').find((c) => c.name === 'notice_id')).toEqual({ name: 'notice_id', notnull: 0, dflt_value: null });
    button({ notice_id: 'om_notice' });
    button({ event_id: 2 });
    expect(h.db.prepare('SELECT event_id, notice_id FROM kanban_deferred_buttons ORDER BY event_id').all()).toEqual([
      { event_id: 1, notice_id: 'om_notice' },
      { event_id: 2, notice_id: null },
    ]);
  });

  it('migrates a database at version 12, with a task and its notice record in it, wake off and every button a button', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-wake-schema-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) {
        if (/^0(0[1-9]|1[0-2])_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      }
      const d = openDb(join(dir, 'team.db'));
      try {
        expect(migrate(d, only)).toBe(12);
        // Written as version 12 wrote them, not through today's writer.
        d.prepare(
          `INSERT INTO kanban_tasks (task_id, title, contract, phase, created_by, created_via, created_at)
           VALUES ('k_old', 'from before', jsonb('{}'), 'open', 'lark:on_alice', jsonb('{}'), ?)`,
        ).run(NOW);
        d.prepare(
          `INSERT INTO kanban_subscriptions (task_id, channel, account_id, conversation_id, created_at)
           VALUES ('k_old', 'lark', 'cli_app', 'oc_chat', ?)`,
        ).run(NOW);
        d.prepare(
          `INSERT INTO kanban_unblock_buttons (message_id, channel, app_id, task_id, block_event, markdown, sent_at)
           VALUES ('om_1', 'lark', 'cli_app', 'k_old', 1, 'blocked', ?)`,
        ).run(NOW);
        expect(migrate(d, SCHEMA_DIR)).toBe(14);
        expect(d.prepare('SELECT wake_by, wake_depth FROM kanban_tasks WHERE task_id = ?').get('k_old')).toEqual({ wake_by: null, wake_depth: 0 });
        expect(d.prepare('SELECT wake_cursor, chat_type FROM kanban_subscriptions WHERE task_id = ?').get('k_old')).toEqual({
          wake_cursor: 0,
          chat_type: null,
        });
        expect(d.prepare('SELECT has_button FROM kanban_unblock_buttons').get()).toEqual({ has_button: 1 });
        expect(d.prepare('SELECT count(*) AS n FROM kanban_wakes').get()).toEqual({ n: 0 });
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
