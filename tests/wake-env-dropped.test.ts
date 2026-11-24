import { afterEach, describe, expect, it } from 'vitest';
import { gateEnv } from '../src/kanban/gates.js';
import { clearSecrets } from '../src/secrets.js';
import { role } from './helpers/dispatch.js';
import { updateFake, type UpdateFake } from './helpers/update.js';

/**
 * A wake token never reaches a gate, a cron script, or git and npm under `mt
 * update` (wake spec §9.2): `gateEnv` and `mt update`'s child environment drop
 * every `MT_WAKE_` name, as they drop `MT_KANBAN_*`, `MT_CRON_*` and the session
 * marker.
 */

let fx: UpdateFake | undefined;
afterEach(() => {
  clearSecrets();
  fx?.cleanup();
  fx = undefined;
});

describe('MT_WAKE_ dropped', () => {
  it("from a gate's environment, whatever put it there", () => {
    const implementer = role('implementer', {
      agent: { ...role('implementer').agent, env: { API_KEY: 'sk-role-1', MT_WAKE_TOKEN: 'a-wake-token', MT_WAKE_STRAY: 'x' } },
    });
    expect(gateEnv(implementer, { PATH: '/usr/bin', MT_WAKE_TOKEN: 'a-wake-token' })).toEqual({ PATH: '/usr/bin', API_KEY: 'sk-role-1' });
  });

  it("from git's, npm's and the check's under mt update", async () => {
    fx = await updateFake();
    await fx.update(['--yes'], { env: { MT_WAKE_TOKEN: 'a-wake-token', MT_WAKE_STRAY: 'x' } });
    expect(fx.runs.length).toBeGreaterThan(0);
    for (const run of fx.runs) expect(Object.keys(run.opts.env).filter((k) => k.startsWith('MT_WAKE_'))).toEqual([]);
  });
});
