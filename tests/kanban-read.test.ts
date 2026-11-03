import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  archive,
  attachSession,
  block,
  closeRun,
  complete,
  endRun,
  DEFAULT_LIMITS,
  link,
  requestChanges,
  requestReview,
} from '../src/db/kanban.js';
import {
  claimableTasks,
  latestCompletion,
  openAgentRunCount,
  openRuns,
  runBySession,
} from '../src/db/kanban-read.js';
import { createSession } from '../src/db/sessions.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, claimed, newTask } from './helpers/kanban.js';

let h: TestDb;

beforeEach(() => {
  h = testDb();
});

afterEach(() => h.close());

const REVIEWER = { kind: 'role', name: 'reviewer' } as const;

/** A work run that asks for review, closed: the task waits in review for its reviewer. */
function reviewRequested(taskId: string, summary: string, metadata: unknown = null, now = NOW): string {
  const run = claimed(h.db, taskId, {}, now);
  expect(requestReview(h.db, taskId, { kind: 'run', runId: run.runId }, { summary, metadata }, now).ok).toBe(true);
  expect(closeRun(h.db, run.runId, now).ok).toBe(true);
  return run.runId;
}

function session(id: string): string {
  createSession(h.db, { id, agentId: 'implementer', workspaceId: 'default', ownerPrincipal: 'kanban' }, NOW);
  return id;
}

describe('the runs a dispatcher reads', () => {
  it('lists every open run, oldest first, and no closed one', () => {
    const a = claimed(h.db, newTask(h.db, { workspace: 'web' }).taskId, {}, NOW);
    const b = claimed(h.db, newTask(h.db, { workspace: 'api' }).taskId, {}, NOW + 1);
    const c = claimed(h.db, newTask(h.db, { workspace: 'docs' }).taskId, {}, NOW + 2);
    expect(endRun(h.db, c.runId, { outcome: 'failed' }, DEFAULT_LIMITS, NOW + 3).ok).toBe(true);
    expect(closeRun(h.db, c.runId, NOW + 4).ok).toBe(true);
    expect(openRuns(h.db).map((r) => r.runId)).toEqual([a.runId, b.runId]);
  });

  it('finds a run by its session, and nothing for a session that is not a run', () => {
    const run = claimed(h.db, newTask(h.db).taskId);
    expect(attachSession(h.db, run.runId, session('s_run'), NOW).ok).toBe(true);
    session('s_chat');
    expect(runBySession(h.db, 's_run')?.runId).toBe(run.runId);
    expect(runBySession(h.db, 's_chat')).toBeUndefined();
  });

  it('counts open agent runs, decided or not, and no person run', () => {
    const decided = claimed(h.db, newTask(h.db, { workspace: 'web' }).taskId);
    claimed(h.db, newTask(h.db, { workspace: 'api' }).taskId);
    claimed(h.db, newTask(h.db, { assignee: { kind: 'human', name: ALICE } }).taskId);
    expect(openAgentRunCount(h.db)).toBe(2);
    // Reported, but still finishing: its process is still there.
    expect(complete(h.db, decided.taskId, { kind: 'run', runId: decided.runId }, { summary: 'done' }, NOW).ok).toBe(true);
    expect(openAgentRunCount(h.db)).toBe(2);
    expect(closeRun(h.db, decided.runId, NOW).ok).toBe(true);
    expect(openAgentRunCount(h.db)).toBe(1);
  });
});

