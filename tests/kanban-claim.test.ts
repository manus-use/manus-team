import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  attachSession,
  block,
  claim,
  closeRun,
  createTask,
  endRun,
  requestReview,
} from '../src/db/kanban.js';
import { eventsOf, getRun, getTask, parentsOf, runsOf, taskView } from '../src/db/kanban-read.js';
import { createSession } from '../src/db/sessions.js';
import { testDb, type TestDb } from './helpers/db.js';
import { AGENT, ALICE, NOW, WORKSPACES, claimantFor, claimed, newTask } from './helpers/kanban.js';

let h: TestDb;

beforeEach(() => {
  h = testDb();
});

afterEach(() => h.close());

const BOB = { kind: 'human', name: 'lark:on_bob' } as const;

function tryClaim(taskId: string, extra: Parameters<typeof claimantFor>[2] = {}, now = NOW) {
  return claim(h.db, { taskId, claimant: claimantFor(h.db, taskId, extra), workspaces: WORKSPACES }, now);
}

describe('claim', () => {
  it('opens a work run on a ready task, and records the claim', () => {
    const task = newTask(h.db);
    const r = claim(
      h.db,
      {
        taskId: task.taskId,
        claimant: claimantFor(h.db, task.taskId),
        tokenHash: 'hash-of-token',
        workspaces: WORKSPACES,
      },
      NOW + 5,
    );
    expect(r).toMatchObject({
      ok: true,
      run: {
        taskId: task.taskId,
        attempt: 1,
        kind: 'work',
        assignee: { kind: 'role', name: 'implementer' },
        agentConfig: AGENT,
        workspace: 'default',
        roleMdHash: 'hash-of-role-md',
        tokenHash: 'hash-of-token',
        sessionId: null,
        seededFromRun: null,
        outcome: null,
        submissions: 0,
        startedAt: NOW + 5,
        endedAt: null,
      },
      task: { workspace: 'default', phase: 'open' },
    });
    if (!r.ok) return;
    expect(r.run.runId).toMatch(/^r_/);
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({
      kind: 'claimed',
      runId: r.run.runId,
      payload: { kind: 'work', attempt: 1, assignee: 'implementer', workspace: 'default', seededFromRun: null },
    });
    expect(taskView(h.db, task.taskId)?.status).toBe('running');
  });

  it('refuses a second claim while a run is open', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    expect(tryClaim(task.taskId)).toEqual({
      ok: false,
      code: 'run_open',
      message: `task ${task.taskId} already has an open run, ${run.runId}`,
    });
    expect(runsOf(h.db, task.taskId)).toHaveLength(1);
  });

  it('refuses a task waiting on a parent that is not done', () => {
    const parent = newTask(h.db);
    const child = newTask(h.db, { parents: [parent.taskId] });
    expect(tryClaim(child.taskId)).toMatchObject({ ok: false, code: 'not_claimable' });
  });

  it('refuses a review claim while a parent is not done', () => {
    const parent = newTask(h.db, { assignee: BOB });
    const task = newTask(h.db, { reviewer: { kind: 'role', name: 'reviewer' } });
    const work = claimed(h.db, task.taskId);
    requestReview(h.db, task.taskId, { kind: 'run', runId: work.runId }, { summary: 'v1' }, NOW);
    closeRun(h.db, work.runId, NOW);
    const review = claimed(h.db, task.taskId);
    const by = { kind: 'run', runId: review.runId } as const;
    block(h.db, task.taskId, by, { kind: 'dependency', reason: 'wait', parents: [parent.taskId] }, NOW);
    closeRun(h.db, review.runId, NOW);
    expect(getTask(h.db, task.taskId)?.phase).toBe('review');
    expect(tryClaim(task.taskId)).toEqual({
      ok: false,
      code: 'not_claimable',
      message: `task ${task.taskId} is waiting on a parent that is not done`,
    });
  });

  it('refuses a claim during a cooldown, and makes it once the cooldown is reached', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    endRun(h.db, run.runId, { outcome: 'rate_limited', hadSideEffects: false }, DEFAULT_LIMITS, NOW);
    closeRun(h.db, run.runId, NOW);
    const until = getTask(h.db, task.taskId)?.cooldownUntil ?? 0;
    expect(until).toBeGreaterThan(NOW);
    expect(tryClaim(task.taskId, {}, until - 1)).toEqual({
      ok: false,
      code: 'not_claimable',
      message: `task ${task.taskId} is cooling down after being throttled`,
    });
    expect(tryClaim(task.taskId, {}, until)).toMatchObject({ ok: true, run: { attempt: 2 } });
  });

  it('refuses a claim for someone the task is no longer assigned to', () => {
    const task = newTask(h.db);
    const r = tryClaim(task.taskId, { assignee: { kind: 'role', name: 'reviewer' } });
    expect(r).toEqual({
      ok: false,
      code: 'stale',
      message: `task ${task.taskId} is now for implementer, not reviewer`,
    });
  });

  it('refuses a task with no assignee as unassignable', () => {
    const task = newTask(h.db, { assignee: null });
    const r = claim(
      h.db,
      {
        taskId: task.taskId,
        claimant: {
          assignee: { kind: 'role', name: 'implementer' },
          agentConfig: AGENT,
          roleWorkspace: undefined,
          roleMdHash: null,
        },
        workspaces: WORKSPACES,
      },
      NOW,
    );
    expect(r).toEqual({ ok: false, code: 'unassignable', message: `task ${task.taskId} has no assignee` });
  });

  it("fixes the workspace from the task's own, else the role's own", () => {
    const own = newTask(h.db, { workspace: 'web' });
    expect(claimed(h.db, own.taskId, { roleWorkspace: 'docs' }).workspace).toBe('web');
    const role = newTask(h.db);
    expect(claimed(h.db, role.taskId, { roleWorkspace: 'docs' }).workspace).toBe('docs');
    expect(getTask(h.db, role.taskId)?.workspace).toBe('docs');
  });

  it('refuses an agent run in a workspace no longer configured, but not a person', () => {
    const agentTask = newTask(h.db, { workspace: 'removed' });
    expect(tryClaim(agentTask.taskId)).toEqual({
      ok: false,
      code: 'unassignable',
      message: `task ${agentTask.taskId}'s workspace removed is not configured`,
    });
    const personTask = newTask(h.db, { workspace: 'removed', assignee: BOB });
    expect(claimed(h.db, personTask.taskId).workspace).toBe('removed');
  });

  it('allows one open agent run per workspace; a person holds none', () => {
    const person = newTask(h.db, { workspace: 'web', assignee: BOB });
    claimed(h.db, person.taskId);
    const first = newTask(h.db, { workspace: 'web' });
    const run = claimed(h.db, first.taskId);
    const second = newTask(h.db, { workspace: 'web' });
    expect(tryClaim(second.taskId)).toEqual({
      ok: false,
      code: 'workspace_busy',
      message: `workspace web has an open agent run, ${run.runId}`,
    });
    const elsewhere = newTask(h.db, { workspace: 'api' });
    expect(claimed(h.db, elsewhere.taskId).workspace).toBe('api');
  });

  it('puts a task a run creates where its creator works, without a link', () => {
    const creator = newTask(h.db, { workspace: 'web', assignee: BOB });
    const run = claimed(h.db, creator.taskId);
    const r = createTask(
      h.db,
      {
        title: 'follow-up',
        assignee: { kind: 'role', name: 'implementer' },
        createdBy: `run:${run.runId}`,
        createdVia: { kind: 'run', runId: run.runId },
      },
      NOW,
    );
    if (!r.ok) throw new Error(r.message);
    expect(r.task.createdFromTask).toBe(creator.taskId);
    expect(parentsOf(h.db, r.task.taskId)).toEqual([]);
    expect(claimed(h.db, r.task.taskId).workspace).toBe('web');
  });

  it('attaches a session to an open agent run, once', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    createSession(h.db, { id: 's_run', agentId: 'implementer', workspaceId: 'default', ownerPrincipal: ALICE }, NOW);
    expect(attachSession(h.db, run.runId, 's_run', NOW)).toMatchObject({ ok: true, run: { sessionId: 's_run' } });
    expect(getRun(h.db, run.runId)?.sessionId).toBe('s_run');
    expect(attachSession(h.db, run.runId, 's_run', NOW)).toEqual({
      ok: false,
      code: 'invalid',
      message: `run ${run.runId} already has session s_run`,
    });
    const person = newTask(h.db, { assignee: BOB });
    expect(attachSession(h.db, claimed(h.db, person.taskId).runId, 's_run', NOW)).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });
});
