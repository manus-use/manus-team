import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Channel } from '../src/channel/types.js';
import { SessionRegistry } from '../src/core/registry.js';
import { NamedWorkspaces } from '../src/core/workspace.js';
import { createCliDriver } from '../src/driver/cli/driver.js';
import type { Driver } from '../src/driver/types.js';
import { eventsOf, getTask, runsOf } from '../src/db/kanban-read.js';
import { Dispatcher } from '../src/kanban/dispatcher.js';
import { KanbanService } from '../src/kanban/service.js';
import { lastTurnOf } from '../src/kanban/session-log.js';
import { writeMtShim } from '../src/kanban/shim.js';
import { KanbanSink } from '../src/kanban/sink.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { WorkerApi } from '../src/kanban/worker.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, VIA } from './helpers/kanban.js';

/**
 * The board end to end (spec §11): a real dispatcher runs a task as a session
 * whose agent is a real process -- the fake CLI agent, through the real CLI
 * driver -- and that process reports by running `mt kanban` by name: the
 * gateway's shim on its PATH, the real CLI, the real socket, the real worker
 * API and the real board.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));

interface Stack {
  t: TestDb;
  service: KanbanService;
  dispatcher: Dispatcher;
  server: WorkerServer;
  registry: SessionRegistry;
  dir: string;
  workspace: string;
  invocations(): Array<{ prompt: string; run: string | null }>;
  /** The environment the agent ran with, as it wrote it down. */
  runEnv(): Record<string, string>;
}

let stack: Stack | undefined;

beforeEach(() => clearSecrets());
afterEach(async () => {
  clearSecrets();
  if (stack === undefined) return;
  await stack.registry.closeAll();
  await stack.dispatcher.idle(5_000);
  await stack.server.close();
  stack.t.close();
  rmSync(stack.dir, { recursive: true, force: true });
  stack = undefined;
});

/** `gated`: the service runs gates and reads commits, for real, and the role's agent has a key a gate can see. */
async function build(mode: string, opts: { gated?: boolean } = {}): Promise<Stack> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-e2e-')));
  const home = join(dir, 'home');
  const workspace = join(dir, 'repo');
  mkdirSync(home);
  mkdirSync(workspace);
  const log = join(dir, 'invocations.log');
  const t = testDb();
  const implementer = role('implementer');
  const roles = new Map([
    [
      'implementer',
      opts.gated === true ? { ...implementer, agent: { ...implementer.agent, env: { GATE_KEY: 'from-the-role' } } } : implementer,
    ],
  ]);
  const service = new KanbanService({
    db: t.db,
    roles,
    workspaces: new Set(['default']),
    // A made-up home, so git reads no configuration of the real one.
    ...(opts.gated === true
      ? { checks: { workspaceDirs: new Map([['default', workspace]]), env: { PATH: process.env['PATH'], HOME: home } } }
      : {}),
  });
  const drivers = new Map<string, Driver>([
    ['implementer', createCliDriver({ command: process.execPath, args: [AGENT], env: { FAKE_CLI_MODE: mode, FAKE_CLI_LOG: log } })],
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
  stack = {
    t,
    service,
    dispatcher,
    server,
    registry,
    dir,
    workspace,
    invocations: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as { prompt: string; run: string | null }),
    runEnv: () => JSON.parse(readFileSync(join(dir, 'kanban-env.json'), 'utf8')) as Record<string, string>,
  };
  return stack;
}

function create(s: Stack, title: string): string {
  const r = s.service.create({ title, assignee: 'implementer', workspace: 'default', createdBy: ALICE, createdVia: VIA });
  if (!r.ok) throw new Error(r.message);
  return r.task.taskId;
}

/**
 * `mt kanban` run by name, as the agent's shell would, with the environment
 * given. Not spawnSync: the socket is served by this process, which must keep
 * running to answer.
 */
