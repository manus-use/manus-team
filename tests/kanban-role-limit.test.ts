import { afterEach, describe, expect, it } from 'vitest';
import { eventsOf, openAgentRunCount, openAgentRunCountAs, runsOf } from '../src/db/kanban-read.js';
import { completes, dispatchHarness, holds, reportComplete, role, until, type DispatchHarness } from './helpers/dispatch.js';
import { ALICE } from './helpers/kanban.js';
import { renderShow } from '../src/kanban/chat-render.js';
import { showText } from '../src/cli/plain.js';
import { KanbanService } from '../src/kanban/service.js';
import type { Role } from '../src/roles.js';

/**
 * A role's max_running (spec §6.3): at most that many open agent runs as the
 * role at once, the role's own `max_running` or else the gateway's
 * `kanban.max_running_per_role`. A task whose role is at its limit is skipped,
 * and its board's queue goes on to its next task.
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

/** The titles of the tasks a driver's runs were given, in the order they started. */
function started(h: DispatchHarness, roleName: string): Array<string | undefined> {
  return h.driver(roleName).runtimes.map((r) => /k_\w+: (\w+)/.exec(r.prompts[0]?.text ?? '')?.[1]);
}

const runCount = (h: DispatchHarness, taskId: string): number => runsOf(h.t.db, taskId).length;
const runOf = (h: DispatchHarness, taskId: string): string => runsOf(h.t.db, taskId)[0]?.runId ?? 'none';

