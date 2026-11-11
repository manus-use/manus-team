import { afterEach, describe, expect, it } from 'vitest';
import { eventsOf, openAgentRunCount, runsOf } from '../src/db/kanban-read.js';
import { fairOrder } from '../src/kanban/fair.js';
import { KanbanService } from '../src/kanban/service.js';
import { completes, dispatchHarness, holds, reportComplete, role, until, type DispatchHarness } from './helpers/dispatch.js';
import { ALICE } from './helpers/kanban.js';

/**
 * The dispatcher and boards (spec §16): one dispatcher for every board, taking
 * them in turn, and holding each to its own max_running inside the gateway's.
 */

const open: DispatchHarness[] = [];

function harness(...args: Parameters<typeof dispatchHarness>): DispatchHarness {
  const h = dispatchHarness(...args);
  open.push(h);
  return h;
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

function boards(h: DispatchHarness, ...names: string[]): void {
  for (const name of names) {
    const r = h.service.createBoard(name, ALICE);
    if (!r.ok) throw new Error(r.message);
  }
}

/** The titles of the tasks a driver's runs were given, in the order they started. */
function started(h: DispatchHarness, roleName: string): Array<string | undefined> {
  return h.driver(roleName).runtimes.map((r) => /k_\w+: (\w+)/.exec(r.prompts[0]?.text ?? '')?.[1]);
}

describe('fairOrder', () => {
  const t = (board: string, title: string) => ({ board, title });
  const tasks = [t('a', 'a1'), t('a', 'a2'), t('a', 'a3'), t('c', 'c1'), t('b', 'b1'), t('b', 'b2')];

  it('takes the boards in turn, by name, keeping each board’s own order', () => {
    expect(fairOrder(tasks).map((x) => x.title)).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'a3']);
  });

  it('starts with the board after the one given, wrapping round', () => {
    expect(fairOrder(tasks, 'a').map((x) => x.title)).toEqual(['b1', 'c1', 'a1', 'b2', 'a2', 'a3']);
    expect(fairOrder(tasks, 'c').map((x) => x.title)).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'a3']);
    expect(fairOrder(tasks, 'bz').map((x) => x.title)).toEqual(['c1', 'a1', 'b1', 'a2', 'b2', 'a3']);
    expect(fairOrder([], 'a')).toEqual([]);
  });
});

describe('Dispatcher: boards in turn', () => {
  it("does not let one board's burst starve another", async () => {
    const h = harness({ settings: { maxRunning: 1 } });
    boards(h, 'alpha', 'beta');
    for (const title of ['a1', 'a2', 'a3']) {
      h.create({ title, workspace: 'web', board: 'alpha' });
      h.clock.advance(1);
    }
    h.create({ title: 'b1', workspace: 'web', board: 'beta' });
    const implementer = h.driver('implementer');
    for (let i = 0; i < 4; i += 1) completes(h, implementer);

    h.dispatcher.pass();
    await h.dispatcher.idle();

    // Oldest first would have run b1 last.
    expect(started(h, 'implementer')).toEqual(['a1', 'b1', 'a2', 'a3']);
  });

  it("keeps priority within a board", async () => {
    const h = harness({ settings: { maxRunning: 1 } });
    boards(h, 'alpha');
    h.create({ title: 'old', workspace: 'web', board: 'alpha' });
    h.clock.advance(1);
    h.create({ title: 'urgent', workspace: 'web', board: 'alpha', priority: 5 });
    const implementer = h.driver('implementer');
    for (let i = 0; i < 2; i += 1) completes(h, implementer);

    h.dispatcher.pass();
    await h.dispatcher.idle();
    expect(started(h, 'implementer')).toEqual(['urgent', 'old']);
  });

  it("gives a board whose head task cannot be claimed its turn with its next task", async () => {
    const roles = [role('implementer'), role('reviewer'), role('holder', { workspace: 'web' })];
    const h = harness({ roles, settings: { maxRunning: 2 } });
    boards(h, 'alpha', 'beta', 'gamma');
    h.create({ title: 'g', board: 'gamma', assignee: 'holder' });
    const held = holds(h.driver('holder'));
    h.dispatcher.pass();
    await until(() => held.started, "gamma's run");

    // alpha's head task waits on gamma's workspace; its next one can run.
    h.create({ title: 'aweb', workspace: 'web', board: 'alpha', priority: 9 });
    h.create({ title: 'aapi', workspace: 'api', board: 'alpha' });
    for (const title of ['b1', 'b2', 'b3', 'b4']) {
      h.create({ title, workspace: 'api', board: 'beta' });
      h.clock.advance(1);
    }
    const implementer = h.driver('implementer');
    for (let i = 0; i < 6; i += 1) completes(h, implementer);

    h.dispatcher.pass();
    // gamma's run is held, so the pass is never idle: wait for the five instead.
    await until(() => started(h, 'implementer').length === 5 && openAgentRunCount(h.t.db) === 1, 'five runs');
    expect(started(h, 'implementer')).toEqual(['aapi', 'b1', 'b2', 'b3', 'b4']);

    held.end('completed', () => reportComplete(h, h.driver('holder')));
    await h.dispatcher.idle();
    expect(started(h, 'implementer')).toEqual(['aapi', 'b1', 'b2', 'b3', 'b4', 'aweb']);
  });
});

