import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { gatesOf, getTask, membersOf } from '../src/db/kanban-read.js';
import { WORKER_LIMITS } from '../src/kanban/limits.js';
import { outcomeWithOutputs, standInContract } from '../src/kanban/routing.js';
import { readWorkflow } from '../src/kanban/workflow.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { VI_WORKFLOW, madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * A stand-in made (workflow routing spec §5.2): with its step's reviewer, its
 * step's gates first and then its own, each contract field merged as the step's
 * and then the handler's; all read from the plan frozen at the start, whatever
 * the file says now; and its work report checked against the step's outputs.
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

/** va with a reviewer, a gate and a contract; escalate with a gate and a verification of its own. */
const FILE = VI_WORKFLOW.replace(
  '    assignee: vulnerability-analyst\n',
  '    assignee: vulnerability-analyst\n    reviewer: { role: assessment-reviewer }\n    outcome: a verdict on reachability\n    verify: cites the advisory\n    gates:\n      - { command: "vi-workflow-gate result.json", timeout_s: 30 }\n',
).replace('    stands_in_for: va\n', '    stands_in_for: va\n    verify: says who was asked\n    gates:\n      - { command: "test -s escalation.md", timeout_s: 10 }\n');

async function stoodIn(after?: () => void): Promise<string> {
  writeFileSync(join(b.dir, 'vi-workflow.yaml'), FILE);
  const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
  after?.();
  const intake = w.tasks[0]?.taskId ?? '';
  const ir = claimed(h.db, intake);
  await b.service.complete(intake, { kind: 'run', runId: ir.runId }, { summary: 'x', metadata: CVE });
  closeRun(h.db, ir.runId, NOW);
  const va = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'va')?.taskId ?? '';
  const vr = claimed(h.db, va);
  b.service.endRun(vr.runId, { outcome: 'crashed' });
  closeRun(h.db, vr.runId, NOW);
  return membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'escalate')?.taskId ?? '';
}

