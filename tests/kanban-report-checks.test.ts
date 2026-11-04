import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventsOf, getRun, getTask, lastGateRun } from '../src/db/kanban-read.js';
import type { CommitReader, ReportedState } from '../src/kanban/commit.js';
import type { GateExit, GateRunOptions } from '../src/kanban/gates.js';
import { KanbanService, type CreateRequest } from '../src/kanban/service.js';
import { hashToken, mintToken } from '../src/kanban/token.js';
import type { Reporter, RunRow, TaskRow } from '../src/kanban/types.js';
import { WorkerApi } from '../src/kanban/worker.js';
import type { Role } from '../src/roles.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * A report's checks (spec §7.7, §7.8): the task's gates, run before complete or
 * review is accepted, whoever reports; and, for an agent's report, the state of
 * its workspace. Over a runner and a git that start no process.
 */

const SHA = '0123456789abcdef0123456789abcdef01234567';
const PARENT_ENV = { PATH: '/usr/bin', HOME: '/home/mt', LARK_APP_SECRET: 'lark-secret-123', MT_KANBAN_TOKEN: 'tok' };

function withKey(name: string, key: string): Role {
  const base = role(name);
  return { ...base, agent: { ...base.agent, env: { API_KEY: key } } };
}

const ROLES = new Map(
  [withKey('default', 'key-default'), withKey('implementer', 'key-implementer'), withKey('reviewer', 'key-reviewer')].map(
    (r) => [r.name, r],
  ),
);
const DIRS = new Map([...WORKSPACES].map((w) => [w, `/ws/${w}`]));

interface Gated {
  t: TestDb;
  s: KanbanService;
  /** Every gate run: its command, where, and the role's key it had. */
  ran: Array<{ command: string; cwd: string; key: string | undefined; env: Readonly<Record<string, string>> }>;
  /** Every workspace read for a commit. */
  read: Array<{ cwd: string; env: Readonly<Record<string, string>> }>;
  /** How the next gates exit, by command; a command missing exits 0. */
  exits: Map<string, Partial<GateExit>>;
  /** A gate held until the test lets it go. */
  hold(command: string): { started: Promise<void>; release(exit?: Partial<GateExit>): void };
  state: ReportedState;
  /** Called as a commit is read. */
  onRead?: () => void;
  create(req?: Partial<CreateRequest>): TaskRow;
  claim(taskId: string): RunRow;
}

let g: Gated;

function gated(): Gated {
  const t = testDb();
  const held = new Map<string, { started: () => void; gate: Promise<Partial<GateExit>> }>();
  const out: Gated = {
    t,
    s: undefined as unknown as KanbanService,
    ran: [],
    read: [],
    exits: new Map(),
    hold(command) {
      let started!: () => void;
      let release!: (exit: Partial<GateExit>) => void;
      const startedP = new Promise<void>((resolve) => (started = resolve));
      held.set(command, { started, gate: new Promise((resolve) => (release = resolve)) });
      return { started: startedP, release: (exit = {}) => release(exit) };
    },
    state: { commit: SHA, dirty: false },
    create(req = {}) {
      const r = out.s.create({ title: 'a task', assignee: 'implementer', workspace: 'web', createdBy: ALICE, createdVia: VIA, ...req });
      if (!r.ok) throw new Error(r.message);
      return r.task;
    },
    claim(taskId) {
      const r = out.s.claim(taskId);
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      return r.run;
    },
  };
  const runGate = async (command: string, opts: GateRunOptions): Promise<GateExit> => {
    out.ran.push({ command, cwd: opts.cwd, key: opts.env['API_KEY'], env: opts.env });
    const h = held.get(command);
    let exit: Partial<GateExit> = out.exits.get(command) ?? {};
    if (h !== undefined) {
      held.delete(command);
      h.started();
      exit = await h.gate;
    }
    return { exitCode: 0, signal: null, timedOut: false, output: '', ...exit };
  };
  const readCommit: CommitReader = async (cwd, opts) => {
    out.read.push({ cwd, env: opts.env });
    out.onRead?.();
    return out.state;
  };
  out.s = new KanbanService({
    db: t.db,
    roles: ROLES,
    workspaces: WORKSPACES,
    clock: new ManualClock(),
    checks: { workspaceDirs: DIRS, env: PARENT_ENV, runGate, readCommit },
  });
  return out;
}

