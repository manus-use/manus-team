import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { commentsOf, eventsOf, getRun, getTask, membersOf, parentsOf, pendingOf, settledOf } from '../src/db/kanban-read.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { VI_WORKFLOW, madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * A stand-in's completion (workflow routing spec §5.2, §9.2, §9.5): the member
 * settled for the earliest settling fact by event id, whichever transaction or
 * reconciliation wrote it; a winning stand-in archiving its routed task, from
 * whatever phase, with its comment, unless it is archived already; one that
 * settles nothing archiving nothing; a stand-in left open after the routed
 * task's own completion told once; its review and its gates the step's; and the
 * cap passed at its completion skipping what it would make, the completion kept.
 */

let h: TestDb;
let b: ViBoard;
let workspace: string;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  workspace = mkdtempSync(join(h.dir, 'vi-'));
  b = viBoard(h, {
    limits: { failureLimit: 1, transientLimit: 10, transientCooldownS: 300 },
    // Gates run for real, in the workspace vi's directory (kanban spec §7.7).
    checks: { workspaceDirs: new Map([['vi', workspace]]), env: process.env },
  });
});
afterEach(() => h.close());

const CVE = { kind: 'cve', verify: true, patch: false, bnpm: false, packages: [] };

interface Routed {
  instanceId: string;
  intake: string;
  va: string;
}

async function report(taskId: string, metadata: Record<string, unknown>) {
  const run = claimed(h.db, taskId);
  const r = await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'done', metadata });
  closeRun(h.db, run.runId, NOW);
  return r;
}

function giveUp(taskId: string): string {
  const run = claimed(h.db, taskId);
  b.service.endRun(run.runId, { outcome: 'crashed' });
  closeRun(h.db, run.runId, NOW);
  return handlers().at(-1) ?? '';
}

let instance = '';
const handlers = () => membersOf(h.db, instance).filter((m) => m.step === 'escalate').map((m) => m.taskId);

async function routed(file = VI_WORKFLOW, intakeResult: Record<string, unknown> = CVE): Promise<Routed> {
  writeFileSync(join(b.dir, 'vi-workflow.yaml'), file);
  const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
  instance = w.instance.instanceId;
  const intake = w.tasks[0]?.taskId ?? '';
  await report(intake, intakeResult);
  return { instanceId: instance, intake, va: membersOf(h.db, instance).find((m) => m.step === 'va')?.taskId ?? '' };
}

const vaRow = () => settledOf(h.db, instance).find((s) => s.step === 'va');

