import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archive, claim, closeRun, complete, link } from '../src/db/kanban.js';
import { getTask } from '../src/db/kanban-read.js';
import { worktreeOf } from '../src/db/workspaces.js';
import { runGit, TaskDirectories } from '../src/kanban/worktree.js';
import type { TaskRow } from '../src/kanban/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { claimantFor, NOW, newTask } from './helpers/kanban.js';

/**
 * A task's own directory against real git (spec §18): a worktree on its own
 * branch, from its parents' work, with a fan-in's merge made, a conflict left for
 * a person and taken up again once resolved; a folder for a workspace that is no
 * repository; and every refusal leaving the repository as it was.
 */

let dir: string;
let t: TestDb;
/** git's environment: a made-up home, so no test reads the real one's configuration. */
let env: Record<string, string>;
let repo: string;
let root: string;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(cwd: string, file: string, text: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', `write ${file}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

function directories(workspaces: Record<string, string> = { web: repo }, isolated: Record<string, { base?: string }> = { web: {} }) {
  return new TaskDirectories({ db: t.db, root, workspaceDirs: new Map(Object.entries(workspaces)), isolated, env });
}

/** A task claimed in an isolated workspace, so it has a directory of its own to make. */
function claimed(workspace = 'web', extra: Parameters<typeof newTask>[1] = {}): TaskRow {
  const task = newTask(t.db, { workspace, ...extra });
  const r = claim(
    t.db,
    { taskId: task.taskId, claimant: claimantFor(t.db, task.taskId), workspaces: new Set([workspace]), isolated: new Set([workspace]) },
    NOW,
  );
  if (!r.ok) throw new Error(r.message);
  return r.task;
}

/** Finish a task's run as done, so its children can be claimed. */
function finish(task: TaskRow): void {
  const run = claimantRun(task);
  const r = complete(t.db, task.taskId, { kind: 'run', runId: run }, { summary: 'done' }, NOW);
  if (!r.ok) throw new Error(r.message);
  closeRun(t.db, run, NOW);
}

function claimantRun(task: TaskRow): string {
  const row = t.db.prepare<[string], { run_id: string }>('SELECT run_id FROM kanban_runs WHERE task_id = ? AND ended_at IS NULL').get(task.taskId);
  if (row === undefined) throw new Error(`task ${task.taskId} has no open run`);
  return row.run_id;
}

async function made(d: TaskDirectories, task: TaskRow): Promise<string> {
  const r = await d.prepare(getTask(t.db, task.taskId) ?? task);
  if (!r.ok) throw new Error(r.reason);
  return r.dir.rootPath;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-worktree-')));
  env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1' };
  repo = join(dir, 'web');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@example.com');
  commit(repo, 'README', 'hello\n');
  root = join(dir, 'home', 'worktrees');
  mkdirSync(join(dir, 'home'));
  t = testDb();
});

afterEach(() => {
  t.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a task with no parents', () => {
  it("starts from what the workspace has checked out, on its own branch, outside the repository, and leaves the base checkout's changes behind", async () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'README'), 'changed, not committed\n');
    const task = claimed();
    const d = directories();
    const path = await made(d, task);
    expect(path).toBe(join(realpathSync(root), 'web', task.taskId));
    expect(git(path, 'symbolic-ref', '--short', 'HEAD')).toBe(`mt/${task.taskId}`);
    expect(git(path, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(path, 'README'), 'utf8')).toBe('hello\n');
    expect(worktreeOf(t.db, `wt:${task.taskId}`)).toEqual({
      id: `wt:${task.taskId}`,
      kind: 'git-worktree',
      rootPath: path,
      repoRoot: repo,
      branch: `mt/${task.taskId}`,
    });
    // The base checkout is as it was, and its own status does not see the worktree.
    expect(git(repo, 'status', '--porcelain')).toBe('M README');
    expect((statSync(join(root, 'web')).mode & 0o777).toString(8)).toBe('700');
    // Every later run uses the same directory.
    expect(await made(d, task)).toBe(path);
  });

  it("starts from the workspace's configured base instead", async () => {
    git(repo, 'checkout', '-q', '-b', 'release');
    const release = commit(repo, 'CHANGES', 'one\n');
    git(repo, 'checkout', '-q', 'main');
    const task = claimed();
    const path = await made(directories({ web: repo }, { web: { base: 'release' } }), task);
    expect(git(path, 'rev-parse', 'HEAD')).toBe(release);
    const missing = claimed();
    expect(await directories({ web: repo }, { web: { base: 'nowhere' } }).prepare(missing)).toEqual({
      ok: false,
      reason: 'the base nowhere of workspace web is not a commit there',
    });
  });

  it('runs no hook of the repository', async () => {
    const marker = join(dir, 'hook-ran');
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    await made(directories(), claimed());
    expect(existsSync(marker)).toBe(false);
  });

  it('is made from a bare repository too', async () => {
    const bare = join(dir, 'bare.git');
    git(dir, 'clone', '-q', '--bare', repo, bare);
    const path = await made(directories({ web: bare }), claimed());
    expect(readFileSync(join(path, 'README'), 'utf8')).toBe('hello\n');
  });
});

