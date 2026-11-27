import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { instanceStatus } from '../src/kanban/workflow.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * A routed instance's status (workflow routing spec §12.4): a waiting step, and
 * a skipped step not yet settled, one unfinished each, so the instance is never
 * done while one is; a skipped step, settled, finished; members and unmade steps
 * counted together; the same from `instances`' aggregate and from `instance`.
 */

describe('instanceStatus with steps not made', () => {
  it('counts a waiting step and an unsettled skip as unfinished, and a settled skip as finished', () => {
    expect(instanceStatus(['done'], { waiting: 1, skippedUnsettled: 0, skippedSettled: 0 })).toEqual({ status: 'running', done: 1, total: 2, blocked: 0 });
    expect(instanceStatus(['done'], { waiting: 0, skippedUnsettled: 1, skippedSettled: 0 })).toEqual({ status: 'running', done: 1, total: 2, blocked: 0 });
    expect(instanceStatus(['done', 'archived'], { waiting: 0, skippedUnsettled: 0, skippedSettled: 2 })).toEqual({ status: 'done', done: 4, total: 4, blocked: 0 });
    expect(instanceStatus(['blocked'], { waiting: 3, skippedUnsettled: 0, skippedSettled: 0 })).toEqual({ status: 'blocked', done: 0, total: 4, blocked: 1 });
    expect(instanceStatus(['done'])).toEqual({ status: 'done', done: 1, total: 1, blocked: 0 });
  });
});

describe("a routed instance's status", () => {
  let h: TestDb;
  let b: ViBoard;
  beforeEach(() => {
    clearSecrets();
    h = testDb();
    b = viBoard(h);
    writeFileSync(
      join(b.dir, 'flow.yaml'),
      'board: vi\nsteps:\n  a:\n    title: a\n    assignee: vi-coordinator\n    outputs: { go: boolean }\n  b:\n    title: b\n    assignee: verifier\n    parents: [a]\n    when: [{ step: a, output: go, is: true }]\n',
    );
  });
  afterEach(() => h.close());

  it('is running while a step waits, and done once it is skipped and settled, in instance and instances alike', async () => {
    const w = madeOf(b.service.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
    const id = w.instance.instanceId;
    expect(b.service.instance(id)).toMatchObject({ ok: true, view: { status: 'running', done: 0, total: 2 } });
    expect(b.service.instances('vi').instances.map((s) => [s.status, s.done, s.total])).toEqual([['running', 0, 2]]);
    const a = w.tasks[0]?.taskId ?? '';
    const run = claimed(h.db, a);
    expect((await b.service.complete(a, { kind: 'run', runId: run.runId }, { summary: 'no', metadata: { go: false } })).ok).toBe(true);
    closeRun(h.db, run.runId, NOW);
    expect(b.service.instance(id)).toMatchObject({ ok: true, view: { status: 'done', done: 2, total: 2 } });
    expect(b.service.instances('vi', true).instances.map((s) => [s.status, s.done, s.total])).toEqual([['done', 2, 2]]);
  });
});
