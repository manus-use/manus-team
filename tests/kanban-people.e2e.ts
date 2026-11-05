import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CardView, Channel } from '../src/channel/types.js';
import { SessionRegistry } from '../src/core/registry.js';
import { Router } from '../src/core/router.js';
import { NamedWorkspaces } from '../src/core/workspace.js';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import { createCliDriver } from '../src/driver/cli/driver.js';
import type { Driver } from '../src/driver/types.js';
import { CardPoster } from '../src/kanban/cards.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { Dispatcher } from '../src/kanban/dispatcher.js';
import { Notifier } from '../src/kanban/notices.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import { writeMtShim } from '../src/kanban/shim.js';
import { KanbanSink } from '../src/kanban/sink.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { WorkerApi } from '../src/kanban/worker.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import { clearSecrets } from '../src/secrets.js';
import type { InboundMention, InboundMessage, Principal } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { FakeDriver } from './helpers/driver.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';

/**
 * People on the board, end to end (spec §9.2, §11): a task given to a person by
 * @-mention in a group thread is sent to them as a card in a direct message, by
 * union_id; their press of Done, as the callback's operator, completes it; and
 * the thread hears who had it and that it is done. And a person reviewing an
 * agent's work -- the fake CLI agent, a real process reporting through `mt
 * kanban` and the real socket -- is sent the review card, asks for changes, which
 * the agent's rework run revises, and approves the second review.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));
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
  /** A new one is a new process: it knows only what the database does. */
  notifier: () => Notifier;
  cards: () => CardPoster;
  chat: KanbanChat;
  server: WorkerServer;
  registry: SessionRegistry;
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
  await stack.server.close();
  stack.t.close();
  rmSync(stack.dir, { recursive: true, force: true });
  stack = undefined;
});

