import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachSession, block, claim, closeRun, complete, link, requestChanges, requestReview } from '../src/db/kanban.js';
import { eventsOf, getRun, getTask, runsOf, taskView } from '../src/db/kanban-read.js';
import { createSession } from '../src/db/sessions.js';
import type { Reporter, RunRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { AGENT, ALICE, NOW, WORKSPACES, claimantFor, claimed, newTask } from './helpers/kanban.js';

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
const REVIEWER = { kind: 'role', name: 'reviewer' } as const;
const asRun = (run: RunRow): Reporter => ({ kind: 'run', runId: run.runId });
const asPerson = (principal: string): Reporter => ({ kind: 'person', principal });

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

/** A finished task in a workspace, as a person leaves one: done, with no agent involved. */
function doneIn(workspace: string | null): string {
  const task = newTask(h.db, { assignee: BOB, workspace });
  if (workspace !== null) claimed(h.db, task.taskId);
  ok(complete(h.db, task.taskId, asPerson('lark:on_bob'), { summary: 'done' }, NOW));
  return task.taskId;
}

describe('complete', () => {
  it("completes a running task from its run's report, and frees its children", () => {
    const task = newTask(h.db);
    const child = newTask(h.db, { parents: [task.taskId] });
    const run = claimed(h.db, task.taskId);
    const r = complete(
      h.db,
      task.taskId,
      asRun(run),
      { summary: 'parser written', metadata: { files: 2 }, reportedCommit: 'abc123', reportedDirty: false },
      NOW + 10,
    );
    expect(r).toMatchObject({
      ok: true,
      task: { phase: 'done', closedAt: NOW + 10, consecutiveFailures: 0 },
      run: {
        outcome: 'completed',
        summary: 'parser written',
        metadata: { files: 2 },
        reportedCommit: 'abc123',
        reportedDirty: false,
        endedAt: null,
      },
    });
    expect(taskView(h.db, child.taskId)?.status).toBe('ready');
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({
      kind: 'completed',
      runId: run.runId,
      actor: `run:${run.runId}`,
      payload: { summary: 'parser written' },
    });
  });

  it('masks the summary, the metadata and the event on write', () => {
    addSecrets(['sk-test-123456']);
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    const r = ok(
      complete(
        h.db,
        task.taskId,
        asRun(run),
        { summary: 'rotated sk-test-123456', metadata: { key: 'sk-test-123456', files: 2 } },
        NOW,
      ),
    );
    expect(r.run).toMatchObject({ summary: `rotated ${MASK}`, metadata: { key: MASK, files: 2 } });
    expect(eventsOf(h.db, task.taskId).at(-1)?.payload).toEqual({ summary: `rotated ${MASK}` });
  });

  it('masks metadata under any key, and in its keys, since an agent shapes it', () => {
    addSecrets(['sk-test-123456']);
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    const metadata = {
      sessionId: 'sk-test-123456',
      idempotencyKey: ['sk-test-123456'],
      'sk-test-123456': { messageId: 'sk-test-123456', files: 2 },
    };
    const r = ok(complete(h.db, task.taskId, asRun(run), { summary: 'done', metadata }, NOW));
    const stored = JSON.stringify(getRun(h.db, run.runId)?.metadata);
    expect(stored).not.toContain('sk-test-123456');
    expect(r.run?.metadata).toEqual({
      sessionId: MASK,
      idempotencyKey: [MASK],
      [MASK]: { messageId: MASK, files: 2 },
    });
  });

  it('masks a reported commit on write', () => {
    addSecrets(['sk-test-123456']);
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    const r = ok(complete(h.db, task.taskId, asRun(run), { summary: 'done', reportedCommit: 'sk-test-123456' }, NOW));
    expect(r.run?.reportedCommit).toBe(MASK);
  });

  it('keeps the reporting run open, holding its workspace, until it is closed', () => {
    // The agent usually keeps going after it reports, in the same checkout.
    const task = newTask(h.db);
    const child = newTask(h.db, { parents: [task.taskId] });
    const run = claimed(h.db, task.taskId);
    ok(complete(h.db, task.taskId, asRun(run), { summary: 'done' }, NOW));
    const blocked = claim(
      h.db,
      { taskId: child.taskId, claimant: claimantFor(h.db, child.taskId), workspaces: WORKSPACES },
      NOW,
    );
    expect(blocked).toMatchObject({ ok: false, code: 'workspace_busy' });
    expect(closeRun(h.db, run.runId, NOW + 1)).toMatchObject({ ok: true, run: { endedAt: NOW + 1 } });
    expect(claimed(h.db, child.taskId).workspace).toBe('default');
  });

  it('refuses a second report from a run, a report after it is closed, and one on another task', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    ok(complete(h.db, task.taskId, asRun(run), { summary: 'done' }, NOW));
    expect(complete(h.db, task.taskId, asRun(run), { summary: 'again' }, NOW)).toEqual({
      ok: false,
      code: 'already_reported',
      message: `run ${run.runId} has already reported (completed)`,
    });
    ok(closeRun(h.db, run.runId, NOW));
    expect(complete(h.db, task.taskId, asRun(run), { summary: 'late' }, NOW)).toEqual({
      ok: false,
      code: 'run_superseded',
      message: `run ${run.runId} is over`,
    });
    const other = newTask(h.db);
    expect(complete(h.db, other.taskId, asRun(run), { summary: 'x' }, NOW)).toMatchObject({
      ok: false,
      code: 'wrong_task',
    });
  });

  it('refuses to complete a task whose parent is not done', () => {
    const parent = newTask(h.db);
    const child = newTask(h.db, { parents: [parent.taskId] });
    expect(complete(h.db, child.taskId, asPerson(ALICE), { summary: 'x' }, NOW)).toEqual({
      ok: false,
      code: 'parents_unfinished',
      message: `task ${child.taskId} has a parent that is not done`,
    });
  });

  it('lets a person complete their task, deciding and closing their own run', () => {
    const task = newTask(h.db, { assignee: BOB });
    const run = claimed(h.db, task.taskId);
    const r = ok(complete(h.db, task.taskId, asPerson('lark:on_bob'), { summary: 'did it' }, NOW + 3));
    expect(r.run).toMatchObject({ runId: run.runId, outcome: 'completed', summary: 'did it', endedAt: NOW + 3 });
    expect(r.task.phase).toBe('done');
  });

  it('refuses a person while an agent run is open: stop it first, or wait for it to finish', () => {
    const task = newTask(h.db, { reviewer: BOB });
    const run = claimed(h.db, task.taskId);
    expect(complete(h.db, task.taskId, asPerson(ALICE), { summary: 'x' }, NOW)).toEqual({
      ok: false,
      code: 'agent_run_open',
      message: `task ${task.taskId} has an agent run working on it (${run.runId}); stop it first`,
    });
    ok(requestReview(h.db, task.taskId, asRun(run), { summary: 'please look' }, NOW));
    expect(complete(h.db, task.taskId, asPerson('lark:on_bob'), { summary: 'approved' }, NOW)).toEqual({
      ok: false,
      code: 'agent_run_open',
      message: `task ${task.taskId}'s agent run ${run.runId} has reported and is finishing; wait for it to finish`,
    });
  });
});

