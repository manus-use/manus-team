import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { registerWorkspaces, registrationsAt } from '../src/db/workspaces.js';
import { testDb, type TestDb } from './helpers/db.js';

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

function rows(t: TestDb): Array<{ id: string; kind: string; root_path: string }> {
  return t.db
    .prepare<[], { id: string; kind: string; root_path: string }>('SELECT id, kind, root_path FROM workspaces ORDER BY id')
    .all();
}

/**
 * A workspace name is a durable identity, and its directory never moves (spec §2.3):
 * relocating one orphans the provider sessions opened in it and silently moves
 * every task fixed to it.
 */
describe('registerWorkspaces', () => {
  it('records each name the first time it is seen', () => {
    const t = db();
    const result = registerWorkspaces(t.db, new Map([['default', '/srv/a'], ['docs', '/srv/b']]), NOW);
    expect(result).toEqual({ ok: true, added: ['default', 'docs'] });
    expect(rows(t)).toEqual([
      { id: 'default', kind: 'plain-dir', root_path: '/srv/a' },
      { id: 'docs', kind: 'plain-dir', root_path: '/srv/b' },
    ]);
  });

  it('accepts the same directories again, adding nothing', () => {
    const t = db();
    registerWorkspaces(t.db, new Map([['default', '/srv/a']]), NOW);
    expect(registerWorkspaces(t.db, new Map([['default', '/srv/a']]), NOW + 1)).toEqual({ ok: true, added: [] });
    expect(rows(t)).toHaveLength(1);
  });

  it('refuses a known name pointed at a new directory, naming both', () => {
    const t = db();
    registerWorkspaces(t.db, new Map([['default', '/srv/a']]), NOW);
    const result = registerWorkspaces(t.db, new Map([['default', '/srv/moved']]), NOW + 1);
    expect('error' in result && result.error).toMatch(/workspace default is \/srv\/a .* \/srv\/moved/);
    expect('error' in result && result.error).toMatch(/new name/);
  });

  it('registers nothing when any name has moved', () => {
    // Checked before anything is written, so a refused start leaves the table as it was.
    const t = db();
    registerWorkspaces(t.db, new Map([['default', '/srv/a']]), NOW);
    // 'alpha' sorts before the moved name, so writing as it goes would insert it.
    registerWorkspaces(t.db, new Map([['alpha', '/srv/b'], ['default', '/srv/moved']]), NOW + 1);
    expect(rows(t).map((r) => r.id)).toEqual(['default']);
  });
});

describe('registrationsAt', () => {
  it('is empty for a database that does not exist, and does not create one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-reg-'));
    try {
      const path = join(dir, 'gateway.db');
      expect(registrationsAt(path)).toEqual(new Map());
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads what the gateway registered', () => {
    const t = db();
    registerWorkspaces(t.db, new Map([['default', '/srv/a']]), NOW);
    expect(registrationsAt(join(t.dir, 'gateway.db'))).toEqual(new Map([['default', '/srv/a']]));
  });

  it('is empty for a database the migrations have not reached', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-reg-'));
    try {
      const path = join(dir, 'gateway.db');
      const raw = new Database(path);
      raw.exec('CREATE TABLE other (a TEXT)');
      raw.close();
      expect(registrationsAt(path)).toEqual(new Map());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
