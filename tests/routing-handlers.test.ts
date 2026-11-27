import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, getTask, membersOf, parentsOf, routesOf } from '../src/db/kanban-read.js';
import type { WorkflowMade } from '../src/kanban/service.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { VI_WORKFLOW, madeOf, viBoard, workerRun, type ViBoard } from './helpers/routing.js';

/**
 * A route made (workflow routing spec §5): a handler's task made for its routed
 * task's give-up, once for that event, with no link, its ref `<handler>:<n>`,
 * its body gaining its paragraph, kept whole, its created event naming the
 * routed task, in that task's workspace; a block routed to a helper; the fourth
 * give-up `over_limit`, said once; the cap's `over_cap`; and the worker's show of
 * a handler's task naming its source from the route row.
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

function start(): WorkflowMade {
  return madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
}

async function done(taskId: string, metadata: Record<string, unknown> = {}): Promise<void> {
  const run = claimed(h.db, taskId);
  const r = await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'did it', metadata });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  closeRun(h.db, run.runId, NOW);
}

/** A crash of the task's next run, its failure limit 1: it gives up. */
function giveUp(taskId: string): void {
  const run = claimed(h.db, taskId);
  const r = b.service.endRun(run.runId, { outcome: 'crashed' });
  if (!r.ok) throw new Error(r.message);
  closeRun(h.db, run.runId, NOW);
}

async function vaOf(): Promise<{ w: WorkflowMade; va: string }> {
  const w = start();
  await done(w.tasks[0]?.taskId ?? '', CVE);
  return { w, va: membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'va')?.taskId ?? '' };
}

const handlers = (id: string) => membersOf(h.db, id).filter((m) => m.step === 'escalate');

