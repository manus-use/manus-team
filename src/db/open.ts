import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from '../config.js';

export type Db = Database.Database;

/**
 * PRAGMAs per architecture §3.7. busy_timeout is 1000ms, NOT the 30s some
 * drivers default to: a writer blocked for 30s is indistinguishable from a
 * hang, and we would rather retry with jitter than sit on the lock.
 */
export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 1000');
  db.pragma('synchronous = NORMAL');
  return db;
}

/**
 * Read-only, for the `mt` commands (spec §2.6). It never migrates, writes or
 * checkpoints, so a running gateway is not disturbed. A database that does not
 * exist yet -- a fresh install -- is undefined, and is not created.
 *
 * When the gateway is stopped, opening a WAL database read-only may still create
 * its -wal and -shm sidecar files. That is harmless when they belong to the
 * gateway's user, so run mt as that user, not with sudo: root-owned sidecars
 * would stop the gateway from opening its own database.
 */
export function openDbReadOnly(path: string): Db | undefined {
  if (!existsSync(path)) return undefined;
  return new Database(path, { readonly: true, fileMustExist: true });
}

/** The migration files in `schemaDir`, `NNN_name.sql`, with their numbers. */
function migrationFiles(schemaDir: string): { file: string; version: number }[] {
  return readdirSync(schemaDir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .map((f) => ({ file: f, version: Number(f.slice(0, f.indexOf('_'))) }));
}

/** The highest `NNN` among the migration files in `schemaDir`: the newest schema this build knows. 0 when there are none. */
export function highestMigration(schemaDir: string): number {
  return migrationFiles(schemaDir).reduce((top, m) => Math.max(top, m.version), 0);
}

/**
 * A database whose `user_version` is above every migration this build has: a
 * newer build migrated it (spec §20.6). A configuration error, so the gateway
 * says it in one line and exits 78, which keeps systemd from a restart loop.
 */
export class SchemaTooNewError extends ConfigError {
  readonly dbVersion: number;
  readonly buildVersion: number;

  constructor(message: string, dbVersion: number, buildVersion: number, cause?: unknown) {
    super(message);
    this.name = 'SchemaTooNewError';
    this.dbVersion = dbVersion;
    this.buildVersion = buildVersion;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Apply any migration in `schemaDir` newer than the recorded version.
 *
 * Migration files are `NNN_name.sql` and run in numeric order. Each runs inside
 * one transaction, so a partially applied migration cannot be committed.
 *
 * Bookkeeping lives in `PRAGMA user_version`, not in a table. A migration runner
 * that creates its own version table cannot coexist with a migration file that
 * also creates one, and `user_version` is a header field reserved for exactly
 * this. The `schema_version` table remains the migrations' own business.
 *
 * A database above the highest file is refused before anything runs, as a
 * `SchemaTooNewError`: an older build put back on a migrated database, by hand
 * or by a crash restart, stops rather than run on a schema it does not know. A
 * directory with no file has a highest of 0, so it refuses any migrated database.
 */
export function migrate(db: Db, schemaDir: string): number {
  const current = Number(db.pragma('user_version', { simple: true }));
  const files = migrationFiles(schemaDir);
  const highest = files.reduce((top, m) => Math.max(top, m.version), 0);
  if (current > highest) {
    throw new SchemaTooNewError(
      `the database is at schema version ${current}, and this build knows only up to ${highest}: it was migrated by a newer build. ` +
        `Run that build, or restore a backup of version ${highest}`,
      current,
      highest,
    );
  }

  const pending = files
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);

  let applied = current;
  for (const m of pending) {
    const sql = readFileSync(join(schemaDir, m.file), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      // Inside the transaction, deliberately. user_version lives in the database
      // header and is written through the same journal as everything else, so it
      // commits or rolls back with the DDL. Bumping it after COMMIT would open a
      // window where a crash leaves the schema changed and the version not, and
      // every migration file would have to be individually re-runnable --
      // `ALTER TABLE ... ADD COLUMN` is not. One transaction, one fact.
      db.pragma(`user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.file} failed: ${String(err)}`, { cause: err });
    }
    applied = m.version;
  }
  return applied;
}

const MAX_RETRIES = 15;
const MIN_BACKOFF_MS = 20;
const MAX_BACKOFF_MS = 150;

function isBusy(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT';
}

/**
 * Run `fn` inside BEGIN IMMEDIATE, retrying on contention with jitter.
 *
 * BEGIN IMMEDIATE, not BEGIN: it takes the write lock up front, so two writers
 * cannot both read, both decide, and then both try to commit. "There is only one
 * writer" is a claim that rots the moment a script or subcommand is added, and
 * the failure mode is a stale snapshot silently erasing another writer's row.
 * A probe has a TOCTOU window; a transaction does not.
 *
 * `fn` must be synchronous. An `await` inside a transaction would let unrelated
 * work interleave while the write lock is held.
 */
export function txImmediate<T>(db: Db, fn: (db: Db) => T): T {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      if (!isBusy(err) || attempt === MAX_RETRIES) throw err;
      lastErr = err;
      sleepJitter();
      continue;
    }
    try {
      const out = fn(db);
      db.exec('COMMIT');
      maybeCheckpoint(db);
      return out;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // A failed rollback means the transaction is already gone; the original
        // error is the one worth reporting.
      }
      if (!isBusy(err) || attempt === MAX_RETRIES) throw err;
      lastErr = err;
      sleepJitter();
    }
  }
  throw new Error(`write contention: gave up after ${MAX_RETRIES} retries`, { cause: lastErr });
}

/**
 * Synchronous jittered backoff. Deliberately synchronous: `txImmediate` is
 * synchronous by contract, and yielding to the event loop here would let a
 * caller start a second transaction on the same connection mid-retry.
 */
function sleepJitter(): void {
  const ms = MIN_BACKOFF_MS + Math.random() * (MAX_BACKOFF_MS - MIN_BACKOFF_MS);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// WAL grows until checkpointed. PASSIVE never blocks a reader; if it cannot run
// now it will run on a later commit.
const CHECKPOINT_EVERY = 50;
const writeCounts = new WeakMap<Db, number>();

function maybeCheckpoint(db: Db): void {
  const n = (writeCounts.get(db) ?? 0) + 1;
  if (n < CHECKPOINT_EVERY) {
    writeCounts.set(db, n);
    return;
  }
  writeCounts.set(db, 0);
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
  } catch {
    // Checkpointing is opportunistic. Failing to reclaim WAL space is not a
    // reason to fail a committed write.
  }
}