describe("Dispatcher: a role's max_running", () => {
  it("opens no more of one role's runs than its limit, however many workspaces are free", async () => {
    const h = harness({ roles: [role('implementer', { maxRunning: 2 })] });
    const tasks = ['one', 'two', 'three', 'four'].map((title, i) => {
      h.clock.advance(1);
      return h.create({ title, workspace: ['web', 'api', 'docs', 'default'][i] ?? 'default' });
    });
    const held = tasks.map(() => holds(h.driver('implementer')));

    h.dispatcher.pass();
    await until(() => held[0]?.started === true && held[1]?.started === true, 'two runs');
    h.dispatcher.pass();
    expect(tasks.map((t) => runCount(h, t.taskId))).toEqual([1, 1, 0, 0]);
    expect(openAgentRunCountAs(h.t.db, 'implementer')).toBe(2);

    // A run closing gives its slot to the role's next task, oldest first.
    held[0]?.end('completed', () => reportComplete(h, runOf(h, tasks[0]?.taskId ?? '')));
    await until(() => held[2]?.started === true, 'the third run');
    expect(tasks.map((t) => runCount(h, t.taskId))).toEqual([1, 1, 1, 0]);

    held[1]?.end('completed', () => reportComplete(h, runOf(h, tasks[1]?.taskId ?? '')));
    held[2]?.end('completed', () => reportComplete(h, runOf(h, tasks[2]?.taskId ?? '')));
    await until(() => held[3]?.started === true, 'the fourth run');
    held[3]?.end('completed', () => reportComplete(h, runOf(h, tasks[3]?.taskId ?? '')));
    await h.dispatcher.idle();
    expect(tasks.map((t) => runsOf(h.t.db, t.taskId).map((r) => r.outcome))).toEqual([
      ['completed'],
      ['completed'],
      ['completed'],
      ['completed'],
    ]);
    expect(started(h, 'implementer')).toEqual(['one', 'two', 'three', 'four']);
  });

  it("runs another role's tasks, behind the capped role's in the queue, while it waits", async () => {
    const roles = [role('implementer', { maxRunning: 1 }), role('reviewer'), role('docs-writer', { workspace: 'docs' })];
    const h = harness({ roles });
    const first = h.create({ title: 'first', workspace: 'web' });
    h.clock.advance(1);
    const second = h.create({ title: 'second', workspace: 'api' });
    h.clock.advance(1);
    const docs = h.create({ title: 'docs', assignee: 'docs-writer' });
    h.clock.advance(1);
    const review = h.create({ title: 'other', workspace: 'default', assignee: 'reviewer' });
    const impl = holds(h.driver('implementer'));
    const writer = holds(h.driver('docs-writer'));
    const other = holds(h.driver('reviewer'));

    h.dispatcher.pass();
    await until(() => impl.started && writer.started && other.started, 'three runs');
    expect([first, second, docs, review].map((t) => runCount(h, t.taskId))).toEqual([1, 0, 1, 1]);

    completes(h, h.driver('implementer'));
    impl.end('completed', () => reportComplete(h, runOf(h, first.taskId)));
    writer.end('completed', () => reportComplete(h, runOf(h, docs.taskId)));
    other.end('completed', () => reportComplete(h, runOf(h, review.taskId)));
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, second.taskId).map((r) => r.outcome)).toEqual(['completed']);
  });

  it('holds together with the boards taking turns: a capped task does not end its board’s turn', async () => {
    const roles = [role('implementer', { maxRunning: 1 }), role('reviewer')];
    const h = harness({ roles });
    for (const name of ['alpha', 'beta']) expect(h.service.createBoard(name, ALICE).ok).toBe(true);
    const a1 = h.create({ title: 'a1', workspace: 'web', board: 'alpha' });
    h.clock.advance(1);
    const a2 = h.create({ title: 'a2', workspace: 'api', board: 'alpha' });
    h.clock.advance(1);
    const a3 = h.create({ title: 'a3', workspace: 'default', board: 'alpha', assignee: 'reviewer' });
    h.clock.advance(1);
    const b1 = h.create({ title: 'b1', workspace: 'docs', board: 'beta' });
    const first = holds(h.driver('implementer'));
    const second = holds(h.driver('implementer'));
    const other = holds(h.driver('reviewer'));

    h.dispatcher.pass();
    // alpha's turn: a1. beta's: b1 waits on the role, and beta has nothing else.
    // alpha's again: a2 waits on the role, and a3, behind it, is claimed.
    await until(() => first.started && other.started, 'two runs');
    expect([a1, a2, a3, b1].map((t) => runCount(h, t.taskId))).toEqual([1, 0, 1, 0]);

    // alpha had the last claim, so beta's b1 takes the role's freed slot, though a2 is older.
    first.end('completed', () => reportComplete(h, runOf(h, a1.taskId)));
    await until(() => second.started, "the role's next run");
    expect([a2, b1].map((t) => runCount(h, t.taskId))).toEqual([0, 1]);

    completes(h, h.driver('implementer'));
    second.end('completed', () => reportComplete(h, runOf(h, b1.taskId)));
    other.end('completed', () => reportComplete(h, runOf(h, a3.taskId)));
    await h.dispatcher.idle();
    expect(started(h, 'implementer')).toEqual(['a1', 'b1', 'a2']);
  });

  it('counts a review run against the reviewer role, not the role that did the work', async () => {
    const roles = [role('implementer', { maxRunning: 1 }), role('reviewer', { maxRunning: 1 })];
    const h = harness({ roles });
    const task = h.create({ title: 'reviewed', workspace: 'web', reviewer: 'reviewer' });
    const implementer = h.driver('implementer');
    implementer.scripts.push(async (ctl) => {
      const run = h.runOf(implementer);
      expect((await h.service.requestReview(task.taskId, { kind: 'run', runId: run.runId }, { summary: 'look' })).ok).toBe(true);
      ctl.end('completed');
    });
    const review = holds(h.driver('reviewer'));
    h.dispatcher.pass();
    await until(() => review.started, 'the review run');
    expect(openAgentRunCountAs(h.t.db, 'reviewer')).toBe(1);
    expect(openAgentRunCountAs(h.t.db, 'implementer')).toBe(0);

    // The reviewer is at its limit: its own work waits. The implementer is not.
    const reviewersWork = h.create({ title: 'work', workspace: 'api', assignee: 'reviewer' });
    const more = h.create({ title: 'more', workspace: 'docs' });
    completes(h, implementer);
    h.dispatcher.pass();
    await until(() => runsOf(h.t.db, more.taskId)[0]?.outcome === 'completed', "the implementer's next run");
    expect(runCount(h, reviewersWork.taskId)).toBe(0);

    completes(h, h.driver('reviewer'));
    const reviewRun = runsOf(h.t.db, task.taskId).find((r) => r.kind === 'review')?.runId ?? 'none';
    review.end('completed', () => reportComplete(h, reviewRun, 'approved'));
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, reviewersWork.taskId).map((r) => r.outcome)).toEqual(['completed']);
  });

  it("takes kanban.max_running_per_role for a role with none of its own, and a role's own over it", async () => {
    const roles = [role('implementer'), role('writer', { maxRunning: 1 })];
    const h = harness({ roles, settings: { maxRunningPerRole: 2 } });
    const i1 = h.create({ title: 'i1', workspace: 'web' });
    const i2 = h.create({ title: 'i2', workspace: 'api' });
    const w1 = h.create({ title: 'w1', workspace: 'docs', assignee: 'writer' });
    const w2 = h.create({ title: 'w2', workspace: 'default', assignee: 'writer' });
    const held = [holds(h.driver('implementer')), holds(h.driver('implementer')), holds(h.driver('writer'))];

    h.dispatcher.pass();
    await until(() => held.every((x) => x.started), 'three runs');
    h.dispatcher.pass();
    // The implementer has the default's 2; the writer its own 1, though the default is more.
    expect([i1, i2, w1, w2].map((t) => runCount(h, t.taskId))).toEqual([1, 1, 1, 0]);

    completes(h, h.driver('writer'));
    held[0]?.end('completed', () => reportComplete(h, runOf(h, i1.taskId)));
    held[1]?.end('completed', () => reportComplete(h, runOf(h, i2.taskId)));
    held[2]?.end('completed', () => reportComplete(h, runOf(h, w1.taskId)));
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, w2.taskId).map((r) => r.outcome)).toEqual(['completed']);
  });

  it('has no role limit when neither the role nor the gateway sets one', async () => {
    const h = harness({ roles: [role('implementer')] });
    const tasks = ['web', 'api', 'docs'].map((workspace) => h.create({ title: workspace, workspace }));
    const held = tasks.map(() => holds(h.driver('implementer')));
    h.dispatcher.pass();
    await until(() => held.every((x) => x.started), 'three runs');
    expect(openAgentRunCount(h.t.db)).toBe(3);
    for (const [i, x] of held.entries()) x.end('completed', () => reportComplete(h, runOf(h, tasks[i]?.taskId ?? '')));
    await h.dispatcher.idle();
  });

  it("is held inside the gateway's max_running", async () => {
    const h = harness({ roles: [role('implementer', { maxRunning: 3 })], settings: { maxRunning: 1 } });
    const one = h.create({ title: 'one', workspace: 'web' });
    const two = h.create({ title: 'two', workspace: 'api' });
    const held = holds(h.driver('implementer'));
    completes(h, h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started, 'the first run');
    h.dispatcher.pass();
    expect([one, two].map((t) => runCount(h, t.taskId))).toEqual([1, 0]);
    held.end('completed', () => reportComplete(h, runOf(h, one.taskId)));
    await h.dispatcher.idle();
  });

  it('never reports a task waiting on its role’s limit as stranded', async () => {
    const h = harness({ roles: [role('implementer', { maxRunning: 1 })] });
    const first = h.create({ title: 'first', workspace: 'web' });
    h.clock.advance(1);
    const waiting = h.create({ title: 'waiting', workspace: 'api' });
    const held = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started, 'the first run');

    h.clock.advance(31 * 60_000);
    h.dispatcher.sweep();
    expect(eventsOf(h.t.db, waiting.taskId).map((e) => e.kind)).toEqual(['created']);
    expect(h.notes.filter((n) => n.includes('stranded'))).toEqual([]);

    completes(h, h.driver('implementer'));
    held.end('completed', () => reportComplete(h, runOf(h, first.taskId)));
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, waiting.taskId).map((r) => r.outcome)).toEqual(['completed']);
  });

  it("counts a run that has reported but is still finishing, as the gateway's limit does", async () => {
    const h = harness({ roles: [role('implementer', { maxRunning: 1 })] });
    const first = h.create({ title: 'first', workspace: 'web' });
    const second = h.create({ title: 'second', workspace: 'api' });
    // The run reports, then its turn is held open: decided, not yet closed.
    const held = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started, 'the first run');
    await reportComplete(h, runOf(h, first.taskId));
    h.dispatcher.pass();
    expect(runCount(h, second.taskId)).toBe(0);

    completes(h, h.driver('implementer'));
    held.end('completed');
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, second.taskId).map((r) => r.outcome)).toEqual(['completed']);
  });
});

