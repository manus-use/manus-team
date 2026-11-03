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

  it('reads agent.native, which only a role directory has', () => {
    role('plain', AGENT);
    role('injected', `${AGENT}  native: false\n`);
    expect(load('plain').role.agent.native).toBeUndefined();
    expect(load('injected').role.agent.native).toBe(false);
    role('bad', `${AGENT}  native: no\n`);
    expect(() => load('bad')).toThrow(/agent\.native must be true or false, got "no"/);
  });

  it('requires every passEnv name to be set', () => {
    role('r', `${AGENT}  passEnv: [GH_TOKEN]\n`);
    expect(() => load('r')).toThrow(/names GH_TOKEN, which is not set/);
    expect(load('r', { GH_TOKEN: 'ghp_x' }).role.agent.env).toEqual({ GH_TOKEN: 'ghp_x' });
  });
});

describe('loadRoleDir: skills imported by name', () => {
  /** A user-level skill directory under a made-up home: never the real one. */
  function userSkill(root: string, name: string, description = `the ${name} skill`): string {
    const dir = join(rolesDir, 'home', root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nUse it.\n`);
    return dir;
  }
  const HOME = () => ({ HOME: join(rolesDir, 'home') });

  it("adds each named user skill after the role's own, from where bytesec would load it", () => {
    const dir = userSkill('.agents/skills', 'lark-doc');
    role('r', `${AGENT}  skills: [lark-doc]\n`, {
      'skills/testing/SKILL.md': '---\nname: testing\ndescription: How to test\n---\n',
    });
    expect(load('r', HOME()).role.skills).toEqual([
      expect.objectContaining({ name: 'testing' }),
      { name: 'lark-doc', description: 'the lark-doc skill', dir, path: join(dir, 'SKILL.md') },
    ]);
  });

  it("looks where bytesec looks, its config directory first, then .trae, .coco, .agents and .claude", () => {
    userSkill('.claude/skills', 'lark-im', 'from claude');
    userSkill('.agents/skills', 'lark-im', 'from agents');
    role('r', `${AGENT}  skills: [lark-im]\n`);
    expect(load('r', HOME()).role.skills[0]?.description).toBe('from agents');
    userSkill('.config/bytesec/skill', 'lark-im', 'from config skill');
    expect(load('r', HOME()).role.skills[0]?.description).toBe('from config skill');
    userSkill('.config/bytesec/skills', 'lark-im', 'from config skills');
    expect(load('r', HOME()).role.skills[0]?.description).toBe('from config skills');
    // XDG_CONFIG_HOME moves the config directory, as it moves bytesec's.
    const xdg = join(rolesDir, 'xdg');
    mkdirSync(join(xdg, 'bytesec', 'skills', 'lark-im'), { recursive: true });
    writeFileSync(join(xdg, 'bytesec', 'skills', 'lark-im', 'SKILL.md'), '---\nname: lark-im\ndescription: from xdg\n---\n');
    expect(load('r', { ...HOME(), XDG_CONFIG_HOME: xdg }).role.skills[0]?.description).toBe('from xdg');
  });

  it('does not follow a symlinked skill directory, and goes on to the next', () => {
    const real = userSkill('.agents/skills', 'lark-base');
    mkdirSync(join(rolesDir, 'home', '.trae', 'skills'), { recursive: true });
    symlinkSync(real, join(rolesDir, 'home', '.trae', 'skills', 'lark-base'));
    role('r', `${AGENT}  skills: [lark-base]\n`);
    expect(load('r', HOME()).role.skills[0]?.dir).toBe(real);
    rmSync(real, { recursive: true });
    expect(() => load('r', HOME())).toThrow(/a symlinked skill directory is not followed/);
  });

  it('refuses a name it cannot find, naming the role, and finds nothing without a home', () => {
    role('r', `${AGENT}  skills: [lark-missing]\n`);
    expect(() => load('r', HOME())).toThrow(/^role r: agent\.skills names lark-missing, which is in none of .*\.agents\/skills/);
    expect(() => load('r')).toThrow('role r: agent.skills names lark-missing, but HOME is not set, so there is nowhere to look');
  });

  it("refuses a name outside bytesec's skill-name rule, and one the role has itself", () => {
    userSkill('.agents/skills', 'testing');
    role('bad', `${AGENT}  skills: [Lark_Doc]\n`);
    expect(() => load('bad', HOME())).toThrow(/agent\.skills: "Lark_Doc" is not a skill name bytesec loads/);
    role('both', `${AGENT}  skills: [testing]\n`, { 'skills/testing/SKILL.md': '---\nname: testing\ndescription: d\n---\n' });
    expect(() => load('both', HOME())).toThrow('role both: skill testing is in its skills/ and in agent.skills; keep one');
  });

  it("checks an imported skill's front matter as it checks the role's own", () => {
    const dir = userSkill('.agents/skills', 'lark-task');
    writeFileSync(join(dir, 'SKILL.md'), 'no front matter');
    role('r', `${AGENT}  skills: [lark-task]\n`);
    expect(() => load('r', HOME())).toThrow(/must start with front matter/);
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

  it("leaves the values of maskExempt names out of the role's secrets", () => {
    const dir = role('r', `${AGENT}  passEnv: [BASE_URL]\n  maskExempt: [BASE_URL]\n`);
    writeFileSync(join(dir, '.env'), 'API_KEY=sk-role-12345678\n');
    chmodSync(join(dir, '.env'), 0o600);
    const { role: r } = load('r', { BASE_URL: 'https://example.invalid/v1' });
    expect(r.secretValues).toEqual(['sk-role-12345678']);
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