describe('a task with parents', () => {
  it("starts from its one parent's branch", async () => {
    const d = directories();
    const parent = claimed();
    const parentDir = await made(d, parent);
    const work = commit(parentDir, 'a.txt', 'from the parent\n');
    finish(parent);
    const child = newTask(t.db, { workspace: 'web', parents: [parent.taskId] });
    const r = claim(t.db, { taskId: child.taskId, claimant: claimantFor(t.db, child.taskId), workspaces: new Set(['web']), isolated: new Set(['web']) }, NOW);
    if (!r.ok) throw new Error(r.message);
    const childDir = await made(d, r.task);
    expect(git(childDir, 'rev-parse', 'HEAD')).toBe(work);
  });

  it("merges several parents' branches, and leaves a conflict for a person, taking it up again once resolved", async () => {
    const d = directories();
    const [a, b, c] = [claimed(), claimed(), claimed()];
    commit(await made(d, a), 'a.txt', 'from a\n');
    commit(await made(d, b), 'README', 'from b\n');
    commit(await made(d, c), 'README', 'from c\n');
    for (const p of [a, b, c]) finish(p);
    const child = newTask(t.db, { workspace: 'web' });
    for (const p of [a, b, c]) link(t.db, p.taskId, child.taskId, 'lark:on_alice', NOW);
    const r = claim(t.db, { taskId: child.taskId, claimant: claimantFor(t.db, child.taskId), workspaces: new Set(['web']), isolated: new Set(['web']) }, NOW);
    if (!r.ok) throw new Error(r.message);
    const path = join(realpathSync(root), 'web', child.taskId);

    const conflicted = await d.prepare(r.task);
    expect(conflicted).toEqual({
      ok: false,
      reason:
        `merging the branch mt/${c.taskId} of its parent ${c.taskId} conflicts in README. ` +
        `Resolve it in ${path}: fix those files and commit there, then unblock the task`,
    });
    // Recorded already, so show and mt kanban task worktree can point the person at it.
    expect(worktreeOf(t.db, `wt:${child.taskId}`)?.rootPath).toBe(path);
    // Taken up again before it is resolved: still waiting for the person.
    expect(await d.prepare(r.task)).toEqual({
      ok: false,
      reason: `a merge in ${path} is not finished: resolve its conflicts and commit there, then unblock the task`,
    });
    // The person resolves it.
    writeFileSync(join(path, 'README'), 'from b and c\n');
    git(path, 'add', 'README');
    git(path, 'commit', '-q', '--no-edit');
    expect(await made(d, r.task)).toBe(path);
    expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('from a\n');
    for (const p of [a, b, c]) expect(spawnSync('git', ['merge-base', '--is-ancestor', `mt/${p.taskId}`, 'HEAD'], { cwd: path, env }).status).toBe(0);
    // The base branch was never touched.
    expect(git(repo, 'log', '--format=%s', 'main')).toBe('write README');
  });

  it("refuses a parent's branch that is gone", async () => {
    const d = directories();
    const parent = claimed();
    const parentDir = await made(d, parent);
    finish(parent);
    git(repo, 'worktree', 'remove', parentDir);
    git(repo, 'branch', '-D', `mt/${parent.taskId}`);
    const child = newTask(t.db, { workspace: 'web', parents: [parent.taskId] });
    const r = claim(t.db, { taskId: child.taskId, claimant: claimantFor(t.db, child.taskId), workspaces: new Set(['web']), isolated: new Set(['web']) }, NOW);
    if (!r.ok) throw new Error(r.message);
    expect(await d.prepare(r.task)).toEqual({ ok: false, reason: `the branch mt/${parent.taskId} of its parent ${parent.taskId} is not there` });
  });
});

