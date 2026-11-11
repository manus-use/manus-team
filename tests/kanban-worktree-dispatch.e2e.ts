import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRun, getTask, runsOf } from '../src/db/kanban-read.js';
import { worktreeOf } from '../src/db/workspaces.js';
import { TaskDirectories } from '../src/kanban/worktree.js';
import type { FakeDriver } from './helpers/driver.js';
import { completes, dispatchHarness, reportComplete, type DispatchHarness } from './helpers/dispatch.js';
import { testDb } from './helpers/db.js';
import { ALICE } from './helpers/kanban.js';

/**
 * A DAG in an isolated git workspace, end to end (spec §18): two parallel tasks
 * of one role run at once, each committing in its own worktree; their child
 * starts from the merge of their branches, its gates run there and its commit is
 * read there; and the base branch is never touched.
 */

let dir: string;
let repo: string;
let env: Record<string, string>;
let h: DispatchHarness;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** The directory a turn's run works in, read from the board as the agent would find its cwd. */
function runDir(runId: string): string {
  const run = getRun(h.t.db, runId);
  const task = run === undefined ? undefined : getTask(h.t.db, run.taskId);
  const cwd = task?.worktree === null || task === undefined ? undefined : worktreeOf(h.t.db, task.worktree)?.rootPath;
  if (cwd === undefined) throw new Error(`run ${runId} has no directory of its own`);
  return cwd;
}

/**
 * The next `n` turns on this driver each wait until all `n` have started, then
 * write and commit a file named after their task in their own directory, and
 * report complete. Resolves `started` once all are running at once.
 */
function together(driver: FakeDriver, n: number): { started: Promise<void> } {
  let count = 0;
  let all!: () => void;
  const started = new Promise<void>((resolve) => (all = resolve));
  for (let i = 0; i < n; i += 1) {
    driver.scripts.push(async (ctl) => {
      count += 1;
      if (count === n) all();
      await started;
      const runId = ctl.env?.['MT_KANBAN_RUN'] ?? '';
      const cwd = runDir(runId);
      const file = `${getRun(h.t.db, runId)?.taskId ?? ''}.txt`;
      writeFileSync(join(cwd, file), 'work\n');
      git(cwd, 'add', file);
      git(cwd, 'commit', '-q', '-m', `add ${file}`);
      await reportComplete(h, runId);
      ctl.end('completed');
    });
  }
  return { started };
}

/** Real git takes real time: wait for `done` in wall-clock time, or give up. */
async function eventually(done: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 30_000;
  while (!done()) {
    if (Date.now() > until) throw new Error(`gave up waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-wt-dispatch-')));
  env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1' };
  repo = join(dir, 'web');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@example.com');
  writeFileSync(join(repo, 'README'), 'hello\n');
  git(repo, 'add', 'README');
  git(repo, 'commit', '-q', '-m', 'first');
  mkdirSync(join(dir, 'home'));
  const t = testDb();
  const dirs = new Map([['web', repo]]);
  h = dispatchHarness({
    t,
    isolated: new Set(['web']),
    dirs: { web: repo },
    settings: { maxRunning: 4 },
    // The gates and the commit, for real, in the run's own directory.
    checks: { workspaceDirs: dirs, env },
    workdirs: new TaskDirectories({ db: t.db, root: join(dir, 'home', 'worktrees'), workspaceDirs: dirs, isolated: { web: {} }, env }),
  });
});

afterEach(() => {
  h.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a DAG in an isolated git workspace', () => {
  it('runs two parallel tasks of one role at once, and starts their child from the merge of their branches', async () => {
    const a = h.create({ title: 'write a', workspace: 'web' });
    const b = h.create({ title: 'write b', workspace: 'web' });
    const child = h.create({ title: 'check both', workspace: 'web', parents: [a.taskId, b.taskId] });
    h.service.addGate(child.taskId, { command: `test -f ${a.taskId}.txt && test -f ${b.taskId}.txt` }, ALICE);
    const implementer = h.driver('implementer');
    // Both at once: the workspace's one-agent limit does not hold tasks with directories of their own.
    const both = together(implementer, 2);
    completes(h, implementer);
    h.dispatcher.pass();
    await both.started;
    const starts = implementer.starts.map((s) => s.cwd);
    expect(new Set(starts).size).toBe(2);
    expect(starts).not.toContain(repo);
    await eventually(() => getTask(h.t.db, child.taskId)?.phase === 'done', 'the child to complete');
    await h.dispatcher.idle();

    const childDir = runDir(runsOf(h.t.db, child.taskId)[0]?.runId ?? '');
    expect(readFileSync(join(childDir, `${a.taskId}.txt`), 'utf8')).toBe('work\n');
    expect(readFileSync(join(childDir, `${b.taskId}.txt`), 'utf8')).toBe('work\n');
    // Its gate passed in its own directory, and its reported commit is its branch's HEAD.
    const [run] = runsOf(h.t.db, child.taskId);
    expect(run).toMatchObject({ outcome: 'completed', reportedCommit: git(repo, 'rev-parse', `mt/${child.taskId}`), reportedDirty: false });
    // Nothing landed on the base branch, and the base checkout is as it was.
    expect(git(repo, 'log', '--format=%s', 'main')).toBe('first');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});
