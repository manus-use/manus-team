import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindSession, revokeBindingsAt } from '../src/db/bindings.js';
import { getWake, wakeEventsOf } from '../src/db/kanban-read.js';
import { createSession } from '../src/db/sessions.js';
import { createTurn } from '../src/db/turns.js';
import { turnIdempotencyKey } from '../src/core/ids.js';
import type { TaskRow } from '../src/kanban/types.js';
import { NOW } from './helpers/kanban.js';
import { APP, THREAD_KEY, wakeHarness, type WakeHarness } from './helpers/waker.js';

/**
 * Submits under way, restarts and dedupe (wake spec §5.2 step 1, §5.7): this
 * boot's stamped rows are settled from memory, never looked up, a settling
 * write that fails tried again each round; a stamped row stops holding its
 * conversation once its key binds another session; another boot's rows are
 * looked up by their current attempt's turn; a batch is never delivered twice.
 */

let h: WakeHarness;
beforeEach(() => {
  h = wakeHarness();
});
afterEach(() => {
  h.waker.stop();
  h.t.close();
});

function completed(task: TaskRow, summary = 'Booked.'): number {
  return h.event(task, 'completed', 'run:r_1', { summary });
}

function actor(): ReturnType<WakeHarness['registry']['actor']> {
  return h.registry.actor(h.registry.bindOrCreate(THREAD_KEY, { openId: 'ou_alice', unionId: 'on_alice', displayName: null }).session.id);
}

/** Another boot's stamp on a row, as a restart finds it. */
function fromAnotherBoot(wakeId: number): void {
  h.db.prepare("UPDATE kanban_wakes SET submit_boot = 'b_before' WHERE wake_id = ?").run(wakeId);
}

/** `/new` in the thread: its binding moved to a new session. */
function rebind(): string {
  revokeBindingsAt(h.db, THREAD_KEY, NOW);
  createSession(h.db, { id: 's_new', agentId: 'default', workspaceId: 'plain-dir:x', ownerPrincipal: 'on_alice' }, NOW);
  bindSession(h.db, THREAD_KEY, 's_new', NOW);
  return 's_new';
}

describe('a settling write that fails', () => {
  it('is kept, tried again each round until it lands, the row then delivered and its conversation free', async () => {
    const task = h.woken();
    completed(task);
    const advance = h.service.advanceWake.bind(h.service);
    let fails = 2;
    h.service.advanceWake = (wakeId) => {
      if (fails-- > 0) throw new Error('database is locked');
      return advance(wakeId);
    };
    await h.round();
    expect(h.wakes()[0]).toMatchObject({ state: 'pending', submitBoot: expect.any(String) });
    expect(h.notes.filter((n) => n.includes('database is locked'))).toHaveLength(1);
    completed(task, 'later');
    await h.round();
    expect(h.wakes()[0]?.state).toBe('pending');
    await h.round();
    expect(h.wakes()[0]?.state).toBe('delivered');
    // Its conversation free, the later outcome is woken in the same round.
    expect(h.registry.submits).toHaveLength(2);
    expect(h.notes.filter((n) => n.includes('database is locked'))).toHaveLength(1);
  });

  it('for a refusal is kept too, and the row refused once it lands, then retried after its pause', async () => {
    const task = h.woken();
    completed(task);
    const a = actor();
    a.answers.push('fail_start');
    const refuse = h.service.wakeRefused.bind(h.service);
    let fails = 1;
    h.service.wakeRefused = (wakeId, error) => {
      if (fails-- > 0) throw new Error('database is locked');
      return refuse(wakeId, error);
    };
    await h.round();
    expect(h.wakes()[0]).toMatchObject({ state: 'pending', attempt: 1, sessionId: 's_w1' });
    await h.round();
    expect(h.wakes()[0]).toMatchObject({ state: 'pending', attempt: 2, sessionId: null });
    await h.clock.delay(2_000);
    await h.round();
    expect(a.submits.map((r) => r.messageId.split(':').length)).toEqual([2, 3]);
    expect(h.wakes()[0]?.state).toBe('delivered');
  });
});