describe('a review run', () => {
  it("completes the task on the reviewer's complete", () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const work = claimed(h.db, task.taskId);
    ok(requestReview(h.db, task.taskId, asRun(work), { summary: 'v1' }, NOW));
    ok(closeRun(h.db, work.runId, NOW));
    const review = claimed(h.db, task.taskId);
    expect(complete(h.db, task.taskId, asRun(review), { summary: 'approved' }, NOW + 1)).toMatchObject({
      ok: true,
      task: { phase: 'done', closedAt: NOW + 1 },
      run: { runId: review.runId, kind: 'review', outcome: 'completed', summary: 'approved' },
    });
  });

  it('refuses a public link onto a task in review: a parent added now could not hold it back', () => {
    const parent = newTask(h.db);
    const task = newTask(h.db, { reviewer: REVIEWER });
    const work = claimed(h.db, task.taskId);
    ok(requestReview(h.db, task.taskId, asRun(work), { summary: 'v1' }, NOW));
    ok(closeRun(h.db, work.runId, NOW));
    expect(link(h.db, parent.taskId, task.taskId, ALICE, NOW)).toEqual({
      ok: false,
      code: 'illegal_transition',
      message: `task ${task.taskId} is review; a parent added now could not hold it back`,
    });
  });
});

describe('complete on a task that names a reviewer', () => {
  it("sends an agent's complete to the role reviewer as a review request, with the same handoff", () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const work = claimed(h.db, task.taskId);
    const r = complete(h.db, task.taskId, asRun(work), { summary: 'parser written', metadata: { files: 2 } }, NOW + 1);
    expect(r).toMatchObject({
      ok: true,
      task: { phase: 'review', reviewer: REVIEWER, closedAt: null },
      run: { runId: work.runId, outcome: 'review_requested', summary: 'parser written', metadata: { files: 2 } },
    });
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({
      kind: 'review_requested',
      runId: work.runId,
      payload: { summary: 'parser written', reviewer: 'reviewer', reviewerKind: 'role' },
    });
    expect(eventsOf(h.db, task.taskId).map((e) => e.kind)).not.toContain('completed');
    ok(closeRun(h.db, work.runId, NOW + 2));
    expect(claimed(h.db, task.taskId)).toMatchObject({ kind: 'review', assignee: REVIEWER });
  });

  it("sends a person's done to a person reviewer the same way", () => {
    const task = newTask(h.db, { assignee: { kind: 'human', name: ALICE }, reviewer: BOB });
    const run = claimed(h.db, task.taskId);
    const r = ok(complete(h.db, task.taskId, asPerson(ALICE), { summary: 'booked' }, NOW + 1));
    expect(r.task).toMatchObject({ phase: 'review', reviewer: BOB });
    expect(r.run).toMatchObject({ runId: run.runId, outcome: 'review_requested', endedAt: NOW + 1 });
  });

  it("sends a rework's complete back to review, and completes on the reviewer's approval", () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const work = claimed(h.db, task.taskId);
    ok(complete(h.db, task.taskId, asRun(work), { summary: 'v1' }, NOW));
    ok(closeRun(h.db, work.runId, NOW));
    const review = claimed(h.db, task.taskId);
    ok(requestChanges(h.db, task.taskId, asRun(review), 'handle empty input', NOW));
    ok(closeRun(h.db, review.runId, NOW));
    const rework = claimed(h.db, task.taskId);
    expect(ok(complete(h.db, task.taskId, asRun(rework), { summary: 'v2' }, NOW)).task.phase).toBe('review');
    ok(closeRun(h.db, rework.runId, NOW));
    const second = claimed(h.db, task.taskId);
    expect(ok(complete(h.db, task.taskId, asRun(second), { summary: 'approved' }, NOW + 5)).task).toMatchObject({
      phase: 'done',
      closedAt: NOW + 5,
    });
  });

  it('still completes a task that names no reviewer, whatever its children', () => {
    const task = newTask(h.db);
    const review = newTask(h.db, { assignee: REVIEWER, parents: [task.taskId] });
    const run = claimed(h.db, task.taskId);
    expect(ok(complete(h.db, task.taskId, asRun(run), { summary: 'done' }, NOW)).task.phase).toBe('done');
    expect(taskView(h.db, review.taskId)?.status).toBe('ready');
  });
});