describe("/kanban task show: a task waiting on its role's limit", () => {
  it("says so while the role is at its limit, and not once it is not", async () => {
    const h = harness({ roles: [role('implementer', { maxRunning: 1 })] });
    const first = h.create({ title: 'first', workspace: 'web' });
    h.clock.advance(1);
    const waiting = h.create({ title: 'waiting', workspace: 'api' });
    const held = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started, 'the first run');

    const shown = h.service.show(waiting.taskId);
    expect(shown.ok && shown.view.waiting).toEqual([{ kind: 'role', role: 'implementer', maxRunning: 1 }]);
    if (!shown.ok) throw new Error(shown.message);
    const line = 'role implementer is at its max_running, 1 agent run at once; it is claimed when one of them ends';
    expect(showText(shown.view, [])).toContain(`waiting: ${line}`);
    expect(renderShow(shown.view, [])).toContain(`waiting: ${line.replace('max_running', 'max\\_running')}`);
    // The running task is not waiting on anything.
    const running = h.service.show(first.taskId);
    expect(running.ok && running.view.waiting).toBeUndefined();
    if (running.ok) expect(showText(running.view, []).join('\n')).not.toMatch(/waiting:/);

    completes(h, h.driver('implementer'));
    held.end('completed', () => reportComplete(h, runOf(h, first.taskId)));
    await h.dispatcher.idle();
    const after = h.service.show(waiting.taskId);
    expect(after.ok && after.view.waiting).toBeUndefined();
  });
});

