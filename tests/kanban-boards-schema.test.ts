import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTask } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { newTask } from './helpers/kanban.js';

/**
 * Migration 006 (spec §16): the boards, `default` among them, and every task on
 * one. It runs on the live database, which holds tasks, so it is tested from
 * version 5 with rows in it, as well as from nothing.
 */

const NOW = 1_760_000_000_000;
let dir: string;
let db: Db;

/** A database migrated as far as `version`, as a gateway from before this change left it. */
function migratedTo(version: number): Db {
  const only = mkdtempSync(join(dir, 'schema-'));
  for (const f of readdirSync(SCHEMA_DIR)) {
    if (/^\d+_.*\.sql$/.test(f) && Number(f.slice(0, f.indexOf('_'))) <= version) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
  }
  const d = openDb(join(dir, 'team.db'));
  migrate(d, only);
  return d;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mt-boards-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('migration 006', () => {
  it('puts every task already on the board on default, and changes nothing else of it', () => {
    db = migratedTo(5);
    db.prepare(
      `INSERT INTO kanban_tasks (task_id, title, contract, phase, created_by, created_via, created_at)
       VALUES ('k_old', 'from before boards', jsonb('{}'), 'open', 'lark:on_alice', jsonb('{}'), ?)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO kanban_runs (run_id, task_id, attempt, kind, assignee_kind, assignee, agent_config, started_at)
       VALUES ('r_old', 'k_old', 1, 'work', 'role', 'implementer', jsonb('{}'), ?)`,
    ).run(NOW);

    expect(migrate(db, SCHEMA_DIR)).toBe(8);

    expect(getTask(db, 'k_old')).toMatchObject({ taskId: 'k_old', title: 'from before boards', phase: 'open', board: 'default' });
    expect(db.prepare('SELECT run_id, task_id FROM kanban_runs').all()).toEqual([{ run_id: 'r_old', task_id: 'k_old' }]);
    const boards = db.prepare<[], { name: string; created_by: string; created_at: number }>('SELECT * FROM kanban_boards').all();
    expect(boards.map((b) => [b.name, b.created_by])).toEqual([['default', 'gateway']]);
    // Stamped with the moment it ran, in milliseconds, as every other time is.
    expect(boards[0]?.created_at).toBeGreaterThan(NOW);
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 8 });
  });

  it('puts a task created afterwards on default unless it says otherwise', () => {
    // As far as the code it runs needs: 007 adds the column every task row is read with, 008 the one its subscription is written with.
    db = migratedTo(8);
    expect(newTask(db).board).toBe('default');
  });

  it('refuses a chat on a board that does not exist', () => {
    db = migratedTo(6);
    const insert = db.prepare(
      `INSERT INTO kanban_chat_boards (channel, account_id, conversation_id, board, set_by, set_at)
       VALUES ('lark', 'cli_app', 'oc_chat', ?, 'lark:on_alice', ?)`,
    );
    expect(() => insert.run('nowhere', NOW)).toThrow(/FOREIGN KEY constraint failed/);
    insert.run('default', NOW);
  });

  it('refuses a board max_running below 1', () => {
    db = migratedTo(6);
    const insert = db.prepare(
      "INSERT INTO kanban_boards (name, max_running, created_by, created_at) VALUES (?, ?, 'lark:on_alice', ?)",
    );
    expect(() => insert.run('zero', 0, NOW)).toThrow(/CHECK constraint failed/);
    insert.run('one', 1, NOW);
  });
});
