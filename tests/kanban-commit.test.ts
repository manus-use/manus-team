import { describe, expect, it } from 'vitest';
import { commitReader, describeReported, type GitExec, type GitOptions } from '../src/kanban/commit.js';

/** Reading the reported commit (spec §7.8), over a git that starts nothing: each command's answer, as scripted. */

const SHA = '0123456789abcdef0123456789abcdef01234567';

function git(answers: Record<string, { code: number | null; stdout: string }>) {
  const calls: Array<{ args: readonly string[] } & GitOptions> = [];
  const exec: GitExec = async (args, opts) => {
    calls.push({ args, ...opts });
    return answers[args.join(' ')] ?? { code: 1, stdout: '' };
  };
  return { exec, calls };
}

const HEAD = 'rev-parse --verify --quiet HEAD^{commit}';
const STATUS = '--no-optional-locks status --porcelain';

describe('the reported commit', () => {
  it('records HEAD and a clean tree, reading in the workspace with the environment given', async () => {
    const { exec, calls } = git({ [HEAD]: { code: 0, stdout: `${SHA}\n` }, [STATUS]: { code: 0, stdout: '' } });
    const env = { PATH: '/usr/bin' };
    expect(await commitReader(exec)('/ws/web', { env })).toEqual({ commit: SHA, dirty: false });
    expect(calls.map((c) => [c.args.join(' '), c.cwd, c.env, c.timeoutMs])).toEqual([
      [HEAD, '/ws/web', env, 10_000],
      [STATUS, '/ws/web', env, 10_000],
    ]);
  });

  it('records uncommitted changes on top of HEAD', async () => {
    const { exec } = git({ [HEAD]: { code: 0, stdout: SHA }, [STATUS]: { code: 0, stdout: ' M src/a.ts\n?? b.ts\n' } });
    expect(await commitReader(exec)('/ws', { env: {} })).toEqual({ commit: SHA, dirty: true });
  });

  it('records no commit, and uncommitted, outside a repository or when git fails', async () => {
    const outside = git({ [HEAD]: { code: 128, stdout: '' } });
    expect(await commitReader(outside.exec)('/ws', { env: {} })).toEqual({ commit: null, dirty: true });
    expect(outside.calls).toHaveLength(1);
    const odd = git({ [HEAD]: { code: 0, stdout: 'HEAD' } });
    expect(await commitReader(odd.exec)('/ws', { env: {} })).toEqual({ commit: null, dirty: true });
    const noStatus = git({ [HEAD]: { code: 0, stdout: SHA }, [STATUS]: { code: null, stdout: '' } });
    expect(await commitReader(noStatus.exec)('/ws', { env: {} })).toEqual({ commit: SHA, dirty: true });
  });

  it('says what a reviewer reviews', () => {
    expect(describeReported({ reportedCommit: SHA, reportedDirty: false })).toBe(`review commit ${SHA}`);
    expect(describeReported({ reportedCommit: SHA, reportedDirty: true })).toBe(`uncommitted changes on top of ${SHA}`);
    expect(describeReported({ reportedCommit: null, reportedDirty: true })).toBe('uncommitted; no commit to review');
    expect(describeReported({ reportedCommit: null, reportedDirty: null })).toBeUndefined();
  });
});
