import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelError } from '../src/channel/types.js';
import { deferredButton, eventsOf, subscriptionsOf, unblockMessage } from '../src/db/kanban-read.js';
import { unblockButton } from '../src/kanban/chat-render.js';
import { Notifier } from '../src/kanban/notices.js';
import { KanbanService } from '../src/kanban/service.js';
import type { CreatedVia, KanbanEvent, SubscriptionRow, TaskRow } from '../src/kanban/types.js';
import { clearSecrets } from '../src/secrets.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { ALICE, WORKSPACES } from './helpers/kanban.js';

/**
 * The notifier defers a block's Unblock button at the waker's word (wake spec
 * §5.9): the notice goes at once, without the button, ending "The agent is
 * looking at it first.", as a card even with no button left; once the send
 * succeeded, and before the cursor moves, the message is recorded with
 * `has_button` 0 for the block and the deferral written `held`, for a card and
 * for a text notice; a failed send writes neither.
 */

const VIA: CreatedVia = { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' };
const LOOKING = 'The agent is looking at it first.';
const person = { kind: 'person', principal: ALICE } as const;

let t: TestDb;
let clock: ManualClock;
let service: KanbanService;
let lark: FakeChannel;
let notes: string[];
let asked: Array<{ sub: number; event: number; kind: string }>;
let defer: Set<string>;

beforeEach(() => {
  clearSecrets();
  t = testDb();
  clock = new ManualClock();
  service = new KanbanService({ db: t.db, roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])), workspaces: WORKSPACES, clock });
  lark = new FakeChannel({ id: 'lark', clock });
  notes = [];
  asked = [];
  defer = new Set();
});
afterEach(() => {
  clearSecrets();
  t.close();
});

function notifier(wouldDefer: boolean = true): Notifier {
  return new Notifier({
    db: t.db,
    service,
    channels: new Map([['lark', lark]]),
    appId: 'cli_app',
    blockRecurrenceLimit: 2,
    clock,
    note: (line) => notes.push(line),
    ...(wouldDefer
      ? {
          wouldDefer: (sub: SubscriptionRow, event: KanbanEvent) => {
            asked.push({ sub: sub.id, event: event.id, kind: event.kind });
            return defer.has(event.taskId);
          },
        }
      : {}),
  });
}

function create(title: string): TaskRow {
  const r = service.create({ title, assignee: 'implementer', createdBy: ALICE, createdVia: VIA });
  if (!r.ok) throw new Error(r.message);
  return r.task;
}

function blocked(title: string): { task: TaskRow; block: number; sub: SubscriptionRow } {
  const task = create(title);
  expect(service.block(task.taskId, person, { kind: 'needs_input', reason: 'which wiki?' }).ok).toBe(true);
  const block = eventsOf(t.db, task.taskId).find((e) => e.kind === 'blocked')?.id ?? 0;
  const sub = subscriptionsOf(t.db, task.taskId)[0];
  if (sub === undefined) throw new Error('no subscription');
  return { task, block, sub };
}

function cursorOf(task: TaskRow): number {
  return subscriptionsOf(t.db, task.taskId)[0]?.cursor ?? -1;
}

