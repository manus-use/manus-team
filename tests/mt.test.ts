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
    expect(usage).toContain("the worker's commands, which work only in a board run's shell");
    expect(usage).toContain('  mt kanban <show|complete|review|changes|block|comment|create|link> < input.json');
  });

  it('refuses an unknown command with the usage, exit 2', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'fly']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown command: role fly/);
    expect(r.err).toMatch(/usage:/);
  });

  it("answers a worker command outside a run as needing one, before its arguments, naming the operator's task command where there is one", async () => {
    fx = mtFixture();
    const NEED = 'mt kanban works only inside a board run: MT_KANBAN_RUN, MT_KANBAN_TOKEN and MT_KANBAN_SOCKET must all be set';
    for (const [argv, name] of [
      [['show', 'k_1'], 'show'],
      [['show'], 'show'],
      [['comment', 'k_1', 'hello'], 'comment'],
      [['link', 'k_1', 'k_2'], 'link'],
      [['show', 'k_1', '--json'], 'show'],
    ] as const) {
      const r = await fx.run(['kanban', ...argv]);
      expect([argv, r.code, r.err]).toEqual([argv, 1, '']);
      expect(JSON.parse(r.out)).toEqual({
        ok: false,
        code: 'not_in_a_run',
        message: `${NEED}; the operator's is mt kanban task ${name}`,
      });
    }
    for (const argv of [['complete'], ['complete', '--summary', 'x'], ['create', 'x'], ['review'], ['changes'], ['block']]) {
      const r = await fx.run(['kanban', ...argv]);
      expect([argv, r.code]).toEqual([argv, 1]);
      expect(JSON.parse(r.out)).toEqual({ ok: false, code: 'not_in_a_run', message: NEED });
    }
  });

  it("keeps a worker command's answers in a run as they were: its arguments refused before the socket is asked", async () => {
    fx = mtFixture();
    const run = { MT_KANBAN_RUN: 'r_1', MT_KANBAN_TOKEN: 't', MT_KANBAN_SOCKET: '/nowhere.sock' };
    const r = await fx.run(['kanban', 'show', 'k_1'], { env: run });
    expect(r).toEqual({
      code: 2,
      out: '{"ok":false,"code":"bad_request","message":"mt kanban show takes no arguments: its input is JSON on stdin"}',
      err: '',
    });
    // Only a token set is a run's shell too, and there the worker says what is missing.
    const half = await fx.run(['kanban', 'show'], { env: { MT_KANBAN_TOKEN: 't' } });
    expect(half.out).toBe(
      '{"ok":false,"code":"not_in_a_run","message":"mt kanban works only inside a board run: MT_KANBAN_RUN, MT_KANBAN_TOKEN and MT_KANBAN_SOCKET must all be set"}',
    );
  });

  it("answers the old form of an operator's task command as unknown, naming the command it now is, and runs nothing", async () => {
    fx = mtFixture();
    for (const verb of ['new', 'list', 'assign', 'unblock', 'stop', 'archive']) {
      const r = await fx.run(['kanban', verb, 'k_1']);
      expect(r.code).toBe(2);
      expect(r.out).toBe('');
      expect(r.err.split('\n')[0]).toBe(`mt: unknown command: kanban ${verb}; the operator's command is mt kanban task ${verb}`);
    }
    const other = await fx.run(['kanban', 'finish']);
    expect(other.err.split('\n')[0]).toBe('mt: unknown command: kanban finish');
  });
});
