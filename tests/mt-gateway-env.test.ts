import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * The `mt` commands that load the gateway's settings read its `.env` as the
 * gateway does, so they see what it sees; `mt role check` says what the file is
 * and which names it sets, never their values.
 */
let fx: MtFixture;
afterEach(() => fx.cleanup());

const SECRET = 'lark-secret-from-file-1234';

/** The fixture's config, without the workspace: the gateway's .env sets it. */
function noWorkspace(): string {
  return ['agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n');
}

function envFile(text: string, mode = 0o600): string {
  const path = join(fx.home, '.env');
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

describe("mt and the gateway's .env", () => {
  it('mt role check says the file is optional when there is none', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'check']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`gateway .env: ${join(fx.home, '.env')} does not exist; it is optional`);
  });

  it('mt role check names what a good file sets, and no value', async () => {
    fx = mtFixture();
    const path = envFile(`LARK_APP_SECRET=${SECRET}\nMT_ALLOW_TALK=ou_a\n`);
    const r = await fx.run(['role', 'check']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`gateway .env: ${path} is owner-only, and sets LARK_APP_SECRET, MT_ALLOW_TALK`);
    expect(`${r.out}\n${r.err}`).not.toContain(SECRET);
  });

  it('mt role check reports a file group or others can read under files', async () => {
    fx = mtFixture();
    const path = envFile(`LARK_APP_SECRET=${SECRET}\n`, 0o644);
    const r = await fx.run(['role', 'check']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(new RegExp(`^files:\\n {2}${path} can be read or written by other users \\(mode 644\\)`, 'm'));
    expect(`${r.out}\n${r.err}`).not.toContain(SECRET);
  });

  it('mt role check reports an unknown name under files, by name', async () => {
    fx = mtFixture();
    envFile('LARK_APP_SECRT=value-not-for-printing\n');
    const r = await fx.run(['role', 'check']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^files:\n {2}.*\.env:1: unknown variable LARK_APP_SECRT/m);
    expect(`${r.out}\n${r.err}`).not.toContain('not-for-printing');
  });

  it("blames the file, not this shell, for an MT_AGENT_* setting it holds", async () => {
    fx = mtFixture();
    envFile('MT_AGENT_DRIVER=nonesuch\n');
    const r = await fx.run(['role', 'check']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^files:\n {2}agent\.driver must be one of/m);
    expect(r.out).toMatch(/^this shell's environment: ok$/m);
  });

  it('mt role check says which names this shell sets over the file', async () => {
    fx = mtFixture();
    envFile(`LARK_APP_SECRET=${SECRET}\nMT_ALLOW_TALK=ou_a\n`);
    const r = await fx.run(['role', 'check'], { env: { MT_ALLOW_TALK: 'ou_b' } });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(
      `note: MT_ALLOW_TALK is set both in this shell and in ${join(fx.home, '.env')}; the environment wins`,
    );
  });

  it('the mt commands that load the settings see the file', async () => {
    fx = mtFixture(noWorkspace);
    // Without the file, there is no workspace.
    const without = await fx.run(['role', 'list']);
    expect(without.code).toBe(1);
    expect(without.err).toMatch(/a workspace is required/);

    envFile(`MT_WORKSPACE=${fx.workspace}\nLARK_APP_SECRET=${SECRET}\n`);
    const list = await fx.run(['role', 'list']);
    expect(list.code, list.err).toBe(0);
    const check = await fx.run(['role', 'check']);
    expect(check.code, check.out).toBe(0);
    const workspaces = await fx.run(['workspace', 'list']);
    expect(workspaces.code, workspaces.err).toBe(0);
    expect(workspaces.out).toContain(fx.workspace);
    // Past the settings, to the board the gateway has not created yet.
    const board = await fx.run(['kanban', 'board', 'list']);
    expect(board.err).toMatch(/there is no board at/);
  });

  it('mt role create applies an MT_AGENT_* override from the file, and says where it came from', async () => {
    fx = mtFixture();
    const path = envFile('MT_AGENT_ARGS=run -m other-model\nMT_AGENT_ENV_API_KEY=sk-not-for-printing\n');
    const r = await fx.run(['role', 'create', 'reviewer']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`applied MT_AGENT_ARGS from ${path}`);
    expect(r.out).toContain('  API_KEY=...');
    const config = readFileSync(join(fx.home, 'roles', 'reviewer', 'config.yaml'), 'utf8');
    expect(config).toMatch(/other-model/);
    expect(`${r.out}${r.err}${config}`).not.toMatch(/sk-not-for-printing/);
  });

  it('the mt commands refuse a loose file, as the gateway does', async () => {
    fx = mtFixture();
    envFile(`LARK_APP_SECRET=${SECRET}\n`, 0o640);
    for (const argv of [['role', 'list'], ['workspace', 'list'], ['kanban', 'board', 'list']]) {
      const r = await fx.run(argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err).toMatch(/can be read or written by other users \(mode 640\)/);
      expect(`${r.out}\n${r.err}`).not.toContain(SECRET);
    }
  });
});