const person: Reporter = { kind: 'person', principal: ALICE };
const as = (run: RunRow): Reporter => ({ kind: 'run', runId: run.runId });

beforeEach(() => {
  clearSecrets();
  g = gated();
});
afterEach(() => {
  clearSecrets();
  g.t.close();
});

describe('gates on complete and review', () => {
  it("runs an agent's gates in the workspace, as its role, and records the run and the commit", async () => {
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const run = g.claim(task.taskId);

    expect(await g.s.complete(task.taskId, as(run), { summary: 'done' })).toMatchObject({
      ok: true,
      task: { phase: 'done' },
      run: { outcome: 'completed', reportedCommit: SHA, reportedDirty: false },
    });
    expect(g.ran).toEqual([
      {
        command: 'npm test',
        cwd: '/ws/web',
        key: 'key-implementer',
        env: { PATH: '/usr/bin', HOME: '/home/mt', API_KEY: 'key-implementer' },
      },
    ]);
    // The commit is read with what an agent is given of the gateway's environment, and no more.
    expect(g.read).toEqual([{ cwd: '/ws/web', env: { PATH: '/usr/bin', HOME: '/home/mt' } }]);
    expect(lastGateRun(g.t.db, task.taskId)).toMatchObject({
      runId: run.runId,
      actor: `run:${run.runId}`,
      for: 'complete',
      passed: true,
      aborted: false,
      notRun: 0,
      results: [{ command: 'npm test', exitCode: 0, timedOut: false }],
    });
  });

  it('refuses a report whose gate fails, with the gate, its exit and its output, and leaves the run undecided', async () => {
    addSecrets(['sk-live-1234567890']);
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    g.s.addGate(task.taskId, { command: 'npm run lint' }, ALICE);
    const run = g.claim(task.taskId);
    g.exits.set('npm test', { exitCode: 1, output: 'FAIL parser.test.ts with sk-live-1234567890' });

    expect(await g.s.complete(task.taskId, as(run), { summary: 'done' })).toEqual({
      ok: false,
      code: 'gate_failed',
      message: 'gate "npm test" exited 1; the report was not applied: fix it and report again',
      gate: { command: 'npm test', exitCode: 1, signal: null, timedOut: false, output: `FAIL parser.test.ts with ${MASK}` },
    });
    expect(g.ran.map((r) => r.command)).toEqual(['npm test']);
    expect(getRun(g.t.db, run.runId)?.outcome).toBeNull();
    expect(getTask(g.t.db, task.taskId)?.phase).toBe('open');
    expect(lastGateRun(g.t.db, task.taskId)).toMatchObject({
      passed: false,
      notRun: 1,
      results: [{ exitCode: 1, output: `FAIL parser.test.ts with ${MASK}` }],
    });

    g.exits.clear();
    expect(await g.s.complete(task.taskId, as(run), { summary: 'fixed' })).toMatchObject({ ok: true, task: { phase: 'done' } });
    expect(eventsOf(g.t.db, task.taskId).filter((e) => e.kind === 'gates_ran')).toHaveLength(2);
  });

  it('says how a gate that timed out or could not start refused the report', async () => {
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test', timeoutS: 120 }, ALICE);
    const run = g.claim(task.taskId);
    g.exits.set('npm test', { exitCode: null, signal: 'SIGTERM', timedOut: true });
    expect(await g.s.complete(task.taskId, as(run), { summary: 'done' })).toMatchObject({
      code: 'gate_failed',
      message: 'gate "npm test" ran past its 120 s; the report was not applied: fix it and report again',
    });
    g.exits.set('npm test', { exitCode: null, signal: null, output: 'the gate could not start: spawn /bin/sh ENOENT' });
    expect(await g.s.complete(task.taskId, as(run), { summary: 'done' })).toMatchObject({
      code: 'gate_failed',
      message: 'gate "npm test" could not start; the report was not applied: fix it and report again',
    });
  });

  it("runs gates for an implementer's review as the implementer, and for a reviewer's approval as the reviewer", async () => {
    const task = g.create({ reviewer: 'reviewer' });
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const work = g.claim(task.taskId);
    expect(await g.s.requestReview(task.taskId, as(work), { summary: 'have a look' })).toMatchObject({
      ok: true,
      run: { outcome: 'review_requested', reportedCommit: SHA },
    });
    g.s.closeRun(work.runId);
    const review = g.claim(task.taskId);
    g.state = { commit: null, dirty: true };
    expect(await g.s.complete(task.taskId, as(review), { summary: 'LGTM' })).toMatchObject({
      ok: true,
      run: { kind: 'review', outcome: 'completed', reportedCommit: null, reportedDirty: true },
    });
    expect(g.ran.map((r) => r.key)).toEqual(['key-implementer', 'key-reviewer']);
    expect(lastGateRun(g.t.db, task.taskId)).toMatchObject({ for: 'complete', runId: review.runId });
  });

  it("runs a person's gates as the latest agent run's role, or default, and reads no commit for them", async () => {
    const reviewed = g.create({ reviewer: 'reviewer' });
    g.s.addGate(reviewed.taskId, { command: 'npm test' }, ALICE);
    const work = g.claim(reviewed.taskId);
    expect((await g.s.requestReview(reviewed.taskId, as(work), { summary: 'v1' })).ok).toBe(true);
    g.s.closeRun(work.runId);
    expect(await g.s.complete(reviewed.taskId, person, { summary: 'approved' })).toMatchObject({ ok: true, run: undefined });

    const untouched = g.create();
    g.s.addGate(untouched.taskId, { command: 'make check' }, ALICE);
    expect((await g.s.complete(untouched.taskId, person, { summary: 'done by hand' })).ok).toBe(true);

    expect(g.ran.map((r) => [r.command, r.key])).toEqual([
      ['npm test', 'key-implementer'],
      ['npm test', 'key-implementer'],
      ['make check', 'key-default'],
    ]);
    expect(g.read).toHaveLength(1);
    expect(lastGateRun(g.t.db, untouched.taskId)).toMatchObject({ runId: null, actor: ALICE });
  });

  it('runs nothing for a report the board would refuse anyway', async () => {
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const run = g.claim(task.taskId);
    expect(await g.s.complete(task.taskId, person, { summary: 'done' })).toMatchObject({ code: 'agent_run_open' });
    expect(await g.s.requestReview(task.taskId, as(run), { summary: 'v1' })).toMatchObject({ code: 'no_reviewer' });
    expect((await g.s.complete(task.taskId, as(run), { summary: 'done' })).ok).toBe(true);
    expect(await g.s.complete(task.taskId, as(run), { summary: 'again' })).toMatchObject({ code: 'already_reported' });
    expect(g.ran).toHaveLength(1);
    expect(g.read).toHaveLength(1);
  });

  it('refuses a report whose gates cannot run, saying why, rather than run them elsewhere or as someone else', async () => {
    const made = g.s.create({ title: 'no workspace yet', assignee: 'implementer', createdBy: ALICE, createdVia: VIA });
    if (!made.ok) throw new Error(made.message);
    const nowhere = made.task;
    g.s.addGate(nowhere.taskId, { command: 'npm test' }, ALICE);
    expect(await g.s.complete(nowhere.taskId, person, { summary: 'done' })).toEqual({
      ok: false,
      code: 'gates_cannot_run',
      message: `task ${nowhere.taskId} has gates and no workspace to run them in; set its workspace first`,
    });

    // The same board, as a gateway whose configuration has changed would see it.
    const changed = (roles: ReadonlyMap<string, Role>, dirs: ReadonlyMap<string, string>) =>
      new KanbanService({ db: g.t.db, roles, workspaces: WORKSPACES, checks: { workspaceDirs: dirs, env: PARENT_ENV } });
    const onlyDefault = new Map([['default', withKey('default', 'k')]]);
    const gone = g.create({ workspace: 'api' });
    g.s.addGate(gone.taskId, { command: 'npm test' }, ALICE);
    expect(await changed(onlyDefault, new Map([['web', '/ws/web']])).complete(gone.taskId, person, { summary: 'done' })).toEqual({
      ok: false,
      code: 'gates_cannot_run',
      message: `task ${gone.taskId}'s workspace "api" is no longer configured, so its gates cannot run`,
    });

    const worked = g.create();
    g.s.addGate(worked.taskId, { command: 'npm test' }, ALICE);
    const run = g.claim(worked.taskId);
    expect(await changed(onlyDefault, DIRS).complete(worked.taskId, as(run), { summary: 'done' })).toMatchObject({
      code: 'gates_cannot_run',
      message: `task ${worked.taskId}'s gates run with the environment of role "implementer", which is no longer configured`,
    });

    const unchecked = new KanbanService({ db: g.t.db, roles: ROLES, workspaces: WORKSPACES });
    expect(await unchecked.complete(worked.taskId, as(run), { summary: 'done' })).toMatchObject({
      code: 'gates_cannot_run',
      message: `task ${worked.taskId} has gates, and this gateway runs none`,
    });
    expect(getRun(g.t.db, run.runId)?.outcome).toBeNull();
  });
});

