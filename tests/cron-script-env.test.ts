import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_VARIABLES } from '../src/cli/gate.js';
import { scriptEnv, type ScriptHome } from '../src/cron/scheduler.js';
import { migrate, openDb } from '../src/db/open.js';
import { gateEnv, spawnGate, type GateExit, type GateRunOptions } from '../src/kanban/gates.js';
import { writeMtShim } from '../src/kanban/shim.js';
import { clearSecrets } from '../src/secrets.js';
import { answers, cronHarness, type CronHarness } from './helpers/cron.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { newTask } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * A fire's script's PATH and home (the cron spec, §5.1): `$MT_HOME/bin` first,
 * before the role's PATH or the gateway's, and the gateway's home, config file
 * and database, so plain `mt` in a script reaches this gateway; none of them an
 * agent's variable, and a gate's environment as it was.
 */

const WORKER = { socket: '/run/mt/kanban.sock', mtDir: '/srv/mt/bin', path: '/usr/local/bin:/usr/bin' };
const HOME: ScriptHome = { home: '/srv/mt', configPath: '/etc/mt/config.yaml', dbPath: '/data/team.db' };
/** The gateway's own environment, which, inside the gateway, has an agent's variables too. */
const GATEWAY = { PATH: '/usr/local/bin:/usr/bin', HOME: '/home/mt', MT_KANBAN_RUN: 'r_1', MT_KANBAN_TOKEN: 't', MT_KANBAN_SOCKET: '/s', MT_CRON_TOKEN: 'c', MT_CRON_FIRE: '7', MT_CONFIG: '/tmp/other.yaml' };

describe('scriptEnv', () => {
  it("puts the gateway's mt first, before the gateway's PATH, and sets its home, config file and database", () => {
    const env = scriptEnv(role('worker'), GATEWAY, WORKER, HOME);
    expect(env).toEqual({ PATH: '/srv/mt/bin:/usr/local/bin:/usr/bin', HOME: '/home/mt', MT_HOME: '/srv/mt', MT_CONFIG: '/etc/mt/config.yaml', MT_DB: '/data/team.db' });
  });

  it("puts it before the role's own PATH, and sets the three after the role's environment", () => {
    const worker = role('worker', { agent: { ...role('worker').agent, env: { PATH: '/opt/tools/bin', MT_HOME: '/elsewhere', GH_HOST: 'git.example' } } });
    const env = scriptEnv(worker, GATEWAY, WORKER, HOME);
    expect(env).toMatchObject({ PATH: '/srv/mt/bin:/opt/tools/bin', MT_HOME: '/srv/mt', GH_HOST: 'git.example' });
  });

  it('gives no MT_CONFIG to an environment-only gateway, no agent variable and no socket', () => {
    const env = scriptEnv(role('worker'), GATEWAY, WORKER, { ...HOME, configPath: undefined });
    expect(env['MT_CONFIG']).toBeUndefined();
    for (const name of [...AGENT_VARIABLES, 'MT_KANBAN_SOCKET']) expect(env[name], name).toBeUndefined();
  });

  it("leaves a gate's environment as it was, and a script's without the deps", () => {
    expect(gateEnv(role('worker'), GATEWAY)).toEqual({ PATH: '/usr/local/bin:/usr/bin', HOME: '/home/mt' });
    expect(scriptEnv(role('worker'), GATEWAY, undefined, undefined)).toEqual(gateEnv(role('worker'), GATEWAY));
  });
});

describe("a fire's script", () => {
  const open: CronHarness[] = [];
  afterEach(() => {
    clearSecrets();
    while (open.length > 0) open.pop()?.close();
  });

  it('runs with the environment scriptEnv gives, from the scheduler\'s deps', async () => {
    const calls: GateRunOptions[] = [];
    const runner = async (_command: string, opts: GateRunOptions): Promise<GateExit> => {
      calls.push(opts);
      return { exitCode: 0, signal: null, timedOut: false, output: 'ok' };
    };
    const h = cronHarness({ deps: { runner, env: GATEWAY, worker: WORKER, scriptHome: HOME } });
    open.push(h);
    h.add({ script: 'mt kanban task list --json' });
    answers(h.driver, 'Nothing stuck.');
    h.clock.advance(60 * 60_000);
    await h.tick();
    await h.scheduler.idle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.env).toEqual(scriptEnv(role('worker'), GATEWAY, WORKER, HOME));
    expect(calls[0]?.env['PATH']?.startsWith('/srv/mt/bin:')).toBe(true);
  });
});

describe("plain mt in a script, through the gateway's launcher", () => {
  let fx: MtFixture;
  beforeEach(() => clearSecrets());
  afterEach(() => fx?.cleanup());

  it("reads the gateway's own database, one a gateway run by hand names by MT_DB outside its home included", async () => {
    fx = mtFixture();
    writeMtShim(fx.home);
    const dbPath = join(mkdtempSync(join(fx.root, 'data-')), 'board.db');
    const db = openDb(dbPath);
    migrate(db, SCHEMA_DIR);
    const task = newTask(db, { title: 'In the gateway database', assignee: null });
    db.close();
    const env = scriptEnv(role('worker'), { PATH: process.env['PATH'], HOME: fx.root }, { socket: '/none', mtDir: join(fx.home, 'bin'), path: process.env['PATH'] }, { home: fx.home, configPath: fx.configPath, dbPath });
    const exit = await spawnGate('mt kanban task list --json', { cwd: fx.workspace, env, timeoutMs: 60_000 });
    expect(exit.exitCode, exit.output).toBe(0);
    const answer = JSON.parse(exit.output.split('\n').find((l) => l.startsWith('{')) ?? 'null') as { ok: boolean; tasks: Array<{ task_id: string }> };
    expect(answer.ok).toBe(true);
    expect(answer.tasks.map((t) => t.task_id)).toEqual([task.taskId]);
  }, 60_000);
});
