import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_VARIABLES, runShellRefusal } from '../src/cli/gate.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * An agent's shell (the cron spec, §6.4): the operator's commands are refused
 * there, and the refusal names the variable it found.
 */

let fx: MtFixture | undefined;

afterEach(() => {
  fx?.cleanup();
  fx = undefined;
});

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