describe('what it refuses, changing nothing', () => {
  it('a branch of its name that is there already, at another commit than it would start from', async () => {
    const task = claimed();
    git(repo, 'branch', `mt/${task.taskId}`);
    commit(repo, 'later.txt', 'later\n');
    const before = git(repo, 'rev-parse', `mt/${task.taskId}`);
    const r = await directories().prepare(task);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining(`a branch mt/${task.taskId} is there already`) });
    expect(git(repo, 'rev-parse', `mt/${task.taskId}`)).toBe(before);
    expect(existsSync(join(root, 'web', task.taskId))).toBe(false);
  });

  it('a directory that is gone once made, keeping its branch', async () => {
    const d = directories();
    const task = claimed();
    const path = await made(d, task);
    rmSync(path, { recursive: true, force: true });
    const r = await d.prepare(task);
    expect(r).toEqual({
      ok: false,
      reason: `its directory ${path} is gone; make it again from its branch with git worktree add ${path} mt/${task.taskId}, in ${repo}, then unblock the task`,
    });
    expect(git(repo, 'branch', '--list', `mt/${task.taskId}`)).toContain(`mt/${task.taskId}`);
  });

  it('a symlinked directory for the worktrees', async () => {
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, root);
    const r = await directories().prepare(claimed());
    expect(r).toEqual({ ok: false, reason: `${root} is a symlink; tasks' directories must be real directories under the gateway's home` });
  });
});