describe("Dispatcher: a board's max_running", () => {
  it('opens no more agent runs on a board than its own limit, while other boards run', async () => {
    const h = harness({ settings: { maxRunning: 4 } });
    boards(h, 'alpha', 'beta');
    expect(h.service.setBoard('alpha', { maxRunning: 1 }, ALICE).ok).toBe(true);
    const first = h.create({ title: 'first', workspace: 'web', board: 'alpha' });
    h.clock.advance(1);
    const second = h.create({ title: 'second', workspace: 'api', board: 'alpha' });
    const other = h.create({ title: 'other', board: 'beta', assignee: 'docs-writer' });
    const held = holds(h.driver('implementer'));
    completes(h, h.driver('implementer'));
    const docs = holds(h.driver('docs-writer'));

    h.dispatcher.pass();
    await until(() => held.started && docs.started, 'a run on each board');
    h.dispatcher.pass();
    expect([first, second, other].map((t) => runsOf(h.t.db, t.taskId).length)).toEqual([1, 0, 1]);

    // Once alpha's run has closed, its next task is claimed.
    held.end('completed', () => reportComplete(h, h.driver('implementer')));
    docs.end('completed', () => reportComplete(h, h.driver('docs-writer')));
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, second.taskId).map((r) => r.outcome)).toEqual(['completed']);
  });

  it("is held to the gateway's max_running whatever its own says", async () => {
    const h = harness({ settings: { maxRunning: 1 } });
    boards(h, 'alpha');
    // A service not told the gateway's limit lets this through: the dispatcher still holds to it.
    const unbounded = new KanbanService({ db: h.t.db, roles: new Map(), workspaces: new Set() });
    expect(unbounded.setBoard('alpha', { maxRunning: 3 }, ALICE).ok).toBe(true);
    const one = h.create({ title: 'one', workspace: 'web', board: 'alpha' });
    const two = h.create({ title: 'two', workspace: 'api', board: 'alpha' });
    const held = holds(h.driver('implementer'));
    completes(h, h.driver('implementer'));

    h.dispatcher.pass();
    await until(() => held.started, 'the first run');
    h.dispatcher.pass();
    expect([one, two].map((t) => runsOf(h.t.db, t.taskId).length)).toEqual([1, 0]);
    held.end('completed', () => reportComplete(h, h.driver('implementer')));
    await h.dispatcher.idle();
  });
});

describe('Dispatcher: a task waiting on a limit', () => {
  const MINUTE = 60_000;

  it('is never reported stranded, whether the limit is the gateway’s or its board’s', async () => {
    const h = harness({ settings: { maxRunning: 2 } });
    boards(h, 'alpha', 'beta');
    expect(h.service.setBoard('alpha', { maxRunning: 1 }, ALICE).ok).toBe(true);
    const a1 = h.create({ title: 'a1', workspace: 'web', board: 'alpha' });
    h.clock.advance(1);
    const onBoard = h.create({ title: 'a2', workspace: 'api', board: 'alpha' });
    const b1 = h.create({ title: 'b1', workspace: 'docs', board: 'beta' });
    h.clock.advance(1);
    const onGateway = h.create({ title: 'b2', workspace: 'default', board: 'beta' });
    const first = holds(h.driver('implementer'));
    const second = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => first.started && second.started, 'two runs');

    h.clock.advance(31 * MINUTE);
    h.dispatcher.sweep();
    for (const task of [onBoard, onGateway]) {
      expect(eventsOf(h.t.db, task.taskId).map((e) => e.kind)).toEqual(['created']);
    }

    for (let i = 0; i < 2; i += 1) completes(h, h.driver('implementer'));
    const runOf = (taskId: string) => runsOf(h.t.db, taskId)[0]?.runId ?? 'none';
    first.end('completed', () => reportComplete(h, runOf(a1.taskId)));
    second.end('completed', () => reportComplete(h, runOf(b1.taskId)));
    await h.dispatcher.idle();
    expect([onBoard, onGateway].map((t) => runsOf(h.t.db, t.taskId).map((r) => r.outcome))).toEqual([
      ['completed'],
      ['completed'],
    ]);
  });
});
