import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupError, backupDatabase, backupName, pruneBackups } from '../src/db/backup.js';
import { migrate, openDb, openDbReadOnly, type Db } from '../src/db/open.js';
import { SCHEMA_DIR } from './helpers/db.js';

/**
 * The backup before an update's restart (spec §20.8): its name, owner-only
 * through a `.partial`, one whole file in journal mode DELETE, checked, and the
 * backups kept. A real WAL database, read through a read-only connection, as
 * the update reads the gateway's.
 */

let root: string;
let dir: string;
let dbPath: string;
let writer: Db;
let reader: Db;
const AT = new Date('2026-11-12T15:30:00.000Z');
const SHA = '8b64aa1f00000000000000000000000000000000';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mt-backup-'));
  dir = join(root, 'backups');
  mkdirSync(dir, { mode: 0o700 });
  dbPath = join(root, 'team.db');
  writer = openDb(dbPath);
  migrate(writer, SCHEMA_DIR);
  writer.exec("CREATE TABLE IF NOT EXISTS backup_probe (n INTEGER); INSERT INTO backup_probe VALUES (1), (2), (3);");
  reader = openDbReadOnly(dbPath) as Db;
});
afterEach(() => {
  reader.close();
  writer.close();
  rmSync(root, { recursive: true, force: true });
});

const version = (): number => Number(writer.pragma('user_version', { simple: true }));

describe('backupName', () => {
  it("is the database's name, its version, the old commit and the UTC time with no colon", () => {
    expect(backupName('/home/x/.manus-team/team.db', 8, SHA, AT)).toBe('team-v8-8b64aa1-20261112T153000Z.db');
    expect(backupName('/data/other.db', 12, 'abcdef0123', AT)).toBe('other-v12-abcdef0-20261112T153000Z.db');
  });
});

