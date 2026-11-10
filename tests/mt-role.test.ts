import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseAgentVersion, versionBelow } from '../src/cli/role.js';
import { loadTeamSettings } from '../src/config.js';
import { loadRoleDir } from '../src/roles.js';
import { loadTeam } from '../src/team.js';
import { migrate, openDb } from '../src/db/open.js';
import { registerWorkspaces } from '../src/db/workspaces.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

let fx: MtFixture;
afterEach(() => fx.cleanup());

function roleDir(name: string, config: string): string {
  const dir = join(fx.home, 'roles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), config);
  return dir;
}

const ACP_AGENT = 'agent:\n  driver: acp\n  command: claude-agent-acp\n';

/** The fixture's own config, with a kanban: section of these limits. */
function limitsConfig(kanban: Record<string, number>): (workspace: string) => string {
  return (workspace) =>
    [
      `workspace: ${workspace}`,
      'agent:',
      '  driver: structured-cli',
      '  command: bytesec',
      '  args: [run, -m, test-model]',
      '  unsupervised: true',
      'kanban:',
      ...Object.entries(kanban).map(([k, v]) => `  ${k}: ${v}`),
      '',
    ].join('\n');
}

/** Every regular file under `dir`, not following symlinks. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

describe('mt role list', () => {
  it('lists the role default from the agent: block, and each role directory', async () => {
    fx = mtFixture();
    roleDir('reviewer', `description: Reviews code\n${ACP_AGENT}`);
    const r = await fx.run(['role', 'list']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^default\s+structured-cli\s+agent: block\s+max_running none$/m);
    expect(r.out).toMatch(/^reviewer\s+acp\s+roles\/reviewer\s+max_running none\s+Reviews code$/m);
  });

  it("shows each role's max_running and where it comes from: the role, the default, or none", async () => {
    fx = mtFixture(limitsConfig({ max_running: 4, max_running_per_role: 2 }));
    roleDir('implementer', `max_running: 3\n${ACP_AGENT}`);
    roleDir('reviewer', ACP_AGENT);
    // Read loosely, as the rest of the line is: mt role check says what is wrong.
    roleDir('broken', `max_running: lots\n${ACP_AGENT}`);
    const r = await fx.run(['role', 'list']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^default\s+structured-cli\s+agent: block\s+max_running 2 \(per_role\)$/m);
    expect(r.out).toMatch(/^implementer\s+acp\s+roles\/implementer\s+max_running 3 \(role\)$/m);
    expect(r.out).toMatch(/^reviewer\s+acp\s+roles\/reviewer\s+max_running 2 \(per_role\)$/m);
    expect(r.out).toMatch(/^broken\s+acp\s+roles\/broken\s+max_running \?$/m);
    // Above kanban.max_running, which check and startup refuse, it is not shown as a limit either.
    roleDir('greedy', `max_running: 5\n${ACP_AGENT}`);
    expect((await fx.run(['role', 'list'])).out).toMatch(/^greedy\s+acp\s+roles\/greedy\s+max_running \?$/m);
  });

  it('refuses an unknown option as a usage error', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'list', '--bogus']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/bogus/);
  });
});

describe('mt role create', () => {
  it('writes a role from the agent: block, with an empty owner-only .env and a .gitignore', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'create', 'reviewer']);
    expect(r.code).toBe(0);
    const dir = join(fx.home, 'roles', 'reviewer');
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('');
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.env\n');
    expect(statSync(join(dir, 'skills')).isDirectory()).toBe(true);
    expect(existsSync(join(dir, 'role.md'))).toBe(true);
    const config = parseYaml(readFileSync(join(dir, 'config.yaml'), 'utf8')) as { agent: Record<string, unknown> };
    expect(config.agent).toMatchObject({ driver: 'structured-cli', command: 'bytesec', args: ['run', '-m', 'test-model'] });
    // What it wrote is a role the gateway accepts.
    expect(() => loadRoleDir('reviewer', dir, fx.env, new Set(['default']))).not.toThrow();
  });

  it('names the overrides it applied and the secrets it did not copy, never their values', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'create', 'reviewer'], {
      env: { MT_AGENT_ARGS: 'run -m other-model', MT_AGENT_ENV_API_KEY: 'sk-not-for-printing' },
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/MT_AGENT_ARGS/);
    expect(r.out).toMatch(/MT_AGENT_ENV_API_KEY/);
    expect(r.out).toMatch(/API_KEY=/);
    const config = readFileSync(join(fx.home, 'roles', 'reviewer', 'config.yaml'), 'utf8');
    expect(config).toMatch(/other-model/);
    expect(`${r.out}${r.err}${config}`).not.toMatch(/sk-not-for-printing/);
  });

  it('writes no max_running by default, and leaves out the one roles/default has', async () => {
    fx = mtFixture();
    expect((await fx.run(['role', 'create', 'plain'])).code).toBe(0);
    expect(readFileSync(join(fx.home, 'roles', 'plain', 'config.yaml'), 'utf8')).not.toMatch(/max_running/);

    roleDir('default', `max_running: 2\n${ACP_AGENT}`);
    const settings = fx.configPath;
    writeFileSync(settings, `workspace: ${fx.workspace}\n`);
    expect((await fx.run(['role', 'create', 'fresh'])).code).toBe(0);
    expect(readFileSync(join(fx.home, 'roles', 'fresh', 'config.yaml'), 'utf8')).not.toMatch(/max_running/);
    expect((await fx.run(['role', 'create', 'described', '--description', 'Writes'])).code).toBe(0);
    expect(readFileSync(join(fx.home, 'roles', 'described', 'config.yaml'), 'utf8')).not.toMatch(/max_running/);
    // A clone keeps it: it copies the role it names.
    roleDir('capped', `max_running: 2\n${ACP_AGENT}`);
    expect((await fx.run(['role', 'create', 'twin', '--clone-from', 'capped'])).code).toBe(0);
    expect(parseYaml(readFileSync(join(fx.home, 'roles', 'twin', 'config.yaml'), 'utf8'))).toMatchObject({ max_running: 2 });
  });

  it('refuses a bad name, a reserved name, and a role that exists', async () => {
    fx = mtFixture();
    expect((await fx.run(['role', 'create', 'Reviewer'])).code).toBe(1);
    expect((await fx.run(['role', 'create', 'acp'])).err).toMatch(/reserved/);
    expect((await fx.run(['role', 'create', 'reviewer'])).code).toBe(0);
    const again = await fx.run(['role', 'create', 'reviewer']);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already exists/);
  });

  it('copies config.yaml, role.md and skills with --clone-from, but never .env', async () => {
    fx = mtFixture();
    const source = roleDir('impl', `# keep me\n${ACP_AGENT}`);
    writeFileSync(join(source, 'role.md'), 'Write the code.\n');
    mkdirSync(join(source, 'skills', 'tdd'), { recursive: true });
    writeFileSync(join(source, 'skills', 'tdd', 'SKILL.md'), '---\nname: tdd\ndescription: Test first\n---\n');
    writeFileSync(join(source, '.env'), 'TOKEN=impl-only\n');
    chmodSync(join(source, '.env'), 0o600);

    const r = await fx.run(['role', 'create', 'reviewer', '--clone-from', 'impl', '--description', 'Reviews code']);
    expect(r.code).toBe(0);
    const dir = join(fx.home, 'roles', 'reviewer');
    const config = readFileSync(join(dir, 'config.yaml'), 'utf8');
    expect(config).toMatch(/# keep me/);
    expect((parseYaml(config) as { description: string }).description).toBe('Reviews code');
    expect(readFileSync(join(dir, 'role.md'), 'utf8')).toBe('Write the code.\n');
    expect(existsSync(join(dir, 'skills', 'tdd', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('');
  });

  it('moves the legacy default into roles/default, and prints the cutover', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'create', 'default']);
    expect(r.code).toBe(0);
    expect(existsSync(join(fx.home, 'roles', 'default', 'config.yaml'))).toBe(true);
    expect(r.out).toMatch(/remove the agent: block/);
    expect(r.out).toMatch(/mt role check/);
  });

  it('refuses --clone-from with default, and a source that is not a role', async () => {
    fx = mtFixture();
    roleDir('impl', ACP_AGENT);
    expect((await fx.run(['role', 'create', 'default', '--clone-from', 'impl'])).err).toMatch(/--clone-from/);
    expect((await fx.run(['role', 'create', 'x', '--clone-from', 'nope'])).err).toMatch(/no role nope/);
    expect((await fx.run(['role', 'create', 'x', '--clone-from', '../impl'])).code).toBe(1);
  });

  it('refuses a source whose config.yaml is a symlink, and prints nothing it points at', async () => {
    fx = mtFixture();
    const victim = roleDir('victim', ACP_AGENT);
    writeFileSync(join(victim, '.env'), 'TOKEN=victim-secret-value\n');
    const impl = join(fx.home, 'roles', 'impl');
    mkdirSync(impl);
    symlinkSync(join(victim, '.env'), join(impl, 'config.yaml'));
    const r = await fx.run(['role', 'create', 'reviewer', '--clone-from', 'impl']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/config\.yaml is not a regular file/);
    expect(existsSync(join(fx.home, 'roles', 'reviewer'))).toBe(false);
    expect(`${r.out}${r.err}`).not.toMatch(/victim-secret-value/);
  });

  it('ignores a symlinked roles/default, as the gateway does, and copies from the agent: block', async () => {
    fx = mtFixture();
    const elsewhere = join(fx.root, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'config.yaml'), 'agent:\n  driver: acp\n  command: evil\n');
    mkdirSync(join(fx.home, 'roles'));
    symlinkSync(elsewhere, join(fx.home, 'roles', 'default'));
    const r = await fx.run(['role', 'create', 'x']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/the agent: block/);
    const config = parseYaml(readFileSync(join(fx.home, 'roles', 'x', 'config.yaml'), 'utf8')) as {
      agent: Record<string, unknown>;
    };
    expect(config.agent['command']).toBe('bytesec');

    const again = await fx.run(['role', 'create', 'default']);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/exists but is not a role directory/);
  });

  it('refuses --description on a source config that is not a role config', async () => {
    fx = mtFixture();
    roleDir('impl', '- a\n');
    const r = await fx.run(['role', 'create', 'x', '--clone-from', 'impl', '--description', 'd']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mt: impl's config\.yaml is not a valid role config; run mt role check impl$/m);
    expect(existsSync(join(fx.home, 'roles', 'x'))).toBe(false);
  });

  it('copies skills without a FIFO in them', async () => {
    fx = mtFixture();
    const source = roleDir('impl', ACP_AGENT);
    mkdirSync(join(source, 'skills', 'tdd'), { recursive: true });
    writeFileSync(join(source, 'skills', 'tdd', 'SKILL.md'), '---\nname: tdd\ndescription: Test first\n---\n');
    execFileSync('mkfifo', [join(source, 'skills', 'tdd', 'pipe')]);
    const r = await fx.run(['role', 'create', 'x', '--clone-from', 'impl']);
    expect(r.code).toBe(0);
    expect(existsSync(join(fx.home, 'roles', 'x', 'skills', 'tdd', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(fx.home, 'roles', 'x', 'skills', 'tdd', 'pipe'))).toBe(false);
  });

  it('copies no symlink and no nested .env with --clone-from, and prints nothing a link points at', async () => {
    fx = mtFixture();
    const secret = 'linked-secret-not-for-copying';
    const outside = join(fx.root, 'outside');
    mkdirSync(join(outside, 'dir'), { recursive: true });
    writeFileSync(join(outside, 'secret'), `TOKEN=${secret}\n`);
    writeFileSync(join(outside, 'dir', 'inner'), `TOKEN=${secret}\n`);
    const source = roleDir('impl', ACP_AGENT);
    symlinkSync(join(outside, 'secret'), join(source, 'role.md'));
    mkdirSync(join(source, 'skills', 'x'), { recursive: true });
    writeFileSync(join(source, 'skills', 'x', 'SKILL.md'), '---\nname: x\ndescription: X\n---\n');
    symlinkSync(join(outside, 'secret'), join(source, 'skills', 'x', 'f'));
    symlinkSync(join(outside, 'dir'), join(source, 'skills', 'link'));
    writeFileSync(join(source, 'skills', 'x', '.env'), `TOKEN=${secret}\n`);

    const r = await fx.run(['role', 'create', 'reviewer', '--clone-from', 'impl']);
    expect(r.code, r.err).toBe(0);
    const dir = join(fx.home, 'roles', 'reviewer');
    expect(readFileSync(join(dir, 'role.md'), 'utf8')).toContain('Standing instructions for the reviewer role');
    expect(existsSync(join(dir, 'skills', 'x', 'SKILL.md'))).toBe(true);
    expect(lstatSync(join(dir, 'skills', 'x', 'f'), { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(join(dir, 'skills', 'link'), { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(join(dir, 'skills', 'x', '.env'), { throwIfNoEntry: false })).toBeUndefined();
    expect(`${r.out}${r.err}`).not.toContain(secret);
    for (const file of filesUnder(dir)) expect(readFileSync(file, 'utf8'), file).not.toContain(secret);
  });

  it('drops the default role\'s description when copying from it without --description', async () => {
    fx = mtFixture((ws) => `workspace: ${ws}\n`);
    roleDir('default', `description: The default role\n${ACP_AGENT}`);
    const plain = await fx.run(['role', 'create', 'reviewer']);
    expect(plain.code, plain.err).toBe(0);
    const config = parseYaml(readFileSync(join(fx.home, 'roles', 'reviewer', 'config.yaml'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(config).not.toHaveProperty('description');
    expect(config['agent']).toMatchObject({ command: 'claude-agent-acp' });

    const cloned = await fx.run(['role', 'create', 'tester', '--clone-from', 'default']);
    expect(cloned.code, cloned.err).toBe(0);
    const kept = parseYaml(readFileSync(join(fx.home, 'roles', 'tester', 'config.yaml'), 'utf8')) as {
      description?: string;
    };
    expect(kept.description).toBe('The default role');
  });

  it("says a gateway variable cannot go in a role's .env, rather than how to put it there", async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'create', 'x'], {
      env: {
        MT_AGENT_ENV_PATH: 'p-not-for-printing',
        MT_AGENT_ENV_MT_HOME: 'h-not-for-printing',
        MT_AGENT_ENV_LARK_APP_SECRET: 'l-not-for-printing',
        MT_AGENT_ENV_API_KEY: 'k-not-for-printing',
      },
    });
    expect(r.code).toBe(0);
    for (const name of ['PATH', 'MT_HOME', 'LARK_APP_SECRET']) {
      expect(r.out).toContain(`  ${name} cannot go in a role's .env (it belongs to the gateway); this role will not get it`);
      expect(r.out).not.toContain(`  ${name}=...`);
    }
    expect(r.out).toContain('  API_KEY=...');
    expect(r.out).not.toMatch(/not-for-printing/);
  });
});

describe('mt role create --own-workspace', () => {
  /** What a failed run must leave exactly as it was. */
  function snapshot(name: string): { config: string; role: boolean; workspace: boolean } {
    return {
      config: readFileSync(fx.configPath, 'utf8'),
      role: lstatSync(join(fx.home, 'roles', name), { throwIfNoEntry: false }) !== undefined,
      workspace: lstatSync(join(fx.home, 'workspaces', name), { throwIfNoEntry: false }) !== undefined,
    };
  }

  /** No staged role directory and no temporary config file left over. */
  function noLeftovers(): void {
    const roles = join(fx.home, 'roles');
    if (existsSync(roles)) expect(readdirSync(roles).filter((e) => e.startsWith('.'))).toEqual([]);
    expect(readdirSync(fx.home).filter((e) => e.includes('.mt-'))).toEqual([]);
  }

  it('creates the workspace, adds it to the config keeping its comments, and points the role at it', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'create', 'researcher', '--own-workspace']);
    expect(r.code, r.err).toBe(0);
    const dir = join(fx.home, 'workspaces', 'researcher');
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const text = readFileSync(fx.configPath, 'utf8');
    expect(text).toMatch(/# test config/);
    expect((parseYaml(text) as { workspaces: Record<string, string> }).workspaces['researcher']).toBe(dir);
    const config = parseYaml(readFileSync(join(fx.home, 'roles', 'researcher', 'config.yaml'), 'utf8')) as {
      workspace?: string;
    };
    expect(config.workspace).toBe('researcher');
    expect(r.out).toMatch(/created role researcher/);
    expect(r.out).toMatch(/added workspace researcher/);
    expect(r.out).toMatch(/own workspace, not in their parents' checkout/);

    const settings = loadTeamSettings(fx.env);
    const team = loadTeam(settings, fx.env);
    expect(team.roles.get('researcher')?.workspace).toBe('researcher');
    expect(team.workspaces.get('researcher')).toBe(dir);
  });

  it('refuses the role default', async () => {
    fx = mtFixture();
    const before = snapshot('default');
    const r = await fx.run(['role', 'create', 'default', '--own-workspace']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/the role default works in the workspace default/);
    expect(snapshot('default')).toEqual(before);
  });

  it('refuses a name already among the workspaces, and leaves nothing behind', async () => {
    fx = mtFixture();
    const docs = join(fx.root, 'docs');
    mkdirSync(docs);
    expect((await fx.run(['workspace', 'add', 'docs', docs])).code).toBe(0);
    const before = snapshot('docs');
    const r = await fx.run(['role', 'create', 'docs', '--own-workspace']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/workspace docs is already in/);
    expect(snapshot('docs')).toEqual({ ...before, role: false, workspace: false });
    noLeftovers();
  });

  it('refuses when the workspace directory exists, even as a dangling symlink, and leaves it', async () => {
    fx = mtFixture();
    const parent = join(fx.home, 'workspaces');
    mkdirSync(parent);
    symlinkSync(join(fx.root, 'nowhere'), join(parent, 'researcher'));
    const before = snapshot('researcher');
    const r = await fx.run(['role', 'create', 'researcher', '--own-workspace']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/already exists/);
    expect(snapshot('researcher')).toEqual({ ...before, role: false });
    expect(lstatSync(join(parent, 'researcher')).isSymbolicLink()).toBe(true);
    noLeftovers();
  });

  it('refuses a name the database recorded for another directory, and leaves nothing behind', async () => {
    fx = mtFixture();
    const db = openDb(join(fx.home, 'team.db'));
    migrate(db, SCHEMA_DIR);
    registerWorkspaces(db, new Map([['researcher', '/elsewhere']]), 0);
    db.close();
    const before = snapshot('researcher');
    const r = await fx.run(['role', 'create', 'researcher', '--own-workspace']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/workspace researcher is \/elsewhere/);
    expect(snapshot('researcher')).toEqual(before);
    expect(existsSync(join(fx.home, 'workspaces'))).toBe(false);
    noLeftovers();
  });

  it.skipIf(process.getuid?.() === 0)('refuses a recorded name before writing anything', async () => {
    fx = mtFixture();
    // Outside the home, so the database can still be read once the home is read-only.
    const dbPath = join(fx.root, 'team.db');
    const db = openDb(dbPath);
    migrate(db, SCHEMA_DIR);
    registerWorkspaces(db, new Map([['researcher', '/elsewhere']]), 0);
    db.close();
    const before = snapshot('researcher');
    // A read-only home: any write before the refusal would fail instead.
    chmodSync(fx.home, 0o500);
    let r;
    try {
      r = await fx.run(['role', 'create', 'researcher', '--own-workspace'], { env: { MT_DB: dbPath } });
    } finally {
      chmodSync(fx.home, 0o700);
    }
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/workspace researcher is \/elsewhere/);
    expect(snapshot('researcher')).toEqual(before);
    expect(existsSync(join(fx.home, 'workspaces'))).toBe(false);
    expect(existsSync(join(fx.home, 'roles'))).toBe(false);
  });

  it('refuses a symlinked workspaces directory, and creates nothing at its target', async () => {
    fx = mtFixture();
    const outside = join(fx.root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(fx.home, 'workspaces'));
    const before = readFileSync(fx.configPath, 'utf8');
    const r = await fx.run(['role', 'create', 'researcher', '--own-workspace']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/workspaces is a symlink; workspaces under the gateway's home must be real directories/);
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(fx.configPath, 'utf8')).toBe(before);
    expect(lstatSync(join(fx.home, 'roles', 'researcher'), { throwIfNoEntry: false })).toBeUndefined();
    noLeftovers();
  });

  it('refuses when there is no config file, and creates nothing', async () => {
    fx = mtFixture();
    rmSync(fx.configPath);
    const r = await fx.run(['role', 'create', 'researcher', '--own-workspace'], {
      env: { MT_WORKSPACE: fx.workspace, MT_AGENT_COMMAND: 'bytesec' },
    });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no config file/);
    expect(readdirSync(fx.home)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('undoes everything when the config file cannot be written', async () => {
    fx = mtFixture();
    // Both parents exist and stay writable; only the home itself, where the
    // config file's temporary copy goes, is read-only.
    mkdirSync(join(fx.home, 'roles'));
    mkdirSync(join(fx.home, 'workspaces'));
    const before = snapshot('researcher');
    chmodSync(fx.home, 0o500);
    let r;
    try {
      r = await fx.run(['role', 'create', 'researcher', '--own-workspace']);
    } finally {
      chmodSync(fx.home, 0o700);
    }
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mt: cannot write/);
    expect(snapshot('researcher')).toEqual(before);
    expect(readdirSync(join(fx.home, 'roles'))).toEqual([]);
    expect(readdirSync(join(fx.home, 'workspaces'))).toEqual([]);
    noLeftovers();
  });

  it.skipIf(process.getuid?.() === 0)('leaves nothing when the workspace directory cannot be made', async () => {
    fx = mtFixture();
    mkdirSync(join(fx.home, 'roles'));
    chmodSync(fx.home, 0o500);
    let r;
    try {
      r = await fx.run(['role', 'create', 'researcher', '--own-workspace']);
    } finally {
      chmodSync(fx.home, 0o700);
    }
    // The home is read-only, so the workspaces directory cannot be made: refused, nothing made.
    expect(r.code).toBe(1);
    expect(existsSync(join(fx.home, 'workspaces'))).toBe(false);
    expect(readdirSync(join(fx.home, 'roles'))).toEqual([]);
  });

  it('replaces the workspace of a config copied with --clone-from', async () => {
    fx = mtFixture();
    roleDir('impl', `# keep me\nworkspace: default\n${ACP_AGENT}`);
    const r = await fx.run(['role', 'create', 'writer', '--clone-from', 'impl', '--own-workspace']);
    expect(r.code, r.err).toBe(0);
    const text = readFileSync(join(fx.home, 'roles', 'writer', 'config.yaml'), 'utf8');
    expect(text).toMatch(/# keep me/);
    expect((parseYaml(text) as { workspace: string }).workspace).toBe('writer');
  });
});

