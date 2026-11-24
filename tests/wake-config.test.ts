import { describe, expect, it } from 'vitest';
import { ConfigError, WAKE_DEFAULTS, loadConfig, loadTeamSettings } from '../src/config.js';

/** `kanban.wake` (wake spec §11): its keys, defaults and ranges, read alike by the gateway and the terminal. */

const env = { MT_HOME: '/tmp/mt-home', LARK_APP_ID: 'cli_app', LARK_APP_SECRET: 'secret-value-123', MT_OWNER_OPEN_ID: 'ou_owner' };
const file = (kanban: string) => (path: string) =>
  path.endsWith('config.yaml') ? `workspace: /tmp\nagent:\n  command: bytesec\n  driver: structured-cli\n  unsupervised: true\n${kanban}` : undefined;

describe('kanban.wake', () => {
  it('is on by default, at 6 woken turns an hour, 5 deep, and a 10-minute hold', () => {
    expect(WAKE_DEFAULTS).toEqual({ enabled: true, perHour: 6, maxDepth: 5, holdMinutes: 10 });
    expect(loadConfig(env, file('')).kanban.wake).toEqual(WAKE_DEFAULTS);
    expect(loadConfig(env, file('kanban:\n  enabled: true\n')).kanban.wake).toEqual(WAKE_DEFAULTS);
    expect(loadTeamSettings(env, file('')).wake).toEqual(WAKE_DEFAULTS);
  });

  it('takes each key, and the terminal reads the same values', () => {
    const text = 'kanban:\n  wake:\n    enabled: false\n    per_hour: 60\n    max_depth: 20\n    hold_minutes: 1\n';
    const want = { enabled: false, perHour: 60, maxDepth: 20, holdMinutes: 1 };
    expect(loadConfig(env, file(text)).kanban.wake).toEqual(want);
    expect(loadTeamSettings(env, file(text)).wake).toEqual(want);
    expect(loadConfig(env, file('kanban:\n  wake:\n    max_depth: 3\n')).kanban.wake).toEqual({ ...WAKE_DEFAULTS, maxDepth: 3 });
  });

  it.each([
    ['    colour: blue\n', 'unknown setting kanban.wake.colour (known: enabled, per_hour, max_depth, hold_minutes)'],
    ['    perHour: 3\n', 'unknown setting kanban.wake.perHour'],
    ['    per_hour: 0\n', 'kanban.wake.per_hour must be a positive integer, got 0'],
    ['    per_hour: 61\n', 'kanban.wake.per_hour must be from 1 to 60, got 61'],
    ['    max_depth: 21\n', 'kanban.wake.max_depth must be from 1 to 20, got 21'],
    ['    max_depth: 1.5\n', 'kanban.wake.max_depth must be a positive integer, got 1.5'],
    ['    hold_minutes: 61\n', 'kanban.wake.hold_minutes must be from 1 to 60, got 61'],
    ['    enabled: yes\n', 'kanban.wake.enabled must be true or false'],
  ])('refuses %j', (line, message) => {
    expect(() => loadConfig(env, file(`kanban:\n  wake:\n${line}`))).toThrow(ConfigError);
    expect(() => loadConfig(env, file(`kanban:\n  wake:\n${line}`))).toThrow(message);
  });

  it('refuses a wake that is not a mapping', () => {
    expect(() => loadConfig(env, file('kanban:\n  wake: 3\n'))).toThrow('kanban.wake must be a mapping');
    expect(() => loadConfig(env, file('kanban:\n  wake: true\n'))).toThrow('kanban.wake must be a mapping');
  });
});
