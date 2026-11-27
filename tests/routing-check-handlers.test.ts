import { describe, expect, it } from 'vitest';
import { checkWorkflow, type WorkflowFacts } from '../src/kanban/workflow.js';
import { standInContract } from '../src/kanban/routing.js';
import { role } from './helpers/dispatch.js';
import { VI_WORKFLOW, viRoles } from './helpers/routing.js';

/**
 * The checks of routes and handlers (workflow routing spec §5, §6), message for
 * message: a handler made only when routed to, never a step's parent or
 * ancestor, never chaining; a route to a handler; and a stand-in that takes its
 * step's outputs, reviewer, gates, contract and checkout.
 */

const ROLES = viRoles();
ROLES.set('vi-ops', role('vi-ops', { workspace: 'ops' }));
ROLES.set('vi-analyst', role('vi-analyst', { workspace: 'vi' }));
const FACTS: WorkflowFacts = { roles: ROLES, workspaces: new Set(['default', 'vi', 'ops']), supervisedRoles: false };

function problem(text: string): string | undefined {
  const r = checkWorkflow('vi-workflow', text, FACTS);
  return r.ok ? undefined : r.problem;
}

function viWith(from: string, to: string): string {
  if (VI_WORKFLOW.split(from).length !== 2) throw new Error(`not once in the file: ${from}`);
  return VI_WORKFLOW.replace(from, to);
}

const ESCALATE = '  escalate:\n    title: "{{case}} · va, escalated"\n    assignee: vi-coordinator\n    handler: true\n    stands_in_for: va\n';

