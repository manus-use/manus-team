import { describe, expect, it } from 'vitest';
import { decide, effectiveParents, INSTANCE_CAP, type Facts, type Plan, type PlanStep, type StepFact, type Template, type WhenItem } from '../src/kanban/routing.js';

/**
 * decide(plan, facts) on plans and facts written by hand (workflow routing spec
 * §3, §10): every clause and state, the any group, what a skipped or archived
 * step reads as, an early skip held until its parents settle, the effective
 * parents, archive spreading, the cap, and totality.
 */

const TEMPLATE: Template = {
  title: 't',
  body: null,
  assignee: 'worker',
  reviewer: null,
  workspace: null,
  priority: 0,
  contract: {},
  failure_limit: null,
  retry_on_crash: 'always',
  max_runtime_s: null,
  gates: [],
  wake: null,
};

function step(name: string, parents: string[] = [], extra: Partial<PlanStep> = {}): PlanStep {
  return { step: name, made: parents.length === 0 ? 'start' : 'decide', parents, outputs: {}, on_blocked: 'wait', on_gave_up: 'wait', template: { ...TEMPLATE }, ...extra };
}

/** a, a root with outputs; b, a child of a; c, a child of b. */
function plan(whenB?: WhenItem[], whenC?: WhenItem[]): Plan {
  return {
    format: 1,
    steps: [
      step('a', [], { outputs: { kind: { enum: ['cve', 'ghsa'] }, score: 'number', go: 'boolean', note: 'string', list: { list: 'string', max: 5 } } }),
      step('b', ['a'], whenB === undefined ? {} : { when: whenB }),
      step('c', ['b'], whenC === undefined ? {} : { when: whenC }),
    ],
  };
}

function fact(name: string, over: Partial<StepFact> = {}): StepFact {
  return { step: name, row: null, skippedBy: null, settled: null, items: new Map(), entered: { blocked: false, gaveUp: false }, result: null, ...over };
}

const DONE = (taskId: string, eventId: number) => ({ how: 'done' as const, taskId, eventId });

function facts(list: StepFact[], members = 1): Facts {
  return { steps: new Map(list.map((f) => [f.step, f])), due: [], members, cap: INSTANCE_CAP };
}

/** b's own decision, given a's result and settling, with b and c waiting: a skipped b's settling in the same call, and c's decision after it, are the settling tests'. */
function decideB(whenB: WhenItem[], a: Partial<StepFact>) {
  return decide(plan(whenB), facts([fact('a', { settled: DONE('k_a', 4), ...a }), fact('b', { row: 'waiting' }), fact('c', { row: 'waiting' })])).filter(
    (d) => d.step === 'b' && d.outcome !== 'settled',
  );
}

const RESULT = { kind: 'cve', score: 7, go: true, note: 'hello', list: ['x', 'y'] };