describe('a report while its gates run', () => {
  it('refuses a second report on the task, and a claim, until the first has its answer', async () => {
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const run = g.claim(task.taskId);
    const held = g.hold('npm test');
    const first = g.s.complete(task.taskId, as(run), { summary: 'done' });
    await held.started;

    expect(await g.s.complete(task.taskId, as(run), { summary: 'done' })).toEqual({
      ok: false,
      code: 'report_in_progress',
      message:
        `task ${task.taskId} is being reported on already, and its gates are running; ` +
        'wait for that answer, or see mt kanban show',
    });
    const other = g.create();
    g.s.addGate(other.taskId, { command: 'npm test' }, ALICE);
    const otherHeld = g.hold('npm test');
    const person1 = g.s.complete(other.taskId, person, { summary: 'done' });
    await otherHeld.started;
    expect(g.s.claim(other.taskId)).toEqual({
      ok: false,
      code: 'not_claimable',
      message: `task ${other.taskId} is being reported on: its gates are running`,
    });
    otherHeld.release();
    expect((await person1).ok).toBe(true);

    held.release();
    expect(await first).toMatchObject({ ok: true, task: { phase: 'done' } });
  });

  it('claims no other task in the workspace whose gates are running, and any in another', async () => {
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const held = g.hold('npm test');
    const report = g.s.complete(task.taskId, person, { summary: 'done' });
    await held.started;
    const same = g.create({ title: 'same checkout' });
    const other = g.create({ title: 'another checkout', workspace: 'api' });
    expect(g.s.claim(same.taskId)).toEqual({
      ok: false,
      code: 'not_claimable',
      message: `workspace web is running the gates of a report on task ${task.taskId}`,
    });
    expect(g.s.claim(other.taskId).ok).toBe(true);
    held.release();
    expect((await report).ok).toBe(true);
    expect(g.s.claim(same.taskId).ok).toBe(true);
  });

  it('settles once the report is answered', async () => {
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const run = g.claim(task.taskId);
    await g.s.settled(task.taskId);
    const held = g.hold('npm test');
    const report = g.s.complete(task.taskId, as(run), { summary: 'done' });
    await held.started;
    let settled = false;
    const waiting = g.s.settled(task.taskId).then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    held.release();
    await waiting;
    expect(getRun(g.t.db, run.runId)?.outcome).toBe('completed');
    expect((await report).ok).toBe(true);
  });

  it('applies nothing for a run decided while its gates ran: the board checks again after them', async () => {
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const run = g.claim(task.taskId);
    const held = g.hold('npm test');
    const report = g.s.complete(task.taskId, as(run), { summary: 'done' });
    await held.started;
    expect(g.s.endRun(run.runId, { outcome: 'timed_out', error: 'past its limit' }).ok).toBe(true);
    held.release();
    expect(await report).toMatchObject({ ok: false, code: 'run_superseded' });
    expect(getRun(g.t.db, run.runId)?.outcome).toBe('timed_out');
    expect(lastGateRun(g.t.db, task.taskId)).toMatchObject({ passed: true });
  });

  it('applies nothing once the gateway stops while the gates run', async () => {
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    g.s.addGate(task.taskId, { command: 'npm run lint' }, ALICE);
    const run = g.claim(task.taskId);
    const held = g.hold('npm test');
    const stopping = new AbortController();
    const report = g.s.complete(task.taskId, as(run), { summary: 'done' }, { signal: stopping.signal });
    await held.started;
    stopping.abort();
    held.release({ exitCode: null, signal: 'SIGTERM' });
    expect(await report).toEqual({
      ok: false,
      code: 'gates_cannot_run',
      message: 'the gateway is stopping, so the gates did not finish and the report was not applied; report again once it is back',
    });
    expect(getRun(g.t.db, run.runId)?.outcome).toBeNull();
    expect(lastGateRun(g.t.db, task.taskId)).toMatchObject({ passed: false, aborted: true, notRun: 1 });
  });
});

