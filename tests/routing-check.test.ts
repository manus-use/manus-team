import { describe, expect, it } from 'vitest';
import { checkWorkflow, pendingSteps, type WorkflowFacts } from '../src/kanban/workflow.js';
import { outcomeWithOutputs, outputsSentence } from '../src/kanban/routing.js';
import { VI_WORKFLOW, viRoles } from './helpers/routing.js';

/**
 * The checks of a file's conditions, fan-outs and references to results
 * (workflow routing spec §6), message for message; which steps are pending
 * (§7.1); and the outputs sentence (§2.1).
 */

const FACTS: WorkflowFacts = { roles: viRoles(), workspaces: new Set(['default', 'vi']), supervisedRoles: false };

function problem(text: string): string | undefined {
  const r = checkWorkflow('vi-workflow', text, FACTS);
  return r.ok ? undefined : r.problem;
}

/** The vi file with one text replaced, which must be in it once. */
function viWith(from: string, to: string): string {
  if (VI_WORKFLOW.split(from).length !== 2) throw new Error(`not once in the file: ${from}`);
  return VI_WORKFLOW.replace(from, to);
}

describe('the checks of conditions and fan-outs', () => {
  it('passes the folded vi file of §1', () => {
    expect(problem(VI_WORKFLOW)).toBeUndefined();
  });

  it('refuses a clause, a for_each or a reference naming an undeclared output', () => {
    expect(problem(viWith('{ step: va, output: reachable, is: true }', '{ step: va, output: score, at_least: 7 }'))).toBe(
      'steps.verify.when[1] names va.score, which va does not declare (it declares reachable)',
    );
    expect(problem(viWith('for_each: { step: intake, output: packages }', 'for_each: { step: intake, output: pkgs }'))).toBe(
      'steps.exposure.for_each names intake.pkgs, which intake does not declare (it declares kind, verify, patch, bnpm, packages)',
    );
    expect(problem(viWith('title: "{{case}} · verify"', 'title: "{{case}} · verify, {{va.score}}"'))).toBe(
      'steps.verify.title names va.score, which va does not declare (it declares reachable)',
    );
    expect(problem(viWith('{ step: intake, output: bnpm, is: true }', '{ step: report, output: x, is: true }'))).toBe(
      'steps.registry.when[0] names report, which is not an ancestor of registry: a condition reads only steps its parents come after',
    );
  });

  it('refuses one naming a step that is not an ancestor, or no step', () => {
    expect(problem(viWith('{ step: va, output: reachable, is: true }', '{ step: registry, output: x, is: true }'))).toBe(
      'steps.verify.when[1] names registry, which is not an ancestor of verify: a condition reads only steps its parents come after',
    );
    expect(problem(viWith('{ step: va, output: reachable, is: true }', '{ step: nope, state: done }'))).toBe('steps.verify.when[1] names "nope", which is no step of this file');
    expect(problem(viWith('for_each: { step: intake, output: packages }', 'for_each: { step: registry, output: packages }'))).toBe(
      'steps.exposure.for_each names registry, which is not an ancestor of exposure: a fan-out reads only steps its parents come after',
    );
    expect(problem(viWith('title: "{{case}} · registry"', 'title: "{{case}} · registry, {{va.reachable}}"'))).toBe(
      'steps.registry.title names va, which is not an ancestor of registry: a reference reads only steps its parents come after',
    );
  });

  it('refuses a clause whose test does not fit the output, and a fan-out over no list', () => {
    expect(problem(viWith('{ step: va, output: reachable, is: true }', '{ step: va, output: reachable, at_least: 7 }'))).toBe(
      'steps.verify.when[1]: at_least compares a number, and va.reachable is a boolean',
    );
    expect(problem(viWith('{ step: intake, output: kind, equals: cve }', '{ step: intake, output: kind, equals: library }'))).toBe(
      "steps.va.when[0]: equals library is not one of intake.kind's values (cve, supplychain)",
    );
    expect(problem(viWith('{ step: intake, output: kind, equals: cve }', '{ step: intake, output: kind, in: [cve, ghsa] }'))).toBe(
      "steps.va.when[0]: in ghsa is not one of intake.kind's values (cve, supplychain)",
    );
    expect(problem(viWith('{ step: intake, output: kind, equals: cve }', '{ step: intake, output: kind, equals: 3 }'))).toBe(
      'steps.va.when[0]: equals compares a number, and intake.kind is an enum',
    );
    expect(problem(viWith('{ step: intake, output: kind, equals: cve }', '{ step: intake, output: verify, equals: yes }'))).toBe(
      'steps.va.when[0]: equals compares text, and intake.verify is a boolean',
    );
    expect(problem(viWith('{ step: intake, output: kind, equals: cve }', '{ step: intake, output: kind, is: true }'))).toBe(
      'steps.va.when[0]: is compares true or false, and intake.kind is an enum',
    );
    expect(problem(viWith('{ step: intake, output: kind, equals: cve }', '{ step: intake, output: packages, equals: lodash }'))).toBe(
      'steps.va.when[0] names intake.packages, a list: a list is read by a fan-out only',
    );
    expect(problem(viWith('for_each: { step: intake, output: packages }', 'for_each: { step: intake, output: kind }'))).toBe(
      'steps.exposure.for_each names intake.kind, which is no list',
    );
  });

  it('refuses a clause on a fan-out step, and a fan-out over a fan-out', () => {
    expect(problem(viWith('    parents: [va, verify, exposure, registry]\n', '    parents: [va, verify, exposure, registry]\n    when:\n      - { step: exposure, state: done }\n'))).toBe(
      'steps.report.when[0] names exposure, a fan-out step, whose items each have their own result',
    );
    const audit = `${VI_WORKFLOW}  audit:\n    title: audit {{item}}\n    assignee: verifier\n    parents: [exposure]\n    for_each: { step: exposure, output: reachable }\n`;
    expect(problem(audit)).toBe("steps.audit.for_each names exposure, itself a fan-out: a fan-out over another fan-out's items is not supported");
  });

  it('allows {{step.output}} in a pending step\'s title and body, and refuses it in a plain step, a contract field, a name field and a gate', () => {
    expect(problem(viWith('title: "{{case}} · verify"', 'title: "{{case}} · verify, {{intake.kind}}"\n    body: "reachable: {{va.reachable}}"'))).toBeUndefined();
    expect(problem(viWith('title: "{{case}} · va"', 'title: "{{case}} · va, {{intake.kind}}"'))).toBeUndefined();
    const plain = 'steps:\n  intake:\n    title: intake\n    assignee: vi-coordinator\n    outputs: { kind: string }\n  va:\n    title: "va {{intake.kind}}"\n    assignee: vulnerability-analyst\n    parents: [intake]\n';
    expect(problem(plain)).toBe('steps.va.title names {{intake.kind}}, and va is made at the start, before any result');
    expect(problem(viWith('title: "{{case}} · verify"', 'title: "{{case}} · verify"\n    outcome: "says {{intake.kind}}"'))).toBe(
      'steps.verify.outcome names {{intake.kind}}: a result fills only a title and a body',
    );
    expect(problem(viWith('    assignee: verifier\n', '    assignee: "{{intake.kind}}"\n'))).toBe('steps.verify.assignee names {{intake.kind}}: a result fills only a title and a body');
    expect(problem(viWith('    assignee: verifier\n', '    assignee: verifier\n    gates:\n      - command: "test {{intake.kind}}"\n'))).toBe(
      'steps.verify.gates[0].command holds {{, and a gate is a shell command: name the value as an environment variable instead',
    );
  });

  it("refuses outputs on a step whose assignee is written as a person", () => {
    const person = (who: string) =>
      problem(`steps:\n  intake:\n    title: intake\n    assignee: ${who}\n    outputs: { kind: string }\n`);
    const said = "steps.intake declares outputs, which a role's run reports in its metadata, and its assignee is a person: a person's done gives none";
    expect(person('"lark:on_alice"')).toBe(said);
    expect(person('{ person: "lark:on_alice" }')).toBe(said);
    expect(person('vi-coordinator')).toBeUndefined();
  });

  it('refuses an outcome past 8 KiB once its outputs sentence is added', () => {
    const long = 'x'.repeat(8_150);
    expect(problem(`steps:\n  intake:\n    title: intake\n    assignee: vi-coordinator\n    outcome: ${long}\n    outputs: { verify: boolean }\n`)).toBe(
      `steps.intake.outcome with its outputs sentence is ${8_150 + 2 + outputsSentence({ verify: 'boolean' }).length} bytes; at most 8192`,
    );
    expect(problem(`steps:\n  intake:\n    title: intake\n    assignee: vi-coordinator\n    outcome: ${long}\n`)).toBeUndefined();
  });
});

