import { describe, expect, it } from 'vitest';
import { commitReader, describeReported, type GitExec, type GitOptions } from '../src/kanban/commit.js';

/** Reading the reported commit (spec §7.8), over a git that starts nothing: each command's answer, as scripted. */

const SHA = '0123456789abcdef0123456789abcdef01234567';

type Answer = { code: number | null; stdout: string; error?: string };

function git(answers: Record<string, Answer>) {
  const calls: Array<{ args: readonly string[] } & GitOptions> = [];
  const exec: GitExec = async (args, opts) => {
    calls.push({ args, ...opts });
    return answers[args.join(' ')] ?? { code: 1, stdout: '' };
  };
  return { exec, calls };
}

const REPO = '--no-optional-locks rev-parse --git-dir';
const IN_REPO: Answer = { code: 0, stdout: '.git\n' };
const HEAD = 'rev-parse --verify --quiet HEAD^{commit}';
const STATUS = '--no-optional-locks status --porcelain';

describe('the reported commit', () => {
  it('records HEAD and a clean tree, reading in the workspace with the environment given', async () => {
    const { exec, calls } = git({
      [REPO]: IN_REPO,
      [HEAD]: { code: 0, stdout: `${SHA}\n` },
      [STATUS]: { code: 0, stdout: '' },
    });
    const env = { PATH: '/usr/bin' };
    expect(await commitReader(exec)('/ws/web', { env })).toEqual({ commit: SHA, dirty: false });
    expect(calls.map((c) => [c.args.join(' '), c.cwd, c.env, c.timeoutMs])).toEqual([
      [REPO, '/ws/web', env, 10_000],
      [HEAD, '/ws/web', env, 10_000],
      [STATUS, '/ws/web', env, 10_000],
    ]);
  });

  it('records uncommitted changes on top of HEAD', async () => {
    const { exec } = git({ [REPO]: IN_REPO, [HEAD]: { code: 0, stdout: SHA }, [STATUS]: { code: 0, stdout: ' M src/a.ts\n?? b.ts\n' } });
    expect(await commitReader(exec)('/ws', { env: {} })).toEqual({ commit: SHA, dirty: true });
  });

  it('records nothing outside a repository, or when git is not installed', async () => {
    const outside = git({ [REPO]: { code: 128, stdout: '' } });
    expect(await commitReader(outside.exec)('/ws', { env: {} })).toEqual({ commit: null, dirty: null });
    expect(outside.calls).toHaveLength(1);
    const missing = git({ [REPO]: { code: null, stdout: '', error: 'ENOENT' } });
    expect(await commitReader(missing.exec)('/ws', { env: {} })).toEqual({ commit: null, dirty: null });
    expect(missing.calls).toHaveLength(1);
  });

  it('records no commit, and uncommitted, in a repository with no commit yet or when git fails', async () => {
    const empty = git({ [REPO]: IN_REPO, [HEAD]: { code: 1, stdout: '' } });
    expect(await commitReader(empty.exec)('/ws', { env: {} })).toEqual({ commit: null, dirty: true });
    expect(empty.calls).toHaveLength(2);
    const timedOut = git({ [REPO]: { code: null, stdout: '' } });
    expect(await commitReader(timedOut.exec)('/ws', { env: {} })).toEqual({ commit: null, dirty: true });
    const odd = git({ [REPO]: IN_REPO, [HEAD]: { code: 0, stdout: 'HEAD' } });
    expect(await commitReader(odd.exec)('/ws', { env: {} })).toEqual({ commit: null, dirty: true });
    const noHead = git({ [REPO]: IN_REPO, [HEAD]: { code: null, stdout: '' } });
    expect(await commitReader(noHead.exec)('/ws', { env: {} })).toEqual({ commit: null, dirty: true });
    const noStatus = git({ [REPO]: IN_REPO, [HEAD]: { code: 0, stdout: SHA }, [STATUS]: { code: null, stdout: '' } });
    expect(await commitReader(noStatus.exec)('/ws', { env: {} })).toEqual({ commit: SHA, dirty: true });
  });

  it('says what a reviewer reviews', () => {
    expect(describeReported({ reportedCommit: SHA, reportedDirty: false })).toBe(`review commit ${SHA}`);
    expect(describeReported({ reportedCommit: SHA, reportedDirty: true })).toBe(`uncommitted changes on top of ${SHA}`);
    expect(describeReported({ reportedCommit: null, reportedDirty: true })).toBe('uncommitted; no commit to review');
    expect(describeReported({ reportedCommit: null, reportedDirty: null })).toBeUndefined();
  });
});
