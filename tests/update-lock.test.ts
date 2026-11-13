import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UpdateLock, readUpdateLock, type UpdateLockState } from '../src/cli/update-lock.js';

/**
 * `mt update`'s locks (spec §20.10): taken atomically by link, holding one JSON
 * line, rewritten whole by their holder, removed only by it, and never cleared
 * automatically, however dead the pid they name.
 */

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mt-update-lock-'));
  path = join(dir, 'update.pid');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const STATE: UpdateLockState = { pid: 4321, home: '/h', checkout: '/c', step: 'check' };

function take(state: UpdateLockState = STATE): UpdateLock {
  const lock = UpdateLock.take(path, state);
  if (!(lock instanceof UpdateLock)) throw new Error('not taken');
  return lock;
}

describe('UpdateLock', () => {
  it('is taken with one JSON line, owner-only, and leaves no staging file', () => {
    take();
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(STATE)}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['update.pid']);
  });

  it('is refused while held, answering what it holds, and never removed, even for a dead pid', () => {
    writeFileSync(path, `${JSON.stringify({ ...STATE, pid: 999999, step: 'build', old: 'a', new: 'b' })}\n`);
    const second = UpdateLock.take(path, { ...STATE, pid: 1 });
    expect(second).toEqual({ held: { ...STATE, pid: 999999, step: 'build', old: 'a', new: 'b' } });
    expect(readUpdateLock(path)?.pid).toBe(999999);
    expect(readdirSync(dir)).toEqual(['update.pid']);
  });

  it('answers held undefined for a file that holds no update', () => {
    writeFileSync(path, 'garbage\n');
    expect(UpdateLock.take(path, STATE)).toEqual({ held: undefined });
    expect(existsSync(path)).toBe(true);
  });

  it('refuses a symlink in its place', () => {
    symlinkSync(join(dir, 'elsewhere'), path);
    writeFileSync(join(dir, 'elsewhere'), JSON.stringify(STATE));
    expect(() => UpdateLock.take(path, STATE)).toThrow(/is not a file of its own \(a symlink\)/);
  });

  it('is rewritten whole before each step by its holder, and removed by it', () => {
    const lock = take();
    lock.write({ ...STATE, step: 'backup', backup: '/h/backups/team-v8.db', servicePid: 4242, userVersion: 8 });
    expect(readUpdateLock(path)).toEqual({ ...STATE, step: 'backup', backup: '/h/backups/team-v8.db', servicePid: 4242, userVersion: 8 });
    expect(readdirSync(dir)).toEqual(['update.pid']);
    lock.release();
    expect(existsSync(path)).toBe(false);
    lock.release();
  });

  it('is not removed by a holder whose pid it no longer names', () => {
    const lock = take();
    writeFileSync(path, `${JSON.stringify({ ...STATE, pid: 77 })}\n`);
    lock.release();
    expect(readUpdateLock(path)?.pid).toBe(77);
  });
});