describe('which steps are pending (§7.1)', () => {
  it('makes pending a step with when, a result fan-out or handler, every step below one, and a child of a step a handler stands in for', () => {
    const r = checkWorkflow('vi-workflow', VI_WORKFLOW, FACTS);
    if (!r.ok) throw new Error(r.problem);
    expect([...pendingSteps(r.workflow.steps)].sort()).toEqual(['escalate', 'exposure', 'patch', 'registry', 'report', 'va', 'verify']);
    const stood = checkWorkflow(
      'x',
      'steps:\n  a:\n    title: a\n    assignee: verifier\n    on_gave_up: { route: h }\n  b:\n    title: b\n    assignee: verifier\n    parents: [a]\n  h:\n    title: h\n    assignee: verifier\n    handler: true\n    stands_in_for: a\n',
      FACTS,
    );
    if (!stood.ok) throw new Error(stood.problem);
    expect([...pendingSteps(stood.workflow.steps)].sort()).toEqual(['b', 'h']);
  });
});

describe('the outputs sentence (§2.1)', () => {
  it('names each output and its type', () => {
    expect(outputsSentence({ reachable: 'boolean', packages: { list: 'string', max: 50 } })).toBe(
      'Report in the metadata of your completion: reachable (true or false); packages (a list of at most 50 texts).',
    );
    expect(outputsSentence({ kind: { enum: ['cve', 'supplychain'] }, score: 'number', note: 'string', flags: { list: 'boolean', max: 3 }, kinds: { list: { enum: ['a', 'b'] }, max: 2 } })).toBe(
      'Report in the metadata of your completion: kind (one of cve, supplychain); score (a number); note (text); flags (a list of at most 3 true or false values); kinds (a list of at most 2 values of a, b).',
    );
    expect(outcomeWithOutputs('the verdict', { reachable: 'boolean' })).toBe('the verdict\n\nReport in the metadata of your completion: reachable (true or false).');
    expect(outcomeWithOutputs(undefined, { reachable: 'boolean' })).toBe('Report in the metadata of your completion: reachable (true or false).');
    expect(outcomeWithOutputs('the verdict', {})).toBe('the verdict');
  });
});
