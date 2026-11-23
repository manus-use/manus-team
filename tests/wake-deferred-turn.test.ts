import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferButton, unblock } from '../src/db/kanban.js';
import { deferredButton, subscriptionsOf } from '../src/db/kanban-read.js';
import type { TaskRow } from '../src/kanban/types.js';
import type { TurnTerminal } from '../src/types.js';
import { clearSecrets } from '../src/secrets.js';
import { settle } from './helpers/db.js';
import { ALICE, NOW } from './helpers/kanban.js';
import { wakeHarness, type WakeHarness } from './helpers/waker.js';

/**
 * A woken turn's end decides its deferred blocks (wake spec §5.9): each still
 * held is read for its lift once the turn's promise settles, `lifted` if it
 * was, else `due`, `tried` after a completed turn and `turn_failed` after any
 * other; the prompt says a block's button is deferred only while its row is
 * still held at the submit (§7); and a deferred block cut from the prompt by
 * its 4,000 characters is released at the submit, `not_woken`, as the agent is
 * not told of it.
 */

const DEFERRED_NOTE =
  'People in this thread have seen this block, but have no Unblock button for it yet: you have the first try. If it is still blocked when your turn ends, or after 10 minutes, the button goes to them.';

let h: WakeHarness;
beforeEach(() => {
  clearSecrets();
  h = wakeHarness();
});
afterEach(() => {
  clearSecrets();
  h.t.close();
});

/** A run's block of a wake-on task, its notice sent without its button: the deferral written. */
function deferredBlock(task: TaskRow, reason = 'which speaker?'): { sub: number; event: number } {
  h.db.prepare("UPDATE kanban_tasks SET phase = 'blocked', blocked_from = 'open', block_kind = 'needs_input' WHERE task_id = ?").run(task.taskId);
  const event = h.event(task, 'blocked', 'run:r_1', { kind: 'needs_input', reason, blockRecurrences: 1 });
  const sub = subscriptionsOf(h.db, task.taskId)[0]?.id ?? 0;
  const r = deferButton(h.db, { subscriptionId: sub, eventId: event }, NOW);
  if (!r.ok) throw new Error(r.message);
  return { sub, event };
}

async function turnEnds(terminal: TurnTerminal): Promise<void> {
  h.registry.actor('s_w1').release(terminal);
  await settle();
}

