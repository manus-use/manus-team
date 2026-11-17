import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SendTarget } from '../src/channel/types.js';
import { noticeBatchUuid } from '../src/core/ids.js';
import { eventsOf, subscriptionsOf } from '../src/db/kanban-read.js';
import { notePerson } from '../src/db/people.js';
import { CardPoster } from '../src/kanban/cards.js';
import { renderNotice } from '../src/kanban/chat-render.js';
import { Notifier } from '../src/kanban/notices.js';
import { KanbanService } from '../src/kanban/service.js';
import type { CreatedVia, Follow, KanbanEvent, TaskRow } from '../src/kanban/types.js';
import { clearSecrets } from '../src/secrets.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * A chat that follows a terminal's task (kanban spec §22.1): `follow`, which
 * `subscribe()` writes in the task's transaction for this bot, at chat scope or
 * in a thread with its root; refused from chat and from a run; a repeat by key
 * adding nothing; and its "Created" line, `task_created_followed`, which the
 * notifier sends before the task's other notices.
 */

const OPERATOR: CreatedVia = { kind: 'operator' };
const BY = 'operator:alice';
const CHAT: Follow = { appId: 'cli_app', chatId: 'oc_team', threadId: '', rootId: null };
const THREAD: Follow = { appId: 'cli_app', chatId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' };
const ALICE = 'lark:on_alice';

let t: TestDb;
let clock: ManualClock;
let service: KanbanService;
let lark: FakeChannel;

beforeEach(() => {
  clearSecrets();
  t = testDb();
  clock = new ManualClock();
  service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock,
    people: { canTalk: (p) => p === ALICE },
  });
  lark = new FakeChannel({ id: 'lark', clock });
});
afterEach(() => {
  clearSecrets();
  t.close();
});

function create(follow: Follow | undefined, extra: Partial<Parameters<KanbanService['create']>[0]> = {}) {
  return service.create({ title: 'Book the venue', assignee: 'implementer', createdBy: BY, createdVia: OPERATOR, ...(follow === undefined ? {} : { follow }), ...extra });
}

function made(follow: Follow | undefined, extra: Partial<Parameters<KanbanService['create']>[0]> = {}): TaskRow {
  const r = create(follow, extra);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.task;
}

function notifier(): Notifier {
  return new Notifier({ db: t.db, service, channels: new Map([['lark', lark]]), appId: 'cli_app', blockRecurrenceLimit: 2, clock, note: () => undefined });
}