describe("an operator's answer while a role reviewer's run is open", () => {
  function reviewing() {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const work = claimed(h.db, task.taskId);
    ok(requestReview(h.db, task.taskId, asRun(work), { summary: 'v1' }, NOW));
    ok(closeRun(h.db, work.runId, NOW));
    return { task, work, review: claimed(h.db, task.taskId) };
  }
  const operator = (run: RunRow): Reporter => ({ kind: 'person', principal: ALICE, runId: run.runId, as: 'operator' });

  it('supersedes the run and completes the task in one transaction', () => {
    const { task, review } = reviewing();
    const r = ok(complete(h.db, task.taskId, operator(review), { summary: 'fine' }, NOW + 1));
    expect(r.task).toMatchObject({ phase: 'done', closedAt: NOW + 1 });
    expect(r.run).toMatchObject({ runId: review.runId, outcome: 'superseded', endedAt: null });
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({ kind: 'completed', runId: review.runId, actor: ALICE });
    // The reviewer's own report, later, finds its run over.
    expect(complete(h.db, task.taskId, asRun(review), { summary: 'approved' }, NOW + 2)).toMatchObject({
      ok: false,
      code: 'run_superseded',
    });
  });

  it('supersedes the run on changes, and the rework goes to the assignee once it closes', () => {
    const { task, review } = reviewing();
    const r = ok(requestChanges(h.db, task.taskId, operator(review), 'keep the old colour', NOW + 1));
    expect(r.task.phase).toBe('open');
    expect(r.run).toMatchObject({ runId: review.runId, outcome: 'superseded' });
    expect(requestChanges(h.db, task.taskId, asRun(review), 'x', NOW + 2)).toMatchObject({ code: 'run_superseded' });
    ok(closeRun(h.db, review.runId, NOW + 3));
    expect(claimed(h.db, task.taskId)).toMatchObject({ kind: 'work', assignee: { kind: 'role', name: 'implementer' } });
  });

  it('is refused to anyone answering as other than an operator, and to an operator on a work run', () => {
    const { task, review } = reviewing();
    for (const as of ['reviewer', 'assignee', undefined] as const) {
      const by: Reporter = { kind: 'person', principal: ALICE, runId: review.runId, ...(as === undefined ? {} : { as }) };
      expect(complete(h.db, task.taskId, by, { summary: 'fine' }, NOW)).toMatchObject({ ok: false });
      expect(requestChanges(h.db, task.taskId, by, 'x', NOW)).toMatchObject({ ok: false });
    }
    expect(getRun(h.db, review.runId)?.outcome).toBeNull();
    const other = newTask(h.db, { reviewer: REVIEWER, workspace: 'web' });
    const work = claimed(h.db, other.taskId);
    expect(complete(h.db, other.taskId, operator(work), { summary: 'x' }, NOW)).toMatchObject({ ok: false });
    expect(getRun(h.db, work.runId)?.outcome).toBeNull();
  });

  it("decides a person reviewer's open run as completed, as before: an operator may answer any review", () => {
    const task = newTask(h.db, { reviewer: BOB });
    const work = claimed(h.db, task.taskId);
    ok(requestReview(h.db, task.taskId, asRun(work), { summary: 'v1' }, NOW));
    ok(closeRun(h.db, work.runId, NOW));
    const review = claimed(h.db, task.taskId);
    const r = ok(complete(h.db, task.taskId, operator(review), { summary: 'fine' }, NOW + 1));
    expect(r.task.phase).toBe('done');
    expect(r.run).toMatchObject({ runId: review.runId, outcome: 'completed', endedAt: NOW + 1 });
  });

  it("refuses an operator's block while the reviewer's run is open: only an answer takes the review", () => {
    const { task, review } = reviewing();
    expect(block(h.db, task.taskId, operator(review), { kind: 'needs_input', reason: 'hold on' }, NOW)).toMatchObject({
      ok: false,
      code: 'agent_run_open',
    });
    expect(getRun(h.db, review.runId)?.outcome).toBeNull();
    expect(getTask(h.db, task.taskId)?.phase).toBe('review');
  });

  it('is refused while the reviewer has reported and its run is finishing', () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const work = claimed(h.db, task.taskId);
    ok(requestReview(h.db, task.taskId, asRun(work), { summary: 'v1' }, NOW));
    ok(closeRun(h.db, work.runId, NOW));
    const review = claimed(h.db, task.taskId);
    // A dependency block keeps the task in review, with the run decided and still open.
    const parent = newTask(h.db);
    ok(block(h.db, task.taskId, asRun(review), { kind: 'dependency', reason: 'needs the API', parents: [parent.taskId] }, NOW));
    expect(complete(h.db, task.taskId, operator(review), { summary: 'fine' }, NOW)).toMatchObject({
      code: 'agent_run_open',
      message: `task ${task.taskId}'s agent run ${review.runId} has reported and is finishing; wait for it to finish`,
    });
  });
});

