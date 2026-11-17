import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTask } from '../src/db/kanban-read.js';
import { migrate, openDb } from '../src/db/open.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { NOW, newTask } from './helpers/kanban.js';

/**
 * Migration 010 (the cron spec, §3): cron_jobs and cron_fires, their checks,
 * their indexes, and the one running fire a job.
 */

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

function job(id: string, extra: Record<string, unknown> = {}): void {
  const row = {
    job_id: id,
    name: 'Daily PRs',
    schedule: 'every weekday 09:00',
    tz: 'Asia/Shanghai',
    role: 'worker',
    workspace: 'default',
    prompt: 'List the open PRs.',
    script: null,
    delivery_channel: 'lark',
    delivery_account: 'cli_app',
    delivery_chat: 'oc_team',
    state: 'active',
    next_run_at: NOW,
    created_by: 'operator:alice',
    created_via: '{"kind":"operator"}',
    created_at: NOW,
    updated_at: NOW,
    ...extra,
  };
  h.db.prepare(`INSERT INTO cron_jobs (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row));
}

function fire(jobId: string, extra: Record<string, unknown> = {}): number {
  const row = { job_id: jobId, scheduled_at: NOW, trigger: 'schedule', started_at: NOW, ...extra };
  return Number(
    h.db.prepare(`INSERT INTO cron_fires (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row))
      .lastInsertRowid,
  );
}

const indexes = (table: string): string[] =>
  h.db
    .prepare<[string], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name LIKE 'idx_%' ORDER BY name")
    .all(table)
    .map((r) => r.name);

describe('migration 010', () => {
  it('is version 10, with both tables STRICT and their indexes', () => {
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(10);
    const strict = h.db.prepare<[], { name: string; strict: number }>("SELECT name, strict FROM pragma_table_list WHERE name LIKE 'cron_%' ORDER BY name").all();
    expect(strict).toEqual([
      { name: 'cron_fires', strict: 1 },
      { name: 'cron_jobs', strict: 1 },
    ]);
    expect(indexes('cron_jobs')).toEqual(['idx_cron_jobs_chat', 'idx_cron_jobs_due']);
    expect(indexes('cron_fires')).toEqual(['idx_cron_fires_job', 'idx_cron_fires_pending', 'idx_cron_fires_running']);
  });

  it("checks a job's state, its next run while active, its delivery and its created_via", () => {
    job('c_1');
    job('c_2', { state: 'paused', next_run_at: null, delivery_channel: null, delivery_account: null, delivery_chat: null });
    expect(() => job('c_3', { state: 'gone' })).toThrow(/CHECK constraint failed/);
    expect(() => job('c_4', { state: 'paused' })).toThrow(/CHECK constraint failed/);
    expect(() => job('c_5', { next_run_at: null })).toThrow(/CHECK constraint failed/);
    expect(() => job('c_6', { delivery_chat: null })).toThrow(/CHECK constraint failed/);
    expect(() => job('c_7', { delivery_account: null })).toThrow(/CHECK constraint failed/);
    expect(() => job('c_8', { delivery_channel: null, delivery_chat: null })).toThrow(/CHECK constraint failed/);
    expect(() => job('c_9', { created_via: 'not json' })).toThrow(/CHECK constraint failed/);
    job('c_10', { idempotency_key: 'operator:k' });
    expect(() => job('c_11', { idempotency_key: 'operator:k' })).toThrow(/UNIQUE constraint failed/);
    expect(() => job('c_12', { next_run_at: 'soon' })).toThrow(/cannot store TEXT value in INTEGER column/);
  });

  it("checks a fire's trigger, outcome, ending and delivery, and its job", () => {
    job('c_1');
    const skip = fire('c_1', { started_at: null, ended_at: NOW, outcome: 'skipped_missed' });
    expect(skip).toBeGreaterThan(0);
    expect(() => fire('c_1', { trigger: 'manual' })).toThrow(/CHECK constraint failed/);
    expect(() => fire('c_1', { ended_at: NOW, outcome: 'exploded' })).toThrow(/CHECK constraint failed/);
    expect(() => fire('c_1', { ended_at: NOW })).toThrow(/CHECK constraint failed/);
    expect(() => fire('c_1', { outcome: 'posted' })).toThrow(/CHECK constraint failed/);
    expect(() => fire('c_1', { started_at: null })).toThrow(/CHECK constraint failed/);
    expect(() => fire('c_1', { ended_at: NOW, outcome: 'posted', delivery: 'maybe' })).toThrow(/CHECK constraint failed/);
    expect(() => fire('c_none')).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('holds one running fire a job, whatever writes it', () => {
    job('c_1');
    job('c_2');
    fire('c_1');
    expect(() => fire('c_1')).toThrow(/UNIQUE constraint failed/);
    fire('c_2');
    fire('c_1', { ended_at: NOW, outcome: 'posted' });
  });

  it('never gives a fire id again once it is deleted', () => {
    job('c_1');
    const first = fire('c_1', { ended_at: NOW, outcome: 'posted' });
    const second = fire('c_1', { ended_at: NOW, outcome: 'posted' });
    h.db.prepare('DELETE FROM cron_fires WHERE fire_id = ?').run(second);
    expect(fire('c_1', { ended_at: NOW, outcome: 'posted' })).toBe(second + 1);
    expect(second).toBe(first + 1);
  });

  it('migrates a database at version 9, with a board in it, as it was', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-cron-schema-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) {
        if (/^00[1-9]_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      }
      const d = openDb(join(dir, 'team.db'));
      try {
        expect(migrate(d, only)).toBe(9);
        const task = newTask(d);
        const before = getTask(d, task.taskId);
        expect(migrate(d, SCHEMA_DIR)).toBe(10);
        expect(getTask(d, task.taskId)).toEqual(before);
        expect(d.prepare('SELECT count(*) AS n FROM cron_jobs').get()).toEqual({ n: 0 });
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
