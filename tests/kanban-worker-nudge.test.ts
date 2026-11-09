import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KanbanService } from '../src/kanban/service.js';
import { listenWorker, type WorkerServer } from '../src/kanban/socket.js';
import { NUDGE, WorkerApi } from '../src/kanban/worker.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { WORKSPACES } from './helpers/kanban.js';

/**
 * The nudge (spec §7.3): the one request with no token, which asks for a
 * dispatcher pass and does nothing else.
 */

let t: TestDb;
let api: WorkerApi;
let passes: number;

beforeEach(() => {
  t = testDb();
  passes = 0;
  const service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
  });
  api = new WorkerApi({ db: t.db, service, changed: () => (passes += 1) });
});

afterEach(() => t.close());

/** The next tick, when a nudge's pass runs. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('the nudge', () => {
  it('asks for a pass, with no run or token, and answers ok', async () => {
    expect(await api.handle({ ...NUDGE })).toEqual({ ok: true });
    await tick();
    expect(passes).toBe(1);
  });

  it('asks for one pass for a burst of nudges, and another for a nudge after it', async () => {
    for (let i = 0; i < 5; i += 1) expect(await api.handle({ ...NUDGE })).toEqual({ ok: true });
    expect(passes).toBe(0);
    await tick();
    expect(passes).toBe(1);
    await api.handle({ ...NUDGE });
    await tick();
    expect(passes).toBe(2);
  });

  it('is exactly {"nudge": true}: anything else is an ordinary request, refused without a pass', async () => {
    for (const raw of [{ nudge: 'yes' }, { nudge: true, run: 'r_1' }, { nudge: 1 }]) {
      expect(await api.handle(raw)).toMatchObject({ ok: false, code: 'bad_request' });
    }
    await tick();
    expect(passes).toBe(0);
  });

  it('is answered through the socket, as one line', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-nudge-')));
    let server: WorkerServer | undefined;
    try {
      server = await listenWorker(join(root, 'run', 'kanban.sock'), (req) => api.handle(req));
      const path = server.path;
      const line = await new Promise<string>((resolve, reject) => {
        const conn = createConnection(path);
        let got = '';
        conn.setEncoding('utf8');
        conn.on('data', (d: string) => (got += d));
        conn.once('error', reject);
        conn.once('close', () => resolve(got));
        conn.write(`${JSON.stringify(NUDGE)}\n`);
      });
      expect(line).toBe('{"ok":true}\n');
      await tick();
      expect(passes).toBe(1);
    } finally {
      await server?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
