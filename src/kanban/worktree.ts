import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { IsolatedWorkspace } from '../config.js';
import { getTask, parentsInLinkOrder, runsOf } from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import { registerWorktree, worktreeOf, type TaskDirectory } from '../db/workspaces.js';
import { systemClock, type Clock } from '../time.js';
import type { TaskRow } from './types.js';

/**
 * A task's own directory, in an isolated workspace (spec §18): made before the
 * task's first run, reused by every later one, and never removed by the board.
 *
 * In a git workspace it is a worktree of the workspace's repository, on its own
 * branch, `mt/<task_id>`, under `$MT_HOME/worktrees/<workspace>/<task_id>`:
 * outside the repository, so the base checkout's `git status` never sees it.
 * It starts from its parents' work -- the workspace's base with none, a parent's
 * branch with one, and with several the merge of their branches, made here. It
 * is recorded as soon as `git worktree add` succeeds, so a merge that conflicts
 * leaves a directory a person can be pointed to; the merges go on at each later
 * prepare until the task's first session starts. Nothing is ever merged into the
 * base, pushed or rebased; no branch is deleted, no worktree removed and none
 * pruned. In any other workspace it is an empty folder of its own, and the
 * task's prompt lists its parents' folders.
 *
 * Every git command runs with no hook and no fsmonitor, in the environment an
 * agent gets, in a process group of its own that is killed whole when it runs
 * past its time; and the commands in one repository run one at a time, so two
 * claims never make worktrees in it at once. Git's own locks still guard against
 * everyone else, the agents included.
 */

/** A task's directory, made or found; or why it could not be, for a person to put right. */
export type Prepared = { ok: true; dir: TaskDirectory } | { ok: false; reason: string };

/** What the dispatcher asks before a run in a task's own directory. */
export interface Workdirs {
  /** Never rejects. */
  prepare(task: TaskRow): Promise<Prepared>;
}

/** One git command's end: its exit code, null when it did not exit by itself; what it wrote; and why it could not start. */
export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The error code when git could not start: `ENOENT`, no git. */
  error?: string;
  /** It ran past its time, and its process group was killed. */
  timedOut?: boolean;
}

export type GitRunner = (
  args: readonly string[],
  opts: { cwd: string; env: Readonly<Record<string, string>>; timeoutMs: number },
) => Promise<GitResult>;

export interface TaskDirectoriesDeps {
  db: Db;
  /** `$MT_HOME/worktrees`: in the home, which no workspace may contain (spec §2.3). */
  root: string;
  /** Each configured workspace's real directory, by name. */
  workspaceDirs: ReadonlyMap<string, string>;
  /** The isolated workspaces, each with its base, if it names one. */
  isolated: Readonly<Record<string, IsolatedWorkspace>>;
  /** What git is given: an agent's environment, never the gateway's own. */
  env: Readonly<Record<string, string>>;
  git?: GitRunner;
  /** How long one git command may take; default two minutes, as checking out a large repository is slow. */
  timeoutMs?: number;
  clock?: Clock;
}

const GIT_TIMEOUT_MS = 120_000;
/** At most this much of what git writes is kept, of each stream. */
const OUTPUT_BYTES = 1024 * 1024;
/** At most this many conflicting files are named. */
const FILES_NAMED = 10;
/**
 * How long, once git has exited or been killed, its output may stay open: a
 * process it started that left the group, or outlived the kill, can hold the
 * pipes for as long as it lives, and is not waited for (as `spawnGate` does).
 */
const OUTPUT_GRACE_MS = 500;

/**
 * The settings every command overrides: no hook (`worktree add` runs
 * `post-checkout`, a merge its own), no fsmonitor, no automatic gc or
 * maintenance, which detach processes of their own, and for the fan-in's merges
 * no signing, no signature checks, no remembered resolution and a fast-forward
 * where one will do, whatever the user's global configuration says.
 */
const OVERRIDES = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'commit.gpgSign=false',
  '-c', 'merge.ff=true',
  '-c', 'rerere.enabled=false',
  '-c', 'merge.verifySignatures=false',
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false',
] as const;

