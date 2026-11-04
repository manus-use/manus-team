import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelError, type Channel } from '../src/channel/types.js';
import { noticeBatchUuid } from '../src/core/ids.js';
import { dueSubscriptions, eventsOf, subscriptionsOf } from '../src/db/kanban-read.js';
import {
  BATCH_NOTICES,
  DEAD_AFTER,
  NOTICE_BACKOFF_MAX_MS,
  NOTICE_POLL_MS,
  Notifier,
  ROUND_EVENTS,
  ROUND_SENDS,
} from '../src/kanban/notices.js';
import { KanbanService } from '../src/kanban/service.js';
import type { CreatedVia, TaskRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { ALICE, WORKSPACES } from './helpers/kanban.js';

/**
 * Subscriptions' notices (spec §9.4): one message per conversation a round, in
 * event order, the cursors moved once it is sent; at least once, with one uuid
 * per batch; a conversation that cannot be reached let go of; and caught up
 * after a restart by the same code.
 */

const VIA: CreatedVia = { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' };
const ELSEWHERE: CreatedVia = { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_other', threadId: '' };
const BROKEN: CreatedVia = { kind: 'chat', channel: 'broken', appId: 'cli_app', conversationId: 'oc_other', threadId: '' };

let t: TestDb;
let clock: ManualClock;
let service: KanbanService;
let lark: FakeChannel;
let notes: string[];

beforeEach(() => {
  clearSecrets();
  t = testDb();
  clock = new ManualClock();
  service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock,
  });
  lark = new FakeChannel({ id: 'lark', clock });
  notes = [];
});
afterEach(() => {
  clearSecrets();
  t.close();
});

function notifier(opts: { appId?: string; channels?: ReadonlyMap<string, Channel>; sendTimeoutMs?: number } = {}): Notifier {
  return new Notifier({
    ...(opts.sendTimeoutMs === undefined ? {} : { sendTimeoutMs: opts.sendTimeoutMs }),
    db: t.db,
    service,
    channels: opts.channels ?? new Map([['lark', lark]]),
    appId: opts.appId ?? 'cli_app',
    blockRecurrenceLimit: 2,
    clock,
    note: (line) => notes.push(line),
  });
}

function create(title: string, via: CreatedVia = VIA): TaskRow {
  const r = service.create({ title, assignee: 'implementer', createdBy: ALICE, createdVia: via });
  if (!r.ok) throw new Error(r.message);
  return r.task;
}

async function done(task: TaskRow, summary: string): Promise<void> {
  const r = await service.complete(task.taskId, { kind: 'person', principal: ALICE }, { summary });
  if (!r.ok) throw new Error(r.message);
}

function eventId(task: TaskRow, kind: string): number {
  return eventsOf(t.db, task.taskId).find((e) => e.kind === kind)?.id ?? 0;
}

function subId(task: TaskRow): number {
  return subscriptionsOf(t.db, task.taskId)[0]?.id ?? 0;
}

describe('the notifier', () => {
  it("sends a conversation one message a round, its subscriptions' notices in event order, passing over the rest", async () => {
    const a = create('Draft the notes');
    const b = create('Check the links');
    expect(service.comment(a.taskId, 'first draft by Friday', ALICE, { steers: true }).ok).toBe(true);
    expect(service.block(b.taskId, { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason: 'which wiki?' }).ok).toBe(true);
    await done(a, 'merged');
    const n = notifier();

    expect(await n.deliver()).toBe(2);
    expect(lark.texts).toHaveLength(1);
    expect(lark.texts[0]?.target).toEqual({ chatId: 'oc_team', threadId: 'omt_topic' });
    expect(lark.texts[0]?.text.split('\n\n')).toEqual([
      `Blocked (needs\\_input) — **Check the links** \`${b.taskId}\`: which wiki?\n\`/kanban unblock ${b.taskId} [comment]\` once it can go on.`,
      `Done — **Draft the notes** \`${a.taskId}\`:\n> merged`,
    ]);
    expect(lark.texts[0]?.uuid).toBe(
      noticeBatchUuid('cli_app', [
        [subId(b), eventId(b, 'blocked')],
        [subId(a), eventId(a, 'completed')],
      ]),
    );
    // Every event, a notice or not, is behind its cursor now.
    expect(subscriptionsOf(t.db, a.taskId)[0]?.cursor).toBe(eventsOf(t.db, a.taskId).at(-1)?.id);
    expect(subscriptionsOf(t.db, b.taskId)[0]?.cursor).toBe(eventsOf(t.db, b.taskId).at(-1)?.id);
    expect(await n.deliver()).toBe(0);
    expect(lark.texts).toHaveLength(1);
  });

  it('sends at most a batch of notices a message, says more follow, and sends them in the next round', async () => {
    const tasks = Array.from({ length: BATCH_NOTICES + 3 }, (_, i) => create(`task ${i}`));
    for (const task of tasks) await done(task, 'ok');
    const n = notifier();
    expect(await n.deliver()).toBe(BATCH_NOTICES);
    const first = lark.texts[0]?.text.split('\n\n') ?? [];
    expect(first).toHaveLength(BATCH_NOTICES + 1);
    expect(first.at(-1)).toBe('… and 3 more, in the next message.');
    // The cursors moved past what was sent, and no further.
    const last = tasks.at(-1);
    if (last === undefined) throw new Error('no tasks');
    expect(subscriptionsOf(t.db, last.taskId)[0]?.cursor).toBeLessThan(eventId(last, 'completed'));
    expect(await n.deliver()).toBe(3);
    expect(lark.texts[1]?.text.split('\n\n')).toHaveLength(3);
    expect(await n.deliver()).toBe(0);
  });

  it('sends each conversation its own message', async () => {
    await done(create('Here'), 'ok');
    await done(create('There', ELSEWHERE), 'ok');
    expect(await notifier().deliver()).toBe(2);
    expect(lark.texts.map((m) => m.target.chatId).sort()).toEqual(['oc_other', 'oc_team']);
  });

  it("tells the chat following a task about the tasks that task's runs create", async () => {
    const parent = create('Plan the launch');
    const claimed = service.claim(parent.taskId);
    if (!claimed.ok) throw new Error(claimed.message);
    const child = service.create({
      title: 'Book the room',
      assignee: 'implementer',
      createdBy: `run:${claimed.run.runId}`,
      createdVia: { kind: 'run', runId: claimed.run.runId },
    });
    if (!child.ok) throw new Error(child.message);
    expect(service.stop(parent.taskId, ALICE).ok).toBe(true);
    expect(service.closeRun(claimed.run.runId).ok).toBe(true);
    await done(child.task, 'booked');
    await notifier().deliver();
    expect(lark.texts.map((m) => m.text.split('\n\n').map((n) => n.split('\n')[0]))).toEqual([
      [
        `Blocked (needs\\_input) — **Plan the launch** \`${parent.taskId}\`: stopped by lark:on\\_alice`,
        `Done — **Book the room** \`${child.task.taskId}\`:`,
      ],
    ]);
  });

  it('keeps the cursors where they are when a send fails, and tries again after a pause, sending once', async () => {
    const a = create('Draft the notes');
    await done(a, 'merged');
    const n = notifier();
    lark.failNext('sendText', new ChannelError(99991400, 'rate limited', true));
    expect(await n.deliver()).toBe(0);
    expect(notes.at(-1)).toBe(
      `kanban: notices for oc_team/omt_topic (task ${a.taskId}) were not sent (rate limited (code 99991400)); trying again in 2 s`,
    );
    expect(subscriptionsOf(t.db, a.taskId)[0]?.cursor).toBe(0);
    // Held back until the pause is over.
    expect(await n.deliver()).toBe(0);
    clock.advance(NOTICE_POLL_MS);
    expect(await n.deliver()).toBe(1);
    expect(lark.texts).toHaveLength(1);
    expect(await n.deliver()).toBe(0);
  });

  it('holds a conversation back on a network failure, which Lark reports as code 0 and not retryable, and sends once later', async () => {
    const a = create('Draft the notes');
    await done(a, 'merged');
    const n = notifier();
    lark.failNext('sendText', new ChannelError(0, 'socket hang up', false));
    expect(await n.deliver()).toBe(0);
    expect(notes.at(-1)).toContain('were not sent (socket hang up (code 0)); trying again in 2 s');
    expect(notes.some((l) => l.includes('cannot be reached'))).toBe(false);
    clock.advance(NOTICE_POLL_MS);
    expect(await n.deliver()).toBe(1);
    expect(lark.texts).toHaveLength(1);
  });

  it('counts a send that never answers as failed, and sends the batch again later with the same uuid', async () => {
    const a = create('Draft the notes');
    await done(a, 'merged');
    const n = notifier({ sendTimeoutMs: 20 });
    lark.hold();
    expect(await n.deliver()).toBe(0);
    expect(notes.at(-1)).toContain('were not sent (the send took longer than 20 ms)');
    expect(subscriptionsOf(t.db, a.taskId)[0]?.cursor).toBe(0);
    // The slow send lands after all; the batch goes again, as at least once allows, with its uuid.
    lark.release();
    clock.advance(NOTICE_POLL_MS);
    expect(await n.deliver()).toBe(1);
    expect(lark.texts).toHaveLength(2);
    expect(lark.texts[1]?.uuid).toBe(lark.texts[0]?.uuid);
    expect(await n.idle(10)).toBe(true);
  });

  it('says it has not finished while a send is held, and that it has once the round is over', async () => {
    await done(create('Draft the notes'), 'merged');
    const n = notifier();
    lark.hold();
    const round = n.deliver();
    expect(await n.idle(10)).toBe(false);
    lark.release();
    expect(await round).toBe(1);
    expect(await n.idle(10)).toBe(true);
  });

  it(`sends to at most ${ROUND_SENDS} conversations a round, the longest waiting first`, async () => {
    const chats = Array.from({ length: ROUND_SENDS + 2 }, (_, i) => `oc_chat_${String(i).padStart(2, '0')}`);
    // Completed newest chat first, so the oldest pending event is the last chat's.
    const tasks = chats.map((chat) => create(`for ${chat}`, { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: chat, threadId: '' }));
    for (const task of [...tasks].reverse()) await done(task, 'ok');
    const n = notifier();
    expect(await n.deliver()).toBe(ROUND_SENDS);
    // Every task's oldest pending event is its creation, so the first created waits longest.
    expect(lark.texts.map((m) => m.target.chatId)).toEqual(chats.slice(0, ROUND_SENDS));
    expect(await n.deliver()).toBe(2);
    expect(lark.texts.slice(ROUND_SENDS).map((m) => m.target.chatId)).toEqual(chats.slice(ROUND_SENDS));
  });

  it(`keeps event order when a subscription has more than ${ROUND_EVENTS} events to read`, async () => {
    const a = create('Long thread');
    const b = create('Short one');
    for (let i = 0; i < ROUND_EVENTS + 20; i += 1) expect(service.comment(a.taskId, `note ${i}`, ALICE, { steers: true }).ok).toBe(true);
    expect(service.block(a.taskId, { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason: 'which one?' }).ok).toBe(true);
    await done(b, 'quick');
    const n = notifier();
    // The first round reads only a's first ROUND_EVENTS, none a notice, and so holds b's later one back.
    expect(await n.deliver()).toBe(0);
    expect(await n.deliver()).toBe(2);
    expect(lark.texts.map((m) => m.text.split('\n\n').map((x) => x.split(' — ')[0]))).toEqual([['Blocked (needs\\_input)', 'Done']]);
  });

  it('lets go of a conversation a send refuses as unreachable: its notices dropped, said once, the rest passed over until a restart', async () => {
    const a = create('Draft the notes');
    const b = create('Check the links');
    const elsewhere = create('Elsewhere', ELSEWHERE);
    await done(a, 'merged');
    await done(b, 'checked');
    await done(elsewhere, 'ok');
    // The team's thread is the first sent to: its subscriptions are the oldest.
    lark.failNext('sendText', new ChannelError(230002, 'the bot is not in the chat', false));
    const n = notifier();
    expect(await n.deliver()).toBe(1);
    expect(lark.texts.map((m) => m.target.chatId)).toEqual(['oc_other']);
    const dropped = notes.filter((l) => l.includes('cannot be reached'));
    expect(dropped).toEqual([
      `kanban: oc_team/omt_topic (tasks ${a.taskId}, ${b.taskId}) cannot be reached (the bot is not in the chat (code 230002)); ` +
        `dropping 2 notice(s) (${a.taskId}#${eventId(a, 'completed')}, ${b.taskId}#${eventId(b, 'completed')}) ` +
        'and passing over its notices until the gateway restarts',
    ]);
    // Later notices are passed over without a send, or another line.
    await done(create('Another'), 'ok');
    expect(await n.deliver()).toBe(0);
    expect(notes.filter((l) => l.includes('cannot be reached'))).toHaveLength(1);
    expect(dueSubscriptions(t.db, 'cli_app')).toEqual([]);
    // A restart tries the conversation again.
    await done(create('After the restart'), 'ok');
    expect(await notifier().deliver()).toBe(1);
    expect(lark.texts.at(-1)?.target.chatId).toBe('oc_team');
  });

  it(`lets go of a conversation whose sends fail ${DEAD_AFTER} times in a row at the longest pause`, async () => {
    const a = create('Draft the notes');
    await done(a, 'merged');
    const n = notifier();
    let failures = 0;
    for (;;) {
      lark.failNext('sendText', new ChannelError(99991400, 'rate limited', true));
      await n.deliver();
      failures += 1;
      if (notes.some((l) => l.includes('cannot be reached'))) break;
      expect(subscriptionsOf(t.db, a.taskId)[0]?.cursor).toBe(0);
      clock.advance(NOTICE_BACKOFF_MAX_MS);
      if (failures > 20) throw new Error('never let go');
    }
    // Eight pauses of 2 s to 256 s, then DEAD_AFTER failures at five minutes, the last letting it go.
    expect(failures).toBe(8 + DEAD_AFTER);
    expect(subscriptionsOf(t.db, a.taskId)[0]?.cursor).toBe(eventsOf(t.db, a.taskId).at(-1)?.id);
  });

  it('never lets go of a conversation for network failures, however many, and catches up from its cursors once a send succeeds', async () => {
    const a = create('Draft the notes');
    await done(a, 'merged');
    const n = notifier();
    for (let i = 0; i < 20; i += 1) {
      lark.failNext('sendText', new ChannelError(0, 'socket hang up', false));
      expect(await n.deliver()).toBe(0);
      expect(subscriptionsOf(t.db, a.taskId)[0]?.cursor).toBe(0);
      clock.advance(NOTICE_BACKOFF_MAX_MS);
    }
    expect(notes.some((l) => l.includes('cannot be reached'))).toBe(false);
    // What happened during the outage is told too, in the same message.
    const b = create('Check the links');
    await done(b, 'checked');
    expect(await n.deliver()).toBe(2);
    expect(lark.texts).toHaveLength(1);
    expect(await n.deliver()).toBe(0);
    expect(lark.texts).toHaveLength(1);
  });

  it('never lets go of a conversation for sends that time out, however many, and catches up from its cursors once one succeeds', async () => {
    const a = create('Draft the notes');
    await done(a, 'merged');
    const n = notifier({ sendTimeoutMs: 5 });
    let hung = 20;
    const send = lark.sendText.bind(lark);
    vi.spyOn(lark, 'sendText').mockImplementation((target, text, uuid) => {
      if (hung <= 0) return send(target, text, uuid);
      hung -= 1;
      return new Promise(() => undefined);
    });
    for (let i = 0; i < 20; i += 1) {
      expect(await n.deliver()).toBe(0);
      expect(subscriptionsOf(t.db, a.taskId)[0]?.cursor).toBe(0);
      clock.advance(NOTICE_BACKOFF_MAX_MS);
    }
    expect(notes.filter((l) => l.includes('the send took longer than 5 ms'))).toHaveLength(20);
    expect(notes.some((l) => l.includes('cannot be reached'))).toBe(false);
    const b = create('Check the links');
    await done(b, 'checked');
    expect(await n.deliver()).toBe(2);
    expect(lark.texts).toHaveLength(1);
    expect(await n.deliver()).toBe(0);
    expect(lark.texts).toHaveLength(1);
  });

  it('keeps one subscription whose task is gone, or one conversation that throws, from holding up the rest', async () => {
    const a = create('Draft the notes');
    await done(a, 'merged');
    // A subscription whose task is not on the board, in the same conversation.
    const goneEvent = (): number => {
      t.db.pragma('foreign_keys = OFF');
      const id = Number(
        t.db
          .prepare(
            `INSERT INTO kanban_events (task_id, kind, actor, payload, created_at) VALUES ('k_gone', 'stranded', 'gateway', jsonb('{}'), 0)`,
          )
          .run().lastInsertRowid,
      );
      t.db.pragma('foreign_keys = ON');
      return id;
    };
    t.db.pragma('foreign_keys = OFF');
    t.db
      .prepare(
        `INSERT INTO kanban_subscriptions (task_id, channel, account_id, conversation_id, thread_id, created_at)
         VALUES ('k_gone', 'lark', 'cli_app', 'oc_team', 'omt_topic', 0)`,
      )
      .run();
    t.db.pragma('foreign_keys = ON');
    const first = goneEvent();
    // And a conversation on a channel whose lookup throws.
    const broken = create('On a broken channel', BROKEN);
    await done(broken, 'ok');
    const channels = new Map<string, Channel>([['lark', lark]]);
    const get = channels.get.bind(channels);
    channels.get = (id: string) => {
      if (id === 'broken') throw new Error('the channel table is broken');
      return get(id);
    };
    expect(await notifier({ channels }).deliver()).toBe(1);
    expect(lark.texts.map((m) => m.text.split('\n')[0])).toEqual([`Done — **Draft the notes** \`${a.taskId}\`:`]);
    // The gone task's subscription is let go of by itself, past what it held, said once.
    const gone = 'kanban: subscription 2 follows task k_gone, which is not on the board; passing over its events until the gateway restarts';
    expect(notes).toContain(gone);
    expect(subscriptionsOf(t.db, 'k_gone')[0]?.cursor).toBe(first);
    expect(notes).toContain(
      `kanban: notices for oc_other (task ${broken.taskId}) were not sent (the channel table is broken); trying again in 2 s`,
    );
    // Its later events are passed over without another line; its neighbours go on.
    const later = goneEvent();
    await done(create('Check the links'), 'checked');
    clock.advance(NOTICE_POLL_MS * 2);
    expect(await notifier({ channels }).deliver()).toBeGreaterThanOrEqual(1);
    expect(subscriptionsOf(t.db, 'k_gone')[0]?.cursor).toBe(later);
    expect(notes.filter((l) => l === gone)).toHaveLength(2);
    const n = notifier({ channels });
    goneEvent();
    await n.deliver();
    const last = goneEvent();
    await n.deliver();
    expect(subscriptionsOf(t.db, 'k_gone')[0]?.cursor).toBe(last);
    expect(notes.filter((l) => l === gone)).toHaveLength(3);
  });

  it('lets go of a conversation on a channel this gateway has not got, past what it held, said once', async () => {
    const a = create('On a channel not here', BROKEN);
    await done(a, 'ok');
    await done(create('Here'), 'ok');
    const n = notifier();
    expect(await n.deliver()).toBe(1);
    expect(lark.texts.map((m) => m.target.chatId)).toEqual(['oc_team']);
    const line =
      `kanban: oc_other (task ${a.taskId}) cannot be reached (no channel broken); dropping 1 notice(s) ` +
      `(${a.taskId}#${eventId(a, 'completed')}) and passing over its notices until the gateway restarts`;
    expect(notes).toEqual([line]);
    expect(subscriptionsOf(t.db, a.taskId)[0]?.cursor).toBe(eventsOf(t.db, a.taskId).at(-1)?.id);
    // Later notices are passed over, without another line.
    const b = create('Another not here', BROKEN);
    await done(b, 'ok');
    clock.advance(NOTICE_BACKOFF_MAX_MS);
    expect(await n.deliver()).toBe(0);
    expect(notes).toEqual([line]);
    expect(dueSubscriptions(t.db, 'cli_app')).toEqual([]);
  });

  it('says a batch was sent when a cursor then fails to move, moves the others, and sends that one again later', async () => {
    const a = create('Draft the notes');
    const b = create('Check the links');
    expect(service.block(a.taskId, { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason: 'which wiki?' }).ok).toBe(true);
    await done(b, 'checked');
    const advance = service.advanceSubscription.bind(service);
    let failures = 1;
    service.advanceSubscription = (id: number, cursor: number) => {
      if (id === subId(a) && failures > 0) {
        failures -= 1;
        throw new Error('disk I/O error');
      }
      return advance(id, cursor);
    };
    const n = notifier();
    expect(await n.deliver()).toBe(2);
    expect(notes).toEqual([
      `kanban: notices for subscription ${subId(a)} of task ${a.taskId} sent; cursor not moved (disk I/O error); trying again in 2 s`,
    ]);
    expect(subscriptionsOf(t.db, a.taskId)[0]?.cursor).toBe(0);
    expect(subscriptionsOf(t.db, b.taskId)[0]?.cursor).toBe(eventsOf(t.db, b.taskId).at(-1)?.id);
    // Held back for its pause, then sent again: at least once.
    expect(await n.deliver()).toBe(0);
    clock.advance(2_000);
    expect(await n.deliver()).toBe(1);
    expect(lark.texts.at(-1)?.text).toContain(`Blocked (needs\\_input) — **Draft the notes** \`${a.taskId}\`: which wiki?`);
    expect(subscriptionsOf(t.db, a.taskId)[0]?.cursor).toBe(eventsOf(t.db, a.taskId).at(-1)?.id);
    // Its pause starts over after a success: a later failure waits 2 s, not 4.
    failures = 1;
    expect(service.unblock(a.taskId, ALICE, 'the team wiki').ok).toBe(true);
    await done(a, 'merged');
    expect(await n.deliver()).toBe(1);
    expect(notes.at(-1)).toBe(
      `kanban: notices for subscription ${subId(a)} of task ${a.taskId} sent; cursor not moved (disk I/O error); trying again in 2 s`,
    );
  });

  it('catches up after a restart from the cursors, sending again only what was not marked sent, with the same uuid', async () => {
    const a = create('Draft the notes');
    await done(a, 'merged');
    expect(await notifier().deliver()).toBe(1);
    // A new process: nothing is sent twice that was marked sent.
    expect(await notifier().deliver()).toBe(0);
    // One that stopped after the send and before its cursors moved.
    t.db.prepare('UPDATE kanban_subscriptions SET cursor = 0').run();
    expect(await notifier().deliver()).toBe(1);
    expect(lark.texts).toHaveLength(2);
    expect(lark.texts[1]?.uuid).toBe(lark.texts[0]?.uuid);
  });

  it("runs one round at a time, delivers only this bot's subscriptions, and masks what it sends", async () => {
    addSecrets(['sk-notice-12345678']);
    const mine = create('Rotate the key');
    const theirs = create('Elsewhere', { kind: 'chat', channel: 'lark', appId: 'cli_other', conversationId: 'oc_team', threadId: '' });
    await done(mine, 'rotated, old one was sk-notice-12345678');
    await done(theirs, 'done');
    const n = notifier();
    const [first, second] = await Promise.all([n.deliver(), n.deliver()]);
    expect([first, second]).toEqual([1, 1]);
    expect(lark.texts).toHaveLength(1);
    expect(lark.texts[0]?.text).toContain(`old one was ${MASK}`);
    expect(lark.texts[0]?.text).not.toContain('sk-notice');
  });

  it('sends nothing once stopped, and idle waits for the round under way', async () => {
    const a = create('Draft the notes');
    await done(a, 'merged');
    const n = notifier();
    lark.hold();
    const round = n.deliver();
    n.stop();
    lark.release();
    await n.idle();
    expect(await round).toBe(1);
    expect(await n.deliver()).toBe(0);
    await done(create('Another'), 'ok');
    expect(await n.deliver()).toBe(0);
    expect(lark.texts).toHaveLength(1);
  });
});
