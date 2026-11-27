import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, membersOf, pendingOf, settledOf } from '../src/db/kanban-read.js';
import type { WorkflowMade } from '../src/kanban/service.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * The writer's sweep and its hooks (workflow routing spec §8, §9.1, §9.2): a
 * completion and an archive write each member's settled row, its winner the
 * earliest settling fact, and decide what is due in their transaction, here the
 * skips and the settlings, said in one workflow_routed event; a run's block and
 * its give-up decide too; and the transitions that change nothing a step reads,
 * a review request, a person's block, a stop, an unblock, changes asked and an
 * assign, decide nothing.
 */

const FLOW = `board: vi
steps:
  intake:
    title: intake
    assignee: vi-coordinator
    outputs:
      kind: { enum: [cve, supplychain] }
      verify: boolean
  va:
    title: va
    assignee: vulnerability-analyst
    parents: [intake]
    when:
      - { step: intake, output: kind, equals: cve }
  verify:
    title: verify
    assignee: verifier
    parents: [va]
    when:
      - { step: intake, output: verify, is: true }
  help:
    title: help
    assignee: verifier
    parents: [va]
    when:
      - { step: va, state: gave_up }
`;

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  b = viBoard(h);
  writeFileSync(join(b.dir, 'flow.yaml'), FLOW);
});
afterEach(() => h.close());

function start(file = FLOW): WorkflowMade {
  writeFileSync(join(b.dir, 'flow.yaml'), file);
  return madeOf(b.service.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
}

const routed = (taskId: string) => eventsOf(h.db, taskId).filter((e) => e.kind === 'workflow_routed').map((e) => e.payload as Record<string, unknown>);

describe("the writer's sweep", () => {
  it("settles a plain member at its completion and skips, in its transaction, every step whose when is false, settling each once its parents are", async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    const run = claimed(h.db, intake);
    expect((await b.service.complete(intake, { kind: 'run', runId: run.runId }, { summary: 'x', metadata: { kind: 'supplychain', verify: false } })).ok).toBe(true);
    const completed = eventsOf(h.db, intake).find((e) => e.kind === 'completed')?.id;
    expect(settledOf(h.db, w.instance.instanceId).map((s) => [s.step, s.how, s.taskId, s.eventId])).toEqual([
      ['help', 'skipped', null, completed],
      ['intake', 'done', intake, completed],
      ['va', 'skipped', null, completed],
      ['verify', 'skipped', null, completed],
    ]);
    expect(routed(intake)).toEqual([
      {
        workflow: w.instance.instanceId,
        workflowName: 'flow',
        step: 'intake',
        cause: 'completed',
        decisions: [
          { step: 'va', outcome: 'skipped', why: 'intake.kind is supplychain', taskIds: [], by: 'when' },
          { step: 'verify', outcome: 'skipped', why: 'intake.verify is false', taskIds: [], by: 'when' },
          { step: 'help', outcome: 'skipped', why: 'va did not give up', taskIds: [], by: 'when' },
        ],
      },
    ]);
    expect(pendingOf(h.db, w.instance.instanceId).find((p) => p.step === 'va')).toMatchObject({ state: 'skipped', causeEvent: completed, decidedAt: NOW });
  });

  it("skips by archive every step below a root archived undone, in the archive's transaction", () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    expect(b.service.archive(intake, ALICE).ok).toBe(true);
    expect(membersOf(h.db, w.instance.instanceId).length).toBe(1);
    expect(settledOf(h.db, w.instance.instanceId).map((s) => [s.step, s.how])).toEqual([
      ['help', 'archived'],
      ['intake', 'archived'],
      ['va', 'archived'],
      ['verify', 'archived'],
    ]);
    expect(routed(intake)[0]).toMatchObject({ cause: 'archived' });
    expect((routed(intake)[0]?.['decisions'] as unknown[]).length).toBe(3);
  });

  it('decides nothing at a review request, a person\'s block, a stop, an unblock, changes asked or an assign', async () => {
    const w = start(FLOW.replace('    assignee: vi-coordinator\n', '    assignee: vi-coordinator\n    reviewer: verifier\n'));
    const intake = w.tasks[0]?.taskId ?? '';
    const nothing = () => {
      expect(routed(intake)).toEqual([]);
      expect(settledOf(h.db, w.instance.instanceId)).toEqual([]);
      expect(membersOf(h.db, w.instance.instanceId).length).toBe(1);
      expect(pendingOf(h.db, w.instance.instanceId).every((p) => p.state === 'waiting')).toBe(true);
    };
    const run = claimed(h.db, intake);
    expect(b.service.stop(intake, ALICE).ok).toBe(true);
    closeRun(h.db, run.runId, NOW);
    nothing();
    expect(b.service.unblock(intake, ALICE).ok).toBe(true);
    expect(b.service.block(intake, { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason: 'wait' }).ok).toBe(true);
    expect(b.service.unblock(intake, ALICE).ok).toBe(true);
    expect(b.service.assign(intake, 'verifier', ALICE).ok).toBe(true);
    expect(b.service.assign(intake, 'vi-coordinator', ALICE).ok).toBe(true);
    nothing();
    const work = claimed(h.db, intake);
    expect(await b.service.requestReview(intake, { kind: 'run', runId: work.runId }, { summary: 'x', metadata: { kind: 'cve', verify: true } })).toMatchObject({ ok: true, task: { phase: 'review' } });
    closeRun(h.db, work.runId, NOW);
    nothing();
    const review = claimed(h.db, intake);
    expect(b.service.requestChanges(intake, { kind: 'run', runId: review.runId }, 'say why').ok).toBe(true);
    closeRun(h.db, review.runId, NOW);
    nothing();
  });
});