describe('follow', () => {
  it("is the new task's one subscription, for this bot, at chat scope, with the task's creator and createdVia unchanged", () => {
    const task = made(CHAT);
    expect(task).toMatchObject({ createdBy: BY, createdVia: OPERATOR });
    expect(subscriptionsOf(t.db, task.taskId)).toEqual([
      expect.objectContaining({ channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: '', rootMessageId: null, cursor: 0 }),
    ]);
    expect(subscriptionsOf(t.db, made(undefined).taskId)).toEqual([]);
  });

  it('is written in a thread with its root, and nothing at all when the task is refused', () => {
    const task = made(THREAD);
    expect(subscriptionsOf(t.db, task.taskId)).toEqual([expect.objectContaining({ conversationId: 'oc_team', threadId: 'omt_topic', rootMessageId: 'om_root' })]);
    const before = t.db.prepare('SELECT count(*) AS n FROM kanban_subscriptions').get();
    expect(create(CHAT, { parents: ['k_nope'] })).toMatchObject({ ok: false, code: 'not_found' });
    expect(t.db.prepare('SELECT count(*) AS n FROM kanban_subscriptions').get()).toEqual(before);
  });

  it('is refused from chat and from a run, and in any shape but Lark\'s', () => {
    const run = service.claim(made(undefined).taskId);
    if (!run.ok) throw new Error(run.message);
    for (const via of [VIA, { kind: 'run', runId: run.run.runId } as const]) {
      expect(service.create({ title: 'x', createdBy: BY, createdVia: via, follow: CHAT })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/^only the terminal names a chat/) });
    }
    const bad: unknown[] = [
      { ...CHAT, chatId: 'team' },
      { ...CHAT, appId: '' },
      { ...CHAT, threadId: 'topic', rootId: 'om_root' },
      { ...THREAD, rootId: null },
      { ...CHAT, rootId: 'om_root' },
      'oc_team',
    ];
    for (const follow of bad) expect(create(follow as Follow), JSON.stringify(follow)).toMatchObject({ ok: false, code: 'invalid' });
    expect(t.db.prepare('SELECT count(*) AS n FROM kanban_subscriptions').get()).toEqual({ n: 0 });
  });

  it("writes one task_created_followed after created, by the creator, and none without a follow", () => {
    const task = made(CHAT);
    const events = eventsOf(t.db, task.taskId);
    expect(events.map((e) => e.kind)).toEqual(['created', 'task_created_followed']);
    expect(events[1]).toMatchObject({ actor: BY, payload: { by: BY } });
    expect(eventsOf(t.db, made(undefined).taskId).map((e) => e.kind)).toEqual(['created']);
  });

  it('answers a key repeated with another chat with the first task, adding no subscription and no event', () => {
    const first = create(CHAT, { idempotencyKey: 'weekly' });
    const again = create({ ...CHAT, chatId: 'oc_other' }, { idempotencyKey: 'weekly' });
    expect(again).toMatchObject({ ok: true, existing: true, task: { taskId: first.ok ? first.task.taskId : '' } });
    const id = first.ok ? first.task.taskId : '';
    expect(subscriptionsOf(t.db, id).map((s) => s.conversationId)).toEqual(['oc_team']);
    expect(eventsOf(t.db, id).map((e) => e.kind)).toEqual(['created', 'task_created_followed']);
  });

  it("finds a thread's root as the notifier does, from a subscription in it", () => {
    const at = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' };
    expect(service.threadRoot(at)).toBeUndefined();
    service.create({ title: 'From chat', createdBy: ALICE, createdVia: { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' } });
    expect(service.threadRoot(at)).toBe('om_root');
    expect(service.threadRoot({ ...at, appId: 'cli_other' })).toBeUndefined();
    expect(service.threadRoot({ ...at, threadId: '' })).toBeUndefined();
  });
});

describe('the "Created" line', () => {
  const task = { taskId: 'k_000000000001', title: 'Book_the venue', assignee: { kind: 'role', name: 'worker' } } as unknown as TaskRow;
  const event = { id: 2, taskId: task.taskId, runId: null, kind: 'task_created_followed', actor: BY, payload: { by: BY }, createdAt: 1 } as KanbanEvent;

  it('names the task, who it is for and who made it, from a terminal', () => {
    const opts = { blockRecurrenceLimit: 2, nameOf: (p: string) => (p === ALICE ? 'Alice Chen' : undefined) };
    expect(renderNotice(event, task, opts)).toBe('Created `k_000000000001` **Book\\_the venue**, for role worker, by operator:alice from a terminal.');
    expect(renderNotice(event, { ...task, assignee: { kind: 'human', name: ALICE } }, opts)).toBe('Created `k_000000000001` **Book\\_the venue**, for Alice Chen, by operator:alice from a terminal.');
    expect(renderNotice(event, { ...task, assignee: null }, opts)).toBe('Created `k_000000000001` **Book\\_the venue**, for nobody yet, by operator:alice from a terminal.');
  });

  it("is sent first, then the task's notices, in the chat's conversation and in the thread's", async () => {
    const chat = made(CHAT);
    const thread = made(THREAD, { title: 'Order the food' });
    const n = notifier();
    expect(await n.deliver()).toBe(2);
    expect(lark.texts.map((x) => [x.target, x.text])).toEqual([
      [{ chatId: 'oc_team', threadId: '' }, `Created \`${chat.taskId}\` **Book the venue**, for role implementer, by operator:alice from a terminal.`],
      [{ chatId: 'oc_team', threadId: 'omt_topic', root: 'om_root' }, `Created \`${thread.taskId}\` **Order the food**, for role implementer, by operator:alice from a terminal.`],
    ]);
    const r = await service.complete(chat.taskId, { kind: 'person', principal: ALICE }, { summary: 'booked' });
    expect(r.ok).toBe(true);
    expect(await n.deliver()).toBe(1);
    expect(lark.texts.at(-1)?.text).toBe(`Done: **Book the venue** \`${chat.taskId}\`\n> booked`);
  });

  it('is sent again after a restart with the same uuid', async () => {
    const task = made(CHAT);
    lark.failNext('sendText', new Error('socket hang up'));
    expect(await notifier().deliver()).toBe(0);
    expect(lark.texts).toEqual([]);
    expect(await notifier().deliver()).toBe(1);
    const sub = subscriptionsOf(t.db, task.taskId)[0]?.id ?? 0;
    const created = eventsOf(t.db, task.taskId).find((e) => e.kind === 'task_created_followed')?.id ?? 0;
    expect(lark.texts[0]?.uuid).toBe(noticeBatchUuid('cli_app', [[sub, created]]));
  });
});

describe("a person's card for a task the terminal followed", () => {
  it('goes in the thread to a member, and by direct message from a chat-scope follow', async () => {
    notePerson(t.db, { appId: 'cli_app', unionId: 'on_alice', openId: 'ou_alice', name: 'Alice' }, clock.now());
    lark.members.set('oc_team', ['on_alice']);
    const poster = () => new CardPoster({ db: t.db, service, channel: lark, appId: 'cli_app', clock, note: () => undefined, held: () => false });
    for (const follow of [THREAD, CHAT]) {
      const task = made(follow, { assignee: ALICE });
      expect(service.claim(task.taskId).ok).toBe(true);
      await poster().deliver();
    }
    const dm: SendTarget = { chatId: 'on_alice', threadId: '', receiveIdType: 'union_id' };
    expect(lark.boardCards.map((c) => c.target)).toEqual([{ chatId: 'oc_team', threadId: 'omt_topic', root: 'om_root', stayInThread: true }, dm]);
  });
});
