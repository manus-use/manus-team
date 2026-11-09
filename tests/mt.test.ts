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

  it("lists the operator's task commands under kanban task, and the worker's under their own names", async () => {
    fx = mtFixture();
    const usage = (await fx.run(['help'])).out;
    for (const verb of ['new', 'list', 'show', 'assign', 'link', 'unblock', 'stop', 'archive', 'comment']) {
      expect(usage).toMatch(new RegExp(`^  mt kanban task ${verb} `, 'm'));
      expect(usage).not.toMatch(new RegExp(`^  mt kanban ${verb} `, 'm'));
    }
    expect(usage).toContain('  mt kanban board list [all] [--json]');
    expect(usage).toContain('  mt kanban gate list <task_id>');
    expect(usage).toContain('  mt kanban <show|complete|review|changes|block|comment|create|link> < input.json');
  });

  it('refuses an unknown command with the usage, exit 2', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'fly']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown command: role fly/);
    expect(r.err).toMatch(/usage:/);
  });
});
