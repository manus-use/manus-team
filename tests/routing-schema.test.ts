import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb } from '../src/db/open.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { NOW, newTask } from './helpers/kanban.js';

/**
 * Migration 015 (workflow routing spec §8): an instance's frozen plan and its
 * fault mark; a pending step's one row, moving once from `waiting`; a member's
 * settling, keyed by its step and ref; a route, keyed by its handler and the
 * event it routed.
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

function insert(table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  h.db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row));
}

function instance(id = 'w_1', extra: Record<string, unknown> = {}): void {
  insert('kanban_workflow_instances', {
    instance_id: id,
    name: 'vi-workflow',
    dag: '{}',
    dag_sha256: 'x',
    source: 'start',
    board: 'default',
    created_by: 'lark:on_alice',
    created_via: '{}',
    created_at: NOW,
    ...extra,
  });
}

describe('migration 015', () => {
  it('is migrated to version 15, its three tables STRICT, the pending and settled rows WITHOUT ROWID, with their indexes', () => {
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(15);
    expect(h.db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 15 });
    const strict = h.db
      .prepare<[], { name: string; strict: number; wr: number }>(
        "SELECT name, strict, wr FROM pragma_table_list WHERE name IN ('kanban_workflow_pending', 'kanban_workflow_settled', 'kanban_workflow_routes') ORDER BY name",
      )
      .all();
    expect(strict).toEqual([
      { name: 'kanban_workflow_pending', strict: 1, wr: 1 },
      { name: 'kanban_workflow_routes', strict: 1, wr: 0 },
      { name: 'kanban_workflow_settled', strict: 1, wr: 1 },
    ]);
    expect(indexes('kanban_workflow_pending')).toEqual(['idx_kanban_workflow_pending_waiting']);
    expect(indexes('kanban_workflow_routes')).toEqual(['idx_kanban_workflow_routes_from', 'idx_kanban_workflow_routes_task']);
    expect(indexes('kanban_workflow_settled')).toEqual([]);
    // The faulted instances, which the dispatcher's retry reads every pass, by a partial index.
    expect(indexes('kanban_workflow_instances')).toContain('idx_kanban_workflow_instances_faulted');
  });

  it("gives an instance a plan, checked to be JSON, and a fault mark, both null unless written", () => {
    instance();
    expect(h.db.prepare("SELECT plan, routing_failed_at FROM kanban_workflow_instances WHERE instance_id = 'w_1'").get()).toEqual({ plan: null, routing_failed_at: null });
    expect(() => instance('w_2', { plan: 'not json' })).toThrow(/CHECK constraint failed/);
    instance('w_3', { plan: '{"format":1,"steps":[]}', routing_failed_at: NOW });
  });

  it('keys a pending row by its instance and step, decided_at set exactly when it is no longer waiting', () => {
    instance();
    insert('kanban_workflow_pending', { instance_id: 'w_1', step: 'va', state: 'waiting' });
    expect(() => insert('kanban_workflow_pending', { instance_id: 'w_1', step: 'va', state: 'waiting' })).toThrow(/UNIQUE constraint failed/);
    expect(() => insert('kanban_workflow_pending', { instance_id: 'w_1', step: 'verify', state: 'skipped' })).toThrow(/CHECK constraint failed/);
    expect(() => insert('kanban_workflow_pending', { instance_id: 'w_1', step: 'patch', state: 'waiting', decided_at: NOW })).toThrow(/CHECK constraint failed/);
    expect(() => insert('kanban_workflow_pending', { instance_id: 'w_1', step: 'report', state: 'done', decided_at: NOW })).toThrow(/CHECK constraint failed/);
    expect(() => insert('kanban_workflow_pending', { instance_id: 'w_1', step: 'exposure', state: 'made', decided_at: NOW, items: '[' })).toThrow(/CHECK constraint failed/);
    insert('kanban_workflow_pending', { instance_id: 'w_1', step: 'exposure', state: 'made', decided_at: NOW, items: '[]', reason: '{}', cause_event: 7 });
    expect(() => insert('kanban_workflow_pending', { instance_id: 'w_9', step: 'va', state: 'waiting' })).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('keys a settled row by its instance, step and ref, with one of four ways', () => {
    instance();
    const task = newTask(h.db);
    insert('kanban_workflow_settled', { instance_id: 'w_1', step: 'va', ref: 'va', how: 'done', task_id: task.taskId, event_id: 3, settled_at: NOW });
    insert('kanban_workflow_settled', { instance_id: 'w_1', step: 'exposure', ref: 'exposure:1', how: 'archived', event_id: 4, settled_at: NOW });
    expect(() => insert('kanban_workflow_settled', { instance_id: 'w_1', step: 'va', ref: 'va', how: 'stood_in', event_id: 5, settled_at: NOW })).toThrow(/UNIQUE constraint failed/);
    expect(() => insert('kanban_workflow_settled', { instance_id: 'w_1', step: 'x', ref: 'x', how: 'made', event_id: 5, settled_at: NOW })).toThrow(/CHECK constraint failed/);
    expect(() => insert('kanban_workflow_settled', { instance_id: 'w_1', step: 'y', ref: 'y', how: 'done', task_id: 'k_none', event_id: 5, settled_at: NOW })).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('keys a route row by its instance, handler and event, its task set exactly when it was made', () => {
    instance();
    const from = newTask(h.db);
    const handler = newTask(h.db);
    insert('kanban_workflow_routes', { instance_id: 'w_1', handler: 'escalate', event_id: 9, from_task: from.taskId, outcome: 'made', task_id: handler.taskId, created_at: NOW });
    insert('kanban_workflow_routes', { instance_id: 'w_1', handler: 'escalate', event_id: 12, from_task: from.taskId, outcome: 'over_limit', created_at: NOW });
    expect(() =>
      insert('kanban_workflow_routes', { instance_id: 'w_1', handler: 'escalate', event_id: 9, from_task: from.taskId, outcome: 'over_cap', created_at: NOW }),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      insert('kanban_workflow_routes', { instance_id: 'w_1', handler: 'escalate', event_id: 13, from_task: from.taskId, outcome: 'made', created_at: NOW }),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      insert('kanban_workflow_routes', {
        instance_id: 'w_1',
        handler: 'escalate',
        event_id: 14,
        from_task: from.taskId,
        outcome: 'over_cap',
        task_id: handler.taskId,
        created_at: NOW,
      }),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      insert('kanban_workflow_routes', { instance_id: 'w_1', handler: 'escalate', event_id: 15, from_task: from.taskId, outcome: 'routed', created_at: NOW }),
    ).toThrow(/CHECK constraint failed/);
  });

  it('migrates a database at version 14 with an instance in it: its plan and fault mark null, no row in the three tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-routing-schema-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) {
        if (/^01[0-4]_.*\.sql$/.test(f) || /^00[1-9]_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      }
      const d = openDb(join(dir, 'team.db'));
      try {
        expect(migrate(d, only)).toBe(14);
        // Written as version 14 wrote it, not through today's writer.
        d.prepare(
          `INSERT INTO kanban_workflow_instances (instance_id, name, dag, dag_sha256, source, board, created_by, created_via, created_at)
           VALUES ('w_old', 'vendor-eval', '{}', 'x', 'start', 'default', 'lark:on_alice', '{}', ?)`,
        ).run(NOW);
        expect(migrate(d, SCHEMA_DIR)).toBe(15);
        expect(d.prepare("SELECT plan, routing_failed_at FROM kanban_workflow_instances WHERE instance_id = 'w_old'").get()).toEqual({
          plan: null,
          routing_failed_at: null,
        });
        for (const table of ['kanban_workflow_pending', 'kanban_workflow_settled', 'kanban_workflow_routes']) {
          expect(d.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        }
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
