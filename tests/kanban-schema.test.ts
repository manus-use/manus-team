import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../src/db/sessions.js';
import { testDb, type TestDb } from './helpers/db.js';

/**
 * The shape of the board's tables (spec §3). These tests write raw rows on
 * purpose: they check what the database itself refuses, the backstop under
 * db/kanban.ts's own checks.
 */
const NOW = 1_760_000_000_000;
let h: TestDb;

beforeEach(() => {
  h = testDb();
});

afterEach(() => h.close());

function task(id: string, extra: Record<string, string | number | null> = {}): void {
  const row: Record<string, string | number | null> = {
    task_id: id,
    title: 't',
    phase: 'open',
    created_by: 'test',
    created_at: NOW,
    ...extra,
  };
  const cols = Object.keys(row);
  // The JSON columns are JSONB blobs, as db/kanban.ts writes them.
  h.db
    .prepare(
      `INSERT INTO kanban_tasks (contract, created_via, ${cols.join(', ')})
       VALUES (jsonb('{}'), jsonb('{}'), ${cols.map(() => '?').join(', ')})`,
    )
    .run(...Object.values(row));
}

/** A raw run row; `agent` false leaves agent_config null, as a person's run has it. */
function run(
  id: string,
  taskId: string,
  attempt: number,
  extra: Record<string, string | number | null> = {},
  agent = true,
): void {
  const row: Record<string, string | number | null> = {
    run_id: id,
    task_id: taskId,
    attempt,
    kind: 'work',
    assignee_kind: 'role',
    assignee: 'implementer',
    started_at: NOW,
    ...extra,
  };
  const cols = Object.keys(row);
  h.db
    .prepare(
      `INSERT INTO kanban_runs (agent_config, ${cols.join(', ')})
       VALUES (${agent ? "jsonb('{}')" : 'NULL'}, ${cols.map(() => '?').join(', ')})`,
    )
    .run(...Object.values(row));
}

describe('migration 003', () => {
  it('creates every kanban table, all STRICT', () => {
    // 004 adds a column to kanban_comments and an index; every table is 003's.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(4);
    const tables = h.db
      .prepare<[], { name: string; strict: number }>(
        "SELECT name, strict FROM pragma_table_list WHERE name LIKE 'kanban_%' ORDER BY name",
      )
      .all();
    expect(tables).toEqual([
      { name: 'kanban_comments', strict: 1 },
      { name: 'kanban_events', strict: 1 },
      { name: 'kanban_gates', strict: 1 },
      { name: 'kanban_links', strict: 1 },
      { name: 'kanban_runs', strict: 1 },
      { name: 'kanban_subscriptions', strict: 1 },
      { name: 'kanban_tasks', strict: 1 },
    ]);
  });

  it('allows one open run per task, and another once it is closed', () => {
    // Two dispatch passes racing to claim one task fail here instead of starting two agents.
    task('k_1');
    run('r_1', 'k_1', 1);
    expect(() => run('r_2', 'k_1', 2)).toThrow(/UNIQUE constraint failed/);
    h.db.prepare("UPDATE kanban_runs SET outcome = 'failed', ended_at = ? WHERE run_id = 'r_1'").run(NOW);
    run('r_2', 'k_1', 2);
  });

  it('refuses two runs with one token hash', () => {
    // The worker CLI finds a run by its token's hash (plan C3).
    task('k_1');
    task('k_2');
    run('r_1', 'k_1', 1, { token_hash: 'hash-of-token' });
    expect(() => run('r_2', 'k_2', 1, { token_hash: 'hash-of-token' })).toThrow(/UNIQUE constraint failed/);
    run('r_3', 'k_2', 1);
  });

  it('refuses rows that break the lifecycle', () => {
    expect(() => task('k_a', { phase: 'running' })).toThrow(/CHECK constraint failed/);
    expect(() => task('k_b', { phase: 'blocked' })).toThrow(/CHECK constraint failed/);
    expect(() => task('k_c', { blocked_from: 'open' })).toThrow(/CHECK constraint failed/);
    task('k_d');
    expect(() => run('r_1', 'k_d', 1, { ended_at: NOW })).toThrow(/CHECK constraint failed/);
    expect(() => h.db.prepare("INSERT INTO kanban_links VALUES ('k_d', 'k_d', ?)").run(NOW)).toThrow(
      /CHECK constraint failed/,
    );
  });

  it('keeps idempotency keys unique, and allows any number of tasks without one', () => {
    task('k_1', { idempotency_key: 'lark:om_1' });
    expect(() => task('k_2', { idempotency_key: 'lark:om_1' })).toThrow(/UNIQUE constraint failed/);
    task('k_3');
    task('k_4');
  });

  it('stores reported_dirty as 0 or 1 only', () => {
    task('k_1');
    task('k_2');
    expect(() => run('r_1', 'k_1', 1, { reported_dirty: 2 })).toThrow(/CHECK constraint failed/);
    run('r_2', 'k_1', 1, { reported_dirty: 1 });
    run('r_3', 'k_2', 1, { reported_dirty: 0 });
  });

  it("gives a person's run no session, and a session to one run at most", () => {
    for (const id of ['s_1', 's_2']) {
      createSession(h.db, { id, agentId: 'implementer', workspaceId: 'default', ownerPrincipal: 'test' }, NOW);
    }
    task('k_1');
    task('k_2');
    task('k_3');
    const person = { assignee_kind: 'human', assignee: 'lark:on_bob' };
    expect(() => run('r_1', 'k_1', 1, { ...person, session_id: 's_1' }, false)).toThrow(/CHECK constraint failed/);
    run('r_2', 'k_1', 1, person, false);
    run('r_3', 'k_2', 1, { session_id: 's_1' });
    expect(() => run('r_4', 'k_3', 1, { session_id: 's_1' })).toThrow(/UNIQUE constraint failed/);
    run('r_5', 'k_3', 1, { session_id: 's_2' });
  });

  it('gives a run an agent exactly when it is for a role', () => {
    task('k_1');
    expect(() => run('r_1', 'k_1', 1, {}, false)).toThrow(/CHECK constraint failed/);
    expect(() => run('r_2', 'k_1', 1, { assignee_kind: 'human', assignee: 'lark:on_bob' })).toThrow(
      /CHECK constraint failed/,
    );
  });

  it('names an assignee and a reviewer together with their kind, or neither', () => {
    expect(() => task('k_1', { assignee_kind: 'role' })).toThrow(/CHECK constraint failed/);
    expect(() => task('k_2', { assignee: 'implementer' })).toThrow(/CHECK constraint failed/);
    expect(() => task('k_3', { reviewer_kind: 'human' })).toThrow(/CHECK constraint failed/);
    expect(() => task('k_4', { reviewer: 'lark:on_bob' })).toThrow(/CHECK constraint failed/);
    task('k_5', { assignee_kind: 'role', assignee: 'implementer', reviewer_kind: 'human', reviewer: 'lark:on_bob' });
  });
});

describe('migration 004', () => {
  it("reads a bot's subscriptions by its account through an index, not a scan of every subscription", () => {
    const plan = h.db
      .prepare<[], { detail: string }>(
        "EXPLAIN QUERY PLAN SELECT id FROM kanban_subscriptions s WHERE s.account_id = 'cli_app'",
      )
      .all()
      .map((r) => r.detail);
    expect(plan).toEqual([expect.stringMatching(/USING (COVERING )?INDEX idx_kanban_subscriptions_account/)]);
  });
});
