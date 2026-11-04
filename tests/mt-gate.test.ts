import { userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTask } from '../src/db/kanban.js';
import { eventsOf, gatesOf } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { KanbanService } from '../src/kanban/service.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { ALICE, NOW, VIA } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * `mt kanban gate`: an operator defining gates from a shell, in the gateway's
 * own database, through the board's service, beside a gateway that has it open.
 */

let f: MtFixture;
/** The gateway's connection to its database. */
let gateway: Db;
let taskId: string;
const ME = `operator:${userInfo().username}`;

beforeEach(() => {
  clearSecrets();
  f = mtFixture((workspace) =>
    [
      `workspace: ${workspace}`,
      'agent:',
      '  driver: structured-cli',
      '  command: bytesec',
      '  unsupervised: true',
      '  passEnv: [API_KEY]',
      '',
    ].join('\n'),
  );
  gateway = openDb(join(f.home, 'gateway.db'));
  migrate(gateway, SCHEMA_DIR);
  const r = createTask(gateway, { title: 'a task', workspace: 'default', createdBy: ALICE, createdVia: VIA }, NOW);
  if (!r.ok) throw new Error(r.message);
  taskId = r.task.taskId;
});
afterEach(() => {
  clearSecrets();
  gateway.close();
  f.cleanup();
});

/** As the operator's shell runs it: a made-up home, and the role's key set. */
function mt(argv: string[], env: Record<string, string | undefined> = {}) {
  return f.run(['kanban', 'gate', ...argv], { env: { HOME: f.root, API_KEY: 'sk-live-1234567890', ...env } });
}

describe('mt kanban gate', () => {
  it('adds, lists and removes a gate, as the operator, in the database the gateway has open', async () => {
    const added = await mt(['add', taskId, '--timeout', '120', '--', 'npm', 'test', '--', '--grep', 'parser']);
    expect(added).toMatchObject({ code: 0, err: '' });
    const [gate] = gatesOf(gateway, taskId);
    expect(gate).toMatchObject({ command: 'npm test -- --grep parser', timeoutS: 120, createdBy: ME });
    expect(added.out).toBe(`added gate ${gate?.id}: npm test -- --grep parser (up to 120 s) to task ${taskId}`);

    expect(await mt(['list', taskId])).toEqual({
      code: 0,
      out: [
        `id  timeout  defined by${' '.repeat(ME.length - 10)}  command`,
        `${gate?.id}   120 s    ${ME}  npm test -- --grep parser`,
      ].join('\n'),
      err: '',
    });
    expect(await mt(['remove', taskId, String(gate?.id)])).toMatchObject({
      code: 0,
      out: `removed gate ${gate?.id}: npm test -- --grep parser (up to 120 s) from task ${taskId}`,
    });
    expect(gatesOf(gateway, taskId)).toEqual([]);
    expect(eventsOf(gateway, taskId).map((e) => [e.kind, e.actor])).toEqual([
      ['created', ALICE],
      ['gate_added', ME],
      ['gate_removed', ME],
    ]);
    expect(await mt(['list', taskId])).toMatchObject({ code: 0, out: `task ${taskId} has no gates` });
  });

  it("refuses a command holding a secret the gateway knows: a role's value, or the Lark app secret", async () => {
    expect(await mt(['add', taskId, '--', 'curl', '-H', 'k:sk-live-1234567890'])).toMatchObject({
      code: 1,
      err: expect.stringContaining("mt: the gate's command holds a known secret"),
    });
    const lark = await mt(['add', taskId, '--', 'echo', 'lark-secret-123'], { LARK_APP_SECRET: 'lark-secret-123' });
    expect(lark).toMatchObject({ code: 1 });
    expect(gatesOf(gateway, taskId)).toEqual([]);
  });

  it('says which of the role environment it could not check, when a passEnv name is unset in this shell', async () => {
    const r = await mt(['add', taskId, '--', 'npm', 'test'], { API_KEY: undefined });
    expect(r).toMatchObject({ code: 0 });
    expect(r.err).toBe('mt: default: API_KEY not set in this shell, so a gate holding those values cannot be refused here');
  });

  it("refuses in a board run's shell: gates are an operator's", async () => {
    for (const name of ['MT_KANBAN_RUN', 'MT_KANBAN_TOKEN']) {
      expect(await mt(['add', taskId, '--', 'true'], { [name]: 'set' })).toEqual({
        code: 1,
        out: '',
        err:
          "mt: mt kanban gate add is an operator's command, not a board run's: this shell has MT_KANBAN_RUN or " +
          'MT_KANBAN_TOKEN set. Run it from your own shell',
      });
    }
    expect(gatesOf(gateway, taskId)).toEqual([]);
  });

  it("refuses what the board refuses, and a missing board, with exit 1", async () => {
    expect(await mt(['add', taskId, '--timeout', '601', '--', 'true'])).toMatchObject({ code: 1 });
    expect(await mt(['add', 'k_missing', '--', 'true'])).toMatchObject({ code: 1, err: 'mt: no task k_missing' });
    expect(await mt(['remove', taskId, '7'])).toMatchObject({ code: 1, err: `mt: task ${taskId} has no gate 7` });
    gateway.close();
    f.cleanup();
    f = mtFixture();
    gateway = openDb(join(f.root, 'unused.db'));
    expect(await mt(['list', 'k_1'])).toMatchObject({
      code: 1,
      err: `mt: there is no board at ${join(f.home, 'gateway.db')}: the gateway creates its database when it first starts`,
    });
  });

  it('answers a wrong command line with exit 2', async () => {
    for (const argv of [
      ['add', taskId],
      ['add', taskId, '--timeout', 'soon', '--', 'true'],
      ['remove', taskId, 'one'],
      ['list'],
      ['rename', taskId],
    ]) {
      expect((await mt(argv)).code).toBe(2);
    }
  });
});

describe('the board shared with a running gateway', () => {
  it("writes beside the gateway's reads, which see it at once", () => {
    const shell = openDb(join(f.home, 'gateway.db'));
    try {
      gateway.exec('BEGIN');
      expect(gatesOf(gateway, taskId)).toEqual([]);
      const s = new KanbanService({ db: shell, roles: new Map(), workspaces: new Set(['default']) });
      expect(s.addGate(taskId, { command: 'npm test' }, ME).ok).toBe(true);
      gateway.exec('COMMIT');
      expect(gatesOf(gateway, taskId).map((g) => g.command)).toEqual(['npm test']);
    } finally {
      shell.close();
    }
  });

  it("waits out the gateway's write, retrying, and writes nothing if it never ends", () => {
    const shell = openDb(join(f.home, 'gateway.db'));
    try {
      shell.pragma('busy_timeout = 5');
      const s = new KanbanService({ db: shell, roles: new Map(), workspaces: new Set(['default']) });
      gateway.exec('BEGIN IMMEDIATE');
      expect(() => s.addGate(taskId, { command: 'npm test' }, ME)).toThrow(/database is locked/);
      gateway.exec('COMMIT');
      expect(gatesOf(gateway, taskId)).toEqual([]);
      expect(s.addGate(taskId, { command: 'npm test' }, ME).ok).toBe(true);
    } finally {
      shell.close();
    }
  });
});
