import { describe, expect, it } from 'vitest';
import { bytesecRenderer } from '../src/render/bytesec.js';
import type { AgentConfig } from '../src/config.js';
import type { Role } from '../src/roles.js';

/**
 * bytesec's renderer: which roles it takes, and the package a role becomes --
 * the layout copied from a real bytesec 0.7.4 package, which the spike loaded.
 */

function role(name: string, extra: Partial<Role> = {}, agent: Partial<AgentConfig> = {}): Role {
  return {
    name,
    source: 'directory',
    dir: `/roles/${name}`,
    description: undefined,
    workspace: undefined,
    agent: {
      driver: 'structured-cli',
      command: 'bytesec',
      args: ['run', '-m', 'model-a'],
      env: {},
      unsupervised: true,
      passEnv: [],
      readOnlyTools: [],
      maskExempt: [],
      ...agent,
    },
    roleMdPath: `/roles/${name}/role.md`,
    skills: [],
    secretValues: [],
    ...extra,
  };
}

const skill = (name: string) => ({ name, description: 'd', dir: `/s/${name}`, path: `/s/${name}/SKILL.md` });

function text(files: ReturnType<typeof bytesecRenderer.files>): Record<string, string> {
  return Object.fromEntries(files.map((f) => [f.path, f.bytes.toString('utf8')]));
}

describe('bytesecRenderer: which roles', () => {
  it('handles a structured-cli agent whose command is bytesec, by its basename', () => {
    expect(bytesecRenderer.handles(role('implementer'))).toBe(true);
    expect(bytesecRenderer.handles(role('implementer', {}, { command: '/opt/bin/bytesec' }))).toBe(true);
    // A wrapper may not pass --agent or the environment on.
    expect(bytesecRenderer.handles(role('implementer', {}, { command: 'bytesec-wrapper' }))).toBe(false);
    expect(bytesecRenderer.handles(role('implementer', {}, { driver: 'acp', command: 'bytesec' }))).toBe(false);
  });

  it('renders a role it handles unless something stands in the way, and says what', () => {
    expect(bytesecRenderer.refuses(role('implementer'))).toBeUndefined();
    expect(bytesecRenderer.refuses(role('bytesec-agent'))).toBe(
      'bytesec keeps the agent name bytesec-agent for its own agent',
    );
    expect(bytesecRenderer.refuses(role('implementer', {}, { args: ['run', '--agent', 'other'] }))).toBe(
      'its agent.args already choose a bytesec agent with --agent',
    );
    expect(bytesecRenderer.refuses(role('implementer', {}, { args: ['run', '--agent=other'] }))).toMatch(/--agent/);
    expect(bytesecRenderer.refuses(role('implementer', {}, { env: { BYTESEC_LOCAL_APM_PATH: '/p' } }))).toBe(
      'its environment already sets BYTESEC_LOCAL_APM_PATH',
    );
    expect(bytesecRenderer.refuses(role('implementer', {}, { env: { OPENCODE_LOCAL_APM_PATH: '/p' } }))).toBe(
      'its environment already sets OPENCODE_LOCAL_APM_PATH',
    );
    // Forwarded from the gateway's environment is set too.
    expect(bytesecRenderer.refuses(role('implementer', {}, { passEnv: ['BYTESEC_LOCAL_APM_PATH'] }))).toBe(
      'its environment already sets BYTESEC_LOCAL_APM_PATH',
    );
    expect(bytesecRenderer.refuses(role('Bad-'))).toBe('bytesec cannot name an agent "Bad-"');
  });

  it("refuses a role with a skill bytesec cannot load, by bytesec's own rule", () => {
    expect(bytesecRenderer.refuses(role('implementer', { skills: [skill('git-hygiene')] }))).toBeUndefined();
    for (const name of ['Testing', 'a--b', '-x', 'x_y', 'a'.repeat(65)]) {
      expect(bytesecRenderer.refuses(role('implementer', { skills: [skill(name)] }))).toMatch(
        /^bytesec cannot load its skill .*: a bytesec skill name is lowercase/,
      );
    }
  });
});

describe('bytesecRenderer: the package', () => {
  it('writes apm.json, the agent as mode primary with role.md as its body, and the skills', () => {
    const files = bytesecRenderer.files(
      role('implementer', { description: 'Writes: "code"\nwell' }),
      Buffer.from('You change code in this repository.\n'),
      [{ name: 'testing', files: [{ path: 'SKILL.md', bytes: Buffer.from('---\nname: testing\n---\n') }, { path: 'references/ci.md', bytes: Buffer.from('ci') }] }],
    );
    expect(files.map((f) => f.path)).toEqual([
      'apm.json',
      'agents/implementer.md',
      'skills/testing/SKILL.md',
      'skills/testing/references/ci.md',
    ]);
    const t = text(files);
    expect(JSON.parse(t['apm.json'] ?? '')).toEqual({
      name: 'implementer',
      description: 'Writes: "code" well',
      source: 'default',
      path: '',
    });
    expect(t['agents/implementer.md']).toBe(
      '---\nname: "implementer"\ndescription: "Writes: \\"code\\" well"\nmode: primary\n---\nYou change code in this repository.\n',
    );
    expect(t['skills/testing/references/ci.md']).toBe('ci');
  });

  it("gives role.md's bytes unchanged, and an empty body without one", () => {
    const bytes = Buffer.from([0x68, 0x69, 0xff, 0x0a]);
    const agent = bytesecRenderer.files(role('implementer'), bytes, []).find((f) => f.path === 'agents/implementer.md');
    expect(agent?.bytes.subarray(-4)).toEqual(bytes);
    const bare = text(bytesecRenderer.files(role('implementer', { roleMdPath: undefined }), undefined, []));
    // No body: bytesec keeps its own default identity.
    expect(bare['agents/implementer.md']).toBe('---\nname: "implementer"\ndescription: "the implementer role"\nmode: primary\n---\n');
  });

  it('launches the package by its directory and the role as the agent', () => {
    expect(bytesecRenderer.launch(role('implementer'), '/home/rendered/implementer/abc')).toEqual({
      args: ['--agent', 'implementer'],
      env: { BYTESEC_LOCAL_APM_PATH: '/home/rendered/implementer/abc' },
    });
  });
});
