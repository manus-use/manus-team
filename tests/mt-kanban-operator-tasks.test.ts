import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { commentsOf, eventsOf, getRun, getTask, parentsOf, subscriptionsOf } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { claimed } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * The operator's task commands (spec §2.6, §9.1): `mt kanban new`, `list`,
 * `show`, `assign`, `link`, `unblock`, `stop`, `archive` and `comment`, with
 * chat's semantics, as the operator, beside a gateway that has the board open.
 */

let f: MtFixture;
let gateway: Db;
let server: WorkerServer | undefined;
let nudges: number;
const ME = `operator:${userInfo().username}`;

beforeEach(async () => {
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
      '  passEnv: [API_KEY]',
      '',
    ].join('\n'),
  );
  gateway = openDb(join(f.home, 'team.db'));
  migrate(gateway, SCHEMA_DIR);
  nudges = 0;
  server = await listenWorker(workerSocketPath(f.home), () => {
    nudges += 1;
    return { ok: true };
  });
});

afterEach(async () => {
  clearSecrets();
  await server?.close();
  gateway.close();
  f.cleanup();
});

interface Run {
  stdin?: string;
  tty?: boolean;
  env?: Record<string, string | undefined>;
}

/** As the operator's shell runs it, with stdin when given. */
async function mt(argv: string[], opts: Run = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMt(['kanban', ...argv], {
    env: { ...f.env, HOME: f.root, API_KEY: 'sk-live-1234567890', ...opts.env },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    stdinIsTTY: opts.tty ?? false,
    stdin: async (max) => {
      const text = opts.stdin ?? '';
      return Buffer.byteLength(text) > max ? undefined : text;
    },
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** The id `mt kanban new` printed. */
function created(out: string): string {
  const m = /^created (k_[0-9a-z]+):/.exec(out);
  if (m?.[1] === undefined) throw new Error(`not created: ${out}`);
  return m[1];
}

describe('mt kanban new', () => {
  it("creates a task as the operator, with chat's fields as flags, followed by no chat, and nudges the gateway", async () => {
    const parent = created((await mt(['new', 'Parent', '--assignee', 'default'])).out);
    const r = await mt([
      'new', 'Draft', 'the', 'summary',
      '--assignee', 'default',
      '--workspace', 'default',
      '--parent', parent,
      '--outcome', 'a page',
      '--verify', 'it links every source',
      '--stop-when', 'it is ten pages',
      '--body', 'Use last quarter as the model.',
    ]);
    expect(r).toMatchObject({ code: 0, err: '' });
    const taskId = created(r.out);
    expect(r.out).toBe(`created ${taskId}: Draft the summary, for role default, in default, on board default`);
    expect(getTask(gateway, taskId)).toMatchObject({
      title: 'Draft the summary',
      body: 'Use last quarter as the model.',
      contract: { outcome: 'a page', verification: 'it links every source', stop_when: 'it is ten pages' },
      createdBy: ME,
      createdVia: { kind: 'operator' },
      board: 'default',
    });
    expect(parentsOf(gateway, taskId).map((p) => p.taskId)).toEqual([parent]);
    expect(subscriptionsOf(gateway, taskId)).toEqual([]);
    expect(nudges).toBe(2);
  });

  it('reads the body from a file, or from stdin with --body-file -, and refuses a terminal there', async () => {
    const file = join(f.root, 'body.md');
    writeFileSync(file, 'From a file.\r\nTwo lines.\n');
    const fromFile = created((await mt(['new', 'A', '--body-file', file])).out);
    expect(getTask(gateway, fromFile)?.body).toBe('From a file.\nTwo lines.');
    const fromStdin = created((await mt(['new', 'B', '--body-file', '-'], { stdin: 'From stdin.' })).out);
    expect(getTask(gateway, fromStdin)?.body).toBe('From stdin.');
    expect(await mt(['new', 'C', '--body-file', '-'], { tty: true })).toEqual({
      code: 1,
      out: '',
      err: 'mt: --body-file - reads the body on stdin; stdin is a terminal: redirect a file or pipe it',
    });
    expect(await mt(['new', 'D', '--body-file', join(f.root, 'nowhere.md')])).toMatchObject({
      code: 1,
      err: `mt: cannot read the body from ${join(f.root, 'nowhere.md')}: ENOENT`,
    });
  });

  it('reads a body only from a regular file: not a directory, a device or a FIFO, which could block', async () => {
    const dir = join(f.root, 'a-dir');
    mkdirSync(dir);
    const fifo = join(f.root, 'a-fifo');
    execFileSync('mkfifo', [fifo]);
    for (const path of [dir, '/dev/null', fifo]) {
      expect(await mt(['new', 'E', '--body-file', path])).toEqual({
        code: 1,
        out: '',
        err: `mt: ${path} is not a regular file: give a file, or - for stdin`,
      });
    }
    expect(gateway.prepare('SELECT count(*) AS n FROM kanban_tasks').get()).toEqual({ n: 0 });
  });

  it('refuses a title holding a line break or a control character, as a wrong command line', async () => {
    for (const title of ['two\nlines', 'a\u0007bell', 'a\u2028separator']) {
      const r = await mt(['new', title]);
      expect(r.code).toBe(2);
      expect(r.err.split('\n')[0]).toBe('mt: a title is one line, with no control characters');
    }
    expect(gateway.prepare('SELECT count(*) AS n FROM kanban_tasks').get()).toEqual({ n: 0 });
  });

  it("refuses what chat refuses: a person, an unknown role, an archived board, a task over chat's limits", async () => {
    expect(await mt(['new', 'x', '--assignee', 'lark:on_bob'])).toEqual({
      code: 1,
      out: '',
      err: 'mt: "lark:on_bob" is a person: give a person work from chat, by @-mention, where the gateway can check they have talk tier',
    });
    expect(await mt(['new', 'x', '--reviewer', '@Bob'])).toMatchObject({ code: 1 });
    expect(await mt(['new', 'x', '--assignee', 'implementr'])).toMatchObject({ code: 1, err: 'mt: role "implementr" is not configured' });
    expect(await mt(['new', 'x', '--board', 'nowhere'])).toMatchObject({ code: 1, err: 'mt: there is no board nowhere; no task is added to it' });
    expect(await mt(['new', 'x'.repeat(513)])).toMatchObject({ code: 1, err: 'mt: A title is at most 512 bytes; put the rest in the body.' });
    const json = await mt(['new', 'x', '--assignee', 'implementr', '--json']);
    expect(JSON.parse(json.out)).toEqual({ ok: false, code: 'unknown_role', message: 'role "implementr" is not configured' });
    expect(gateway.prepare('SELECT count(*) AS n FROM kanban_tasks').get()).toEqual({ n: 0 });
    expect(nudges).toBe(0);
  });

  it('answers a wrong command line with exit 2', async () => {
    for (const argv of [
      ['new'],
      ['new', 'x', '--body', 'a', '--body-file', 'b'],
      ['new', 'x', '--outcome', ''],
      ['new', 'x', '--parent', ','],
      ['new', 'x', '--priority', '3'],
      ['new', 'x', '--board', '  '],
      ['list', '--board', ''],
    ]) {
      expect((await mt(argv)).code).toBe(2);
    }
  });

  it('puts the task on the board --board names, and lists that board', async () => {
    expect((await mt(['board', 'create', 'web-app'])).code).toBe(0);
    const taskId = created((await mt(['new', 'On web', '--board', 'web-app'])).out);
    expect(getTask(gateway, taskId)?.board).toBe('web-app');
    expect((await mt(['list'])).out).toBe('no open tasks on board default; mt kanban list all shows done and archived ones too');
    const listed = await mt(['list', '--board', 'web-app', '--json']);
    expect(JSON.parse(listed.out)).toEqual({
      ok: true,
      board: 'web-app',
      tasks: [{ task_id: taskId, status: 'ready', title: 'On web', assignee: null, assignee_kind: null }],
    });
    expect(await mt(['list', '--board', 'nowhere'])).toMatchObject({ code: 1, err: 'mt: there is no board nowhere' });
    expect((await mt(['list', 'finished'])).code).toBe(2);
  });
});

describe('the task commands', () => {
  it('shows a task, in plain text or JSON, and refuses one that does not exist', async () => {
    const taskId = created((await mt(['new', 'Show me', '--assignee', 'default', '--body', 'key sk-live-1234567890'])).out);
    const shown = await mt(['show', taskId]);
    expect(shown.out.split('\n')).toEqual([
      `Show me (${taskId}): ready`,
      'assignee: role default · reviewer: nobody · workspace: not yet fixed · board: default',
      '',
      '    key ••••',
      '',
    ]);
    const json = JSON.parse((await mt(['show', taskId, '--json'])).out) as { task: { body: string; board: string } };
    expect(json.task).toMatchObject({ body: 'key ••••', board: 'default' });
    expect(await mt(['show', 'k_missing'])).toMatchObject({ code: 1, err: 'mt: no task k_missing' });
  });

  it('assigns, stops, unblocks, comments, links and archives, as the operator, nudging after what chat follows with a pass', async () => {
    const taskId = created((await mt(['new', 'Work', '--assignee', 'default'])).out);
    const child = created((await mt(['new', 'Later'])).out);
    nudges = 0;
    const run = claimed(gateway, taskId);

    expect((await mt(['stop', taskId])).out).toBe(
      `stopped ${taskId}: its run was cancelled, and the task is blocked (needs_input); mt kanban unblock ${taskId} runs it again`,
    );
    expect(getRun(gateway, run.runId)?.outcome).toBe('cancelled');
    expect((await mt(['unblock', taskId, 'try', 'again'])).out).toBe(`${taskId} is unblocked, back to open`);
    expect((await mt(['assign', taskId, 'default'])).out).toBe(`${taskId} is already assigned to role default`);
    expect((await mt(['comment', taskId, 'look', 'at', 'the', 'lexer'])).out).toBe(
      `comment added to ${taskId}: an agent working on it gets it when its current turn ends; otherwise the next run reads it`,
    );
    expect(commentsOf(gateway, taskId).map((c) => [c.author, c.body])).toEqual([[ME, 'try again'], [ME, 'look at the lexer']]);
    expect((await mt(['link', taskId, child])).out).toBe(`${child} now waits for ${taskId}`);
    expect((await mt(['link', taskId, child])).out).toBe(`${child} already waits for ${taskId}`);
    expect((await mt(['assign', child, 'default'])).out).toBe(`${child} is now for role default`);
    expect((await mt(['archive', child])).out).toBe(`archived ${child}`);
    // stop, unblock, the second assign and archive; not comment or link, as in chat.
    expect(nudges).toBe(4);
    expect(eventsOf(gateway, taskId).filter((e) => e.actor === ME).map((e) => e.kind)).toEqual([
      'created',
      'stopped',
      'unblocked',
      'commented',
      'commented',
    ]);
  });

  it('with --board, acts only on a task on that board, both tasks for link, and refuses a board that does not exist', async () => {
    expect((await mt(['board', 'create', 'web-app'])).code).toBe(0);
    const here = created((await mt(['new', 'Here', '--board', 'web-app', '--assignee', 'default'])).out);
    const there = created((await mt(['new', 'There', '--assignee', 'default'])).out);
    const other = (id: string) => ({ code: 1, out: '', err: `mt: task ${id} is on board default, not web-app` });
    for (const argv of [
      ['show', there],
      ['assign', there, 'default'],
      ['unblock', there],
      ['stop', there],
      ['archive', there],
      ['comment', there, 'hello'],
      ['link', here, there],
    ]) {
      expect(await mt([...argv, '--board', 'web-app'])).toEqual(other(there));
    }
    expect(await mt(['link', there, here, '--board', 'web-app'])).toEqual(other(there));
    const json = await mt(['stop', there, '--board', 'web-app', '--json']);
    expect(JSON.parse(json.out)).toEqual({ ok: false, code: 'other_board', message: `task ${there} is on board default, not web-app` });
    expect(await mt(['show', here, '--board', 'nowhere'])).toEqual({ code: 1, out: '', err: 'mt: there is no board nowhere' });
    expect(await mt(['show', 'k_missing', '--board', 'web-app'])).toMatchObject({ code: 1, err: 'mt: no task k_missing' });
    expect(eventsOf(gateway, there).map((e) => e.kind)).toEqual(['created']);

    // On its own board, and without --board on any.
    expect((await mt(['show', here, '--board', ' web-app '])).out.split('\n')[0]).toBe(`Here (${here}): ready`);
    expect((await mt(['comment', here, 'hi', '--board', 'web-app'])).code).toBe(0);
    expect((await mt(['archive', here, '--board', 'web-app'])).out).toBe(`archived ${here}`);
    expect((await mt(['archive', there])).out).toBe(`archived ${there}`);
  });

  it('answers a wrong command line with exit 2', async () => {
    for (const argv of [['show', 'k_1', '--board', ''], ['stop', 'k_1', '--board', ' '], ['show'], ['show', 'a', 'b'], ['assign', 'k_1'], ['link', 'k_1'], ['stop', 'k_1', 'now'], ['comment', 'k_1'], ['unblock']]) {
      expect((await mt(argv)).code).toBe(2);
    }
  });
});

describe("in a board run's shell", () => {
  const RUN = { MT_KANBAN_RUN: 'r_1', MT_KANBAN_TOKEN: 'not-a-token', MT_KANBAN_SOCKET: '/nowhere.sock' };

  it("refuses the operator's commands, and changes nothing", async () => {
    for (const argv of [['new', 'x'], ['list'], ['assign', 'k_1', 'default'], ['unblock', 'k_1'], ['stop', 'k_1'], ['archive', 'k_1']]) {
      const r = await mt(argv, { env: RUN });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/is an operator's command, not a board run's/);
    }
    expect(gateway.prepare('SELECT count(*) AS n FROM kanban_tasks').get()).toEqual({ n: 0 });
  });

  it("takes show, comment and link as the worker's, which never take the operator's arguments", async () => {
    for (const argv of [['show', 'k_1'], ['comment', 'k_1', 'hello'], ['link', 'k_1', 'k_2']]) {
      const r = await mt(argv, { env: RUN });
      expect(r.code).toBe(2);
      expect(JSON.parse(r.out)).toMatchObject({ ok: false, code: 'bad_request' });
    }
  });
});
