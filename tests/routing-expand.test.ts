import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalDag, type Dag } from '../src/kanban/dag.js';
import type { Plan } from '../src/kanban/routing.js';
import { checkWorkflow, expand, type Workflow, type WorkflowFacts } from '../src/kanban/workflow.js';
import type { Result } from '../src/kanban/types.js';
import { role } from './helpers/dispatch.js';
import { VI_WORKFLOW, viRoles } from './helpers/routing.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * The expansion of a routed file (workflow routing spec §7): the plain steps'
 * tasks in the DAG as today, the plan with every step, its templates with the
 * params filled in and the references to results left in place, the outputs
 * sentence in `outcome`; and a file with no routing key expanded byte for byte as
 * before, with no plan.
 */

const ROLES = viRoles();
ROLES.set('worker', role('worker'));
ROLES.set('reviewer', role('reviewer'));
const FACTS: WorkflowFacts = { roles: ROLES, workspaces: new Set(['default', 'vi']), supervisedRoles: false };

function workflow(text: string, name = 'vi-workflow'): Workflow {
  const r = checkWorkflow(name, text, FACTS);
  if (!r.ok) throw new Error(r.problem);
  return r.workflow;
}

function expanded(r: Result<{ dag: Dag; plan: Plan | null }>): { dag: Dag; plan: Plan | null } {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return { dag: r.dag, plan: r.plan };
}

const CASE = { from: 'json', params: { case: 'CVE-2026-12345' } } as const;
const SENTENCE = 'Report in the metadata of your completion: kind (one of cve, supplychain); verify (true or false); patch (true or false); bnpm (true or false); packages (a list of at most 100 texts).';

