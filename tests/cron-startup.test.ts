import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LarkAdapter } from '../src/channel/lark/adapter.js';
import { LarkInbound } from '../src/channel/lark/inbound.js';
import { loadConfig, type GatewayConfig } from '../src/config.js';
import { addJob } from '../src/db/cron.js';
import { migrate, openDb } from '../src/db/open.js';
import { cronLine, createGateway } from '../src/index.js';
import { clearSecrets } from '../src/secrets.js';
import { loadTeam, type Team } from '../src/team.js';
import { jobInput } from './helpers/cron.js';
import { SCHEMA_DIR } from './helpers/db.js';

/**
 * Cron at startup (the cron spec, §4.1, §10, §13): the startup lines, the
 * database's lock beside the home's, and the gateway's zone written once the
 * home is held. The channel is stubbed: nothing talks to Lark.
 */

let root: string;
let config: GatewayConfig;
let team: Team;

beforeEach(() => {
  clearSecrets();
  root = mkdtempSync(join(tmpdir(), 'mt-cron-startup-'));
  const home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(join(root, 'repo'));
  const env = {
    MT_HOME: home,
    MT_DB: join(home, 'team.db'),
    MT_WORKSPACE: join(root, 'repo'),
    MT_OWNER_OPEN_ID: 'ou_owner',
    LARK_APP_ID: 'cli_app',
    LARK_APP_SECRET: 'app-secret',
    MT_AGENT_COMMAND: 'bytesec',
    MT_AGENT_DRIVER: 'structured-cli',
    MT_AGENT_UNSUPERVISED: 'true',
  };
  config = loadConfig(env, () => undefined);
  team = loadTeam(config, env);
  vi.spyOn(LarkAdapter.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(LarkAdapter.prototype, 'disconnect').mockResolvedValue(undefined);
  vi.spyOn(LarkInbound.prototype, 'start').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('cronLine', () => {
  it('says what fires, how many at once, the idle limit and the zone with its source; or that cron is off, or nothing', () => {
    const on = { enabled: true, maxRunning: 2, idleTimeoutS: 600 };
    expect(cronLine({ ...on, tz: 'Asia/Shanghai' }, { active: 7, paused: 2 }, 'Asia/Shanghai')).toBe(
      'cron: 7 active job(s), 2 paused; up to 2 fire(s) at once, each stopped after 600 s with no activity; new jobs in Asia/Shanghai (from cron.tz), and every job keeps its own zone',
    );
    expect(cronLine(on, { active: 0, paused: 0 }, 'Europe/Berlin')).toMatch(/new jobs in Europe\/Berlin \(from this process's zone\)/);
    expect(cronLine({ ...on, enabled: false }, { active: 7, paused: 0 }, 'UTC')).toBe('cron: off (cron.enabled is unset); 7 active job(s) do not fire');
    expect(cronLine({ ...on, enabled: false }, { active: 0, paused: 3 }, 'UTC')).toBeUndefined();
  });
});

describe('a gateway with cron on', () => {
  const on = (): GatewayConfig => ({ ...config, cron: { enabled: true, maxRunning: 2, idleTimeoutS: 600, tz: 'Asia/Shanghai' } });

  it('notes its line, holds the home and the database, writes gateway.tz, and lets both go at its stop', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const gateway = await createGateway(on(), team);
    expect(gateway.cron).toBeDefined();
    expect(gateway.dispatcher).toBeUndefined();
    expect(lines.some((l) => l.includes('cron: 0 active job(s), 0 paused; up to 2 fire(s) at once'))).toBe(true);
    try {
      await gateway.start();
      expect(readFileSync(join(config.home, 'run', 'gateway.pid'), 'utf8')).toBe(`${process.pid}\n`);
      expect(readFileSync(`${config.dbPath}.lock`, 'utf8')).toBe(`${process.pid}\n`);
      expect(readFileSync(join(config.home, 'run', 'gateway.tz'), 'utf8')).toBe('Asia/Shanghai\n');
      expect(existsSync(join(config.home, 'bin', 'mt'))).toBe(true);
    } finally {
      await gateway.stop();
    }
    expect(existsSync(`${config.dbPath}.lock`)).toBe(false);
    expect(existsSync(join(config.home, 'run', 'gateway.pid'))).toBe(false);
  });

  it('is refused by the database lock another gateway holds, from another home', async () => {
    writeFileSync(`${config.dbPath}.lock`, `${process.ppid}\n`, { mode: 0o600 });
    const gateway = await createGateway(on(), team);
    try {
      await expect(gateway.start()).rejects.toThrow(`another gateway (pid ${process.ppid}) holds the database lock ${config.dbPath}.lock`);
    } finally {
      await gateway.stop();
    }
  });

  it('says cron is off when it is, with active jobs, and gives no chat agent a token', async () => {
    const db = openDb(config.dbPath);
    migrate(db, SCHEMA_DIR);
    addJob(db, jobInput({ role: 'default' }), Date.now());
    db.close();
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const gateway = await createGateway(config, team);
    try {
      expect(gateway.cron).toBeUndefined();
      expect(lines.some((l) => l.includes('cron: off (cron.enabled is unset); 1 active job(s) do not fire'))).toBe(true);
    } finally {
      await gateway.stop();
    }
  });
});
