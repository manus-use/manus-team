import Database from 'better-sqlite3';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readUpdateLock } from '../src/cli/update-lock.js';
import { openDb } from '../src/db/open.js';
import { clearSecrets } from '../src/secrets.js';
import { NEW, OLD, TOP, updateFake, type UpdateFake } from './helpers/update.js';

/**
 * `mt update`'s steps 4 to 6 (spec §20.4 to §20.8): the fast-forward, npm ci
 * only when it must, the build, the new build's check and the backup; each
 * failure going back with reset --keep, npm ci only if one ran, and the build,
 * the restart never called; and a gateway that moved meanwhile stopping it,
 * exit 3, with no going back.
 */

let fx: UpdateFake;
afterEach(() => {
  clearSecrets();
  fx.cleanup();
});

const NPM = (): string => `PATH='${join(fx.root, 'node bin')}':"$PATH" '${fx.npm}'`;
const MT = (): string => `PATH='${join(fx.root, 'node bin')}':"$PATH" '${fx.node}' '${join(fx.checkout, 'dist', 'mt.js')}'`;
/** The check that the tree is clean once gone back. */
const STATUS = 'git status --porcelain --untracked-files=normal';
const restarted = (): boolean => fx.words().some((w) => / kill SIGTERM | kickstart /.test(` ${w} `));
/** The calls after the fetch's checks: what the update did. */
const did = (): string[] => {
  const all = fx.ran();
  return all.slice(all.findIndex((w) => w.startsWith('git diff --quiet')) + 1);
};
const failing = (word: string, result: { code?: number; stderr?: string; timedOut?: boolean }) => (run: { cmd: string; args: string[] }) =>
  [run.cmd === fx.npm ? 'npm' : run.cmd === fx.node ? 'node' : run.cmd, ...run.args].join(' ').startsWith(word) ? result : undefined;

