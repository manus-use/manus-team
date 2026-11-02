import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadRoleDir } from '../src/roles.js';
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
});
