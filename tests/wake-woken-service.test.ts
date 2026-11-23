import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advanceWake, recordWake } from '../src/db/kanban.js';
import { commentsOf, eventsOf, getTask } from '../src/db/kanban-read.js';
import { KanbanService, type WakeJudge } from '../src/kanban/service.js';
import type { TaskRow, WakeRow } from '../src/kanban/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { NOW, WORKSPACES, newTask } from './helpers/kanban.js';

/**
 * A woken turn's show and unblock, as the service judges them (wake spec §9.2),
 * given the turn's delivered wake: only the tasks whose events woke it, the
 * setter's tiers live, the recurrence limit, the woken-unblock limit, and the
 * board's own refusals; the unblock bound to the latest block of the task in the
 * wake, recorded with the wake and by its setter.
 */

const ZHIXI = 'lark:on_zhixi';
let h: TestDb;
let service: KanbanService;
let talk: Set<string>;
let operate: Set<string>;
let judge: WakeJudge;

beforeEach(() => {
  h = testDb();
  service = new KanbanService({
    db: h.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock: new ManualClock(NOW + 10),
    wake: { enabled: true, maxDepth: 5 },
  });
  talk = new Set([ZHIXI]);
  operate = new Set([ZHIXI]);
  judge = {
    canTalk: (p) => talk.has(p),
    canOperate: (p) => operate.has(p),
    nameOf: (p) => (p === ZHIXI ? 'Zhixi Sun' : undefined),
    blockRecurrenceLimit: 3,
  };
});
afterEach(() => h.close());

/** A task with wake on, set by Zhixi, as every task a wake carries has. */
function wakeTask(t: Parameters<typeof newTask>[1] = {}): TaskRow {
  return newTask(h.db, { wake: { by: ZHIXI, depth: 0 }, ...t });
}

/** An event of the task, written as the board writes it. */
function event(task: TaskRow, kind: string, actor: string, payload: Record<string, unknown>): number {
  h.db
    .prepare('INSERT INTO kanban_events (task_id, kind, actor, payload, created_at) VALUES (?, ?, ?, jsonb(?), ?)')
    .run(task.taskId, kind, actor, JSON.stringify(payload), NOW);
  return eventsOf(h.db, task.taskId).at(-1)?.id ?? 0;
}

/** The task blocked by its run, as `mt kanban block` leaves it. */
function blocked(task: TaskRow, recurrences = 1): number {
  h.db.prepare("UPDATE kanban_tasks SET phase = 'blocked', blocked_from = 'open', block_kind = 'needs_input' WHERE task_id = ?").run(task.taskId);
  return event(task, 'blocked', 'run:r_1', { kind: 'needs_input', reason: 'which speaker?', blockRecurrences: recurrences });
}

/** A delivered wake of these events. */
function woke(events: ReadonlyArray<{ task: TaskRow; eventId: number }>, uuid = 'w1'): WakeRow {
  const r = recordWake(
    h.db,
    {
      uuid,
      channel: 'lark',
      appId: 'cli_app',
      conversationId: 'oc_team',
      threadId: 'omt_1',
      principal: ZHIXI,
      depth: 0,
      events: events.map((e) => ({ subscriptionId: 1, eventId: e.eventId, taskId: e.task.taskId })),
    },
    NOW,
  );
  if (!r.ok) throw new Error(r.message);
  advanceWake(h.db, r.wake.wakeId, NOW + 1);
  return r.wake;
}

describe('showForWake', () => {
  it('shows a task whose event woke the turn, a completion and a block alike', () => {
    const done = wakeTask({ title: 'Book the venue' });
    const stuck = wakeTask({ title: 'Draft the agenda' });
    const wake = woke([
      { task: done, eventId: event(done, 'completed', 'run:r_0', { summary: 'booked' }) },
      { task: stuck, eventId: blocked(stuck) },
    ]);
    expect(service.showForWake(wake, done.taskId, judge)).toMatchObject({ ok: true, view: { task: { taskId: done.taskId } }, gates: [] });
    expect(service.showForWake(wake, stuck.taskId, judge)).toMatchObject({ ok: true, view: { task: { taskId: stuck.taskId } } });
  });

  it('refuses any other task in the same words, whether it exists or not', () => {
    const done = wakeTask();
    const other = wakeTask();
    const wake = woke([{ task: done, eventId: event(done, 'completed', 'run:r_0', { summary: 'ok' }) }]);
    const a = service.showForWake(wake, other.taskId, judge);
    const b = service.showForWake(wake, 'k_nonesuch', judge);
    expect(a).toEqual({ ok: false, code: 'unauthorized', message: 'a woken turn reads only the tasks whose events woke it' });
    expect(b).toEqual(a);
  });

  it("refuses needs_talk once the setter has lost talk tier, and writes nothing", () => {
    const done = wakeTask();
    const wake = woke([{ task: done, eventId: event(done, 'completed', 'run:r_0', { summary: 'ok' }) }]);
    talk.delete(ZHIXI);
    const before = eventsOf(h.db, done.taskId).length;
    expect(service.showForWake(wake, done.taskId, judge)).toEqual({
      ok: false,
      code: 'needs_talk',
      message: 'Zhixi Sun, who set this wake, does not have talk tier, which task show needs',
    });
    expect(eventsOf(h.db, done.taskId)).toHaveLength(before);
  });
});

