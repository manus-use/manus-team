import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { getTask, membersOf, parentsOf } from '../src/db/kanban-read.js';
import { registerWorktree } from '../src/db/workspaces.js';
import { TaskDirectories, type GitResult, type GitRunner } from '../src/kanban/worktree.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA } from './helpers/kanban.js';
import { VI_WORKFLOW, madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * A handler in an isolated workspace (workflow routing spec §5.2, §13.4): made
 * with the routed task's fixed workspace when its step and role name none, with
 * no parent and, from chat, no creating task, so its worktree starts from the
 * workspace's base; its body naming the routed task's own directory.
 */

let dir: string;
let asked: string[][];
let refs: Map<string, string>;

const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });

/** A stand-in for git that answers what a worktree's making asks, its refs from `refs`, and records it. */
const git: GitRunner = async (args) => {
  asked.push([...args]);
  const [verb, ...rest] = args;
  if (verb === 'rev-parse' && rest[0] === '--git-common-dir') return ok('.git');
  if (verb === 'rev-parse' && rest[0] === '--verify') {
    const commit = refs.get((rest.at(-1) ?? '').replace(/\^\{commit\}$/, ''));
    return commit === undefined ? { code: 1, stdout: '', stderr: '' } : ok(commit);
  }
  if (verb === 'worktree' && rest[0] === 'add') {
    mkdirSync(rest.find((a) => a.startsWith(join(dir, 'worktrees'))) ?? '', { recursive: true });
    return ok();
  }
  if (verb === 'worktree' && rest[0] === 'list') return ok('');
  throw new Error(`unexpected git ${args.join(' ')}`);
};

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-handler-base-')));
  mkdirSync(join(dir, 'vi', '.git'), { recursive: true });
  asked = [];
  refs = new Map([['HEAD', 'b'.repeat(40)]]);
  h = testDb();
  b = viBoard(h, { isolated: new Set(['vi']), limits: { failureLimit: 1, transientLimit: 10, transientCooldownS: 300 } });
  writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW.replace('    assignee: vulnerability-analyst\n', '    assignee: vulnerability-analyst\n    workspace: vi\n'));
});
afterEach(() => {
  h.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a handler in an isolated workspace', () => {
  it("is made in the routed task's workspace, with no parent and no creating task, its body naming the routed task's directory", async () => {
    const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
    const intake = w.tasks[0]?.taskId ?? '';
    const ir = b.service.claim(intake);
    if (!ir.ok) throw new Error(ir.message);
    await b.service.complete(intake, { kind: 'run', runId: ir.run.runId }, { summary: 'x', metadata: { kind: 'cve', verify: false, patch: false, bnpm: false, packages: [] } });
    closeRun(h.db, ir.run.runId, NOW);
    const va = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'va')?.taskId ?? '';
    const run = b.service.claim(va);
    if (!run.ok) throw new Error(run.message);
    expect(getTask(h.db, va)?.worktree).toBe(`wt:${va}`);
    // The directory the dispatcher would make before the run's first prompt.
    refs.set(`refs/heads/mt/${va}`, 'a'.repeat(40));
    registerWorktree(h.db, { id: `wt:${va}`, kind: 'git-worktree', rootPath: `/home/mt/worktrees/${va}`, repoRoot: join(dir, 'vi'), branch: `mt/${va}` }, NOW);
    b.service.endRun(run.run.runId, { outcome: 'crashed' });
    const escalate = getTask(h.db, membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'escalate')?.taskId ?? '');
    expect(escalate).toMatchObject({ workspace: 'vi', createdFromTask: null, worktree: null });
    expect(parentsOf(h.db, escalate?.taskId ?? '')).toEqual([]);
    expect(escalate?.body.split('\n')[1]).toBe(`Its directory: /home/mt/worktrees/${va}`);
    // At its claim its worktree is made from the workspace's base, HEAD, not from the routed task's branch.
    const claim = b.service.claim(escalate?.taskId ?? '');
    if (!claim.ok) throw new Error(claim.message);
    const claimedTask = getTask(h.db, escalate?.taskId ?? '');
    expect(claimedTask?.worktree).toBe(`wt:${escalate?.taskId ?? ''}`);
    const d = new TaskDirectories({ db: h.db, root: join(dir, 'worktrees'), workspaceDirs: new Map([['vi', join(dir, 'vi')]]), isolated: { vi: {} }, env: {}, git });
    if (claimedTask === undefined) throw new Error('no task');
    const prepared = await d.prepare(claimedTask);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared));
    expect(asked.find((a) => a[0] === 'rev-parse' && a[1] === '--verify')?.at(-1)).toBe('HEAD^{commit}');
    expect(asked.find((a) => a[0] === 'worktree' && a[1] === 'add')?.at(-1)).toBe('b'.repeat(40));
    expect(asked.filter((a) => a[0] === 'merge')).toEqual([]);
  });
});
