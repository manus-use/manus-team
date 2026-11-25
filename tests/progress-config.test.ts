import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config.js';

/**
 * `kanban.progress` (progress cards spec §3): off by default, `min_seconds` 30,
 * snake case and file only, a whole number from 0 to 3,600.
 */

const PATH = '/var/lib/prime/config.yaml';

function load(kanban?: Record<string, unknown>) {
  const file = stringify({
    workspace: '/srv/repo',
    lark: { appId: 'cli_app' },
    auth: { owner: 'ou_owner' },
    agent: { command: 'claude-agent-acp' },
    ...(kanban === undefined ? {} : { kanban }),
  });
  return loadConfig({ MT_HOME: '/var/lib/prime', LARK_APP_SECRET: 'app-secret' }, (p) => (p === PATH ? file : undefined));
}

describe('kanban.progress', () => {
  it('is off by default, with min_seconds 30', () => {
    expect(load().kanban.progress).toEqual({ enabled: false, minSeconds: 30 });
    expect(load({ progress: null }).kanban.progress).toEqual({ enabled: false, minSeconds: 30 });
  });

  it('reads enabled and min_seconds, 0 and 3600 among them', () => {
    expect(load({ progress: { enabled: true } }).kanban.progress).toEqual({ enabled: true, minSeconds: 30 });
    expect(load({ progress: { enabled: true, min_seconds: 0 } }).kanban.progress).toEqual({ enabled: true, minSeconds: 0 });
    expect(load({ progress: { min_seconds: 3600 } }).kanban.progress).toEqual({ enabled: false, minSeconds: 3600 });
  });

  it('refuses a min_seconds that is not a whole number, with the file first', () => {
    expect(() => load({ progress: { min_seconds: '30s' } })).toThrow(
      `${PATH}: kanban.progress.min_seconds must be a whole number, 0 or more, got "30s"`,
    );
    expect(() => load({ progress: { min_seconds: -1 } })).toThrow(`${PATH}: kanban.progress.min_seconds must be a whole number, 0 or more, got -1`);
  });

  it('refuses a min_seconds past an hour, with the file first', () => {
    expect(() => load({ progress: { min_seconds: 5000 } })).toThrow(`${PATH}: kanban.progress.min_seconds must be from 0 to 3600, got 5000`);
  });

  it('refuses an unknown key, and an enabled that is not a boolean', () => {
    expect(() => load({ progress: { minSeconds: 10 } })).toThrow('unknown setting kanban.progress.minSeconds (known: enabled, min_seconds)');
    expect(() => load({ progress: { enabled: 'yes' } })).toThrow('kanban.progress.enabled must be true or false');
  });

  it('is a key of kanban', () => {
    expect(() => load({ progres: {} })).toThrow(/unknown setting kanban\.progres \(known: .*wake, progress\)/);
  });
});
