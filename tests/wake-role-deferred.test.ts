import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setWake } from '../src/db/kanban.js';
import { deferredButton, eventsOf, getSubscription, subscriptionsOf } from '../src/db/kanban-read.js';
import type { DeferredButtonRow, TaskRow } from '../src/kanban/types.js';
import type { Role } from '../src/roles.js';
import { role } from './helpers/dispatch.js';
import { ALICE, NOW, claimed } from './helpers/kanban.js';
import { APP, wakeHarness, type WakeHarness } from './helpers/waker.js';

/**
 * A role's agent-first blocks (wake spec §19.6): a deferred button of a role's
 * wake waits for the reaction task's first run to end, or for `hold_minutes`
 * from the notice's send, the time in the queue counting; read from the
 * database each round, so a restart changes nothing; and a removed role never
 * holds a button.
 */

let roles: Map<string, Role>;
let h: WakeHarness;
beforeEach(() => {
  roles = new Map([['vi-coordinator', role('vi-coordinator')]]);
  h = wakeHarness({}, { roles });
});
afterEach(() => {
  h.waker.stop();
  h.t.close();
});

const MINUTE = 60_000;

/** A task with wake on for vi-coordinator, blocked by its run, its notice sent without its button (held), and the round that made its reaction task. */
async function heldBlock(): Promise<{ task: TaskRow; event: number; sub: number; reaction: string }> {
  const task = h.woken();
  const r = setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5, role: 'vi-coordinator' }, ALICE, APP, NOW);
  if (!r.ok) throw new Error(r.message);
  h.noticed(task);
  const event = h.event(task, 'blocked', 'run:r_1', { kind: 'needs_input', reason: 'Which one?', blockRecurrences: 1 });
  const sub = subscriptionsOf(h.db, task.taskId)[0]?.id ?? 0;
  const s = getSubscription(h.db, sub);
  const e = eventsOf(h.db, task.taskId).find((x) => x.id === event);
  if (s === undefined || e === undefined) throw new Error('no block');
  expect(h.waker.wouldDefer(s, e)).toBe(true);
  expect(h.service.deferButton(s, e, h.clock.now()).ok).toBe(true);
  await h.round();
  const reaction = h.wakes()[0]?.reactionTask;
  if (reaction === undefined || reaction === null) throw new Error('no reaction task');
  return { task: r.task, event, sub, reaction };
}

function button(sub: number, event: number): DeferredButtonRow | undefined {
  return deferredButton(h.db, sub, event);
}

/** The reaction task's first run, decided with `outcome`. */
function decided(reaction: string, outcome: string): void {
  const run = claimed(h.db, reaction);
  h.db.prepare('UPDATE kanban_runs SET outcome = ? WHERE run_id = ?').run(outcome, run.runId);
}

describe("a role's deferred button", () => {
  it('stays held while the reaction task waits in the queue, within the hold', async () => {
    const b = await heldBlock();
    expect(button(b.sub, b.event)).toMatchObject({ state: 'held' });
    h.clock.advance(9 * MINUTE);
    await h.round();
    expect(button(b.sub, b.event)).toMatchObject({ state: 'held' });
  });

  it('goes to people, tried, once its first run completed with the block still there', async () => {
    const b = await heldBlock();
    decided(b.reaction, 'completed');
    await h.round();
    expect(button(b.sub, b.event)).toMatchObject({ why: 'tried' });
    expect(h.lark.texts.at(-1)?.text).toContain(`The agent could not lift the block on \`${b.task.taskId}\``);
  });

  it('counts a run that asked for review as a try', async () => {
    const b = await heldBlock();
    decided(b.reaction, 'review_requested');
    await h.round();
    expect(button(b.sub, b.event)).toMatchObject({ why: 'tried' });
  });

  it('goes to people, turn_failed, after a first run that ended any other way', async () => {
    const b = await heldBlock();
    decided(b.reaction, 'blocked');
    await h.round();
    expect(button(b.sub, b.event)).toMatchObject({ why: 'turn_failed' });
  });

  it('owes no card once the block is lifted', async () => {
    const b = await heldBlock();
    h.event(b.task, 'unblocked', ALICE, { kind: 'needs_input' });
    decided(b.reaction, 'completed');
    await h.round();
    expect(button(b.sub, b.event)).toMatchObject({ state: 'lifted' });
  });

  it('is released at hold_minutes, not_woken while the task waits unclaimed', async () => {
    const b = await heldBlock();
    h.clock.advance(10 * MINUTE);
    await h.round();
    expect(button(b.sub, b.event)).toMatchObject({ why: 'not_woken' });
  });

  it('is released at hold_minutes, running while its run runs', async () => {
    const b = await heldBlock();
    claimed(h.db, b.reaction);
    h.clock.advance(10 * MINUTE);
    await h.round();
    expect(button(b.sub, b.event)).toMatchObject({ why: 'running' });
  });

  it('reads the same from the database after a restart', async () => {
    const b = await heldBlock();
    h.rebuild();
    await h.round();
    expect(button(b.sub, b.event)).toMatchObject({ state: 'held' });
    decided(b.reaction, 'completed');
    await h.round();
    expect(button(b.sub, b.event)).toMatchObject({ why: 'tried' });
  });

  it('is never held for a role that can no longer be given work', async () => {
    const task = h.woken();
    const r = setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5, role: 'vi-coordinator' }, ALICE, APP, NOW);
    if (!r.ok) throw new Error(r.message);
    h.noticed(task);
    const event = h.event(task, 'blocked', 'run:r_1', { kind: 'needs_input', reason: 'Which one?', blockRecurrences: 1 }, false);
    const s = subscriptionsOf(h.db, task.taskId)[0];
    const e = eventsOf(h.db, task.taskId).find((x) => x.id === event);
    if (s === undefined || e === undefined) throw new Error('no block');
    roles.delete('vi-coordinator');
    expect(h.waker.wouldDefer(s, e)).toBe(false);
  });
});
