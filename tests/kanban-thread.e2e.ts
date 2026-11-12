import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelError, type CardView, type Channel, type SendTarget } from '../src/channel/types.js';
import { SessionRegistry } from '../src/core/registry.js';
import { Router } from '../src/core/router.js';
import { NamedWorkspaces } from '../src/core/workspace.js';
import { getRun, getTask, subscriptionsOf } from '../src/db/kanban-read.js';
import { notePerson } from '../src/db/people.js';
import type { Driver } from '../src/driver/types.js';
import { CardPoster } from '../src/kanban/cards.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { Dispatcher } from '../src/kanban/dispatcher.js';
import { Notifier } from '../src/kanban/notices.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import { KanbanSink } from '../src/kanban/sink.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import { clearSecrets } from '../src/secrets.js';
import type { InboundMention, InboundMessage, Principal } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { FakeDriver } from './helpers/driver.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role, until } from './helpers/dispatch.js';

/**
 * A task's thread, end to end (spec §19): a task created in a group at chat
 * scope is answered in a thread on its command, through the router and the fake
 * Lark channel; its person's card goes there when they are a member, by direct
 * message when not, and to the thread when a direct message cannot reach them;
 * its notices, its follow-ups' notices and cards, and a supervised agent's
 * approval card all land there; and a task created in a direct message is as it
 * was.
 */

const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const ALICE: Principal = { openId: 'ou_alice', unionId: 'on_alice', displayName: 'Alice Smith' };
const BOB: Principal = { openId: 'ou_bob', unionId: 'on_bob', displayName: 'Bob' };
const AT_ALICE: InboundMention = { key: '@_user_1', name: 'Alice Smith', openId: 'ou_alice', unionId: 'on_alice' };
const AT_BOB: InboundMention = { key: '@_user_2', name: 'Bob', openId: 'ou_bob', unionId: 'on_bob' };

interface Stack {
  t: TestDb;
  lark: FakeChannel;
  router: Router;
  dispatcher: Dispatcher;
  service: KanbanService;
  chat: KanbanChat;
  notifier: Notifier;
  cards: CardPoster;
  registry: SessionRegistry;
  helper: FakeDriver;
  watched: FakeDriver;
  dir: string;
}

let stack: Stack | undefined;
let seq = 0;

beforeEach(() => clearSecrets());
afterEach(async () => {
  clearSecrets();
  if (stack === undefined) return;
  await stack.registry.closeAll();
  await stack.dispatcher.idle(5_000);
  stack.t.close();
  rmSync(stack.dir, { recursive: true, force: true });
  stack = undefined;
});

