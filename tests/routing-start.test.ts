import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBoard } from '../src/db/kanban.js';
import { getInstance, pendingOf } from '../src/db/kanban-read.js';
import { migrate, openDb } from '../src/db/open.js';
import { KanbanService } from '../src/kanban/service.js';
import type { CreatedVia } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA } from './helpers/kanban.js';
import { VI_WORKFLOW, madeOf, viBoard, viRoles, type ViBoard } from './helpers/routing.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * A start of a routed file (workflow routing spec §7.2, §7.3, §6, §8): the plain
 * steps' tasks made, the frozen plan stored, masked but for what decides and
 * what runs, its templates' wakes as the start resolved them, one waiting row a
 * pending step and none a handler; the templates checked with placeholders, a
 * person's outputs refused, and a database not yet at 015 refusing it.
 */

const SECRET = 'sk-live-1234567890';
let h: TestDb;
let b: ViBoard;

beforeEach(() => {
  clearSecrets();
  addSecrets([SECRET]);
  h = testDb();
  b = viBoard(h);
});
afterEach(() => {
  clearSecrets();
  h.close();
});

const CASE = { from: 'json', params: { case: 'CVE-2026-12345' } } as const;

function start(extra: Partial<Parameters<KanbanService['startWorkflow']>[0]> = {}) {
  return b.service.startWorkflow({ workflow: 'vi-workflow', params: CASE, createdBy: ALICE, createdVia: VIA, ...extra });
}

