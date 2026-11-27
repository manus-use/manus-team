import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { block, closeRun, endRun, requestReview, stop, type KanbanLimits } from '../src/db/kanban.js';
import { triggersOf } from '../src/db/kanban-read.js';
import { decide, INSTANCE_CAP, type Facts, type Plan, type PlanStep, type RouteFact, type StepFact, type Template } from '../src/kanban/routing.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, claimed, newTask } from './helpers/kanban.js';

/**
 * The trigger table (workflow routing spec §5.1), each row from the code: a run's
 * own block and the run endings that block route by `on_blocked`, the breaker's
 * give-up and the transient limit's block by `on_gave_up`; a person's block, a
 * stop, a review's block and a dependency route nothing. And decide's routes
 * (§5.3, §10): by the trigger's key, once a route is due, at most 3 a routed
 * task, at the cap `over_cap`, none from a member already settled.
 */

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

const LIMITS: KanbanLimits = { failureLimit: 1, transientLimit: 2, transientCooldownS: 300 };

/** A task's one trigger, after `act` on a fresh run of it; undefined for none. */
function trigger(act: (taskId: string, runId: string) => void, task = newTask(h.db)) {
  const run = claimed(h.db, task.taskId);
  act(task.taskId, run.runId);
  closeRun(h.db, run.runId, NOW);
  return triggersOf(h.db, task.taskId).map(({ eventId: _e, ...t }) => t);
}

describe('the trigger table', () => {
  it("reads a run's own block, of any kind but dependency, as blocked", () => {
    for (const kind of ['needs_input', 'capability', 'transient'] as const) {
      expect(trigger((t, r) => block(h.db, t, { kind: 'run', runId: r }, { kind, reason: 'stuck' }, NOW))).toEqual([
        { kind: 'blocked', throttled: false, blockKind: kind, reason: 'stuck' },
      ]);
    }
    const parent = newTask(h.db);
    expect(trigger((t, r) => block(h.db, t, { kind: 'run', runId: r }, { kind: 'dependency', reason: 'wait', parents: [parent.taskId] }, NOW))).toEqual([]);
  });

  it('reads the run endings that block as blocked, and the two terminal failure endings as gave_up', () => {
    expect(trigger((_t, r) => endRun(h.db, r, { outcome: 'terminal_provider', error: 'bad key' }, LIMITS, NOW))).toEqual([
      { kind: 'blocked', throttled: false, blockKind: 'capability', reason: 'bad key' },
    ]);
    const cautious = newTask(h.db, { retryOnCrash: 'if-no-side-effects', failureLimit: 5 });
    expect(trigger((_t, r) => endRun(h.db, r, { outcome: 'crashed', hadSideEffects: true }, LIMITS, NOW), cautious)).toEqual([
      { kind: 'blocked', throttled: false, blockKind: 'needs_input', reason: 'the run ended crashed after changing things; look before it is retried' },
    ]);
    expect(trigger((_t, r) => endRun(h.db, r, { outcome: 'failed', block: 'the directory could not be made' }, LIMITS, NOW))).toEqual([
      { kind: 'blocked', throttled: false, blockKind: 'needs_input', reason: 'the directory could not be made' },
    ]);
    expect(trigger((_t, r) => endRun(h.db, r, { outcome: 'crashed', error: 'boom' }, LIMITS, NOW))).toEqual([
      { kind: 'gave_up', throttled: false, blockKind: 'gave_up', reason: 'failed 1 times; last crashed: boom' },
    ]);
    const throttled = newTask(h.db);
    const first = claimed(h.db, throttled.taskId);
    endRun(h.db, first.runId, { outcome: 'rate_limited' }, LIMITS, NOW);
    closeRun(h.db, first.runId, NOW);
    h.db.prepare('UPDATE kanban_tasks SET cooldown_until = NULL WHERE task_id = ?').run(throttled.taskId);
    expect(trigger((_t, r) => endRun(h.db, r, { outcome: 'rate_limited' }, LIMITS, NOW), throttled)).toEqual([
      { kind: 'gave_up', throttled: true, blockKind: 'transient', reason: 'throttled 2 times in a row' },
    ]);
  });

  it("reads nothing from a person's block, a stop, or a review run's block", () => {
    const person = newTask(h.db);
    block(h.db, person.taskId, { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason: 'wait' }, NOW);
    expect(triggersOf(h.db, person.taskId)).toEqual([]);
    expect(trigger((t) => stop(h.db, t, ALICE, NOW))).toEqual([]);
    const reviewed = newTask(h.db, { reviewer: { kind: 'role', name: 'reviewer' } });
    const work = claimed(h.db, reviewed.taskId);
    requestReview(h.db, reviewed.taskId, { kind: 'run', runId: work.runId }, { summary: 'x' }, NOW);
    closeRun(h.db, work.runId, NOW);
    const review = claimed(h.db, reviewed.taskId);
    block(h.db, reviewed.taskId, { kind: 'run', runId: review.runId }, { kind: 'needs_input', reason: 'unsure' }, NOW);
    expect(triggersOf(h.db, reviewed.taskId)).toEqual([]);
  });
});

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

