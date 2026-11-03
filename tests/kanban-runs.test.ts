import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  claim,
  closeRun,
  complete,
  endRun,
  requestReview,
  unblock,
  type RunEnding,
} from '../src/db/kanban.js';
import { eventsOf, getRun, getTask } from '../src/db/kanban-read.js';
import type { NewTask } from '../src/db/kanban.js';
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

const SEC = 1000;

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

/** Claim the task, end the run this way, and close it, as plan C2 will once its turn is over. */
function attempt(taskId: string, ending: RunEnding, limits = DEFAULT_LIMITS, now = NOW) {
  const run = claimed(h.db, taskId, {}, now);
  const r = ok(endRun(h.db, run.runId, ending, limits, now));
  ok(closeRun(h.db, run.runId, now));
  return r;
}

function task(t: Partial<NewTask> = {}): string {
  return newTask(h.db, t).taskId;
}

describe('endRun', () => {
  it('counts a failure, records it, and leaves the task to be claimed again', () => {
    addSecrets(['sk-test-123456']);
    const id = task();
    const run = claimed(h.db, id);
    const r = endRun(
      h.db,
      run.runId,
      { outcome: 'failed', error: 'exit 1 with sk-test-123456', lastOutput: 'tests failed' },
      DEFAULT_LIMITS,
      NOW,
    );
    expect(r).toMatchObject({
      ok: true,
      next: 'retry',
      task: { phase: 'open', consecutiveFailures: 1 },
      run: { outcome: 'failed', error: `exit 1 with ${MASK}`, lastOutput: 'tests failed', endedAt: null },
    });
    expect(eventsOf(h.db, id).at(-1)).toMatchObject({
      kind: 'run_ended',
      payload: { outcome: 'failed', error: `exit 1 with ${MASK}`, next: 'retry', blockKind: null },
    });
    ok(closeRun(h.db, run.runId, NOW));
    expect(claimed(h.db, id).attempt).toBe(2);
  });

  it('gives up at the failure limit, keeping the outcome that used it up', () => {
    const id = task();
    attempt(id, { outcome: 'failed' });
    const r = attempt(id, { outcome: 'crashed', error: 'exited without finishing' });
    expect(r).toMatchObject({
      next: 'blocked',
      run: { outcome: 'crashed' },
      task: {
        phase: 'blocked',
        blockKind: 'gave_up',
        blockReason: 'failed 2 times; last crashed: exited without finishing',
        consecutiveFailures: 2,
      },
    });
  });

  it("uses the task's own failure limit: 1 means no retries", () => {
    expect(attempt(task({ failureLimit: 1 }), { outcome: 'timed_out' })).toMatchObject({
      next: 'blocked',
      task: { blockKind: 'gave_up' },
    });
  });

  it('counts a failing review run, and leaves the task in review for the reviewer', () => {
    const id = task({ reviewer: { kind: 'role', name: 'reviewer' } });
    const work = claimed(h.db, id);
    ok(requestReview(h.db, id, { kind: 'run', runId: work.runId }, { summary: 'v1' }, NOW));
    ok(closeRun(h.db, work.runId, NOW));
    expect(attempt(id, { outcome: 'crashed' })).toMatchObject({
      next: 'retry',
      run: { kind: 'review', outcome: 'crashed' },
      task: { phase: 'review', consecutiveFailures: 1 },
    });
    expect(claimed(h.db, id)).toMatchObject({ kind: 'review', attempt: 3 });
  });

  it('resets the failure count on completion, and on unblocking a task that gave up', () => {
    const a = task();
    attempt(a, { outcome: 'protocol_violation' });
    const run = claimed(h.db, a);
    expect(
      ok(complete(h.db, a, { kind: 'run', runId: run.runId }, { summary: 'done' }, NOW)).task.consecutiveFailures,
    ).toBe(0);
    ok(closeRun(h.db, run.runId, NOW));

    const b = task({ failureLimit: 1 });
    attempt(b, { outcome: 'failed' });
    expect(ok(unblock(h.db, b, ALICE, undefined, NOW)).task).toMatchObject({
      phase: 'open',
      consecutiveFailures: 0,
      blockRecurrences: 0,
    });
  });

  it('does not count throttling, and holds the task in a doubling cooldown', () => {
    const id = task();
    expect(attempt(id, { outcome: 'rate_limited' })).toMatchObject({
      next: 'cooldown',
      task: { phase: 'open', consecutiveFailures: 0, consecutiveTransient: 1, cooldownUntil: NOW + 300 * SEC },
    });
    const early = claim(h.db, { taskId: id, claimant: claimantFor(h.db, id), workspaces: WORKSPACES }, NOW + 299 * SEC);
    expect(early).toEqual({
      ok: false,
      code: 'not_claimable',
      message: `task ${id} is cooling down after being throttled`,
    });
    expect(attempt(id, { outcome: 'rate_limited' }, DEFAULT_LIMITS, NOW + 300 * SEC).task.cooldownUntil).toBe(
      NOW + 900 * SEC,
    );
  });

  it('caps the cooldown at an hour, blocks as transient at the limit, and unblocking resets it', () => {
    const limits = { ...DEFAULT_LIMITS, transientLimit: 3, transientCooldownS: 2000 };
    const id = task();
    expect(attempt(id, { outcome: 'rate_limited' }, limits, NOW).task.cooldownUntil).toBe(NOW + 2000 * SEC);
    expect(attempt(id, { outcome: 'rate_limited' }, limits, NOW + 2000 * SEC).task.cooldownUntil).toBe(
      NOW + 5600 * SEC,
    );
    expect(attempt(id, { outcome: 'rate_limited' }, limits, NOW + 5600 * SEC)).toMatchObject({
      next: 'blocked',
      task: { blockKind: 'transient', blockReason: 'throttled 3 times in a row' },
    });
    expect(ok(unblock(h.db, id, ALICE, undefined, NOW)).task).toMatchObject({
      consecutiveTransient: 0,
      cooldownUntil: null,
    });
  });

  it('resets the throttling count on any other outcome', () => {
    const id = task();
    attempt(id, { outcome: 'rate_limited' });
    expect(attempt(id, { outcome: 'failed' }, DEFAULT_LIMITS, NOW + 300 * SEC).task.consecutiveTransient).toBe(0);
  });

  it('blocks at once on a terminal provider error, without counting it', () => {
    expect(attempt(task(), { outcome: 'terminal_provider', error: '401 unauthorized' })).toMatchObject({
      next: 'blocked',
      task: { blockKind: 'capability', blockReason: '401 unauthorized', consecutiveFailures: 0 },
    });
  });

  it('does not count an interruption', () => {
    expect(attempt(task(), { outcome: 'interrupted' })).toMatchObject({
      next: 'retry',
      task: { phase: 'open', consecutiveFailures: 0 },
    });
  });

  it('with if-no-side-effects, asks a person before retrying a run that changed things', () => {
    const careful = { retryOnCrash: 'if-no-side-effects' } as const;
    expect(attempt(task(careful), { outcome: 'failed', hadSideEffects: true })).toMatchObject({
      next: 'blocked',
      task: {
        blockKind: 'needs_input',
        blockReason: 'the run ended failed after changing things; look before it is retried',
      },
    });
    expect(attempt(task(careful), { outcome: 'failed', hadSideEffects: false }).next).toBe('retry');
    expect(attempt(task(careful), { outcome: 'interrupted', hadSideEffects: true }).task.blockKind).toBe('needs_input');
    const throttled = attempt(task(careful), { outcome: 'rate_limited', hadSideEffects: true }).task;
    expect(throttled).toMatchObject({ blockKind: 'needs_input', consecutiveTransient: 1 });
    // Unblocking it is not unblocking a transient block: the throttling count stands (spec §8.2).
    expect(ok(unblock(h.db, throttled.taskId, ALICE, undefined, NOW)).task.consecutiveTransient).toBe(1);
    expect(attempt(task(), { outcome: 'failed', hadSideEffects: true }).next).toBe('retry');
  });

  it("never overwrites a decided run's outcome, and refuses a closed run", () => {
    const id = task();
    const run = claimed(h.db, id);
    ok(complete(h.db, id, { kind: 'run', runId: run.runId }, { summary: 'done' }, NOW));
    expect(endRun(h.db, run.runId, { outcome: 'timed_out' }, DEFAULT_LIMITS, NOW)).toEqual({
      ok: false,
      code: 'already_decided',
      message: `run ${run.runId} already has its outcome (completed), which stands`,
    });
    expect(getRun(h.db, run.runId)?.outcome).toBe('completed');
    expect(getTask(h.db, id)?.consecutiveFailures).toBe(0);
    ok(closeRun(h.db, run.runId, NOW));
    expect(endRun(h.db, run.runId, { outcome: 'interrupted' }, DEFAULT_LIMITS, NOW)).toMatchObject({
      ok: false,
      code: 'already_closed',
    });
  });

  it("refuses a person's run", () => {
    const id = task({ assignee: { kind: 'human', name: 'lark:on_bob' } });
    const run = claimed(h.db, id);
    expect(endRun(h.db, run.runId, { outcome: 'timed_out' }, DEFAULT_LIMITS, NOW)).toEqual({
      ok: false,
      code: 'invalid',
      message: `run ${run.runId} is a person's: it has no process to end`,
    });
  });
});
