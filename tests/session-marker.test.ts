import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scriptEnv } from '../src/cron/scheduler.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { SESSION_MARKER, gateEnv } from '../src/kanban/gates.js';
import { sessionEnv } from '../src/index.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * The session marker (the tier grants spec §6.3): `MT_AGENT_SESSION=<session
 * id>` in every agent session's environment, beside what a run, a fire or a
 * chat session's cron token gives, or alone; dropped from a gate's, a cron
 * script's and `mt update`'s children's; and refusing `mt auth` alone of the
 * operator's commands.
 */

describe('sessionEnv', () => {
  it("adds the marker to a run's, a fire's and a chat session's environment, and gives it alone with none", () => {
    expect(SESSION_MARKER).toBe('MT_AGENT_SESSION');
    expect(sessionEnv('s_chat', undefined)).toEqual({ MT_AGENT_SESSION: 's_chat' });
    expect(sessionEnv('s_chat', { MT_CRON_TOKEN: 't', PATH: '/srv/mt/bin:/usr/bin' })).toEqual({ MT_CRON_TOKEN: 't', PATH: '/srv/mt/bin:/usr/bin', MT_AGENT_SESSION: 's_chat' });
    expect(sessionEnv('s_run', { MT_KANBAN_RUN: 'r_1', MT_KANBAN_TOKEN: 'k' })).toMatchObject({ MT_KANBAN_RUN: 'r_1', MT_AGENT_SESSION: 's_run' });
    expect(sessionEnv('s_fire', { MT_CRON_FIRE: '7' })).toMatchObject({ MT_CRON_FIRE: '7', MT_AGENT_SESSION: 's_fire' });
    // The session's own id, whatever was given.
    expect(sessionEnv('s_real', { MT_AGENT_SESSION: 's_other' })).toEqual({ MT_AGENT_SESSION: 's_real' });
  });

  it("is dropped from a gate's environment and a cron script's, the operator's shells", () => {
    const worker = role('worker', { agent: { ...role('worker').agent, env: { MT_AGENT_SESSION: 's_role', API_KEY: 'k' } } });
    const parent = { PATH: '/usr/bin', HOME: '/home/mt', MT_AGENT_SESSION: 's_parent' };
    expect(gateEnv(worker, parent)).toEqual({ PATH: '/usr/bin', HOME: '/home/mt', API_KEY: 'k' });
    expect(scriptEnv(worker, parent, undefined, undefined)).not.toHaveProperty('MT_AGENT_SESSION');
  });
});

describe('mt in a shell with the marker alone', () => {
  let fx: MtFixture;
  let db: Db;

  afterEach(() => {
    clearSecrets();
    db?.close();
    fx?.cleanup();
  });

  function setup(): void {
    clearSecrets();
    fx = mtFixture((ws) =>
      [`workspace: ${ws}`, 'lark:', '  appId: cli_app', 'auth:', '  owner: ou_owner', 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'),
    );
    db = openDb(join(fx.home, 'team.db'));
    migrate(db, SCHEMA_DIR);
  }

  it('refuses mt auth, naming the marker, as JSON with --json, and the first agent variable when there is one', async () => {
    setup();
    const refusal = "mt auth list is an operator's command, not an agent's; this shell has MT_AGENT_SESSION set. Run it from your own shell";
    expect(await fx.run(['auth', 'list'], { env: { MT_AGENT_SESSION: 's_1' } })).toEqual({ code: 1, out: '', err: `mt: ${refusal}` });
    expect(JSON.parse((await fx.run(['auth', 'list', '--json'], { env: { MT_AGENT_SESSION: 's_1' } })).out)).toEqual({ ok: false, code: 'operator_command', message: refusal });
    expect((await fx.run(['auth', 'grant', 'lark:on_x', 'talk'], { env: { MT_AGENT_SESSION: 's_1', MT_CRON_TOKEN: 't' } })).err).toContain('this shell has MT_CRON_TOKEN set');
    expect((await fx.run(['auth', 'list'])).code).toBe(0);
  });

  it("does not refuse the board's or the cron operator's commands, which only the agent variables refuse", async () => {
    setup();
    const board = await fx.run(['kanban', 'task', 'list', '--json'], { env: { MT_AGENT_SESSION: 's_1' } });
    expect(board.code, board.err).toBe(0);
    expect(JSON.parse(board.out)).toMatchObject({ ok: true });
    const cron = await fx.run(['cron', 'list'], { env: { MT_AGENT_SESSION: 's_1' } });
    expect(cron.err).not.toContain("operator's command");
  });
});