describe('backupDatabase', () => {
  it('copies the database whole, owner-only, in journal mode DELETE, leaving no .partial', async () => {
    const { path } = await backupDatabase(reader, { dir, dbPath, version: version(), sha: SHA, at: AT });
    expect(path).toBe(join(dir, `team-v${version()}-8b64aa1-20261112T153000Z.db`));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual([`team-v${version()}-8b64aa1-20261112T153000Z.db`]);
    const copy = new Database(path, { readonly: true });
    try {
      expect(copy.pragma('journal_mode', { simple: true })).toBe('delete');
      expect(Number(copy.pragma('user_version', { simple: true }))).toBe(version());
      expect(copy.prepare('SELECT count(*) AS n FROM backup_probe').get()).toEqual({ n: 3 });
    } finally {
      copy.close();
    }
  });

  it('holds what is committed in the WAL, not yet checkpointed', async () => {
    writer.exec('INSERT INTO backup_probe VALUES (4)');
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
    const { path } = await backupDatabase(reader, { dir, dbPath, version: version(), sha: SHA, at: AT });
    const copy = new Database(path, { readonly: true });
    try {
      expect(copy.prepare('SELECT count(*) AS n FROM backup_probe').get()).toEqual({ n: 4 });
    } finally {
      copy.close();
    }
  });

  it('fails on a quick_check that is not ok, and removes the .partial and its journal', async () => {
    const failing = backupDatabase(reader, {
      dir,
      dbPath,
      version: version(),
      sha: SHA,
      at: AT,
      quickCheck: () => {
        writeFileSync(join(dir, `.${backupName(dbPath, version(), SHA, AT)}.partial-journal`), '');
        return '*** in database main ***\nPage 7: btreeInitPage() returns error code 11';
      },
    });
    await expect(failing).rejects.toThrow(BackupError);
    await expect(failing).rejects.toThrow(/quick_check says: \*\*\* in database main/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("fails on a copy whose user_version is not the update's, and leaves nothing", async () => {
    await expect(backupDatabase(reader, { dir, dbPath, version: version() - 1, sha: SHA, at: AT })).rejects.toThrow(
      `the copy is at schema version ${version()}, not ${version() - 1}: the database moved during the backup`,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("fails on a copy whose journal mode does not become DELETE, and leaves nothing", async () => {
    const failing = backupDatabase(reader, { dir, dbPath, version: version(), sha: SHA, at: AT, journalMode: () => 'wal' });
    await expect(failing).rejects.toThrow(BackupError);
    await expect(failing).rejects.toThrow("the copy's journal mode is wal, not delete");
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a source connection that can write, before it writes anything', async () => {
    await expect(backupDatabase(writer, { dir, dbPath, version: version(), sha: SHA, at: AT })).rejects.toThrow(
      'the backup is taken from a read-only connection, and this one can write',
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it('is a consistent copy while another connection writes', async () => {
    // Each write puts one row in each of two tables, in one transaction: a copy of a committed state has as many of each.
    writer.exec('CREATE TABLE pair_a (n INTEGER); CREATE TABLE pair_b (n INTEGER)');
    const pair = writer.transaction((n: number) => {
      writer.prepare('INSERT INTO pair_a VALUES (?)').run(n);
      writer.prepare('INSERT INTO pair_b VALUES (?)').run(n);
    });
    let n = 0;
    let writing = true;
    const writes = (async () => {
      while (writing) {
        pair(++n);
        await new Promise((next) => setImmediate(next));
      }
    })();
    await new Promise((wait) => setTimeout(wait, 50));
    const before = n;
    let path: string;
    try {
      ({ path } = await backupDatabase(reader, { dir, dbPath, version: version(), sha: SHA, at: AT }));
    } finally {
      await new Promise((wait) => setTimeout(wait, 20));
      writing = false;
      await writes;
    }
    const copy = new Database(path, { readonly: true });
    try {
      expect(copy.pragma('quick_check', { simple: true })).toBe('ok');
      const a = (copy.prepare('SELECT count(*) AS n FROM pair_a').get() as { n: number }).n;
      const b = (copy.prepare('SELECT count(*) AS n FROM pair_b').get() as { n: number }).n;
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(before);
      expect(a).toBeLessThanOrEqual(n);
      expect(n).toBeGreaterThan(before);
    } finally {
      copy.close();
    }
  });

  it("never takes another's .partial", async () => {
    const theirs = join(dir, `.${backupName(dbPath, version(), SHA, AT)}.partial`);
    writeFileSync(theirs, 'not ours');
    await expect(backupDatabase(reader, { dir, dbPath, version: version(), sha: SHA, at: AT })).rejects.toThrow(/EEXIST/);
    expect(existsSync(theirs)).toBe(true);
  });
});

describe('pruneBackups', () => {
  it('keeps the five newest and the newest of each version, removes the rest and any .partial, and touches nothing else', () => {
    const names = [
      'team-v6-aaaaaaa-20261101T000000Z.db',
      'team-v7-bbbbbbb-20261102T000000Z.db',
      'team-v7-ccccccc-20261103T000000Z.db',
      ...[4, 5, 6, 7, 8, 9, 10, 11].map((d) => `team-v8-ddddddd-202611${String(d).padStart(2, '0')}T000000Z.db`),
    ];
    const others = ['notes.txt', 'other-v8-eeeeeee-20261101T000000Z.db', 'team.db', 'team-v8-latest.db'];
    const leftovers = ['.team-v8-fffffff-20261112T000000Z.db.partial', '.team-v8-fffffff-20261112T000000Z.db.partial-journal'];
    for (const name of [...names, ...others, ...leftovers]) writeFileSync(join(dir, name), '');
    expect(pruneBackups(dir, dbPath)).toEqual(
      [
        'team-v7-bbbbbbb-20261102T000000Z.db',
        'team-v8-ddddddd-20261104T000000Z.db',
        'team-v8-ddddddd-20261105T000000Z.db',
        'team-v8-ddddddd-20261106T000000Z.db',
        ...leftovers,
      ].sort(),
    );
    expect(readdirSync(dir).sort()).toEqual(
      [
        'team-v6-aaaaaaa-20261101T000000Z.db',
        'team-v7-ccccccc-20261103T000000Z.db',
        ...[7, 8, 9, 10, 11].map((d) => `team-v8-ddddddd-202611${String(d).padStart(2, '0')}T000000Z.db`),
        ...others,
      ].sort(),
    );
  });

  it('runs after each backup', async () => {
    for (const d of [1, 2, 3, 4, 5, 6]) writeFileSync(join(dir, `team-v${version()}-aaaaaaa-2026110${d}T000000Z.db`), '');
    const { removed } = await backupDatabase(reader, { dir, dbPath, version: version(), sha: SHA, at: AT });
    expect(removed).toEqual([`team-v${version()}-aaaaaaa-20261101T000000Z.db`, `team-v${version()}-aaaaaaa-20261102T000000Z.db`]);
  });
});
