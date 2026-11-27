import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { closeRun, createBoard } from '../src/db/kanban.js';
import { membersOf } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { renderInstance } from '../src/kanban/chat-render.js';
import { stepLines, type Plan } from '../src/kanban/routing.js';
import { KanbanService } from '../src/kanban/service.js';
import { clearSecrets } from '../src/secrets.js';
import { ManualClock, SCHEMA_DIR } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';
import { VI_ROLES, VI_WORKFLOW, madeOf, viRoles } from './helpers/routing.js';

/**
 * What `workflow show` says of a routed instance (workflow routing spec §12.1):
 * every step, real or pending, in the plan's order, with where it is and why,
 * its tasks under it; a handler never routed to absent; the failed-routing line;
 * and at the terminal, `--json`'s steps, `--plan`, and `--dag`'s note.
 */

let f: MtFixture;
let db: Db;
let service: KanbanService;
beforeEach(() => {
  clearSecrets();
  f = mtFixture();
  for (const name of VI_ROLES) {
    mkdirSync(join(f.home, 'roles', name), { recursive: true });
    writeFileSync(join(f.home, 'roles', name, 'config.yaml'), 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
  }
  mkdirSync(join(f.home, 'workflows'));
  writeFileSync(join(f.home, 'workflows', 'vi-workflow.yaml'), VI_WORKFLOW);
  db = openDb(join(f.home, 'team.db'));
  migrate(db, SCHEMA_DIR);
  createBoard(db, 'vi', ALICE, NOW);
  service = new KanbanService({
    db,
    roles: viRoles(),
    workspaces: new Set(['default']),
    supervisedRoles: true,
    workflowsDir: join(f.home, 'workflows'),
    clock: new ManualClock(NOW),
    limits: { failureLimit: 1, transientLimit: 10, transientCooldownS: 300 },
  });
});
afterEach(() => {
  clearSecrets();
  db.close();
  f.cleanup();
});

async function done(taskId: string, metadata: Record<string, unknown> = {}): Promise<void> {
  const run = claimed(db, taskId);
  const r = await service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'did it', metadata });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  closeRun(db, run.runId, NOW);
}

