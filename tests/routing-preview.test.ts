import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun, createBoard } from '../src/db/kanban.js';
import { eventsOf, getInstance } from '../src/db/kanban-read.js';
import { migrate, openDb } from '../src/db/open.js';
import { KanbanService } from '../src/kanban/service.js';
import { previewLines, renderNotice, renderPreview, renderStarted, startedReply } from '../src/kanban/chat-render.js';
import { mostLater, type Plan } from '../src/kanban/routing.js';
import { previewText } from '../src/cli/plain.js';
import { clearSecrets } from '../src/secrets.js';
import { ManualClock, SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { madeOf, viBoard, viRoles, workerRun, type ViBoard } from './helpers/routing.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * A routed file's preview and start (workflow routing spec §12.3, §13.2): the
 * plain tasks, then each step made later in the words of a check, the first line
 * counting both, at most 500 in all; the start's reply's line of steps to come;
 * `waiting` in the worker's and the terminal's answers, and a repeat's answer
 * with every member now and the steps still waiting; an instance started before
 * migration 015 left as it was, with no plan, and no `waiting`.
 */

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  b = viBoard(h);
});
afterEach(() => h.close());

const PARAMS = { from: 'json', params: { case: 'CVE-1' } } as const;

function preview() {
  const r = b.service.previewWorkflow({ workflow: 'vi-workflow', params: PARAMS, createdBy: ALICE, createdVia: VIA, board: 'vi' });
  if (!r.ok) throw new Error(r.message);
  return r;
}

describe('the preview of a routed file', () => {
  it('lists the plain tasks, then each step made later, the first line counting both', () => {
    const r = preview();
    expect(renderPreview('vi-workflow', r.dag, (n) => n, undefined, 'default', r.plan).split('\n')).toEqual([
      'vi-workflow would make 1 task now, and up to 108 more as results come, on board **vi**:',
      '- `intake` CVE-1 · intake, for vi-coordinator',
      '- va: when intake.kind is cve; on gave up, routed to escalate',
      '- escalate: handler for va, standing in',
      '- verify: when intake.verify is true and va.reachable is true',
      '- exposure: per item of intake.packages, at most 100',
      '- registry: when intake.bnpm is true',
      '- report: when its parents are settled',
      '- patch: when intake.patch is true',
      'Nothing was made: `/kanban workflow start vi-workflow`, with these params, makes it.',
    ]);
    expect(previewText('vi-workflow', 'vi', previewLines(r.dag), r.plan)).toEqual([
      'vi-workflow would make 1 task now, and up to 108 more as results come, on board vi:',
      '  intake  CVE-1 · intake  role vi-coordinator',
      '  va: when intake.kind is cve; on gave up, routed to escalate',
      '  escalate: handler for va, standing in',
      '  verify: when intake.verify is true and va.reachable is true',
      '  exposure: per item of intake.packages, at most 100',
      '  registry: when intake.bnpm is true',
      '  report: when its parents are settled',
      '  patch: when intake.patch is true',
      'nothing was made: mt kanban workflow start vi-workflow, with these params, makes it',
    ]);
  });

  it('says at most 500 in all past the cap', () => {
    const r = preview();
    const plan = r.plan as Plan;
    const wide: Plan = { ...plan, steps: plan.steps.map((s) => (s.step === 'intake' ? { ...s, outputs: { ...s.outputs, packages: { list: 'string', max: 100 } } } : s)) };
    const more: Plan = { ...wide, steps: [...wide.steps, ...[1, 2, 3, 4].map((n) => ({ ...(wide.steps[4] as Plan['steps'][number]), step: `exposure${n}` }))] };
    expect(mostLater(more)).toBe(508);
    expect(renderPreview('vi-workflow', r.dag, (n) => n, undefined, 'vi', more).split('\n')[0]).toBe('vi-workflow would make 1 task now, and up to 508 more as results come, at most 500 in all, on board **vi**:');
  });
});

