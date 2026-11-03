import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { block, claim, closeRun, complete, requestReview, stop, unblock } from '../src/db/kanban.js';
import { commentsOf, eventsOf, getRun, getTask, parentsOf, taskView } from '../src/db/kanban-read.js';
import type { Reporter, RunRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, WORKSPACES, claimantFor, claimed, newTask } from './helpers/kanban.js';

let h: TestDb;

beforeEach(() => {
  clearSecrets();
  h = testDb();
});

afterEach(() => {
  h.close();
  clearSecrets();
});

const BOB = { kind: 'human', name: 'lark:on_bob' } as const;
const asRun = (run: RunRow): Reporter => ({ kind: 'run', runId: run.runId });

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

/** Claim, block with this kind, and close the run, as an agent would leave it. */
function blockedBy(taskId: string, kind: 'needs_input' | 'capability'): void {
  const run = claimed(h.db, taskId);
  ok(block(h.db, taskId, asRun(run), { kind, reason: `${kind} please` }, NOW));
  ok(closeRun(h.db, run.runId, NOW));
}

describe('block', () => {
  it('blocks a running task, remembering the phase it left, and records why', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    const r = block(h.db, task.taskId, asRun(run), { kind: 'needs_input', reason: 'which database?' }, NOW);
    expect(r).toMatchObject({
      ok: true,
      task: { phase: 'blocked', blockedFrom: 'open', blockKind: 'needs_input', blockReason: 'which database?' },
      run: { outcome: 'blocked', summary: 'which database?', endedAt: null },
    });
    expect(taskView(h.db, task.taskId)?.status).toBe('blocked');
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({
      kind: 'blocked',
      payload: { kind: 'needs_input', reason: 'which database?', blockRecurrences: 0 },
    });
  });

  it('masks the reason on write', () => {
    addSecrets(['sk-test-123456']);
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    const r = ok(
      block(h.db, task.taskId, asRun(run), { kind: 'capability', reason: 'sk-test-123456 is revoked' }, NOW),
    );
    expect(r.task.blockReason).toBe(`${MASK} is revoked`);
    expect(r.run?.summary).toBe(`${MASK} is revoked`);
    expect(eventsOf(h.db, task.taskId).at(-1)?.payload).toMatchObject({ reason: `${MASK} is revoked` });
  });

  it('counts a block of the same kind after an unblock, and keeps the count across unblocks', () => {
    const task = newTask(h.db);
    blockedBy(task.taskId, 'needs_input');
    ok(unblock(h.db, task.taskId, ALICE, undefined, NOW));
    blockedBy(task.taskId, 'needs_input');
    expect(getTask(h.db, task.taskId)?.blockRecurrences).toBe(1);
    ok(unblock(h.db, task.taskId, ALICE, undefined, NOW));
    blockedBy(task.taskId, 'capability');
    expect(getTask(h.db, task.taskId)).toMatchObject({ blockRecurrences: 1, blockKind: 'capability' });
  });

  it('returns a task to open on a dependency block, waiting on the parents it names', () => {
    const prerequisite = newTask(h.db, { title: 'prerequisite' });
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    const r = block(
      h.db,
      task.taskId,
      asRun(run),
      { kind: 'dependency', reason: 'needs the schema first', parents: [prerequisite.taskId] },
      NOW,
    );
    expect(r).toMatchObject({ ok: true, task: { phase: 'open', blockKind: null }, run: { outcome: 'blocked' } });
    expect(parentsOf(h.db, task.taskId).map((t) => t.title)).toEqual(['prerequisite']);
    expect(taskView(h.db, task.taskId)?.status).toBe('todo');
  });

  it("keeps a reviewer's dependency block in review, and claims the reviewer again once the parents are done", () => {
    // The implementer's work is done; only the review was waiting.
    const prerequisite = newTask(h.db, { title: 'prerequisite', assignee: BOB });
    const task = newTask(h.db, { reviewer: { kind: 'role', name: 'reviewer' } });
    const work = claimed(h.db, task.taskId);
    ok(requestReview(h.db, task.taskId, asRun(work), { summary: 'v1' }, NOW));
    ok(closeRun(h.db, work.runId, NOW));
    const review = claimed(h.db, task.taskId);
    const r = block(
      h.db,
      task.taskId,
      asRun(review),
      { kind: 'dependency', reason: 'needs the API docs first', parents: [prerequisite.taskId] },
      NOW,
    );
    expect(r).toMatchObject({ ok: true, task: { phase: 'review', blockKind: null }, run: { outcome: 'blocked' } });
    expect(parentsOf(h.db, task.taskId).map((t) => t.title)).toEqual(['prerequisite']);
    expect(taskView(h.db, task.taskId)?.status).toBe('todo');
    ok(closeRun(h.db, review.runId, NOW));
    expect(
      claim(h.db, { taskId: task.taskId, claimant: claimantFor(h.db, task.taskId), workspaces: WORKSPACES }, NOW),
    ).toEqual({
      ok: false,
      code: 'not_claimable',
      message: `task ${task.taskId} is waiting on a parent that is not done`,
    });
    ok(
      complete(
        h.db,
        prerequisite.taskId,
        { kind: 'person', principal: 'lark:on_bob' },
        { summary: 'docs written' },
        NOW,
      ),
    );
    expect(taskView(h.db, task.taskId)?.status).toBe('review');
    expect(claimed(h.db, task.taskId)).toMatchObject({ kind: 'review', attempt: 3, assignee: { name: 'reviewer' } });
  });

  it('refuses a dependency block with nothing unfinished to wait on, and writes nothing', () => {
    const finished = newTask(h.db, { assignee: BOB });
    ok(complete(h.db, finished.taskId, { kind: 'person', principal: 'lark:on_bob' }, { summary: 'done' }, NOW));
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    for (const parents of [[], [finished.taskId]]) {
      expect(block(h.db, task.taskId, asRun(run), { kind: 'dependency', reason: 'x', parents }, NOW)).toEqual({
        ok: false,
        code: 'invalid',
        message: `a dependency block must name a task ${task.taskId} waits on that is not done`,
      });
    }
    expect(parentsOf(h.db, task.taskId)).toEqual([]);
    expect(getRun(h.db, run.runId)?.outcome).toBeNull();
  });
});