describe("the service's show: which tasks are waiting on their role's limit", () => {
  /** Another service on the harness's board: as the gateway builds it, or as config later says. */
  function serviceOn(h: DispatchHarness, roles: readonly Role[], extra: { maxRunningPerRole?: number; workspaces?: string[] } = {}) {
    return new KanbanService({
      db: h.t.db,
      roles: new Map(roles.map((r) => [r.name, r])),
      workspaces: new Set(extra.workspaces ?? ['default', 'web', 'api', 'docs']),
      clock: h.clock,
      ...(extra.maxRunningPerRole === undefined ? {} : { maxRunningPerRole: extra.maxRunningPerRole }),
    });
  }

  it('takes kanban.max_running_per_role for a role with no limit of its own', async () => {
    const roles = [role('implementer')];
    const h = harness({ roles, settings: { maxRunningPerRole: 1 } });
    const first = h.create({ title: 'first', workspace: 'web' });
    h.clock.advance(1);
    const waiting = h.create({ title: 'waiting', workspace: 'api' });
    const held = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started, 'the first run');

    const withDefault = serviceOn(h, roles, { maxRunningPerRole: 1 }).show(waiting.taskId);
    expect(withDefault.ok && withDefault.view.waiting).toEqual([{ kind: 'role', role: 'implementer', maxRunning: 1 }]);
    // Without the default the role has no limit, so nothing is said.
    const without = serviceOn(h, roles).show(waiting.taskId);
    expect(without.ok && without.view.waiting).toBeUndefined();

    completes(h, h.driver('implementer'));
    held.end('completed', () => reportComplete(h, runOf(h, first.taskId)));
    await h.dispatcher.idle();
  });

  it('says nothing of a task the claim would refuse anyway: its workspace no longer configured, or its parents in two', async () => {
    const roles = [role('implementer', { maxRunning: 1 }), role('writer')];
    const h = harness({ roles });
    const holder = h.create({ title: 'holder', workspace: 'docs' });
    const held = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started, "the implementer's run");

    const gone = h.create({ title: 'gone', workspace: 'api' });
    const p1 = h.create({ title: 'p1', workspace: 'web', assignee: 'writer' });
    const p2 = h.create({ title: 'p2', workspace: 'api', assignee: 'writer' });
    const split = h.create({ title: 'split', parents: [p1.taskId, p2.taskId] });
    const single = h.create({ title: 'single', parents: [p1.taskId] });
    completes(h, h.driver('writer'));
    completes(h, h.driver('writer'));
    h.dispatcher.pass();
    await until(() => [p1, p2].every((p) => runsOf(h.t.db, p.taskId)[0]?.endedAt != null), "the writer's runs");

    const waiting = (s: KanbanService, taskId: string) => {
      const r = s.show(taskId);
      return r.ok ? r.view.waiting : 'refused';
    };
    const capped = [{ kind: 'role', role: 'implementer', maxRunning: 1 }];
    expect(waiting(h.service, gone.taskId)).toEqual(capped);
    expect(waiting(serviceOn(h, roles, { workspaces: ['default', 'web', 'docs'] }), gone.taskId)).toBeUndefined();
    expect(waiting(h.service, single.taskId)).toEqual(capped);
    expect(waiting(h.service, split.taskId)).toBeUndefined();

    completes(h, h.driver('implementer'));
    completes(h, h.driver('implementer'));
    held.end('completed', () => reportComplete(h, runOf(h, holder.taskId)));
    await h.dispatcher.idle();
    expect([gone, single, split].map((t) => runsOf(h.t.db, t.taskId).map((r) => r.outcome))).toEqual([['completed'], ['completed'], []]);
  });
});