describe('the clauses', () => {
  it('decides equals on text, an enum, a number and a boolean, and in', () => {
    expect(decideB([{ step: 'a', output: 'kind', equals: 'cve' }], { result: RESULT })).toEqual([{ step: 'b', outcome: 'made', parents: ['k_a'], why: 'a.kind is cve' }]);
    expect(decideB([{ step: 'a', output: 'kind', equals: 'ghsa' }], { result: RESULT })).toEqual([{ step: 'b', outcome: 'skipped', by: 'when', why: 'a.kind is cve' }]);
    expect(decideB([{ step: 'a', output: 'note', equals: 'hello' }], { result: RESULT })[0]?.outcome).toBe('made');
    expect(decideB([{ step: 'a', output: 'score', equals: 7 }], { result: RESULT })[0]?.outcome).toBe('made');
    expect(decideB([{ step: 'a', output: 'go', equals: false }], { result: RESULT })).toEqual([{ step: 'b', outcome: 'skipped', by: 'when', why: 'a.go is true' }]);
    expect(decideB([{ step: 'a', output: 'kind', in: ['ghsa', 'cve'] }], { result: RESULT })[0]?.outcome).toBe('made');
    expect(decideB([{ step: 'a', output: 'kind', in: ['ghsa'] }], { result: RESULT })[0]?.outcome).toBe('skipped');
  });

  it('decides is true and false, and at_least and at_most at, below and above the bound', () => {
    expect(decideB([{ step: 'a', output: 'go', is: true }], { result: RESULT })[0]?.outcome).toBe('made');
    expect(decideB([{ step: 'a', output: 'go', is: false }], { result: RESULT })[0]?.outcome).toBe('skipped');
    for (const [bound, made] of [[6, true], [7, true], [8, false]] as const) {
      expect(decideB([{ step: 'a', output: 'score', at_least: bound }], { result: RESULT })[0]?.outcome).toBe(made ? 'made' : 'skipped');
    }
    for (const [bound, made] of [[6, false], [7, true], [8, true]] as const) {
      expect(decideB([{ step: 'a', output: 'score', at_most: bound }], { result: RESULT })[0]?.outcome).toBe(made ? 'made' : 'skipped');
    }
    expect(decideB([{ step: 'a', output: 'score', at_least: 8 }], { result: RESULT })).toEqual([{ step: 'b', outcome: 'skipped', by: 'when', why: 'a.score is 7' }]);
  });

  it('decides each state, done and skipped once settled, and blocked and gave_up at the transition', () => {
    expect(decideB([{ step: 'a', state: 'done' }], {})[0]?.outcome).toBe('made');
    expect(decideB([{ step: 'a', state: 'skipped' }], {})).toEqual([{ step: 'b', outcome: 'skipped', by: 'when', why: 'a is done' }]);
    expect(decideB([{ step: 'a', state: 'done' }], { settled: { how: 'skipped', taskId: null, eventId: 4 } })).toEqual([
      { step: 'b', outcome: 'skipped', by: 'when', why: 'a was skipped' },
    ]);
    expect(decideB([{ step: 'a', state: 'skipped' }], { settled: { how: 'skipped', taskId: null, eventId: 4 } })[0]?.outcome).toBe('made');
    // Its one parent archived undone: the clause holds, and the step is skipped by archive, never made with no link.
    expect(decideB([{ step: 'a', state: 'skipped' }], { settled: { how: 'archived', taskId: null, eventId: 4 } })).toEqual([
      { step: 'b', outcome: 'skipped', by: 'archive', why: 'its parents were archived' },
    ]);
    // Unsettled: a clause on its state is undecided, but blocked and gave_up hold at the transition.
    const running = (when: WhenItem[], entered = { blocked: false, gaveUp: false }) =>
      decide(plan(when), facts([fact('a', { entered }), fact('b', { row: 'waiting' }), fact('c', { row: 'waiting' })]));
    expect(running([{ step: 'a', state: 'done' }])).toEqual([]);
    expect(running([{ step: 'a', state: 'gave_up' }])).toEqual([]);
    expect(running([{ step: 'a', state: 'gave_up' }], { blocked: false, gaveUp: true })).toEqual([{ step: 'b', outcome: 'made', parents: [], why: 'a gave up' }]);
    expect(running([{ step: 'a', state: 'blocked' }], { blocked: true, gaveUp: false })).toEqual([{ step: 'b', outcome: 'made', parents: [], why: 'a blocked' }]);
    expect(running([{ step: 'a', state: 'blocked' }], { blocked: false, gaveUp: true })).toEqual([]);
    // Settled without having entered it: false.
    expect(decideB([{ step: 'a', state: 'gave_up' }], {})).toEqual([{ step: 'b', outcome: 'skipped', by: 'when', why: 'a did not give up' }]);
    expect(decideB([{ step: 'a', state: 'blocked' }], {})).toEqual([{ step: 'b', outcome: 'skipped', by: 'when', why: 'a did not block' }]);
  });

  it('holds an any group when one of three holds, not when none does, and a false clause before it skips first', () => {
    const any: WhenItem = { any: [{ step: 'a', output: 'score', at_least: 9 }, { step: 'a', output: 'kind', equals: 'cve' }, { step: 'a', output: 'go', is: false }] };
    expect(decideB([any], { result: RESULT })).toEqual([{ step: 'b', outcome: 'made', parents: ['k_a'], why: '(a.score is at least 9 or a.kind is cve or a.go is false)' }]);
    expect(decideB([any], { result: { ...RESULT, kind: 'ghsa' } })).toEqual([{ step: 'b', outcome: 'skipped', by: 'when', why: 'a.score is 7' }]);
    expect(decideB([{ step: 'a', output: 'go', is: false }, any], { result: RESULT })).toEqual([{ step: 'b', outcome: 'skipped', by: 'when', why: 'a.go is true' }]);
  });

  it('reads a clause on a skipped or undone archived step as false, and a done step archived later as done with its result', () => {
    expect(decideB([{ step: 'a', output: 'go', is: true }], { settled: { how: 'skipped', taskId: null, eventId: 4 }, result: RESULT })).toEqual([
      { step: 'b', outcome: 'skipped', by: 'when', why: 'a was skipped' },
    ]);
    expect(decideB([{ step: 'a', output: 'go', is: true }], { settled: { how: 'archived', taskId: null, eventId: 4 } })).toEqual([
      { step: 'b', outcome: 'skipped', by: 'when', why: 'a was archived' },
    ]);
    // Its settled row says done: the archive came after the accepted completion, and never wins.
    expect(decideB([{ step: 'a', output: 'go', is: true }], { result: RESULT })[0]?.outcome).toBe('made');
    expect(decideB([{ step: 'a', output: 'go', is: true }], { settled: { how: 'stood_in', taskId: 'k_s', eventId: 6 }, result: RESULT })).toEqual([
      { step: 'b', outcome: 'made', parents: ['k_s'], why: 'a.go is true' },
    ]);
  });

  it('reads a value of the wrong type as missing, and a step it does not know as unsettled', () => {
    expect(decideB([{ step: 'a', output: 'score', at_least: 1 }], { result: { score: '7' } })).toEqual([{ step: 'b', outcome: 'skipped', by: 'when', why: 'a.score is missing' }]);
    expect(decideB([{ step: 'a', output: 'kind', equals: 'cve' }], { result: { kind: 'library' } })[0]?.outcome).toBe('skipped');
    expect(decideB([{ step: 'nope', state: 'done' }], {})).toEqual([]);
  });
});