describe('unblockForWake', () => {
  it("lifts its own block by the setter, with the wake in the event and the comment as the board's", () => {
    const task = wakeTask();
    const block = blocked(task);
    const wake = woke([{ task, eventId: block }]);
    const r = service.unblockForWake(wake, task.taskId, 'the second speaker', judge);
    expect(r).toMatchObject({ ok: true, task: { phase: 'open' }, setter: 'Zhixi Sun' });
    expect(eventsOf(h.db, task.taskId).find((e) => e.kind === 'unblocked')).toMatchObject({ actor: ZHIXI, payload: { wake: wake.wakeId } });
    expect(commentsOf(h.db, task.taskId, { steering: true })).toEqual([
      expect.objectContaining({ author: ZHIXI, body: '(woken by the board) the second speaker' }),
    ]);
  });

  it('refuses a task whose block did not wake the turn, a completion of it included', () => {
    const done = wakeTask();
    const other = wakeTask();
    blocked(other);
    const wake = woke([{ task: done, eventId: event(done, 'completed', 'run:r_0', { summary: 'ok' }) }]);
    const message = 'a woken turn unblocks only the tasks whose blocks woke it';
    expect(service.unblockForWake(wake, other.taskId, undefined, judge)).toEqual({
      ok: false,
      code: 'not_this_wake',
      message: `\`${other.taskId}\` did not wake this turn: ${message}`,
    });
    expect(service.unblockForWake(wake, done.taskId, undefined, judge)).toMatchObject({ ok: false, code: 'not_this_wake' });
    expect(getTask(h.db, other.taskId)?.phase).toBe('blocked');
  });

  it('refuses needs_operator when the setter has no operate tier now', () => {
    const task = wakeTask();
    const wake = woke([{ task, eventId: blocked(task) }]);
    operate.delete(ZHIXI);
    expect(service.unblockForWake(wake, task.taskId, undefined, judge)).toEqual({
      ok: false,
      code: 'needs_operator',
      message: 'Zhixi Sun, who set this wake, does not have operate tier, which unblocking needs: ask in the thread for someone who can',
    });
  });

  it('refuses a block that has recurred to the limit', () => {
    const task = wakeTask();
    const wake = woke([{ task, eventId: blocked(task, 3) }]);
    expect(service.unblockForWake(wake, task.taskId, undefined, judge)).toEqual({
      ok: false,
      code: 'recurring',
      message: `\`${task.taskId}\` has been blocked 3 times in a row: a person decides whether it is unblocked again`,
    });
  });

  it('lets five woken unblocks through since the task last completed, and refuses the sixth', () => {
    const task = wakeTask();
    for (let i = 0; i < 5; i += 1) {
      const wake = woke([{ task, eventId: blocked(task) }], `w${i}`);
      expect(service.unblockForWake(wake, task.taskId, undefined, judge)).toMatchObject({ ok: true });
    }
    const sixth = woke([{ task, eventId: blocked(task) }], 'w5');
    expect(service.unblockForWake(sixth, task.taskId, undefined, judge)).toEqual({
      ok: false,
      code: 'woken_unblock_limit',
      message: `\`${task.taskId}\` has been unblocked by woken turns 5 times since it last completed: a person decides whether it is unblocked again`,
    });
    // A completion starts the count again.
    event(task, 'completed', 'run:r_9', { summary: 'done' });
    expect(service.unblockForWake(sixth, task.taskId, undefined, judge)).toMatchObject({ ok: true });
  });

  it('binds to the latest block of the task in the wake, and refuses a lifted one as stale', () => {
    const task = wakeTask();
    const first = blocked(task);
    event(task, 'unblocked', ZHIXI, { kind: 'needs_input' });
    const second = blocked(task);
    const wake = woke([
      { task, eventId: first },
      { task, eventId: second },
    ]);
    expect(service.unblockForWake(wake, task.taskId, undefined, judge)).toMatchObject({ ok: true });
    expect(eventsOf(h.db, task.taskId).filter((e) => e.kind === 'unblocked')).toHaveLength(2);
    // Blocked again since: the wake's block was lifted, so the board refuses it.
    blocked(task);
    expect(service.unblockForWake(wake, task.taskId, undefined, judge)).toMatchObject({ ok: false, code: 'stale' });
  });
});

describe('a wake turned off or taken over during the woken turn', () => {
  it('leaves the task outside the wake: its show refused unauthorized, its unblock not_this_wake, and nothing lifted', () => {
    const task = wakeTask();
    const wake = woke([{ task, eventId: blocked(task) }]);
    expect(service.showForWake(wake, task.taskId, judge)).toMatchObject({ ok: true });
    // Turned off mid-turn.
    expect(service.setWake(task.taskId, { on: false }, ZHIXI, 'cli_app')).toMatchObject({ ok: true });
    expect(service.showForWake(wake, task.taskId, judge)).toMatchObject({ ok: false, code: 'unauthorized' });
    expect(service.unblockForWake(wake, task.taskId, undefined, judge)).toEqual({
      ok: false,
      code: 'not_this_wake',
      message: `\`${task.taskId}\`'s wake has been turned off or taken over since it woke this turn, so this turn does not unblock it`,
    });
    expect(getTask(h.db, task.taskId)?.phase).toBe('blocked');
  });

  it('refuses the same once another setter has taken it over', () => {
    const task = wakeTask();
    const wake = woke([{ task, eventId: blocked(task) }]);
    h.db.prepare('UPDATE kanban_tasks SET wake_by = ? WHERE task_id = ?').run('lark:on_kevin', task.taskId);
    expect(service.unblockForWake(wake, task.taskId, undefined, judge)).toMatchObject({ ok: false, code: 'not_this_wake' });
    expect(service.showForWake(wake, task.taskId, judge)).toMatchObject({ ok: false, code: 'unauthorized' });
  });
});