describe('what it takes care over', () => {
  /** A child of these parents, linked in this order, claimed. */
  function childOf(parents: readonly TaskRow[]): TaskRow {
    const child = newTask(t.db, { workspace: 'web' });
    for (const p of parents) link(t.db, p.taskId, child.taskId, 'lark:on_alice', NOW);
    const r = claim(t.db, { taskId: child.taskId, claimant: claimantFor(t.db, child.taskId), workspaces: new Set(['web']), isolated: new Set(['web']) }, NOW);
    if (!r.ok) throw new Error(r.message);
    return r.task;
  }

  it('starts a fan-in from the parent linked first, not the one made first', async () => {
    const d = directories();
    const [a, b] = [claimed(), claimed()];
    commit(await made(d, a), 'a.txt', 'a\n');
    const tipB = commit(await made(d, b), 'b.txt', 'b\n');
    for (const p of [a, b]) finish(p);
    const child = childOf([b, a]);
    const path = await made(d, child);
    expect(git(path, 'rev-parse', 'HEAD^1')).toBe(tipB);
    expect(git(path, 'log', '-1', '--format=%s')).toBe(`Merge mt/${a.taskId} into mt/${child.taskId}`);
    expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('a\n');
  });

  it("merges no archived parent's work, which was abandoned", async () => {
    const d = directories();
    const [kept, dropped] = [claimed(), claimed()];
    commit(await made(d, kept), 'kept.txt', 'kept\n');
    commit(await made(d, dropped), 'dropped.txt', 'dropped\n');
    finish(kept);
    archive(t.db, dropped.taskId, 'lark:on_alice', NOW);
    const path = await made(d, childOf([kept, dropped]));
    expect(existsSync(join(path, 'kept.txt'))).toBe(true);
    expect(existsSync(join(path, 'dropped.txt'))).toBe(false);
  });

  it("takes a parent's branch, never a tag of the same name", async () => {
    const d = directories();
    const parent = claimed();
    const work = commit(await made(d, parent), 'a.txt', 'a\n');
    finish(parent);
    git(repo, 'tag', `mt/${parent.taskId}`, 'main');
    const path = await made(d, childOf([parent]));
    expect(git(path, 'rev-parse', 'HEAD')).toBe(work);
  });

  it('takes up the branch a failed git worktree add left, at the commit it would start from', async () => {
    writeFileSync(join(repo, '.gitattributes'), '* filter=broken\n');
    git(repo, 'add', '.gitattributes');
    git(repo, 'commit', '-q', '-m', 'attributes');
    git(repo, 'config', 'filter.broken.smudge', 'false');
    git(repo, 'config', 'filter.broken.required', 'true');
    const d = directories();
    const task = claimed();
    expect(await d.prepare(task)).toMatchObject({ ok: false, reason: expect.stringContaining('git worktree add failed') });
    expect(git(repo, 'branch', '--list', `mt/${task.taskId}`)).toContain(`mt/${task.taskId}`);
    git(repo, 'config', '--unset', 'filter.broken.required');
    git(repo, 'config', '--unset', 'filter.broken.smudge');
    const path = await made(d, task);
    expect(git(path, 'symbolic-ref', '--short', 'HEAD')).toBe(`mt/${task.taskId}`);
  });

  it('stops a git command past its time, with what it started, and names what it left for a person', async () => {
    writeFileSync(join(repo, '.gitattributes'), '* filter=slow\n');
    git(repo, 'add', '.gitattributes');
    git(repo, 'commit', '-q', '-m', 'attributes');
    const marker = join(dir, 'filter-finished');
    git(repo, 'config', 'filter.slow.smudge', `sleep 3; touch '${marker}'; cat`);
    const task = claimed();
    const quick = new TaskDirectories({ db: t.db, root, workspaceDirs: new Map([['web', repo]]), isolated: { web: {} }, env, timeoutMs: 500 });
    const began = Date.now();
    const first = await quick.prepare(task);
    expect(first).toMatchObject({ ok: false, reason: expect.stringContaining('git did not finish in 1 s, and was stopped') });
    // What to do is in the first reason already, so the person need not unblock twice to learn it.
    expect(first).toMatchObject({ reason: expect.stringContaining(`git worktree remove --force ${join(realpathSync(root), 'web', task.taskId)}`) });
    expect(Date.now() - began).toBeLessThan(2500);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    // The filter was in its process group, and was killed with it.
    expect(existsSync(marker)).toBe(false);
    git(repo, 'config', '--unset', 'filter.slow.smudge');
    const path = join(realpathSync(root), 'web', task.taskId);
    expect(await quick.prepare(task)).toMatchObject({ ok: false, reason: expect.stringContaining(`${path} is there already, left by a git worktree add that did not finish`) });
    // The person does as the reason says.
    git(repo, 'worktree', 'unlock', path);
    git(repo, 'worktree', 'remove', '--force', path);
    expect(await made(quick, task)).toBe(path);
  });

  it('blocks a recorded worktree that is no longer on its branch', async () => {
    const d = directories();
    const task = claimed();
    const path = await made(d, task);
    git(path, 'checkout', '-q', '-b', 'elsewhere');
    expect(await d.prepare(task)).toEqual({
      ok: false,
      reason:
        `${path} is on branch elsewhere, not its branch mt/${task.taskId}: finish or abort what is in progress there ` +
        `(a rebase, a merge), or switch it back to mt/${task.taskId}; then unblock the task`,
    });
  });

  it('blocks a git workspace whose directory is gone, and records nothing, so it is a worktree once the repository is back', async () => {
    const away = join(dir, 'away');
    renameSync(repo, away);
    const task = claimed();
    expect(await directories().prepare(task)).toEqual({ ok: false, reason: `workspace web's directory ${repo} is not there` });
    expect(worktreeOf(t.db, `wt:${task.taskId}`)).toBeUndefined();
    renameSync(away, repo);
    const path = await made(directories(), task);
    expect(worktreeOf(t.db, `wt:${task.taskId}`)).toMatchObject({ kind: 'git-worktree', rootPath: path });
  });

  it('blocks a repository git refuses to read, rather than give its task an empty folder', async () => {
    git(repo, 'config', 'core.repositoryformatversion', '99');
    const task = claimed();
    expect(await directories().prepare(task)).toMatchObject({ ok: false, reason: expect.stringContaining("git cannot read workspace web's repository") });
    expect(existsSync(join(root, 'web', task.taskId))).toBe(false);
    // A .git file pointing nowhere is no repository git can read either.
    const broken = join(dir, 'broken');
    mkdirSync(broken);
    writeFileSync(join(broken, '.git'), 'gitdir: /nowhere/at/all\n');
    const other = claimed('broken');
    expect(await directories({ broken }, { broken: {} }).prepare(other)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("git cannot read workspace broken's repository"),
    });
  });
});

