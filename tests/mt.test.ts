import { afterEach, describe, expect, it } from 'vitest';
import { mtFixture, type MtFixture } from './helpers/mt.js';

let fx: MtFixture;
afterEach(() => fx.cleanup());

describe('mt', () => {
  it('prints the usage: exit 2 when there is no command, 0 when asked for help', async () => {
    fx = mtFixture();
    const none = await fx.run([]);
    expect(none.code).toBe(2);
    expect(none.out).toMatch(/mt role create <name>/);
    expect((await fx.run(['help'])).code).toBe(0);
  });

  it('refuses an unknown command with the usage, exit 2', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'fly']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown command: role fly/);
    expect(r.err).toMatch(/usage:/);
  });
});
