import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CRON_DEFAULTS, ConfigError, loadConfig, loadTeamSettings } from '../src/config.js';
import { gatewayZonePath, readGatewayZone, writeGatewayZone } from '../src/cron/zone-file.js';

/** The `cron:` section (the cron spec, §10), and the gateway's zone file (§2.2). */

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mt-cron-config-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const env = { MT_HOME: '/tmp/mt-home', LARK_APP_ID: 'cli_app', LARK_APP_SECRET: 'secret-value-123', MT_OWNER_OPEN_ID: 'ou_owner' };
const file = (cron: string) => (path: string) => (path.endsWith('config.yaml') ? `workspace: /tmp\nagent:\n  command: bytesec\n  driver: structured-cli\n  unsupervised: true\n${cron}` : undefined);

describe('the cron: section', () => {
  it('is off by default, with two fires at once, a 600 s idle limit and no zone of its own', () => {
    expect(loadConfig(env, file('')).cron).toEqual(CRON_DEFAULTS);
    expect(CRON_DEFAULTS).toEqual({ enabled: false, maxRunning: 2, idleTimeoutS: 600 });
  });

  it('takes enabled, max_running, idle_timeout_s and tz, the zone as Intl names it', () => {
    const c = loadConfig(env, file('cron:\n  enabled: true\n  max_running: 16\n  idle_timeout_s: 86400\n  tz: utc\n'));
    expect(c.cron).toEqual({ enabled: true, maxRunning: 16, idleTimeoutS: 86400, tz: 'UTC' });
    expect(loadTeamSettings(env, file('cron:\n  enabled: true\n  tz: Asia/Shanghai\n')).cron).toEqual({ enabled: true, tz: 'Asia/Shanghai' });
    expect(loadTeamSettings(env, file('')).cron).toBeUndefined();
  });

  it.each([
    ['  colour: blue\n', 'unknown setting cron.colour (known: enabled, max_running, idle_timeout_s, tz)'],
    ['  max_running: 0\n', 'cron.max_running must be a positive integer, got 0'],
    ['  max_running: 17\n', 'cron.max_running must be from 1 to 16, got 17'],
    ['  idle_timeout_s: 59\n', 'cron.idle_timeout_s must be from 60 to 86400, got 59'],
    ['  idle_timeout_s: 86401\n', 'cron.idle_timeout_s must be from 60 to 86400, got 86401'],
    ['  idle_timeout_s: 0\n', 'cron.idle_timeout_s must be a positive integer, got 0'],
    ['  tz: Mars/Olympus\n', 'cron.tz: "Mars/Olympus" is not a time zone'],
    ['  enabled: yes\n', 'cron.enabled'],
  ])('refuses %j', (line, message) => {
    expect(() => loadConfig(env, file(`cron:\n${line}`))).toThrow(ConfigError);
    expect(() => loadConfig(env, file(`cron:\n${line}`))).toThrow(message);
  });
});

describe("the gateway's zone file", () => {
  it('is written whole, 0600 in the private directory, and read back; one that is no zone reads as none', () => {
    expect(readGatewayZone(home)).toBeUndefined();
    writeGatewayZone(home, 'Asia/Shanghai');
    expect(readFileSync(gatewayZonePath(home), 'utf8')).toBe('Asia/Shanghai\n');
    expect(statSync(gatewayZonePath(home)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'run')).mode & 0o777).toBe(0o700);
    expect(readGatewayZone(home)).toBe('Asia/Shanghai');
    writeGatewayZone(home, 'Not/Azone');
    expect(readGatewayZone(home)).toBeUndefined();
  });
});
