import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearSecrets } from '../src/secrets.js';
import { OLD, TOP, startupLines, updateFake, type UpdateFake, type Run } from './helpers/update.js';

/**
 * Signals and a closed terminal (spec §20.11): SIGINT, SIGHUP and SIGTERM are
 * one. Before the merge the running child is stopped and nothing changes,
 * exit 1; from the merge to the backup the running command is let finish and
 * the update goes back; a second one while going back is ignored; the restart
 * call is let finish and the wait stops, exit 3. EPIPE and EIO on output are
 * not a failure.
 */

let fx: UpdateFake;
afterEach(() => {
  clearSecrets();
  fx.cleanup();
});

const words = (run: Run): string =>
  run.cmd === fx.node ? `node ${run.args.slice(1).join(' ')}` : [run.cmd === fx.npm ? 'npm' : run.cmd, ...run.args].join(' ');
const MT = (): string => `PATH='${join(fx.root, 'node bin')}':"$PATH" '${fx.node}' '${join(fx.checkout, 'dist', 'mt.js')}'`;
const restarted = (): boolean => fx.words().some((w) => / kill SIGTERM | kickstart /.test(` ${w} `));

describe('a signal before the merge', () => {
  for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM'] as const) {
    it(`${signal} during the fetch: its group is stopped, nothing changed, exit 1`, async () => {
      fx = await updateFake();
      let aborted: boolean | undefined;
      fx.answer = (run) => {
        if (run.args[0] !== 'fetch') return undefined;
        fx.signal?.(signal);
        aborted = run.opts.signal?.aborted;
        return { code: 143 };
      };
      const r = await fx.update(['--yes']);
      expect(r.code).toBe(1);
      expect(aborted).toBe(true);
      expect(r.err).toBe(`mt: interrupted by ${signal}: nothing changed`);
      expect(fx.ran().some((w) => w.startsWith('git merge --ff-only'))).toBe(false);
      expect(existsSync(join(fx.mtHome, 'run', 'update.pid'))).toBe(false);
    });
  }

  it('at the question: nothing changed, exit 1', async () => {
    fx = await updateFake();
    fx.whileAsking = () => fx.signal?.('SIGINT');
    const r = await fx.update([], { tty: true });
    expect(r.code).toBe(1);
    expect(r.err).toBe('mt: interrupted by SIGINT: nothing changed');
    expect(fx.ran().some((w) => w.startsWith('git merge --ff-only'))).toBe(false);
  });
});

describe('a signal after the last call of step 3', () => {
  for (const argv of [['--yes'], ['--check']]) {
    it(`stops ${argv[0]} with nothing changed, exit 1`, async () => {
      fx = await updateFake();
      const r = await fx.update(argv, {
        out: (line) => {
          if (line.startsWith('the service is running')) fx.signal?.('SIGTERM');
        },
      });
      expect(r.code).toBe(1);
      expect(r.err).toBe('mt: interrupted by SIGTERM: nothing changed');
      expect(fx.ran().some((w) => w.startsWith('git merge --ff-only'))).toBe(false);
    });
  }
});

