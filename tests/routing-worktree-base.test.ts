import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { getTask, membersOf } from '../src/db/kanban-read.js';
import { registerWorktree } from '../src/db/workspaces.js';
import { TaskDirectories, type GitResult, type GitRunner } from '../src/kanban/worktree.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA } from './helpers/kanban.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * Where a step made late starts in an isolated workspace (workflow routing spec
 * §3.2, kanban spec §18.5): from the branches of its effective parents, past a
 * skipped step; a parent done and then archived keeps its link and its
 * handoff, not its branch. Against a stand-in for git that answers what the
 * board asks and records it.
 */

const FLOW = `board: vi
steps:
  a:
    title: a
    assignee: vi-coordinator
    workspace: vi
    outputs: { go: boolean }
  b:
    title: b
    assignee: verifier
    workspace: vi
  s:
    title: s
    assignee: verifier
    workspace: vi
    parents: [a]
    when: [{ step: a, output: go, is: false }]
  c:
    title: c
    assignee: verifier
    workspace: vi
    parents: [s, b]
`;

let dir: string;
let base: string;
let root: string;
let h: TestDb;
let b: ViBoard;
let asked: string[][];
let refs: Map<string, string>;
let addedAt: string | undefined;

const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });
const no = (): GitResult => ({ code: 1, stdout: '', stderr: '' });

const git: GitRunner = async (args, opts) => {
  asked.push([...args]);
  const [verb, ...rest] = args;
  if (verb === 'rev-parse' && rest[0] === '--git-common-dir') return ok('.git');
  if (verb === 'rev-parse' && rest[0] === '--verify') {
    const commit = refs.get((rest.at(-1) ?? '').replace(/\^\{commit\}$/, ''));
    return commit === undefined ? no() : ok(commit);
  }
  if (verb === 'worktree' && rest[0] === 'add') {
    addedAt = rest.at(-1);
    mkdirSync(rest.find((a) => a.startsWith(root)) ?? '', { recursive: true });
    return ok();
  }
  if (verb === 'worktree' && rest[0] === 'list') return ok('');
  if (verb === 'symbolic-ref') return ok(`refs/heads/mt/${opts.cwd.split('/').at(-1) ?? ''}`);
  // Only the commit the worktree was added at is in it already: every other parent's branch is merged.
  if (verb === 'merge-base') return refs.get(rest[1] ?? '') === addedAt ? ok() : no();
  if (verb === 'merge') return ok();
  throw new Error(`unexpected git ${args.join(' ')}`);
};

beforeEach(() => {
  clearSecrets();
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-routed-base-')));
  base = join(dir, 'vi');
  mkdirSync(join(base, '.git'), { recursive: true });
  root = join(dir, 'worktrees');
  asked = [];
  refs = new Map([['HEAD', 'b'.repeat(40)]]);
  h = testDb();
  b = viBoard(h, { isolated: new Set(['vi']) });
  writeFileSync(join(b.dir, 'flow.yaml'), FLOW);
});
afterEach(() => {
  h.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A task done in its own worktree, on its branch at `commit`. */
async function doneOnBranch(taskId: string, commit: string, metadata: Record<string, unknown>): Promise<void> {
  const claim = b.service.claim(taskId);
  if (!claim.ok) throw new Error(claim.message);
  const run = claim.run;
  const id = getTask(h.db, taskId)?.worktree ?? '';
  registerWorktree(h.db, { id, kind: 'git-worktree', rootPath: join(root, 'vi', taskId), repoRoot: base, branch: `mt/${taskId}` }, NOW);
  refs.set(`refs/heads/mt/${taskId}`, commit);
  const r = await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'did it', metadata });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  closeRun(h.db, run.runId, NOW);
}

/** Where the task's worktree starts at its claim: the commit it is added at, and the branches merged into it. */
async function startFrom(taskId: string): Promise<{ from: string | undefined; merged: string[] }> {
  const claim = b.service.claim(taskId);
  if (!claim.ok) throw new Error(claim.message);
  const task = getTask(h.db, taskId);
  if (task === undefined) throw new Error('no task');
  asked = [];
  const d = new TaskDirectories({ db: h.db, root, workspaceDirs: new Map([['vi', base]]), isolated: { vi: {} }, env: {}, git });
  const r = await d.prepare(task);
  if (!r.ok) throw new Error(JSON.stringify(r));
  return { from: asked.find((a) => a[0] === 'worktree' && a[1] === 'add')?.at(-1), merged: asked.filter((a) => a[0] === 'merge').map((a) => a.at(-1) ?? '') };
}

describe("a late step's worktree", () => {
  it("starts from its effective parents' branches, past a skipped step", async () => {
    const w = madeOf(b.service.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
    const [a, bb] = [w.tasks[0]?.taskId ?? '', w.tasks[1]?.taskId ?? ''];
    await doneOnBranch(a, 'a'.repeat(40), { go: true });
    await doneOnBranch(bb, 'c'.repeat(40), {});
    const c = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'c')?.taskId ?? '';
    expect(await startFrom(c)).toEqual({ from: 'a'.repeat(40), merged: [`refs/heads/mt/${bb}`] });
  });

  it('leaves out the branch of a parent done and then archived', async () => {
    const w = madeOf(b.service.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
    const [a, bb] = [w.tasks[0]?.taskId ?? '', w.tasks[1]?.taskId ?? ''];
    await doneOnBranch(a, 'a'.repeat(40), { go: true });
    expect(b.service.archive(a, ALICE).ok).toBe(true);
    await doneOnBranch(bb, 'c'.repeat(40), {});
    const c = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'c')?.taskId ?? '';
    expect(await startFrom(c)).toEqual({ from: 'c'.repeat(40), merged: [] });
  });
});
