import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boardsOf, getTask } from '../src/db/kanban-read.js';
import { renderHelp } from '../src/kanban/chat-render.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import type { BindingKey, InboundMessage, Principal } from '../src/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { WORKSPACES } from './helpers/kanban.js';

/**
 * Boards in chat (spec §16): `/kanban board list` and the rest of `/kanban board …`, each chat
 * on its own board, and `/kanban new`, `list` and `show` acting on it.
 */

const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const GUEST: Principal = { openId: 'ou_guest', unionId: 'on_guest', displayName: 'Guest' };
const TEAM: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: '' };
const TOPIC: BindingKey = { ...TEAM, threadId: 'omt_topic' };
const OTHER: BindingKey = { ...TEAM, conversationId: 'oc_other' };

let t: TestDb;
let service: KanbanService;
let chat: KanbanChat;
let passes: number;
let seq = 0;

beforeEach(() => {
  t = testDb();
  const authorizer = new Authorizer({ ...defaultAuthConfig(OWNER.openId), allowTalk: [OWNER.openId, GUEST.openId] });
  const people = new PeopleDirectory({
    db: t.db,
    appId: 'cli_app',
    canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }),
  });
  service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
    people,
    maxRunning: 4,
  });
  passes = 0;
  chat = new KanbanChat({
    service,
    hasTier: (p, tier) => authorizer.hasTier(p, tier),
    people,
    appId: 'cli_app',
    changed: () => (passes += 1),
  });
});

afterEach(() => t.close());

function message(sender: Principal, key: BindingKey): InboundMessage {
  return {
    messageId: `om_${++seq}`,
    appId: key.appId,
    chatId: key.conversationId,
    chatType: 'group',
    threadId: key.threadId,
    sender,
    senderIsBot: false,
    text: '',
    mentionedBot: true,
    mentionAll: false,
    mentions: [],
    attachments: [],
    createTime: 0,
  };
}

function say(arg: string, key: BindingKey = TEAM, sender: Principal = OWNER): Promise<string> {
  return chat.run(arg, message(sender, key), key);
}

function created(reply: string): string {
  const m = /^Created `(k_[0-9a-z]+)`/.exec(reply);
  if (m?.[1] === undefined) throw new Error(`not created: ${reply}`);
  return m[1];
}

describe('/kanban board list and /kanban board create', () => {
  it('lists default, and the boards an operator creates, marking this chat’s', async () => {
    expect(await say('board list')).toBe(
      '**default** (this chat): no tasks\n' +
        '`/kanban board use <name>` moves this chat to another board; `/kanban board create <name>` makes one.',
    );
    expect(await say('board create web-app')).toBe('Created board **web-app**. `/kanban board use web-app` puts a chat on it.');
    expect((await say('board list', TEAM, GUEST)).split('\n').slice(0, 2)).toEqual(['**default** (this chat): no tasks', '**web-app**: no tasks']);
  });

  it('refuses a talk-tier sender, and a name out of the grammar, creating nothing', async () => {
    expect(await say('board create web-app', TEAM, GUEST)).toBe('`/kanban board create` changes the board, and needs operator permission.');
    expect(await say('board create Web_App')).toMatch(/^Not done: board name "Web\\_App" must be lowercase letters/);
    expect(boardsOf(t.db).map((b) => b.name)).toEqual(['default']);
  });
});

