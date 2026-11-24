import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boardsAt } from '../src/db/boards-at.js';
import { archiveBoard, createBoard } from '../src/db/kanban.js';
import { migrate, openDb } from '../src/db/open.js';
import { loadStartup } from '../src/index.js';
import { clearSecrets } from '../src/secrets.js';
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

/** A file of one step for `worker`, on these top lines. */
export const fileOn = (top: string): string => `${top}${top === '' ? '' : '\n'}steps:\n  sync:\n    title: Sync the team\n    assignee: worker\n`;

/** A home at `<root>/home` with the role worker and these workflow files, and the env the startup reads. */
function home(files: Record<string, string>): Record<string, string | undefined> {
  const h = join(root, 'home');
  mkdirSync(join(h, 'roles', 'worker'), { recursive: true });
  writeFileSync(join(h, 'roles', 'worker', 'config.yaml'), 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
  mkdirSync(join(h, 'workflows'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(h, 'workflows', name), text);
  mkdirSync(join(root, 'repo'), { recursive: true });
  return {
    MT_HOME: h,
    MT_WORKSPACE: join(root, 'repo'),
    MT_OWNER_OPEN_ID: 'ou_owner',
    LARK_APP_ID: 'cli_app',
    LARK_APP_SECRET: 'app-secret-123456',
    MT_AGENT_COMMAND: 'bytesec',
    MT_AGENT_DRIVER: 'structured-cli',
    MT_AGENT_UNSUPERVISED: 'true',
  };
}

/** The home's database, migrated, with these boards made and these archived. */
function boards(made: readonly string[], archived: readonly string[] = []): void {
  const db = openDb(join(root, 'home', 'team.db'));
  migrate(db, SCHEMA_DIR);
  for (const b of made) createBoard(db, b, ALICE, NOW);
  for (const b of archived) archiveBoard(db, b, ALICE, NOW);
  db.close();
}

const MISSING = 'workflow vi-sync is not usable: its board vi does not exist (create it with /kanban board create vi, or mt kanban board create vi)';

describe('the startup', () => {
  beforeEach(() => clearSecrets());
  afterEach(() => clearSecrets());

  it('says a workflow on a missing board is not usable, with no database, and lists one naming default as usable', () => {
    const env = home({ 'vi-sync.yaml': fileOn('board: vi'), 'home-sync.yaml': fileOn('board: default') });
    expect(loadStartup(env).workflows).toEqual([MISSING, 'workflows: home-sync; not usable: vi-sync']);
  });

  it('says the archived words for an archived board, and lists a live one as usable', () => {
    const env = home({ 'vi-sync.yaml': fileOn('board: vi') });
    boards(['vi'], ['vi']);
    expect(loadStartup(env).workflows).toEqual([
      'workflow vi-sync is not usable: its board vi is archived, and nothing is added to it (name another board in its file)',
      'workflows: none; not usable: vi-sync',
    ]);
    rmSync(join(root, 'home', 'team.db'));
    boards(['vi']);
    expect(loadStartup(env).workflows).toEqual(['workflows: vi-sync']);
  });

  it('says once when the database cannot be read, and judges the files alone', () => {
    const env = home({ 'vi-sync.yaml': fileOn('board: vi') });
    const holder = new Database(join(root, 'home', 'team.db'));
    holder.pragma('journal_mode = DELETE');
    holder.exec('CREATE TABLE kanban_boards (name TEXT, archived_at INTEGER); PRAGMA user_version = 6; BEGIN EXCLUSIVE; INSERT INTO kanban_boards VALUES (1, NULL);');
    try {
      const lines = loadStartup(env).workflows;
      expect(lines[0]).toMatch(/^workflow boards are not checked: the database cannot be read: .*(locked|busy)/i);
      expect(lines.slice(1)).toEqual(['workflows: vi-sync']);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });
});