describe("this boot's submit under way", () => {
  it('a start that fails only after several rounds: never looked up though its turn exists, then refused and retried, never delivered meanwhile', async () => {
    const task = h.woken();
    completed(task);
    const a = actor();
    a.answers.push('hang', 'hang');
    await h.round();
    const [wake] = h.wakes();
    createTurn(h.db, { sessionId: 's_w1', turnId: 't_w', generation: 0, idempotencyKey: wake?.turnKey ?? '' }, NOW);
    // The turn is open, so the session is busy: only its own end frees it.
    for (let i = 0; i < 3; i += 1) await h.round();
    expect(h.wakes()[0]).toMatchObject({ state: 'pending', attempt: 1, sessionId: 's_w1' });
    h.db.prepare("UPDATE turns SET state = 'failed', terminal = 'failed', ended_at = ? WHERE turn_id = 't_w'").run(NOW);
    a.release('failed');
    await new Promise((r) => setImmediate(r));
    expect(h.wakes()[0]).toMatchObject({ state: 'pending', attempt: 2, sessionId: null });
    await h.clock.delay(2_000);
    await h.round();
    expect(a.submits.map((r) => r.messageId)).toEqual([`wake:${wake?.uuid}`, `wake:${wake?.uuid}:2`]);
    expect(h.wakes()[0]?.state).toBe('pending');
  });

  it('a driver start that hangs holds its thread until /new; then the next outcome wakes the new session with its own events', async () => {
    const task = h.woken();
    completed(task);
    const old = actor();
    old.answers.push('hang');
    await h.round();
    const [hung] = h.wakes();
    completed(task, 'second');
    expect(await h.round()).toBe(0);
    rebind();
    expect(await h.round()).toBe(1);
    const [, fresh] = h.wakes();
    expect(fresh?.sessionId).toBe('s_new');
    const hungEvents = wakeEventsOf(h.db, hung?.wakeId ?? 0).map((e) => e.eventId);
    const freshEvents = wakeEventsOf(h.db, fresh?.wakeId ?? 0).map((e) => e.eventId);
    expect(freshEvents.some((e) => hungEvents.includes(e))).toBe(false);
    expect(h.registry.actor('s_new').submits[0]?.input.text).toContain('second');
    // The hung start fails at last: refused, and retried in the session bound now.
    old.release('failed');
    await new Promise((r) => setImmediate(r));
    expect(getWake(h.db, hung?.wakeId ?? 0)).toMatchObject({ state: 'pending', attempt: 2 });
    await h.clock.delay(2_000);
    await h.round();
    expect(getWake(h.db, hung?.wakeId ?? 0)).toMatchObject({ state: 'delivered', sessionId: 's_new' });
  });

  it('a hung start whose prompt does reach the old session at last is delivered there', async () => {
    const task = h.woken();
    completed(task);
    const old = actor();
    old.answers.push('hang');
    await h.round();
    rebind();
    old.submits[0]?.onPrompted?.();
    expect(h.wakes()[0]).toMatchObject({ state: 'delivered', sessionId: 's_w1' });
  });

  it('a stamped row no waker of this boot holds is refused as lost, and retried', async () => {
    const task = h.woken();
    completed(task);
    actor().answers.push('hang');
    await h.round();
    h.rebuild();
    await h.round();
    expect(h.wakes()[0]).toMatchObject({ state: 'pending', attempt: 2, sessionId: null, error: 'lost by the waker' });
    await h.clock.delay(2_000);
    await h.round();
    expect(h.wakes()[0]?.state).toBe('delivered');
  });

  it('a late callback on a row settled by another path changes nothing', async () => {
    const task = h.woken();
    completed(task);
    const a = actor();
    a.answers.push('hang');
    await h.round();
    h.service.dropWake(h.wakes()[0]?.wakeId ?? 0, 'dropped by a test');
    a.submits[0]?.onPrompted?.();
    a.release('failed');
    await new Promise((r) => setImmediate(r));
    expect(h.wakes()[0]).toMatchObject({ state: 'dropped', attempt: 1, error: 'dropped by a test' });
  });
});