describe('a signal from the merge to the backup', () => {
  for (const [word, step] of [
    ['git merge --ff-only', 'the merge'],
    ['npm run build', 'the build'],
    ['node service check', 'the check'],
  ] as const) {
    it(`during ${step}: let finish, then going back, exit 1`, async () => {
      fx = await updateFake();
      let builds = 0;
      fx.answer = (run) => {
        if (words(run).startsWith(word) && (word !== 'npm run build' || builds++ === 0)) fx.signal?.('SIGTERM');
        return undefined;
      };
      const r = await fx.update(['--yes']);
      expect(r.code).toBe(1);
      expect(r.out).toContain('SIGTERM: going back once the running command ends');
      expect(r.err).toBe('mt: interrupted by SIGTERM');
      expect(fx.ran()).toContain(`git reset --keep ${OLD}`);
      expect(restarted()).toBe(false);
    });
  }

  it('during the backup: let finish, then going back, exit 1, the restart never called', async () => {
    fx = await updateFake();
    // Sent once the backup has begun, while it is awaited.
    fx.whileBackingUp = () => setImmediate(() => fx.signal?.('SIGINT'));
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('SIGINT: going back once the running command ends');
    expect(r.out).toMatch(/^backed up the database to /m);
    expect(r.out.indexOf('SIGINT: going back')).toBeLessThan(r.out.indexOf('backed up the database'));
    expect(r.err).toBe('mt: interrupted by SIGINT');
    expect(fx.ran()).toContain(`git reset --keep ${OLD}`);
    expect(restarted()).toBe(false);
    expect(r.out).toContain('the checkout is back at 8b64aa1, and the gateway as it was');
  });

  it('during npm ci: let finish, then going back with npm ci again', async () => {
    fx = await updateFake();
    fx.repo.depsChanged = true;
    let cis = 0;
    fx.answer = (run) => {
      if (words(run) === 'npm ci' && cis++ === 0) fx.signal?.('SIGHUP');
      return undefined;
    };
    expect((await fx.update(['--yes'])).code).toBe(1);
    expect(fx.ran().filter((w) => w === 'npm ci')).toHaveLength(2);
  });

  it('a second one while going back is ignored, and going back carries on', async () => {
    fx = await updateFake();
    let builds = 0;
    fx.answer = (run) => {
      if (words(run) === 'npm run build' && builds++ === 0) fx.signal?.('SIGINT');
      if (run.args[0] === 'reset') fx.signal?.('SIGINT');
      return undefined;
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('SIGINT: ignored, as stopping now would leave the state being undone');
    expect(fx.ran().slice(-3)).toEqual([`git reset --keep ${OLD}`, 'npm run build', 'git status --porcelain --untracked-files=normal']);
  });
});

describe('a signal at the restart', () => {
  it("during macOS's drain: the call is let finish, then the steps back, exit 3", async () => {
    fx = await updateFake();
    fx.onStart = () => {};
    fx.override = (c) => {
      if (c.args[0] === 'kill') fx.signal?.('SIGINT');
      return undefined;
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(fx.words()).toContain('launchctl kickstart gui/501/team.manus.gateway');
    expect(r.out).toContain('SIGINT: the restart call is let finish');
    expect(r.err).toBe('mt: interrupted by SIGINT while waiting for the new gateway to connect');
    expect(r.out).toContain('the steps back, never taken by themselves');
    expect(readdirSync(join(fx.mtHome, 'backups'))).toHaveLength(1);
  });

  it("during Linux's systemctl restart: likewise, exit 3", async () => {
    fx = await updateFake();
    fx.install({ platform: 'linux' });
    fx.job.pid = 4242;
    fx.override = (c) => {
      if (c.args[1] === 'restart') fx.signal?.('SIGTERM');
      return undefined;
    };
    const r = await fx.update(['--yes'], { platform: 'linux' });
    expect(r.code).toBe(3);
    expect(fx.words()).toContain('systemctl --user restart manus-team.service');
  });

  it("during macOS's drain, the new gateway connected by then: says so, and prints no steps back, exit 3", async () => {
    fx = await updateFake();
    fx.override = (c) => {
      if (c.args[0] === 'kill') fx.signal?.('SIGINT');
      return undefined;
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.err).toBe('mt: interrupted by SIGINT while waiting for the new gateway to connect');
    expect(r.out).toContain(`it connected; check ${MT()} service status`);
    expect(r.out).not.toContain('the steps back');
    expect(r.out).not.toContain('cp ');
  });

  it('during the wait, the log saying connected as it came: says so, and prints no restore, exit 3', async () => {
    fx = await updateFake();
    fx.onStart = () => {};
    fx.whileSleeping = () => {
      appendFileSync(join(fx.mtHome, 'logs', 'gateway.log'), startupLines(TOP, fx.dbPath));
      fx.signal?.('SIGINT');
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.out).toContain(`it connected; check ${MT()} service status`);
    expect(r.out).not.toContain('cp ');
  });

  it('during the wait: it stops waiting, exit 3', async () => {
    fx = await updateFake();
    fx.onStart = () => {};
    fx.whileSleeping = () => fx.signal?.('SIGHUP');
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(fx.slept).toBe(250);
    expect(r.err).toBe('mt: interrupted by SIGHUP while waiting for the new gateway to connect');
  });
});

describe('output that cannot be written', () => {
  it('is no failure: EPIPE and EIO are ignored, and the update goes on', async () => {
    fx = await updateFake();
    let n = 0;
    const r = await fx.update(['--yes'], {
      out: () => {
        n += 1;
        const err = Object.assign(new Error('write EPIPE'), { code: n % 2 === 0 ? 'EPIPE' : 'EIO' });
        throw err;
      },
    });
    expect(r.code).toBe(0);
    expect(n).toBeGreaterThan(5);
  });
});