describe('the checks of routes and handlers', () => {
  it('refuses a handler named in parents, in a when, as a for_each source or in a reference', () => {
    expect(problem(viWith('parents: [va, verify, exposure, registry]', 'parents: [va, verify, exposure, registry, escalate]'))).toBe(
      "steps.report.parents names escalate, a handler, which is made only when routed to and is no step's parent",
    );
    expect(problem(viWith('{ step: intake, output: patch, is: true }', '{ step: escalate, output: reachable, is: true }'))).toBe(
      "steps.patch.when[0] names escalate, a handler, which is made only when routed to and is no step's ancestor",
    );
    expect(problem(viWith('for_each: { step: intake, output: packages }', 'for_each: { step: escalate, output: reachable }'))).toBe(
      "steps.exposure.for_each names escalate, a handler, which is made only when routed to and is no step's ancestor",
    );
    expect(problem(viWith('title: "{{case}} · patch"', 'title: "{{case}} · patch {{escalate.reachable}}"'))).toBe(
      "steps.patch.title names escalate, a handler, which is made only when routed to and is no step's ancestor",
    );
  });

  it('refuses a handler routed from nowhere, one with parents, when or for_each, and a route from a handler', () => {
    expect(problem(viWith('    on_gave_up: { route: escalate }\n', ''))).toBe(
      'steps.escalate is a handler, and no step routes to it: add on_blocked or on_gave_up: { route: escalate } to the step it handles',
    );
    expect(problem(viWith(ESCALATE, `${ESCALATE}    parents: [intake]\n`))).toBe('steps.escalate is a handler, made with no parents when routed to: it takes no parents');
    expect(problem(viWith(ESCALATE, `${ESCALATE}    when: [{ step: intake, state: done }]\n`))).toBe('steps.escalate is a handler, made only when routed to: it takes no when');
    expect(problem(viWith(ESCALATE, `${ESCALATE}    on_gave_up: { route: escalate }\n`))).toBe(
      "steps.escalate is a handler, and a handler's blocks wait for a person: it takes no on_gave_up, so routes never chain",
    );
  });

  it('refuses a route to a step that is no handler, or to none', () => {
    expect(problem(viWith('on_gave_up: { route: escalate }', 'on_gave_up: { route: report }'))).toBe('steps.va.on_gave_up routes to report, which is not a handler (handler: true)');
    expect(problem(viWith('on_gave_up: { route: escalate }', 'on_gave_up: { route: nope }'))).toBe('steps.va.on_gave_up routes to "nope", which is no step of this file');
  });

  it('refuses stands_in_for off a handler, naming no step, or a step that does not route to it', () => {
    expect(problem(viWith('    parents: [report]\n', '    parents: [report]\n    stands_in_for: report\n'))).toBe('steps.patch takes stands_in_for only as a handler (handler: true)');
    expect(problem(viWith('    stands_in_for: va\n', '    stands_in_for: nope\n'))).toBe('steps.escalate.stands_in_for names "nope", which is no step of this file');
    expect(problem(viWith('    stands_in_for: va\n', '    stands_in_for: intake\n'))).toBe('steps.escalate stands in for intake, which does not route to it');
  });

  it("refuses a stand-in whose outputs differ from its step's", () => {
    const escalated = `${ESCALATE}    outputs:\n      reachable: boolean\n`;
    expect(problem(viWith(escalated, `${ESCALATE}    outputs:\n      reachable: string\n`))).toBe(
      'steps.escalate stands in for va, and its outputs differ: va declares reachable (boolean), escalate reachable (string)',
    );
    expect(problem(viWith(escalated, ESCALATE))).toBe('steps.escalate stands in for va, and its outputs differ: va declares reachable (boolean), escalate none');
  });

  it("refuses a stand-in that names a reviewer of its own, as it takes its step's", () => {
    const withReviewer = viWith('    assignee: vulnerability-analyst\n', '    assignee: vulnerability-analyst\n    reviewer: { role: assessment-reviewer }\n');
    const both = withReviewer.replace(ESCALATE, `${ESCALATE}    reviewer: verifier\n`);
    expect(problem(both)).toBe("steps.escalate stands in for va, and takes va's reviewer (role assessment-reviewer): it names none of its own");
    expect(problem(viWith(ESCALATE, `${ESCALATE}    reviewer: verifier\n`))).toBe("steps.escalate stands in for va, and takes va's reviewer (none): it names none of its own");
    expect(problem(withReviewer)).toBeUndefined();
  });

  it("refuses a stand-in whose gates with its step's pass a task's bounds", () => {
    const gates = (n: number, timeout = 10) => `    gates:\n${Array.from({ length: n }, (_, i) => `      - { command: "test -s f${i}", timeout_s: ${timeout} }\n`).join('')}`;
    const va = (n: number, t?: number) => viWith('    assignee: vulnerability-analyst\n', `    assignee: vulnerability-analyst\n${gates(n, t)}`);
    expect(problem(va(2).replace(ESCALATE, `${ESCALATE}${gates(19)}`))).toBe("steps.escalate stands in for va, and va's 2 gates with its own 19 are 21: a task has at most 20");
    expect(problem(va(2, 200).replace(ESCALATE, `${ESCALATE}${gates(1, 300)}`))).toBe(
      "steps.escalate stands in for va, and va's gates with its own would take up to 700 s together; at most 600 s",
    );
    expect(problem(va(2).replace(ESCALATE, `${ESCALATE}${gates(18)}`))).toBeUndefined();
  });

  it("refuses a stand-in whose merged contract field passes 8 KiB, and merges each field as the step's, then the handler's", () => {
    const long = 'v'.repeat(5_000);
    const text = viWith('    assignee: vulnerability-analyst\n', `    assignee: vulnerability-analyst\n    verify: ${long}\n`).replace(ESCALATE, `${ESCALATE}    verify: ${long}\n`);
    expect(problem(text)).toBe(`steps.escalate stands in for va: its contract's verification with va's is ${"the step's (va): ".length + 5_000 + "\n\nthis handler's: ".length + 5_000} bytes; at most 8192`);
    expect(standInContract('va', { outcome: 'the verdict', verification: 'cites the advisory' }, { verification: 'says who was asked', constraints: 'read only' })).toEqual({
      outcome: "the step's (va): the verdict",
      verification: "the step's (va): cites the advisory\n\nthis handler's: says who was asked",
      constraints: 'read only',
    });
  });

  it("refuses a stand-in whose workspace certainly differs from its step's", () => {
    const text = viWith('    assignee: vulnerability-analyst\n', '    assignee: vi-analyst\n').replace(ESCALATE, ESCALATE.replace('vi-coordinator', 'vi-ops'));
    expect(problem(text)).toBe('steps.escalate stands in for va, whose gates run in workspace vi, and escalate works in ops');
    expect(problem(viWith('    assignee: vulnerability-analyst\n', '    assignee: vi-analyst\n'))).toBeUndefined();
  });

  it('allows {{item}} in a handler only when every step routing to it is a fan-out, and its references from the routed step\'s ancestors', () => {
    const helper = '  help:\n    title: "help {{item}}"\n    assignee: vi-coordinator\n    handler: true\n';
    const fanned = viWith('    for_each: { step: intake, output: packages }\n', '    for_each: { step: intake, output: packages }\n    on_blocked: { route: help }\n') + helper;
    expect(problem(fanned)).toBeUndefined();
    expect(problem(viWith('on_gave_up: { route: escalate }', 'on_gave_up: { route: escalate }\n    on_blocked: { route: help }') + helper)).toBe(
      'steps.help.title uses {{item}}, which only a for_each step has',
    );
    expect(problem(viWith('title: "{{case}} · va, escalated"', 'title: "{{case}} · va, escalated, {{intake.kind}}"'))).toBeUndefined();
    expect(problem(viWith('title: "{{case}} · va, escalated"', 'title: "{{case}} · va, escalated, {{va.reachable}}"'))).toBe(
      'steps.escalate.title names va, which is not an ancestor of escalate: a reference reads only steps its parents come after',
    );
  });
});
