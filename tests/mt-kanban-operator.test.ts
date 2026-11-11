import { userInfo } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jsonLine } from '../src/cli/operator.js';
import { boardsOf, getBoard } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * The operator's `mt kanban` (spec §2.6): chat's board commands at a terminal,
 * in the gateway's own database, through the board's service, beside a gateway
 * that has it open; and the nudge that asks that gateway for a pass.
 */

let f: MtFixture;
/** The gateway's connection to its database. */
let gateway: Db;
/** The gateway's socket, when a test starts one, and the requests it was sent. */
let server: WorkerServer | undefined;
let requests: unknown[];
const ME = `operator:${userInfo().username}`;

beforeEach(() => {
  clearSecrets();
  f = mtFixture((workspace) =>
    [
      `workspace: ${workspace}`,
      'kanban:',
      '  enabled: true',
      'agent:',
      '  driver: structured-cli',
      '  command: bytesec',
      '  unsupervised: true',
      '',
    ].join('\n'),
  );
  gateway = openDb(join(f.home, 'team.db'));
  migrate(gateway, SCHEMA_DIR);
  server = undefined;
  requests = [];
});

afterEach(async () => {
  clearSecrets();
  await server?.close();
  gateway.close();
  f.cleanup();
});

/** As the operator's shell runs it: a made-up home. */
function mt(argv: string[], env: Record<string, string | undefined> = {}) {
  return f.run(['kanban', ...argv], { env: { HOME: f.root, ...env } });
}

/** A gateway listening on the home's socket, answering a nudge as the real one does. */
async function listening(): Promise<void> {
  server = await listenWorker(workerSocketPath(f.home), (req) => {
    requests.push(req);
    return { ok: true };
  });
}

