import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearSecrets } from '../src/secrets.js';
import { updateFake, type UpdateFake } from './helpers/update.js';

/**
 * `mt update`'s first step (spec §20.2): every refusal before anything
 * changes, each exit 1 with no merge, and the locks left as they were found.
 */

let fx: UpdateFake;
afterEach(() => {
  clearSecrets();
  fx.cleanup();
});

describe('mt update refuses before anything changes', () => {
  it('in a board run shell, before looking at anything', async () => {
    fx = await updateFake();
    const r = await fx.update(['--check'], { env: { MT_KANBAN_RUN: 'r_1' } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mt: mt update is an operator's command, not a board run's/);
    expect(fx.runs).toEqual([]);
  });

  it('a wrong command line, exit 2', async () => {
    fx = await updateFake();
    expect((await fx.update(['--check', '--yes'])).code).toBe(2);
    expect((await fx.update(['now'])).code).toBe(2);
    expect((await fx.update(['--force'])).code).toBe(2);
    expect(fx.runs).toEqual([]);
  });

  it('a checkout that is no git checkout, as one from a tarball', async () => {
    fx = await updateFake();
    fx.repo.top = undefined;
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/is not a git checkout, so there is nothing to update it from/);
  });

  it('a checkout that is not the top of its worktree', async () => {
    fx = await updateFake();
    fx.repo.top = fx.root;
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`is not the top of a git worktree (${fx.root} is)`);
  });

  it('a service that runs another checkout, naming both', async () => {
    fx = await updateFake();
    const other = join(fx.root, 'other checkout');
    mkdirSync(other);
    fx.install({ checkout: other });
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`the service runs ${other}, and this mt is ${fx.checkout}'s`);
    expect(r.err).toContain('mt service install');
  });

  it('a service on the same checkout by another path, which it is', async () => {
    fx = await updateFake();
    const link = join(fx.root, 'link to checkout');
    symlinkSync(fx.checkout, link);
    fx.install({ checkout: link });
    expect((await fx.update(['--check'])).code).toBe(0);
  });

  it('a unit that mt service install did not write', async () => {
    fx = await updateFake();
    writeFileSync(fx.install(), '<plist>by hand</plist>\n');
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/was not written by mt service install.*run mt service install to write it again/);
  });

  it("a service whose node is gone", async () => {
    fx = await updateFake();
    rmSync(fx.node);
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`the node the service runs, ${fx.node}, is gone`);
  });

  it('a service state that cannot be read on macOS, never taken as stopped', async () => {
    fx = await updateFake();
    fx.job.loaded = false;
    fx.domain = false;
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/the service's state cannot be read, and is not taken as stopped: launchctl print gui\/501 failed.*console/);
  });

  it('a service state that cannot be read on Linux', async () => {
    fx = await updateFake();
    fx.install({ platform: 'linux' });
    fx.override = (c) => (c.cmd === 'systemctl' && c.args[1] === 'show' ? { code: 1, stderr: 'Failed to connect to bus: No medium found' } : undefined);
    const r = await fx.update(['--check'], { platform: 'linux' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/cannot be read.*Failed to connect to bus.*loginctl enable-linger/);
  });

  it('another gateway holding the home, not the service', async () => {
    fx = await updateFake();
    mkdirSync(join(fx.mtHome, 'run'), { recursive: true, mode: 0o700 });
    writeFileSync(join(fx.mtHome, 'run', 'gateway.pid'), '777\n');
    fx.alive.add(777);
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/a gateway \(pid 777\) is running on .*, not as the service; perhaps npm run dev/);
  });

  it('a gateway holding the home with no service installed, as tsx watch would restart at the merge', async () => {
    fx = await updateFake({ service: 'none' });
    mkdirSync(join(fx.mtHome, 'run'), { recursive: true, mode: 0o700 });
    writeFileSync(join(fx.mtHome, 'run', 'gateway.pid'), '778\n');
    fx.alive.add(778);
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/a gateway \(pid 778\) is running on .* with no service installed.*tsx watch/);
  });

  it('a detached HEAD', async () => {
    fx = await updateFake();
    fx.repo.branch = undefined;
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/has a detached HEAD/);
  });

  it('a branch with no upstream, naming the command to set it, never guessing one', async () => {
    fx = await updateFake();
    fx.repo.branch = 'task/k_1';
    fx.repo.upstream = undefined;
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('task/k_1 has no upstream to update from. Name the one it tracks, once: git branch --set-upstream-to=origin/task/k_1');
    expect(fx.ran().some((w) => w.startsWith('git fetch'))).toBe(false);
  });

  it('a change to a tracked file, a staged one, and an untracked file', async () => {
    fx = await updateFake();
    fx.repo.status = [' M src/index.ts', 'A  notes.md', '?? scratch.txt'];
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toBe(`mt: ${fx.checkout} is not clean; commit, stash or remove these first:\n   M src/index.ts\n  A  notes.md\n  ?? scratch.txt`);
    expect(fx.ran()).toContain('git status --porcelain --untracked-files=normal');
  });

  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    it(`an operation under way that status may not show: ${name}`, async () => {
      fx = await updateFake();
      writeFileSync(join(fx.repo.gitDir, name), '');
      const r = await fx.update(['--check']);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`an operation is under way in ${fx.checkout} (${name})`);
    });
  }

  it('a failed fetch, with what git said, and nothing changed', async () => {
    fx = await updateFake();
    fx.answer = (run) => (run.args[0] === 'fetch' ? { code: 128, stderr: 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.' } : undefined);
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/git fetch origin failed \(exit 128\): .*Could not read from remote repository\. Nothing changed\. .*credential helper or an ssh agent/);
  });

  it('a branch that is not an ancestor of its upstream: commits made here, or a force-push', async () => {
    fx = await updateFake();
    fx.repo.ancestor = false;
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      'mt: main has commits origin/main does not: made here, or origin/main was rewritten (force-pushed). ' +
        'Joining them is for a person: see git log origin/main..main and git log main..origin/main',
    );
  });

  it('an ignored file at a path the incoming commits add', async () => {
    fx = await updateFake();
    fx.repo.added = ['docs/new.md', 'config.yaml', '.env'];
    writeFileSync(join(fx.checkout, 'config.yaml'), 'mine');
    writeFileSync(join(fx.checkout, '.env'), 'mine');
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/the incoming commits add config\.yaml, \.env, already in .* and ignored by git, which would overwrite them in the fast-forward without a word\. Move them aside/);
  });

  it("a home whose run directory is not its own", async () => {
    fx = await updateFake();
    mkdirSync(join(fx.root, 'elsewhere'));
    symlinkSync(join(fx.root, 'elsewhere'), join(fx.mtHome, 'run'));
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/run is not a directory of its own \(a symlink or a file\); refusing to put the update lock there/);
  });

  it('an update under way, by its live pid, from the home lock', async () => {
    fx = await updateFake();
    mkdirSync(join(fx.mtHome, 'run'), { recursive: true, mode: 0o700 });
    writeFileSync(join(fx.mtHome, 'run', 'update.pid'), `${JSON.stringify({ pid: 31337, home: fx.mtHome, checkout: fx.checkout, step: 'build' })}\n`);
    fx.alive.add(31337);
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`an update (pid 31337) is under way on ${fx.mtHome}, from ${fx.checkout}, at its step build`);
  });

  it("an update under way, from the checkout's lock", async () => {
    fx = await updateFake();
    writeFileSync(join(fx.repo.gitDir, 'mt-update.lock'), `${JSON.stringify({ pid: 31338, home: '/elsewhere', checkout: fx.checkout, step: 'merge' })}\n`);
    fx.alive.add(31338);
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('an update (pid 31338) is under way on /elsewhere');
  });
});

