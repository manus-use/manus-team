import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addComment,
  archive,
  assign,
  assignReviewer,
  closeRun,
  complete,
  noteUnassignable,
  requestReview,
  setWorkspace,
} from '../src/db/kanban.js';
import { eventsOf, getRun, taskView } from '../src/db/kanban-read.js';
import type { Reporter, RunRow } from '../src/kanban/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, claimed, newTask } from './helpers/kanban.js';

let h: TestDb;

beforeEach(() => {
  h = testDb();
});

afterEach(() => h.close());

const OTHER = { kind: 'role', name: 'other-role' } as const;
const REVIEWER = { kind: 'role', name: 'reviewer' } as const;
const asRun = (run: RunRow): Reporter => ({ kind: 'run', runId: run.runId });

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

describe('assign', () => {
  it('supersedes an undecided work run; the next claim goes to the new assignee', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    expect(assign(h.db, task.taskId, OTHER, ALICE, NOW)).toMatchObject({
      ok: true,
      task: { phase: 'open', assignee: OTHER },
      run: { runId: run.runId, outcome: 'superseded', endedAt: null },
    });
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({
      kind: 'assignee_set',
      runId: run.runId,
      payload: { assignee: 'other-role', assigneeKind: 'role' },
    });
    expect(complete(h.db, task.taskId, asRun(run), { summary: 'x' }, NOW)).toMatchObject({ code: 'run_superseded' });
    ok(closeRun(h.db, run.runId, NOW));
    expect(claimed(h.db, task.taskId)).toMatchObject({ attempt: 2, assignee: OTHER });
  });

  it('leaves a work run that has reported with its outcome, and returns it to be closed', () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const run = claimed(h.db, task.taskId);
    ok(requestReview(h.db, task.taskId, asRun(run), { summary: 'v1' }, NOW));
    expect(assign(h.db, task.taskId, OTHER, ALICE, NOW)).toMatchObject({
      ok: true,
      task: { phase: 'review', assignee: OTHER },
      run: { runId: run.runId, outcome: 'review_requested', endedAt: null },
    });
  });

  it('changes nothing when the assignee is the same', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    const before = eventsOf(h.db, task.taskId).length;
    expect(assign(h.db, task.taskId, { kind: 'role', name: 'implementer' }, ALICE, NOW)).toMatchObject({
      ok: true,
      run: undefined,
    });
    expect(eventsOf(h.db, task.taskId)).toHaveLength(before);
    expect(getRun(h.db, run.runId)?.outcome).toBeNull();
  });

  it('replaces the reviewer, superseding an undecided review run, but not a work run', () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const work = claimed(h.db, task.taskId);
    expect(assignReviewer(h.db, task.taskId, OTHER, ALICE, NOW)).toMatchObject({ ok: true, run: undefined });
    ok(requestReview(h.db, task.taskId, asRun(work), { summary: 'v1' }, NOW));
    ok(closeRun(h.db, work.runId, NOW));
    const review = claimed(h.db, task.taskId);
    expect(assignReviewer(h.db, task.taskId, REVIEWER, ALICE, NOW)).toMatchObject({
      ok: true,
      task: { phase: 'review', reviewer: REVIEWER },
      run: { runId: review.runId, outcome: 'superseded' },
    });
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({
      kind: 'reviewer_set',
      payload: { reviewer: 'reviewer', reviewerKind: 'role' },
    });
    ok(closeRun(h.db, review.runId, NOW));
    expect(claimed(h.db, task.taskId).assignee).toEqual(REVIEWER);
  });

  it('refuses to reassign a done or archived task', () => {
    const done = newTask(h.db);
    ok(complete(h.db, done.taskId, { kind: 'person', principal: ALICE }, { summary: 'x' }, NOW));
    expect(assign(h.db, done.taskId, OTHER, ALICE, NOW)).toEqual({
      ok: false,
      code: 'illegal_transition',
      message: `task ${done.taskId} is done; it cannot be reassigned`,
    });
    const archived = newTask(h.db);
    ok(archive(h.db, archived.taskId, ALICE, NOW));
    expect(assignReviewer(h.db, archived.taskId, OTHER, ALICE, NOW)).toMatchObject({ code: 'illegal_transition' });
  });
});

describe('setWorkspace', () => {
  it('sets a null workspace, and refuses once one is fixed', () => {
    const task = newTask(h.db);
    expect(setWorkspace(h.db, task.taskId, 'web', ALICE, NOW)).toMatchObject({ ok: true, task: { workspace: 'web' } });
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({ kind: 'workspace_set', payload: { workspace: 'web' } });
    expect(setWorkspace(h.db, task.taskId, 'api', ALICE, NOW)).toEqual({
      ok: false,
      code: 'workspace_fixed',
      message: `task ${task.taskId} works in web; a fixed workspace does not change`,
    });
    const claimedTask = newTask(h.db);
    claimed(h.db, claimedTask.taskId);
    expect(setWorkspace(h.db, claimedTask.taskId, 'api', ALICE, NOW)).toMatchObject({ code: 'workspace_fixed' });
  });
});

describe('archive', () => {
  it('archives a task, superseding an undecided run, and frees its children', () => {
    const task = newTask(h.db);
    const child = newTask(h.db, { parents: [task.taskId] });
    const run = claimed(h.db, task.taskId);
    expect(archive(h.db, task.taskId, ALICE, NOW + 1)).toMatchObject({
      ok: true,
      task: { phase: 'archived', closedAt: NOW + 1 },
      run: { runId: run.runId, outcome: 'superseded' },
    });
    expect(taskView(h.db, child.taskId)?.status).toBe('ready');
    expect(archive(h.db, task.taskId, ALICE, NOW)).toEqual({
      ok: false,
      code: 'illegal_transition',
      message: `task ${task.taskId} is already archived`,
    });
  });

  it('archives a task whose run has reported, keeping its outcome, and returns the run to be closed', () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const run = claimed(h.db, task.taskId);
    ok(requestReview(h.db, task.taskId, asRun(run), { summary: 'v1' }, NOW));
    expect(archive(h.db, task.taskId, ALICE, NOW)).toMatchObject({
      ok: true,
      task: { phase: 'archived' },
      run: { runId: run.runId, outcome: 'review_requested', endedAt: null },
    });
  });

  it('keeps the time a done task was done', () => {
    const task = newTask(h.db);
    ok(complete(h.db, task.taskId, { kind: 'person', principal: ALICE }, { summary: 'x' }, NOW));
    expect(ok(archive(h.db, task.taskId, ALICE, NOW + 50)).task).toMatchObject({ phase: 'archived', closedAt: NOW });
  });
});

describe('noteUnassignable', () => {
  it('writes once, until something else happens to the task', () => {
    const task = newTask(h.db);
    expect(noteUnassignable(h.db, task.taskId, 'role gone is not configured', NOW)).toEqual({
      ok: true,
      written: true,
    });
    expect(noteUnassignable(h.db, task.taskId, 'role gone is not configured', NOW)).toEqual({
      ok: true,
      written: false,
    });
    ok(addComment(h.db, task.taskId, ALICE, 'any news?', NOW, true));
    expect(noteUnassignable(h.db, task.taskId, 'role gone is not configured', NOW)).toEqual({
      ok: true,
      written: true,
    });
    expect(eventsOf(h.db, task.taskId).filter((e) => e.kind === 'skipped_unassignable')).toHaveLength(2);
  });
});