describe('a report while the gateway stops', () => {
  it('applies nothing when the stop comes as the commit is read, with no gate to notice it', async () => {
    const task = g.create();
    const run = g.claim(task.taskId);
    const stopping = new AbortController();
    g.onRead = () => stopping.abort();
    expect(await g.s.complete(task.taskId, as(run), { summary: 'done' }, { signal: stopping.signal })).toEqual({
      ok: false,
      code: 'gates_cannot_run',
      message: 'the gateway is stopping, so the gates did not finish and the report was not applied; report again once it is back',
    });
    expect(getRun(g.t.db, run.runId)?.outcome).toBeNull();
  });
});

describe("a workspace's directory that is gone", () => {
  it('refuses the report, naming the directory, rather than run a gate that cannot start', async () => {
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const message = `task ${task.taskId}'s workspace directory /ws/web does not exist`;
    const missing = new KanbanService({
      db: g.t.db,
      roles: ROLES,
      workspaces: WORKSPACES,
      checks: {
        workspaceDirs: DIRS,
        env: PARENT_ENV,
        runGate: async () => ({ exitCode: 0, signal: null, timedOut: false, output: '' }),
        isDirectory: () => false,
      },
    });
    const refused = { ok: false, code: 'gates_cannot_run', message };
    expect(await missing.complete(task.taskId, person, { summary: 'done' })).toEqual(refused);
    // The real runner's default: the filesystem, which has no /ws/web. Nothing is started.
    const real = new KanbanService({
      db: g.t.db,
      roles: ROLES,
      workspaces: WORKSPACES,
      checks: { workspaceDirs: DIRS, env: PARENT_ENV },
    });
    expect(await real.complete(task.taskId, person, { summary: 'done' })).toEqual(refused);
    expect(getTask(g.t.db, task.taskId)?.phase).toBe('open');
  });
});

