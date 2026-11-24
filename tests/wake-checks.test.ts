import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelError } from '../src/channel/types.js';
import { replyUuid } from '../src/core/ids.js';
import { eventsOf, subscriptionsOf } from '../src/db/kanban-read.js';
import { Notifier } from '../src/kanban/notices.js';
import type { TaskRow } from '../src/kanban/types.js';
import { ALICE, newTask } from './helpers/kanban.js';
import { APP, BOB, IN_THREAD, wakeHarness, type WakeHarness } from './helpers/waker.js';

/**
 * The waker's live checks (wake spec §2.1, §5.2 step 3, §5.3): what is let go
 * of, passed over or skipped, each moving the wake cursor with no wake: a task
 * no longer on the board, an archived task, a setter without talk tier, a
 * conversation the gateway does not admit, and one the notifier let go of.
 */

let h: WakeHarness;
let admits: 'chat_not_allowed' | 'dm_disabled' | undefined;
let letGo: boolean;
let asked: Array<{ chatId: string; chatType: string | null }>;

beforeEach(() => {
  admits = undefined;
  letGo = false;
  asked = [];
  h = wakeHarness({
    admitsConversation: (chatId, chatType) => {
      asked.push({ chatId, chatType });
      return admits;
    },
    letGo: () => letGo,
  });
});
afterEach(() => {
  h.waker.stop();
  h.t.close();
});

function completed(task: TaskRow, summary = 'Booked.'): number {
  return h.event(task, 'completed', 'run:r_1', { summary });
}

function wakeCursor(task: TaskRow): number {
  return subscriptionsOf(h.db, task.taskId)[0]?.wakeCursor ?? -1;
}

describe('a task no longer on the board', () => {
  it('is let go of by itself, said once in the log, and passed over until a restart', async () => {
    const task = h.woken();
    completed(task);
    h.db.pragma('foreign_keys = OFF');
    h.db.prepare('DELETE FROM kanban_tasks WHERE task_id = ?').run(task.taskId);
    expect(await h.round()).toBe(0);
    expect(h.registry.submits).toEqual([]);
    const last = eventsOf(h.db, task.taskId).at(-1)?.id ?? 0;
    expect(wakeCursor(task)).toBe(last);
    h.event(task, 'completed', 'run:r_2', { summary: 'again' });
    await h.round();
    expect(h.notes.filter((n) => n.includes('not on the board'))).toEqual([
      `kanban: subscription ${subscriptionsOf(h.db, task.taskId)[0]?.id} follows task ${task.taskId}, which is not on the board; passing over its wakes until the gateway restarts`,
    ]);
    expect(wakeCursor(task)).toBe(eventsOf(h.db, task.taskId).at(-1)?.id);
  });
});

describe('an archived task', () => {
  it("has its events passed over, and wakes nothing", async () => {
    const task = h.woken();
    const event = completed(task);
    h.db.prepare("UPDATE kanban_tasks SET phase = 'archived' WHERE task_id = ?").run(task.taskId);
    expect(await h.round()).toBe(0);
    expect(h.registry.submits).toEqual([]);
    expect(wakeCursor(task)).toBe(event);
  });

  it('leaves the other tasks of its thread to wake', async () => {
    const archived = h.woken();
    const live = h.woken();
    completed(archived);
    completed(live);
    h.db.prepare("UPDATE kanban_tasks SET phase = 'archived' WHERE task_id = ?").run(archived.taskId);
    expect(await h.round()).toBe(1);
    expect(h.registry.submits[0]?.input.text).toContain(live.taskId);
    expect(h.registry.submits[0]?.input.text).not.toContain(archived.taskId);
  });
});