describe('skipping, settling and the effective parents', () => {
  it('skips a step whose when is false while its parent runs, settling it only once its parents are, and its child waits', () => {
    // c reads a, its grandparent, and b is still running.
    const p = plan(undefined, [{ step: 'a', output: 'go', is: false }]);
    const running = facts([fact('a', { settled: DONE('k_a', 4), result: RESULT }), fact('b', { row: 'made' }), fact('c', { row: 'waiting' })]);
    expect(decide(p, running)).toEqual([{ step: 'c', outcome: 'skipped', by: 'when', why: 'a.go is true' }]);
    const skipped = facts([fact('a', { settled: DONE('k_a', 4), result: RESULT }), fact('b', { row: 'made' }), fact('c', { row: 'skipped', skippedBy: 'when' })]);
    expect(decide(p, skipped)).toEqual([]);
    const through = facts([fact('a', { settled: DONE('k_a', 4), result: RESULT }), fact('b', { row: 'made', settled: DONE('k_b', 9) }), fact('c', { row: 'skipped', skippedBy: 'when' })]);
    expect(decide(p, through)).toEqual([{ step: 'c', outcome: 'settled', how: 'skipped', eventId: 9 }]);
  });

  it('settles a skipped step in the call that skips it once its parents are, so a chain below it settles in one call', () => {
    // b, c and d wait under a, archived undone: each is skipped by archive and settled at once, the next reading it.
    const p: Plan = { format: 1, steps: [...plan().steps, step('d', ['c'])] };
    const archived = { how: 'archived' as const, taskId: null, eventId: 5 };
    expect(decide(p, facts([fact('a', { settled: archived }), fact('b', { row: 'waiting' }), fact('c', { row: 'waiting' }), fact('d', { row: 'waiting' })]))).toEqual(
      ['b', 'c', 'd'].flatMap((name) => [
        { step: name, outcome: 'skipped', by: 'archive', why: 'its parents were archived' },
        { step: name, outcome: 'settled', how: 'archived', eventId: 5 },
      ]),
    );
    // A step skipped by its when with its parent settled settles at once, and its child is made, linked past it.
    expect(decide(plan([{ step: 'a', output: 'go', is: false }]), facts([fact('a', { settled: DONE('k_a', 4), result: RESULT }), fact('b', { row: 'waiting' }), fact('c', { row: 'waiting' })]))).toEqual([
      { step: 'b', outcome: 'skipped', by: 'when', why: 'a.go is true' },
      { step: 'b', outcome: 'settled', how: 'skipped', eventId: 4 },
      { step: 'c', outcome: 'made', parents: ['k_a'], why: 'its parents are settled' },
    ]);
  });

  it('links a child past a chain of two skips to the nearest done ancestor, never reading its outputs', () => {
    const p: Plan = { format: 1, steps: [...plan().steps, step('d', ['c'], { when: [{ step: 'c', state: 'skipped' }] })] };
    const f = facts([
      fact('a', { settled: DONE('k_a', 4), result: RESULT }),
      fact('b', { row: 'skipped', skippedBy: 'when', settled: { how: 'skipped', taskId: null, eventId: 4 } }),
      fact('c', { row: 'skipped', skippedBy: 'when', settled: { how: 'skipped', taskId: null, eventId: 4 } }),
      fact('d', { row: 'waiting' }),
    ]);
    expect(decide(p, f)).toEqual([{ step: 'd', outcome: 'made', parents: ['k_a'], why: 'c is skipped' }]);
    expect(effectiveParents(p, f, ['c'])).toEqual(['k_a']);
  });

  it('skips by archive a step whose parents were all archived undone, settles a skipped step so, and decides by the others when some are done', () => {
    const two: Plan = { format: 1, steps: [step('a'), step('x'), step('b', ['a', 'x'])] };
    const archived = { how: 'archived' as const, taskId: null, eventId: 5 };
    expect(decide(two, facts([fact('a', { settled: archived }), fact('x', { settled: { ...archived, eventId: 6 } }), fact('b', { row: 'waiting' })]))).toEqual([
      { step: 'b', outcome: 'skipped', by: 'archive', why: 'its parents were archived' },
      { step: 'b', outcome: 'settled', how: 'archived', eventId: 6 },
    ]);
    expect(decide(two, facts([fact('a', { settled: archived }), fact('x', { settled: DONE('k_x', 6) }), fact('b', { row: 'waiting' })]))).toEqual([
      { step: 'b', outcome: 'made', parents: ['k_x'], why: 'its parents are settled' },
    ]);
    // A step skipped by its when whose parents all count as skipped by archive counts so itself.
    expect(decide(two, facts([fact('a', { settled: archived }), fact('x', { settled: { ...archived, eventId: 6 } }), fact('b', { row: 'skipped', skippedBy: 'when' })]))).toEqual([
      { step: 'b', outcome: 'settled', how: 'archived', eventId: 6 },
    ]);
  });

  it('links a done parent archived later, and never a parent read by a true blocked or gave_up clause', () => {
    expect(decideB([{ step: 'a', state: 'done' }], { result: RESULT })).toEqual([{ step: 'b', outcome: 'made', parents: ['k_a'], why: 'a is done' }]);
    const stuck = decide(plan([{ step: 'a', state: 'gave_up' }]), facts([fact('a', { entered: { blocked: false, gaveUp: true } }), fact('b', { row: 'waiting' }), fact('c', { row: 'waiting' })]));
    expect(stuck).toEqual([{ step: 'b', outcome: 'made', parents: [], why: 'a gave up' }]);
  });

  it('decides a clause on a grandparent once it settles, and makes the step only once its parents are', () => {
    const p = plan(undefined, [{ step: 'a', output: 'go', is: true }]);
    expect(decide(p, facts([fact('a'), fact('b', { row: 'made' }), fact('c', { row: 'waiting' })]))).toEqual([]);
    expect(decide(p, facts([fact('a', { settled: DONE('k_a', 4), result: RESULT }), fact('b', { row: 'made' }), fact('c', { row: 'waiting' })]))).toEqual([]);
    expect(decide(p, facts([fact('a', { settled: DONE('k_a', 4), result: RESULT }), fact('b', { row: 'made', settled: DONE('k_b', 8) }), fact('c', { row: 'waiting' })]))).toEqual([
      { step: 'c', outcome: 'made', parents: ['k_b'], why: 'a.go is true' },
    ]);
  });

  it('decides a step once: a made or skipped row is never decided again', () => {
    expect(decide(plan([{ step: 'a', state: 'blocked' }]), facts([fact('a', { settled: DONE('k_a', 9) }), fact('b', { row: 'made' }), fact('c', { row: 'made' })]))).toEqual([]);
  });

  it('skips a step whose making would pass the cap, counting what this decision made', () => {
    const two: Plan = { format: 1, steps: [step('a'), step('b', ['a']), step('c', ['a'])] };
    const f = (members: number) => facts([fact('a', { settled: DONE('k_a', 4) }), fact('b', { row: 'waiting' }), fact('c', { row: 'waiting' })], members);
    expect(decide(two, f(498)).map((d) => d.outcome)).toEqual(['made', 'made']);
    expect(decide(two, f(499))).toEqual([
      { step: 'b', outcome: 'made', parents: ['k_a'], why: 'its parents are settled' },
      { step: 'c', outcome: 'skipped', by: 'cap', why: 'the instance has 500 tasks' },
      { step: 'c', outcome: 'settled', how: 'skipped', eventId: 4 },
    ]);
  });
});
