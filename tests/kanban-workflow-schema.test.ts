import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newWorkflowId } from '../src/core/ids.js';
import { getTask } from '../src/db/kanban-read.js';
import { migrate, openDb } from '../src/db/open.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { NOW, claimed, newTask } from './helpers/kanban.js';

/**
 * Migration 009 (workflows spec §7): an instance and its members, two tables of their
 * own, with their keys and indexes, and an index on a task's created_from_task.
 */

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

function instance(id: string, extra: Record<string, unknown> = {}): void {
  const row = {
    instance_id: id,
    name: 'vendor-eval',
    dag: '{"format":1}',
    dag_sha256: 'a'.repeat(64),
    source: 'start',
    board: 'default',
    created_by: 'lark:on_alice',
    created_via: '{"kind":"operator"}',
    idempotency_key: null,
    created_at: NOW,
    ...extra,
  };
  h.db
    .prepare(`INSERT INTO kanban_workflow_instances (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`)
    .run(...Object.values(row));
}

function member(taskId: string, instanceId: string, ref: string, position: number): void {
  h.db
    .prepare('INSERT INTO kanban_workflow_tasks (task_id, instance_id, ref, step, item, position) VALUES (?, ?, ?, ?, NULL, ?)')
    .run(taskId, instanceId, ref, ref, position);
}

const indexes = (table: string): string[] =>
  h.db
    .prepare<[string], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name LIKE 'idx_%' ORDER BY name")
    .all(table)
    .map((r) => r.name);

describe('migration 009', () => {
  it('is past version 9, with both tables STRICT and the members WITHOUT ROWID', () => {
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBeGreaterThanOrEqual(9);
    const rows = h.db
      .prepare<[], { name: string; strict: number; wr: number }>(
        "SELECT name, strict, wr FROM pragma_table_list WHERE name LIKE 'kanban_workflow_%' ORDER BY name",
      )
      .all();
    expect(rows).toEqual([
      { name: 'kanban_workflow_instances', strict: 1, wr: 0 },
      { name: 'kanban_workflow_tasks', strict: 1, wr: 1 },
    ]);
    expect(indexes('kanban_workflow_instances')).toEqual(['idx_kanban_workflow_instances_board']);
    expect(indexes('kanban_tasks')).toContain('idx_kanban_tasks_created_from');
  });

  it('keeps a ref and a position unique in an instance, and a task in one instance at most', () => {
    const [a, b, c] = [newTask(h.db), newTask(h.db), newTask(h.db)];
    instance('w_1');
    instance('w_2');
    member(a.taskId, 'w_1', 'shortlist', 0);
    expect(() => member(b.taskId, 'w_1', 'shortlist', 1)).toThrow(/UNIQUE constraint failed/);
    expect(() => member(b.taskId, 'w_1', 'evaluate:1', 0)).toThrow(/UNIQUE constraint failed/);
    expect(() => member(a.taskId, 'w_2', 'shortlist', 0)).toThrow(/UNIQUE constraint failed/);
    member(b.taskId, 'w_1', 'evaluate:1', 1);
    member(c.taskId, 'w_2', 'shortlist', 0);
  });

  it('refuses a member of no task or no instance, an instance on no board, a key twice, and a source of another kind', () => {
    const a = newTask(h.db);
    instance('w_1', { idempotency_key: 'operator:k' });
    expect(() => member('k_none', 'w_1', 'x', 0)).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => member(a.taskId, 'w_none', 'x', 0)).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => instance('w_2', { board: 'nowhere' })).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => instance('w_3', { idempotency_key: 'operator:k' })).toThrow(/UNIQUE constraint failed/);
    expect(() => instance('w_4', { source: 'render' })).toThrow(/CHECK constraint failed/);
    expect(() => instance('w_5', { dag: 'not json' })).toThrow(/CHECK constraint failed/);
  });

  it('migrates a database at version 8, its tasks as they were', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-wf-schema-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) {
        if (/^00[1-8]_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      }
      const d = openDb(join(dir, 'team.db'));
      try {
        expect(migrate(d, only)).toBe(8);
        const task = newTask(d);
        // A task made by a run of another, its created_from_task set: the index 009 adds is on that column.
        const run = claimed(d, task.taskId);
        const follow = newTask(d, { createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } });
        expect(follow.createdFromTask).toBe(task.taskId);
        const before = [getTask(d, task.taskId), getTask(d, follow.taskId)];
        expect(migrate(d, SCHEMA_DIR)).toBe(14);
        expect([getTask(d, task.taskId), getTask(d, follow.taskId)]).toEqual(before);
        expect(d.prepare('SELECT task_id FROM kanban_tasks WHERE created_from_task = ?').all(task.taskId)).toEqual([{ task_id: follow.taskId }]);
        expect(d.prepare('SELECT count(*) AS n FROM kanban_workflow_instances').get()).toEqual({ n: 0 });
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('newWorkflowId', () => {
  it('is w_ and twelve characters of the ids alphabet, a new one each time', () => {
    const a = newWorkflowId();
    expect(a).toMatch(/^w_[0-9a-hjkmnp-tv-z]{12}$/);
    expect(newWorkflowId()).not.toBe(a);
  });
});