describe('mt role check', () => {
  it('passes a sound team', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'check']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^files: ok$/m);
    expect(r.out).toMatch(/^this shell's environment: ok$/m);
    expect(r.out).toMatch(/service's environment may differ/);
  });

  it("says, a line a role, its max_running and where it comes from", async () => {
    fx = mtFixture(limitsConfig({ max_running: 4, max_running_per_role: 2 }));
    roleDir('implementer', `max_running: 3\n${ACP_AGENT}`);
    roleDir('reviewer', ACP_AGENT);
    const r = await fx.run(['role', 'check']);
    expect(r.code, r.out).toBe(0);
    expect(r.out.split('\n').filter((l) => l.startsWith('max_running: '))).toEqual([
      'max_running: role default runs at most 2 agent runs at once, from kanban.max_running_per_role',
      'max_running: role implementer runs at most 3 agent runs at once, from its config.yaml',
      'max_running: role reviewer runs at most 2 agent runs at once, from kanban.max_running_per_role',
    ]);

    const bare = mtFixture();
    try {
      mkdirSync(join(bare.home, 'roles', 'solo'), { recursive: true });
      writeFileSync(join(bare.home, 'roles', 'solo', 'config.yaml'), `max_running: 1\n${ACP_AGENT}`);
      const one = await bare.run(['role', 'check']);
      expect(one.out.split('\n').filter((l) => l.startsWith('max_running: '))).toEqual([
        "max_running: role default has no limit of its own: kanban.max_running and the boards' limits hold",
        'max_running: role solo runs at most 1 agent run at once, from its config.yaml',
      ]);
    } finally {
      bare.cleanup();
    }
  });

  it("reports a role's max_running above kanban.max_running, or not a positive whole number", async () => {
    fx = mtFixture(limitsConfig({ max_running: 2 }));
    roleDir('implementer', `max_running: 3\n${ACP_AGENT}`);
    const above = await fx.run(['role', 'check']);
    expect(above.code).toBe(1);
    expect(above.out).toMatch(/^files:\n {2}.*implementer\/config\.yaml: max_running \(3\) is above the gateway's kanban\.max_running \(2\)/m);
    roleDir('implementer', `max_running: 0\n${ACP_AGENT}`);
    const zero = await fx.run(['role', 'check']);
    expect(zero.code).toBe(1);
    expect(zero.out).toMatch(/max_running must be a positive integer, got 0/);
  });

  it('reports a skill named in agent.skills that cannot be found under the files', async () => {
    fx = mtFixture();
    roleDir('implementer', 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n  skills: [lark-doc]\n');
    // A made-up home, never the real one.
    const home = join(fx.root, 'user');
    const r = await fx.run(['role', 'check'], { env: { HOME: home } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^files:\n {2}role implementer: agent\.skills names lark-doc, which is in none of /m);
    mkdirSync(join(home, '.agents', 'skills', 'lark-doc'), { recursive: true });
    writeFileSync(join(home, '.agents', 'skills', 'lark-doc', 'SKILL.md'), '---\nname: lark-doc\ndescription: Lark docs\n---\n');
    expect((await fx.run(['role', 'check'], { env: { HOME: home } })).code).toBe(0);
  });

  it('says, a line a role, whether its runs get role.md and skills as a native agent package', async () => {
    fx = mtFixture();
    roleDir('implementer', 'agent:\n  driver: structured-cli\n  command: bytesec\n  args: [run]\n  unsupervised: true\n');
    writeFileSync(join(fx.home, 'roles', 'implementer', 'role.md'), 'You change code.\n');
    roleDir('injected', 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n  native: false\n');
    writeFileSync(join(fx.home, 'roles', 'injected', 'role.md'), 'You change code.\n');
    const all = await fx.run(['role', 'check']);
    expect(all.code, all.out).toBe(0);
    expect(all.out.split('\n').filter((l) => l.startsWith('native: '))).toEqual([
      'native: role default does not: it has no role.md and no skills',
      'native: role implementer runs as a bytesec agent package',
      'native: role injected does not: agent.native is false',
    ]);
    const one = await fx.run(['role', 'check', 'implementer']);
    expect(one.out.split('\n').filter((l) => l.startsWith('native: '))).toEqual([
      'native: role implementer runs as a bytesec agent package',
    ]);
  });

  it('warns of a bytesec role whose bytesec cannot resume a session, asking each command once', async () => {
    fx = mtFixture();
    roleDir('implementer', 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
    const asked: string[] = [];
    const r = await fx.run(['role', 'check'], { agentVersion: (command) => (asked.push(command), '0.7.2') });
    // A warning, not a failure: an older bytesec was never measured, and may work or not.
    expect(r.code).toBe(0);
    expect(asked).toEqual(['bytesec']);
    expect(r.out.split('\n').filter((l) => l.startsWith('warning: '))).toEqual([
      'warning: role default runs bytesec 0.7.2, older than 0.7.4, the oldest measured to resume a session; with it, native resume is unmeasured and its turns may not work',
      'warning: role implementer runs bytesec 0.7.2, older than 0.7.4, the oldest measured to resume a session; with it, native resume is unmeasured and its turns may not work',
    ]);
  });

  it('notes a bytesec whose version cannot be read, and asks no other agent', async () => {
    fx = mtFixture();
    roleDir('reviewer', ACP_AGENT);
    const asked: string[] = [];
    const r = await fx.run(['role', 'check'], { agentVersion: (command) => (asked.push(command), undefined) });
    expect(r.code).toBe(0);
    expect(asked).toEqual(['bytesec']);
    expect(r.out).toMatch(/^note: role default: bytesec --version gave no version; native resume needs bytesec 0\.7\.4 or later$/m);
  });

  it('says nothing of a bytesec that resumes, comparing versions part by part', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'check'], { agentVersion: () => '0.10.0' });
    expect(r.out).not.toMatch(/resume/);
    expect([versionBelow('0.7.2', '0.7.4'), versionBelow('0.7.4', '0.7.4'), versionBelow('0.10.0', '0.7.4'), versionBelow('1.0', '0.7.4')]).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it("reads bytesec's own version over any other, from stdout and then stderr", () => {
    expect(parseAgentVersion('bytesec 0.7.4\n', '')).toBe('0.7.4');
    expect(parseAgentVersion('ByteSec version v0.8.1 (built with go 1.22.3)\n', '')).toBe('0.8.1');
    // Another version first, such as the runtime's: bytesec's is still the one taken.
    expect(parseAgentVersion('go1.22.3 runtime 1.22.3\nbytesec 0.7.4\n', '')).toBe('0.7.4');
    expect(parseAgentVersion('runtime 1.22.3\n', 'bytesec 0.7.4\n')).toBe('0.7.4');
    // No bytesec named: the first version anywhere, stdout before stderr.
    expect(parseAgentVersion('0.7.2\n', '0.9.0\n')).toBe('0.7.2');
    expect(parseAgentVersion('', 'v0.7.3\n')).toBe('0.7.3');
    expect(parseAgentVersion('v22.15.0\n', '')).toBe('22.15.0');
    // Not a version: a part of a longer word, or only two parts.
    expect(parseAgentVersion('build abc1.2.3\n', '')).toBeUndefined();
    expect(parseAgentVersion('bytesec 0.7\n', '')).toBeUndefined();
    expect(parseAgentVersion('', '')).toBeUndefined();
    // A pre-release keeps its suffix, so it is not taken for the release.
    expect(parseAgentVersion('bytesec 0.7.4-rc1\n', '')).toBe('0.7.4-rc1');
  });

  it('counts a pre-release as older than its release', () => {
    expect([versionBelow('0.7.4-rc1', '0.7.4'), versionBelow('0.7.5-rc1', '0.7.4'), versionBelow('0.7.3-rc1', '0.7.4')]).toEqual([true, false, true]);
  });

  it('says nothing about rendering when the check fails', async () => {
    fx = mtFixture();
    roleDir('broken', 'agent: [\n');
    const r = await fx.run(['role', 'check']);
    expect(r.code).toBe(1);
    expect(r.out).not.toMatch(/^native: /m);
  });

  it('reports a broken role file under the files', async () => {
    fx = mtFixture();
    roleDir('broken', 'agent: [\n');
    const r = await fx.run(['role', 'check']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^files:\n {2}.*broken/m);
    expect(r.out).toMatch(/^this shell's environment: ok$/m);
  });

  it("reports an unset passEnv name as this shell's, apart from the files", async () => {
    fx = mtFixture();
    roleDir('reviewer', `${ACP_AGENT}  passEnv: [REVIEW_TOKEN]\n`);
    const r = await fx.run(['role', 'check', 'reviewer']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^files: ok$/m);
    expect(r.out).toMatch(/role reviewer names REVIEW_TOKEN in agent.passEnv, and it is not set in this shell/);
  });

  it('warns of a passEnv name set in this shell, which a service started by launchd or systemd will not have', async () => {
    fx = mtFixture();
    const dir = roleDir('reviewer', `${ACP_AGENT}  passEnv: [REVIEW_TOKEN]\n`);
    const r = await fx.run(['role', 'check', 'reviewer'], { env: { REVIEW_TOKEN: 'tok-never-printed' } });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^this shell's environment: ok$/m);
    expect(r.out).toContain(
      `warning: role reviewer takes REVIEW_TOKEN from this shell through agent.passEnv; a service started by launchd or systemd will not have it: put it in ${join(dir, '.env')} and remove it from passEnv`,
    );
    expect(r.out + r.err).not.toContain('tok-never-printed');
  });

  it("warns of a passEnv name of the agent: block set in this shell, pointing at MT_AGENT_ENV_*", async () => {
    fx = mtFixture((ws) =>
      [`workspace: ${ws}`, 'agent:', '  driver: acp', '  command: claude-agent-acp', '  passEnv: [SVC_TOKEN]', ''].join('\n'),
    );
    const r = await fx.run(['role', 'check'], { env: { SVC_TOKEN: 'svc-never-printed' } });
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      `warning: role default takes SVC_TOKEN from this shell through agent.passEnv; a service started by launchd or systemd will not have it: set MT_AGENT_ENV_SVC_TOKEN in ${join(fx.home, '.env')} and remove it from agent.passEnv`,
    );
  });

  it("reports MT_AGENT_* variables beside roles/default as this shell's", async () => {
    fx = mtFixture((ws) => `workspace: ${ws}\n`);
    roleDir('default', ACP_AGENT);
    const r = await fx.run(['role', 'check'], { env: { MT_AGENT_COMMAND: 'bytesec' } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^files: ok$/m);
    expect(r.out).toMatch(/define the role default; keep one/);
  });

  it('refuses a workspace the database recorded at another directory', async () => {
    fx = mtFixture();
    const db = openDb(join(fx.home, 'team.db'));
    migrate(db, SCHEMA_DIR);
    registerWorkspaces(db, new Map([['default', '/elsewhere']]), 0);
    db.close();
    const r = await fx.run(['role', 'check']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/workspace default is \/elsewhere/);
  });

  it('says so when the named role does not exist', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'check', 'nobody']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/there is no role nobody/);
  });

  it("reports only the named role's unset passEnv names, on every path", async () => {
    fx = mtFixture();
    roleDir('reviewer', `${ACP_AGENT}  passEnv: [REVIEW_TOKEN]\n`);
    roleDir('other', ACP_AGENT);
    const ok = await fx.run(['role', 'check', 'other']);
    expect(ok.code).toBe(0);
    expect(ok.out).not.toMatch(/reviewer/);
    const missing = await fx.run(['role', 'check', 'nobody']);
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(/there is no role nobody/);
    expect(missing.out).not.toMatch(/reviewer/);
  });

  it("reports an unset passEnv name in the gateway's agent: block as this shell's, apart from the files", async () => {
    fx = mtFixture((ws) =>
      [
        `workspace: ${ws}`,
        'agent:',
        '  driver: structured-cli',
        '  command: bytesec',
        '  unsupervised: true',
        '  passEnv: [SVC_TOKEN]',
        '',
      ].join('\n'),
    );
    const r = await fx.run(['role', 'check']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^files: ok$/m);
    expect(r.out).toMatch(/role default names SVC_TOKEN in agent.passEnv, and it is not set in this shell/);
  });
});