function step(name: string, extra: Partial<PlanStep> = {}): PlanStep {
  return { step: name, made: 'start', parents: [], outputs: {}, on_blocked: 'wait', on_gave_up: 'wait', template: TEMPLATE, ...extra };
}

const PLAN: Plan = {
  format: 1,
  steps: [
    step('va', { on_gave_up: { route: 'escalate' }, on_blocked: { route: 'help' } }),
    step('each', { for_each: { param: 'items' }, on_gave_up: { route: 'escalate' } }),
    step('quiet'),
    step('escalate', { made: 'route', handler: true, stands_in_for: 'va' }),
    step('help', { made: 'route', handler: true }),
  ],
};

function fact(name: string, over: Partial<StepFact> = {}): StepFact {
  return { step: name, row: null, skippedBy: null, settled: null, items: new Map(), entered: { blocked: false, gaveUp: false }, result: null, ...over };
}

function due(over: Partial<RouteFact> = {}): RouteFact {
  return { taskId: 'k_va', step: 'va', ref: 'va', item: null, eventId: 7, kind: 'gave_up', throttled: false, blockKind: 'gave_up', reason: 'failed', routes: 0, ...over };
}

function facts(routes: RouteFact[], extra: StepFact[] = [], members = 3): Facts {
  const list = [fact('va'), fact('each'), fact('quiet'), ...extra];
  return { steps: new Map(list.map((f) => [f.step, f])), due: routes, members, cap: INSTANCE_CAP };
}

describe("decide's routes", () => {
  it("routes a due trigger by its key, to a handler standing in or helping, and waits on wait", () => {
    expect(decide(PLAN, facts([due()]))).toEqual([{ step: 'va', outcome: 'route', handler: 'escalate', from: due(), standsIn: true }]);
    expect(decide(PLAN, facts([due({ kind: 'blocked', blockKind: 'capability' })]))).toEqual([
      { step: 'va', outcome: 'route', handler: 'help', from: due({ kind: 'blocked', blockKind: 'capability' }), standsIn: false },
    ]);
    expect(decide(PLAN, facts([due({ kind: 'gave_up', throttled: true, blockKind: 'transient' })]))[0]).toMatchObject({ handler: 'escalate' });
    expect(decide(PLAN, facts([due({ step: 'quiet', taskId: 'k_q', ref: 'quiet' })]))).toEqual([]);
  });

  it("routes a fan-out's item for its own transition, a handler for each, not standing in for another step", () => {
    const item = due({ step: 'each', taskId: 'k_e2', ref: 'each:2', item: 'qs' });
    expect(decide(PLAN, facts([item]))).toEqual([{ step: 'each', outcome: 'route', handler: 'escalate', from: item, standsIn: false }]);
    const settled = fact('each', { items: new Map([['each:2', { how: 'done', taskId: 'k_e2', eventId: 9 }]]) });
    expect(decide(PLAN, { ...facts([item]), steps: new Map([...facts([item]).steps, ['each', settled]]) })).toEqual([]);
  });

  it('falls back to wait past 3 routes a task, over_limit, and at the cap, over_cap, and routes nothing from a member settled', () => {
    expect(decide(PLAN, facts([due({ routes: 3 })]))).toEqual([{ step: 'va', outcome: 'over_limit', handler: 'escalate', from: due({ routes: 3 }) }]);
    expect(decide(PLAN, facts([due({ routes: 2 })]))[0]?.outcome).toBe('route');
    expect(decide(PLAN, facts([due()], [], 500))).toEqual([{ step: 'va', outcome: 'over_cap', handler: 'escalate', from: due() }]);
    const won = fact('va', { settled: { how: 'stood_in', taskId: 'k_s', eventId: 8 } });
    expect(decide(PLAN, { ...facts([due()]), steps: new Map([...facts([due()]).steps, ['va', won]]) })).toEqual([]);
  });
});