describe('mt kanban board', () => {
  it('creates, sets, lists and archives a board, as the operator', async () => {
    expect(await mt(['board', 'create', 'web-app'])).toEqual({
      code: 0,
      out: 'created board web-app; mt kanban task new --board web-app adds a task to it',
      err: '',
    });
    expect(getBoard(gateway, 'web-app')).toMatchObject({ createdBy: ME });
    await listening();
    expect(await mt(['board', 'set', 'web-app', 'max_running', '1'])).toEqual({
      code: 0,
      out: 'board web-app runs at most 1 agent at once now',
      err: '',
    });
    expect(await mt(['board', 'set', 'web-app', 'workspace', 'default'])).toMatchObject({
      code: 0,
      out: "board web-app's tasks work in default now, unless their own workspace, their role's or their parents' says otherwise",
    });
    expect(getBoard(gateway, 'web-app')).toMatchObject({ maxRunning: 1, workspace: 'default', updatedBy: ME });
    expect(await mt(['board', 'list'])).toEqual({
      code: 0,
      out: ['default: no tasks', 'web-app: no tasks · max_running 1 · workspace default'].join('\n'),
      err: '',
    });
    expect(await mt(['board', 'archive', 'web-app'])).toMatchObject({ code: 0 });
    expect((await mt(['board', 'list'])).out).toBe('default: no tasks');
    expect((await mt(['board', 'list', 'all'])).out).toContain('web-app (archived): no tasks');
    expect((await mt(['board', 'list', 'ALL'])).out).toContain('web-app (archived): no tasks');
  });

  it("caps a board's max_running at the gateway's kanban.max_running, as chat does", async () => {
    expect((await mt(['board', 'create', 'web-app'])).code).toBe(0);
    const over = await mt(['board', 'set', 'web-app', 'max_running', '9', '--json']);
    expect(over.code).toBe(1);
    expect(JSON.parse(over.out)).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/kanban\.max_running, 8$/) });
    expect(getBoard(gateway, 'web-app')?.maxRunning).toBeNull();
    expect((await mt(['board', 'set', 'web-app', 'max_running', '8'])).code).toBe(0);
  });

  it('prints one line of JSON with --json, a refusal too', async () => {
    const made = await mt(['board', 'create', 'web-app', '--json']);
    expect(made.code).toBe(0);
    expect(JSON.parse(made.out)).toEqual({ ok: true, board: { name: 'web-app', max_running: null, workspace: null, archived: false } });
    const listed = JSON.parse((await mt(['board', 'list', '--json'])).out) as { boards: Array<{ name: string; counts: object }> };
    expect(listed.boards.map((b) => b.name)).toEqual(['default', 'web-app']);
    expect(listed.boards[0]?.counts).toEqual({ open: 0, review: 0, blocked: 0, done: 0, archived: 0 });
    const again = await mt(['board', 'create', 'web-app', '--json']);
    expect(again).toMatchObject({ code: 1, err: '' });
    expect(JSON.parse(again.out)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('refuses what the board refuses, with exit 1, and a wrong command line with exit 2', async () => {
    expect(await mt(['board', 'archive', 'default'])).toEqual({
      code: 1,
      out: '',
      err: 'mt: board default is where every chat starts; it is never archived',
    });
    expect(await mt(['board', 'set', 'nowhere', 'max_running', '2'])).toMatchObject({ code: 1, err: 'mt: there is no board nowhere' });
    for (const argv of [
      ['board'],
      ['board', 'create'],
      ['board', 'create', 'a', 'b'],
      ['board', 'set', 'web-app', 'max_running', '0'],
      ['board', 'set', 'web-app', 'colour', 'blue'],
      ['board', 'list', 'archived'],
      ['board', 'rename', 'web-app'],
      ['board', 'create', 'web-app', '--board', 'x'],
    ]) {
      expect((await mt(argv)).code).toBe(2);
    }
    expect(boardsOf(gateway).map((b) => b.name)).toEqual(['default']);
  });

  it('has no use: a terminal has no chat to move', async () => {
    const r = await mt(['board', 'use', 'default']);
    expect(r.code).toBe(2);
    expect(r.err.split('\n')[0]).toBe('mt: kanban board use moves a chat, and a terminal has none: give task new and task list --board <name>');
  });

  it("refuses in a board run's shell, where it is not the operator's", async () => {
    for (const name of ['MT_KANBAN_RUN', 'MT_KANBAN_TOKEN']) {
      expect(await mt(['board', 'create', 'web-app'], { [name]: 'set' })).toEqual({
        code: 1,
        out: '',
        err:
          "mt: mt kanban board create is an operator's command, not a board run's: this shell has MT_KANBAN_RUN or " +
          'MT_KANBAN_TOKEN set. Run it from your own shell',
      });
    }
    expect(boardsOf(gateway).map((b) => b.name)).toEqual(['default']);
  });
});

describe('the nudge after a change', () => {
  it('asks a running gateway for a pass, with the one request that needs no token', async () => {
    await listening();
    await mt(['board', 'create', 'web-app']);
    expect(requests).toEqual([]);
    const r = await mt(['board', 'set', 'web-app', 'max_running', '2', '--json']);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, nudged: true });
    expect(requests).toEqual([{ nudge: true }]);
  });

  it('says when no gateway answered, and the change stands', async () => {
    await mt(['board', 'create', 'web-app']);
    const r = await mt(['board', 'set', 'web-app', 'max_running', '2']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('board web-app runs at most 2 agents at once now');
    expect(r.err).toBe(
      `mt: no gateway answered at ${workerSocketPath(f.home)} (ENOENT; is the gateway running?); the change stands, ` +
        'and running the command again would make it twice: a running gateway acts on it at its next sweep, ' +
        'and a stopped one when it next starts',
    );
    expect(getBoard(gateway, 'web-app')?.maxRunning).toBe(2);
    const quiet = await mt(['board', 'set', 'web-app', 'max_running', '1', '--json']);
    expect(JSON.parse(quiet.out)).toMatchObject({ ok: true, nudged: false });
  });
});

