import type { Channel } from '../../src/channel/types.js';
import { SessionRegistry } from '../../src/core/registry.js';
import { NamedWorkspaces } from '../../src/core/workspace.js';
import { getRun } from '../../src/db/kanban-read.js';
import { Dispatcher, type DispatcherSettings } from '../../src/kanban/dispatcher.js';
import { KanbanService, type CreateRequest } from '../../src/kanban/service.js';
import { KanbanSink } from '../../src/kanban/sink.js';
import type { RunRow, TaskRow } from '../../src/kanban/types.js';
import type { Role } from '../../src/roles.js';
import type { TurnTerminal } from '../../src/types.js';
import { FakeChannel } from './channel.js';
import { FakeDriver } from './driver.js';
import { ManualClock, settle, testDb, type TestDb } from './db.js';
import { ALICE, VIA } from './kanban.js';

/**
 * A dispatcher over the real board, session registry and actors, with a fake
 * driver per role: the agents are scripts, and report through the service the
 * way plan C3's worker CLI will, using the run id in their environment.
 */

export const APP = 'cli_app';

export function role(name: string, extra: Partial<Role> = {}, readOnlyTools: readonly string[] = []): Role {
  return {
    name,
    source: 'directory',
    dir: undefined,
    description: undefined,
    workspace: undefined,
    agent: {
      driver: 'structured-cli',
      command: 'bytesec',
      args: ['run'],
      env: {},
      unsupervised: true,
      passEnv: [],
      readOnlyTools,
      maskExempt: [],
    },
    roleMdPath: undefined,
    skills: [],
    secretValues: [],
    ...extra,
  };
}

export interface DispatchHarness {
  t: TestDb;
  clock: ManualClock;
  service: KanbanService;
  registry: SessionRegistry;
  dispatcher: Dispatcher;
  lark: FakeChannel;
  notes: string[];
  driver(roleName: string): FakeDriver;
  /** Create a task through the service, as chat would. */
  create(req: Partial<CreateRequest>): TaskRow;
  /**
   * The run an agent started on this driver most recently is working on. Right
   * only while the driver has one run at a time; a script reads its own from
   * `ctl.env`, as `completes` does.
   */
  runOf(driver: FakeDriver): RunRow;
  close(): void;
}

export interface HarnessOptions {
  roles?: readonly Role[];
  settings?: Partial<DispatcherSettings>;
  maxLive?: number;
  /** Another harness's database: a second gateway process, after a restart. */
  t?: TestDb;
  clock?: ManualClock;
}

export const DEFAULT_ROLES: readonly Role[] = [
  role('implementer'),
  role('reviewer'),
  role('docs-writer', { workspace: 'docs' }),
];

export function dispatchHarness(opts: HarnessOptions = {}): DispatchHarness {
  const t = opts.t ?? testDb();
  const clock = opts.clock ?? new ManualClock();
  const roles = new Map((opts.roles ?? DEFAULT_ROLES).map((r) => [r.name, r]));
  const drivers = new Map([...roles.keys(), 'default'].map((name) => [name, new FakeDriver(name)]));
  const workspaces = new Map(['default', 'web', 'api', 'docs'].map((name) => [name, `/tmp/ws-${name}`]));
  const service = new KanbanService({ db: t.db, roles, workspaces: new Set(workspaces.keys()), clock });
  const lark = new FakeChannel({ id: 'lark', clock });
  const notes: string[] = [];
  // The registry asks the dispatcher, which is built after it, as in src/index.ts.
  let dispatcher: Dispatcher | undefined;
  const registry = new SessionRegistry({
    db: t.db,
    drivers,
    channels: new Map<string, Channel>([
      ['lark', lark],
      ['kanban', new KanbanSink(() => clock.now())],
    ]),
    envFor: (sessionId) => dispatcher?.envFor(sessionId),
    pinned: (sessionId) => dispatcher?.pinned(sessionId) ?? false,
    workspaces: new NamedWorkspaces(workspaces),
    appId: APP,
    clock,
    maxLive: opts.maxLive ?? 8,
    note: (line) => notes.push(line),
  });
  dispatcher = new Dispatcher({
    db: t.db,
    service,
    sessions: registry,
    roles,
    appId: APP,
    settings: { maxRunning: 8, defaultMaxRuntimeS: 4 * 3600, strandedAfterS: 1800, sweepIntervalS: 60, ...opts.settings },
    clock,
    note: (line) => notes.push(line),
  });
  return {
    t,
    clock,
    service,
    registry,
    dispatcher,
    lark,
    notes,
    driver(roleName) {
      const d = drivers.get(roleName);
      if (d === undefined) throw new Error(`no driver for role ${roleName}`);
      return d;
    },
    create(req) {
      const r = service.create({ title: 'a task', assignee: 'implementer', createdBy: ALICE, createdVia: VIA, ...req });
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      return r.task;
    },
    runOf(driver) {
      const runId = driver.starts.at(-1)?.env?.['MT_KANBAN_RUN'];
      const run = runId === undefined ? undefined : getRun(t.db, runId);
      if (run === undefined) throw new Error(`driver ${driver.id} has started no run`);
      return run;
    },
    close: () => t.close(),
  };
}

/** Let the runs move until `done` holds, or give up. */
export async function until(done: () => boolean, what = 'the condition'): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (done()) return;
    await settle();
  }
  throw new Error(`gave up waiting for ${what}`);
}

/**
 * Report complete through the service, as the agent of a run would: the run
 * given by id, or this driver's latest -- which is right only while the driver
 * has one run at a time.
 */
export function reportComplete(h: DispatchHarness, from: FakeDriver | string, summary = 'done'): void {
  const run = typeof from === 'string' ? getRun(h.t.db, from) : h.runOf(from);
  if (run === undefined) throw new Error(`no run ${String(from)}`);
  const r = h.service.complete(run.taskId, { kind: 'run', runId: run.runId }, { summary });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
}

/** The next turn on this driver reports complete for its own run, then ends. */
export function completes(h: DispatchHarness, driver: FakeDriver, summary = 'done'): void {
  driver.scripts.push((ctl) => {
    const runId = ctl.env?.['MT_KANBAN_RUN'];
    if (runId === undefined) throw new Error(`a turn on driver ${driver.id} was started with no run`);
    reportComplete(h, runId, summary);
    ctl.end('completed');
  });
}

/** A turn held open until the test lets it end; `started` once it is running. */
export interface Held {
  started: boolean;
  /** End the turn: optionally do something first, as the agent, then end with `terminal`. */
  end(terminal?: TurnTerminal, first?: () => void): void;
}

export function holds(driver: FakeDriver): Held {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ending: { terminal: TurnTerminal; first: (() => void) | undefined } = { terminal: 'completed', first: undefined };
  const held: Held = {
    started: false,
    end(terminal = 'completed', first) {
      ending = { terminal, first };
      release?.();
    },
  };
  driver.scripts.push(async (ctl) => {
    held.started = true;
    await gate;
    ending.first?.();
    ctl.end(ending.terminal);
  });
  return held;
}
