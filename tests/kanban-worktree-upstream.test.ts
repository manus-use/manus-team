import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archive, claim } from '../src/db/kanban.js';
import { getTask } from '../src/db/kanban-read.js';
import { registerWorktree } from '../src/db/workspaces.js';
import type { TaskRow } from '../src/kanban/types.js';
import { TaskDirectories, type GitResult, type GitRunner } from '../src/kanban/worktree.js';
import { testDb, type TestDb } from './helpers/db.js';
import { claimantFor, NOW, newTask } from './helpers/kanban.js';

/**
 * Where a follow-up with no parents starts (spec §18.5): from the branch of the
 * task that created it, done or not, as committed when its worktree is made,
 * with its creator's later commits merged in until its first session starts;
 * never from an archived creator's. Against a stand-in for git that answers
 * what the board asks and records it.
 */

let dir: string;
let t: TestDb;
let base: string;
let root: string;
let asked: string[][];
/** The commits each ref names, as git would answer `rev-parse`; absent is no such ref. */
let refs: Map<string, string>;
/** The refs `merge-base --is-ancestor <ref> HEAD` says are in the worktree already. */
let inside: Set<string>;

const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });
const no = (): GitResult => ({ code: 1, stdout: '', stderr: '' });

const git: GitRunner = async (args, opts) => {
  asked.push([...args]);
  const [verb, ...rest] = args;
  if (verb === 'rev-parse' && rest[0] === '--git-common-dir') return ok('.git');
  if (verb === 'rev-parse' && rest[0] === '--verify') {
    const ref = (rest.at(-1) ?? '').replace(/\^\{commit\}$/, '');
    const commit = refs.get(ref);
    return commit === undefined ? no() : ok(commit);
  }
  if (verb === 'worktree' && rest[0] === 'add') {
    mkdirSync(rest.find((a) => a.startsWith(root)) ?? '', { recursive: true });
    return ok();
  }
  if (verb === 'worktree' && rest[0] === 'list') return ok('');
  if (verb === 'symbolic-ref') return ok(`refs/heads/mt/${opts.cwd.split('/').at(-1) ?? ''}`);
  if (verb === 'merge-base') return inside.has(rest[1] ?? '') ? ok() : no();
  if (verb === 'merge') return ok();
  throw new Error(`unexpected git ${args.join(' ')}`);
};

function directories(): TaskDirectories {
  return new TaskDirectories({ db: t.db, root, workspaceDirs: new Map([['web', base]]), isolated: { web: {} }, env: {}, git });
}

function claimIn(task: TaskRow): { task: TaskRow; runId: string } {
  const r = claim(
    t.db,
    { taskId: task.taskId, claimant: claimantFor(t.db, task.taskId), workspaces: new Set(['web']), isolated: new Set(['web']) },
    NOW,
  );
  if (!r.ok) throw new Error(r.message);
  return { task: r.task, runId: r.run.runId };
}

/** A creator still open, with its worktree made, and a follow-up its run created, claimed at once. */
function followUp(): { creator: TaskRow; follow: TaskRow } {
  const creator = claimIn(newTask(t.db, { workspace: 'web' }));
  registerWorktree(
    t.db,
    { id: `wt:${creator.task.taskId}`, kind: 'git-worktree', rootPath: join(root, 'web', creator.task.taskId), repoRoot: base, branch: `mt/${creator.task.taskId}` },
    NOW,
  );
  const follow = claimIn(newTask(t.db, { createdVia: { kind: 'run', runId: creator.runId } }));
  return { creator: creator.task, follow: follow.task };
}

const adds = (): string[][] => asked.filter((a) => a[0] === 'worktree' && a[1] === 'add');

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-upstream-')));
  base = join(dir, 'web');
  mkdirSync(join(base, '.git'), { recursive: true });
  root = join(dir, 'worktrees');
  asked = [];
  refs = new Map([['HEAD', 'b'.repeat(40)]]);
  inside = new Set();
  t = testDb();
});

afterEach(() => {
  t.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a follow-up with no parents', () => {
  it('starts from the branch of the task that created it, while that task is still open', async () => {
    const { creator, follow } = followUp();
    expect(getTask(t.db, creator.taskId)?.phase).toBe('open');
    refs.set(`refs/heads/mt/${creator.taskId}`, 'c'.repeat(40));
    inside.add(`refs/heads/mt/${creator.taskId}`);
    const r = await directories().prepare(follow);
    expect(r).toMatchObject({ ok: true });
    expect(adds()).toEqual([['worktree', 'add', '--quiet', '--no-track', '-b', `mt/${follow.taskId}`, join(realpathSync(root), 'web', follow.taskId), 'c'.repeat(40)]]);
  });

  it("merges its creator's later commits until its first session starts", async () => {
    const { creator, follow } = followUp();
    refs.set(`refs/heads/mt/${creator.taskId}`, 'c'.repeat(40));
    const d = directories();
    inside.add(`refs/heads/mt/${creator.taskId}`);
    expect(await d.prepare(follow)).toMatchObject({ ok: true });
    // The creator commits again; the follow-up is taken up again before its session starts.
    inside.clear();
    asked = [];
    expect(await d.prepare(getTask(t.db, follow.taskId) ?? follow)).toMatchObject({ ok: true });
    expect(asked.filter((a) => a[0] === 'merge').map((a) => a.at(-1))).toEqual([`refs/heads/mt/${creator.taskId}`]);
  });

  it("starts from the base when its creator was archived, whose work was abandoned", async () => {
    const { creator, follow } = followUp();
    refs.set(`refs/heads/mt/${creator.taskId}`, 'c'.repeat(40));
    archive(t.db, creator.taskId, 'lark:on_alice', NOW);
    expect(await directories().prepare(follow)).toMatchObject({ ok: true });
    expect(adds()[0]?.at(-1)).toBe('b'.repeat(40));
  });
});