describe('task show: every reason a pass skips a claimable task', () => {
  const shown = (h: DispatchHarness, taskId: string) => {
    const r = h.service.show(taskId);
    if (!r.ok) throw new Error(r.message);
    return r.view;
  };
  const lines = (h: DispatchHarness, taskId: string) => {
    const view = shown(h, taskId);
    return { plain: showText(view, []).filter((l) => l.startsWith('waiting:')), chat: renderShow(view, []).split('\n').filter((l) => l.startsWith('waiting:')) };
  };

  it("names the task whose agent run holds its workspace, and says nothing once it is free", async () => {
    const h = harness({ roles: [role('implementer')] });
    const first = h.create({ title: 'first', workspace: 'web' });
    h.clock.advance(1);
    const second = h.create({ title: 'second', workspace: 'web' });
    const held = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started, 'the first run');
    expect(runCount(h, second.taskId)).toBe(0);

    expect(shown(h, second.taskId).waiting).toEqual([{ kind: 'workspace', workspace: 'web', taskId: first.taskId, runId: runOf(h, first.taskId) }]);
    const said = `workspace web is busy with task ${first.taskId}'s agent run; it is claimed when that run ends`;
    expect(lines(h, second.taskId)).toEqual({ plain: [`waiting: ${said}`], chat: [`waiting: ${said.replace(first.taskId, `\`${first.taskId}\``)}`] });
    expect(shown(h, first.taskId).waiting).toBeUndefined();

    completes(h, h.driver('implementer'));
    held.end('completed', () => reportComplete(h, runOf(h, first.taskId)));
    await h.dispatcher.idle();
    expect(shown(h, second.taskId).waiting).toBeUndefined();
  });

  it("says when the gateway's kanban.max_running is reached", async () => {
    const h = harness({ roles: [role('implementer'), role('reviewer')], settings: { maxRunning: 1 } });
    const first = h.create({ title: 'first', workspace: 'web' });
    h.clock.advance(1);
    const second = h.create({ title: 'second', workspace: 'api', assignee: 'reviewer' });
    const held = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started, 'the first run');
    expect(runCount(h, second.taskId)).toBe(0);

    expect(shown(h, second.taskId).waiting).toEqual([{ kind: 'gateway', maxRunning: 1 }]);
    const said = 'the gateway is at its kanban.max_running, 1 agent run at once; it is claimed when one of them ends';
    expect(lines(h, second.taskId)).toEqual({ plain: [`waiting: ${said}`], chat: [`waiting: ${said.replace('max_running', 'max\\_running')}`] });

    completes(h, h.driver('reviewer'));
    held.end('completed', () => reportComplete(h, runOf(h, first.taskId)));
    await h.dispatcher.idle();
    expect(shown(h, second.taskId).waiting).toBeUndefined();
  });

  it("says when its board's max_running is reached, and not of another board's task", async () => {
    const h = harness({ roles: [role('implementer')] });
    expect(h.service.createBoard('alpha', ALICE).ok).toBe(true);
    expect(h.service.setBoard('alpha', { maxRunning: 1 }, ALICE).ok).toBe(true);
    const first = h.create({ title: 'first', workspace: 'web', board: 'alpha' });
    h.clock.advance(1);
    const second = h.create({ title: 'second', workspace: 'api', board: 'alpha' });
    const elsewhere = h.create({ title: 'elsewhere', workspace: 'docs' });
    const held = holds(h.driver('implementer'));
    const other = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started && other.started, 'two runs');
    expect([second, elsewhere].map((t) => runCount(h, t.taskId))).toEqual([0, 1]);

    expect(shown(h, second.taskId).waiting).toEqual([{ kind: 'board', board: 'alpha', maxRunning: 1 }]);
    const said = 'board alpha is at its max_running, 1 agent run at once; it is claimed when one of them ends';
    expect(lines(h, second.taskId)).toEqual({ plain: [`waiting: ${said}`], chat: [`waiting: ${said.replace('max_running', 'max\\_running')}`] });

    completes(h, h.driver('implementer'));
    held.end('completed', () => reportComplete(h, runOf(h, first.taskId)));
    other.end('completed', () => reportComplete(h, runOf(h, elsewhere.taskId)));
    await h.dispatcher.idle();
    expect(shown(h, second.taskId).waiting).toBeUndefined();
  });

  it('gives every reason that holds, in the order the pass checks them', async () => {
    const h = harness({ roles: [role('implementer', { maxRunning: 1 })], settings: { maxRunning: 1 } });
    const first = h.create({ title: 'first', workspace: 'web' });
    h.clock.advance(1);
    const second = h.create({ title: 'second', workspace: 'web' });
    const held = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started, 'the first run');
    expect(shown(h, second.taskId).waiting).toEqual([
      { kind: 'gateway', maxRunning: 1 },
      { kind: 'role', role: 'implementer', maxRunning: 1 },
      { kind: 'workspace', workspace: 'web', taskId: first.taskId, runId: runOf(h, first.taskId) },
    ]);
    expect(lines(h, second.taskId).plain).toHaveLength(3);
    completes(h, h.driver('implementer'));
    held.end('completed', () => reportComplete(h, runOf(h, first.taskId)));
    await h.dispatcher.idle();
  });

  it("says nothing of a task that cannot be claimed for another reason: a parent not done, nobody to do it, its role not configured", async () => {
    const h = harness({ roles: [role('implementer')], settings: { maxRunning: 1 } });
    const first = h.create({ title: 'first', workspace: 'web' });
    const held = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started, 'the first run');
    const child = h.create({ title: 'child', workspace: 'api', parents: [first.taskId] });
    const made = h.service.create({ title: 'nobody', workspace: 'api', createdBy: ALICE, createdVia: { kind: 'operator' } });
    if (!made.ok) throw new Error(made.message);
    const nobody = made.task;
    const capped = h.create({ title: 'capped', workspace: 'api' });
    for (const t of [child, nobody]) expect(shown(h, t.taskId).waiting).toBeUndefined();
    expect(shown(h, capped.taskId).waiting).toEqual([{ kind: 'gateway', maxRunning: 1 }]);
    // The same board, read by a gateway whose config no longer has the role: the claim would refuse it.
    const without = new KanbanService({ db: h.t.db, roles: new Map(), workspaces: new Set(['default', 'web', 'api']), clock: h.clock, maxRunning: 1 });
    const r = without.show(capped.taskId);
    expect(r.ok && r.view.waiting).toBeUndefined();
    completes(h, h.driver('implementer'));
    completes(h, h.driver('implementer'));
    completes(h, h.driver('implementer'));
    held.end('completed', () => reportComplete(h, runOf(h, first.taskId)));
    await h.dispatcher.idle();
  });
});
