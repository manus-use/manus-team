import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/config.js';
import { buildDriver, buildRoleDrivers } from '../src/driver/build.js';
import type { Role } from '../src/roles.js';

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    driver: 'structured-cli',
    command: '/nonexistent/agent',
    args: [],
    env: {},
    unsupervised: true,
    passEnv: [],
    readOnlyTools: [],
    maskExempt: [],
    ...over,
  };
}

function role(name: string, a: AgentConfig): Role {
  return {
    name,
    source: 'directory',
    dir: undefined,
    description: undefined,
    workspace: undefined,
    agent: a,
    roleMdPath: undefined,
    skills: [],
    secretValues: [],
  };
}

describe('buildDriver', () => {
  it('builds the driver its kind names', () => {
    expect(buildDriver(agent({ driver: 'structured-cli' })).id).toBe('structured-cli');
    expect(buildDriver(agent({ driver: 'acp', unsupervised: false })).id).toBe('acp');
  });
});

describe('buildRoleDrivers', () => {
  it('gives two roles of one kind each their own driver, with their own command', async () => {
    // Impossible with the old process-wide registry, which refused a second
    // structured-cli. Each driver starts its own role's command, which a missing
    // binary makes visible without spawning anything.
    const drivers = buildRoleDrivers(
      new Map([
        ['implementer', role('implementer', agent({ command: '/nonexistent/implementer' }))],
        ['reviewer', role('reviewer', agent({ command: '/nonexistent/reviewer' }))],
      ]),
    );
    expect([...drivers.keys()].sort()).toEqual(['implementer', 'reviewer']);
    await expect(drivers.get('implementer')?.start({ cwd: tmpdir() })).rejects.toThrow(/implementer/);
    await expect(drivers.get('reviewer')?.start({ cwd: tmpdir() })).rejects.toThrow(/reviewer/);
  });

  it('builds a separate driver per role even when the agent blocks are equal', () => {
    const same = agent();
    const drivers = buildRoleDrivers(new Map([['a', role('a', same)], ['b', role('b', same)]]));
    expect(drivers.get('a')).not.toBe(drivers.get('b'));
  });
});
