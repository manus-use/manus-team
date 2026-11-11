import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerWorktree } from '../src/db/workspaces.js';
import type { CommitReader } from '../src/kanban/commit.js';
import type { GateExit, GateRunOptions } from '../src/kanban/gates.js';
import { renderShow } from '../src/kanban/chat-render.js';
import { KanbanService } from '../src/kanban/service.js';
import type { RunRow, TaskRow } from '../src/kanban/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, NOW, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * The service and a task's own directory (spec §18): the claim is told which
 * workspaces are isolated, a report's checks run in the task's directory, a
 * report there holds back no other task, and `show` says where the directory is.
 */

const ROLES = new Map([role('default'), role('implementer')].map((r) => [r.name, r]));
const DIRS = new Map([...WORKSPACES].map((w) => [w, `/ws/${w}`]));
const SHA = '0123456789abcdef0123456789abcdef01234567';

let t: TestDb;
let s: KanbanService;
let ran: Array<{ command: string; cwd: string }>;
let read: string[];
let release: (() => void) | undefined;

beforeEach(() => {
  t = testDb();
  ran = [];
  read = [];
  release = undefined;
  const runGate = async (command: string, opts: GateRunOptions): Promise<GateExit> => {
    ran.push({ command, cwd: opts.cwd });
    if (command === 'slow') await new Promise<void>((resolve) => (release = resolve));
    return { exitCode: 0, signal: null, timedOut: false, output: '' };
  };
  const readCommit: CommitReader = async (cwd) => {
    read.push(cwd);
    return { commit: SHA, dirty: false };
  };
  s = new KanbanService({
    db: t.db,
    roles: ROLES,
    workspaces: WORKSPACES,
    isolated: new Set(['web']),
    clock: new ManualClock(),
    checks: { workspaceDirs: DIRS, env: { PATH: '/usr/bin' }, runGate, readCommit },
  });
});
afterEach(() => t.close());

function create(workspace = 'web'): TaskRow {
  const r = s.create({ title: 'a task', assignee: 'implementer', workspace, createdBy: ALICE, createdVia: VIA });
  if (!r.ok) throw new Error(r.message);
  return r.task;
}

function claim(taskId: string): RunRow {
  const r = s.claim(taskId);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.run;
}

/** The task's directory, as the dispatcher records it once made. */
function made(taskId: string): string {
  const path = `/home/mt/worktrees/web/${taskId}`;
  registerWorktree(t.db, { id: `wt:${taskId}`, kind: 'git-worktree', rootPath: path, repoRoot: '/ws/web', branch: `mt/${taskId}` }, NOW);
  return path;
}

describe('a task with a directory of its own', () => {
  it('is claimed with one, beside another task in the same workspace', () => {
    const a = create();
    const b = create();
    expect(claim(a.taskId).workspace).toBe(`wt:${a.taskId}`);
    expect(claim(b.taskId).workspace).toBe(`wt:${b.taskId}`);
  });

  it('runs its gates, and reads its commit, in its own directory', async () => {
    const task = create();
    s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const run = claim(task.taskId);
    const dir = made(task.taskId);
    expect(await s.complete(task.taskId, { kind: 'run', runId: run.runId }, { summary: 'done' })).toMatchObject({
      ok: true,
      run: { reportedCommit: SHA },
    });
    expect(ran).toEqual([{ command: 'npm test', cwd: dir }]);
    expect(read).toEqual([dir]);
  });

  it('refuses gates it cannot run yet: its directory is made before its next agent run', async () => {
    const task = create();
    s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const run = claim(task.taskId);
    expect(await s.complete(task.taskId, { kind: 'run', runId: run.runId }, { summary: 'done' })).toMatchObject({
      ok: false,
      code: 'gates_cannot_run',
      message: `task ${task.taskId}'s own directory has not been made yet, so its gates cannot run; it is made before its next agent run`,
    });
    expect(ran).toEqual([]);
  });

  it('holds back no other task while its gates run, as a shared directory does', async () => {
    const task = create();
    s.addGate(task.taskId, { command: 'slow' }, ALICE);
    const run = claim(task.taskId);
    made(task.taskId);
    const report = s.complete(task.taskId, { kind: 'run', runId: run.runId }, { summary: 'done' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(ran.map((r) => r.command)).toEqual(['slow']);
    // Another task in the same workspace starts in its own directory meanwhile.
    expect(s.claim(create().taskId)).toMatchObject({ ok: true });
    release?.();
    expect(await report).toMatchObject({ ok: true });
  });

  it("is not said to wait on the shared directory's agent run", () => {
    // A task first claimed before the workspace was isolated works in the shared directory.
    const shared = create();
    const before = new KanbanService({ db: t.db, roles: ROLES, workspaces: WORKSPACES, clock: new ManualClock() });
    const r = before.claim(shared.taskId);
    if (!r.ok) throw new Error(r.message);
    const waiting = create();
    expect(s.show(waiting.taskId)).toMatchObject({ ok: true });
    const view = s.show(waiting.taskId);
    expect(view.ok && view.view.waiting).toBeUndefined();
    // As the claim agrees: it gets a directory of its own, and is not held back.
    expect(s.claim(waiting.taskId)).toMatchObject({ ok: true, run: { workspace: `wt:${waiting.taskId}` } });
  });

  it("is claimed while a report's gates run in the shared directory, which it does not work in", async () => {
    // A task first claimed before the workspace was isolated works in the shared directory.
    const shared = create();
    s.addGate(shared.taskId, { command: 'slow' }, ALICE);
    const before = new KanbanService({ db: t.db, roles: ROLES, workspaces: WORKSPACES, clock: new ManualClock() });
    const run = before.claim(shared.taskId);
    if (!run.ok) throw new Error(run.message);
    const report = s.complete(shared.taskId, { kind: 'run', runId: run.run.runId }, { summary: 'done' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(ran.map((r) => r.cwd)).toEqual(['/ws/web']);
    const fresh = create();
    expect(s.claim(fresh.taskId)).toMatchObject({ ok: true, run: { workspace: `wt:${fresh.taskId}` } });
    // A second shared task still waits for the shared directory's agent.
    const other = create();
    const plain = new KanbanService({ db: t.db, roles: ROLES, workspaces: WORKSPACES, clock: new ManualClock() });
    expect(plain.claim(other.taskId)).toMatchObject({ ok: false, code: 'workspace_busy' });
    release?.();
    expect(await report).toMatchObject({ ok: true });
  });

  it('says, before any agent has taken it up, that its directory is made when one first does', () => {
    const task = create();
    const view = s.show(task.taskId);
    if (!view.ok) throw new Error(view.message);
    const shown = renderShow(view.view, []);
    expect(shown.split('\n')).toContain('directory: its own, not made yet: it is made when an agent first takes the task up');
    expect(shown).not.toMatch(/git/i);
    // A task in a workspace that is not isolated says nothing of a directory.
    const shared = s.show(create('api').taskId);
    expect(shared.ok && shared.view.workdir).toBeUndefined();
  });

  it('says where its directory is, and its branch, once made', () => {
    const task = create();
    claim(task.taskId);
    expect(s.show(task.taskId)).toMatchObject({ ok: true, view: { workdir: { path: null, branch: null } } });
    const dir = made(task.taskId);
    expect(s.show(task.taskId)).toMatchObject({ ok: true, view: { workdir: { path: dir, branch: `mt/${task.taskId}` } } });
    const shared = create('api');
    claim(shared.taskId);
    const view = s.show(shared.taskId);
    expect(view.ok && view.view.workdir).toBeUndefined();
  });
});