function build(): Stack {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-thread-e2e-')));
  const workspace = join(dir, 'work');
  mkdirSync(workspace);
  const t = testDb();
  const authorizer = new Authorizer({ ...defaultAuthConfig(OWNER.openId), allowTalk: [OWNER.openId, ALICE.openId, BOB.openId] });
  const people = new PeopleDirectory({
    db: t.db,
    appId: 'cli_app',
    canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }),
  });
  // Both have used the board before, so it knows them, and their open_ids for this bot.
  for (const p of [ALICE, BOB]) notePerson(t.db, { appId: 'cli_app', unionId: p.unionId ?? '', openId: p.openId, name: p.displayName }, Date.now());
  const watchedRole = role('watched');
  const roles = new Map([
    ['helper', role('helper')],
    ['watched', { ...watchedRole, agent: { ...watchedRole.agent, unsupervised: false } }],
  ]);
  const helper = new FakeDriver('helper');
  const watched = new FakeDriver('watched');
  const service = new KanbanService({ db: t.db, roles, workspaces: new Set(['default']), people, supervisedRoles: true });
  const lark = new FakeChannel({ id: 'lark' });
  // Alice and the owner are in the team's group; Bob is not.
  lark.members.set('oc_team', ['on_owner', 'on_alice']);
  const drivers = new Map<string, Driver>([
    ['default', new FakeDriver()],
    ['helper', helper],
    ['watched', watched],
  ]);
  let dispatcher: Dispatcher | undefined;
  const registry = new SessionRegistry({
    db: t.db,
    drivers,
    channels: new Map<string, Channel>([
      ['lark', lark],
      ['kanban', new KanbanSink(undefined, { db: t.db, channels: new Map<string, Channel>([['lark', lark]]), appId: 'cli_app' })],
    ]),
    envFor: (sessionId) => dispatcher?.envFor(sessionId),
    argsFor: (sessionId) => dispatcher?.argsFor(sessionId),
    pinned: (sessionId) => dispatcher?.pinned(sessionId) ?? false,
    workspaces: new NamedWorkspaces(new Map([['default', workspace]])),
    appId: 'cli_app',
    maxLive: 4,
  });
  dispatcher = new Dispatcher({
    db: t.db,
    service,
    sessions: registry,
    roles,
    appId: 'cli_app',
    settings: { maxRunning: 2, defaultMaxRuntimeS: 600, strandedAfterS: 1800, sweepIntervalS: 60, nudgeLimit: 0 },
  });
  const d = dispatcher;
  const chat = new KanbanChat({
    service,
    hasTier: (principal, tier) => authorizer.hasTier(principal, tier),
    people,
    appId: 'cli_app',
    redraw: (messageId, view) => lark.updateCard(messageId, view),
    changed: () => d.pass(),
    cancel: (runId) => {
      d.cancel(runId);
    },
  });
  const router = new Router({ db: t.db, registry, authorizer, channel: lark, channelId: 'lark', appId: 'cli_app', kanban: chat });
  const nameOf = (principal: string) => people.nameOf(principal);
  stack = {
    t,
    lark,
    router,
    dispatcher,
    service,
    chat,
    notifier: new Notifier({ db: t.db, service, channels: new Map([['lark', lark]]), appId: 'cli_app', blockRecurrenceLimit: 2, nameOf }),
    cards: new CardPoster({ db: t.db, service, channel: lark, appId: 'cli_app', nameOf, held: (taskId) => chat.held(taskId) }),
    registry,
    helper,
    watched,
    dir,
  };
  return stack;
}

/** A message in the team's group, at chat scope, mentioning the bot and whoever else. */
function inGroup(text: string, mentions: InboundMention[] = []): InboundMessage {
  return {
    messageId: `om_e2e_${++seq}`,
    appId: 'cli_app',
    chatId: 'oc_team',
    chatType: 'group',
    threadId: '',
    sender: OWNER,
    senderIsBot: false,
    text,
    mentionedBot: true,
    mentionAll: false,
    mentions,
    attachments: [],
    createTime: Date.now(),
  };
}

/** The task a "Created" reply names. */
function createdIn(lark: FakeChannel): string {
  const reply = lark.texts.find((m) => m.text.startsWith('Created'))?.text ?? '';
  const id = /^Created `(k_[0-9a-z]+)`/.exec(reply)?.[1];
  if (id === undefined) throw new Error(`no task created: ${reply}`);
  return id;
}

/** The thread on a command message, as the fake channel answers a reply that opens one. */
function threadOn(message: InboundMessage): SendTarget {
  return { chatId: 'oc_team', threadId: `omt_${message.messageId}`, root: message.messageId };
}

/** Press a card's button as `who`, as Lark's callback gives it, through the router; then wait for the press's work. */
async function press(s: Stack, view: CardView, messageId: string, label: string, who: Principal, input?: string): Promise<void> {
  const button = view.buttons.find((b) => b.label === label);
  if (button === undefined) throw new Error(`no ${label} on the card`);
  await s.router.onCardAction({ chatId: 'oc_team', messageId, operator: who, value: { ...button.value }, ...(input === undefined ? {} : { input }) });
  await s.chat.idle(10_000);
}

/** Nothing the board said went to the top of the group: every send there is in a thread, or opens one. */
function nothingAtTheTop(lark: FakeChannel): boolean {
  const targets = [...lark.texts.map((m) => m.target), ...lark.boardCards.map((c) => c.target), ...lark.approvalCards.map((c) => c.target)];
  return targets.every((x) => x.chatId !== 'oc_team' || x.threadId !== '' || x.replyInThread === true);
}

