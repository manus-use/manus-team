import { describe, expect, it } from 'vitest';
import { NamedWorkspaces } from '../src/core/workspace.js';

describe('NamedWorkspaces', () => {
  const provider = new NamedWorkspaces(new Map([['default', '/srv/a'], ['docs', '/srv/b']]));

  it('gives a session the directory its workspace name stands for', async () => {
    expect(await provider.acquire('s_1', 'docs')).toEqual({ id: 'docs', kind: 'plain-dir', cwd: '/srv/b' });
    expect(provider.has('docs')).toBe(true);
    expect(provider.has('gone')).toBe(false);
  });

  it('refuses a name that is no longer configured, rather than using another', async () => {
    // A workspace removed from config strands its sessions (spec §2.3); quietly
    // running them in `default` would point an agent at a different checkout.
    await expect(provider.acquire('s_1', 'gone')).rejects.toThrow(/workspace gone is not configured/);
  });
});
