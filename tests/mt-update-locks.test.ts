import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UpdateLockState, UpdateStep } from '../src/cli/update-lock.js';
import { openDb } from '../src/db/open.js';
import { clearSecrets } from '../src/secrets.js';
import { SECRET } from './helpers/service.js';
import { NEW, OLD, TOP, updateFake, type UpdateFake } from './helpers/update.js';

/**
 * A lock left by an update that died (spec §20.10): never cleared, never
 * taken as up to date, refused with what it says, and what to do: that it
 * changed nothing, or the steps back or forward by the database's version read
 * again, then the rm.
 */

let fx: UpdateFake;
afterEach(() => {
  clearSecrets();
  fx.cleanup();
});

const DEAD = 424_242;
const homeLock = (): string => join(fx.mtHome, 'run', 'update.pid');

function died(step: UpdateStep, extra: Partial<UpdateLockState> = {}, where: 'home' | 'checkout' = 'home'): string {
  const state: UpdateLockState = {
    pid: DEAD,
    home: fx.mtHome,
    checkout: fx.checkout,
    step,
    ...(['check'].includes(step) ? {} : { old: OLD, new: NEW }),
    ...(['check', 'show'].includes(step) ? {} : { servicePid: 4242, userVersion: TOP, db: fx.dbPath }),
    ...extra,
  };
  const path = where === 'home' ? homeLock() : join(fx.repo.gitDir, 'mt-update.lock');
  mkdirSync(join(fx.mtHome, 'run'), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state)}\n`);
  return path;
}

function migrateTo(version: number): void {
  const db = openDb(fx.dbPath);
  db.pragma(`user_version = ${version}`);
  db.close();
}

describe('an error nothing foresaw', () => {
  it('after the merge: the locks are kept, saying the step, exit 3; the next run gives the advice', async () => {
    fx = await updateFake();
    fx.onStart = () => {};
    fx.whileSleeping = () => {
      throw new Error(`disk on fire ${SECRET}`);
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.err).toBe('mt: unexpected error at its step confirm: disk on fire ••••');
    expect(r.out).toContain(`its locks are kept, saying where it stopped: ${join(fx.repo.gitDir, 'mt-update.lock')}, ${homeLock()}; run mt update again for what to do`);
    expect(existsSync(homeLock())).toBe(true);
    fx.whileSleeping = () => {};
    const again = await fx.update(['--yes']);
    expect(again.code).toBe(1);
    expect(again.err).toContain('died at its step confirm');
    expect(again.out).toContain('the steps back:');
  });

  it('before the merge: nothing changed, the locks go, exit 1, masked', async () => {
    fx = await updateFake();
    fx.whileAsking = () => {
      throw new Error(`no tty ${SECRET}`);
    };
    const r = await fx.update([], { tty: true });
    expect(r.code).toBe(1);
    expect(r.err).toBe('mt: unexpected error: no tty ••••');
    expect(existsSync(homeLock())).toBe(false);
    expect(existsSync(join(fx.repo.gitDir, 'mt-update.lock'))).toBe(false);
  });
});

describe('a lock left by an update that died', () => {
  for (const step of ['check', 'show'] as const) {
    it(`at ${step}: it changed nothing, remove it; exit 1, the lock kept`, async () => {
      fx = await updateFake();
      const path = died(step);
      const r = await fx.update(['--yes']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(new RegExp(`^mt: an update \\(pid ${DEAD}\\) died at its step ${step}.*; its lock is never cleared by itself: `));
      expect(r.out).toBe(`it changed nothing; remove its lock: rm '${path}'`);
      expect(existsSync(path)).toBe(true);
      expect(fx.ran().some((w) => w.startsWith('git fetch'))).toBe(false);
    });
  }

  for (const step of ['merge', 'npm ci', 'build', 'preflight', 'backup', 'going back'] as const) {
    it(`at ${step}, the database's version unchanged: the steps back, then the rm`, async () => {
      fx = await updateFake();
      const path = died(step);
      const r = await fx.update(['--yes']);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`died at its step ${step}, updating 8b64aa1..4f0c2de`);
      expect(r.out).toContain(`the database is still at version ${TOP}\nthe steps back:`);
      expect(r.out).toContain(`  git reset --keep ${OLD}`);
      expect(r.out).not.toContain('cp ');
      expect(r.out.split('\n').slice(-1)).toEqual([`then remove its lock: rm '${path}'`]);
      expect(r.out).not.toMatch(/up to date/);
    });

    it(`at ${step}, the database's version moved: the steps forward`, async () => {
      fx = await updateFake();
      died(step);
      migrateTo(TOP + 1);
      const r = await fx.update(['--yes']);
      expect(r.out).toContain(`the database moved from version ${TOP} to version ${TOP + 1}: the old build can no longer run on it\nthe steps forward:`);
      expect(r.out).not.toContain('git reset --keep');
    });
  }

  for (const step of ['restart', 'confirm'] as const) {
    it(`at ${step} with a backup named, unchanged: the steps back with its restore`, async () => {
      fx = await updateFake();
      died(step, { backup: '/b/team-v8.db' });
      const r = await fx.update(['--yes']);
      expect(r.out).toContain(`  cp '/b/team-v8.db' '${fx.dbPath}'`);
    });

    it(`at ${step} with a backup named, moved: the steps forward, and the steps back with its restore remain possible`, async () => {
      fx = await updateFake();
      died(step, { backup: '/b/team-v8.db' });
      migrateTo(TOP + 1);
      const r = await fx.update(['--yes']);
      expect(r.out).toContain('the steps forward:');
      expect(r.out).toContain('or the steps back, with its backup, which remain possible:');
      expect(r.out).toContain(`  cp '/b/team-v8.db' '${fx.dbPath}'`);
    });
  }

  it('left in both places: one message, and an rm of both', async () => {
    fx = await updateFake();
    const home = died('build');
    const checkout = died('build', {}, 'checkout');
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`its locks are never cleared by itself: ${checkout}, ${home}`);
    expect(r.out.split('\n').slice(-1)).toEqual([`then remove its locks: rm '${checkout}' '${home}'`]);
    expect(r.out.match(/the steps back:/g)).toHaveLength(1);
  });

  it("in the checkout's lock, of another home: no steps, but how to ask that home", async () => {
    fx = await updateFake();
    died('backup', { home: '/srv/other home' }, 'checkout');
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toBe("mt: an update of /srv/other home died at its step backup; run MT_HOME='/srv/other home' mt update for what to do");
    expect(r.out).toBe('');
  });

  it("whose database cannot be read: both ways, and how to read the version", async () => {
    fx = await updateFake();
    const garbage = join(fx.root, 'not a database.db');
    writeFileSync(garbage, 'not sqlite at all, but long enough to be read as a header '.repeat(10));
    died('build', { db: garbage });
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^the database's version cannot be read here \(.*\): read it with .* service check$/m);
    expect(r.out).toContain(`at version ${TOP}, the steps back:`);
    expect(r.out).toContain('at another, the steps forward:');
  });

  it("in the checkout's lock too", async () => {
    fx = await updateFake();
    const path = died('build', {}, 'checkout');
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.out.split('\n').slice(-1)).toEqual([`then remove its lock: rm '${path}'`]);
  });

  it('a lock file that holds no update', async () => {
    fx = await updateFake();
    mkdirSync(join(fx.mtHome, 'run'), { recursive: true, mode: 0o700 });
    writeFileSync(homeLock(), 'garbage');
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toBe(`mt: ${homeLock()} holds no update's state; if no mt update runs, remove it: rm '${homeLock()}'`);
  });
});