async function build(mode: string): Promise<Stack> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-people-e2e-')));
  const home = join(dir, 'home');
  const workspace = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(workspace);
  const t = testDb();
  const authorizer = new Authorizer({
    ...defaultAuthConfig(OWNER.openId),
    allowTalk: [OWNER.openId, ALICE.openId, BOB.openId],
  });
  const people = new PeopleDirectory({
    db: t.db,
    appId: 'cli_app',
    canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }),
  });
  const roles = new Map([['implementer', role('implementer')]]);
  const service = new KanbanService({ db: t.db, roles, workspaces: new Set(['default']), people, supervisedRoles: true });
  const lark = new FakeChannel({ id: 'lark' });
  const drivers = new Map<string, Driver>([
    ['default', new FakeDriver()],
    [
      'implementer',
      createCliDriver({
        command: process.execPath,
        args: [AGENT],
        env: { FAKE_CLI_MODE: mode, FAKE_CLI_LOG: join(dir, 'invocations.log') },
      }),
    ],
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
  const socket = workerSocketPath(home);
  dispatcher = new Dispatcher({
    db: t.db,
    service,
    sessions: registry,
    roles,
    appId: 'cli_app',
    settings: { maxRunning: 2, defaultMaxRuntimeS: 600, strandedAfterS: 1800, sweepIntervalS: 60, nudgeLimit: 0 },
    worker: { socket, mtDir: writeMtShim(home), path: process.env['PATH'] },
  });
  const d = dispatcher;
  const api = new WorkerApi({ db: t.db, service, changed: () => d.pass() });
  const server = await listenWorker(socket, (request, signal) => api.handle(request, { signal }));
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
  const router = new Router({
    db: t.db,
    registry,
    authorizer,
    channel: lark,
    channelId: 'lark',
    appId: 'cli_app',
    kanban: chat,
  });
  const nameOf = (principal: string) => people.nameOf(principal);
  stack = {
    t,
    lark,
    router,
    dispatcher,
    notifier: () =>
      new Notifier({ db: t.db, service, channels: new Map([['lark', lark]]), appId: 'cli_app', blockRecurrenceLimit: 2, nameOf }),
    cards: () => new CardPoster({ db: t.db, service, channel: lark, appId: 'cli_app', nameOf }),
    chat,
    server,
    registry,
    dir,
  };
  return stack;
}

/** A message in the team's group, in a topic thread, mentioning the bot and whoever else. */
function said(text: string, mentions: InboundMention[] = []): InboundMessage {
  return {
    messageId: `om_e2e_${++seq}`,
    appId: 'cli_app',
    chatId: 'oc_team',
    chatType: 'group',
    threadId: 'omt_topic',
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

function createdIn(lark: FakeChannel): string {
  const reply = lark.texts.at(-1)?.text ?? '';
  const id = /^Created `(k_[0-9a-z]+)`/.exec(reply)?.[1];
  if (id === undefined) throw new Error(`no task created: ${reply}`);
  return id;
}

/**
 * Press a card's button as `who`, with what was typed in its box: as Lark's
 * callback gives it, through the router, on the card as it was last drawn. Then
 * wait for the work the press began, and give the card it left, and what was
 * said in the chat: nothing, as a board card's press is shown on its card.
 */
async function press(
  s: Stack,
  card: { view: CardView; messageId: string },
  label: string,
  who: Principal,
  input?: string,
): Promise<{ said: number; card: string }> {
  const drawn = s.lark.cardUpdates.filter((u) => u.messageId === card.messageId && u.view.buttons.length > 0).at(-1)?.view ?? card.view;
  const button = drawn.buttons.find((b) => b.label === label);
  if (button === undefined) throw new Error(`no ${label} on the card`);
  const texts = s.lark.texts.length;
  const answer = await s.router.onCardAction({
    chatId: `oc_dm_${who.unionId ?? ''}`,
    messageId: card.messageId,
    operator: who,
    value: { ...button.value },
    ...(input === undefined ? {} : { input }),
  });
  if (answer !== undefined) throw new Error(`a board card's press was answered in the chat: ${answer}`);
  await s.chat.idle(10_000);
  const last = s.lark.cardUpdates.filter((u) => u.messageId === card.messageId).at(-1)?.view.markdown ?? '';
  return { said: s.lark.texts.length - texts, card: last };
}

/** The cards sent so far, each with the message it became. */
function cardsOf(lark: FakeChannel): Array<{ view: CardView; to: string; messageId: string }> {
  return lark.boardCards.map((c, i) => ({ view: c.view, to: c.target.chatId, messageId: `om_board_${i + 1}` }));
}

describe('people on the board, end to end', () => {
  it('a task for a person reaches them as a card, their Done completes it, and the thread hears both', async () => {
    const s = await build('kanban');
    await s.router.onMessage(said('/kanban new Check the links\nassignee: @Alice Smith\nEvery link on the wiki page.', [AT_ALICE]));
    const taskId = createdIn(s.lark);
    await s.dispatcher.idle();
    expect(runsOf(s.t.db, taskId)).toMatchObject([{ kind: 'work', assignee: { kind: 'human', name: 'lark:on_alice' }, outcome: null }]);

    // The card goes to Alice herself, by union_id, and only there.
    expect(await s.cards().deliver()).toBe(1);
    const [card] = cardsOf(s.lark);
    if (card === undefined) throw new Error('no card');
    expect(s.lark.boardCards[0]?.target).toEqual({ chatId: 'on_alice', threadId: '', receiveIdType: 'union_id' });
    expect(card.view.markdown).toContain('> Every link on the wiki page.');
    // The thread gets one line, naming her in plain text.
    const replies = s.lark.texts.length;
    expect(await s.notifier().deliver()).toBe(1);
    expect(s.lark.texts.slice(replies).map((m) => [m.target, m.text])).toEqual([
      [{ chatId: 'oc_team', threadId: 'omt_topic' }, `📋 **Check the links** \`${taskId}\` — assigned to Alice Smith`],
    ]);

    // Someone else's press does nothing; Alice's, with her summary, completes it.
    expect(await press(s, card, 'Done', BOB, 'not mine')).toEqual({ said: 0, card: '' });
    expect(runsOf(s.t.db, taskId)[0]?.outcome).toBeNull();
    const done = await press(s, card, 'Done', ALICE, 'all links answer');
    expect(done.said).toBe(0);
    expect(done.card).toBe(`**Check the links** \`${taskId}\`\nDone — by Alice Smith.`);
    expect(getTask(s.t.db, taskId)?.phase).toBe('done');
    expect(runsOf(s.t.db, taskId)[0]).toMatchObject({ outcome: 'completed', summary: 'all links answer' });
    expect(s.lark.cardUpdates.map((u) => [u.messageId, u.view.buttons.length])).toEqual([
      [card.messageId, 0],
      [card.messageId, 0],
    ]);
    // Pressed again, the card says it is out of date, and changes nothing.
    expect((await press(s, card, 'Done', ALICE, 'again')).card).toMatch(/\nThis card is out of date/);

    const before = s.lark.texts.length;
    expect(await s.notifier().deliver()).toBe(1);
    expect(s.lark.texts.slice(before).map((m) => m.text)).toEqual([`Done — **Check the links** \`${taskId}\`:\n> all links answer`]);
    // A restart sends no card again, and no notice.
    expect(await s.cards().deliver()).toBe(0);
    expect(await s.notifier().deliver()).toBe(0);
  });

  it("a person reviewing an agent's work asks for changes, the agent revises, and the person approves", async () => {
    const s = await build('kanban-review');
    await s.router.onMessage(
      said('/kanban new Draft the notes\nassignee: implementer\nreviewer: @Bob\nworkspace: default', [AT_BOB]),
    );
    const taskId = createdIn(s.lark);
    await s.dispatcher.idle();
    s.dispatcher.pass();
    await s.dispatcher.idle();
    expect(getTask(s.t.db, taskId)?.phase).toBe('review');
    expect(runsOf(s.t.db, taskId).map((r) => [r.kind, r.assignee.kind, r.outcome])).toEqual([
      ['work', 'role', 'review_requested'],
      ['review', 'human', null],
    ]);

    // Bob's review card: the agent's handoff, from its agent; no commit line, as the workspace is no repository.
    expect(await s.cards().deliver()).toBe(1);
    const first = cardsOf(s.lark)[0];
    if (first === undefined) throw new Error('no card');
    expect(first.to).toBe('on_bob');
    expect(first.view.markdown).toContain('**The handoff**, from its agent:\n> drafted: Draft the notes');
    expect(first.view.markdown).not.toContain('To review:');

    // Request changes needs a reason; with one, the task goes back to the agent, which revises.
    // An empty box is refused, and the card redrawn live, with buttons a second press can be made with.
    const empty = await press(s, first, 'Request changes', BOB);
    expect(empty.said).toBe(0);
    expect(empty.card).toContain('**Not done.** Type what needs changing');
    const asked = await press(s, first, 'Request changes', BOB, 'cite the sources');
    expect(asked.said).toBe(0);
    expect(asked.card).toBe(`**Draft the notes** \`${taskId}\`\nChanges requested — by Bob: cite the sources`);
    await s.dispatcher.idle();
    s.dispatcher.pass();
    await s.dispatcher.idle();
    expect(runsOf(s.t.db, taskId).map((r) => [r.kind, r.outcome, r.summary])).toEqual([
      ['work', 'review_requested', 'drafted: Draft the notes'],
      ['review', 'changes_requested', 'cite the sources'],
      ['work', 'review_requested', 'revised (cite the sources): Draft the notes'],
      ['review', null, null],
    ]);

    // The second review's card; the first one is out of date now.
    expect(await s.cards().deliver()).toBe(1);
    const second = cardsOf(s.lark)[1];
    if (second === undefined) throw new Error('no second card');
    expect(second.view.markdown).toContain('> revised (cite the sources): Draft the notes');
    expect((await press(s, second, 'Approve', BOB)).card).toBe(`**Draft the notes** \`${taskId}\`\nApproved — by Bob.`);
    expect((await press(s, first, 'Request changes', BOB, 'again')).card).toMatch(/\nThis card is out of date/);
    expect(getTask(s.t.db, taskId)?.phase).toBe('done');

    // The thread heard each request for review, who had each review, and the end.
    await s.notifier().deliver();
    const told = s.lark.texts
      .filter((m) => m.target.threadId === 'omt_topic' && !m.text.startsWith('Created'))
      .flatMap((m) => m.text.split('\n\n'));
    const name = `**Draft the notes** \`${taskId}\``;
    expect(told).toEqual([
      `Review requested — ${name}, from Bob.`,
      `📋 ${name} — review assigned to Bob`,
      `Review requested — ${name}, from Bob.`,
      `📋 ${name} — review assigned to Bob`,
      // Approved with nothing more to say.
      `Done — ${name}.`,
    ]);
  });
});
