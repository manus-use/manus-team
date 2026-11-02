import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverRoles, loadRoleDir } from '../src/roles.js';

/**
 * A role is a self-contained directory: its coding agent, its instructions,
 * its skills, its own secrets. Everything wrong with one is found at startup,
 * when it is a line to fix, not at the first claim, when it strands a task.
 */
let rolesDir: string;
const WORKSPACES = new Set(['default', 'docs']);

beforeEach(() => {
  rolesDir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-roles-')));
});

afterEach(() => rmSync(rolesDir, { recursive: true, force: true }));

const AGENT = 'agent:\n  driver: structured-cli\n  command: bytesec\n  args: [run]\n  unsupervised: true\n';

function role(name: string, config: string, files: Record<string, string> = {}): string {
  const dir = join(rolesDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), config);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function load(name: string, env: Record<string, string> = {}) {
  return loadRoleDir(name, join(rolesDir, name), env, WORKSPACES);
}

describe('discoverRoles', () => {
  it('finds role directories, ignores dot-entries, and reports anything else', () => {
    role('implementer', AGENT);
    role('reviewer', AGENT);
    mkdirSync(join(rolesDir, '.git'));
    writeFileSync(join(rolesDir, 'README.md'), 'notes');
    mkdirSync(join(rolesDir, 'Bad_Name'));
    const found = discoverRoles(rolesDir);
    expect(found.names).toEqual(['implementer', 'reviewer']);
    expect(found.notes).toHaveLength(2);
    expect(found.notes.join('\n')).toContain('README.md');
    expect(found.notes.join('\n')).toContain('Bad_Name');
  });

  it('finds nothing when there is no roles directory', () => {
    expect(discoverRoles(join(rolesDir, 'absent'))).toEqual({ names: [], notes: [] });
  });

  it('refuses a role named like a driver', () => {
    role('acp', AGENT);
    expect(() => discoverRoles(rolesDir)).toThrow(/reserved/);
  });
});