describe('unblock', () => {
  it('returns a task to the phase it left, keeping the kind, with a comment for the next run', () => {
    const task = newTask(h.db, { reviewer: { kind: 'role', name: 'reviewer' } });
    const work = claimed(h.db, task.taskId);
    ok(requestReview(h.db, task.taskId, asRun(work), { summary: 'v1' }, NOW));
    ok(closeRun(h.db, work.runId, NOW));
    blockedBy(task.taskId, 'capability');
    expect(getTask(h.db, task.taskId)?.blockedFrom).toBe('review');
    const r = unblock(h.db, task.taskId, ALICE, 'access granted', NOW);
    expect(r).toMatchObject({ ok: true, task: { phase: 'review', blockedFrom: null, blockKind: 'capability' } });
    expect(commentsOf(h.db, task.taskId).map((c) => [c.author, c.body])).toEqual([[ALICE, 'access granted']]);
    expect(claimed(h.db, task.taskId).kind).toBe('review');
  });

  it('refuses a task that is not blocked', () => {
    const task = newTask(h.db);
    expect(unblock(h.db, task.taskId, ALICE, undefined, NOW)).toEqual({
      ok: false,
      code: 'illegal_transition',
      message: `task ${task.taskId} is open, not blocked`,
    });
  });
});

describe('stop', () => {
  it('cancels an undecided run, and blocks the task for input', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    const r = stop(h.db, task.taskId, ALICE, NOW);
    expect(r).toMatchObject({
      ok: true,
      task: { phase: 'blocked', blockedFrom: 'open', blockKind: 'needs_input', blockReason: `stopped by ${ALICE}` },
      run: { outcome: 'cancelled', endedAt: null },
    });
    // The agent's later report finds its run decided by someone else.
    expect(complete(h.db, task.taskId, asRun(run), { summary: 'x' }, NOW)).toMatchObject({
      ok: false,
      code: 'run_superseded',
    });
  });

  it('leaves a run that has reported with its outcome, writing nothing', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    ok(complete(h.db, task.taskId, asRun(run), { summary: 'done' }, NOW));
    const before = eventsOf(h.db, task.taskId).length;
    expect(stop(h.db, task.taskId, ALICE, NOW)).toMatchObject({
      ok: true,
      task: { phase: 'done' },
      run: { outcome: 'completed', endedAt: null },
    });
    expect(eventsOf(h.db, task.taskId)).toHaveLength(before);
  });

  it("closes a person's stopped run at once, and refuses a task with no open run", () => {
    const task = newTask(h.db, { assignee: BOB });
    claimed(h.db, task.taskId);
    expect(stop(h.db, task.taskId, ALICE, NOW + 1)).toMatchObject({
      ok: true,
      run: { outcome: 'cancelled', endedAt: NOW + 1 },
    });
    expect(stop(h.db, task.taskId, ALICE, NOW)).toEqual({
      ok: false,
      code: 'no_open_run',
      message: `task ${task.taskId} has no open run to stop`,
    });
  });
});