describe('the setter without talk tier', () => {
  it("has the task's outcomes skipped, its notice untouched, and the thread told once, by chat name", async () => {
    const task = h.woken(BOB);
    const first = completed(task);
    h.talk.delete(BOB);
    expect(await h.round()).toBe(0);
    expect(h.registry.submits).toEqual([]);
    expect(wakeCursor(task)).toBe(first);
    expect(h.lark.texts).toEqual([
      {
        target: { chatId: 'oc_chat', threadId: 'omt_1', root: 'om_root' },
        text: `wake is off for \`${task.taskId}\`: Bob no longer has talk tier`,
        uuid: replyUuid(APP, `wake-off:${task.taskId}`, `talk:${first}`),
      },
    ]);
    completed(task, 'again');
    expect(await h.round()).toBe(0);
    expect(h.lark.texts).toHaveLength(1);
    // Wake stays on.
    expect(h.db.prepare<[string], { wake_by: string | null }>('SELECT wake_by FROM kanban_tasks WHERE task_id = ?').get(task.taskId)?.wake_by).toBe(BOB);
  });

  it('names the principal when chat has no name for them', async () => {
    const task = h.woken(BOB);
    completed(task);
    h.talk.delete(BOB);
    h.names.delete(BOB);
    await h.round();
    expect(h.lark.texts.map((t) => t.text)).toEqual([`wake is off for \`${task.taskId}\`: ${BOB} no longer has talk tier`]);
  });

  it('resumes from the next outcome once the tier is back, and says it again after a second lapse', async () => {
    const task = h.woken(BOB);
    completed(task);
    h.talk.delete(BOB);
    await h.round();
    h.talk.add(BOB);
    completed(task, 'second');
    expect(await h.round()).toBe(1);
    expect(h.registry.submits[0]?.input.text).toContain('second');
    expect(h.registry.submits[0]?.input.text).not.toContain('Booked.');
    h.talk.delete(BOB);
    completed(task, 'third');
    await h.round();
    expect(h.lark.texts.filter((t) => t.text.startsWith('wake is off')).length).toBe(2);
  });

  it("skips only that setter's tasks: another setter's in the thread still wakes", async () => {
    const bobs = h.woken(BOB);
    const alices = h.woken(ALICE);
    completed(bobs);
    completed(alices);
    h.talk.delete(BOB);
    expect(await h.round()).toBe(1);
    expect(h.registry.submits.map((r) => r.origin?.wake.by)).toEqual([ALICE]);
  });
});

describe('a conversation the gateway does not admit', () => {
  it.each(['chat_not_allowed', 'dm_disabled'] as const)('is passed over when the answer is %s, with one log line until a restart', async (reason) => {
    const task = h.woken();
    const event = completed(task);
    admits = reason;
    expect(await h.round()).toBe(0);
    expect(h.registry.submits).toEqual([]);
    expect(wakeCursor(task)).toBe(event);
    completed(task, 'again');
    await h.round();
    expect(h.notes.filter((n) => n.includes('not admitted'))).toEqual([
      `kanban: oc_chat/omt_1 is not admitted (${reason}); passing over its wakes until the gateway restarts`,
    ]);
  });

  it("is asked with the subscription's chat type, and null for one that does not know it", async () => {
    const task = h.woken();
    completed(task);
    const plain = newTask(h.db, { createdVia: { ...IN_THREAD, conversationId: 'oc_term', threadId: '' } });
    h.db.prepare("UPDATE kanban_subscriptions SET chat_type = NULL WHERE task_id = ?").run(plain.taskId);
    h.db.prepare('UPDATE kanban_tasks SET wake_by = ? WHERE task_id = ?').run(ALICE, plain.taskId);
    completed(plain);
    await h.round();
    expect(asked).toEqual(
      expect.arrayContaining([
        { chatId: 'oc_chat', chatType: 'group' },
        { chatId: 'oc_term', chatType: null },
      ]),
    );
  });
});

describe('a conversation the notifier let go of', () => {
  it('is passed over, with one log line until a restart', async () => {
    const task = h.woken();
    const event = completed(task);
    letGo = true;
    expect(await h.round()).toBe(0);
    expect(wakeCursor(task)).toBe(event);
    completed(task, 'again');
    await h.round();
    expect(h.registry.submits).toEqual([]);
    expect(h.notes.filter((n) => n.includes('let go of'))).toEqual([
      'kanban: oc_chat/omt_1 has been let go of by the notifier; passing over its wakes until the gateway restarts',
    ]);
  });

  it("is what Notifier.letGo says: true once a send let the conversation go, false before", async () => {
    const task = newTask(h.db, { createdVia: IN_THREAD });
    h.event(task, 'completed', 'run:r_1', { summary: 'x' }, false);
    const n = new Notifier({ db: h.db, service: h.service, channels: new Map([['lark', h.lark]]), appId: APP, blockRecurrenceLimit: 3, clock: h.clock });
    const at = { channel: 'lark', appId: APP, conversationId: 'oc_chat', threadId: 'omt_1' };
    expect(n.letGo(at)).toBe(false);
    h.lark.failNext('sendText', new ChannelError(230002, 'the bot is not in the chat', false));
    await n.deliver();
    expect(n.letGo(at)).toBe(true);
    expect(n.letGo({ ...at, threadId: 'omt_2' })).toBe(false);
  });
});