describe("a stand-in's completion", () => {
  it('settles its step for it, archiving the routed task with its comment, and its dependents read its result', async () => {
    const { va } = await routed();
    const escalate = giveUp(va);
    expect((await report(escalate, { reachable: true })).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'stood_in', taskId: escalate });
    expect(getTask(h.db, va)?.phase).toBe('archived');
    expect(eventsOf(h.db, va).find((e) => e.kind === 'archived')).toMatchObject({ actor: 'gateway', payload: { from: 'blocked', workflow: instance, standIn: escalate } });
    expect(commentsOf(h.db, va).map((c) => c.body)).toEqual([`Stood in for by escalate:1 (${escalate}), whose result is read in va's place.`]);
    const verify = membersOf(h.db, instance).find((m) => m.step === 'verify')?.taskId ?? '';
    expect(parentsOf(h.db, verify).map((p) => p.taskId)).toEqual([escalate]);
    expect(eventsOf(h.db, escalate).find((e) => e.kind === 'workflow_routed')?.payload).toMatchObject({
      decisions: [
        { step: 'va', outcome: 'stood_in', why: 'reachable=true', taskIds: [va], handler: 'escalate' },
        { step: 'verify', outcome: 'made' },
        { step: 'exposure', outcome: 'skipped' },
      ],
    });
  });

  it('settles only once its review passes, its changes settling nothing', async () => {
    const { va } = await routed(
      VI_WORKFLOW.replace('    assignee: vulnerability-analyst\n', '    assignee: vulnerability-analyst\n    reviewer: { role: assessment-reviewer }\n'),
    );
    const escalate = giveUp(va);
    expect(await report(escalate, { reachable: true })).toMatchObject({ ok: true, task: { phase: 'review' } });
    expect(vaRow()).toBeUndefined();
    const review = claimed(h.db, escalate);
    expect(b.service.requestChanges(escalate, { kind: 'run', runId: review.runId }, 'cite the advisory').ok).toBe(true);
    closeRun(h.db, review.runId, NOW);
    expect(vaRow()).toBeUndefined();
    expect(await report(escalate, { reachable: false })).toMatchObject({ ok: true, task: { phase: 'review' } });
    const approve = claimed(h.db, escalate);
    expect((await b.service.complete(escalate, { kind: 'run', runId: approve.runId }, { summary: 'LGTM' })).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'stood_in', taskId: escalate });
  });

  it("lets the routed task's own completion win when it comes first, telling the stand-in left open, once", async () => {
    const { va } = await routed();
    const escalate = giveUp(va);
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    expect((await report(va, { reachable: false })).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'done', taskId: va });
    const told = `va was completed by its own task ${va}; this handler's result will not be read: finish or archive it`;
    expect(commentsOf(h.db, escalate).map((c) => c.body)).toEqual([told]);
    const routedPayload = eventsOf(h.db, va).filter((e) => e.kind === 'workflow_routed').at(-1)?.payload as { decisions: unknown[] };
    expect(routedPayload.decisions[0]).toEqual({ step: 'va', outcome: 'unread', why: 'va was completed by its own task', taskIds: [escalate], handler: 'escalate' });
    expect(b.service.reconcileWorkflow(instance).ok).toBe(true);
    expect(commentsOf(h.db, escalate).length).toBe(1);
    expect((await report(escalate, { reachable: true })).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'done', taskId: va });
    expect(getTask(h.db, va)?.phase).toBe('done');
  });

  it('settles a member once when two stand-ins are done, the lower completed id winning, the other archiving nothing', async () => {
    const { va } = await routed();
    const first = giveUp(va);
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    const second = giveUp(va);
    expect(second).not.toBe(first);
    expect((await report(second, { reachable: true })).ok).toBe(true);
    expect((await report(first, { reachable: false })).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'stood_in', taskId: second });
    expect(eventsOf(h.db, va).filter((e) => e.kind === 'archived').length).toBe(1);
  });

  it('gives the stand-in the row after its routing faulted and the routed task completed, with the event id the gateway would have written', async () => {
    const { va } = await routed();
    const escalate = giveUp(va);
    h.db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled WHEN NEW.step = 'va' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    expect((await report(escalate, { reachable: true })).ok).toBe(true);
    h.db.exec('DROP TRIGGER boom');
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    expect((await report(va, { reachable: false })).ok).toBe(true);
    const completed = eventsOf(h.db, escalate).find((e) => e.kind === 'completed')?.id;
    expect(vaRow()).toMatchObject({ how: 'stood_in', taskId: escalate, eventId: completed });
    expect(eventsOf(h.db, va).find((e) => e.kind === 'archived')?.payload).toMatchObject({ from: 'done', standIn: escalate });
    expect(b.service.reconcileWorkflow(instance).ok).toBe(true);
    expect(eventsOf(h.db, va).filter((e) => e.kind === 'archived').length).toBe(1);
  });

  it("gives an archive undone the row after its routing faulted, the stand-in done later settling nothing and archiving nothing", async () => {
    const { va } = await routed();
    const escalate = giveUp(va);
    h.db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled WHEN NEW.step = 'va' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    expect(b.service.archive(va, ALICE).ok).toBe(true);
    h.db.exec('DROP TRIGGER boom');
    expect((await report(escalate, { reachable: true })).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'archived', taskId: null });
    expect(eventsOf(h.db, va).filter((e) => e.kind === 'archived').length).toBe(1);
    expect(commentsOf(h.db, va)).toEqual([]);
  });

  it("settles nothing while a stand-in fails one of its step's gates, the run left undecided, and settles once it passes", async () => {
    const file = VI_WORKFLOW.replace(
      '    assignee: vulnerability-analyst\n',
      '    assignee: vulnerability-analyst\n    workspace: vi\n    gates:\n      - { command: "test -s result.json", timeout_s: 30 }\n',
    );
    const { va } = await routed(file);
    const vaRun = b.service.claim(va);
    if (!vaRun.ok) throw new Error(vaRun.message);
    b.service.endRun(vaRun.run.runId, { outcome: 'crashed' });
    closeRun(h.db, vaRun.run.runId, NOW);
    const escalate = handlers()[0] ?? '';
    expect(getTask(h.db, escalate)?.workspace).toBe('vi');
    const run = b.service.claim(escalate);
    if (!run.ok) throw new Error(run.message);
    const by = { kind: 'run', runId: run.run.runId } as const;
    expect(await b.service.complete(escalate, by, { summary: 'done', metadata: { reachable: true } })).toMatchObject({ ok: false, code: 'gate_failed' });
    expect(getRun(h.db, run.run.runId)?.outcome).toBeNull();
    expect(vaRow()).toBeUndefined();
    expect(getTask(h.db, va)?.phase).toBe('blocked');
    writeFileSync(join(workspace, 'result.json'), '{"reachable": true}\n');
    expect((await b.service.complete(escalate, by, { summary: 'done', metadata: { reachable: true } })).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'stood_in', taskId: escalate });
  });

  it("settles no item while an item's stand-in fails the fan-out step's gates, and the item once they pass", async () => {
    const file = `${VI_WORKFLOW.replace(
      '    for_each: { step: intake, output: packages }\n',
      '    for_each: { step: intake, output: packages }\n    workspace: vi\n    gates:\n      - { command: "test -s result.json", timeout_s: 30 }\n    on_gave_up: { route: redo }\n',
    )}  redo:\n    title: "{{case}} · exposure of {{item}}, redone"\n    assignee: vi-coordinator\n    handler: true\n    stands_in_for: exposure\n`;
    const { va } = await routed(file, { ...CVE, verify: false, packages: ['lodash', 'qs'] });
    expect((await report(va, { reachable: true })).ok).toBe(true);
    const qs = membersOf(h.db, instance).find((m) => m.step === 'exposure' && m.item === 'qs')?.taskId ?? '';
    const run = b.service.claim(qs);
    if (!run.ok) throw new Error(run.message);
    b.service.endRun(run.run.runId, { outcome: 'crashed' });
    closeRun(h.db, run.run.runId, NOW);
    const redo = membersOf(h.db, instance).find((m) => m.step === 'redo')?.taskId ?? '';
    const mine = b.service.claim(redo);
    if (!mine.ok) throw new Error(mine.message);
    const by = { kind: 'run', runId: mine.run.runId } as const;
    const itemRow = () => settledOf(h.db, instance).find((s) => s.step === 'exposure' && s.ref === 'exposure:2');
    expect(await b.service.complete(redo, by, { summary: 'done' })).toMatchObject({ ok: false, code: 'gate_failed' });
    expect(getRun(h.db, mine.run.runId)?.outcome).toBeNull();
    expect(itemRow()).toBeUndefined();
    expect(getTask(h.db, qs)?.phase).toBe('blocked');
    writeFileSync(join(workspace, 'result.json'), '{}\n');
    expect((await b.service.complete(redo, by, { summary: 'done' })).ok).toBe(true);
    expect(itemRow()).toMatchObject({ how: 'stood_in', taskId: redo });
    expect(getTask(h.db, qs)?.phase).toBe('archived');
  });

  it('skips what a stand-in would make past the cap at its completion, the completion and its settling kept', async () => {
    const { va } = await routed(VI_WORKFLOW, { ...CVE, verify: false, packages: ['a', 'b', 'c'] });
    const escalate = giveUp(va);
    // Members to one short of the cap: exposure over the intake's three packages would pass it.
    const task = h.db.prepare(
      `INSERT INTO kanban_tasks (task_id, title, contract, phase, created_by, created_via, created_at, board)
       VALUES (?, 'filler', jsonb('{}'), 'open', ?, jsonb('{"kind":"operator"}'), ?, 'vi')`,
    );
    const member = h.db.prepare("INSERT INTO kanban_workflow_tasks (task_id, instance_id, ref, step, item, position) VALUES (?, ?, ?, 'filler', NULL, ?)");
    const base = membersOf(h.db, instance).length;
    for (let i = 0; i < 499 - base; i += 1) {
      task.run(`k_fill${i}`, ALICE, NOW);
      member.run(`k_fill${i}`, instance, `filler:${i + 1}`, base + i);
    }
    expect((await report(escalate, { reachable: true })).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'stood_in', taskId: escalate });
    expect(pendingOf(h.db, instance).find((p) => p.step === 'exposure')).toMatchObject({ state: 'skipped', reason: { by: 'cap', why: 'the instance has 500 tasks' } });
    expect(membersOf(h.db, instance).filter((m) => m.step === 'exposure')).toEqual([]);
  });

  it("fans out over a stood-in source's list, each item's task linked to the stand-in, a list past the cap refused", async () => {
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
      `${VI_WORKFLOW.replace('      packages: { list: string, max: 100 }\n  va:', '      packages: { list: string, max: 100 }\n    on_gave_up: { route: takeover }\n  va:')}${takeover}`,
    );
    const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
    instance = w.instance.instanceId;
    const intake = w.tasks[0]?.taskId ?? '';
    const run = claimed(h.db, intake);
    b.service.endRun(run.runId, { outcome: 'crashed' });
    closeRun(h.db, run.runId, NOW);
    const stand = membersOf(h.db, instance).find((m) => m.step === 'takeover')?.taskId ?? '';
    const result = { kind: 'supplychain', verify: false, patch: false, bnpm: false };
    const fill = h.db.prepare(
      `INSERT INTO kanban_tasks (task_id, title, contract, phase, created_by, created_via, created_at, board)
       VALUES (?, 'filler', jsonb('{}'), 'open', ?, jsonb('{"kind":"operator"}'), ?, 'vi')`,
    );
    const member = h.db.prepare("INSERT INTO kanban_workflow_tasks (task_id, instance_id, ref, step, item, position) VALUES (?, ?, ?, 'filler', NULL, ?)");
    const base = membersOf(h.db, instance).length;
    for (let i = 0; i < 450; i += 1) {
      fill.run(`k_fill${i}`, ALICE, NOW);
      member.run(`k_fill${i}`, instance, `filler:${i + 1}`, base + i);
    }
    const mine = claimed(h.db, stand);
    const by = { kind: 'run', runId: mine.runId } as const;
    const many = Array.from({ length: 60 }, (_, i) => `p${i}`);
    expect(await b.service.complete(stand, by, { summary: 'x', metadata: { ...result, packages: many } })).toMatchObject({ ok: false, code: 'too_large' });
    expect((await b.service.complete(stand, by, { summary: 'x', metadata: { ...result, packages: ['a', 'b'] } })).ok).toBe(true);
    const exposure = membersOf(h.db, instance).filter((m) => m.step === 'exposure');
    expect(exposure.map((m) => getTask(h.db, m.taskId)?.title)).toEqual(['CVE-1 · exposure of a', 'CVE-1 · exposure of b']);
    for (const m of exposure) expect(parentsOf(h.db, m.taskId).map((p) => p.taskId)).toEqual([stand]);
    expect(eventsOf(h.db, intake).find((e) => e.kind === 'archived')?.payload).toMatchObject({ workflow: instance, standIn: stand });
    expect(settledOf(h.db, instance).find((s) => s.step === 'intake')).toMatchObject({ how: 'stood_in', taskId: stand });
  });

  it('writes only the row for a stand-in winning over a routed task a person archived after its own done', async () => {
    const { va } = await routed();
    const escalate = giveUp(va);
    h.db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled WHEN NEW.step = 'va' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    expect((await report(escalate, { reachable: true })).ok).toBe(true);
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    expect((await report(va, { reachable: false })).ok).toBe(true);
    expect(b.service.archive(va, ALICE).ok).toBe(true);
    h.db.exec('DROP TRIGGER boom');
    expect(b.service.reconcileWorkflow(instance).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'stood_in', taskId: escalate });
    expect(eventsOf(h.db, va).filter((e) => e.kind === 'archived').map((e) => (e.payload as { from: string }).from)).toEqual(['done']);
    expect(commentsOf(h.db, va)).toEqual([]);
  });
});