describe("mt update's checks", () => {
  it('run git in the checkout, never prompting, ssh in batch mode', async () => {
    fx = await updateFake();
    await fx.update(['--check']);
    const fetch = fx.runs.find((r) => r.args[0] === 'fetch');
    expect(fetch?.opts).toMatchObject({ cwd: fx.checkout, timeoutMs: 120_000 });
    expect(fetch?.opts.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' });
  });

  it("leave the user's own ssh command alone, from the environment or core.sshCommand", async () => {
    fx = await updateFake();
    await fx.update(['--check'], { env: { GIT_SSH_COMMAND: 'ssh -i mine' } });
    expect(fx.runs.find((r) => r.args[0] === 'fetch')?.opts.env['GIT_SSH_COMMAND']).toBe('ssh -i mine');
    fx.runs = [];
    fx.repo.sshCommand = true;
    await fx.update(['--check']);
    expect(fx.runs.find((r) => r.args[0] === 'fetch')?.opts.env['GIT_SSH_COMMAND']).toBeUndefined();
  });

  it('say so when the branch is up to date, exit 0, and release both locks', async () => {
    fx = await updateFake();
    fx.repo.upstreamSha = fx.repo.head;
    const r = await fx.update(['--check']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`manus-team at ${fx.checkout}, on main, tracking origin/main: up to date at 8b64aa1`);
    expect(fx.ran().filter((w) => w.startsWith('git log'))).toEqual([]);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(fx.repo.gitDir, 'mt-update.lock'))).toBe(false);
    expect(existsSync(join(fx.mtHome, 'run', 'update.pid'))).toBe(false);
  });
});