describe("another boot's row", () => {
  it("with its current attempt's turn present is delivered, and never submitted again", async () => {
    const task = h.woken();
    completed(task);
    actor().answers.push('hang');
    await h.round();
    const [wake] = h.wakes();
    h.rebuild();
    fromAnotherBoot(wake?.wakeId ?? 0);
    createTurn(h.db, { sessionId: 's_w1', turnId: 't_cut', generation: 0, idempotencyKey: wake?.turnKey ?? '' }, NOW);
    h.db.prepare("UPDATE turns SET state = 'ambiguous', terminal = 'ambiguous', ended_at = ? WHERE turn_id = 't_cut'").run(NOW);
    await h.round();
    expect(h.wakes()[0]?.state).toBe('delivered');
    expect(h.registry.submits).toHaveLength(1);
  });

  it('without it is submitted again, with the same uuid and attempt, its marker not sent again', async () => {
    const task = h.woken();
    completed(task);
    actor().answers.push('hang');
    await h.round();
    const [wake] = h.wakes();
    h.rebuild();
    fromAnotherBoot(wake?.wakeId ?? 0);
    await h.round();
    expect(h.registry.submits.map((r) => r.messageId)).toEqual([`wake:${wake?.uuid}`, `wake:${wake?.uuid}`]);
    expect(h.wakes()[0]?.state).toBe('delivered');
    expect(h.lark.texts).toHaveLength(1);
  });

  it("looks up only the current attempt: a refused attempt's turn, then a restart, is submitted under the next attempt and not delivered before its prompt", async () => {
    const task = h.woken();
    completed(task);
    const a = actor();
    a.answers.push('fail_start', 'hang');
    await h.round();
    const [wake] = h.wakes();
    // The failed start left its turn behind, under attempt 1's key.
    createTurn(h.db, { sessionId: 's_w1', turnId: 't_failed', generation: 0, idempotencyKey: turnIdempotencyKey(APP, `wake:${wake?.uuid}`) }, NOW);
    h.db.prepare("UPDATE turns SET state = 'failed', terminal = 'failed', ended_at = ? WHERE turn_id = 't_failed'").run(NOW);
    h.rebuild();
    await h.round();
    expect(a.submits.map((r) => r.messageId)).toEqual([`wake:${wake?.uuid}`, `wake:${wake?.uuid}:2`]);
    expect(h.wakes()[0]).toMatchObject({ state: 'pending', attempt: 2 });
  });

  it("stamped at attempt 2 by an older boot, with only attempt 1's turn present, is submitted again as attempt 2, not delivered", async () => {
    const task = h.woken();
    completed(task);
    const a = actor();
    a.answers.push('fail_start', 'hang');
    await h.round();
    const [wake] = h.wakes();
    expect(wake).toMatchObject({ state: 'pending', attempt: 2, sessionId: null });
    // Attempt 1's failed start left its turn; attempt 2 was stamped by the boot before, and its turn never written.
    createTurn(h.db, { sessionId: 's_w1', turnId: 't_first', generation: 0, idempotencyKey: turnIdempotencyKey(APP, `wake:${wake?.uuid}`) }, NOW);
    h.db.prepare("UPDATE turns SET state = 'failed', terminal = 'failed', ended_at = ? WHERE turn_id = 't_first'").run(NOW);
    h.db
      .prepare("UPDATE kanban_wakes SET session_id = 's_w1', turn_key = ?, submit_boot = 'b_before' WHERE wake_id = ?")
      .run(turnIdempotencyKey(APP, `wake:${wake?.uuid}:2`), wake?.wakeId ?? 0);
    h.rebuild();
    await h.clock.delay(2_000);
    await h.round();
    expect(a.submits.map((r) => r.messageId)).toEqual([`wake:${wake?.uuid}`, `wake:${wake?.uuid}:2`]);
    expect(h.wakes()[0]).toMatchObject({ state: 'pending', attempt: 2, sessionId: 's_w1' });
    expect(h.wakes()[0]?.submitBoot).not.toBe('b_before');
  });
});
