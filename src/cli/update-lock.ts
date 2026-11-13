import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, openSync, readSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * `mt update`'s two locks (spec §20.10): one per checkout,
 * `<git dir>/mt-update.lock`, and one per home, `$MT_HOME/run/update.pid`.
 *
 * Each is taken as `lockGateway` takes the gateway's: written whole to a
 * staging file beside it and linked into place, which fails if one is there.
 * It holds one JSON line, what the update has recorded, rewritten by staging
 * and rename before each step begins, so it never names a step older than what
 * was done; its directory is synced after each link and rename. Removed by its
 * holder only. A lock left by an update that died is never cleared
 * automatically: two processes clearing one at once could each remove the
 * other's fresh lock, and an update that died needs a person anyway.
 */

/** The step an update is at, as its lock names it. Up to `show`, it has changed nothing. */
export type UpdateStep =
  | 'check'
  | 'show'
  | 'merge'
  | 'npm ci'
  | 'build'
  | 'preflight'
  | 'backup'
  | 'restart'
  | 'confirm'
  | 'going back';

/** The steps after which nothing has changed: step 3 or before. */
export const UNCHANGED_STEPS: readonly UpdateStep[] = ['check', 'show'];

export interface UpdateLockState {
  /** The update's own pid. */
  pid: number;
  home: string;
  checkout: string;
  step: UpdateStep;
  /** The commit the branch was on, and the upstream's. */
  old?: string | undefined;
  new?: string | undefined;
  /** The service's pid at step 3; null when it was not running. */
  servicePid?: number | null | undefined;
  /** The database's `user_version` at step 3; null when there was no database. */
  userVersion?: number | null | undefined;
  /** The database's path. */
  db?: string | undefined;
  /** The backup, once taken. */
  backup?: string | undefined;
}

/** What a lock file holds, or undefined for one that holds no update's state. Refuses what is not a file of its own. */
export function readUpdateLock(path: string): UpdateLockState | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP') throw new Error(`${path} is not a file of its own (a symlink); refusing to use it as the update lock`);
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a file of its own; refusing to use it as the update lock`);
    const buf = Buffer.alloc(64 * 1024);
    const text = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8').trim();
    try {
      const value = JSON.parse(text) as Partial<UpdateLockState>;
      if (typeof value.pid !== 'number' || typeof value.step !== 'string') return undefined;
      return value as UpdateLockState;
    } catch {
      return undefined;
    }
  } finally {
    closeSync(fd);
  }
}

/** The state written whole to a new staging file beside `path`, and synced, so the link or rename puts a whole file in place. */
function staged(path: string, state: UpdateLockState): string {
  const staging = join(dirname(path), `.${basename(path)}-${randomUUID()}`);
  const fd = openSync(staging, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(state)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return staging;
}

/** Sync the directory itself, so the link or rename that put the lock there survives a power cut. */
function syncDir(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class UpdateLock {
  private released = false;

  private constructor(
    readonly path: string,
    private readonly pid: number,
  ) {}

  /**
   * Take the lock at `path`, holding `state`; or, when it is there already,
   * what it holds: `held` undefined for a file that holds no update's state.
   * Never removes one that is there.
   */
  static take(path: string, state: UpdateLockState): UpdateLock | { held: UpdateLockState | undefined } {
    const staging = staged(path, state);
    try {
      linkSync(staging, path);
      syncDir(dirname(path));
      return new UpdateLock(path, state.pid);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return { held: readUpdateLock(path) };
    } finally {
      rmSync(staging, { force: true });
    }
  }

  /** Rewrite it whole, by staging and rename: only its holder does. */
  write(state: UpdateLockState): void {
    if (this.released) return;
    const staging = staged(this.path, state);
    try {
      renameSync(staging, this.path);
      syncDir(dirname(this.path));
    } finally {
      rmSync(staging, { force: true });
    }
  }

  /** Remove it, if it still names this process. */
  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      if (readUpdateLock(this.path)?.pid === this.pid) unlinkSync(this.path);
    } catch {
      // Gone already, or not ours: nothing of ours is left.
    }
  }
}