describe('the expansion of a routed file', () => {
  it('puts the plain steps in the DAG and every step in the plan, in the file\'s order', () => {
    const { dag, plan } = expanded(expand(workflow(VI_WORKFLOW), CASE, 'vi'));
    expect(dag.tasks.map((t) => t.ref)).toEqual(['intake']);
    expect(dag.tasks[0]).toMatchObject({ title: 'CVE-2026-12345 · intake', assignee: 'vi-coordinator', contract: { outcome: SENTENCE }, parents: [] });
    expect(plan?.format).toBe(1);
    expect(plan?.steps.map((s) => [s.step, s.made])).toEqual([
      ['intake', 'start'],
      ['va', 'decide'],
      ['escalate', 'route'],
      ['verify', 'decide'],
      ['exposure', 'decide'],
      ['registry', 'decide'],
      ['report', 'decide'],
      ['patch', 'decide'],
    ]);
  });

  it('gives each step its parents, outputs, when, fan-out, routes and template, the params filled in and the results left in place', () => {
    const { plan } = expanded(expand(workflow(VI_WORKFLOW), CASE, 'vi'));
    const step = (name: string) => plan?.steps.find((s) => s.step === name);
    expect(step('intake')).toMatchObject({ parents: [], on_blocked: 'wait', on_gave_up: 'wait', template: { title: 'CVE-2026-12345 · intake', contract: { outcome: SENTENCE } } });
    expect(step('va')).toEqual({
      step: 'va',
      made: 'decide',
      parents: ['intake'],
      outputs: { reachable: 'boolean' },
      when: [{ step: 'intake', output: 'kind', equals: 'cve' }],
      on_blocked: 'wait',
      on_gave_up: { route: 'escalate' },
      template: {
        title: 'CVE-2026-12345 · va',
        body: null,
        assignee: 'vulnerability-analyst',
        reviewer: null,
        workspace: null,
        priority: 0,
        contract: { outcome: 'Report in the metadata of your completion: reachable (true or false).' },
        failure_limit: null,
        retry_on_crash: 'always',
        max_runtime_s: null,
        gates: [],
        wake: null,
      },
    });
    expect(step('escalate')).toMatchObject({ made: 'route', handler: true, stands_in_for: 'va', parents: [], template: { title: 'CVE-2026-12345 · va, escalated' } });
    expect(step('exposure')).toMatchObject({ for_each: { step: 'intake', output: 'packages' }, template: { title: 'CVE-2026-12345 · exposure of {{item}}' } });
    expect(step('report')).toMatchObject({ parents: ['va', 'verify', 'exposure', 'registry'], template: { reviewer: 'assessment-reviewer' } });
    expect(step('report')?.when).toBeUndefined();
  });

  it('leaves {{step.output}} in a template, and expands a pending step over a list param as one template an item', () => {
    const text = `params:
  vendors: { list: true, required: true }
steps:
  intake:
    title: intake
    assignee: worker
    outputs: { kind: string }
  evaluate:
    title: "evaluate {{item}} as {{intake.kind}}"
    body: "for {{intake.kind}}"
    assignee: worker
    parents: [intake]
    for_each: vendors
    when: [{ step: intake, output: kind, equals: vendor }]
`;
    const { dag, plan } = expanded(expand(workflow(text, 'eval'), { from: 'json', params: { vendors: ['acme', 'globex'] } }, 'default'));
    expect(dag.tasks.map((t) => t.ref)).toEqual(['intake']);
    const evaluate = plan?.steps.find((s) => s.step === 'evaluate');
    expect(evaluate?.for_each).toEqual({ param: 'vendors' });
    expect(evaluate?.template).toBeUndefined();
    expect(evaluate?.templates?.map((t) => [t.item, t.title, t.body])).toEqual([
      ['acme', 'evaluate acme as {{intake.kind}}', 'for {{intake.kind}}'],
      ['globex', 'evaluate globex as {{intake.kind}}', 'for {{intake.kind}}'],
    ]);
  });

  it('expands a file using no routing key byte for byte as before, with no plan', () => {
    const { dag, plan } = expanded(expand(workflow(VENDOR_EVAL, 'vendor-eval'), { from: 'json', params: { topic: 'log storage', vendors: ['acme', 'globex'] } }, 'default'));
    expect(plan).toBeNull();
    expect(createHash('sha256').update(canonicalDag(dag), 'utf8').digest('hex')).toBe('bf503f04081410c78a7dbb0967fc19971fce393fdb140815aa159c148c3bfb9a');
  });

  it("refuses {{item}} in a result fan-out's contract or name field, as a result fills only a title and a body", () => {
    const fanned = (keys: string) =>
      checkWorkflow(
        'x',
        `steps:\n  intake:\n    title: intake\n    assignee: worker\n    outputs: { packages: { list: string, max: 3 } }\n  each:\n    title: "each {{item}}"\n    assignee: worker\n    parents: [intake]\n    for_each: { step: intake, output: packages }\n${keys}`,
        FACTS,
      );
    expect(fanned('    outcome: "about {{item}}"\n')).toEqual({ ok: false, problem: "steps.each.outcome uses {{item}}, a result's: a result fills only a title and a body" });
    expect(fanned('    workspace: "{{item}}"\n')).toEqual({ ok: false, problem: "steps.each.workspace uses {{item}}, a result's: a result fills only a title and a body" });
    expect(fanned('    body: "about {{item}}"\n').ok).toBe(true);
  });

  it('refuses a plan past 1 MiB', () => {
    const text = `params:
  vendors: { list: true, required: true }
steps:
  intake:
    title: intake
    assignee: worker
    outputs: { go: boolean }
  evaluate:
    title: "evaluate {{item}}"
    body: "all of {{vendors}}"
    assignee: worker
    parents: [intake]
    for_each: vendors
    when: [{ step: intake, output: go, is: true }]
`;
    const vendors = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, '0')}${'v'.repeat(600)}`);
    const r = expand(workflow(text, 'eval'), { from: 'json', params: { vendors } }, 'default');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('too_large');
    expect(r.message).toMatch(/^workflow eval's plan is \d+ bytes with these params; it may be at most 1048576$/);
  });
});