describe("a woken turn's end", () => {
  it('makes a deferred block still standing due as tried after a completed turn, and tells the prompt the button waits', async () => {
    const task = h.woken();
    const b = deferredBlock(task);
    h.registry.actor('s_w1').answers.push('hold');
    expect(await h.round()).toBe(1);
    const prompt = h.registry.submits[0]?.input.text ?? '';
    expect(prompt).toContain(DEFERRED_NOTE);
    expect(prompt).not.toContain('An Unblock button is on its notice in this thread.');
    expect(prompt).toContain(`If you can answer the block yourself, lift it with mt kanban task unblock ${task.taskId} <comment>`);
    // Delivered, but the turn still runs: the button waits.
    expect(h.wakes()[0]?.state).toBe('delivered');
    expect(deferredButton(h.db, b.sub, b.event)?.state).toBe('held');
    await turnEnds('completed');
    expect(deferredButton(h.db, b.sub, b.event)).toMatchObject({ state: 'due', why: 'tried' });
  });

  it.each(['failed', 'cancelled', 'ambiguous'] as const)('makes it due as turn_failed after a turn that ended %s', async (terminal) => {
    const task = h.woken();
    const b = deferredBlock(task);
    h.registry.actor('s_w1').answers.push('hold');
    await h.round();
    await turnEnds(terminal);
    expect(deferredButton(h.db, b.sub, b.event)).toMatchObject({ state: 'due', why: 'turn_failed' });
  });

  it('makes it lifted, with no card owed, when the agent lifted the block during its turn', async () => {
    const task = h.woken();
    const b = deferredBlock(task);
    h.registry.actor('s_w1').answers.push('hold');
    await h.round();
    const r = unblock(h.db, task.taskId, ALICE, 'the first one', NOW + 5, { blockedAt: b.event, wake: h.wakes()[0]?.wakeId ?? 0 });
    if (!r.ok) throw new Error(r.message);
    await turnEnds('completed');
    expect(deferredButton(h.db, b.sub, b.event)).toMatchObject({ state: 'lifted' });
  });

  it('makes it due as turn_failed when the submit rejects after the prompt reached the agent', async () => {
    const task = h.woken();
    const b = deferredBlock(task);
    h.registry.actor('s_w1').answers.push({ rejectAfterPrompt: new Error('session s_w1 is closed') });
    await h.round();
    await settle();
    expect(h.wakes()[0]?.state).toBe('delivered');
    expect(deferredButton(h.db, b.sub, b.event)).toMatchObject({ state: 'due', why: 'turn_failed' });
  });

  it('keeps the wake in hand until every decision is written, and tries a failed one again from the round', async () => {
    const task = h.woken();
    const b = deferredBlock(task);
    h.registry.actor('s_w1').answers.push('hold');
    await h.round();
    const due = vi.spyOn(h.service, 'buttonDue').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    await turnEnds('completed');
    expect(deferredButton(h.db, b.sub, b.event)?.state).toBe('held');
    expect(h.notes.some((n) => n.includes(`event ${b.event} was not moved (database is locked)`))).toBe(true);
    await h.round();
    expect(due).toHaveBeenCalledTimes(2);
    expect(deferredButton(h.db, b.sub, b.event)).toMatchObject({ state: 'due', why: 'tried' });
    // Decided: the next round writes nothing more.
    await h.round();
    expect(due).toHaveBeenCalledTimes(2);
  });

  it('decides nothing on a refused attempt: the button still waits for the turn that comes', async () => {
    const task = h.woken();
    const b = deferredBlock(task);
    h.registry.actor('s_w1').answers.push('fail_start');
    await h.round();
    expect(h.wakes()[0]).toMatchObject({ state: 'pending', attempt: 2 });
    expect(deferredButton(h.db, b.sub, b.event)?.state).toBe('held');
  });

  it("uses the button's other note once its row is no longer held at the submit", async () => {
    const task = h.woken();
    const b = deferredBlock(task);
    h.db.prepare("UPDATE kanban_deferred_buttons SET state = 'due', why = 'running'").run();
    await h.round();
    const prompt = h.registry.submits[0]?.input.text ?? '';
    expect(prompt).not.toContain(DEFERRED_NOTE);
    expect(prompt).toContain('Its notice in this thread has no Unblock button; /kanban task unblock lifts it.');
    expect(deferredButton(h.db, b.sub, b.event)?.state).toBe('due');
  });

  it('says the hold in the minutes kanban.wake.hold_minutes gives', async () => {
    h.t.close();
    h = wakeHarness({ settings: { perHour: 6, maxDepth: 5, holdMinutes: 15 } });
    deferredBlock(h.woken());
    await h.round();
    expect(h.registry.submits[0]?.input.text).toContain('If it is still blocked when your turn ends, or after 15 minutes, the button goes to them.');
  });
});

describe('a deferred block cut from the prompt', () => {
  it('has its button released at the submit, not_woken, while the blocks the prompt tells of stay held', async () => {
    const blocks = Array.from({ length: 8 }, (_x, i) => deferredBlock(h.woken(), `${'why '.repeat(150)}${i}`));
    h.registry.actor('s_w1').answers.push('hold');
    await h.round();
    const prompt = h.registry.submits[0]?.input.text ?? '';
    expect(prompt).toMatch(/and \d+ more: \/kanban task list$/);
    const states = blocks.map((b) => deferredButton(h.db, b.sub, b.event));
    const told = states.filter((r) => r?.state === 'held');
    const cut = states.filter((r) => r?.state === 'due');
    expect(told.length).toBeGreaterThan(0);
    expect(cut.length).toBeGreaterThan(0);
    expect(told.length + cut.length).toBe(8);
    for (const r of cut) expect(r?.why).toBe('not_woken');
    expect(prompt.match(/no Unblock button for it yet/g)).toHaveLength(told.length);
  });
});
