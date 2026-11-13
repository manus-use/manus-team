import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { SchemaTooNewError, highestMigration, migrate, openDb, type Db } from '../src/db/open.js';
import { createGateway } from '../src/index.js';
import { loadTeam } from '../src/team.js';
import { SCHEMA_DIR } from './helpers/db.js';

const LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

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

describe('createGateway on a database newer than the build', () => {
  const env = (home: string): Record<string, string> => ({
    MT_HOME: home,
    MT_DB: join(home, 'team.db'),
    MT_WORKSPACE: join(dir, 'repo'),
    MT_OWNER_OPEN_ID: 'ou_owner',
    LARK_APP_ID: 'cli_app',
    LARK_APP_SECRET: 'app-secret-never-printed',
    MT_AGENT_COMMAND: 'bytesec',
    MT_AGENT_DRIVER: 'structured-cli',
    MT_AGENT_UNSUPERVISED: 'true',
  });

  /** A home whose database a newer build migrated: one version above this build's. */
  function newerHome(): { home: string; dbPath: string; version: number } {
    const home = join(dir, 'home');
    mkdirSync(home);
    const dbPath = join(home, 'team.db');
    const newer = openDb(dbPath);
    const version = highestMigration(SCHEMA_DIR) + 1;
    newer.pragma(`user_version = ${version}`);
    newer.close();
    return { home, dbPath, version };
  }

  beforeEach(() => mkdirSync(join(dir, 'repo')));
  afterEach(() => vi.restoreAllMocks());

  it('closes the database and throws a new SchemaTooNewError naming the database and the backups, the original as its cause', async () => {
    const { home, dbPath, version } = newerHome();
    const config = loadConfig(env(home), () => undefined);
    const team = loadTeam(config, env(home));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const close = vi.spyOn(Database.prototype, 'close');
    let thrown: unknown;
    try {
      await createGateway(config, team);
    } catch (err) {
      thrown = err;
    }
    const top = highestMigration(SCHEMA_DIR);
    expect(thrown).toBeInstanceOf(SchemaTooNewError);
    expect(thrown).toMatchObject({
      dbVersion: version,
      buildVersion: top,
      message:
        `the database at ${dbPath} is at schema version ${version}, and this build knows only up to ${top}: it was migrated by a newer build. ` +
        `Run that build, or restore a backup of version ${top} from ${join(home, 'backups')} (spec §20.8)`,
    });
    expect((thrown as Error).cause).toBeInstanceOf(SchemaTooNewError);
    expect((thrown as Error).cause).not.toBe(thrown);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the database before any other error from migrate is thrown, as it was', async () => {
    const home = join(dir, 'home');
    mkdirSync(home);
    const broken = join(dir, 'broken-schema');
    mkdirSync(broken);
    writeFileSync(join(broken, '001_broken.sql'), 'CREATE TABLE;');
    const config = { ...loadConfig(env(home), () => undefined), schemaDir: broken };
    const team = loadTeam(config, env(home));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const close = vi.spyOn(Database.prototype, 'close');
    await expect(createGateway(config, team)).rejects.toThrow(/^migration 001_broken\.sql failed/);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('stops the gateway with configuration error: and exit 78', async () => {
    const { home, dbPath, version } = newerHome();
    const r = await new Promise<{ code: number | null; stderr: string }>((done, fail) => {
      const child = spawn(process.execPath, ['--import', LOADER, MAIN], {
        env: { ...env(home), HOME: dir, PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d: string) => (stderr += d));
      child.once('error', fail);
      child.once('close', (code) => done({ code, stderr }));
    });
    expect(r.code).toBe(78);
    expect(r.stderr).toContain(`\nconfiguration error: the database at ${dbPath} is at schema version ${version}, `);
    expect(r.stderr).not.toContain('app-secret-never-printed');
  }, 30_000);
});
