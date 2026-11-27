import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, gatesOf, getTask, membersOf, parentsOf, pendingOf, settledOf, subscriptionsOf } from '../src/db/kanban-read.js';
import type { WorkflowMade } from '../src/kanban/service.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { briefFor } from '../src/kanban/brief.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * The writer deciding inside the settling transaction (workflow routing spec §9):
 * a completion, an archive, a run's block and a give-up each decide what is now
 * due, making a step's task as the start would have, linked to its effective
 * parents, its references filled, its first member's subscriptions copied, its
 * gates, member row and created event; skipping, and settling once the parents
 * are; and one workflow_routed event listing the decisions. A parent done and
 * then archived is still a done parent, linked, its result read and its handoff
 * in the brief; a reviewed result is the work run's that was approved last.
 */

const PAIR = `board: vi
steps:
  a:
    title: a
    assignee: vi-coordinator
    outputs: { go: boolean }
  b:
    title: b
    assignee: verifier
  c:
    title: c
    assignee: verifier
    parents: [a, b]
    when: [{ step: a, output: go, is: true }]
`;

const REVIEWED = `board: vi
steps:
  a:
    title: a
    assignee: vi-coordinator
    reviewer: { role: verifier }
    outputs: { go: boolean }
  c:
    title: c
    assignee: verifier
    parents: [a]
    when: [{ step: a, output: go, is: true }]
`;