describe('requestReview', () => {
  it("moves the task to review, with a reviewer the report names replacing the task's", () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const work = claimed(h.db, task.taskId);
    const r = requestReview(
      h.db,
      task.taskId,
      asRun(work),
      { summary: 'ready', reviewer: { kind: 'role', name: 'second-opinion' } },
      NOW,
    );
    expect(r).toMatchObject({
      ok: true,
      task: { phase: 'review', reviewer: { kind: 'role', name: 'second-opinion' } },
      run: { outcome: 'review_requested', summary: 'ready' },
    });
    expect(taskView(h.db, task.taskId)?.status).toBe('review');
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({
      kind: 'review_requested',
      payload: { summary: 'ready', reviewer: 'second-opinion', reviewerKind: 'role' },
    });
    ok(closeRun(h.db, work.runId, NOW));
    expect(claimed(h.db, task.taskId)).toMatchObject({
      kind: 'review',
      attempt: 2,
      assignee: { kind: 'role', name: 'second-opinion' },
      workspace: 'default',
    });
    expect(taskView(h.db, task.taskId)?.status).toBe('reviewing');
  });

  it('refuses a review while a parent is not done, as complete does', () => {
    const parent = newTask(h.db);
    const task = newTask(h.db, { assignee: BOB, reviewer: REVIEWER, parents: [parent.taskId] });
    expect(requestReview(h.db, task.taskId, asPerson('lark:on_bob'), { summary: 'have a look' }, NOW)).toEqual({
      ok: false,
      code: 'parents_unfinished',
      message: `task ${task.taskId} has a parent that is not done`,
    });
    expect(getTask(h.db, task.taskId)?.phase).toBe('open');
    expect(eventsOf(h.db, task.taskId).map((e) => e.kind)).toEqual(['created']);
  });

  it('refuses a review with nobody to review it, and leaves the run undecided', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    expect(requestReview(h.db, task.taskId, asRun(run), { summary: 'x' }, NOW)).toEqual({
      ok: false,
      code: 'no_reviewer',
      message: `nobody is named to review task ${task.taskId}`,
    });
    expect(getRun(h.db, run.runId)?.outcome).toBeNull();
  });
});

