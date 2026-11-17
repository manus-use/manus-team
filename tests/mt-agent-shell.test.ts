import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_VARIABLES, inAgentRun, runShellRefusal } from '../src/cli/gate.js';
import { clearSecrets } from '../src/secrets.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * An agent's shell (the cron spec, §6.4): the operator's commands are refused
 * there, and the refusal names the variable it found.
 */

let fx: MtFixture | undefined;

afterEach(() => {
  clearSecrets();
  fx?.cleanup();
  fx = undefined;
});

/** A chat turn's shell, with cron on, and a cron fire's. */
const CHAT_TURN = { MT_CRON_TOKEN: 'chat-token-not-for-printing', MT_KANBAN_SOCKET: '/nowhere.sock' };
const FIRE = { MT_CRON_FIRE: '7', MT_CRON_TOKEN: 'fire-token-not-for-printing', MT_KANBAN_SOCKET: '/nowhere.sock' };
const SHELLS = [
  ['a chat turn', CHAT_TURN],
  ['a fire', FIRE],
] as const;

function envFile(home: string, text: string): void {
  const path = join(home, '.env');
  writeFileSync(path, text);
  chmodSync(path, 0o600);
}

describe('runShellRefusal', () => {
  it('names the first of the agent variables the shell has set', () => {
    for (const name of AGENT_VARIABLES) {
      expect(runShellRefusal('mt service', { [name]: 'x' })).toBe(
        `mt service is an operator's command, not an agent's; this shell has ${name} set. Run it from your own shell`,
      );
    }
    expect(runShellRefusal('mt update', { MT_CRON_FIRE: '7', MT_KANBAN_TOKEN: 't' })).toMatch(/this shell has MT_KANBAN_TOKEN set/);
    expect(runShellRefusal('mt update', { MT_CRON_FIRE: '7', MT_CRON_TOKEN: 't' })).toMatch(/this shell has MT_CRON_TOKEN set/);
  });

  it('says what a board run shell has set, through mt', async () => {
    fx = mtFixture();
    const r = await fx.run(['service', 'status'], { env: { MT_KANBAN_TOKEN: 'tok' } });
    expect(r).toEqual({
      code: 1,
      out: '',
      err: "mt: mt service is an operator's command, not an agent's; this shell has MT_KANBAN_TOKEN set. Run it from your own shell",
    });
  });
});