describe('the notifier, asked to defer a block', () => {
  it('sends the notice at once as a card with no button, ending with its line, and records it and the deferral before the cursor moves', async () => {
    const b = blocked('Draft the agenda');
    defer.add(b.task.taskId);
    clock.advance(123_000);
    expect(await notifier().deliver()).toBe(1);
    expect(lark.texts).toHaveLength(1);
    expect(lark.texts[0]?.buttons).toBeUndefined();
    expect(lark.texts[0]?.card).toBe(true);
    const notice = lark.texts[0]?.text.split('\n\n').at(-1) ?? '';
    expect(notice.endsWith(`\n${LOOKING}`)).toBe(true);
    expect(asked).toEqual([{ sub: b.sub.id, event: b.block, kind: 'blocked' }]);
    expect(unblockMessage(t.db, 'cli_app', 'om_text_1')?.buttons).toEqual([
      { taskId: b.task.taskId, blockEvent: b.block, redrawnFor: null, hasButton: false, deferred: 'held' },
    ]);
    expect(deferredButton(t.db, b.sub.id, b.block)).toMatchObject({ state: 'held', heldAt: 1_760_000_123_000 });
    expect(cursorOf(b.task)).toBe(b.block);
  });

  it('keeps the button on the notice when the waker says no, as today, and asks only of blocks', async () => {
    const b = blocked('Draft the agenda');
    const r = await service.complete(create('Book the venue').taskId, person, { summary: 'booked' });
    expect(r.ok).toBe(true);
    await notifier().deliver();
    expect(lark.texts[0]?.buttons).toEqual([unblockButton('cli_app', { id: b.block, taskId: b.task.taskId })]);
    expect(lark.texts[0]?.card).toBeUndefined();
    expect(lark.texts[0]?.text).not.toContain(LOOKING);
    expect(asked.map((a) => a.kind)).toEqual(['blocked']);
    expect(deferredButton(t.db, b.sub.id, b.block)).toBeUndefined();
  });

  it('records a deferred block and a real button of one message, each as it was sent', async () => {
    const deferred = blocked('Draft the agenda');
    const kept = blocked('Check the links');
    defer.add(deferred.task.taskId);
    await notifier().deliver();
    expect(lark.texts[0]?.buttons?.map((x) => x.value['task'])).toEqual([kept.task.taskId]);
    const notices = lark.texts[0]?.text.split('\n\n') ?? [];
    expect(notices.filter((n) => n.endsWith(LOOKING))).toHaveLength(1);
    expect(notices.find((n) => n.endsWith(LOOKING))).toContain(deferred.task.taskId);
    expect(unblockMessage(t.db, 'cli_app', 'om_text_1')?.buttons.map((x) => [x.taskId, x.hasButton])).toEqual([
      [deferred.task.taskId, false],
      [kept.task.taskId, true],
    ]);
  });

  it('writes the deferral for a notice that went as text, its card refused, and records no message', async () => {
    const b = blocked('Draft the agenda');
    defer.add(b.task.taskId);
    lark.answerNext('sendText', { messageId: 'om_plain', deduped: false, card: false });
    await notifier().deliver();
    expect(unblockMessage(t.db, 'cli_app', 'om_plain')).toBeUndefined();
    expect(deferredButton(t.db, b.sub.id, b.block)?.state).toBe('held');
    expect(cursorOf(b.task)).toBe(b.block);
  });

  it('writes nothing for a send that failed, and moves no cursor', async () => {
    const b = blocked('Draft the agenda');
    defer.add(b.task.taskId);
    lark.failNext('sendText', new ChannelError(230099, 'refused', false));
    await notifier().deliver();
    expect(deferredButton(t.db, b.sub.id, b.block)).toBeUndefined();
    expect(cursorOf(b.task)).toBeLessThan(b.block);
  });

  it('says a deferral that could not be written, and still moves the cursor', async () => {
    const b = blocked('Draft the agenda');
    defer.add(b.task.taskId);
    vi.spyOn(service, 'deferButton').mockImplementation(() => {
      throw new Error('disk full');
    });
    await notifier().deliver();
    expect(notes.some((n) => n.includes(`deferring the Unblock button of task ${b.task.taskId}`) && n.includes('disk full'))).toBe(true);
    expect(cursorOf(b.task)).toBe(b.block);
  });

  it("keeps the button on the notice, and says so, when the waker's word throws", async () => {
    const b = blocked('Draft the agenda');
    const n = new Notifier({
      db: t.db,
      service,
      channels: new Map([['lark', lark]]),
      appId: 'cli_app',
      blockRecurrenceLimit: 2,
      clock,
      note: (line) => notes.push(line),
      wouldDefer: () => {
        throw new Error('no such table');
      },
    });
    await n.deliver();
    expect(lark.texts[0]?.buttons).toEqual([unblockButton('cli_app', { id: b.block, taskId: b.task.taskId })]);
    expect(lark.texts[0]?.text).not.toContain(LOOKING);
    expect(notes.some((x) => x.includes(`defer the Unblock button of task ${b.task.taskId} failed (no such table)`))).toBe(true);
    expect(deferredButton(t.db, b.sub.id, b.block)).toBeUndefined();
    expect(cursorOf(b.task)).toBe(b.block);
  });

  it('still writes the deferral, and moves the cursor, when the has_button 0 record fails', async () => {
    const b = blocked('Draft the agenda');
    defer.add(b.task.taskId);
    vi.spyOn(service, 'recordUnblockButtons').mockImplementation(() => {
      throw new Error('disk full');
    });
    await notifier().deliver();
    expect(notes.some((x) => x.includes('recording the Unblock buttons of message om_text_1 failed (disk full)'))).toBe(true);
    expect(unblockMessage(t.db, 'cli_app', 'om_text_1')).toBeUndefined();
    expect(deferredButton(t.db, b.sub.id, b.block)?.state).toBe('held');
    expect(cursorOf(b.task)).toBe(b.block);
  });

  it('gives the place a deferred block leaves among the buttons to the next block', async () => {
    const blocks = ['one', 'two', 'three', 'four', 'five', 'six'].map((title) => blocked(title));
    await notifier().deliver();
    // Without a deferral, five buttons: the sixth block's notice has none.
    expect(lark.texts[0]?.buttons?.map((x) => x.value['task'])).toEqual(blocks.slice(0, 5).map((b) => b.task.taskId));
    const more = ['seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'].map((title) => blocked(title));
    defer.add(more[0]?.task.taskId ?? '');
    await notifier().deliver();
    expect(lark.texts[1]?.buttons?.map((x) => x.value['task'])).toEqual(more.slice(1).map((b) => b.task.taskId));
  });

  it('says a deferral already written, sent again with the same batch, and keeps its row as it was', async () => {
    const b = blocked('Draft the agenda');
    defer.add(b.task.taskId);
    clock.advance(1_000);
    expect(service.deferButton(b.sub, { id: b.block, taskId: b.task.taskId } as KanbanEvent, clock.now()).ok).toBe(true);
    clock.advance(1_000);
    await notifier().deliver();
    expect(notes.some((x) => x.includes(`the Unblock button of task ${b.task.taskId} (event ${b.block}) was deferred already`))).toBe(true);
    expect(deferredButton(t.db, b.sub.id, b.block)?.heldAt).toBe(1_760_000_001_000);
  });

  it('asks nothing, and defers nothing, with no waker', async () => {
    const b = blocked('Draft the agenda');
    defer.add(b.task.taskId);
    await notifier(false).deliver();
    expect(lark.texts[0]?.buttons).toHaveLength(1);
    expect(asked).toEqual([]);
  });
});
