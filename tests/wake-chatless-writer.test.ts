import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addComment, dropWake, passTaskWake, recordWake, setWake, type NewRoleWake } from '../src/db/kanban.js';
import { boardWakesInLastHour, dueTaskWakes, eventsOf, getTask, subscriptionsOf } from '../src/db/kanban-read.js';
import { KanbanService } from '../src/kanban/service.js';
import type { Role } from '../src/roles.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, NOW, WORKSPACES, newTask } from './helpers/kanban.js';

/**
 * A role's wake with no chat, in the writer and its reads (wake spec §19.16):
 * `recordRoleWake` of a batch of no conversation, its events of subscription 0,
 * makes the reaction task with no subscription and moves the source task's own
 * `wake_cursor`; `dueTaskWakes` lists the chatless tasks with a role's wake and
 * an event past that cursor; `passTaskWake` moves it forward only; and
 * `boardWakesInLastHour` counts such wakes per board, for the cap.
 */

const APP = 'cli_app';
const OPERATOR = { kind: 'operator' } as const;
const ROLES: ReadonlyMap<string, Role> = new Map([['vi-coordinator', role('vi-coordinator')]]);

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

function service(at = NOW + 10): KanbanService {
  return new KanbanService({ db: h.db, roles: ROLES, workspaces: WORKSPACES, clock: new ManualClock(at) });
}

/** A task no chat follows, wake on for vi-coordinator, and an event of it past its cursor. */
function chatless(board?: string): { taskId: string; event: number } {
  const task = newTask(h.db, { createdVia: OPERATOR, ...(board === undefined ? {} : { board }) });
  const set = setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5, role: 'vi-coordinator' }, 'operator:x', APP, NOW);
  if (!set.ok) throw new Error(set.message);
  addComment(h.db, task.taskId, ALICE, 'an outcome stands in here', NOW + 1, false);
  return { taskId: task.taskId, event: eventsOf(h.db, task.taskId).at(-1)?.id ?? 0 };
}

function batchOf(taskId: string, event: number, uuid = 'u-1'): NewRoleWake {
  return {
    uuid,
    channel: 'lark',
    appId: APP,
    conversationId: '',
    threadId: '',
    principal: ALICE,
    depth: 0,
    events: [{ subscriptionId: 0, eventId: event, taskId }],
    role: 'vi-coordinator',
    title: `React to board updates: ${taskId} completed`,
    body: 'Board update: …',
  };
}

describe('recordRoleWake with no chat', () => {
  it("makes the reaction task with no subscription, and moves the source task's own cursor", () => {
    const { taskId, event } = chatless();
    const r = service().recordRoleWake(batchOf(taskId, event));
    if (!r.ok || !('wake' in r)) throw new Error('no reaction task');
    expect(r.existing).toBe(false);
    expect(r.wake).toMatchObject({ state: 'delivered', conversationId: '', threadId: '', targetRole: 'vi-coordinator', reactionTask: r.task.taskId });
    expect(r.task).toMatchObject({ reactionOf: r.wake.wakeId, createdBy: ALICE, wakeBy: null, wakeDepth: 1 });
    expect(subscriptionsOf(h.db, r.task.taskId)).toEqual([]);
    expect(getTask(h.db, taskId)?.wakeCursor).toBe(event);
    const again = service().recordRoleWake(batchOf(taskId, event));
    expect(again).toMatchObject({ ok: true, existing: true, task: { taskId: r.task.taskId } });
  });
});

describe('a chatless batch, partly settled', () => {
  it("moves only the named tasks' own cursors when a pending row of no chat is dropped for some of its tasks", () => {
    const a = chatless();
    const b = chatless();
    const recorded = recordWake(
      h.db,
      {
        uuid: 'u-partial',
        channel: 'lark',
        appId: APP,
        conversationId: '',
        threadId: '',
        principal: ALICE,
        depth: 0,
        events: [
          { subscriptionId: 0, eventId: a.event, taskId: a.taskId },
          { subscriptionId: 0, eventId: b.event, taskId: b.taskId },
        ],
      },
      NOW + 5,
    );
    if (!recorded.ok) throw new Error(recorded.message);
    const before = getTask(h.db, b.taskId)?.wakeCursor ?? 0;
    expect(dropWake(h.db, recorded.wake.wakeId, 'task gone', NOW + 6, { tasks: [a.taskId] })).toEqual({ ok: true, dropped: true });
    expect(getTask(h.db, a.taskId)?.wakeCursor).toBe(a.event);
    expect(getTask(h.db, b.taskId)?.wakeCursor).toBe(before);
    expect(before).toBeLessThan(b.event);
  });

  it('refuses a batch of a conversation that names subscription 0, and writes nothing', () => {
    const { taskId, event } = chatless();
    const tasks = (h.db.prepare('SELECT count(*) AS n FROM kanban_tasks').get() as { n: number }).n;
    expect(service().recordRoleWake({ ...batchOf(taskId, event), conversationId: 'oc_team', threadId: 'omt_1' })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'a batch of conversation oc_team/omt_1 names no subscription',
    });
    expect((h.db.prepare('SELECT count(*) AS n FROM kanban_tasks').get() as { n: number }).n).toBe(tasks);
    expect(getTask(h.db, taskId)?.wakeCursor).toBeLessThan(event);
  });
});

describe('dueTaskWakes', () => {
  it("lists a chatless task with a role's wake and an event past its own cursor, and nothing else", () => {
    const { taskId, event } = chatless();
    newTask(h.db, { createdVia: OPERATOR });
    const followed = newTask(h.db, { wake: { by: ALICE, depth: 0, role: 'vi-coordinator' } });
    addComment(h.db, followed.taskId, ALICE, 'followed in a chat', NOW + 1, false);
    expect(dueTaskWakes(h.db, APP).map((t) => [t.taskId, t.oldestDue])).toEqual([[taskId, event]]);
    expect(passTaskWake(h.db, taskId, event)).toEqual({ ok: true, advanced: true });
    expect(passTaskWake(h.db, taskId, event - 1)).toEqual({ ok: true, advanced: false });
    expect(dueTaskWakes(h.db, APP)).toEqual([]);
  });
});

describe('boardWakesInLastHour', () => {
  it("counts the chatless wakes of the source's board in the hour, and no other board's", () => {
    const a = chatless();
    service(NOW + 10).recordRoleWake(batchOf(a.taskId, a.event, 'u-a'));
    const b = chatless();
    service(NOW + 20).recordRoleWake(batchOf(b.taskId, b.event, 'u-b'));
    expect(boardWakesInLastHour(h.db, APP, 'default', NOW + 30)).toEqual([NOW + 10, NOW + 20]);
    expect(boardWakesInLastHour(h.db, APP, 'research', NOW + 30)).toEqual([]);
    expect(boardWakesInLastHour(h.db, APP, 'default', NOW + 10 + 60 * 60_000)).toEqual([NOW + 20]);
  });
});