describe('mt update --yes', () => {
  it('fast-forwards, builds, checks, backs up, restarts and confirms, exit 0', async () => {
    fx = await updateFake();
    const r = await fx.update(['--yes']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(did()).toEqual(['git merge --ff-only origin/main', 'npm run build', 'node service check']);
    expect(r.out).toContain(`updated main from 8b64aa1 to 4f0c2de; the gateway is connected, at schema version ${TOP}`);
    const backups = readdirSync(join(fx.mtHome, 'backups'));
    expect(backups).toEqual([`team-v${TOP}-8b64aa1-20261112T153000Z.db`]);
    expect(statSync(join(fx.mtHome, 'backups')).mode & 0o777).toBe(0o700);
    expect(fx.words().filter((w) => / (kill|kickstart) /.test(` ${w} `))).toEqual([
      'launchctl kill SIGTERM gui/501/team.manus.gateway',
      'launchctl kickstart gui/501/team.manus.gateway',
    ]);
    expect(existsSync(join(fx.mtHome, 'run', 'update.pid'))).toBe(false);
  });

  it('runs npm with the node the unit records, its directory first on PATH, and the check with no board-run variable', async () => {
    fx = await updateFake();
    await fx.update(['--yes'], { env: { MT_HOME: undefined } });
    const build = fx.runs.find((r) => r.cmd === fx.npm);
    expect(build?.opts.env['PATH']).toBe(`${join(fx.root, 'node bin')}:/usr/bin:/bin`);
    expect(build?.opts.timeoutMs).toBe(10 * 60_000);
    const check = fx.runs.find((r) => r.cmd === fx.node);
    expect(check?.args).toEqual([join(fx.checkout, 'dist', 'mt.js'), 'service', 'check']);
    expect(Object.keys(check?.opts.env ?? {}).filter((k) => k.startsWith('MT_KANBAN_'))).toEqual([]);
    expect(fx.runs.find((r) => r.args[0] === 'merge')?.opts.timeoutMs).toBe(120_000);
  });

  it('runs npm ci when the dependencies changed, within 20 minutes, and skips it when neither file did', async () => {
    fx = await updateFake();
    fx.repo.depsChanged = true;
    await fx.update(['--yes']);
    expect(did().slice(0, 3)).toEqual(['git merge --ff-only origin/main', 'npm ci', 'npm run build']);
    expect(fx.runs.find((r) => r.cmd === fx.npm && r.args[0] === 'ci')?.opts.timeoutMs).toBe(20 * 60_000);
  });

  it('changes nothing when step 2 refuses: no merge, no npm, no restart', async () => {
    fx = await updateFake();
    fx.repo.ancestor = false;
    expect((await fx.update(['--yes'])).code).toBe(1);
    expect(fx.ran().filter((w) => /^git (merge --ff-only|reset)|^npm |^node /.test(w))).toEqual([]);
    expect(restarted()).toBe(false);
  });

  it('prints what the new build\'s check says', async () => {
    fx = await updateFake();
    const r = await fx.update(['--yes']);
    expect(r.out).toContain(`  database: ${fx.dbPath} at version ${TOP}; this build: up to ${TOP}`);
  });
});

describe('a failure in steps 4 to 6 goes back', () => {
  it('a failed build: reset --keep to the old commit, the build again, no npm ci, the restart never called, exit 1', async () => {
    fx = await updateFake();
    let builds = 0;
    fx.answer = (run) => (run.cmd === fx.npm && run.args[1] === 'build' && builds++ === 0 ? { code: 2, stdout: 'src/x.ts(1,1): error TS1005\n' } : undefined);
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(did()).toEqual(['git merge --ff-only origin/main', 'npm run build', `git reset --keep ${OLD}`, 'npm run build', STATUS]);
    expect(fx.repo.head).toBe(OLD);
    expect(r.err).toBe('mt: npm run build failed (exit 2)\n  src/x.ts(1,1): error TS1005');
    expect(r.out).toContain('the checkout is back at 8b64aa1, and the gateway as it was');
    expect(restarted()).toBe(false);
    expect(existsSync(join(fx.mtHome, 'backups'))).toBe(false);
  });

  it('a failed npm ci: npm ci again going back, as it may have left node_modules half there', async () => {
    fx = await updateFake();
    fx.repo.depsChanged = true;
    let cis = 0;
    fx.answer = (run) => (run.cmd === fx.npm && run.args[0] === 'ci' && cis++ === 0 ? { code: 1, stderr: 'npm ERR! network' } : undefined);
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(did()).toEqual(['git merge --ff-only origin/main', 'npm ci', `git reset --keep ${OLD}`, 'npm ci', 'npm run build', STATUS]);
  });

  it('a failed check of the new build, with its last lines, masked', async () => {
    fx = await updateFake();
    fx.answer = failing('node', { code: 1, stderr: `mt: the gateway would not start as the service: ${'lark-secret-never-printed-0000'}` });
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mt: mt service check failed \(exit 1\)\n {2}mt: the gateway would not start as the service: ••••$/);
    expect(did()).toEqual(['git merge --ff-only origin/main', 'npm run build', 'node service check', `git reset --keep ${OLD}`, 'npm run build', STATUS]);
  });

  it('a merge that failed, and one that timed out with HEAD at the new commit, both go back', async () => {
    fx = await updateFake();
    fx.answer = failing('git merge --ff-only', { code: 1, stderr: 'fatal: Not possible to fast-forward' });
    expect((await fx.update(['--yes'])).code).toBe(1);
    expect(did()).toContain(`git reset --keep ${OLD}`);
    fx.runs = [];
    fx.answer = (run) => {
      if (run.args[0] !== 'merge') return undefined;
      fx.repo.head = NEW;
      return { code: 143, timedOut: true };
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('mt: git merge --ff-only origin/main did not finish in 120 seconds (HEAD is at 4f0c2de: the merge landed, and its post-merge hook did not end)');
    expect(fx.repo.head).toBe(OLD);
  });

  it('a build past its 10 minutes', async () => {
    fx = await updateFake();
    let builds = 0;
    fx.answer = (run) => (run.cmd === fx.npm && builds++ === 0 ? { code: 143, timedOut: true } : undefined);
    expect((await fx.update(['--yes'])).err).toContain('mt: npm run build did not finish in 10 minutes');
  });

  it('a failed backup', async () => {
    fx = await updateFake();
    const { mkdirSync, symlinkSync } = await import('node:fs');
    mkdirSync(join(fx.root, 'not mine'));
    symlinkSync(join(fx.root, 'not mine'), join(fx.mtHome, 'backups'));
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mt: the backup failed: .*backups is not a directory of its own/);
    expect(did()).toContain(`git reset --keep ${OLD}`);
    expect(restarted()).toBe(false);
  });

  it('going back that fails too: git status and the commands to finish by hand, exit 3', async () => {
    fx = await updateFake();
    fx.answer = (run) => {
      if (run.cmd === fx.npm && run.args[1] === 'build') return { code: 2, stdout: 'error TS1005' };
      return undefined;
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.err).toContain('mt: npm run build failed (exit 2); and going back, npm run build failed (exit 2):');
    expect(r.out).toContain('git status says:\n  On branch main');
    expect(r.out).toContain(`to finish going back by hand:\n  cd '${fx.checkout}' && ${NPM()} ci && ${NPM()} run build`);
    expect(r.out).toContain('a crash restart would run whatever dist/ and node_modules now hold');
  });

  it('a tree not clean after going back: stuck, with what git status says, exit 3', async () => {
    fx = await updateFake();
    let builds = 0;
    fx.answer = (run) => {
      if (run.cmd === fx.npm && run.args[1] === 'build' && builds++ === 0) return { code: 2 };
      if (run.args[0] === 'status' && run.args[1] === '--porcelain' && builds > 0) return { stdout: '?? dist-leftover.txt\n' };
      return undefined;
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.err).toBe('mt: npm run build failed (exit 2); and going back, the checkout is not clean:\n  ?? dist-leftover.txt');
    expect(r.out).not.toContain('the checkout is back at');
    expect(r.out).toContain(`to finish going back by hand:\n  cd '${fx.checkout}' && ${NPM()} ci && ${NPM()} run build`);
  });

  it('a reset that fails going back names it in the commands to finish', async () => {
    fx = await updateFake();
    fx.answer = (run) => (run.args[0] === 'reset' ? { code: 1, stderr: "error: Entry 'x' not uptodate. Cannot merge." } : run.cmd === fx.npm ? { code: 2 } : undefined);
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.out).toContain(`cd '${fx.checkout}' && git reset --keep ${OLD} && ${NPM()} ci`);
  });
});

