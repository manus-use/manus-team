import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitReader } from '../src/kanban/commit.js';

/** The reported commit against real git (spec §7.8, §11): clean, dirty, not a repository, and no git. */

let dir: string;
/** git's environment: a made-up home, so no test reads the real one's configuration. */
let env: Record<string, string>;

function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-commit-')));
  env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: dir };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('commitReader with git', () => {
  it('reads a clean tree as its commit, and a changed one as uncommitted changes on top of it', async () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    sh(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    sh(repo, 'add', 'a.txt');
    sh(repo, 'commit', '-q', '-m', 'first');
    const head = sh(repo, 'rev-parse', 'HEAD');
    const read = commitReader();
    expect(await read(repo, { env })).toEqual({ commit: head, dirty: false });
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    expect(await read(repo, { env })).toEqual({ commit: head, dirty: true });
  });

  it("never runs the workspace's fsmonitor hook", async () => {
    const repo = join(dir, 'hooked');
    mkdirSync(repo);
    sh(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    sh(repo, 'add', 'a.txt');
    sh(repo, 'commit', '-q', '-m', 'first');
    const marker = join(dir, 'fsmonitor-ran');
    const hook = join(dir, 'fsmonitor.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    sh(repo, 'config', 'core.fsmonitor', hook);
    expect(await commitReader()(repo, { env })).toMatchObject({ dirty: false });
    expect(existsSync(marker)).toBe(false);
  });

  it('records nothing for a directory that is not a repository, and no commit, uncommitted, for one with no commit yet', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    sh(empty, 'init', '-q');
    // Never the repository above the temporary directory, if there is one.
    const outside = { ...env, GIT_CEILING_DIRECTORIES: dir };
    expect(await commitReader()(plain, { env: outside })).toEqual({ commit: null, dirty: null });
    expect(await commitReader()(empty, { env: outside })).toEqual({ commit: null, dirty: true });
  });

  it('records nothing when git is not installed', async () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    sh(repo, 'init', '-q');
    // A PATH with no git on it.
    const noGit = join(dir, 'empty-path');
    mkdirSync(noGit);
    expect(await commitReader()(repo, { env: { ...env, PATH: noGit } })).toEqual({ commit: null, dirty: null });
  });
});