describe('a route made', () => {
  it("makes the handler's task for the give-up, with no link, its paragraph after the file's body, naming the routed task", async () => {
    const { w, va } = await vaOf();
    giveUp(va);
    const [escalate] = handlers(w.instance.instanceId);
    expect(escalate).toMatchObject({ ref: 'escalate:1', step: 'escalate', item: null });
    const task = getTask(h.db, escalate?.taskId ?? '');
    expect(task?.title).toBe('CVE-1 · va, escalated');
    expect(task?.body).toBe(
      [
        `Routed from \`${va}\` (step va): it gave up: failed 1 times; last crashed.`,
        "This task stands in for it: your accepted completion is read in va's place, and archives it.",
        `\`mt kanban unblock\` with {"task_id": "${va}", "comment": "…"} returns it to work instead.`,
      ].join('\n'),
    );
    expect(parentsOf(h.db, escalate?.taskId ?? '')).toEqual([]);
    expect(eventsOf(h.db, escalate?.taskId ?? '')[0]?.payload).toMatchObject({ ref: 'escalate:1', step: 'escalate', routedFrom: va });
    const routes = routesOf(h.db, w.instance.instanceId);
    expect(routes.map((r) => [r.handler, r.fromTask, r.outcome, r.taskId])).toEqual([['escalate', va, 'made', escalate?.taskId]]);
    expect(eventsOf(h.db, va).find((e) => e.kind === 'workflow_routed')?.payload).toMatchObject({
      cause: 'gave_up',
      decisions: [{ step: 'va', outcome: 'routed', why: 'gave up', taskIds: [escalate?.taskId], handler: 'escalate', standsIn: true }],
    });
  });

  it('routes each give-up once, at most 3 a task, then falls back to wait with one over_limit', async () => {
    const { w, va } = await vaOf();
    for (let n = 1; n <= 4; n += 1) {
      giveUp(va);
      expect(b.service.unblock(va, ALICE).ok).toBe(true);
    }
    expect(handlers(w.instance.instanceId).map((m) => m.ref)).toEqual(['escalate:1', 'escalate:2', 'escalate:3']);
    expect(routesOf(h.db, w.instance.instanceId).map((r) => r.outcome)).toEqual(['made', 'made', 'made', 'over_limit']);
    const last = eventsOf(h.db, va).filter((e) => e.kind === 'workflow_routed').at(-1)?.payload;
    expect(last).toMatchObject({ decisions: [{ step: 'va', outcome: 'over_limit', why: 'gave up', taskIds: [va], handler: 'escalate' }] });
  });

  it("routes a run's block to a helper, made in the routed task's workspace, its paragraph saying it helps", async () => {
    writeFileSync(
      join(b.dir, 'vi-workflow.yaml'),
      `${VI_WORKFLOW.replace('    on_gave_up: { route: escalate }\n', '    on_gave_up: { route: escalate }\n    on_blocked: { route: help }\n    workspace: vi\n')}  help:\n    title: "{{case}} · help va, a {{intake.kind}}"\n    assignee: vi-coordinator\n    handler: true\n`,
    );
    const { w, va } = await vaOf();
    const run = b.service.claim(va);
    if (!run.ok) throw new Error(run.message);
    expect(b.service.block(va, { kind: 'run', runId: run.run.runId }, { kind: 'capability', reason: 'no network' }).ok).toBe(true);
    const help = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'help')?.taskId ?? '';
    expect(getTask(h.db, help)).toMatchObject({
      title: 'CVE-1 · help va, a cve',
      workspace: 'vi',
      body: [
        `Routed from \`${va}\` (step va): it blocked (capability): no network.`,
        'This task helps it: its dependents wait for it, not for you.',
        `\`mt kanban unblock\` with {"task_id": "${va}", "comment": "…"} returns it to work instead.`,
      ].join('\n'),
    });
  });

  it("routes the transient limit's block by on_gave_up, saying it stopped after the throttles, and a run's own transient block by on_blocked", async () => {
    b = viBoard(h, { limits: { failureLimit: 1, transientLimit: 2, transientCooldownS: 0 } });
    writeFileSync(
      join(b.dir, 'vi-workflow.yaml'),
      `${VI_WORKFLOW.replace('    on_gave_up: { route: escalate }\n', '    on_gave_up: { route: escalate }\n    on_blocked: { route: help }\n')}  help:\n    title: "{{case}} · help va"\n    assignee: vi-coordinator\n    handler: true\n`,
    );
    const { w, va } = await vaOf();
    for (let n = 1; n <= 2; n += 1) {
      const run = claimed(h.db, va);
      expect(b.service.endRun(run.runId, { outcome: 'rate_limited' }).ok).toBe(true);
      closeRun(h.db, run.runId, NOW);
    }
    expect(getTask(h.db, va)).toMatchObject({ phase: 'blocked', blockKind: 'transient' });
    const escalate = handlers(w.instance.instanceId)[0]?.taskId ?? '';
    expect(getTask(h.db, escalate)?.body).toBe(
      [
        `Routed from \`${va}\` (step va): it stopped after 2 throttles: throttled 2 times in a row.`,
        "This task stands in for it: your accepted completion is read in va's place, and archives it.",
        `\`mt kanban unblock\` with {"task_id": "${va}", "comment": "…"} returns it to work instead.`,
      ].join('\n'),
    );
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    const run = b.service.claim(va);
    if (!run.ok) throw new Error(run.message);
    expect(b.service.block(va, { kind: 'run', runId: run.run.runId }, { kind: 'transient', reason: 'the registry is down' }).ok).toBe(true);
    expect(getTask(h.db, va)).toMatchObject({ phase: 'blocked', blockKind: 'transient' });
    const help = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'help')?.taskId ?? '';
    expect(getTask(h.db, help)?.body.split('\n')[0]).toBe(`Routed from \`${va}\` (step va): it blocked (transient): the registry is down.`);
    expect(routesOf(h.db, w.instance.instanceId).map((r) => [r.handler, r.outcome])).toEqual([
      ['escalate', 'made'],
      ['help', 'made'],
    ]);
  });

  it("routes a fan-out's item for its own give-up, the handler made for that item", async () => {
    writeFileSync(
      join(b.dir, 'vi-workflow.yaml'),
      `${VI_WORKFLOW.replace('    for_each: { step: intake, output: packages }\n', '    for_each: { step: intake, output: packages }\n    on_gave_up: { route: fix }\n')}  fix:\n    title: "{{case}} · fix {{item}}"\n    assignee: vi-coordinator\n    handler: true\n`,
    );
    const w = start();
    await done(w.tasks[0]?.taskId ?? '', { ...CVE, packages: ['lodash', 'qs'] });
    const va = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'va')?.taskId ?? '';
    await done(va, { reachable: true });
    const qs = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'exposure' && m.item === 'qs')?.taskId ?? '';
    giveUp(qs);
    const fix = membersOf(h.db, w.instance.instanceId).filter((m) => m.step === 'fix');
    expect(fix.map((m) => [m.ref, m.item])).toEqual([['fix:1', 'qs']]);
    expect(getTask(h.db, fix[0]?.taskId ?? '')?.title).toBe('CVE-1 · fix qs');
    expect(routesOf(h.db, w.instance.instanceId).map((r) => [r.fromTask, r.outcome])).toEqual([[qs, 'made']]);
  });

  it('counts the handlers made in the cap: a route past 500 members records over_cap', async () => {
    const { w, va } = await vaOf();
    giveUp(va);
    expect(handlers(w.instance.instanceId).length).toBe(1);
    const task = h.db.prepare(
      `INSERT INTO kanban_tasks (task_id, title, contract, phase, created_by, created_via, created_at, board)
       VALUES (?, 'filler', jsonb('{}'), 'open', ?, jsonb('{"kind":"operator"}'), ?, 'vi')`,
    );
    const member = h.db.prepare("INSERT INTO kanban_workflow_tasks (task_id, instance_id, ref, step, item, position) VALUES (?, ?, ?, 'filler', NULL, ?)");
    const base = membersOf(h.db, w.instance.instanceId).length;
    // 499 members of the file's steps and one handler: the instance is at its cap.
    for (let i = 0; i < 500 - base; i += 1) {
      task.run(`k_fill${i}`, ALICE, NOW);
      member.run(`k_fill${i}`, w.instance.instanceId, `filler:${i + 1}`, base + i);
    }
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    giveUp(va);
    expect(handlers(w.instance.instanceId).length).toBe(1);
    expect(routesOf(h.db, w.instance.instanceId).map((r) => r.outcome)).toEqual(['made', 'over_cap']);
  });

  it('makes no handler on a board found archived, writing no route row', async () => {
    const { w, va } = await vaOf();
    h.db.prepare("UPDATE kanban_boards SET archived_at = ? WHERE name = 'vi'").run(NOW);
    giveUp(va);
    expect(handlers(w.instance.instanceId)).toEqual([]);
    expect(routesOf(h.db, w.instance.instanceId)).toEqual([]);
    expect(getTask(h.db, va)?.phase).toBe('blocked');
  });

  it("keeps the paragraph whole, cutting only the file's part of a body at 64 KiB", async () => {
    const eight = Array.from({ length: 8 }, () => '{{note}}').join('');
    writeFileSync(
      join(b.dir, 'vi-workflow.yaml'),
      VI_WORKFLOW.replace('  case: { required', '  note: { required: true }\n  case: { required').replace(
        '    title: "{{case}} · va, escalated"\n',
        `    title: "{{case}} · va, escalated"\n    body: "${eight}${'b'.repeat(1_500)}"\n`,
      ),
    );
    const w = madeOf(
      b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1', note: 'n'.repeat(8_000) } }, createdBy: ALICE, createdVia: VIA }),
    );
    await done(w.tasks[0]?.taskId ?? '', CVE);
    const va = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'va')?.taskId ?? '';
    giveUp(va);
    const body = getTask(h.db, handlers(w.instance.instanceId)[0]?.taskId ?? '')?.body ?? '';
    expect(Buffer.byteLength(body)).toBe(64 * 1024);
    expect(body).toMatch(/\n\nRouted from `k_[a-z0-9]+` \(step va\): it gave up: failed 1 times; last crashed\.\n/);
    expect(body.endsWith('returns it to work instead.')).toBe(true);
  });

  it("names the handler's source in the worker's show, from its route row", async () => {
    const { w, va } = await vaOf();
    giveUp(va);
    const escalate = handlers(w.instance.instanceId)[0]?.taskId ?? '';
    const run = workerRun(b.service, h.db, escalate);
    const event = routesOf(h.db, w.instance.instanceId)[0]?.eventId;
    expect(await run.ask('show')).toMatchObject({ ok: true, routed_from: { task_id: va, step: 'va', item: null, event_id: event } });
  });
});
