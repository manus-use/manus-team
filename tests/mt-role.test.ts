import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadRoleDir } from '../src/roles.js';
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

describe('mt role list', () => {
  it('lists the role default from the agent: block, and each role directory', async () => {
    fx = mtFixture();
    roleDir('reviewer', `description: Reviews code\n${ACP_AGENT}`);
    const r = await fx.run(['role', 'list']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^default\s+structured-cli\s+agent: block$/m);
    expect(r.out).toMatch(/^reviewer\s+acp\s+roles\/reviewer\s+Reviews code$/m);
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

describe('mt role check', () => {
  it('passes a sound team', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'check']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^files: ok$/m);
    expect(r.out).toMatch(/^this shell's environment: ok$/m);
    expect(r.out).toMatch(/service's environment may differ/);
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
    const db = openDb(join(fx.home, 'gateway.db'));
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
