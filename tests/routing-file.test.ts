import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkWorkflow, type Workflow, type WorkflowFacts } from '../src/kanban/workflow.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { VI_WORKFLOW, viRoles } from './helpers/routing.js';

/**
 * The routing keys as a file writes them (workflow routing spec §1 to §5): each
 * read into its step, and each malformed one refused naming its place, an
 * unknown key included.
 */

const FACTS: WorkflowFacts = { roles: viRoles(), workspaces: new Set(['default', 'vi']), supervisedRoles: false };
const SECRET = 'sk-live-1234567890';

beforeEach(() => {
  clearSecrets();
  addSecrets([SECRET]);
});
afterEach(() => clearSecrets());

function read(text: string): Workflow {
  const r = checkWorkflow('vi-workflow', text, FACTS);
  if (!r.ok) throw new Error(r.problem);
  return r.workflow;
}

function problem(text: string): string | undefined {
  const r = checkWorkflow('vi-workflow', text, FACTS);
  return r.ok ? undefined : r.problem;
}

/** A file of one plain step, `intake`, and a step `next` below it whose keys are `keys`, indented as a step's. */
function withNext(keys: string, intake = 'outputs: { kind: { enum: [cve, ghsa] }, score: number, packages: { list: string, max: 5 } }'): string {
  return `steps:\n  intake:\n    title: intake\n    assignee: vi-coordinator\n    ${intake}\n  next:\n    title: next\n    assignee: verifier\n    parents: [intake]\n${keys
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')}\n`;
}

