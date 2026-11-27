import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, getRun, membersOf, settledOf } from '../src/db/kanban-read.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { VI_WORKFLOW, madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * The runs a winning stand-in's archive supersedes (workflow routing spec
 * §9.5): the routed task's undecided run ended `superseded` and its turn
 * cancelled through the service, on every path a sweep runs by, from whatever
 * phase the routed task is in.
 */

let h: TestDb;
let b: ViBoard;
let cancelled: string[];
beforeEach(() => {
  clearSecrets();
  h = testDb();
  cancelled = [];
  b = viBoard(h, {
    limits: { failureLimit: 1, transientLimit: 10, transientCooldownS: 300 },
    cancelRun: (runId) => {
      cancelled.push(runId);
      return true;
    },
  });
});
afterEach(() => h.close());

// Registry is made with va, so another member is open beside it.
const CVE = { kind: 'cve', verify: true, patch: false, bnpm: true, packages: [] };

let instance = '';
const memberOf = (step: string) => membersOf(h.db, instance).find((m) => m.step === step)?.taskId ?? '';
const vaRow = () => settledOf(h.db, instance).find((s) => s.step === 'va');
const BOOM = "CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled WHEN NEW.step = 'va' BEGIN SELECT RAISE(ABORT, 'boom'); END;";

async function report(taskId: string, metadata: Record<string, unknown>) {
  const run = claimed(h.db, taskId);
  const r = await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'done', metadata });
  closeRun(h.db, run.runId, NOW);
  return r;
}

async function routed(file = VI_WORKFLOW): Promise<string> {
  writeFileSync(join(b.dir, 'vi-workflow.yaml'), file);
  const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
  instance = w.instance.instanceId;
  await report(w.tasks[0]?.taskId ?? '', CVE);
  return memberOf('va');
}

/** va given up, its stand-in done while the routing of va faults: va's row is still to write. */
async function stoodInUnwritten(va: string): Promise<string> {
  const run = claimed(h.db, va);
  b.service.endRun(run.runId, { outcome: 'crashed' });
  closeRun(h.db, run.runId, NOW);
  const escalate = memberOf('escalate');
  h.db.exec(BOOM);
  expect((await report(escalate, { reachable: true })).ok).toBe(true);
  expect(vaRow()).toBeUndefined();
  return escalate;
}

/** A claim of another member, in a workspace of its own: the default is held by va's rerun. */
function claimedApart(taskId: string) {
  h.db.prepare("UPDATE kanban_tasks SET workspace = 'vi' WHERE task_id = ?").run(taskId);
  const run = b.service.claim(taskId);
  if (!run.ok) throw new Error(run.message);
  return run.run;
}

const SWEEPS: [string, () => void][] = [
  ['its reconciliation', () => expect(b.service.reconcileWorkflow(instance).ok).toBe(true)],
  ['the routing retry', () => expect(b.service.retryRouting()).toBe(1)],
  ["another member's archive", () => expect(b.service.archive(memberOf('registry'), ALICE).ok).toBe(true)],
  [
    "a run's block of another member",
    () => {
      const run = claimedApart(memberOf('registry'));
      expect(b.service.block(memberOf('registry'), { kind: 'run', runId: run.runId }, { kind: 'capability', reason: 'no network' }).ok).toBe(true);
    },
  ],
  [
    "another member's give-up",
    () => {
      const run = claimedApart(memberOf('registry'));
      expect(b.service.endRun(run.runId, { outcome: 'crashed' }).ok).toBe(true);
    },
  ],
];

describe("a winning stand-in's superseded runs", () => {
  it("archives the routed task's rerun from open when the stand-in wins, its run superseded, returned and cancelled", async () => {
    const va = await routed();
    const run = claimed(h.db, va);
    b.service.endRun(run.runId, { outcome: 'crashed' });
    closeRun(h.db, run.runId, NOW);
    const escalate = memberOf('escalate');
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    const rerun = b.service.claim(va);
    if (!rerun.ok) throw new Error(rerun.message);
    // The stand-in's run, through the service: its workspace is the default's too, held by va's rerun, so it reports as a person's would not.
    const stand = claimedApart(escalate);
    const r = await b.service.complete(escalate, { kind: 'run', runId: stand.runId }, { summary: 'done', metadata: { reachable: true } });
    expect(r).toMatchObject({ ok: true, superseded: [{ runId: rerun.run.runId, outcome: 'superseded' }] });
    expect(getRun(h.db, rerun.run.runId)?.outcome).toBe('superseded');
    expect(eventsOf(h.db, va).find((e) => e.kind === 'archived')?.payload).toMatchObject({ from: 'open', standIn: escalate });
    expect(cancelled).toEqual([rerun.run.runId]);
  });

  it.each(SWEEPS)("ends the routed task's claimed rerun superseded and cancels its turn when %s writes the stand-in's row", async (_how, sweep) => {
    const va = await routed();
    const escalate = await stoodInUnwritten(va);
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    const rerun = b.service.claim(va);
    if (!rerun.ok) throw new Error(rerun.message);
    h.db.exec('DROP TRIGGER boom');
    sweep();
    expect(vaRow()).toMatchObject({ how: 'stood_in', taskId: escalate });
    expect(getRun(h.db, rerun.run.runId)?.outcome).toBe('superseded');
    expect(eventsOf(h.db, va).find((e) => e.kind === 'archived')?.payload).toMatchObject({ from: 'open', standIn: escalate });
    expect(cancelled).toEqual([rerun.run.runId]);
  });

  it("ends the routed task's review run superseded when the stand-in wins over it in review", async () => {
    const va = await routed(
      VI_WORKFLOW.replace('    assignee: vulnerability-analyst\n', '    assignee: vulnerability-analyst\n    reviewer: { role: assessment-reviewer }\n'),
    );
    const run = claimed(h.db, va);
    b.service.endRun(run.runId, { outcome: 'crashed' });
    closeRun(h.db, run.runId, NOW);
    const escalate = memberOf('escalate');
    h.db.exec(BOOM);
    expect(await report(escalate, { reachable: true })).toMatchObject({ ok: true, task: { phase: 'review' } });
    const approve = claimed(h.db, escalate);
    expect((await b.service.complete(escalate, { kind: 'run', runId: approve.runId }, { summary: 'LGTM' })).ok).toBe(true);
    closeRun(h.db, approve.runId, NOW);
    expect(vaRow()).toBeUndefined();
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    expect(await report(va, { reachable: false })).toMatchObject({ ok: true, task: { phase: 'review' } });
    const review = b.service.claim(va);
    if (!review.ok) throw new Error(review.message);
    h.db.exec('DROP TRIGGER boom');
    expect(b.service.reconcileWorkflow(instance).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'stood_in', taskId: escalate });
    expect(getRun(h.db, review.run.runId)?.outcome).toBe('superseded');
    expect(eventsOf(h.db, va).find((e) => e.kind === 'archived')?.payload).toMatchObject({ from: 'review', standIn: escalate });
    expect(cancelled).toEqual([review.run.runId]);
  });
});