function mt(env: Record<string, string>, command: string, input: unknown): Promise<{ status: number | null; answer: unknown }> {
  return new Promise((resolve, reject) => {
    const child = spawn('mt', ['kanban', command], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.once('error', reject);
    child.once('close', (status) => {
      try {
        resolve({ status, answer: JSON.parse(out) as unknown });
      } catch (err) {
        reject(err as Error);
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

describe('the worker CLI, end to end', () => {
  it('a fake agent reports complete by running mt kanban, through the real socket', async () => {
    const s = await build('kanban');
    const taskId = create(s, 'Write the parser');

    s.dispatcher.pass();
    await s.dispatcher.idle();

    expect(getTask(s.t.db, taskId)?.phase).toBe('done');
    const [run] = runsOf(s.t.db, taskId);
    expect(run).toMatchObject({ outcome: 'completed', summary: 'did: Write the parser', metadata: { by: 'cli-agent' }, submissions: 1 });
    expect(run?.endedAt).not.toBeNull();
    // What the agent saw: both commands answered.
    expect(lastTurnOf(s.t.db, run?.sessionId ?? '').output).toContain(
      `show: 0; complete: {"ok":true,"task_id":"${taskId}","phase":"done","outcome":"completed"}`,
    );
    expect(s.invocations()).toEqual([expect.objectContaining({ run: run?.runId })]);

    // The agent was given the run, its socket, and the gateway's mt first on PATH.
    const env = s.runEnv();
    expect(env).toMatchObject({ MT_KANBAN_RUN: run?.runId, MT_KANBAN_SOCKET: s.server.path });
    expect(env['PATH']?.startsWith(`${join(s.dir, 'home', 'bin')}:`)).toBe(true);

    // A report after the run is closed -- a background job, a late retry -- is refused (spec §7.6).
    const late = await mt(env, 'complete', { summary: 'again' });
    expect(late).toEqual({
      status: 1,
      answer: { ok: false, code: 'run_superseded', message: `run ${run?.runId} is over; its task has moved on without it` },
    });
    expect(runsOf(s.t.db, taskId)[0]?.summary).toBe('did: Write the parser');
    // Only its hash was stored: every column read as text, a blob's bytes decoded, so a token in either is found.
    const stored = (s.t.db.prepare('SELECT * FROM kanban_runs').all() as Array<Record<string, unknown>>)
      .flatMap((row) => Object.values(row))
      .map((value) => (Buffer.isBuffer(value) ? value.toString('utf8') : String(value)));
    expect(stored.length).toBeGreaterThan(0);
    for (const value of stored) expect(value).not.toContain(env['MT_KANBAN_TOKEN']);
  });

  it("an agent's report runs the task's gate in the workspace, and is refused until it passes", async () => {
    const s = await build('kanban-gated', { gated: true });
    const env = { PATH: process.env['PATH'], HOME: join(s.dir, 'home'), GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: s.workspace, env, encoding: 'utf8' })
        .stdout.trim();
    git('init', '-q');
    writeFileSync(join(s.workspace, 'README'), 'a repository\n');
    git('add', 'README');
    git('commit', '-q', '-m', 'first');
    const head = git('rev-parse', 'HEAD');
    const taskId = create(s, 'Make the gate pass');
    const gate =
      'test -f gate-ok && echo "key=$GATE_KEY token=${MT_KANBAN_TOKEN:-none} socket=${MT_KANBAN_SOCKET:-none}" && echo "path=$PATH"';
    expect(s.service.addGate(taskId, { command: gate, timeoutS: 30 }, ALICE).ok).toBe(true);

    s.dispatcher.pass();
    await s.dispatcher.idle();

    const [run] = runsOf(s.t.db, taskId);
    expect(getTask(s.t.db, taskId)?.phase).toBe('done');
    // The commit it reported on, and the file the agent left uncommitted.
    expect(run).toMatchObject({ outcome: 'completed', summary: 'gate fixed', reportedCommit: head, reportedDirty: true });
    // What the agent was told, each time.
    const [first, second] = lastTurnOf(s.t.db, run?.sessionId ?? '')
      .output.split('\n')
      .map((line) => JSON.parse(line.slice(line.indexOf(' ') + 1)) as unknown);
    expect(first).toEqual({
      ok: false,
      code: 'gate_failed',
      message: `gate ${JSON.stringify(gate)} exited 1; the report was not applied: fix it and report again`,
      gate: { command: gate, exit_code: 1, signal: null, timed_out: false, output: '' },
    });
    expect(second).toEqual({ ok: true, task_id: taskId, phase: 'done', outcome: 'completed' });
    // Each run of the gate recorded; the one that passed had the role's key, and neither the token nor the socket.
    const ran = eventsOf(s.t.db, taskId).filter((e) => e.kind === 'gates_ran');
    expect(ran.map((e) => (e.payload as { passed: boolean }).passed)).toEqual([false, true]);
    const [passed] = (ran[1]?.payload as { results: Array<{ exitCode: number; output: string }> }).results;
    expect(passed?.exitCode).toBe(0);
    const [said, path] = (passed?.output ?? '').split('\n');
    expect(said).toBe('key=from-the-role token=none socket=none');
    // The gateway's own PATH, never a run's: the mt shim's directory is not on it.
    expect(path).toBe(`path=${process.env['PATH'] ?? ''}`);
    expect(path?.split(':')).not.toContain(join(s.dir, 'home', 'bin'));
  });

  it('an agent that stops without reporting is nudged in its own session, and then reports', async () => {
    const s = await build('kanban-late');
    const taskId = create(s, 'Fix the build');

    s.dispatcher.pass();
    await s.dispatcher.idle();

    const [run] = runsOf(s.t.db, taskId);
    expect(run).toMatchObject({ outcome: 'completed', summary: 'did: Fix the build', submissions: 2 });
    const [first, second] = s.invocations();
    expect(s.invocations()).toHaveLength(2);
    expect(first?.run).toBe(run?.runId);
    expect(second?.run).toBe(run?.runId);
    // The CLI driver carries the first turn into the second as a transcript, then the nudge.
    expect(second?.prompt).toContain('Next I will report.');
    expect(second?.prompt).toContain('You ended your turn without reporting, so your run is not over (reminder 1 of 2).');
  });
});
