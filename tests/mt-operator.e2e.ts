import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Channel } from '../src/channel/types.js';
import { SessionRegistry } from '../src/core/registry.js';
import { NamedWorkspaces } from '../src/core/workspace.js';
import { createCliDriver } from '../src/driver/cli/driver.js';
import type { Driver } from '../src/driver/types.js';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import { Dispatcher } from '../src/kanban/dispatcher.js';
import { KanbanService } from '../src/kanban/service.js';
import { writeMtShim } from '../src/kanban/shim.js';
import { KanbanSink } from '../src/kanban/sink.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { WorkerApi } from '../src/kanban/worker.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';

/**
 * The operator's `mt kanban` end to end (spec §2.6): the real `mt`, as a process
 * of its own, writing the board a gateway has open, and nudging it over the real
 * socket. The gateway's dispatcher is never asked for a pass by the test: the
 * nudge is what starts a task created at the terminal, and what cancels the
 * turn of a run stopped there.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));

interface Gateway {
  t: TestDb;
  dispatcher: Dispatcher;
  registry: SessionRegistry;
  server: WorkerServer;
  dir: string;
  home: string;
  log: string;
}

let g: Gateway | undefined;

beforeEach(() => clearSecrets());
afterEach(async () => {
  clearSecrets();
  if (g === undefined) return;
  await g.registry.closeAll();
  await g.dispatcher.idle(5_000);
  await g.server.close();
  g.t.close();
  rmSync(g.dir, { recursive: true, force: true });
  g = undefined;
});

/** A gateway's board, dispatcher and socket, with the role default run by the fake CLI agent in `mode`. */
async function gateway(mode: string): Promise<Gateway> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-op-e2e-')));
  const home = join(dir, 'home');
  const workspace = join(dir, 'repo');
  mkdirSync(home);
  mkdirSync(workspace);
  // What the operator's mt reads: the gateway's config, whose agent block is the role default.
  writeFileSync(
    join(home, 'config.yaml'),
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
  const log = join(dir, 'invocations.log');
  const t = testDb();
  const roles = new Map([['default', role('default')]]);
  const service = new KanbanService({ db: t.db, roles, workspaces: new Set(['default']) });
  const drivers = new Map<string, Driver>([
    [
      'default',
      createCliDriver({
        command: process.execPath,
        args: [AGENT],
        env: { FAKE_CLI_MODE: mode, FAKE_CLI_LOG: log, FAKE_CLI_SESSIONS: join(dir, 'sessions') },
      }),
    ],
  ]);
  let dispatcher: Dispatcher | undefined;
  const registry = new SessionRegistry({
    db: t.db,
    drivers,
    channels: new Map<string, Channel>([['kanban', new KanbanSink()]]),
    envFor: (sessionId) => dispatcher?.envFor(sessionId),
    argsFor: (sessionId) => dispatcher?.argsFor(sessionId),
    pinned: (sessionId) => dispatcher?.pinned(sessionId) ?? false,
    workspaces: new NamedWorkspaces(new Map([['default', workspace]])),
    appId: 'cli_app',
    maxLive: 4,
  });
  const socket = workerSocketPath(home);
  dispatcher = new Dispatcher({
    db: t.db,
    service,
    sessions: registry,
    roles,
    appId: 'cli_app',
    settings: { maxRunning: 2, defaultMaxRuntimeS: 600, strandedAfterS: 1800, sweepIntervalS: 60, nudgeLimit: 2 },
    worker: { socket, mtDir: writeMtShim(home), path: process.env['PATH'] },
  });
  const d = dispatcher;
  const api = new WorkerApi({ db: t.db, service, changed: () => d.pass() });
  const server = await listenWorker(socket, (request, signal) => api.handle(request, { signal }));
  g = { t, dispatcher, registry, server, dir, home, log };
  return g;
}

/** The operator's `mt kanban …`, as a process: the gateway's own build, through the shim it wrote. */
function operator(gw: Gateway, args: string[]): Promise<{ status: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const env = { MT_HOME: gw.home, MT_DB: join(gw.t.dir, 'team.db'), PATH: process.env['PATH'] ?? '', HOME: gw.dir };
    const child = spawn(join(gw.home, 'bin', 'mt'), ['kanban', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.stderr.on('data', (d: string) => (err += d));
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, out: out.trim(), err: err.trim() }));
  });
}

async function waitFor(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`gave up waiting for ${what}`);
}

describe('the operator at a terminal, end to end', () => {
  it('creates a task the running gateway starts at once, nudged, and its agent completes', async () => {
    const gw = await gateway('kanban');
    const r = await operator(gw, ['new', 'Write the parser', '--assignee', 'default', '--workspace', 'default']);
    expect(r).toMatchObject({ status: 0, err: '' });
    const taskId = /^created (k_[0-9a-z]+):/.exec(r.out)?.[1] ?? '';
    expect(getTask(gw.t.db, taskId)?.createdVia).toEqual({ kind: 'operator' });

    await gw.dispatcher.idle();
    expect(getTask(gw.t.db, taskId)?.phase).toBe('done');
    expect(runsOf(gw.t.db, taskId)[0]).toMatchObject({ outcome: 'completed', summary: 'did: Write the parser' });
  });

  it("stops a running agent's run, whose turn the gateway cancels once nudged", async () => {
    const gw = await gateway('hang');
    const made = await operator(gw, ['new', 'Never finishes', '--assignee', 'default', '--workspace', 'default']);
    const taskId = /^created (k_[0-9a-z]+):/.exec(made.out)?.[1] ?? '';
    await waitFor(() => existsSync(gw.log) && readFileSync(gw.log, 'utf8').trim() !== '', 'the agent to start');

    const stopped = await operator(gw, ['stop', taskId]);
    expect(stopped).toMatchObject({ status: 0, err: '' });
    expect(stopped.out).toMatch(new RegExp(`^stopped ${taskId}: its run was cancelled`));

    await gw.dispatcher.idle();
    const [run] = runsOf(gw.t.db, taskId);
    expect(run).toMatchObject({ outcome: 'cancelled' });
    expect(run?.endedAt).not.toBeNull();
    expect(getTask(gw.t.db, taskId)?.phase).toBe('blocked');
  });
});
