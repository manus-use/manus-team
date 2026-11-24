import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boardsAt } from '../src/db/boards-at.js';
import { archiveBoard, createBoard } from '../src/db/kanban.js';
import { migrate, openDb } from '../src/db/open.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { ALICE, NOW } from './helpers/kanban.js';

/**
 * A workflow's own board at the fronts (workflows spec §19.4, §19.5): the boards
 * read at a path, the startup, `mt workflow check`, the terminal and chat.
 */

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mt-wf-board-fronts-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('boardsAt', () => {
  it('gives default alone with no database, and for one from before migration 006', () => {
    expect(boardsAt(join(root, 'none.db'))).toEqual({ ok: true, boards: new Map([['default', false]]) });
    const old = new Database(join(root, 'old.db'));
    old.pragma('user_version = 5');
    old.close();
    expect(boardsAt(join(root, 'old.db'))).toEqual({ ok: true, boards: new Map([['default', false]]) });
  });

  it("gives a migrated database's boards, each with whether it is archived", () => {
    const db = openDb(join(root, 'team.db'));
    migrate(db, SCHEMA_DIR);
    createBoard(db, 'vi', ALICE, NOW);
    createBoard(db, 'old', ALICE, NOW);
    archiveBoard(db, 'old', ALICE, NOW);
    db.close();
    expect(boardsAt(join(root, 'team.db'))).toEqual({ ok: true, boards: new Map([['default', false], ['old', true], ['vi', false]]) });
  });

  it('says why when the database is held past the busy timeout', () => {
    const path = join(root, 'locked.db');
    const holder = new Database(path);
    holder.pragma('journal_mode = DELETE');
    holder.exec("CREATE TABLE kanban_boards (name TEXT, archived_at INTEGER); PRAGMA user_version = 6; BEGIN EXCLUSIVE; INSERT INTO kanban_boards VALUES ('vi', NULL);");
    try {
      const r = boardsAt(path);
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.why).toMatch(/locked|busy/i);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });
});