describe('the start of a routed file', () => {
  it("says the steps to come in its reply, and gives waiting in the worker's answer and a repeat's", async () => {
    const made = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: PARAMS, createdBy: ALICE, createdVia: VIA, idempotencyKey: 'lark:om_1' }));
    expect(made.waiting).toEqual(['va', 'verify', 'exposure', 'registry', 'report', 'patch']);
    const reply = renderStarted(startedReply(made), 'thread', (a) => a.name);
    expect(reply).toContain(`6 more steps are made as results come: \`/kanban workflow show ${made.instance.instanceId}\` follows them.`);
    const intake = made.tasks[0]?.taskId ?? '';
    const run = claimed(h.db, intake);
    await b.service.complete(intake, { kind: 'run', runId: run.runId }, { summary: 'x', metadata: { kind: 'supplychain', verify: false, patch: true, bnpm: false, packages: [] } });
    closeRun(h.db, run.runId, NOW);
    const again = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: PARAMS, createdBy: ALICE, createdVia: VIA, idempotencyKey: 'lark:om_1' }));
    expect(again.existing).toBe(true);
    expect(again.tasks.map((t) => t.ref)).toEqual(['intake', 'report']);
    expect(again.waiting).toEqual(['patch']);
  });

  it("gives waiting in a run's start-workflow answer, and the terminal's start's reply its line too", async () => {
    const planner = b.service.create({ title: 'plan', assignee: 'vi-coordinator', createdBy: ALICE, createdVia: VIA, board: 'vi' });
    if (!planner.ok) throw new Error(planner.message);
    const run = workerRun(b.service, h.db, planner.task.taskId);
    expect(await run.ask('start-workflow', { workflow: 'vi-workflow', params: { case: 'CVE-2' } })).toMatchObject({
      ok: true,
      waiting: ['va', 'verify', 'exposure', 'registry', 'report', 'patch'],
    });
    const follow = { appId: 'cli_app', chatId: 'oc_team', threadId: '', rootId: null };
    const term = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: PARAMS, createdBy: 'operator:me', createdVia: { kind: 'operator' }, follow }));
    const first = term.tasks[0];
    const started = eventsOf(h.db, first?.taskId ?? '').find((e) => e.kind === 'workflow_started');
    expect(started?.payload).toMatchObject({ waiting: 6 });
    if (started === undefined || first === undefined) throw new Error('no start');
    expect(renderNotice(started, first.task, { blockRecurrenceLimit: 3 })).toContain('6 more steps are made as results come');
  });
});

describe('an instance started before migration 015', () => {
  it('has no plan and no rows, its completions write nothing, its show, list, archive and repeat as before', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-routing-old-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) {
        if (/^01[0-4]_.*\.sql$/.test(f) || /^00[1-9]_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      }
      const d = openDb(join(dir, 'team.db'));
      try {
        expect(migrate(d, only)).toBe(14);
        createBoard(d, 'vi', ALICE, NOW);
        writeFileSync(join(b.dir, 'vendor-eval.yaml'), VENDOR_EVAL);
        const roles = viRoles();
        for (const name of ['worker', 'reviewer']) roles.set(name, viRoles().get('verifier') as never);
        const service = () => new KanbanService({ db: d, roles, workspaces: new Set(['default']), supervisedRoles: true, workflowsDir: b.dir, clock: new ManualClock(NOW) });
        const old = service();
        const params = { from: 'json', params: { topic: 't', vendors: ['a'] } } as const;
        const start = (s: KanbanService) => s.startWorkflow({ workflow: 'vendor-eval', params, createdBy: ALICE, createdVia: VIA, idempotencyKey: 'lark:om_old' });
        const made = madeOf(start(old));
        const id = made.instance.instanceId;
        const shown = old.instance(id);
        const listed = old.instances('default', true);
        expect(shown.ok && listed.instances.map((i) => i.instance.instanceId)).toEqual([id]);
        expect(migrate(d, SCHEMA_DIR)).toBe(15);
        const now = service();
        expect(getInstance(d, id)).toMatchObject({ plan: null, routingFailedAt: null });
        expect(now.instance(id)).toEqual(shown);
        expect(now.instances('default', true)).toEqual(listed);
        const shortlist = made.tasks[0]?.taskId ?? '';
        const run = claimed(d, shortlist);
        expect((await now.complete(shortlist, { kind: 'run', runId: run.runId }, { summary: 'x' })).ok).toBe(true);
        closeRun(d, run.runId, NOW);
        expect(eventsOf(d, shortlist).filter((e) => e.kind.startsWith('workflow_route'))).toEqual([]);
        for (const table of ['kanban_workflow_pending', 'kanban_workflow_settled', 'kanban_workflow_routes']) {
          expect(d.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        }
        const again = madeOf(start(now));
        expect(again.existing).toBe(true);
        expect(again).not.toHaveProperty('waiting');
        expect(now.archiveWorkflow(id, ALICE).ok).toBe(true);
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