describe('requestChanges', () => {
  function reviewed(agent = AGENT, providerSessionId: string | null = 'prov_impl') {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const work = claimed(h.db, task.taskId);
    createSession(
      h.db,
      {
        id: 's_work',
        agentId: 'implementer',
        workspaceId: 'default',
        ownerPrincipal: ALICE,
        ...(providerSessionId === null ? {} : { providerSessionId }),
      },
      NOW,
    );
    ok(attachSession(h.db, work.runId, 's_work', NOW));
    ok(requestReview(h.db, task.taskId, asRun(work), { summary: 'v1' }, NOW));
    ok(closeRun(h.db, work.runId, NOW));
    const review = claimed(h.db, task.taskId);
    const r = requestChanges(h.db, task.taskId, asRun(review), 'handle empty input', NOW);
    ok(closeRun(h.db, review.runId, NOW));
    return { task, work, review, r, rework: claimed(h.db, task.taskId, { agentConfig: agent }) };
  }

  it('returns the task to open, and the next claim is a rework resuming the work run', () => {
    const { task, work, review, r, rework } = reviewed();
    expect(r).toMatchObject({
      ok: true,
      task: { phase: 'open' },
      run: { runId: review.runId, outcome: 'changes_requested', summary: 'handle empty input' },
    });
    expect(rework).toMatchObject({ kind: 'work', attempt: 3, seededFromRun: work.runId });
    // The run's reviewer, as it was, for the notice: the actor is the run.
    expect(eventsOf(h.db, task.taskId).find((e) => e.kind === 'changes_requested')?.payload).toEqual({
      reason: 'handle empty input',
      reviewer: 'reviewer',
      reviewerKind: 'role',
    });
  });

  it('does not seed a rework on another agent, or from a session that saw no provider session', () => {
    expect(reviewed({ ...AGENT, args: ['run', '-m', 'model-b'] }).rework.seededFromRun).toBeNull();
    h.close();
    h = testDb();
    // A changed environment does not make a conversation unresumable.
    expect(reviewed({ ...AGENT, envNames: ['OTHER_KEY'] }).rework.seededFromRun).not.toBeNull();
    h.close();
    h = testDb();
    expect(reviewed(AGENT, null).rework.seededFromRun).toBeNull();
  });

  it('does not seed a rework from an id the CLI driver stored before it could resume', () => {
    // A `cli:` id names the work run's runtime, not a provider session (native resume).
    expect(reviewed(AGENT, 'cli:1a2b3c4d').rework.seededFromRun).toBeNull();
  });

  it('refuses changes from a work run', () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const run = claimed(h.db, task.taskId);
    expect(requestChanges(h.db, task.taskId, asRun(run), 'x', NOW)).toEqual({
      ok: false,
      code: 'illegal_transition',
      message: `task ${task.taskId} is open, so it cannot have changes requested`,
    });
  });
});