describe('the routing keys', () => {
  it('reads the folded vi file of §1: outputs, when, a result fan-out, a route and a handler standing in', () => {
    const w = read(VI_WORKFLOW);
    const step = (name: string) => w.steps.find((s) => s.name === name);
    expect(step('intake')).toMatchObject({
      outputs: { kind: { enum: ['cve', 'supplychain'] }, verify: 'boolean', patch: 'boolean', bnpm: 'boolean', packages: { list: 'string', max: 100 } },
      when: undefined,
      forEach: undefined,
      onBlocked: 'wait',
      onGaveUp: 'wait',
      handler: false,
      standsInFor: undefined,
    });
    expect(Object.keys(step('intake')?.outputs ?? {})).toEqual(['kind', 'verify', 'patch', 'bnpm', 'packages']);
    expect(step('va')).toMatchObject({ when: [{ step: 'intake', output: 'kind', equals: 'cve' }], onGaveUp: { route: 'escalate' }, outputs: { reachable: 'boolean' } });
    expect(step('escalate')).toMatchObject({ handler: true, standsInFor: 'va', parents: [], outputs: { reachable: 'boolean' } });
    expect(step('verify')?.when).toEqual([
      { step: 'intake', output: 'verify', is: true },
      { step: 'va', output: 'reachable', is: true },
    ]);
    expect(step('exposure')?.forEach).toEqual({ step: 'intake', output: 'packages' });
    expect(step('report')).toMatchObject({ outputs: {}, when: undefined, handler: false });
  });

  it('reads every test, a state and one any group', () => {
    const w = read(
      withNext(
        [
          'when:',
          '  - { step: intake, output: kind, equals: cve }',
          '  - { step: intake, output: kind, in: [cve, ghsa] }',
          '  - { step: intake, output: score, at_least: 7 }',
          '  - { step: intake, output: score, at_most: 9.5 }',
          '  - { step: intake, state: done }',
          '  - any:',
          '      - { step: intake, output: score, equals: 10 }',
          '      - { step: intake, state: skipped }',
        ].join('\n'),
      ),
    );
    expect(w.steps[1]?.when).toEqual([
      { step: 'intake', output: 'kind', equals: 'cve' },
      { step: 'intake', output: 'kind', in: ['cve', 'ghsa'] },
      { step: 'intake', output: 'score', at_least: 7 },
      { step: 'intake', output: 'score', at_most: 9.5 },
      { step: 'intake', state: 'done' },
      {
        any: [
          { step: 'intake', output: 'score', equals: 10 },
          { step: 'intake', state: 'skipped' },
        ],
      },
    ]);
  });

  it('refuses a malformed output, naming its place', () => {
    const out = (o: string) => problem(withNext('priority: 1', `outputs: { ${o} }`));
    expect(out('Kind: boolean')).toBe(
      "steps.intake.outputs: output name \"Kind\" must be lowercase letters, digits and '-', start with a letter, not end with '-', and be at most 40 characters",
    );
    expect(out('kind: text')).toBe('steps.intake.outputs.kind is boolean, number, string, { enum: [values] } or { list: <type>, max: <n> }');
    expect(out('packages: { list: string }')).toBe('steps.intake.outputs.packages: a list needs its max, from 1 to 100');
    expect(out('packages: { list: string, max: 101 }')).toBe('steps.intake.outputs.packages: a list needs its max, from 1 to 100');
    expect(out('packages: { list: { list: string, max: 2 }, max: 2 }')).toBe(
      "steps.intake.outputs.packages: a list's items are boolean, number, string or { enum: [values] }",
    );
    expect(out('kind: { enum: [] }')).toBe('steps.intake.outputs.kind: an enum has 1 to 50 values');
    expect(out('kind: { enum: [cve, cve] }')).toBe('steps.intake.outputs.kind: an enum names "cve" twice');
    expect(out('kind: { enum: [cve, 7] }')).toBe("steps.intake.outputs.kind: an enum's values are text of 1 to 256 bytes, on one line");
    expect(out(`kind: { enum: [cve, ${SECRET}] }`)).toBe('steps.intake.outputs.kind: an enum value holds a known secret, and an enum value is stored as written');
    expect(out('kind: { enum: [cve], other: 1 }')).toBe('unknown setting steps.intake.outputs.kind.other (known: enum)');
  });

  it('refuses a malformed when, naming its place', () => {
    const when = (w: string) => problem(withNext(`when:\n${w}`));
    expect(problem(withNext('when: { step: intake, state: done }'))).toBe('steps.next.when is a list of clauses, at least one');
    expect(when('  - any: [{ step: intake, state: done }]\n  - any: [{ step: intake, state: skipped }]')).toBe('steps.next.when has two any groups; it takes one');
    expect(when('  - any: []')).toBe('steps.next.when[0].any is a list of clauses, at least one');
    expect(when('  - any: [{ any: [{ step: intake, state: done }] }]')).toBe('steps.next.when[0].any[0] is a clause: an any group holds no other group');
    expect(when('  - { step: intake, output: kind, equals: cve, in: [cve] }')).toBe('steps.next.when[0] has two tests, equals and in; a clause takes one');
    expect(when('  - { step: intake, output: kind }')).toBe('steps.next.when[0] names an output and one test, or a state');
    expect(when('  - { step: intake, state: done, output: kind }')).toBe('steps.next.when[0] reads a state or an output, not both');
    expect(when('  - { step: intake, state: failed }')).toBe('steps.next.when[0].state is done, skipped, gave_up or blocked');
    expect(when('  - { step: intake, output: kind, is: yes }')).toBe('steps.next.when[0].is is true or false');
    expect(when('  - { step: intake, output: score, at_least: high }')).toBe('steps.next.when[0].at_least is a number');
    expect(when('  - { step: intake, output: kind, in: [] }')).toBe('steps.next.when[0].in is a list of text, numbers, true or false');
    expect(when('  - { step: intake, output: kind, equals: [cve] }')).toBe('steps.next.when[0].equals is text, a number, true or false');
    expect(when(`  - { step: intake, output: kind, equals: ${SECRET} }`)).toBe("steps.next.when[0].equals holds a known secret, and a clause's value is stored as written");
    expect(when('  - { step: intake, output: kind, equal: cve }')).toBe('unknown setting steps.next.when[0].equal (known: step, output, state, equals, in, is, at_least, at_most)');
    expect(when('  - cve')).toBe('steps.next.when[0] is a clause: { step, output, <test> } or { step, state }');
  });

  it('tells the two for_each forms apart by their YAML type, and refuses anything else', () => {
    expect(read(withNext('for_each: { step: intake, output: packages }')).steps[1]?.forEach).toEqual({ step: 'intake', output: 'packages' });
    const bad = "steps.next.for_each is a list param's name, or { step, output } naming an ancestor's list output";
    expect(problem(withNext('for_each: { step: intake }'))).toBe(bad);
    expect(problem(withNext('for_each: { step: intake, output: packages, max: 3 }'))).toBe(bad);
    expect(problem(withNext('for_each: [intake]'))).toBe(bad);
    // Text is a list param's name, as today: never the step.
    expect(problem(withNext('for_each: intake'))).toBe('steps.next.for_each names "intake", which is no param this file declares');
  });

  it('refuses a malformed route, handler or stands_in_for, naming its place', () => {
    expect(problem(withNext('on_gave_up: escalate'))).toBe('steps.next.on_gave_up is wait or { route: <handler step> }');
    expect(problem(withNext('on_gave_up: { rout: escalate }'))).toBe('unknown setting steps.next.on_gave_up.rout (known: route)');
    expect(problem(withNext('on_blocked: { route: 3 }'))).toBe("steps.next.on_blocked.route is a step's name");
    expect(problem(withNext('handler: yes'))).toBe('steps.next.handler is true or false');
    expect(problem(withNext('stands_in_for: [intake]'))).toBe("steps.next.stands_in_for is a step's name");
    expect(read(withNext('on_blocked: wait')).steps[1]).toMatchObject({ onBlocked: 'wait', onGaveUp: 'wait', handler: false });
  });
});
