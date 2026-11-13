import Database from 'better-sqlite3';
import { chmodSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Db } from './open.js';

/**
 * The database's backup before an update's restart (spec §20.8): SQLite's
 * online backup, in one step, from a read-only connection while the gateway
 * runs, to `<dir>/<db>-v<version>-<old short sha>-<UTC time>.db`.
 *
 * In one step, so the copy is one read transaction: in WAL mode, a consistent
 * snapshot of every committed transaction, which the gateway's writes never
 * restart and never wait on. Written owner-only through a `.partial`, created
 * 0600 before the backup opens it, then checked (`quick_check`, and the version
 * the update recorded) and renamed into place. The copy is one whole file, its
 * journal mode DELETE, checked too, so opening it later gives it no `-wal` or
 * `-shm`.
 *
 * The source is only read, by a connection that must be read-only. The copy is
 * the only file written, and nothing in the gateway's database changes.
 */

/** The UTC time with no colon, which some file systems and scp refuse: `20261112T153000Z`. */
export function backupStamp(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll('-', '').replaceAll(':', '');
}

/** The database file's name less `.db`: `team` for `team.db`. */
function baseName(dbPath: string): string {
  return basename(dbPath).replace(/\.db$/, '');
}

/** `team-v8-8b64aa1-20261112T153000Z.db`. */
export function backupName(dbPath: string, version: number, sha: string, at: Date): string {
  return `${baseName(dbPath)}-v${version}-${sha.slice(0, 7)}-${backupStamp(at)}.db`;
}

/** How many of a database's backups are kept, newest first, besides the newest of each version. */
export const BACKUPS_KEPT = 5;

/** A backup that was refused, or taken but is not good: its check failed. */
export class BackupError extends Error {}

export interface BackupOptions {
  /** The directory, made owner-only by the caller. */
  dir: string;
  /** The database's path, for the backup's name. */
  dbPath: string;
  /** The `user_version` the copy must have: the one the update recorded. */
  version: number;
  /** The commit the checkout was on. */
  sha: string;
  at: Date;
  /** The copy's integrity check; `PRAGMA quick_check` unless a test says otherwise. */
  quickCheck?: (copy: Db) => string;
  /** The copy's journal mode set to DELETE, answering the mode it is now; `PRAGMA journal_mode = DELETE` unless a test says otherwise. */
  journalMode?: (copy: Db) => string;
}

/**
 * Back `source` up into `opts.dir`, check the copy, and prune the older
 * backups. Answers the backup's path and the files removed. Throws, leaving no
 * `.partial` or journal of its own, when the copy fails or its check does.
 */
export async function backupDatabase(source: Db, opts: BackupOptions): Promise<{ path: string; removed: string[] }> {
  // Read-only, so nothing of the backup's can ever write to the gateway's database.
  if (!source.readonly) throw new BackupError('the backup is taken from a read-only connection, and this one can write');
  const name = backupName(opts.dbPath, opts.version, opts.sha, opts.at);
  const path = join(opts.dir, name);
  const partial = join(opts.dir, `.${name}.partial`);
  // Before the backup opens it, so it never exists with the umask's mode. `wx`: never another's.
  writeFileSync(partial, '', { flag: 'wx', mode: 0o600 });
  try {
    chmodSync(partial, 0o600);
    // Every remaining page in one step: better-sqlite3 takes the callback's number of pages per step.
    await source.backup(partial, { progress: () => 0x7fffffff });
    const copy = new Database(partial);
    try {
      const mode = (opts.journalMode ?? ((db: Db) => String(db.pragma('journal_mode = DELETE', { simple: true }))))(copy);
      // Anything else leaves the copy needing a -wal of its own, which a restore by cp would not take.
      if (mode !== 'delete') throw new BackupError(`the copy's journal mode is ${mode}, not delete`);
      const checked = (opts.quickCheck ?? ((db: Db) => String(db.pragma('quick_check', { simple: true }))))(copy);
      if (checked !== 'ok') throw new BackupError(`the copy's quick_check says: ${checked}`);
      const version = Number(copy.pragma('user_version', { simple: true }));
      if (version !== opts.version) {
        throw new BackupError(`the copy is at schema version ${version}, not ${opts.version}: the database moved during the backup`);
      }
    } finally {
      copy.close();
    }
    renameSync(partial, path);
  } catch (err) {
    for (const leftover of ['', '-journal', '-wal', '-shm']) rmSync(`${partial}${leftover}`, { force: true });
    throw err;
  }
  return { path, removed: pruneBackups(opts.dir, opts.dbPath) };
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Keep the BACKUPS_KEPT newest backups of this database's name, by the time in
 * their name, and the newest of each version besides; remove the rest, and any
 * `.partial` an update that died left. Nothing else in `dir` is touched.
 * Answers the names removed.
 */
export function pruneBackups(dir: string, dbPath: string): string[] {
  const base = escape(baseName(dbPath));
  const backup = new RegExp(`^${base}-v([0-9]+)-[0-9a-f]+-([0-9]{8}T[0-9]{6}Z)\\.db$`);
  const partial = new RegExp(`^\\.${base}-v[0-9]+-[0-9a-f]+-[0-9]{8}T[0-9]{6}Z\\.db\\.partial(-journal|-wal|-shm)?$`);
  const backups: { name: string; version: string; stamp: string }[] = [];
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    const m = backup.exec(name);
    if (m !== null) backups.push({ name, version: m[1] ?? '', stamp: m[2] ?? '' });
    else if (partial.test(name)) removed.push(name);
  }
  backups.sort((a, b) => (a.stamp === b.stamp ? b.name.localeCompare(a.name) : b.stamp.localeCompare(a.stamp)));
  const kept = new Set(backups.slice(0, BACKUPS_KEPT).map((b) => b.name));
  const versions = new Set<string>();
  for (const b of backups) {
    // The newest of each version: a backup is the way back only for the build of its schema.
    if (!versions.has(b.version)) kept.add(b.name);
    versions.add(b.version);
  }
  for (const b of backups) if (!kept.has(b.name)) removed.push(b.name);
  for (const name of removed) rmSync(join(dir, name), { force: true });
  return removed.sort();
}