describe("a task's thread, end to end", () => {
  it("answers a task created at chat scope in a thread on its command, and puts a member's card, its press and its notices there", async () => {
    const s = build();
    const command = inGroup('/kanban task new Book the venue\nassignee: @Alice Smith', [AT_ALICE]);
    await s.router.onMessage(command);
    const taskId = createdIn(s.lark);
    expect(s.lark.texts[0]?.target).toEqual({ chatId: 'oc_team', threadId: '', replyTo: command.messageId, replyInThread: true, stayInThread: true });
    expect(s.lark.texts[0]?.text).toContain('Their card comes in this thread when it is ready, or by direct message if they are not in this group. This thread hears');
    expect(subscriptionsOf(s.t.db, taskId).map((x) => [x.threadId, x.rootMessageId])).toEqual([[`omt_${command.messageId}`, command.messageId]]);
    expect(s.chat.held(taskId)).toBe(false);
    await s.dispatcher.idle();

    expect(await s.cards.deliver()).toBe(1);
    const [card] = s.lark.boardCards;
    expect(card?.target).toEqual({ ...threadOn(command), stayInThread: true });
    expect(card?.view.markdown.startsWith(`<at id=ou_alice></at> 📋 For you to do: **Book the venue** \`${taskId}\``)).toBe(true);
    // The card says who has it, in the thread: no one line.
    expect(await s.notifier.deliver()).toBe(0);

    await press(s, card?.view ?? { markdown: '', buttons: [] }, 'om_board_2', 'Done', ALICE, 'rooms 3A and 3B');
    expect(getTask(s.t.db, taskId)?.phase).toBe('done');
    expect(await s.notifier.deliver()).toBe(1);
    expect(s.lark.texts.at(-1)).toMatchObject({ target: threadOn(command), text: `Done: **Book the venue** \`${taskId}\`\n> rooms 3A and 3B` });
    expect(nothingAtTheTop(s.lark)).toBe(true);
  });

  it("sends a non-member's card by direct message, and the thread hears who has it", async () => {
    const s = build();
    const command = inGroup('/kanban task new Order the badges\nassignee: @Bob', [AT_BOB]);
    await s.router.onMessage(command);
    const taskId = createdIn(s.lark);
    await s.dispatcher.idle();
    expect(await s.cards.deliver()).toBe(1);
    expect(s.lark.boardCards.map((c) => c.target)).toEqual([{ chatId: 'on_bob', threadId: '', receiveIdType: 'union_id' }]);
    expect(s.lark.boardCards[0]?.view.markdown).not.toContain('<at id=');
    expect(await s.notifier.deliver()).toBe(1);
    expect(s.lark.texts.at(-1)).toMatchObject({ target: threadOn(command), text: `📋 **Order the badges** \`${taskId}\`, assigned to Bob` });
  });

  it('sends a card whose direct message cannot reach its person to the thread', async () => {
    const s = build();
    const command = inGroup('/kanban task new Order the badges\nassignee: @Bob', [AT_BOB]);
    await s.router.onMessage(command);
    const taskId = createdIn(s.lark);
    await s.dispatcher.idle();
    s.lark.failNext('sendCard', new ChannelError(230013, 'Bot has NO availability to this user', false));
    expect(await s.cards.deliver()).toBe(1);
    expect(s.lark.calls.filter((c) => c === 'sendCard')).toHaveLength(2);
    expect(s.lark.boardCards.map((c) => c.target)).toEqual([{ ...threadOn(command), stayInThread: true }]);
    expect(s.lark.boardCards[0]?.view.markdown.startsWith('<at id=ou_bob></at> ')).toBe(true);
    expect(await s.notifier.deliver()).toBe(0);
    expect(getTask(s.t.db, taskId)?.phase).toBe('open');
  });

  it("puts a follow-up's notices, and its person's card, in its parent's thread", async () => {
    const s = build();
    let followUp = '';
    s.helper.scripts.push(async (ctl) => {
      const runId = ctl.env?.['MT_KANBAN_RUN'] ?? '';
      // As the worker API creates one for `mt kanban create`: by the run, for a person.
      const child = s.service.create({ title: 'Call the caterer', assignee: 'lark:on_alice', createdBy: `run:${runId}`, createdVia: { kind: 'run', runId } });
      if (!child.ok) throw new Error(child.message);
      followUp = child.task.taskId;
      const done = await s.service.complete(getRun(s.t.db, runId)?.taskId ?? '', { kind: 'run', runId }, { summary: 'venue booked' });
      if (!done.ok) throw new Error(done.message);
      ctl.end('completed');
    });
    const command = inGroup('/kanban task new Plan the offsite\nassignee: helper');
    await s.router.onMessage(command);
    const taskId = createdIn(s.lark);
    await until(() => followUp !== '' && getTask(s.t.db, taskId)?.phase === 'done', 'the follow-up');
    await s.dispatcher.idle();
    s.dispatcher.pass();
    await s.dispatcher.idle();
    expect(subscriptionsOf(s.t.db, followUp).map((x) => [x.threadId, x.rootMessageId])).toEqual([[`omt_${command.messageId}`, command.messageId]]);
    expect(await s.cards.deliver()).toBe(1);
    const [card] = s.lark.boardCards;
    expect(card?.target).toEqual({ ...threadOn(command), stayInThread: true });
    // Alice's Done on the follow-up's card: its notice comes in the parent's thread too.
    await press(s, card?.view ?? { markdown: '', buttons: [] }, 'om_board_2', 'Done', ALICE, 'booked');
    expect(getTask(s.t.db, followUp)?.phase).toBe('done');
    await s.notifier.deliver();
    const told = s.lark.texts.filter((m) => !m.text.startsWith('Created'));
    expect(told.map((m) => m.target)).toEqual([threadOn(command)]);
    expect(told[0]?.text.split('\n\n')).toEqual([
      `Done: **Plan the offsite** \`${taskId}\`\n> venue booked`,
      `Done: **Call the caterer** \`${followUp}\`\n> booked`,
    ]);
    expect(nothingAtTheTop(s.lark)).toBe(true);
  });

  it("forwards a supervised role's approval card to the task's thread, replying to its root", async () => {
    const s = build();
    let answer: unknown;
    s.watched.scripts.push(async (ctl) => {
      const runId = ctl.env?.['MT_KANBAN_RUN'] ?? '';
      const taskId = getRun(s.t.db, runId)?.taskId ?? '';
      // Asked once the thread is known: one asked in the moment before is the group's (see Known limitations).
      await until(() => subscriptionsOf(s.t.db, taskId)[0]?.rootMessageId !== null, 'the thread');
      answer = await ctl.ask('delete old.log', [{ optionId: 'allow', name: 'Allow' }]);
      ctl.end('completed');
    });
    const command = inGroup('/kanban task new Rotate the logs\nassignee: watched');
    await s.router.onMessage(command);
    const taskId = createdIn(s.lark);
    await until(() => s.lark.approvalCards.length > 0, 'the approval card');
    const [card] = s.lark.approvalCards;
    expect(card?.target).toEqual(threadOn(command));
    expect(card?.spec.action).toBe(`Task ${taskId}, Rotate the logs, asks: delete old.log`);
    expect(
      await s.router.onCardAction({
        chatId: 'oc_team',
        messageId: 'om_approval_2',
        operator: OWNER,
        value: { kind: 'approval', approvalId: card?.spec.approvalId ?? '', optionId: 'allow', nonce: card?.spec.nonce ?? '' },
      }),
    ).toBe('Sent: Allow.');
    await until(() => answer !== undefined, "the agent's answer");
    expect(answer).toEqual({ kind: 'selected', optionId: 'allow' });
  });

  it('leaves a task created in a direct message as it was: no thread, its card by direct message, its one line in that chat', async () => {
    const s = build();
    const command: InboundMessage = { ...inGroup('/kanban task new Check the links\nassignee: @Alice Smith', [AT_ALICE]), chatId: 'oc_dm', chatType: 'p2p' };
    await s.router.onMessage(command);
    const taskId = createdIn(s.lark);
    expect(s.lark.texts[0]?.target).toEqual({ chatId: 'oc_dm', threadId: '' });
    expect(s.lark.texts[0]?.text).toContain('They are sent it as a card, in a direct message, once it is ready. This chat hears');
    expect(subscriptionsOf(s.t.db, taskId).map((x) => [x.conversationId, x.threadId, x.rootMessageId])).toEqual([['oc_dm', '', null]]);
    await s.dispatcher.idle();
    expect(await s.cards.deliver()).toBe(1);
    expect(s.lark.boardCards.map((c) => c.target)).toEqual([{ chatId: 'on_alice', threadId: '', receiveIdType: 'union_id' }]);
    expect(s.lark.memberLookups).toEqual([]);
    expect(await s.notifier.deliver()).toBe(1);
    expect(s.lark.texts.at(-1)).toMatchObject({ target: { chatId: 'oc_dm', threadId: '' }, text: `📋 **Check the links** \`${taskId}\`, assigned to Alice Smith` });
  });
});
