import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanService } from '../src/kanban/service.js';
import { listenWorker, type WorkerServer } from '../src/kanban/socket.js';
import { NUDGE, NUDGE_INTERVAL_MS, WorkerApi } from '../src/kanban/worker.js';
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

  it('asks for one pass for a burst of nudges on one tick', async () => {
    for (let i = 0; i < 5; i += 1) expect(await api.handle({ ...NUDGE })).toEqual({ ok: true });
    expect(passes).toBe(0);
    await tick();
    expect(passes).toBe(1);
  });

  it('runs at most one pass a nudge asks for in each 100 ms, and the last nudge in a window is never lost', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'Date'] });
    try {
      expect(NUDGE_INTERVAL_MS).toBe(100);
      await api.handle({ ...NUDGE });
      await vi.advanceTimersByTimeAsync(0);
      expect(passes).toBe(1);
      // Nudges on separate ticks, as a socket's arrive, inside the window: one more pass, at its end.
      for (let i = 0; i < 5; i += 1) {
        await vi.advanceTimersByTimeAsync(10);
        expect(await api.handle({ ...NUDGE })).toEqual({ ok: true });
      }
      expect(passes).toBe(1);
      await vi.advanceTimersByTimeAsync(49);
      expect(passes).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(passes).toBe(2);
      await vi.advanceTimersByTimeAsync(500);
      expect(passes).toBe(2);
      // Long after: a nudge's pass runs at once again.
      await api.handle({ ...NUDGE });
      await vi.advanceTimersByTimeAsync(0);
      expect(passes).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs no pass a nudge asked for once the API is stopped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'Date'] });
    try {
      await api.handle({ ...NUDGE });
      await vi.advanceTimersByTimeAsync(0);
      await api.handle({ ...NUDGE });
      api.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(passes).toBe(1);
      expect(await api.handle({ ...NUDGE })).toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(passes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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