const FLOW = `board: vi
params:
  case: { required: true }
steps:
  intake:
    title: "{{case}} · intake"
    assignee: vi-coordinator
    outputs:
      kind: { enum: [cve, supplychain] }
      verify: boolean
      note: string
  va:
    title: "{{case}} · va"
    assignee: vulnerability-analyst
    parents: [intake]
    when:
      - { step: intake, output: kind, equals: cve }
    outputs:
      reachable: boolean
  verify:
    title: "{{case}} · verify of {{intake.kind}}"
    body: "reachable: {{va.reachable}}"
    assignee: verifier
    parents: [va]
    when:
      - { step: intake, output: verify, is: true }
  report:
    title: "{{case}} · report, {{intake.note}}"
    assignee: report-author
    parents: [va, verify]
    gates:
      - { command: "test -s report.md", timeout_s: 30 }
  help:
    title: "{{case}} · help"
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
  b = viBoard(h, { limits: { failureLimit: 1, transientLimit: 10, transientCooldownS: 300 } });
  writeFileSync(join(b.dir, 'flow.yaml'), FLOW);
});
afterEach(() => h.close());

function start(): WorkflowMade {
  return madeOf(b.service.startWorkflow({ workflow: 'flow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
}

/** A run of the task, claimed, completing with its outputs, and closed. */
async function done(taskId: string, metadata: Record<string, unknown>): Promise<void> {
  const run = claimed(h.db, taskId);
  const r = await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'did it', metadata });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  closeRun(h.db, run.runId, NOW);
}

function member(instanceId: string, step: string) {
  return membersOf(h.db, instanceId).find((m) => m.step === step);
}

const routed = (taskId: string) => eventsOf(h.db, taskId).filter((e) => e.kind === 'workflow_routed').map((e) => e.payload as Record<string, unknown>);

describe('the writer deciding at a settling', () => {
  it("makes a step whose when holds at its parent's completion, linked to it, as the start would have made it", async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    await done(intake, { kind: 'cve', verify: true, note: 'n' });
    const va = member(w.instance.instanceId, 'va');
    expect(va).toMatchObject({ ref: 'va', step: 'va', item: null, position: 1 });
    const task = getTask(h.db, va?.taskId ?? '');
    expect(task).toMatchObject({ title: 'CVE-1 · va', board: 'vi', createdBy: ALICE, assignee: { kind: 'role', name: 'vulnerability-analyst' } });
    expect(task?.contract.outcome).toBe('Report in the metadata of your completion: reachable (true or false).');
    expect(parentsOf(h.db, va?.taskId ?? '').map((p) => p.taskId)).toEqual([intake]);
    expect(eventsOf(h.db, va?.taskId ?? '')[0]).toMatchObject({
      kind: 'created',
      actor: ALICE,
      payload: { workflow: w.instance.instanceId, workflowName: 'flow', ref: 'va', step: 'va', item: null, parents: [intake] },
    });
    expect(subscriptionsOf(h.db, va?.taskId ?? '').map((s) => [s.conversationId, s.threadId])).toEqual([['oc_chat', '']]);
    expect(settledOf(h.db, w.instance.instanceId)).toEqual([
      { instanceId: w.instance.instanceId, step: 'intake', ref: 'intake', how: 'done', taskId: intake, eventId: expect.any(Number), settledAt: NOW },
    ]);
    expect(routed(intake)).toEqual([
      {
        workflow: w.instance.instanceId,
        workflowName: 'flow',
        step: 'intake',
        cause: 'completed',
        decisions: [{ step: 'va', outcome: 'made', why: 'intake.kind is cve', taskIds: [va?.taskId] }],
      },
    ]);
  });

  it('skips a step at once when its when is false, holding its children until its own parents settle, then links them past it', async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    await done(intake, { kind: 'cve', verify: false, note: 'n' });
    expect(routed(intake)[0]?.['decisions']).toEqual([
      { step: 'va', outcome: 'made', why: 'intake.kind is cve', taskIds: [member(w.instance.instanceId, 'va')?.taskId] },
      { step: 'verify', outcome: 'skipped', why: 'intake.verify is false', taskIds: [], by: 'when' },
    ]);
    // verify is skipped, but not settled while va runs: report waits.
    expect(pendingOf(h.db, w.instance.instanceId).map((p) => [p.step, p.state])).toEqual([
      ['help', 'waiting'],
      ['report', 'waiting'],
      ['va', 'made'],
      ['verify', 'skipped'],
    ]);
    expect(settledOf(h.db, w.instance.instanceId).map((s) => s.step)).toEqual(['intake']);
    const va = member(w.instance.instanceId, 'va')?.taskId ?? '';
    await done(va, { reachable: true });
    const report = member(w.instance.instanceId, 'report')?.taskId ?? '';
    expect(parentsOf(h.db, report).map((p) => p.taskId)).toEqual([va]);
    expect(settledOf(h.db, w.instance.instanceId).map((s) => [s.step, s.how])).toEqual([
      ['help', 'skipped'],
      ['intake', 'done'],
      ['va', 'done'],
      ['verify', 'skipped'],
    ]);
    expect(getTask(h.db, report)?.title).toBe('CVE-1 · report, n');
    expect(gatesOf(h.db, report).map((g) => [g.command, g.timeoutS, g.createdBy])).toEqual([['test -s report.md', 30, ALICE]]);
  });

  it("links a step past a skipped parent to its nearest done ancestor, and fills a skipped step's output with (skipped)", async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    await done(intake, { kind: 'supplychain', verify: true, note: 'n' });
    const verify = member(w.instance.instanceId, 'verify')?.taskId ?? '';
    expect(getTask(h.db, verify)).toMatchObject({ title: 'CVE-1 · verify of supplychain', body: 'reachable: (skipped)' });
    expect(parentsOf(h.db, verify).map((p) => p.taskId)).toEqual([intake]);
    expect(routed(intake)[0]?.['decisions']).toEqual([
      { step: 'va', outcome: 'skipped', why: 'intake.kind is supplychain', taskIds: [], by: 'when' },
      { step: 'verify', outcome: 'made', why: 'intake.verify is true', taskIds: [verify] },
      { step: 'help', outcome: 'skipped', why: 'va did not give up', taskIds: [], by: 'when' },
    ]);
  });

  it("makes a step on its ancestor's give-up, not linked to it, the decision staying made once it is done", async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    await done(intake, { kind: 'cve', verify: false, note: 'n' });
    const va = member(w.instance.instanceId, 'va')?.taskId ?? '';
    const run = claimed(h.db, va);
    const ended = b.service.endRun(run.runId, { outcome: 'crashed', error: 'boom' });
    expect(ended).toMatchObject({ ok: true, next: 'blocked', task: { blockKind: 'gave_up' } });
    const help = member(w.instance.instanceId, 'help')?.taskId ?? '';
    expect(parentsOf(h.db, help)).toEqual([]);
    expect(routed(va)[0]).toMatchObject({ cause: 'gave_up', decisions: [{ step: 'help', outcome: 'made', why: 'va gave up', taskIds: [help] }] });
    closeRun(h.db, run.runId, NOW);
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    await done(va, { reachable: true });
    expect(membersOf(h.db, w.instance.instanceId).filter((m) => m.step === 'help').length).toBe(1);
  });

  it("copies the first member's subscriptions as they are at the making, in its thread", async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    expect(b.service.threadSubscriptions([intake], { channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat' }, 'omt_topic', 'om_root').ok).toBe(true);
    await done(intake, { kind: 'cve', verify: false, note: 'n' });
    const va = member(w.instance.instanceId, 'va')?.taskId ?? '';
    expect(subscriptionsOf(h.db, va).map((s) => [s.conversationId, s.threadId, s.rootMessageId])).toEqual([['oc_chat', 'omt_topic', 'om_root']]);
  });

  it('makes a child of a parent done and then archived, linked to it, its clause and its handoff read', async () => {
    writeFileSync(join(b.dir, 'pair.yaml'), PAIR);
    const w = madeOf(b.service.startWorkflow({ workflow: 'pair', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
    const [a, bb] = [w.tasks[0]?.taskId ?? '', w.tasks[1]?.taskId ?? ''];
    await done(a, { go: true });
    expect(b.service.archive(a, ALICE).ok).toBe(true);
    await done(bb, {});
    expect(settledOf(h.db, w.instance.instanceId).find((s) => s.step === 'a')).toMatchObject({ how: 'done', taskId: a });
    const c = member(w.instance.instanceId, 'c')?.taskId ?? '';
    expect(parentsOf(h.db, c).map((p) => [p.taskId, p.phase])).toEqual([
      [a, 'archived'],
      [bb, 'done'],
    ]);
    expect(routed(bb)[0]?.['decisions']).toEqual([{ step: 'c', outcome: 'made', why: 'a.go is true', taskIds: [c] }]);
    const run = claimed(h.db, c);
    const task = getTask(h.db, c);
    if (task === undefined) throw new Error('no task');
    expect(briefFor(h.db, { run, task, roleMd: undefined, role: undefined }).parents).toContainEqual(
      expect.objectContaining({ summary: 'did it', metadata: { go: true }, task: expect.objectContaining({ taskId: a }) }),
    );
  });

  it("reads a reworked result, the run approved last, and an operator's approval reading the work run's", async () => {
    writeFileSync(join(b.dir, 'reviewed.yaml'), REVIEWED);
    const reviewed = () => madeOf(b.service.startWorkflow({ workflow: 'reviewed', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
    const first = reviewed();
    const a = first.tasks[0]?.taskId ?? '';
    await done(a, { go: true });
    const changes = claimed(h.db, a);
    expect(b.service.requestChanges(a, { kind: 'run', runId: changes.runId }, 'check again').ok).toBe(true);
    closeRun(h.db, changes.runId, NOW);
    await done(a, { go: false });
    await done(a, {});
    expect(getTask(h.db, a)?.phase).toBe('done');
    expect(pendingOf(h.db, first.instance.instanceId).find((p) => p.step === 'c')).toMatchObject({ state: 'skipped', reason: { by: 'when', why: 'a.go is false' } });
    const second = reviewed();
    const a2 = second.tasks[0]?.taskId ?? '';
    await done(a2, { go: true });
    expect((await b.service.complete(a2, { kind: 'person', principal: ALICE }, { summary: 'approved' })).ok).toBe(true);
    expect(routed(a2).at(-1)?.['decisions']).toEqual([{ step: 'c', outcome: 'made', why: 'a.go is true', taskIds: [member(second.instance.instanceId, 'c')?.taskId] }]);
  });

  it('cuts a title made long by a result to its limit, never refusing', async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    await done(intake, { kind: 'supplychain', verify: false, note: 'n'.repeat(600) });
    const report = member(w.instance.instanceId, 'report')?.taskId ?? '';
    expect(Buffer.byteLength(getTask(h.db, report)?.title ?? '')).toBe(512);
  });
});
