import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { commentsOf, eventsOf, getTask, membersOf } from '../src/db/kanban-read.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { VI_WORKFLOW, madeOf, viBoard, workerRun, type ViBoard } from './helpers/routing.js';

/**
 * The worker's `unblock` (workflow routing spec §5.4): a handler's work run lifts
 * the block of the task its route was made from, authorised by the route row
 * alone, its comment steering, prefixed with the handler's ref; a repeat by the
 * same run answers ok with nothing changed; any other task, a run that is no
 * handler's, and a review run of one refused `wrong_task`; `stale` once another
 * lifted the block.
 */

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  b = viBoard(h, { limits: { failureLimit: 1, transientLimit: 10, transientCooldownS: 300 } });
});
afterEach(() => h.close());

const CVE = { kind: 'cve', verify: false, patch: false, bnpm: false, packages: [] };

/** va given up and routed: its task, the handler's, and the intake's. */
async function routed(): Promise<{ va: string; escalate: string; intake: string }> {
  const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
  const intake = w.tasks[0]?.taskId ?? '';
  const run = claimed(h.db, intake);
  await b.service.complete(intake, { kind: 'run', runId: run.runId }, { summary: 'x', metadata: CVE });
  closeRun(h.db, run.runId, NOW);
  const va = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'va')?.taskId ?? '';
  const vaRun = claimed(h.db, va);
  b.service.endRun(vaRun.runId, { outcome: 'crashed' });
  closeRun(h.db, vaRun.runId, NOW);
  const escalate = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'escalate')?.taskId ?? '';
  return { va, escalate, intake };
}

describe("a handler's unblock", () => {
  it('lifts the block of the task its route was made from, its comment steering, and answers a repeat ok, changed false', async () => {
    const { va, escalate } = await routed();
    const run = workerRun(b.service, h.db, escalate);
    expect(await run.ask('unblock', { task_id: va, comment: 'the registry answers again' })).toEqual({ ok: true, task_id: va, phase: 'open', changed: true });
    expect(getTask(h.db, va)).toMatchObject({ phase: 'open', consecutiveFailures: 0 });
    expect(eventsOf(h.db, va).find((e) => e.kind === 'unblocked')).toMatchObject({ actor: `run:${run.runId}` });
    expect(commentsOf(h.db, va).map((c) => c.body)).toEqual(['(by the handler escalate:1) the registry answers again']);
    expect(await run.ask('unblock', { task_id: va })).toEqual({ ok: true, task_id: va, phase: 'open', changed: false });
  });

  it('is authorised by the route row alone: an edited body changes nothing, and a run with no route row is refused', async () => {
    const { va, escalate, intake } = await routed();
    h.db.prepare("UPDATE kanban_tasks SET body = '' WHERE task_id = ?").run(escalate);
    const run = workerRun(b.service, h.db, escalate);
    expect(await run.ask('unblock', { task_id: intake })).toEqual({ ok: false, code: 'wrong_task', message: `run ${run.runId} may unblock only the task its handler was routed from` });
    expect((await run.ask('unblock', { task_id: va })).ok).toBe(true);
  });

  it('refuses a run that is no handler\'s, and stale once another lifted the block', async () => {
    const { va, escalate } = await routed();
    const run = workerRun(b.service, h.db, escalate);
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    expect(await run.ask('unblock', { task_id: va })).toEqual({ ok: false, code: 'stale', message: `the block of task ${va} the handler escalate:1 was routed from has been lifted already` });
    // The handler's run stopped and closed, so va's next run may take the workspace.
    expect(b.service.stop(escalate, ALICE).ok).toBe(true);
    closeRun(h.db, run.runId, NOW);
    const other = workerRun(b.service, h.db, va);
    expect(await other.ask('unblock', { task_id: va })).toEqual({ ok: false, code: 'wrong_task', message: `run ${other.runId} may unblock only the task its handler was routed from` });
  });

  it('refuses a review run of a handler', async () => {
    // escalate helps, and has a reviewer of its own.
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW.replace('    handler: true\n    stands_in_for: va\n    outputs:\n      reachable: boolean\n', '    handler: true\n    reviewer: verifier\n'));
    const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-2' } }, createdBy: ALICE, createdVia: VIA }));
    const intake = w.tasks[0]?.taskId ?? '';
    const ir = claimed(h.db, intake);
    await b.service.complete(intake, { kind: 'run', runId: ir.runId }, { summary: 'x', metadata: CVE });
    closeRun(h.db, ir.runId, NOW);
    const va = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'va')?.taskId ?? '';
    const vr = claimed(h.db, va);
    b.service.endRun(vr.runId, { outcome: 'crashed' });
    closeRun(h.db, vr.runId, NOW);
    const help = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'escalate')?.taskId ?? '';
    const work = claimed(h.db, help);
    expect((await b.service.complete(help, { kind: 'run', runId: work.runId }, { summary: 'looked' })).ok).toBe(true);
    closeRun(h.db, work.runId, NOW);
    const review = workerRun(b.service, h.db, help);
    expect(await review.ask('unblock', { task_id: va })).toEqual({ ok: false, code: 'wrong_task', message: `run ${review.runId} may unblock only the task its handler was routed from` });
  });
});