describe('a gate refusal through the worker API', () => {
  it('carries the failing command, its exit code and the end of its output', async () => {
    const api = new WorkerApi({ db: g.t.db, service: g.s });
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const token = mintToken();
    const claimed = g.s.claim(task.taskId, { tokenHash: hashToken(token) });
    if (!claimed.ok) throw new Error(claimed.message);
    g.exits.set('npm test', { exitCode: 1, output: '1 failing' });
    const input = { summary: 'v1', reviewer: 'reviewer' };
    expect(await api.handle({ run: claimed.run.runId, token, command: 'review', input })).toEqual({
      ok: false,
      code: 'gate_failed',
      message: 'gate "npm test" exited 1; the report was not applied: fix it and report again',
      gate: { command: 'npm test', exit_code: 1, signal: null, timed_out: false, output: '1 failing' },
    });
  });
});

describe('a report through the worker API while the gateway stops', () => {
  it('is told so, and applies nothing', async () => {
    const api = new WorkerApi({ db: g.t.db, service: g.s });
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const token = mintToken();
    const claimed = g.s.claim(task.taskId, { tokenHash: hashToken(token) });
    if (!claimed.ok) throw new Error(claimed.message);
    const stopping = new AbortController();
    stopping.abort();
    const request = { run: claimed.run.runId, token, command: 'complete', input: { summary: 'done' } };
    expect(await api.handle(request, { signal: stopping.signal })).toMatchObject({ ok: false, code: 'gates_cannot_run' });
    expect(g.ran).toEqual([]);
    expect(getRun(g.t.db, claimed.run.runId)?.outcome).toBeNull();
  });
});