describe('claimableTasks', () => {
  it('lists ready tasks and reviews by priority, then age', () => {
    newTask(h.db, { title: 'old' }, NOW);
    newTask(h.db, { title: 'urgent', priority: 5 }, NOW + 2);
    newTask(h.db, { title: 'young' }, NOW + 1);
    expect(claimableTasks(h.db, NOW + 10).map((t) => t.title)).toEqual(['urgent', 'old', 'young']);
  });

  it('leaves out a task with an open run, a todo task, a cooling task, and finished ones', () => {
    const running = newTask(h.db, { title: 'running', workspace: 'web' });
    claimed(h.db, running.taskId);
    const parent = newTask(h.db, { title: 'parent', workspace: 'api' });
    newTask(h.db, { title: 'todo', parents: [parent.taskId] });
    const cooling = newTask(h.db, { title: 'cooling', workspace: 'docs' });
    const run = claimed(h.db, cooling.taskId);
    expect(endRun(h.db, run.runId, { outcome: 'rate_limited' }, DEFAULT_LIMITS, NOW).ok).toBe(true);
    expect(closeRun(h.db, run.runId, NOW).ok).toBe(true);

    expect(claimableTasks(h.db, NOW).map((t) => t.title)).toEqual(['parent']);
    // The cooldown is 300 s; at its end the task is claimable again.
    expect(claimableTasks(h.db, NOW + 300_000).map((t) => t.title)).toEqual(['parent', 'cooling']);
  });

  it('lists a child once its parent is done or archived', () => {
    const parent = newTask(h.db, { title: 'parent' });
    const child = newTask(h.db, { title: 'child' });
    expect(link(h.db, parent.taskId, child.taskId, ALICE, NOW).ok).toBe(true);
    expect(claimableTasks(h.db, NOW).map((t) => t.title)).toEqual(['parent']);
    expect(complete(h.db, parent.taskId, { kind: 'person', principal: ALICE }, { summary: 'did it' }, NOW).ok).toBe(true);
    expect(claimableTasks(h.db, NOW).map((t) => t.title)).toEqual(['child']);
  });

  it('lists a task waiting in review for its reviewer', () => {
    const task = newTask(h.db, { title: 'in review', reviewer: REVIEWER });
    reviewRequested(task.taskId, 'implemented');
    expect(claimableTasks(h.db, NOW).map((t) => [t.title, t.phase])).toEqual([['in review', 'review']]);
  });

  it('leaves out a task whose run has reported but is not closed', () => {
    const task = newTask(h.db, { title: 'reported', reviewer: REVIEWER });
    const run = claimed(h.db, task.taskId);
    expect(requestReview(h.db, task.taskId, { kind: 'run', runId: run.runId }, { summary: 'done' }, NOW).ok).toBe(true);
    // In review, but its work run still holds the workspace.
    expect(claimableTasks(h.db, NOW)).toEqual([]);
    expect(closeRun(h.db, run.runId, NOW).ok).toBe(true);
    expect(claimableTasks(h.db, NOW).map((t) => t.title)).toEqual(['reported']);
  });

  it('leaves out blocked and done tasks', () => {
    const blocked = newTask(h.db, { title: 'blocked', workspace: 'web' });
    const run = claimed(h.db, blocked.taskId);
    expect(
      block(h.db, blocked.taskId, { kind: 'run', runId: run.runId }, { kind: 'needs_input', reason: 'which format?' }, NOW).ok,
    ).toBe(true);
    expect(closeRun(h.db, run.runId, NOW).ok).toBe(true);
    const done = newTask(h.db, { title: 'done', workspace: 'api' });
    expect(complete(h.db, done.taskId, { kind: 'person', principal: ALICE }, { summary: 'by hand' }, NOW).ok).toBe(true);
    newTask(h.db, { title: 'ready' });
    expect(claimableTasks(h.db, NOW).map((t) => t.title)).toEqual(['ready']);
  });

  it('lists a task whose parent was archived', () => {
    const parent = newTask(h.db, { title: 'parent' });
    newTask(h.db, { title: 'child', parents: [parent.taskId] });
    expect(archive(h.db, parent.taskId, ALICE, NOW).ok).toBe(true);
    expect(claimableTasks(h.db, NOW).map((t) => t.title)).toEqual(['child']);
  });
});

describe('latestCompletion', () => {
  it("gives a run's summary and metadata, as reported", () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    expect(
      complete(h.db, task.taskId, { kind: 'run', runId: run.runId }, { summary: 'parsed', metadata: { files: 2 } }, NOW).ok,
    ).toBe(true);
    expect(latestCompletion(h.db, task.taskId)).toEqual({ summary: 'parsed', metadata: { files: 2 }, runId: run.runId });
  });

  it("gives a person's summary from the event, with no metadata", () => {
    const task = newTask(h.db);
    expect(complete(h.db, task.taskId, { kind: 'person', principal: ALICE }, { summary: 'by hand' }, NOW).ok).toBe(true);
    expect(latestCompletion(h.db, task.taskId)).toEqual({ summary: 'by hand', metadata: null, runId: null });
  });

  it("gives the implementer's handoff, not the reviewer's approval, for a task that went through review", () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    reviewRequested(task.taskId, 'first try', { pr: 1 });
    const review1 = claimed(h.db, task.taskId);
    expect(requestChanges(h.db, task.taskId, { kind: 'run', runId: review1.runId }, 'handle the BOM', NOW).ok).toBe(true);
    expect(closeRun(h.db, review1.runId, NOW).ok).toBe(true);
    const rework = reviewRequested(task.taskId, 'parses with or without a BOM', { pr: 2 });
    const review2 = claimed(h.db, task.taskId);
    expect(complete(h.db, task.taskId, { kind: 'run', runId: review2.runId }, { summary: 'LGTM' }, NOW).ok).toBe(true);
    expect(latestCompletion(h.db, task.taskId)).toEqual({
      summary: 'parses with or without a BOM',
      metadata: { pr: 2 },
      runId: rework,
    });
  });

  it('is undefined for a task never completed', () => {
    expect(latestCompletion(h.db, newTask(h.db).taskId)).toBeUndefined();
  });
});