/**
 * The real git, in a process group of its own, so a timeout kills what it
 * started too: a filter, a merge driver. Its answer is its exit, not the close of
 * its output: once git has exited, or been killed past its time, what is left
 * of its group is killed, and its output is let go after a short grace, so a
 * process that left the group (`setsid`) and holds git's stderr can hold up
 * neither the answer nor the repository's queue.
 */
export const runGit: GitRunner = (args, opts) =>
  new Promise((done) => {
    const child = spawn('git', [...OVERRIDES, ...args], {
      cwd: opts.cwd,
      env: { ...opts.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let exitCode: number | null = null;
    let settled = false;
    let letGo: NodeJS.Timeout | undefined;
    const group = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
    };
    const finish = (error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(letGo);
      group();
      child.stdout.destroy();
      child.stderr.destroy();
      if (error !== undefined) done({ code: null, stdout, stderr, error });
      else done(timedOut ? { code: null, stdout, stderr, timedOut: true } : { code: exitCode, stdout, stderr });
    };
    const graceThenFinish = (): void => {
      letGo ??= setTimeout(() => finish(), OUTPUT_GRACE_MS);
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < OUTPUT_BYTES) stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-OUTPUT_BYTES);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      group();
      graceThenFinish();
    }, opts.timeoutMs);
    child.once('error', (err: NodeJS.ErrnoException) => finish(err.code ?? err.message));
    child.once('exit', (code) => {
      exitCode = code;
      // It ended in time: what follows is not its own running past the timeout.
      clearTimeout(timer);
      // What git left behind in its group, holding its output open.
      group();
      graceThenFinish();
    });
    child.once('close', () => finish());
  });