describe('closeRun', () => {
  it('closes a decided run once, and refuses an undecided one', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    expect(closeRun(h.db, run.runId, NOW)).toEqual({
      ok: false,
      code: 'undecided',
      message: `run ${run.runId} has no outcome yet; record one first`,
    });
    ok(complete(h.db, task.taskId, asRun(run), { summary: 'done' }, NOW));
    ok(closeRun(h.db, run.runId, NOW + 1));
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({ kind: 'run_closed', payload: { outcome: 'completed' } });
    expect(closeRun(h.db, run.runId, NOW + 2)).toMatchObject({ ok: false, code: 'already_closed' });
  });
});

describe('a workspace from the parents', () => {
  it("is the parents' common one, ignoring a parent whose workspace was never fixed", () => {
    const child = newTask(h.db, { parents: [doneIn('api'), doneIn('api'), doneIn(null)] });
    expect(claimed(h.db, child.taskId).workspace).toBe('api');
    expect(getTask(h.db, child.taskId)?.workspace).toBe('api');
  });

  it("leaves an agent task unassignable when they disagree, and claims a person's with no workspace", () => {
    const web = doneIn('web');
    const api = doneIn('api');
    const agentTask = newTask(h.db, { parents: [web, api] });
    expect(
      claim(
        h.db,
        { taskId: agentTask.taskId, claimant: claimantFor(h.db, agentTask.taskId), workspaces: WORKSPACES },
        NOW,
      ),
    ).toEqual({
      ok: false,
      code: 'unassignable',
      message: `task ${agentTask.taskId}'s parents are in different workspaces (api, web); set its workspace`,
    });
    expect(runsOf(h.db, agentTask.taskId)).toEqual([]);
    // A person's run does not use the workspace, so the task is still claimed.
    const personTask = newTask(h.db, { parents: [web, api], assignee: BOB });
    expect(claimed(h.db, personTask.taskId)).toMatchObject({ workspace: null, agentConfig: null });
    expect(getTask(h.db, personTask.taskId)?.workspace).toBeNull();
  });

  it('is resolved afresh by an agent claim after a person left it null', () => {
    const web = doneIn('web');
    const api = doneIn('api');
    const task = newTask(h.db, { parents: [web, api], assignee: BOB, reviewer: REVIEWER });
    claimed(h.db, task.taskId);
    ok(requestReview(h.db, task.taskId, asPerson('lark:on_bob'), { summary: 'have a look' }, NOW));
    expect(getTask(h.db, task.taskId)?.workspace).toBeNull();
    // The rules apply again: the parents still disagree, so only the role's own workspace settles it.
    expect(
      claim(h.db, { taskId: task.taskId, claimant: claimantFor(h.db, task.taskId), workspaces: WORKSPACES }, NOW),
    ).toMatchObject({ ok: false, code: 'unassignable' });
    expect(claimed(h.db, task.taskId, { roleWorkspace: 'docs' })).toMatchObject({ kind: 'review', workspace: 'docs' });
    expect(getTask(h.db, task.taskId)?.workspace).toBe('docs');
  });
});