describe('loadRoleDir: config.yaml', () => {
  it('reads the agent, the workspace and the description', () => {
    role('implementer', `description: Writes code\nworkspace: docs\n${AGENT}`);
    const { role: r } = load('implementer');
    expect(r.description).toBe('Writes code');
    expect(r.workspace).toBe('docs');
    expect(r.agent.driver).toBe('structured-cli');
    expect(r.agent.command).toBe('bytesec');
    expect(r.agent.args).toEqual(['run']);
    expect(r.source).toBe('directory');
  });

  it('requires a config.yaml', () => {
    mkdirSync(join(rolesDir, 'empty'));
    expect(() => load('empty')).toThrow(/cannot read .*config\.yaml/);
  });

  it('refuses an unknown setting', () => {
    role('r', `${AGENT}colour: blue\n`);
    expect(() => load('r')).toThrow(/unknown setting colour/);
  });

  it("refuses a credential in the file, pointing at the role's .env", () => {
    role('r', `${AGENT}  apiToken: abc\n`);
    expect(() => load('r')).toThrow(/looks like a credential.*role's \.env/);
  });

  it('refuses a tools policy no available agent can enforce', () => {
    role('r', `${AGENT}tools:\n  deny: [deploy]\n`);
    expect(() => load('r')).toThrow(/declares a tools policy, but its agent's driver \(structured-cli\) cannot enforce one/);
  });

  it('refuses a workspace that is not configured', () => {
    role('r', `workspace: nowhere\n${AGENT}`);
    expect(() => load('r')).toThrow(/workspace "nowhere" is not configured/);
  });

  it('applies the supervision rule to the role agent', () => {
    role('r', 'agent:\n  driver: structured-cli\n  command: bytesec\n');
    expect(() => load('r')).toThrow(/has no way to ask for permission/);
  });

  it('requires every passEnv name to be set', () => {
    role('r', `${AGENT}  passEnv: [GH_TOKEN]\n`);
    expect(() => load('r')).toThrow(/names GH_TOKEN, which is not set/);
    expect(load('r', { GH_TOKEN: 'ghp_x' }).role.agent.env).toEqual({ GH_TOKEN: 'ghp_x' });
  });
});

describe('loadRoleDir: .env, role.md, skills', () => {
  function withEnv(text: string, mode = 0o600): void {
    const dir = role('r', `${AGENT}  passEnv: [GH_TOKEN]\n`);
    writeFileSync(join(dir, '.env'), text);
    chmodSync(join(dir, '.env'), mode);
  }

  it("gives the role's agent its .env values, and records them as secrets", () => {
    withEnv('API_KEY=sk-role\n');
    const { role: r } = load('r', { GH_TOKEN: 'ghp_x' });
    expect(r.agent.env).toEqual({ GH_TOKEN: 'ghp_x', API_KEY: 'sk-role' });
    expect([...r.secretValues].sort()).toEqual(['ghp_x', 'sk-role']);
  });

  it('refuses a .env other users can read, and leaves its mode alone', () => {
    withEnv('API_KEY=sk-role\n', 0o644);
    expect(() => load('r', { GH_TOKEN: 'ghp_x' })).toThrow(/must be readable and writable only by its owner \(for example 0600\)/);
  });

  it('refuses a .env that is a symlink', () => {
    const dir = role('r', AGENT);
    writeFileSync(join(rolesDir, 'elsewhere'), 'A=1\n');
    symlinkSync(join(rolesDir, 'elsewhere'), join(dir, '.env'));
    expect(() => load('r')).toThrow(/is a symlink/);
  });

  it('refuses a .env that is a FIFO, without waiting for a writer', () => {
    const dir = role('r', AGENT);
    execFileSync('mkfifo', [join(dir, '.env')]);
    expect(() => load('r')).toThrow(/is not a regular file/);
  });

  it("refuses the gateway's own names and PATH", () => {
    for (const line of ['MT_DB=x', 'LARK_APP_SECRET=x', 'PATH=/bin']) {
      withEnv(`${line}\n`);
      expect(() => load('r', { GH_TOKEN: 'ghp_x' })).toThrow(/may not be set in a role's \.env/);
      rmSync(join(rolesDir, 'r'), { recursive: true, force: true });
    }
  });

  it('refuses a variable set in .env and named in passEnv', () => {
    withEnv('GH_TOKEN=from-file\n');
    expect(() => load('r', { GH_TOKEN: 'ghp_x' })).toThrow(/GH_TOKEN is set in \.env and named in agent\.passEnv/);
  });

  it('accepts a role without a .env', () => {
    role('r', AGENT);
    expect(load('r').role.agent.env).toEqual({});
  });

  it('records role.md when it is there', () => {
    role('with', AGENT, { 'role.md': 'You change code.' });
    role('without', AGENT);
    expect(load('with').role.roleMdPath).toBe(join(rolesDir, 'with', 'role.md'));
    expect(load('without').role.roleMdPath).toBeUndefined();
  });

  it('reads each skill directory from its SKILL.md front matter', () => {
    role('r', AGENT, {
      'skills/testing/SKILL.md': '---\nname: testing\ndescription: How to run the tests\n---\nRun npm test.\n',
      'skills/testing/references/ci.md': 'notes',
    });
    const dir = join(rolesDir, 'r', 'skills', 'testing');
    expect(load('r').role.skills).toEqual([
      { name: 'testing', description: 'How to run the tests', dir, path: join(dir, 'SKILL.md') },
    ]);
  });

  it('refuses a skill without front matter', () => {
    role('r', AGENT, { 'skills/bare/SKILL.md': 'just text' });
    expect(() => load('r')).toThrow(/must start with front matter/);
  });

  it('refuses a skill directory with no SKILL.md', () => {
    role('r', AGENT, { 'skills/empty/notes.md': 'x' });
    expect(() => load('r')).toThrow(/needs a SKILL\.md/);
  });

  it("refuses a skill whose name is not its directory's", () => {
    role('r', AGENT, { 'skills/testing/SKILL.md': '---\nname: other\ndescription: d\n---\n' });
    expect(() => load('r')).toThrow(/does not match its directory/);
  });

  it('reports a loose file in skills/ and ignores it', () => {
    role('r', AGENT, { 'skills/stray.md': 'x' });
    const loaded = load('r');
    expect(loaded.role.skills).toEqual([]);
    expect(loaded.notes.join('\n')).toContain('stray.md');
  });
});