describe('a gateway that moved during the update', () => {
  it('only its pid, at the backup: the steps back reading the version again, and the steps forward, exit 3, no going back', async () => {
    fx = await updateFake();
    fx.answer = (run) => {
      if (run.cmd === fx.node) fx.job.pid = 4310;
      return undefined;
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.err).toBe(`mt: the service's pid was 4242 and is 4310; the database is still at version ${TOP}`);
    expect(r.out).toContain(`  ${MT()} service check  # it should print "at version ${TOP}"`);
    expect(r.out).toContain('the steps forward, if the check prints another version:');
    expect(did()).not.toContain(`git reset --keep ${OLD}`);
    expect(existsSync(join(fx.mtHome, 'backups'))).toBe(false);
    expect(restarted()).toBe(false);
  });

  it('its database version, at the backup: the steps forward, no backup, exit 3', async () => {
    fx = await updateFake();
    fx.answer = (run) => {
      if (run.cmd === fx.node) {
        const db = openDb(fx.dbPath);
        db.pragma(`user_version = ${TOP + 1}`);
        db.close();
      }
      return undefined;
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.err).toBe(
      `mt: the database moved from version ${TOP} to version ${TOP + 1} before a backup was taken: the old build can no longer run on it, and there is no way back`,
    );
    expect(r.out).toContain(`the steps forward, which make the new tree whole and start it:\n  cd '${fx.checkout}'\n  ${NPM()} ci && ${NPM()} run build\n  ${MT()} service check\n  ${MT()} service restart`);
    expect(existsSync(join(fx.mtHome, 'backups'))).toBe(false);
  });

  it('its pid, at going back: no going back either, exit 3', async () => {
    fx = await updateFake();
    fx.answer = (run) => {
      if (run.cmd !== fx.npm) return undefined;
      fx.job.pid = 4311;
      return { code: 2 };
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.err).toContain("the service's pid was 4242 and is 4311");
    expect(did()).toEqual(['git merge --ff-only origin/main', 'npm run build']);
  });

  it('its version, at going back: the steps forward, exit 3', async () => {
    fx = await updateFake();
    fx.answer = (run) => {
      if (run.cmd !== fx.npm) return undefined;
      const db = new Database(fx.dbPath);
      db.pragma(`user_version = ${TOP + 1}`);
      db.close();
      return { code: 2 };
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.err).toContain(`moved from version ${TOP} to version ${TOP + 1} before a backup was taken`);
  });

  it('the lock records the pid and the version at step 3, and each step before it begins', async () => {
    fx = await updateFake();
    const steps: unknown[] = [];
    fx.answer = (run) => {
      steps.push(readUpdateLock(join(fx.mtHome, 'run', 'update.pid'))?.step);
      if (run.cmd === fx.npm) expect(readUpdateLock(join(fx.repo.gitDir, 'mt-update.lock'))).toMatchObject({ servicePid: 4242, userVersion: TOP, old: OLD, new: NEW, db: fx.dbPath });
      return undefined;
    };
    await fx.update(['--yes']);
    expect([...new Set(steps.filter((s) => s !== undefined))]).toEqual(['check', 'show', 'merge', 'build', 'preflight']);
  });
});

describe('a service that is stopped, or none', () => {
  it('is not started: the update stops after the backup, exit 0', async () => {
    fx = await updateFake({ service: 'stopped' });
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(0);
    expect(readdirSync(join(fx.mtHome, 'backups'))).toHaveLength(1);
    expect(r.out).toContain(`the service is stopped, so it is not started: start it with ${MT()} service start`);
    expect(fx.words().filter((w) => / (kickstart|bootstrap) /.test(` ${w} `))).toEqual([]);
  });

  it('with no service, the backup is taken and the restart is the person\'s', async () => {
    fx = await updateFake({ service: 'none' });
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(0);
    expect(readdirSync(join(fx.mtHome, 'backups'))).toHaveLength(1);
    expect(r.out).toContain('no service is installed: restart the gateway (stop it if it runs, then start it)');
  });
});