describe("a chat turn's shell and a fire's", () => {
  it('are agents\' shells, as a board run\'s is, and no other is', () => {
    expect(inAgentRun(CHAT_TURN)).toBe(true);
    expect(inAgentRun({ MT_CRON_FIRE: '7' })).toBe(true);
    expect(inAgentRun({ MT_KANBAN_RUN: 'r_1' })).toBe(true);
    expect(inAgentRun({ MT_KANBAN_SOCKET: '/nowhere.sock', MT_HOME: '/tmp/x' })).toBe(false);
  });

  it("refuse the operator's commands, naming MT_CRON_TOKEN, with no workflow hint", async () => {
    fx = mtFixture();
    const said = (what: string): string =>
      `mt: ${what} is an operator's command, not an agent's; this shell has MT_CRON_TOKEN set. Run it from your own shell`;
    for (const [, env] of SHELLS) {
      expect(await fx.run(['kanban', 'task', 'new', 'x'], { env })).toEqual({ code: 1, out: '', err: said('mt kanban task new') });
      expect(await fx.run(['kanban', 'board', 'list'], { env })).toEqual({ code: 1, out: '', err: said('mt kanban board list') });
      expect(await fx.run(['kanban', 'workflow', 'start', 'x'], { env })).toEqual({ code: 1, out: '', err: said('mt kanban workflow start') });
      expect(await fx.run(['service', 'status'], { env })).toEqual({ code: 1, out: '', err: said('mt service') });
      expect(await fx.run(['update', '--check'], { env })).toEqual({ code: 1, out: '', err: said('mt update') });
    }
  });

  it("send no worker's command to the socket: mt kanban show says it needs a run", async () => {
    fx = mtFixture();
    for (const [, env] of SHELLS) {
      const r = await fx.run(['kanban', 'show'], { env });
      expect(r.code).toBe(1);
      expect(JSON.parse(r.out)).toMatchObject({ ok: false, code: 'not_in_a_run' });
    }
  });

  it("read no .env: MT_WORKSPACE only there is a missing workspace", async () => {
    fx = mtFixture(() => ['agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'));
    envFile(fx.home, `MT_WORKSPACE=${fx.workspace}\n`);
    expect((await fx.run(['workspace', 'list'])).code).toBe(0);
    for (const [what, env] of SHELLS) {
      for (const argv of [['workspace', 'list'], ['role', 'list'], ['role', 'create', 'helper'], ['workspace', 'add', 'more', fx.workspace]]) {
        const r = await fx.run(argv, { env });
        expect(r.code, `${what}: ${argv.join(' ')}`).toBe(1);
        expect(r.err).toMatch(/a workspace is required/);
      }
    }
  });

  it('read no .env: MT_AGENT_COMMAND only there is no role default, and with a block the block is the default', async () => {
    fx = mtFixture((ws) => `workspace: ${ws}\n`);
    envFile(fx.home, 'MT_AGENT_COMMAND=bytesec\n');
    expect((await fx.run(['role', 'list'])).out).toMatch(/^default\s+acp\s+agent: block/m);
    // role list reads names only, and loads no team; role create copies the default it cannot find.
    expect(await fx.run(['role', 'list'], { env: CHAT_TURN })).toEqual({ code: 0, out: 'no roles: create one with mt role create <name>', err: '' });
    expect(await fx.run(['role', 'create', 'helper'], { env: CHAT_TURN })).toEqual({ code: 1, out: '', err: 'mt: there is no role default to copy from' });

    fx.cleanup();
    fx = mtFixture((ws) => [`workspace: ${ws}`, 'agent:', '  driver: acp', '  command: bytesec', ''].join('\n'));
    envFile(fx.home, 'MT_AGENT_DRIVER=structured-cli\nMT_AGENT_UNSUPERVISED=1\n');
    expect((await fx.run(['role', 'list'])).out).toMatch(/^default\s+structured-cli\s+agent: block/m);
    expect((await fx.run(['role', 'list'], { env: CHAT_TURN })).out).toMatch(/^default\s+acp\s+agent: block/m);
  });

  it('read no .env: MT_AGENT_UNSUPERVISED only there fails a check at a terminal that passes in an agent shell', async () => {
    fx = mtFixture((ws) => [`workspace: ${ws}`, 'agent:', '  driver: acp', '  command: bytesec', ''].join('\n'));
    envFile(fx.home, 'MT_AGENT_UNSUPERVISED=1\n');
    expect((await fx.run(['role', 'check'])).code).toBe(1);
    const agent = await fx.run(['role', 'check'], { env: CHAT_TURN });
    expect(agent.code, agent.out).toBe(0);
    expect(agent.out).not.toContain('.env');
  });

  it("read no .env: MT_MAX_LIVE_SESSIONS only there leaves the per-role bound against the file's limit", async () => {
    fx = mtFixture((ws) =>
      [`workspace: ${ws}`, 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', 'kanban:', '  max_running_per_role: 6', ''].join('\n'),
    );
    envFile(fx.home, 'MT_MAX_LIVE_SESSIONS=4\n');
    const terminal = await fx.run(['role', 'list']);
    expect(terminal.code).toBe(1);
    expect(terminal.err).toMatch(/kanban\.max_running_per_role \(6\) is above kanban\.max_running \(4, from MT_MAX_LIVE_SESSIONS\)/);
    expect((await fx.run(['role', 'list'], { env: CHAT_TURN })).code).toBe(0);
  });

  it('read no .env: an unset passEnv name throws nowhere', async () => {
    fx = mtFixture((ws) =>
      [`workspace: ${ws}`, 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', '  passEnv: [NOT_SET_ANYWHERE]', ''].join('\n'),
    );
    mkdirSync(join(fx.home, 'roles'), { recursive: true });
    for (const argv of [['role', 'list'], ['workspace', 'list']]) {
      expect((await fx.run(argv, { env: CHAT_TURN })).code, argv.join(' ')).toBe(0);
    }
  });
});