describe('the nudge after a keyed task new', () => {
  it('says, when no gateway answered, that running it again with its key returns the task', async () => {
    const r = await mt(['task', 'new', 'Nightly', '--key', 'n1']);
    expect(r.code).toBe(0);
    expect(r.err).toBe(
      `mt: no gateway answered at ${workerSocketPath(f.home)} (ENOENT; is the gateway running?); the change stands, ` +
        'and running the command again with the same --key returns this task: a running gateway acts on it at its next sweep, ' +
        'and a stopped one when it next starts',
    );
  });
});

describe('a socket nothing listens on', () => {
  it('gives the reason, says the change stands, and never says to try again', async () => {
    const socket = workerSocketPath(f.home);
    mkdirSync(dirname(socket), { recursive: true });
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(`${socket}.dead`, resolve));
    renameSync(`${socket}.dead`, socket);
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    await mt(['board', 'create', 'web-app']);
    const r = await mt(['board', 'set', 'web-app', 'max_running', '2']);
    expect(r.code).toBe(0);
    expect(r.err).toBe(
      `mt: no gateway answered at ${socket} (ECONNREFUSED; it may be busy, or stopped); the change stands, ` +
        'and running the command again would make it twice: a running gateway acts on it at its next sweep, ' +
        'and a stopped one when it next starts',
    );
    expect(r.err).not.toContain('try again');
  });
});

describe('a gateway whose board is off', () => {
  it('says so when the config sets kanban.enabled to false, and asks no gateway', async () => {
    writeFileSync(
      f.configPath,
      `workspace: ${f.workspace}\nkanban:\n  enabled: false\nagent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n`,
    );
    await listening();
    await mt(['board', 'create', 'web-app']);
    const r = await mt(['board', 'set', 'web-app', 'max_running', '2']);
    expect(r.code).toBe(0);
    expect(r.err).toBe(
      'mt: the board is off on this gateway (its config sets kanban.enabled to false): the change is recorded, ' +
        'and nothing runs it until the board is turned on and the gateway restarted',
    );
    expect(requests).toEqual([]);
  });

  it('says the change is recorded and nothing runs it, and asks no gateway', async () => {
    writeFileSync(f.configPath, `workspace: ${f.workspace}\nagent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n`);
    await listening();
    await mt(['board', 'create', 'web-app']);
    const r = await mt(['board', 'set', 'web-app', 'max_running', '2', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, nudged: false });
    expect(r.err).toBe(
      'mt: the board is off on this gateway (its config does not set kanban.enabled): the change is recorded, ' +
        'and nothing runs it until the board is turned on and the gateway restarted',
    );
    expect(requests).toEqual([]);
  });
});

describe('jsonLine', () => {
  it('escapes what a terminal may act on that JSON leaves alone, and reads back the same', () => {
    const value = { text: 'a\u0085b\u2028c\u2029d\u202Ee\u2066f\u0007g\u007Fh' };
    const out = jsonLine(value);
    expect(out).toBe('{"text":"a\\u0085b\\u2028c\\u2029d\\u202ee\\u2066f\\u0007g\\u007fh"}');
    expect(JSON.parse(out)).toEqual(value);
  });
});

describe('mt kanban: whose command it is', () => {
  it("keeps the worker's own commands the worker's outside a run, which says it needs one", async () => {
    const r = await mt(['complete']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, code: 'not_in_a_run' });
  });

  it('answers a name neither has with the usage outside a run, and with JSON inside one', async () => {
    const outside = await mt(['finish']);
    expect(outside.code).toBe(2);
    expect(outside.err.split('\n')[0]).toBe('mt: unknown command: kanban finish');
    const inside = await mt(['finish'], { MT_KANBAN_RUN: 'r_1', MT_KANBAN_TOKEN: 't', MT_KANBAN_SOCKET: '/nowhere' });
    expect(inside.code).toBe(2);
    expect(JSON.parse(inside.out)).toMatchObject({ ok: false, code: 'unknown_command' });
  });
});