describe('a start of a routed file', () => {
  it('makes the plain steps, stores the plan, and writes one waiting row a pending step, none for the handler', () => {
    const r = madeOf(start());
    expect(r.tasks.map((t) => t.ref)).toEqual(['intake']);
    expect(r.instance.board).toBe('vi');
    const plan = getInstance(h.db, r.instance.instanceId)?.plan;
    expect(plan?.steps.map((s) => s.step)).toEqual(['intake', 'va', 'escalate', 'verify', 'exposure', 'registry', 'report', 'patch']);
    expect(plan?.steps.find((s) => s.step === 'verify')?.when).toEqual([
      { step: 'intake', output: 'verify', is: true },
      { step: 'va', output: 'reachable', is: true },
    ]);
    expect(pendingOf(h.db, r.instance.instanceId).map((p) => [p.step, p.state, p.decidedAt])).toEqual([
      ['exposure', 'waiting', null],
      ['patch', 'waiting', null],
      ['registry', 'waiting', null],
      ['report', 'waiting', null],
      ['va', 'waiting', null],
      ['verify', 'waiting', null],
    ]);
    expect(r.tasks[0]?.task.contract.outcome).toMatch(/^Report in the metadata of your completion: kind \(one of cve, supplychain\);/);
  });

  it('stores the templates masked, its gates and its clause and enum values as written', () => {
    writeFileSync(
      join(b.dir, 'vi-workflow.yaml'),
      VI_WORKFLOW.replace('    assignee: vulnerability-analyst\n', '    assignee: vulnerability-analyst\n    body: "see {{case}}"\n    gates:\n      - { command: "vi-workflow-gate result.json", timeout_s: 30 }\n'),
    );
    const r = madeOf(start({ params: { from: 'json', params: { case: `CVE ${SECRET}` } } }));
    const plan = getInstance(h.db, r.instance.instanceId)?.plan;
    const va = plan?.steps.find((s) => s.step === 'va');
    expect(va?.template).toMatchObject({ title: `CVE ${MASK} · va`, body: `see CVE ${MASK}`, gates: [{ command: 'vi-workflow-gate result.json', timeout_s: 30 }] });
    expect(va?.when).toEqual([{ step: 'intake', output: 'kind', equals: 'cve' }]);
    expect(plan?.steps[0]?.outputs).toEqual({
      kind: { enum: ['cve', 'supplychain'] },
      verify: 'boolean',
      patch: 'boolean',
      bnpm: 'boolean',
      packages: { list: 'string', max: 100 },
    });
  });

  it("gives each template its step's wake as the start resolved it, and none for a run's start", () => {
    const r = madeOf(start({ wake: { by: ALICE, depth: 0, all: true } }));
    const plan = getInstance(h.db, r.instance.instanceId)?.plan;
    expect(plan?.steps.find((s) => s.step === 'verify')?.template?.wake).toEqual({ by: ALICE, depth: 0 });
    expect(plan?.steps.find((s) => s.step === 'escalate')?.template?.wake).toEqual({ by: ALICE, depth: 0 });
    const none = madeOf(start({ idempotencyKey: 'lark:om_2' }));
    expect(getInstance(h.db, none.instance.instanceId)?.plan?.steps.find((s) => s.step === 'verify')?.template?.wake).toBeNull();
  });

  it('checks each template as create would, references filled with their widest form, refusing a title too long already', () => {
    // 501 bytes, a space and supplychain, the enum's longest value: 513.
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW.replace('title: "{{case}} · registry"', `title: "${'x'.repeat(501)} {{intake.kind}}"`));
    expect(start()).toEqual({ ok: false, code: 'too_large', message: 'registry: its title is 513 bytes; at most 512' });
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW.replace('title: "{{case}} · registry"', `title: "${'x'.repeat(500)} {{intake.kind}}"`));
    expect(start().ok).toBe(true);
  });

  it("refuses a template for a person without talk tier, and a step with outputs whose assignee param names a person", () => {
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW.replace('    assignee: verifier\n', '    assignee: "lark:on_carol"\n'));
    expect(start()).toMatchObject({ ok: false, code: 'person_not_assignable', message: expect.stringMatching(/^verify: "lark:on_carol" cannot be given work: /) });
    writeFileSync(
      join(b.dir, 'vi-workflow.yaml'),
      VI_WORKFLOW.replace('  case: { required', '  who: { required: true }\n  case: { required').replace('    assignee: vulnerability-analyst\n', '    assignee: "{{who}}"\n'),
    );
    expect(start({ params: { from: 'json', params: { case: 'CVE-1', who: 'lark:on_bob' } } })).toEqual({
      ok: false,
      code: 'invalid',
      message: "steps.va declares outputs, which a role's run reports in its metadata, and its assignee is a person: a person's done gives none",
    });
  });

  it('starts a file using no routing key as before: no plan and no row', () => {
    writeFileSync(join(b.dir, 'vendor-eval.yaml'), VENDOR_EVAL);
    for (const name of ['worker', 'reviewer']) b.roles.set(name, viRoles().get('verifier') as never);
    const r = madeOf(
      b.service.startWorkflow({ workflow: 'vendor-eval', params: { from: 'json', params: { topic: 't', vendors: ['a'] } }, createdBy: ALICE, createdVia: VIA }),
    );
    expect(getInstance(h.db, r.instance.instanceId)?.plan).toBeNull();
    expect(pendingOf(h.db, r.instance.instanceId)).toEqual([]);
  });

  it('refuses a routed start on a database not yet migrated to 015, and starts an old file there as before', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-routing-start-'));
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
        const old = new KanbanService({ db: d, roles, workspaces: new Set(['default']), supervisedRoles: true, workflowsDir: b.dir });
        const via: CreatedVia = { kind: 'operator' };
        expect(old.startWorkflow({ workflow: 'vi-workflow', params: CASE, createdBy: 'operator:me', createdVia: via })).toEqual({
          ok: false,
          code: 'invalid',
          message: 'the database is not yet migrated to version 15: start the gateway once, so it is migrated',
        });
        expect(old.startWorkflow({ workflow: 'vendor-eval', params: { from: 'json', params: { topic: 't', vendors: ['a'] } }, createdBy: 'operator:me', createdVia: via }).ok).toBe(true);
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