describe('a stand-in made', () => {
  it("takes its step's reviewer, its gates before its own, and each contract field merged", async () => {
    const escalate = await stoodIn();
    const task = getTask(h.db, escalate);
    expect(task?.reviewer).toEqual({ kind: 'role', name: 'assessment-reviewer' });
    expect(task?.contract).toEqual({
      outcome: "the step's (va): a verdict on reachability\n\nReport in the metadata of your completion: reachable (true or false).",
      verification: "the step's (va): cites the advisory\n\nthis handler's: says who was asked",
    });
    expect(gatesOf(h.db, escalate).map((g) => [g.command, g.timeoutS, g.createdBy])).toEqual([
      ['vi-workflow-gate result.json', 30, ALICE],
      ['test -s escalation.md', 10, ALICE],
    ]);
  });

  it('reads them from the plan frozen at the start, whatever the file says now', async () => {
    const escalate = await stoodIn(() => writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW));
    expect(getTask(h.db, escalate)?.reviewer).toEqual({ kind: 'role', name: 'assessment-reviewer' });
    expect(gatesOf(h.db, escalate).length).toBe(2);
  });

  it("checks its work report against its step's outputs", async () => {
    const escalate = await stoodIn();
    const run = claimed(h.db, escalate);
    expect(await b.service.complete(escalate, { kind: 'run', runId: run.runId }, { summary: 'asked upstream' })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'output reachable is missing',
    });
  });

  it('holds a handler helping another step to its own step, not the one it stands in for', async () => {
    // takeover stands in for intake, and helps va when va blocks.
    const takeover = `  takeover:
    title: "{{case}} · intake, taken over"
    assignee: vi-coordinator
    handler: true
    stands_in_for: intake
    outputs:
      kind: { enum: [cve, supplychain] }
      verify: boolean
      patch: boolean
      bnpm: boolean
      packages: { list: string, max: 100 }
`;
    writeFileSync(
      join(b.dir, 'vi-workflow.yaml'),
      `${VI_WORKFLOW.replace('      packages: { list: string, max: 100 }\n  va:', '      packages: { list: string, max: 100 }\n    on_gave_up: { route: takeover }\n  va:').replace(
        '    on_gave_up: { route: escalate }\n',
        '    on_gave_up: { route: escalate }\n    on_blocked: { route: takeover }\n',
      )}${takeover}`,
    );
    const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
    const id = w.instance.instanceId;
    const intake = w.tasks[0]?.taskId ?? '';
    const ir = claimed(h.db, intake);
    expect((await b.service.complete(intake, { kind: 'run', runId: ir.runId }, { summary: 'x', metadata: { ...CVE, packages: ['a'] } })).ok).toBe(true);
    closeRun(h.db, ir.runId, NOW);
    // Members to 450: were takeover read as intake, exposure's waiting fan-out over its 60 packages would pass the cap.
    const task = h.db.prepare(
      `INSERT INTO kanban_tasks (task_id, title, contract, phase, created_by, created_via, created_at, board)
       VALUES (?, 'filler', jsonb('{}'), 'open', ?, jsonb('{"kind":"operator"}'), ?, 'vi')`,
    );
    const member = h.db.prepare("INSERT INTO kanban_workflow_tasks (task_id, instance_id, ref, step, item, position) VALUES (?, ?, ?, 'filler', NULL, ?)");
    const base = membersOf(h.db, id).length;
    for (let i = 0; i < 450 - base; i += 1) {
      task.run(`k_fill${i}`, ALICE, NOW);
      member.run(`k_fill${i}`, id, `filler:${i + 1}`, base + i);
    }
    const va = membersOf(h.db, id).find((m) => m.step === 'va')?.taskId ?? '';
    const vr = claimed(h.db, va);
    expect(b.service.block(va, { kind: 'run', runId: vr.runId }, { kind: 'capability', reason: 'no network' }).ok).toBe(true);
    closeRun(h.db, vr.runId, NOW);
    const helper = membersOf(h.db, id).find((m) => m.step === 'takeover')?.taskId ?? '';
    const run = claimed(h.db, helper);
    const packages = Array.from({ length: 60 }, (_, i) => `p${i}`);
    expect((await b.service.complete(helper, { kind: 'run', runId: run.runId }, { summary: 'helped', metadata: { ...CVE, packages } })).ok).toBe(true);
  });

  it("counts a stand-in's outputs sentence once, the start agreeing with the check at the limit and one byte past it", () => {
    // escalate's own outcome merged after va's, which carries the outputs sentence: exactly the limit, then one byte more.
    const theirs = { outcome: outcomeWithOutputs(undefined, { reachable: 'boolean' }) };
    const overhead = Buffer.byteLength(standInContract('va', theirs, { outcome: '' }).outcome ?? '');
    const facts = { roles: b.roles, workspaces: new Set(['default', 'vi']), supervisedRoles: true };
    const start = () => b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA });
    for (const extra of [0, 1]) {
      const own = 'o'.repeat(WORKER_LIMITS.contractField - overhead + extra);
      expect(Buffer.byteLength(standInContract('va', theirs, { outcome: own }).outcome ?? '')).toBe(WORKER_LIMITS.contractField + extra);
      writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW.replace('    stands_in_for: va\n', `    stands_in_for: va\n    outcome: ${own}\n`));
      const checked = readWorkflow(b.dir, 'vi-workflow', facts);
      const started = start();
      if (extra === 0) {
        expect(checked.ok).toBe(true);
        expect(started.ok).toBe(true);
      } else {
        const said = `steps.escalate stands in for va: its contract's outcome with va's is ${WORKER_LIMITS.contractField + 1} bytes; at most ${WORKER_LIMITS.contractField}`;
        expect(checked).toMatchObject({ ok: false, message: expect.stringContaining(said) });
        expect(started).toMatchObject({ ok: false, message: expect.stringContaining(said) });
      }
    }
  });
});
