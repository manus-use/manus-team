import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addGate, claim, closeRun, DEFAULT_LIMITS, endRun, reportCheck, requestReview } from '../src/db/kanban.js';
import { eventsOf, getRun, getTask } from '../src/db/kanban-read.js';
import { placeOf } from '../src/kanban/workspace.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, claimantFor, NOW, WORKSPACES, newTask } from './helpers/kanban.js';

/**
 * A task's own directory, decided at its claim (spec §18): its first agent claim
 * in an isolated workspace fixes it on the task, its runs record it as where they
 * work, and the one-agent limit of the workspace's shared directory does not hold
 * them back.
 */

const ISOLATED: ReadonlySet<string> = new Set(['web']);

let t: TestDb;
beforeEach(() => {
  t = testDb();
});
afterEach(() => t.close());

function claimIn(taskId: string, opts: { isolated?: ReadonlySet<string>; reportingIn?: ReadonlyMap<string, string> } = {}) {
  return claim(
    t.db,
    {
      taskId,
      claimant: claimantFor(t.db, taskId),
      workspaces: WORKSPACES,
      isolated: opts.isolated ?? ISOLATED,
      ...(opts.reportingIn === undefined ? {} : { reportingIn: opts.reportingIn }),
    },
    NOW,
  );
}

describe('a claim in an isolated workspace', () => {
  it('gives each task a directory of its own, so two of them run at once', () => {
    const a = newTask(t.db, { workspace: 'web' });
    const b = newTask(t.db, { workspace: 'web' });
    const first = claimIn(a.taskId);
    const second = claimIn(b.taskId);
    if (!first.ok || !second.ok) throw new Error('both claims should succeed');
    expect(first.run.workspace).toBe(`wt:${a.taskId}`);
    expect(second.run.workspace).toBe(`wt:${b.taskId}`);
    expect(getTask(t.db, a.taskId)).toMatchObject({ workspace: 'web', worktree: `wt:${a.taskId}` });
    expect(placeOf(second.task)).toBe(`wt:${b.taskId}`);
    const claimed = eventsOf(t.db, a.taskId).find((e) => e.kind === 'claimed');
    expect(claimed?.payload).toMatchObject({ workspace: 'web', worktree: `wt:${a.taskId}` });
  });

  it('keeps the shared directory, one agent at a time, for a workspace that is not isolated', () => {
    const a = newTask(t.db, { workspace: 'api' });
    const b = newTask(t.db, { workspace: 'api' });
    const first = claimIn(a.taskId);
    expect(first.ok && first.run.workspace).toBe('api');
    expect(first.ok && first.task.worktree).toBeNull();
    expect(claimIn(b.taskId)).toMatchObject({ ok: false, code: 'workspace_busy' });
    // Its claimed event is as it was.
    expect(eventsOf(t.db, a.taskId).find((e) => e.kind === 'claimed')?.payload).not.toHaveProperty('worktree');
  });

  it('leaves a task that has had an agent run in the shared directory there, and counts it against the shared one', () => {
    const old = newTask(t.db, { workspace: 'web' });
    // Its first run, before the workspace was isolated.
    const before = claimIn(old.taskId, { isolated: new Set() });
    if (!before.ok) throw new Error(before.message);
    endRun(t.db, before.run.runId, { outcome: 'failed', error: 'x' }, DEFAULT_LIMITS, NOW);
    closeRun(t.db, before.run.runId, NOW);
    const again = claimIn(old.taskId);
    if (!again.ok) throw new Error(again.message);
    expect(again.run.workspace).toBe('web');
    expect(again.task.worktree).toBeNull();
    // A second shared task waits for it; a new task, with a directory of its own, does not.
    const shared = newTask(t.db, { workspace: 'web' });
    expect(claim(t.db, { taskId: shared.taskId, claimant: claimantFor(t.db, shared.taskId), workspaces: WORKSPACES }, NOW)).toMatchObject({
      ok: false,
      code: 'workspace_busy',
    });
    expect(getRun(t.db, again.run.runId)?.endedAt).toBeNull();
    const fresh = newTask(t.db, { workspace: 'web' });
    expect(claimIn(fresh.taskId)).toMatchObject({ ok: true, run: { workspace: `wt:${fresh.taskId}` } });
  });

  it('keeps a task its own directory once it has one, though the workspace is no longer isolated', () => {
    const a = newTask(t.db, { workspace: 'web' });
    const first = claimIn(a.taskId);
    if (!first.ok) throw new Error(first.message);
    endRun(t.db, first.run.runId, { outcome: 'failed', error: 'x' }, DEFAULT_LIMITS, NOW);
    closeRun(t.db, first.run.runId, NOW);
    const retry = claimIn(a.taskId, { isolated: new Set() });
    expect(retry).toMatchObject({ ok: true, run: { workspace: `wt:${a.taskId}` }, task: { worktree: `wt:${a.taskId}` } });
  });

  it("gives a person's run no directory: a person's run does not use one", () => {
    const task = newTask(t.db, { workspace: 'web', assignee: { kind: 'human', name: ALICE } });
    const r = claimIn(task.taskId);
    expect(r).toMatchObject({ ok: true, run: { workspace: 'web' }, task: { worktree: null } });
  });

  it("is held back by a report's gates in the shared directory only when it works there", () => {
    const shared = newTask(t.db, { workspace: 'api' });
    const own = newTask(t.db, { workspace: 'web' });
    const reporting = new Map([
      ['api', 'k_other'],
      ['web', 'k_other'],
    ]);
    expect(claimIn(shared.taskId, { reportingIn: reporting })).toMatchObject({ ok: false, code: 'not_claimable' });
    expect(claimIn(own.taskId, { reportingIn: reporting })).toMatchObject({ ok: true });
  });

  it("names a task's own directory as the task's, not by its internal id, when its gates hold a claim back", () => {
    const own = newTask(t.db, { workspace: 'web' });
    const first = claimIn(own.taskId);
    if (!first.ok) throw new Error(first.message);
    endRun(t.db, first.run.runId, { outcome: 'failed', error: 'x' }, DEFAULT_LIMITS, NOW);
    closeRun(t.db, first.run.runId, NOW);
    expect(claimIn(own.taskId, { reportingIn: new Map([[`wt:${own.taskId}`, own.taskId]]) })).toMatchObject({
      ok: false,
      code: 'not_claimable',
      message: `task ${own.taskId}'s directory is running the gates of a report on task ${own.taskId}`,
    });
  });

  it("does not refuse a person's review with gates for another task's agent run in the shared directory", () => {
    const own = newTask(t.db, { workspace: 'web' });
    const work = claimIn(own.taskId);
    if (!work.ok) throw new Error(work.message);
    const asked = requestReview(t.db, own.taskId, { kind: 'run', runId: work.run.runId }, { summary: 'done', reviewer: { kind: 'human', name: ALICE } }, NOW);
    if (!asked.ok) throw new Error(asked.message);
    closeRun(t.db, work.run.runId, NOW);
    const review = claimIn(own.taskId);
    if (!review.ok) throw new Error(review.message);
    expect(review.run.workspace).toBe(`wt:${own.taskId}`);
    // A task in the shared directory now has an agent at work there.
    const shared = newTask(t.db, { workspace: 'web' });
    expect(claimIn(shared.taskId, { isolated: new Set() })).toMatchObject({ ok: true, run: { workspace: 'web' } });
    addGate(t.db, own.taskId, { command: 'true', timeoutS: 5 }, ALICE, NOW);
    // The gates of the person's approval run in the task's own directory, where nobody else works.
    expect(reportCheck(t.db, own.taskId, { kind: 'person', principal: ALICE, as: 'reviewer' }, 'complete')).toMatchObject({ ok: true });
    // A task in the shared directory is held back, as before.
    const other = newTask(t.db, { workspace: 'web', assignee: { kind: 'human', name: ALICE } });
    claimIn(other.taskId);
    addGate(t.db, other.taskId, { command: 'true', timeoutS: 5 }, ALICE, NOW);
    expect(reportCheck(t.db, other.taskId, { kind: 'person', principal: ALICE, as: 'assignee' }, 'complete')).toMatchObject({
      ok: false,
      code: 'workspace_busy',
    });
  });

  it("names a task's own directory by its task when another agent run is open there", () => {
    const own = newTask(t.db, { workspace: 'web' });
    const work = claimIn(own.taskId);
    if (!work.ok) throw new Error(work.message);
    const asked = requestReview(t.db, own.taskId, { kind: 'run', runId: work.run.runId }, { summary: 'done', reviewer: { kind: 'human', name: ALICE } }, NOW);
    if (!asked.ok) throw new Error(asked.message);
    closeRun(t.db, work.run.runId, NOW);
    addGate(t.db, own.taskId, { command: 'true', timeoutS: 5 }, ALICE, NOW);
    // Another task's agent run, recorded as working in this task's own directory.
    const other = newTask(t.db, { workspace: 'web' });
    const intruder = claimIn(other.taskId);
    if (!intruder.ok) throw new Error(intruder.message);
    t.db.prepare('UPDATE kanban_runs SET workspace = ? WHERE run_id = ?').run(`wt:${own.taskId}`, intruder.run.runId);
    expect(reportCheck(t.db, own.taskId, { kind: 'person', principal: ALICE, as: 'reviewer' }, 'complete')).toMatchObject({
      ok: false,
      code: 'workspace_busy',
      message:
        `task ${own.taskId}'s gates run in task ${own.taskId}'s directory, where task ${other.taskId}'s agent run ${intruder.run.runId} is open; ` +
        'report again once it has finished',
    });
  });
});

describe('a run that could not start for a reason only a person can put right', () => {
  it('blocks its task as needs_input with the reason, uncounted', () => {
    const a = newTask(t.db, { workspace: 'web' });
    const r = claimIn(a.taskId);
    if (!r.ok) throw new Error(r.message);
    const ended = endRun(
      t.db,
      r.run.runId,
      { outcome: 'failed', error: 'merging conflicts in a.txt', hadSideEffects: false, block: 'merging conflicts in a.txt' },
      DEFAULT_LIMITS,
      NOW,
    );
    expect(ended).toMatchObject({ ok: true, next: 'blocked', run: { outcome: 'failed' } });
    expect(getTask(t.db, a.taskId)).toMatchObject({
      phase: 'blocked',
      blockKind: 'needs_input',
      blockReason: 'merging conflicts in a.txt',
      blockedFrom: 'open',
      consecutiveFailures: 0,
    });
  });

  it('is only a failed run', () => {
    const a = newTask(t.db, { workspace: 'web' });
    const r = claimIn(a.taskId);
    if (!r.ok) throw new Error(r.message);
    expect(endRun(t.db, r.run.runId, { outcome: 'crashed', block: 'x' }, DEFAULT_LIMITS, NOW)).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });
});
