import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getTask } from '../src/db/kanban-read.js';
import { migrate, openDb } from '../src/db/open.js';
import {
  registeredWorkspaces,
  registerWorkspaces,
  registerWorktree,
  worktreeId,
  worktreeOf,
  type TaskDirectory,
} from '../src/db/workspaces.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { newTask } from './helpers/kanban.js';

/**
 * A task's own directory (spec §18): the column the claim fixes it in
 * (migration 007), and the workspaces row that records it once made.
 */

const NOW = 1_760_000_000_000;
const open: TestDb[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

function db(): TestDb {
  const t = testDb();
  open.push(t);
  return t;
}

const DIR: TaskDirectory = {
  id: 'wt:k_one',
  kind: 'git-worktree',
  rootPath: '/home/mt/worktrees/web/k_one',
  repoRoot: '/srv/web',
  branch: 'mt/k_one',
};

describe('migration 007', () => {
  it('gives every task already on the board no directory of its own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-wt-schema-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) {
        if (/^00[1-6]_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      }
      const d = openDb(join(dir, 'team.db'));
      try {
        expect(migrate(d, only)).toBe(6);
        d.prepare(
          `INSERT INTO kanban_tasks (task_id, title, contract, phase, created_by, created_via, created_at)
           VALUES ('k_old', 'from before', jsonb('{}'), 'open', 'lark:on_alice', jsonb('{}'), ?)`,
        ).run(NOW);
        expect(migrate(d, SCHEMA_DIR)).toBe(8);
        expect(getTask(d, 'k_old')).toMatchObject({ taskId: 'k_old', workspace: null, worktree: null });
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a new task with no directory of its own', () => {
    const t = db();
    expect(newTask(t.db).worktree).toBeNull();
  });
});

describe('registerWorktree', () => {
  it("records a task's directory once, and the same again changes nothing", () => {
    const t = db();
    expect(worktreeId('k_one')).toBe('wt:k_one');
    expect(worktreeOf(t.db, 'wt:k_one')).toBeUndefined();
    expect(registerWorktree(t.db, DIR, NOW)).toEqual({ ok: true, added: ['wt:k_one'] });
    expect(registerWorktree(t.db, DIR, NOW + 1)).toEqual({ ok: true, added: [] });
    expect(worktreeOf(t.db, 'wt:k_one')).toEqual(DIR);
    const folder: TaskDirectory = { id: 'wt:k_two', kind: 'plain-dir', rootPath: '/home/mt/worktrees/notes/k_two', repoRoot: '/srv/notes', branch: null };
    registerWorktree(t.db, folder, NOW);
    expect(worktreeOf(t.db, 'wt:k_two')).toEqual(folder);
  });

  it('refuses another directory for a recorded id, and an id that is not a task directory', () => {
    const t = db();
    registerWorktree(t.db, DIR, NOW);
    expect(registerWorktree(t.db, { ...DIR, rootPath: '/elsewhere/k_one' }, NOW)).toEqual({
      error: 'wt:k_one is /home/mt/worktrees/web/k_one, recorded when it was made, not /elsewhere/k_one',
    });
    expect(registerWorktree(t.db, { ...DIR, id: 'web' }, NOW)).toEqual({ error: "web is not a task's directory id" });
    expect(worktreeOf(t.db, 'web')).toBeUndefined();
  });

  it("leaves tasks' directories out of the configured workspaces' registrations", () => {
    const t = db();
    registerWorkspaces(t.db, new Map([['web', '/srv/web']]), NOW);
    registerWorktree(t.db, DIR, NOW);
    expect(registeredWorkspaces(t.db)).toEqual(new Map([['web', '/srv/web']]));
  });
});
