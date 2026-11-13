import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.js';
import { SchemaTooNewError, highestMigration, migrate, openDb, type Db } from '../src/db/open.js';
import { SCHEMA_DIR } from './helpers/db.js';

/**
 * A database newer than the build (spec §20.6): `migrate()` refuses one whose
 * `user_version` is above the highest migration file, before anything runs, and
 * migrates one at or below it as before.
 */

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mt-newer-'));
  db = openDb(join(dir, 'team.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A schema directory holding the bundled migrations numbered up to `top`. */
function schemaUpTo(top: number): string {
  const only = join(dir, `schema-${top}`);
  mkdirSync(only);
  for (const f of readdirSync(SCHEMA_DIR)) {
    if (/^\d+_.*\.sql$/.test(f) && Number(f.slice(0, f.indexOf('_'))) <= top) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
  }
  return only;
}

const tables = (): string[] =>
  db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);

describe('highestMigration', () => {
  it('is the highest NNN among the files, and 0 for a directory with none', () => {
    expect(highestMigration(schemaUpTo(3))).toBe(3);
    expect(highestMigration(SCHEMA_DIR)).toBe(readdirSync(SCHEMA_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).length);
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    expect(highestMigration(empty)).toBe(0);
  });
});

describe('migrate on a database newer than the build', () => {
  it('refuses it as a SchemaTooNewError with both versions, applying nothing', () => {
    db.pragma('user_version = 5');
    let thrown: unknown;
    try {
      migrate(db, schemaUpTo(3));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SchemaTooNewError);
    expect(thrown).toBeInstanceOf(ConfigError);
    expect(thrown).toMatchObject({
      name: 'SchemaTooNewError',
      dbVersion: 5,
      buildVersion: 3,
      message:
        'the database is at schema version 5, and this build knows only up to 3: it was migrated by a newer build. ' +
        'Run that build, or restore a backup of version 3 (spec §20.8)',
    });
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(5);
    expect(tables()).toEqual([]);
  });

  it('refuses any migrated database from a directory with no migration file', () => {
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    expect(migrate(db, empty)).toBe(0);
    db.pragma('user_version = 1');
    expect(() => migrate(db, empty)).toThrow(SchemaTooNewError);
  });

  it('migrates one below the highest file, and leaves one at it as it is', () => {
    expect(migrate(db, schemaUpTo(3))).toBe(3);
    expect(migrate(db, SCHEMA_DIR)).toBe(highestMigration(SCHEMA_DIR));
    const before = tables();
    expect(migrate(db, SCHEMA_DIR)).toBe(highestMigration(SCHEMA_DIR));
    expect(tables()).toEqual(before);
  });
});
