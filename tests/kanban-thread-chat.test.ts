import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTask, subscriptionsOf } from '../src/db/kanban-read.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import type { BindingKey, InboundMention, InboundMessage, Principal } from '../src/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { WORKSPACES } from './helpers/kanban.js';

/**
 * `/kanban task new` in a group (spec §19.1, §19.4, §19.5): a fresh task at chat
 * scope is answered for a thread of its own, in both wordings, and held until the
 * router says where its reply went; every other task is answered as before, and
 * held by nothing.
 */

const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const AT_ALICE: InboundMention = { key: '@_user_1', name: 'Alice Smith', openId: 'ou_alice', unionId: 'on_alice' };
const TEAM: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: '' };
const TOPIC: BindingKey = { ...TEAM, threadId: 'omt_topic' };
const HEARS = 'hears when it is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.';

let t: TestDb;
let people: PeopleDirectory;
let service: KanbanService;
/** Whether the newest task was held when the dispatcher was told of it, at each time it was. */
let heldAtPass: boolean[];
let seq = 0;

function newest(): string {
  return t.db.prepare<[], { task_id: string }>('SELECT task_id FROM kanban_tasks ORDER BY rowid DESC LIMIT 1').get()?.task_id ?? '';
}

function chat(holdMs?: number): KanbanChat {
  const c: KanbanChat = new KanbanChat({
    service,
    hasTier: () => true,
    people,
    appId: 'cli_app',
    changed: () => heldAtPass.push(c.held(newest())),
    ...(holdMs === undefined ? {} : { holdMs }),
  });
  return c;
}

beforeEach(() => {
  t = testDb();
  const authorizer = new Authorizer({ ...defaultAuthConfig(OWNER.openId), allowTalk: [OWNER.openId, 'ou_alice'] });
  people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }) });
  service = new KanbanService({ db: t.db, roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])), workspaces: WORKSPACES, people });
  heldAtPass = [];
});
afterEach(() => t.close());

function message(key: BindingKey, over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: `om_${++seq}`,
    appId: 'cli_app',
    chatId: key.conversationId,
    chatType: 'group',
    threadId: key.threadId,
    sender: OWNER,
    senderIsBot: false,
    text: '',
    mentionedBot: true,
    mentionAll: false,
    mentions: [AT_ALICE],
    attachments: [],
    createTime: 0,
    ...over,
  };
}

function idOf(text: string): string {
  const m = /^Created `(k_[0-9a-z]+)`/.exec(text);
  if (m?.[1] === undefined) throw new Error(`not created: ${text}`);
  return m[1];
}

const FOR_ALICE = 'task new Check the links\nassignee: @Alice Smith';

describe("/kanban task new in a group, for a thread of its own", () => {
  it('answers a fresh task at chat scope in the words of its thread, with the quoted words beside them, naming the task', async () => {
    const answer = await chat().run(FOR_ALICE, message(TEAM), TEAM);
    const taskId = idOf(answer.text);
    const head = `Created \`${taskId}\`: **Check the links**, for Alice Smith (lark:on\\_alice).`;
    expect(answer).toEqual({
      text: `${head} Their card comes in this thread when it is ready, or by direct message if they are not in this group. This thread ${HEARS}`,
      quoted: `${head} They are sent it as a card, in a direct message, once it is ready. This chat ${HEARS}`,
      thread: taskId,
    });
  });

  it("answers a task in a thread with a root in the thread's words, and one in a direct message, in a thread with no root, or already created, as before, with no thread", async () => {
    const c = chat();
    const inTopic = await c.run(FOR_ALICE, message(TOPIC, { rootId: 'om_root' }), TOPIC);
    expect(inTopic.text).toContain('Their card comes in this thread when it is ready');
    expect(inTopic).not.toHaveProperty('thread');
    const dm = await c.run(FOR_ALICE, message(TEAM, { chatType: 'p2p' }), TEAM);
    expect(dm).toEqual({ text: expect.stringContaining(`in a direct message, once it is ready. This chat ${HEARS}`) as string });
    const rootless = await c.run(FOR_ALICE, message(TOPIC), TOPIC);
    expect(rootless.text).toContain('They are sent it as a card, in a direct message');
    const again = message(TEAM);
    const first = await c.run(FOR_ALICE, again, TEAM);
    expect(await c.run(FOR_ALICE, again, TEAM)).toEqual({ text: `Already created, as \`${idOf(first.text)}\`.` });
  });
});

describe('the hold on a task whose thread is being made (spec §19.4)', () => {
  it('holds a fresh task from a group at chat scope from before the dispatcher is told of it, until its subscription moves', async () => {
    const c = chat();
    const msg = message(TEAM);
    const answer = await c.run(FOR_ALICE, msg, TEAM);
    const taskId = answer.thread ?? '';
    expect(heldAtPass).toEqual([true]);
    expect(c.held(taskId)).toBe(true);
    c.threaded(taskId, TEAM, msg.messageId, 'omt_new');
    expect(c.held(taskId)).toBe(false);
    expect(subscriptionsOf(t.db, taskId).map((s) => [s.threadId, s.rootMessageId])).toEqual([['omt_new', msg.messageId]]);
  });

  it('ends the hold when no thread came back, leaving the task at chat scope; lapses by itself; and a move after it lapsed still applies', async () => {
    const c = chat(20);
    const failed = (await c.run(FOR_ALICE, message(TEAM), TEAM)).thread ?? '';
    c.threaded(failed, TEAM, 'om_x', undefined);
    expect(c.held(failed)).toBe(false);
    expect(subscriptionsOf(t.db, failed).map((s) => [s.threadId, s.rootMessageId])).toEqual([['', null]]);
    const msg = message(TEAM);
    const late = (await c.run(FOR_ALICE, msg, TEAM)).thread ?? '';
    expect(c.held(late)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(c.held(late)).toBe(false);
    c.threaded(late, TEAM, msg.messageId, 'omt_late');
    expect(subscriptionsOf(t.db, late).map((s) => [s.threadId, s.rootMessageId])).toEqual([['omt_late', msg.messageId]]);
  });

  it('holds no task that gets no thread: one in a direct message, in a thread, or already created', async () => {
    const c = chat();
    await c.run(FOR_ALICE, message(TEAM, { chatType: 'p2p' }), TEAM);
    await c.run(FOR_ALICE, message(TOPIC, { rootId: 'om_root' }), TOPIC);
    expect(heldAtPass).toEqual([false, false]);
    const again = message(TEAM);
    const taskId = (await c.run(FOR_ALICE, again, TEAM)).thread ?? '';
    c.threaded(taskId, TEAM, again.messageId, undefined);
    expect((await c.run(FOR_ALICE, again, TEAM)).thread).toBeUndefined();
    expect(c.held(taskId)).toBe(false);
  });

  it('ends the hold when the reply cannot be rendered after the create, which stands, at chat scope', async () => {
    const c = chat();
    people.nameOf = () => {
      throw new Error('the people table is locked');
    };
    await expect(c.run(FOR_ALICE, message(TEAM), TEAM)).rejects.toThrow('the people table is locked');
    const taskId = newest();
    expect(heldAtPass).toEqual([true]);
    expect(c.held(taskId)).toBe(false);
    expect(getTask(t.db, taskId)?.title).toBe('Check the links');
    expect(subscriptionsOf(t.db, taskId).map((s) => s.threadId)).toEqual(['']);
  });
});
