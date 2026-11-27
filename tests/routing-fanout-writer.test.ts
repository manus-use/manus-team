import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, getTask, membersOf, parentsOf, pendingOf, settledOf } from '../src/db/kanban-read.js';
import type { WorkflowMade } from '../src/kanban/service.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * A result fan-out in the writer (workflow routing spec §4): its items made in
 * the transaction that settled their source, all at once, refs `<step>:<n>`,
 * each item in its member row and its title, the pending row their join marker;
 * the fan-out's own row written only once every item has its own; and the join's
 * child made then, linked to each item's winner and to none archived undone,
 * but to one done and then archived, its row done.
 */

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  b = viBoard(h);
});
afterEach(() => h.close());

const SUPPLY = { kind: 'supplychain', verify: false, patch: false, bnpm: true, packages: ['lodash', 'minimist', 'qs'] };

function start(): WorkflowMade {
  return madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
}

async function done(taskId: string, metadata: Record<string, unknown> = {}): Promise<void> {
  const run = claimed(h.db, taskId);
  const r = await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'did it', metadata });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  closeRun(h.db, run.runId, NOW);
}

const stepOf = (id: string, step: string) => membersOf(h.db, id).filter((m) => m.step === step);

describe('a result fan-out in the writer', () => {
  it("fans out one task an item of the intake's list in its transaction, with the join marker, and the items in one notice", async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    await done(intake, SUPPLY);
    const items = stepOf(w.instance.instanceId, 'exposure');
    expect(items.map((m) => [m.ref, m.item])).toEqual([
      ['exposure:1', 'lodash'],
      ['exposure:2', 'minimist'],
      ['exposure:3', 'qs'],
    ]);
    expect(items.map((m) => getTask(h.db, m.taskId)?.title)).toEqual(['CVE-1 · exposure of lodash', 'CVE-1 · exposure of minimist', 'CVE-1 · exposure of qs']);
    // va was skipped, and settled with intake: the items are linked to its effective parent, intake.
    expect(items.map((m) => parentsOf(h.db, m.taskId).map((p) => p.taskId))).toEqual([[intake], [intake], [intake]]);
    expect(pendingOf(h.db, w.instance.instanceId).find((p) => p.step === 'exposure')).toMatchObject({
      state: 'made',
      items: items.map((m) => ({ item: m.item, taskId: m.taskId, ref: m.ref })),
    });
    const routed = eventsOf(h.db, intake).find((e) => e.kind === 'workflow_routed')?.payload as { decisions: unknown[] };
    expect(routed.decisions).toContainEqual({
      step: 'exposure',
      outcome: 'fanned_out',
      why: 'per item of intake.packages',
      taskIds: items.map((m) => m.taskId),
      items: ['lodash', 'minimist', 'qs'],
      count: 3,
    });
  });

  it("writes the fan-out's own row only after every item's, and makes the join's child then, linked to each item but one archived undone", async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    await done(intake, SUPPLY);
    const id = w.instance.instanceId;
    const [one, two, three] = stepOf(id, 'exposure').map((m) => m.taskId);
    const registry = stepOf(id, 'registry')[0]?.taskId ?? '';
    await done(registry);
    await done(one ?? '');
    expect(b.service.archive(two ?? '', ALICE).ok).toBe(true);
    expect(settledOf(h.db, id).filter((s) => s.step === 'exposure').map((s) => [s.ref, s.how])).toEqual([
      ['exposure:1', 'done'],
      ['exposure:2', 'archived'],
    ]);
    expect(stepOf(id, 'report')).toEqual([]);
    await done(three ?? '');
    expect(settledOf(h.db, id).filter((s) => s.step === 'exposure').map((s) => [s.ref, s.how, s.taskId])).toEqual([
      ['exposure', 'done', null],
      ['exposure:1', 'done', one],
      ['exposure:2', 'archived', null],
      ['exposure:3', 'done', three],
    ]);
    const report = stepOf(id, 'report')[0]?.taskId ?? '';
    expect(parentsOf(h.db, report).map((p) => p.taskId).sort()).toEqual([intake, one, three, registry].sort());
  });

  it("links the join's child to an item done and then archived, its row done", async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    await done(intake, { ...SUPPLY, bnpm: false, packages: ['lodash', 'qs'] });
    const id = w.instance.instanceId;
    const [one, two] = stepOf(id, 'exposure').map((m) => m.taskId);
    await done(one ?? '');
    expect(b.service.archive(one ?? '', ALICE).ok).toBe(true);
    await done(two ?? '');
    expect(settledOf(h.db, id).filter((s) => s.step === 'exposure').map((s) => [s.ref, s.how, s.taskId])).toEqual([
      ['exposure', 'done', null],
      ['exposure:1', 'done', one],
      ['exposure:2', 'done', two],
    ]);
    const report = stepOf(id, 'report')[0]?.taskId ?? '';
    expect(parentsOf(h.db, report).map((p) => [p.taskId, p.phase]).sort()).toEqual(
      [
        [intake, 'done'],
        [one, 'archived'],
        [two, 'done'],
      ].sort(),
    );
  });

  it('skips the fan-out on an empty list, and its child is linked past it', async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    await done(intake, { ...SUPPLY, bnpm: false, packages: [] });
    const id = w.instance.instanceId;
    expect(pendingOf(h.db, id).find((p) => p.step === 'exposure')).toMatchObject({ state: 'skipped', reason: { by: 'source', why: 'intake.packages is empty' } });
    // Every parent of report was skipped, va's and exposure's back to intake: report is made, linked to it.
    const report = stepOf(id, 'report')[0]?.taskId ?? '';
    expect(parentsOf(h.db, report).map((p) => p.taskId)).toEqual([intake]);
  });
});
