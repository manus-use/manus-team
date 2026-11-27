import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, getTask, membersOf, pendingOf } from '../src/db/kanban-read.js';
import type { WorkflowMade } from '../src/kanban/service.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { VI_WORKFLOW, madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * The instance's 500 tasks (workflow routing spec §2.2, §9.4): reserved at the
 * report whose list a fan-out will read, `too_large` while the agent can still
 * shorten it; and, past it later, at a reviewer's approval, the fan-out skipped
 * whole with its notice, the approval committed, never refused.
 */

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  b = viBoard(h);
});
afterEach(() => h.close());

function start(): WorkflowMade {
  return madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
}

/** `n` more members of the instance, written as rows: tasks the instance made, which nothing here reads but the count. */
function fill(instanceId: string, n: number): void {
  const task = h.db.prepare(
    `INSERT INTO kanban_tasks (task_id, title, contract, phase, created_by, created_via, created_at, board)
     VALUES (?, 'filler', jsonb('{}'), 'open', ?, jsonb('{"kind":"operator"}'), ?, 'vi')`,
  );
  const member = h.db.prepare("INSERT INTO kanban_workflow_tasks (task_id, instance_id, ref, step, item, position) VALUES (?, ?, ?, 'filler', NULL, ?)");
  const base = membersOf(h.db, instanceId).length;
  for (let i = 0; i < n; i += 1) {
    task.run(`k_fill${i}`, ALICE, NOW);
    member.run(`k_fill${i}`, instanceId, `filler:${i + 1}`, base + i);
  }
}

const packages = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
const OUTPUTS = { kind: 'supplychain', verify: false, patch: false, bnpm: false };

describe('the cap', () => {
  it('is reserved at the reporting completion, too_large while the list can be shortened', async () => {
    const w = start();
    fill(w.instance.instanceId, 470);
    const intake = w.tasks[0]?.taskId ?? '';
    const run = claimed(h.db, intake);
    const by = { kind: 'run', runId: run.runId } as const;
    expect(await b.service.complete(intake, by, { summary: 'x', metadata: { ...OUTPUTS, packages: packages(63) } })).toEqual({
      ok: false,
      code: 'too_large',
      message: `output packages would make 63 tasks, and instance ${w.instance.instanceId} has 471 of its 500`,
    });
    expect((await b.service.complete(intake, by, { summary: 'x', metadata: { ...OUTPUTS, packages: packages(3) } })).ok).toBe(true);
    expect(membersOf(h.db, w.instance.instanceId).filter((m) => m.step === 'exposure').length).toBe(3);
  });

  it("reserves a waiting fan-out over a list param's items, not one task", async () => {
    // each waits on the intake's kind, and fans out over the ten vendors when made.
    const vendors = Array.from({ length: 10 }, (_, i) => `v${i}`);
    writeFileSync(
      join(b.dir, 'vi-workflow.yaml'),
      VI_WORKFLOW.replace('  case: { required', '  vendors: { list: true, required: true }\n  case: { required').replace(
        '  registry:\n',
        '  each:\n    title: "{{case}} · vendor {{item}}"\n    assignee: verifier\n    parents: [intake]\n    for_each: vendors\n    when:\n      - { step: intake, output: kind, equals: supplychain }\n  registry:\n',
      ),
    );
    const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1', vendors } }, createdBy: ALICE, createdVia: VIA }));
    // 1 member and 470 fillers; waiting: va, verify, exposure, registry, report, patch, and each's ten.
    fill(w.instance.instanceId, 470);
    const intake = w.tasks[0]?.taskId ?? '';
    const run = claimed(h.db, intake);
    const by = { kind: 'run', runId: run.runId } as const;
    expect(await b.service.complete(intake, by, { summary: 'x', metadata: { ...OUTPUTS, packages: packages(15) } })).toEqual({
      ok: false,
      code: 'too_large',
      message: `output packages would make 15 tasks, and instance ${w.instance.instanceId} has 471 of its 500`,
    });
    expect((await b.service.complete(intake, by, { summary: 'x', metadata: { ...OUTPUTS, packages: packages(14) } })).ok).toBe(true);
  });

  it('skips a fan-out whole past the cap at a reviewer\'s approval, with its notice, the approval committed', async () => {
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW.replace('    assignee: vi-coordinator\n    outputs:', '    assignee: vi-coordinator\n    reviewer: verifier\n    outputs:'));
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    const run = claimed(h.db, intake);
    expect((await b.service.complete(intake, { kind: 'run', runId: run.runId }, { summary: 'x', metadata: { ...OUTPUTS, packages: packages(30) } })).ok).toBe(true);
    closeRun(h.db, run.runId, NOW);
    fill(w.instance.instanceId, 479);
    const review = claimed(h.db, intake);
    expect(await b.service.complete(intake, { kind: 'run', runId: review.runId }, { summary: 'LGTM' })).toMatchObject({ ok: true, task: { phase: 'done' } });
    expect(getTask(h.db, intake)?.phase).toBe('done');
    expect(membersOf(h.db, w.instance.instanceId).filter((m) => m.step === 'exposure')).toEqual([]);
    expect(pendingOf(h.db, w.instance.instanceId).find((p) => p.step === 'exposure')).toMatchObject({ state: 'skipped', reason: { by: 'cap', why: 'the instance has 500 tasks' } });
    const routed = eventsOf(h.db, intake).find((e) => e.kind === 'workflow_routed')?.payload as { decisions: unknown[] };
    expect(routed.decisions).toContainEqual({ step: 'exposure', outcome: 'skipped', why: 'the instance has 500 tasks', taskIds: [], by: 'cap' });
  });
});
