import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LarkAdapter } from '../src/channel/lark/adapter.js';
import { LarkInbound } from '../src/channel/lark/inbound.js';
import { loadConfig, type GatewayConfig } from '../src/config.js';
import type { CronSchedulerDeps } from '../src/cron/scheduler.js';
import { createGateway } from '../src/index.js';
import { clearSecrets } from '../src/secrets.js';
import { loadTeam, type Team } from '../src/team.js';

/**
 * A gateway whose MT_HOME is relative (the cron spec, §5.1): a script runs in a
 * workspace, so the socket, `$MT_HOME/bin` on its PATH and its MT_HOME are the
 * home resolved, never relative to wherever the script runs.
 */

const seen = vi.hoisted(() => ({ deps: [] as unknown[] }));
vi.mock('../src/cron/scheduler.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/cron/scheduler.js')>();
  class Recorded extends real.CronScheduler {
    constructor(deps: CronSchedulerDeps) {
      super(deps);
      seen.deps.push(deps);
    }
  }
  return { ...real, CronScheduler: Recorded };
});

let root: string;
let config: GatewayConfig;
let team: Team;

beforeEach(() => {
  clearSecrets();
  seen.deps.length = 0;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-relative-home-')));
  const home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(join(root, 'repo'));
  const env = {
    MT_HOME: relative(process.cwd(), home),
    MT_DB: join(home, 'team.db'),
    MT_WORKSPACE: join(root, 'repo'),
    MT_OWNER_OPEN_ID: 'ou_owner',
    LARK_APP_ID: 'cli_app',
    LARK_APP_SECRET: 'app-secret',
    MT_AGENT_COMMAND: 'bytesec',
    MT_AGENT_DRIVER: 'structured-cli',
    MT_AGENT_UNSUPERVISED: 'true',
  };
  config = { ...loadConfig(env, () => undefined), cron: { enabled: true, maxRunning: 2, idleTimeoutS: 600, tz: 'UTC' } };
  team = loadTeam(config, env);
  vi.spyOn(LarkAdapter.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(LarkAdapter.prototype, 'disconnect').mockResolvedValue(undefined);
  vi.spyOn(LarkInbound.prototype, 'start').mockImplementation(() => undefined);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('a gateway with a relative MT_HOME', () => {
  it("gives a script the home resolved, as its MT_HOME, its socket and the first entry on its PATH", async () => {
    expect(isAbsolute(config.home)).toBe(false);
    const gateway = await createGateway(config, team);
    try {
      const deps = seen.deps[0] as CronSchedulerDeps | undefined;
      const home = join(root, 'home');
      expect(deps?.scriptHome?.home).toBe(home);
      expect(deps?.worker?.mtDir).toBe(join(home, 'bin'));
      expect(isAbsolute(deps?.worker?.socket ?? '')).toBe(true);
    } finally {
      await gateway.stop();
    }
  });
});