describe('git that leaves something behind', () => {
  /** A git alias that runs `sh` as the command: what a filter or a merge driver could leave running. */
  const alias = (script: string) => ['-c', `alias.leave=!${script}`, 'leave'];
  const setsid = (seconds: number) => `perl -MPOSIX -e 'if (fork() == 0) { POSIX::setsid(); sleep ${seconds}; exit 0 }'`;

  it('answers when git exits, though a child it left in its group holds its output', async () => {
    const began = Date.now();
    const r = await runGit(alias('(sleep 5 >&2 &); exit 3'), { cwd: repo, env, timeoutMs: 10_000 });
    expect(r).toMatchObject({ code: 3 });
    expect(Date.now() - began).toBeLessThan(2000);
  });

  it('answers when git exits, though a child that left its group holds its output', async () => {
    const began = Date.now();
    const r = await runGit(alias(`${setsid(5)}; exit 4`), { cwd: repo, env, timeoutMs: 10_000 });
    expect(r).toMatchObject({ code: 4 });
    expect(Date.now() - began).toBeLessThan(2000);
  });

  it('answers past its time, though a child that left its group holds its output', async () => {
    const began = Date.now();
    const r = await runGit(alias(`${setsid(5)}; sleep 5`), { cwd: repo, env, timeoutMs: 300 });
    expect(r).toMatchObject({ code: null, timedOut: true });
    expect(Date.now() - began).toBeLessThan(1500);
  });

  it('records a worktree whose filter left a child holding its output', async () => {
    writeFileSync(join(repo, '.gitattributes'), '* filter=lingers\n');
    git(repo, 'add', '.gitattributes');
    git(repo, 'commit', '-q', '-m', 'attributes');
    git(repo, 'config', 'filter.lingers.smudge', '(sleep 5 >&2 &); cat');
    const task = claimed();
    const began = Date.now();
    const path = await made(directories(), task);
    expect(Date.now() - began).toBeLessThan(4000);
    expect(worktreeOf(t.db, `wt:${task.taskId}`)?.rootPath).toBe(path);
  });
});

describe('in one repository at once', () => {
  it('makes each claim its worktree in turn', async () => {
    const d = directories();
    const tasks = [claimed(), claimed(), claimed(), claimed()];
    const all = await Promise.all(tasks.map((task) => d.prepare(task)));
    expect(all.every((r) => r.ok)).toBe(true);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(5);
  });
});

describe('a workspace that is not a repository', () => {
  it('gives each task an empty folder of its own, even inside a repository above it', async () => {
    const notes = join(repo, 'notes');
    mkdirSync(notes);
    const task = claimed('notes');
    const path = await made(directories({ notes }, { notes: {} }), task);
    expect(path).toBe(join(realpathSync(root), 'notes', task.taskId));
    expect(statSync(path).isDirectory()).toBe(true);
    expect((statSync(path).mode & 0o777).toString(8)).toBe('700');
    expect(worktreeOf(t.db, `wt:${task.taskId}`)).toMatchObject({ kind: 'plain-dir', branch: null, repoRoot: notes });
  });
});