/** The branch of a task's worktree. */
export function taskBranch(taskId: string): string {
  return `mt/${taskId}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A branch a task starts from, and whose it is, as a reason names it. */
interface Upstream {
  taskId: string;
  branch: string;
  of: string;
}

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

export class TaskDirectories implements Workdirs {
  readonly #deps: TaskDirectoriesDeps;
  readonly #git: GitRunner;
  readonly #timeoutMs: number;
  readonly #clock: Clock;
  /** The tail of each repository's queue, by its common directory. */
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(deps: TaskDirectoriesDeps) {
    this.#deps = deps;
    this.#git = deps.git ?? runGit;
    this.#timeoutMs = deps.timeoutMs ?? GIT_TIMEOUT_MS;
    this.#clock = deps.clock ?? systemClock;
  }

  async prepare(task: TaskRow): Promise<Prepared> {
    try {
      return await this.#prepare(task);
    } catch (err) {
      // A full disk, a permission: the task waits for a person, the dispatcher goes on.
      return fail(`its directory could not be made: ${message(err)}`);
    }
  }

  async #prepare(task: TaskRow): Promise<Prepared> {
    const { taskId, worktree, workspace } = task;
    if (worktree === null || workspace === null) return fail(`task ${taskId} has no directory of its own`);
    const made = worktreeOf(this.#deps.db, worktree);
    if (made !== undefined) {
      if (!isDirectory(made.rootPath)) return fail(await this.#gone(made));
      if (made.kind === 'plain-dir' || made.branch === null) return { ok: true, dir: made };
      return this.#serial(await this.#commonDir(made.repoRoot), () => this.#again(task, made));
    }
    const base = this.#deps.workspaceDirs.get(workspace);
    if (base === undefined) return fail(`workspace ${workspace} is not configured`);
    // A repository moved away is no folder: git would not even start there, and a folder recorded now would stay one.
    if (!isDirectory(base)) return fail(`workspace ${workspace}'s directory ${base} is not there`);
    const parent = this.#parentFor(workspace);
    if ('problem' in parent) return fail(parent.problem);
    const path = join(parent.dir, taskId);

    // Only the workspace's own directory counts as a repository, never one above it.
    const probe = await this.#run(base, ['rev-parse', '--git-common-dir'], { ceiling: dirname(base) });
    if (probe.code !== 0) {
      // Only git saying there is no repository here, with nothing here that looks like one, is a folder.
      const looks = existsSync(join(base, '.git')) || (existsSync(join(base, 'HEAD')) && existsSync(join(base, 'objects')));
      if (!looks && (probe.error === 'ENOENT' || (probe.code !== null && /not a git repository/i.test(probe.stderr)))) {
        return this.#folder(worktree, base, path);
      }
      if (probe.error === 'ENOENT') return fail(`workspace ${workspace} is a git repository, and git is not installed`);
      return fail(`git cannot read workspace ${workspace}'s repository: ${this.#said(probe)}`);
    }
    const common = realpathSync(resolve(base, probe.stdout.trim()));
    return this.#serial(common, () => this.#worktree(task, worktree, base, common, path));
  }

  /**
   * `<root>/<workspace>`, made `0700` if it is not there, and refused unless a
   * real directory. Each is looked at before anything is made, so a symlinked
   * root never has a directory made in its target, and a dangling one is named
   * as a symlink.
   */
  #parentFor(workspace: string): { dir: string } | { problem: string } {
    const root = this.#deps.root;
    const dir = join(root, workspace);
    const refused = (d: string): string | undefined => {
      const stat = lstatSync(d, { throwIfNoEntry: false });
      if (stat === undefined || (stat.isDirectory() && !stat.isSymbolicLink())) return undefined;
      return `${d} is ${stat.isSymbolicLink() ? 'a symlink' : 'not a directory'}; tasks' directories must be real directories under the gateway's home`;
    };
    for (const d of [root, dir]) {
      const problem = refused(d);
      if (problem !== undefined) return { problem };
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const d of [root, dir]) {
      const problem = refused(d);
      if (problem !== undefined) return { problem };
    }
    return { dir: realpathSync(dir) };
  }

  /** A workspace that is not a repository: an empty folder of the task's own. */
  #folder(id: string, base: string, path: string): Prepared {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (err) {
      // Made before, and not recorded: a stop between the two.
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
        throw err;
      }
    }
    return this.#record({ id, kind: 'plain-dir', rootPath: path, repoRoot: base, branch: null });
  }

  /** A new worktree on the task's branch, from its parents' work; under its repository's queue. */
  async #worktree(task: TaskRow, id: string, base: string, common: string, path: string): Promise<Prepared> {
    const branch = taskBranch(task.taskId);
    const starts = this.#upstream(task);
    const configured = task.workspace === null ? undefined : this.#deps.isolated[task.workspace]?.base;
    const first = starts[0];
    const from = first !== undefined ? `refs/heads/${first.branch}` : configured === undefined ? 'HEAD' : await this.#baseRef(base, configured);
    const start = await this.#run(base, ['rev-parse', '--verify', '--quiet', `${from}^{commit}`]);
    if (start.code !== 0) {
      return fail(
        start.code === null
          ? this.#said(start)
          : first !== undefined
            ? `the branch ${first.branch} of ${first.of} is not there`
            : configured !== undefined
              ? `the base ${configured} of workspace ${task.workspace ?? ''} is not a commit there`
              : `workspace ${task.workspace ?? ''} has no commit to start from`,
      );
    }
    const commit = start.stdout.trim();
    if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) {
      // Not recorded: a git worktree add this gateway started and did not see finish, which is taken up, or one
      // that was stopped, or someone else's.
      const found = await this.#finished(base, common, path, branch, commit);
      if (!found.ok) return found;
      const dir: TaskDirectory = { id, kind: 'git-worktree', rootPath: path, repoRoot: base, branch };
      const recorded = this.#record(dir);
      // Its parents' branches merged in, as at any prepare before its first session: a start that moved on since is a fast-forward.
      return recorded.ok ? this.#merges(dir, starts) : recorded;
    }
    const tip = await this.#run(base, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    let added: GitResult;
    if (tip.code === 0) {
      // A branch of its name with no worktree: one a failed add left, at the very commit it would start from, is
      // taken up; any other may be a person's, and is never taken over.
      if (tip.stdout.trim() !== commit) {
        return fail(`a branch ${branch} is there already, with no worktree of it at ${path}; rename or remove the branch, then unblock the task`);
      }
      added = await this.#run(base, ['worktree', 'add', '--quiet', path, branch]);
    } else {
      added = await this.#run(base, ['worktree', 'add', '--quiet', '--no-track', '-b', branch, path, commit]);
    }
    if (added.code !== 0) {
      const left = lstatSync(path, { throwIfNoEntry: false }) === undefined ? '' : `. It left ${path}. ${await this.#clearAway(base, path)}`;
      return fail(`git worktree add failed: ${this.#said(added)}${left}`);
    }
    const dir: TaskDirectory = { id, kind: 'git-worktree', rootPath: path, repoRoot: base, branch };
    const recorded = this.#record(dir);
    if (!recorded.ok) return recorded;
    return this.#merges(dir, starts);
  }

  /** A recorded worktree, again: still on its branch, and its parents' branches merged until its first session starts. */
  async #again(task: TaskRow, dir: TaskDirectory): Promise<Prepared> {
    const branch = dir.branch ?? taskBranch(task.taskId);
    // The full ref, not --short: a tag of the branch's name makes git shorten it to heads/<branch>.
    const on = await this.#run(dir.rootPath, ['symbolic-ref', '--quiet', 'HEAD']);
    const ref = on.stdout.trim();
    if (on.code !== 0 || ref !== `refs/heads/${branch}`) {
      // Its branch is what its children start from, and what its reported commit names: work on another would be lost to both.
      const now = on.code === 0 ? `branch ${ref.replace(/^refs\/heads\//, '')}` : on.code === null ? this.#said(on) : 'no branch';
      return fail(
        `${dir.rootPath} is on ${now}, not its branch ${branch}: finish or abort what is in progress there (a rebase, a merge), ` +
          `or switch it back to ${branch}; then unblock the task`,
      );
    }
    const started = runsOf(this.#deps.db, task.taskId).some((r) => r.sessionId !== null);
    return started ? { ok: true, dir } : this.#merges(dir, this.#upstream(task));
  }

  /** Each parent's branch not yet in the worktree merged in, one at a time; a conflict left for a person. */
  async #merges(dir: TaskDirectory, starts: readonly Upstream[]): Promise<Prepared> {
    const path = dir.rootPath;
    const merging = await this.#run(path, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
    if (merging.code === 0) {
      return fail(`a merge in ${path} is not finished: resolve its conflicts and commit there, then unblock the task`);
    }
    for (const s of starts) {
      const ref = `refs/heads/${s.branch}`;
      const inside = await this.#run(path, ['merge-base', '--is-ancestor', ref, 'HEAD']);
      if (inside.code === 0) continue;
      if (inside.code !== 1) return fail(`the branch ${s.branch} of ${s.of} cannot be read: ${this.#said(inside)}`);
      const merged = await this.#run(path, [
        'merge', '--quiet', '--no-stat', '--no-edit', '--ff', '--no-gpg-sign', '--no-verify-signatures',
        '-m', `Merge ${s.branch} into ${dir.branch ?? ''}`, ref,
      ]);
      if (merged.code === 0) continue;
      const conflicted = await this.#run(path, ['diff', '--name-only', '--diff-filter=U']);
      const files = conflicted.stdout.split('\n').filter((f) => f !== '');
      if (files.length === 0) return fail(`merging the branch ${s.branch} of ${s.of} failed: ${this.#said(merged)}`);
      const more = files.length > FILES_NAMED ? ` and ${files.length - FILES_NAMED} more` : '';
      return fail(
        `merging the branch ${s.branch} of ${s.of} conflicts in ${files.slice(0, FILES_NAMED).join(', ')}${more}. ` +
          `Resolve it in ${path}: fix those files and commit there, then unblock the task`,
      );
    }
    return { ok: true, dir };
  }

  /**
   * The branches a git task starts from: its parents that are done, or, with
   * none, the task that created it, as §2.3 uses it in place of parents, done or
   * not (a follow-up is claimable at once, usually while its creator still
   * runs), so long as it is not archived; of those, the ones with a worktree in
   * the same workspace, in the order they were linked. An archived task's work
   * was abandoned, and is not merged.
   */
  #upstream(task: TaskRow): Upstream[] {
    const db = this.#deps.db;
    const parents = parentsInLinkOrder(db, task.taskId);
    const from = parents.length === 0 && task.createdFromTask !== null ? getTask(db, task.createdFromTask) : undefined;
    const upstream = parents.length > 0 ? parents : from === undefined ? [] : [from];
    const counts = (p: TaskRow): boolean => (p === from ? p.phase !== 'archived' : p.phase === 'done');
    return upstream.flatMap((p) => {
      if (!counts(p) || p.worktree === null || p.workspace !== task.workspace) return [];
      const dir = worktreeOf(db, p.worktree);
      return dir?.kind === 'git-worktree' && dir.branch !== null
        ? [{ taskId: p.taskId, branch: dir.branch, of: p === from ? `the task ${p.taskId} that created it` : `its parent ${p.taskId}` }]
        : [];
    });
  }

  /**
   * Whether an unrecorded path is the worktree this prepare would have made, a
   * git worktree add the gateway did not see finish (it was restarted, or
   * stopped, meanwhile), and why not when it is not. It is taken up only as a
   * real directory that git lists on the task's branch, neither prunable nor
   * locked (as a stopped add leaves it); that is itself the top of a working
   * tree of the workspace's repository, not a clone or a directory inside
   * another repository; with nothing in it a fresh add would not have made, not
   * even an ignored file; and at the very commit it starts from, or one that
   * start has since moved on from, which its parents' merges then bring it to.
   * Anything else may be a person's.
   */
  async #finished(base: string, common: string, path: string, branch: string, commit: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    // On its branch at another commit, the branch would be refused next, as a branch in the way: the advice clears both.
    let drop: string | undefined;
    const someone = async (): Promise<{ ok: false; reason: string }> =>
      fail(
        `${path} is there already, left by a git worktree add that did not finish, or put there by someone else. ${await this.#clearAway(base, path, drop)}`,
      );
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) return someone();
    const lines = await this.#listed(base, path);
    if (lines === undefined) return someone();
    if (lines.includes('locked initializing')) {
      // What git worktree add leaves while it runs, and when it was killed.
      return fail(
        `${path} is there already, and git may still be adding it as a worktree: wait a little, then unblock the task. ` +
          `If it is refused again, the add was stopped: ${await this.#clearAway(base, path)}`,
      );
    }
    if (lines.some((l) => l === 'locked' || l.startsWith('locked '))) return someone();
    // Its .git gone: git in it would find whatever repository is above it.
    if (lines.some((l) => l === 'prunable' || l.startsWith('prunable '))) return someone();
    if (!lines.includes(`branch refs/heads/${branch}`)) return someone();
    if (!lines.includes(`HEAD ${commit}`)) drop = branch;
    const top = await this.#run(path, ['rev-parse', '--show-toplevel', '--git-common-dir']);
    const [toplevel, commonDir] = top.stdout.split('\n');
    if (top.code !== 0 || toplevel === undefined || commonDir === undefined) return someone();
    if (real(toplevel) !== real(path) || real(resolve(path, commonDir)) !== common) return someone();
    // Every untracked and ignored file, whatever the configuration hides; and the index never written.
    const status = await this.#run(path, [
      '--no-optional-locks', 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none', '--ignored',
    ]);
    if (status.code !== 0 || status.stdout.trim() !== '') return someone();
    if (lines.includes(`HEAD ${commit}`)) return { ok: true };
    const head = lines.find((l) => l.startsWith('HEAD '))?.slice('HEAD '.length);
    if (head === undefined || !/^[0-9a-f]+$/.test(head)) return someone();
    // Its start moved on since the add began (a parent committed again): the merges bring it there, a fast-forward.
    const behind = await this.#run(base, ['merge-base', '--is-ancestor', head, commit]);
    if (behind.code === 0) return { ok: true };
    if (behind.code !== 1) return someone();
    return fail(
      `${path} is there already, a worktree of ${branch} the board did not record: it is at ${head.slice(0, 12)}; ` +
        `the task now starts from ${commit.slice(0, 12)}, which does not contain it. ${await this.#clearAway(base, path, branch)}`,
    );
  }

  /** A workspace's configured base: its branch of that name when there is one, as a tag of the same name would otherwise win; else as given. */
  async #baseRef(repo: string, configured: string): Promise<string> {
    const branch = `refs/heads/${configured}`;
    const r = await this.#run(repo, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`]);
    return r.code === 0 ? branch : configured;
  }

  /**
   * What a person runs to clear a half-made or unrecorded worktree out of a
   * task's way. A path git lists is a registered worktree, which moving aside
   * would leave registered, so git is used to remove it, and with it the branch
   * named, which would otherwise be refused next as a branch in the way; any
   * other is moved aside, a symlink too, whatever it points to.
   */
  async #clearAway(base: string, path: string, branch?: string): Promise<string> {
    const link = lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;
    if (link || (await this.#listed(base, path)) === undefined) return `If it holds nothing you need, move it aside; then unblock the task`;
    const drop = branch === undefined ? '' : `, then git branch -D ${branch}`;
    return (
      `In ${base}, move out anything you need, then run git worktree unlock ${path} if it is locked, ` +
      `and git worktree remove --force ${path}${drop}; then unblock the task`
    );
  }

  /**
   * A recorded directory that is gone, and how to make it again from its
   * branch: a path git still lists (removed with `rm -rf`) is one git refuses to
   * add again without `-f`.
   */
  async #gone(dir: TaskDirectory): Promise<string> {
    if (dir.kind !== 'git-worktree' || dir.branch === null) {
      return `its directory ${dir.rootPath} is gone; make the folder again, then unblock the task`;
    }
    const force = (await this.#listed(dir.repoRoot, dir.rootPath)) === undefined ? '' : '-f ';
    return (
      `its directory ${dir.rootPath} is gone; make it again from its branch with git worktree add ${force}${dir.rootPath} ${dir.branch}, ` +
      `in ${dir.repoRoot}, then unblock the task`
    );
  }

  /** What `git worktree list --porcelain` says of a path, if it lists it: its lines, `HEAD`, `branch`, `locked` and the rest. */
  async #listed(base: string, path: string): Promise<string[] | undefined> {
    const listed = await this.#run(base, ['worktree', 'list', '--porcelain']);
    if (listed.code !== 0) return undefined;
    const mine = real(path);
    return listed.stdout
      .split('\n\n')
      .map((entry) => entry.split('\n').filter((l) => l !== ''))
      .find((lines) => lines[0]?.startsWith('worktree ') === true && real(lines[0].slice('worktree '.length)) === mine);
  }

  #record(dir: TaskDirectory): Prepared {
    const r = registerWorktree(this.#deps.db, dir, this.#clock.now());
    return 'error' in r ? fail(r.error) : { ok: true, dir };
  }

  /** A repository's common directory: what its worktrees share, and its queue's key. */
  async #commonDir(repo: string): Promise<string> {
    const r = await this.#run(repo, ['rev-parse', '--git-common-dir']);
    return r.code === 0 ? realpathSync(resolve(repo, r.stdout.trim())) : repo;
  }

  /** `fn` after every earlier one in the same repository has finished. */
  async #serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const before = this.#queues.get(key) ?? Promise.resolve();
    const mine = before.then(fn, fn);
    const tail = mine.catch(() => undefined);
    this.#queues.set(key, tail);
    try {
      return await mine;
    } finally {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    }
  }

  #run(cwd: string, args: readonly string[], opts: { ceiling?: string } = {}): Promise<GitResult> {
    return this.#git(args, {
      cwd,
      env: opts.ceiling === undefined ? this.#deps.env : { ...this.#deps.env, GIT_CEILING_DIRECTORIES: opts.ceiling },
      timeoutMs: this.#timeoutMs,
    });
  }

  /** The last lines git wrote, or that it did not finish in time, for a reason a person reads. */
  #said(r: GitResult): string {
    if (r.timedOut === true) return `git did not finish in ${Math.round(this.#timeoutMs / 1000)} s, and was stopped`;
    const text = `${r.stderr}\n${r.stdout}`.trim();
    return text === '' ? 'git said nothing' : text.split('\n').slice(-3).join(' ').trim();
  }
}

/** A path as it really is, or as given when it is not there. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
