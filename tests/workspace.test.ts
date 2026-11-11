import { describe, expect, it } from 'vitest';
import { NamedWorkspaces } from '../src/core/workspace.js';

describe('NamedWorkspaces', () => {
  const provider = new NamedWorkspaces(new Map([['default', '/srv/a'], ['docs', '/srv/b']]));

  it('gives a session the directory its workspace name stands for', async () => {
    expect(await provider.acquire('s_1', 'docs')).toEqual({ id: 'docs', kind: 'plain-dir', cwd: '/srv/b' });
    expect(provider.has('docs')).toBe(true);
    expect(provider.has('gone')).toBe(false);
  });

  it("gives a kanban run's session its task's own directory, as recorded when made", async () => {
    const own = new NamedWorkspaces(new Map([['default', '/srv/a']]), (id) =>
      id === 'wt:k_1' ? { kind: 'git-worktree', rootPath: '/home/mt/worktrees/web/k_1' } : undefined,
    );
    expect(own.has('wt:k_1')).toBe(true);
    expect(own.has('wt:k_2')).toBe(false);
    expect(await own.acquire('s_1', 'wt:k_1')).toEqual({ id: 'wt:k_1', kind: 'git-worktree', cwd: '/home/mt/worktrees/web/k_1' });
    expect(await own.acquire('s_1', 'default')).toEqual({ id: 'default', kind: 'plain-dir', cwd: '/srv/a' });
    await expect(own.acquire('s_1', 'wt:k_2')).rejects.toThrow(/workspace wt:k_2 is not configured/);
  });

  it('refuses a name that is no longer configured, rather than using another', async () => {
    // A workspace removed from config strands its sessions (spec §2.3); quietly
    // running them in `default` would point an agent at a different checkout.
    await expect(provider.acquire('s_1', 'gone')).rejects.toThrow(/workspace gone is not configured/);
  });
});
