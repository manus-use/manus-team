import { mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { getRun } from '../src/db/kanban-read.js';
import { KanbanService } from '../src/kanban/service.js';
import { listenWorker, type WorkerServer } from '../src/kanban/socket.js';
import { hashToken, mintToken } from '../src/kanban/token.js';
import type { RunRow } from '../src/kanban/types.js';
import { WorkerApi } from '../src/kanban/worker.js';
import { clearSecrets } from '../src/secrets.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * `mt kanban` as an agent runs it: the run's environment, JSON on stdin, and
 * the real worker API behind a real socket.
 */

let t: TestDb;
let root: string;
let server: WorkerServer;
let run: RunRow;
let env: Record<string, string>;
let asked = 0;

beforeEach(async () => {
  clearSecrets();
  t = testDb();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-kanban-')));
  const service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
  });
  const api = new WorkerApi({ db: t.db, service });
  asked = 0;
  server = await listenWorker(join(root, 'run', 'kanban.sock'), (req) => {
    asked += 1;
    return api.handle(req);
  });
  const created = service.create({ title: 'a task', assignee: 'implementer', workspace: 'web', createdBy: ALICE, createdVia: VIA });
  if (!created.ok) throw new Error(created.message);
  const token = mintToken();
  const claimed = service.claim(created.task.taskId, { tokenHash: hashToken(token) });
  if (!claimed.ok) throw new Error(claimed.message);
  run = claimed.run;
  env = { MT_KANBAN_RUN: run.runId, MT_KANBAN_TOKEN: token, MT_KANBAN_SOCKET: server.path };
});

afterEach(async () => {
  clearSecrets();
  await server.close();
  t.close();
  rmSync(root, { recursive: true, force: true });
});

async function mt(
  argv: string[],
  stdin: string | (() => never) = '',
  over: Record<string, string | undefined> = {},
  stdinIsTTY = false,
): Promise<{ code: number; out: unknown; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMt(argv, {
    env: { ...env, ...over },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdinIsTTY,
    stdin: async (max) => {
      const text = typeof stdin === 'function' ? stdin() : stdin;
      return Buffer.byteLength(text) > max ? undefined : text;
    },
  });
  // One line of JSON, always.
  expect(out).toHaveLength(1);
  return { code, out: JSON.parse(out[0] ?? ''), err: err.join('\n') };
}

describe('mt kanban', () => {
  it('reports through the socket: JSON on stdin, one line of JSON out, exit 0', async () => {
    const r = await mt(['kanban', 'complete'], '{"summary": "parsed it", "metadata": {"files": 2}}');
    expect(r).toEqual({ code: 0, out: { ok: true, task_id: run.taskId, phase: 'done', outcome: 'completed' }, err: '' });
    expect(getRun(t.db, run.runId)).toMatchObject({ outcome: 'completed', summary: 'parsed it', metadata: { files: 2 } });
  });

  it('prints a refusal as JSON and exits 1', async () => {
    await mt(['kanban', 'complete'], '{"summary": "once"}');
    const r = await mt(['kanban', 'complete'], '{"summary": "twice"}');
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({ ok: false, code: 'already_reported' });
  });

  it('shows the task without reading stdin', async () => {
    const r = await mt(['kanban', 'show'], () => {
      throw new Error('show read stdin');
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ ok: true, task: { task_id: run.taskId, title: 'a task' } });
  });

  it('refuses outside a run, without asking the gateway', async () => {
    const r = await mt(['kanban', 'show'], '', { MT_KANBAN_TOKEN: undefined });
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({ ok: false, code: 'not_in_a_run' });
    expect(asked).toBe(0);
  });

  it('refuses input that is not JSON, or too large, without asking the gateway or quoting it', async () => {
    const notJson = await mt(['kanban', 'comment'], 'body: sk-not-json');
    expect(notJson).toMatchObject({ code: 1, out: { ok: false, code: 'invalid' } });
    expect(JSON.stringify(notJson.out)).not.toContain('sk-not-json');
    const big = await mt(['kanban', 'comment'], JSON.stringify({ body: 'x'.repeat(300 * 1024) }));
    expect(big).toMatchObject({ code: 1, out: { ok: false, code: 'too_large' } });
    expect(asked).toBe(0);
  });

  it('answers a wrong command line with JSON too, exit 2', async () => {
    expect(await mt(['kanban', 'finish'])).toMatchObject({ code: 2, out: { ok: false, code: 'unknown_command' } });
    expect(await mt(['kanban'])).toMatchObject({ code: 2, out: { ok: false, code: 'unknown_command' } });
    expect(await mt(['kanban', 'complete', '--summary', 'x'])).toMatchObject({ code: 2, out: { ok: false, code: 'bad_request' } });
  });

  it('says when the gateway cannot be reached, and never prints the token', async () => {
    const r = await mt(['kanban', 'show'], '', { MT_KANBAN_SOCKET: join(root, 'nowhere.sock') });
    expect(r).toMatchObject({ code: 1, out: { ok: false, code: 'unreachable' } });
    expect(JSON.stringify(r)).not.toContain(env['MT_KANBAN_TOKEN']);
  });

  it('asks whether the gateway is running when there is no socket, and says to try again only when it refused', async () => {
    const missing = join(root, 'nowhere.sock');
    expect((await mt(['kanban', 'show'], '', { MT_KANBAN_SOCKET: missing })).out).toEqual({
      ok: false,
      code: 'unreachable',
      message: `cannot reach the gateway at ${missing}: ENOENT; is the gateway running?`,
    });
    // A socket nothing listens on: refused, as a busy gateway's full backlog refuses.
    const refused = join(root, 'refused.sock');
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(join(root, 'dead.sock'), resolve));
    renameSync(join(root, 'dead.sock'), refused);
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    expect((await mt(['kanban', 'show'], '', { MT_KANBAN_SOCKET: refused })).out).toEqual({
      ok: false,
      code: 'unreachable',
      message: `cannot reach the gateway at ${refused}: ECONNREFUSED; if it is running, it may be busy: try again`,
    });
  });

  it('refuses at once when stdin is a terminal, for every command that reads it; show still works', async () => {
    const never = (): never => {
      throw new Error('read a terminal');
    };
    for (const command of ['complete', 'review', 'changes', 'block', 'comment', 'create', 'link']) {
      expect(await mt(['kanban', command], never, {}, true)).toEqual({
        code: 1,
        out: {
          ok: false,
          code: 'invalid',
          message: `mt kanban ${command} reads JSON on stdin; stdin is a terminal: redirect a file or pipe it`,
        },
        err: '',
      });
    }
    expect(asked).toBe(0);
    expect((await mt(['kanban', 'show'], never, {}, true)).code).toBe(0);
  });

  it('is in the usage', async () => {
    const out: string[] = [];
    await runMt(['help'], { env: {}, out: (l) => out.push(l), err: () => undefined });
    expect(out.join('\n')).toContain('mt kanban <show|complete|review|changes|block|comment|create|link> < input.json');
  });
});
