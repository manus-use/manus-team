import { execFile } from 'node:child_process';

/**
 * The reported commit (spec §7.8): when an agent reports `complete` or `review`,
 * the gateway reads, in the run's workspace, `HEAD` and whether the working tree
 * has uncommitted changes, before the transaction that decides the run, so they
 * describe the state the report was made in. They are facts the gateway
 * observes, not the agent's word: its summary can say what it changed, not
 * reliably which state it left.
 *
 * A workspace that is not a git repository, or where git is not installed,
 * records nothing: a task need not be code, and nothing is known of its state.
 * A repository with no commit yet, or where git fails, has no commit, and
 * counts as uncommitted.
 */

/**
 * What a report recorded of its workspace: `HEAD`, or null when there is none;
 * and uncommitted changes, or null when the workspace is not a git repository.
 */
export interface ReportedState {
  commit: string | null;
  dirty: boolean | null;
}

export interface GitOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Runs one git command: its exit code, null when it did not exit by itself, its
 * stdout, and the error code when it could not start (`ENOENT`: no git). Never rejects.
 */
export type GitExec = (
  args: readonly string[],
  opts: GitOptions,
) => Promise<{ code: number | null; stdout: string; error?: string }>;

/** Reads a workspace's state. Never rejects. */
export type CommitReader = (
  cwd: string,
  opts: { env: Readonly<Record<string, string>>; signal?: AbortSignal },
) => Promise<ReportedState>;

/** How long one git command may take: a report waits for it. */
const GIT_TIMEOUT_MS = 10_000;
/** A whole commit id, SHA-1 or SHA-256. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The real `git`, asynchronously: a report must not hold up the gateway. */
export const execGit: GitExec = (args, opts) =>
  new Promise((resolve) => {
    execFile(
      'git',
      // A workspace's own configuration must not run a program: no fsmonitor hook.
      ['-c', 'core.fsmonitor=false', ...args],
      {
        cwd: opts.cwd,
        env: { ...opts.env },
        timeout: opts.timeoutMs,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      },
      (err, stdout) => {
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : null;
        const out = typeof stdout === 'string' ? stdout : '';
        resolve(err !== null && typeof err.code === 'string' ? { code, stdout: out, error: err.code } : { code, stdout: out });
      },
    );
  });

/**
 * A reader over `exec`: `git rev-parse --git-dir`, whether the workspace is a
 * repository at all; `git rev-parse` for HEAD; then `git status --porcelain`.
 * None takes a lock (`--no-optional-locks`), so reading never gets in the way
 * of the agent's own git. Not a repository -- `--git-dir` exits non-zero -- or
 * git missing records nothing. In a repository, no HEAD -- no commit yet, git
 * failing -- is no commit, and uncommitted; a status that fails, or a
 * `--git-dir` that times out, counts as uncommitted too: nobody can say the
 * tree is clean.
 */
export function commitReader(exec: GitExec = execGit): CommitReader {
  return async (cwd, opts) => {
    const git = (args: readonly string[]) =>
      exec(args, {
        cwd,
        env: opts.env,
        timeoutMs: GIT_TIMEOUT_MS,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
    const repo = await git(['--no-optional-locks', 'rev-parse', '--git-dir']);
    if (repo.error === 'ENOENT' || (repo.code !== null && repo.code !== 0)) return { commit: null, dirty: null };
    if (repo.code !== 0) return { commit: null, dirty: true };
    const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    const commit = head.stdout.trim();
    if (head.code !== 0 || !COMMIT_ID.test(commit)) return { commit: null, dirty: true };
    const status = await git(['--no-optional-locks', 'status', '--porcelain']);
    return { commit, dirty: status.code !== 0 || status.stdout.trim() !== '' };
  };
}

/**
 * What a reviewer is told to review (spec §7.8), from what the report recorded;
 * undefined when nothing was: a person's report, or a run from before plan C4.
 */
export function describeReported(state: { reportedCommit: string | null; reportedDirty: boolean | null }): string | undefined {
  const { reportedCommit: commit, reportedDirty: dirty } = state;
  if (commit === null) return dirty === true ? 'uncommitted; no commit to review' : undefined;
  return dirty === true ? `uncommitted changes on top of ${commit}` : `review commit ${commit}`;
}