/** The vi file's instance, its intake done, va stood in for by escalate, one exposure item done. */
async function staged(): Promise<string> {
  const w = madeOf(service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
  const id = w.instance.instanceId;
  await done(w.tasks[0]?.taskId ?? '', { kind: 'cve', verify: false, patch: false, bnpm: false, packages: ['lodash', 'minimist', 'qs'] });
  const step = (s: string) => membersOf(db, id).filter((m) => m.step === s).map((m) => m.taskId);
  const va = step('va')[0] ?? '';
  const run = claimed(db, va);
  service.endRun(run.runId, { outcome: 'crashed' });
  closeRun(db, run.runId, NOW);
  await done(step('escalate')[0] ?? '', { reachable: true });
  await done(step('exposure')[0] ?? '');
  return id;
}

const anon = (text: string) => text.replace(/k_[a-z0-9]+/g, 'k_…').replace(/w_[a-z0-9]+/g, 'w_…');

describe('workflow show of a routed instance', () => {
  it("says every step in the plan's order, where it is and why, its tasks under it", async () => {
    const id = await staged();
    const r = service.instance(id);
    if (!r.ok) throw new Error(r.message);
    const text = renderInstance(r.view, 'vi', (a) => (a === null ? 'nobody' : `role ${a.name}`), () => undefined);
    // Chat's markdown escapes the parentheses, as every label does.
    expect(anon(text).split('\n').slice(3)).toEqual([
      'Params: case: CVE-1',
      '✓ intake: done \\(kind=cve, verify=false, patch=false, bnpm=false, 3 packages\\)',
      '- `k_…` done · role vi-coordinator',
      '✓ va: done, stood in for by escalate \\(reachable=true\\)',
      '- `k_…` archived · role vulnerability-analyst',
      '↪ escalate: routed from va \\(gave up\\), standing in',
      '- `k_…` escalate:1 done · role vi-coordinator',
      '⏭ verify: skipped \\(intake.verify is false\\)',
      '▶ exposure: 3 items, 1 done',
      '- `k_…` lodash: done · role exposure-analyst',
      '- `k_…` minimist: ready · role exposure-analyst',
      '- `k_…` qs: ready · role exposure-analyst',
      '⏭ registry: skipped \\(intake.bnpm is false\\)',
      '⏳ report: waiting for exposure',
      '⏭ patch: skipped \\(intake.patch is false\\), waiting for report',
    ]);
    expect(anon(text).split('\n')[0]).toBe('**vi-workflow** `w_…`: running, 6 of 10 done · board: **vi**');
  });

  it('names the stand-in that won by its task, not a helper routed from the step before it', async () => {
    writeFileSync(
      join(f.home, 'workflows', 'vi-workflow.yaml'),
      `${VI_WORKFLOW.replace('    on_gave_up: { route: escalate }\n', '    on_gave_up: { route: escalate }\n    on_blocked: { route: help }\n')}  help:\n    title: "{{case}} · help va"\n    assignee: vi-coordinator\n    handler: true\n`,
    );
    const w = madeOf(service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
    const id = w.instance.instanceId;
    await done(w.tasks[0]?.taskId ?? '', { kind: 'cve', verify: false, patch: false, bnpm: false, packages: [] });
    const step = (s: string) => membersOf(db, id).find((m) => m.step === s)?.taskId ?? '';
    const va = step('va');
    // The helper first, for a block; then the stand-in, for a give-up.
    const blocked = claimed(db, va);
    expect(service.block(va, { kind: 'run', runId: blocked.runId }, { kind: 'capability', reason: 'no network' }).ok).toBe(true);
    closeRun(db, blocked.runId, NOW);
    expect(step('help')).not.toBe('');
    expect(service.unblock(va, ALICE).ok).toBe(true);
    const crashed = claimed(db, va);
    service.endRun(crashed.runId, { outcome: 'crashed' });
    closeRun(db, crashed.runId, NOW);
    await done(step('escalate'), { reachable: true });
    const r = service.instance(id);
    if (!r.ok) throw new Error(r.message);
    expect(r.view.steps?.find((l) => l.step === 'va')?.text).toBe('va: done, stood in for by escalate (reachable=true)');
  });

  it('says a route the transient limit made by the throttles that stopped its task', async () => {
    const w = madeOf(service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
    await done(w.tasks[0]?.taskId ?? '', { kind: 'cve', verify: false, patch: false, bnpm: false, packages: [] });
    const va = membersOf(db, w.instance.instanceId).find((m) => m.step === 'va')?.taskId ?? '';
    for (let n = 1; n <= 10; n += 1) {
      // The cooldown lifted at once: the clock here does not move.
      db.prepare('UPDATE kanban_tasks SET cooldown_until = NULL WHERE task_id = ?').run(va);
      const run = claimed(db, va);
      service.endRun(run.runId, { outcome: 'rate_limited' });
      closeRun(db, run.runId, NOW);
    }
    const r = service.instance(w.instance.instanceId);
    if (!r.ok) throw new Error(r.message);
    const text = renderInstance(r.view, 'vi', () => 'x', () => undefined);
    expect(anon(text)).toContain('↪ escalate: routed from va \\(stopped after 10 throttles\\), standing in');
  });

  it('adds the failed-routing line while the fault is not reconciled', async () => {
    const w = madeOf(service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
    db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled BEGIN SELECT RAISE(ABORT, 'cannot write'); END;");
    await done(w.tasks[0]?.taskId ?? '', { kind: 'cve', verify: false, patch: false, bnpm: false, packages: [] });
    const r = service.instance(w.instance.instanceId);
    if (!r.ok) throw new Error(r.message);
    expect(r.view.routingFailed).toEqual({ at: NOW, error: 'cannot write' });
    const text = renderInstance(r.view, 'vi', () => 'x', () => undefined);
    expect(anon(text)).toContain('Routing failed at 08:53 UTC: cannot write. The gateway tries again; `mt kanban workflow reconcile w_…` tries now.');
  });

  it('leaves out a handler never routed to, and shows waiting and running steps', () => {
    const plan: Plan = {
      format: 1,
      steps: [
        { step: 'a', made: 'start', parents: [], outputs: {}, on_blocked: 'wait', on_gave_up: { route: 'h' } },
        { step: 'b', made: 'decide', parents: ['a'], outputs: {}, on_blocked: 'wait', on_gave_up: 'wait', when: [{ step: 'a', state: 'done' }] },
        { step: 'h', made: 'route', parents: [], outputs: {}, on_blocked: 'wait', on_gave_up: 'wait', handler: true },
      ],
    };
    expect(stepLines(plan, [{ step: 'a', ref: 'a', taskId: 'k_a', phase: 'open' }], [{ step: 'b', state: 'waiting', reason: null }], [], [], new Map())).toEqual([
      { step: 'a', mark: '▶', text: 'a: running', state: 'running', why: null, items: null, routes: 0 },
      { step: 'b', mark: '⏳', text: 'b: waiting for a', state: 'waiting', why: null, items: null, routes: 0 },
    ]);
    expect(stepLines(plan, [{ step: 'a', ref: 'a', taskId: 'k_a', phase: 'blocked' }], [{ step: 'b', state: 'waiting', reason: null }], [], [], new Map())[0]).toMatchObject({
      mark: '⛔',
      text: 'a: blocked',
    });
  });
});

describe('mt kanban workflow show of a routed instance', () => {
  async function mt(...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMt(['kanban', 'workflow', 'show', ...argv], { env: { ...f.env, HOME: f.root }, out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it("gives the step lines, --json's steps, --plan, and --dag with its note", async () => {
    const id = await staged();
    const plain = await mt(id);
    expect(plain.code).toBe(0);
    expect(anon(plain.out)).toContain('↪ escalate: routed from va (gave up), standing in\n  k_… escalate:1 done · role vi-coordinator');
    const json = JSON.parse((await mt(id, '--json')).out) as { steps: unknown[] };
    expect(json.steps).toContainEqual({ step: 'escalate', state: 'routed', why: 'gave up', items: null, routes: 1 });
    expect(json.steps).toContainEqual({ step: 'exposure', state: 'running', why: null, items: 3, routes: 0 });
    expect(json.steps).toContainEqual({ step: 'verify', state: 'skipped', why: 'intake.verify is false', items: null, routes: 0 });
    const plan = await mt(id, '--plan');
    expect((JSON.parse(plan.out) as Plan).steps.map((s) => s.step)).toEqual(['intake', 'va', 'escalate', 'verify', 'exposure', 'registry', 'report', 'patch']);
    const dag = await mt(id, '--dag');
    expect(dag.err).toBe(`mt: instance ${id} has a plan: its DAG holds only the steps made at the start, and mt kanban workflow show ${id} --plan prints the rest`);
    expect(JSON.parse(dag.out)).toMatchObject({ workflow: 'vi-workflow', tasks: [{ ref: 'intake' }] });
  });
});
