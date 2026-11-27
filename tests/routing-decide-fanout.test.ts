import { describe, expect, it } from 'vitest';
import { decide, INSTANCE_CAP, type Facts, type Plan, type PlanStep, type SettledFact, type StepFact, type Template } from '../src/kanban/routing.js';

/**
 * decide's result fan-out and its join (workflow routing spec §4): one task an
 * item of the source's accepted list, in its order; an empty list, or a skipped
 * or archived source, skipping it; a source stood in for fanning out from the
 * stand-in's list; the join's child decided only once the fan-out's own row is
 * there, linked to each item's winner and to none archived undone; and a
 * fan-out made whole or not at all at the cap.
 */

const TEMPLATE: Template = {
  title: 'each {{item}}',
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

function step(name: string, parents: string[], extra: Partial<PlanStep> = {}): PlanStep {
  return { step: name, made: parents.length === 0 ? 'start' : 'decide', parents, outputs: {}, on_blocked: 'wait', on_gave_up: 'wait', template: TEMPLATE, ...extra };
}

/** intake, a root with a list; mid, its child; each, a fan-out over intake's list below mid; join, below each. */
const PLAN: Plan = {
  format: 1,
  steps: [
    step('intake', [], { outputs: { packages: { list: 'string', max: 100 }, scores: { list: 'number', max: 3 } } }),
    step('mid', ['intake']),
    step('each', ['mid'], { for_each: { step: 'intake', output: 'packages' } }),
    step('join', ['each']),
  ],
};

function fact(name: string, over: Partial<StepFact> = {}): StepFact {
  return { step: name, row: null, skippedBy: null, settled: null, items: new Map(), entered: { blocked: false, gaveUp: false }, result: null, ...over };
}

const DONE = (taskId: string, eventId: number): SettledFact => ({ how: 'done', taskId, eventId });

function facts(list: StepFact[], members = 2): Facts {
  return { steps: new Map(list.map((f) => [f.step, f])), due: [], members, cap: INSTANCE_CAP };
}

/** The facts once intake settled as given, and mid is done. */
function settledIntake(intake: Partial<StepFact>, members = 2): Facts {
  return facts([fact('intake', intake), fact('mid', { row: 'made', settled: DONE('k_mid', 9) }), fact('each', { row: 'waiting' }), fact('join', { row: 'waiting' })], members);
}

describe("a fan-out over a result", () => {
  it("makes one task an item, in the list's order, linked to its parents, once its source and parents are settled", () => {
    expect(decide(PLAN, settledIntake({ settled: DONE('k_i', 4), result: { packages: ['lodash', ' minimist ', 'qs'] } }))).toEqual([
      { step: 'each', outcome: 'fanned_out', items: ['lodash', 'minimist', 'qs'], parents: ['k_mid'], why: 'per item of intake.packages' },
    ]);
    const unsettledSource = facts([fact('intake'), fact('mid', { row: 'made', settled: DONE('k_mid', 9) }), fact('each', { row: 'waiting' }), fact('join', { row: 'waiting' })]);
    expect(decide(PLAN, unsettledSource)).toEqual([]);
  });

  it('writes numbers and booleans as JSON writes them', () => {
    const p: Plan = { ...PLAN, steps: PLAN.steps.map((s) => (s.step === 'each' ? { ...s, for_each: { step: 'intake', output: 'scores' } } : s)) };
    expect(decide(p, settledIntake({ settled: DONE('k_i', 4), result: { scores: [7, 9.5] } }))[0]).toMatchObject({ items: ['7', '9.5'] });
  });

  it('skips on an empty list, a skipped or archived source, and a list of the wrong type', () => {
    expect(decide(PLAN, settledIntake({ settled: DONE('k_i', 4), result: { packages: [] } }))).toEqual([
      { step: 'each', outcome: 'skipped', by: 'source', why: 'intake.packages is empty' },
    ]);
    expect(decide(PLAN, settledIntake({ settled: { how: 'skipped', taskId: null, eventId: 4 } }))).toEqual([
      { step: 'each', outcome: 'skipped', by: 'source', why: 'intake was skipped' },
    ]);
    expect(decide(PLAN, settledIntake({ settled: { how: 'archived', taskId: null, eventId: 4 } }))).toEqual([
      { step: 'each', outcome: 'skipped', by: 'source', why: 'intake was archived' },
    ]);
    expect(decide(PLAN, settledIntake({ settled: DONE('k_i', 4), result: { packages: 'lodash' } }))).toEqual([
      { step: 'each', outcome: 'skipped', by: 'source', why: 'intake.packages is missing' },
    ]);
  });

  it("fans out from a stand-in's accepted list, and from a source done and archived later", () => {
    expect(decide(PLAN, settledIntake({ settled: { how: 'stood_in', taskId: 'k_s', eventId: 6 }, result: { packages: ['qs'] } }))[0]).toMatchObject({
      outcome: 'fanned_out',
      items: ['qs'],
    });
    // Done, then archived: its row says done, as the archive came after its accepted completion.
    expect(decide(PLAN, settledIntake({ settled: DONE('k_i', 4), result: { packages: ['qs'] } }))[0]).toMatchObject({ outcome: 'fanned_out' });
  });

  it('makes none of its items past the cap, never a part', () => {
    expect(decide(PLAN, settledIntake({ settled: DONE('k_i', 4), result: { packages: Array.from({ length: 60 }, (_, i) => `p${i}`) } }, 450))).toEqual([
      { step: 'each', outcome: 'skipped', by: 'cap', why: 'the instance has 500 tasks' },
    ]);
    expect(decide(PLAN, settledIntake({ settled: DONE('k_i', 4), result: { packages: Array.from({ length: 50 }, (_, i) => `p${i}`) } }, 450))[0]?.outcome).toBe('fanned_out');
  });
});

describe('the join', () => {
  const items = (rows: Array<[string, SettledFact]>) => new Map(rows);

  it("decides the join's child only once the fan-out's own row is there, linked to each item's winner, none archived undone", () => {
    const partial = facts([
      fact('intake', { settled: DONE('k_i', 4) }),
      fact('mid', { row: 'made', settled: DONE('k_mid', 9) }),
      fact('each', { row: 'made', items: items([['each:1', DONE('k_1', 11)], ['each:2', { how: 'archived', taskId: null, eventId: 12 }]]) }),
      fact('join', { row: 'waiting' }),
    ]);
    expect(decide(PLAN, partial)).toEqual([]);
    const whole = facts([
      fact('intake', { settled: DONE('k_i', 4) }),
      fact('mid', { row: 'made', settled: DONE('k_mid', 9) }),
      fact('each', {
        row: 'made',
        settled: { how: 'done', taskId: null, eventId: 13 },
        items: items([
          ['each:1', DONE('k_1', 11)],
          ['each:2', { how: 'archived', taskId: null, eventId: 12 }],
          ['each:3', { how: 'stood_in', taskId: 'k_h', eventId: 13 }],
        ]),
      }),
      fact('join', { row: 'waiting' }),
    ]);
    expect(decide(PLAN, whole)).toEqual([{ step: 'join', outcome: 'made', parents: ['k_1', 'k_h'], why: 'its parents are settled' }]);
  });

  it('skips by archive the child of a fan-out whose items were all archived undone', () => {
    const archived = facts([
      fact('intake', { settled: DONE('k_i', 4) }),
      fact('mid', { row: 'made', settled: DONE('k_mid', 9) }),
      fact('each', { row: 'made', settled: { how: 'archived', taskId: null, eventId: 12 }, items: items([['each:1', { how: 'archived', taskId: null, eventId: 12 }]]) }),
      fact('join', { row: 'waiting' }),
    ]);
    expect(decide(PLAN, archived)).toEqual([{ step: 'join', outcome: 'skipped', by: 'archive', why: 'its parents were archived' }]);
  });
});