describe('/kanban board use', () => {
  it('moves this chat, all its threads, onto a board, and no other chat', async () => {
    await say('board create web-app');
    expect(await say('board use web-app', TOPIC)).toBe(
      'This chat is on board **web-app** now: its `/kanban new` adds tasks to it, and `/kanban list` shows them.',
    );
    expect(service.chatBoard({ channel: 'lark', appId: 'cli_app', conversationId: 'oc_team' }).name).toBe('web-app');
    expect(service.chatBoard({ channel: 'lark', appId: 'cli_app', conversationId: 'oc_other' }).name).toBe('default');
    expect(await say('board use web-app', TEAM, GUEST)).toBe('`/kanban board use` changes the board, and needs operator permission.');
    expect(await say('board use nowhere')).toBe('Not done: there is no board nowhere');
  });

  it("creates this chat's tasks on its board, and lists that board alone", async () => {
    await say('board create web-app');
    const plain = created(await say('new On default\nassignee: implementer', OTHER));
    await say('board use web-app');
    const reply = await say('new On the web app\nassignee: implementer\nworkspace: web');
    const taskId = created(reply);
    expect(reply).toContain(', in web, on board **web-app**. This chat hears');
    expect(getTask(t.db, taskId)?.board).toBe('web-app');
    expect(passes).toBe(2);

    expect((await say('list')).split('\n')).toEqual(['Board **web-app**:', `\`${taskId}\` **ready**: On the web app · role implementer`]);
    expect(await say('list', OTHER)).toBe(`\`${plain}\` **ready**: On default · role implementer`);
    expect(await say('list done')).toBe('No done tasks on board web-app.');
  });

  it("shows a task on any board by its id, naming its board", async () => {
    await say('board create web-app');
    const plain = created(await say('new On default\nassignee: implementer'));
    expect((await say(`show ${plain}`)).split('\n')[1]).toBe('assignee: role implementer · reviewer: nobody · workspace: not yet fixed');
    await say('board use web-app');
    expect((await say(`show ${plain}`)).split('\n')[1]).toBe(
      'assignee: role implementer · reviewer: nobody · workspace: not yet fixed · board: default',
    );
  });

  it("refuses a parent on another board", async () => {
    await say('board create web-app');
    const plain = created(await say('new On default\nassignee: implementer'));
    await say('board use web-app');
    expect(await say(`new Child\nassignee: implementer\nparent: ${plain}`)).toBe(
      `Not done: task ${plain.replace('_', '\\_')} is on board default, not web-app: a task and its parents are on one board`,
    );
  });
});

describe('/kanban board set', () => {
  it("sets a board's max_running and workspace, and looks for work", async () => {
    await say('board create web-app');
    expect(await say('board set web-app max_running 2')).toBe('Board **web-app** runs at most 2 agents at once now.');
    expect(await say('board set web-app max_running none')).toBe(
      "Board **web-app** has no max\\_running of its own now: the gateway's kanban.max\\_running holds.",
    );
    expect(await say('board set web-app workspace web')).toBe(
      "Board **web-app**'s tasks work in web now, unless their own workspace, their role's or their parents' says otherwise.",
    );
    expect(passes).toBe(3);
    expect(await say('board set web-app max_running 5')).toBe(
      "Not done: a board's max\\_running is a whole number from 1 to the gateway's kanban.max\\_running, 4",
    );
    expect(await say('board set web-app workspace nowhere')).toBe('Not done: workspace "nowhere" is not configured');
    expect(await say('board set web-app max_running 1', TEAM, GUEST)).toBe(
      '`/kanban board set` changes the board, and needs operator permission.',
    );
    expect((await say('board list')).split('\n')[1]).toBe('**web-app**: no tasks · workspace web');
  });
});

describe('/kanban board archive', () => {
  it('archives a board once its tasks are finished, and then adds nothing to it', async () => {
    await say('board create web-app');
    await say('board use web-app');
    const taskId = created(await say('new Last one\nassignee: implementer'));
    expect(await say('board archive web-app')).toBe(
      'Not done: board web-app has 1 task not yet done or archived; finish or archive it first',
    );
    await say(`archive ${taskId}`);
    expect(await say('board archive web-app')).toBe(
      'Archived board **web-app**. Its tasks stay, and `/kanban show` still shows them; nothing more is added to it.',
    );
    expect(await say('new Another\nassignee: implementer')).toBe(
      'This chat is on board **web-app**, which is archived: `/kanban board use <board>` moves it to another first.',
    );
    expect(await say('board use web-app', OTHER)).toBe('Not done: board web-app is archived');
    // A chat on an archived board still sees it, marked; another chat does not.
    expect((await say('board list')).split('\n')[1]).toBe('**web-app** (archived, this chat): no tasks');
    expect(await say('board list', OTHER)).not.toContain('**web-app**');
    expect((await say('board list all', OTHER)).split('\n')[1]).toBe('**web-app** (archived): no tasks');
    expect(await say('board archive default')).toBe('Not done: board default is where every chat starts; it is never archived');
  });
});

describe('/kanban help', () => {
  it('lists the board commands, with who may run them', () => {
    const help = renderHelp();
    expect(help).toContain('`/kanban board list [all]` (anyone allowed)');
    expect(help).not.toContain('/kanban boards');
    for (const verb of ['create <name>', 'use <name>', 'archive <name>']) {
      expect(help).toContain(`\`/kanban board ${verb}\` (operator)`);
    }
    expect(help).toContain('`/kanban board set <name> max_running <number|none>, or workspace <workspace|none>` (operator)');
    expect(help).toContain('A board is a queue of tasks of its own.');
  });
});
