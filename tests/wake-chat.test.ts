import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventsOf, getTask } from '../src/db/kanban-read.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { parseKanban } from '../src/kanban/chat-parse.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import { clearSecrets } from '../src/secrets.js';
import type { BindingKey, InboundMessage, Principal } from '../src/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { WORKSPACES } from './helpers/kanban.js';

/**
 * Wake in chat (wake spec §3.1, §3.4): the `wake:` field line of `/kanban task
 * new`, and `/kanban task wake <task> on|off`, typed in a chat that follows the
 * task, its answers naming the setter by chat name.
 */

const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Zhixi Sun' };
const GUEST: Principal = { openId: 'ou_guest', unionId: 'on_guest', displayName: 'Kevin Tu' };
const KEY: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' };
const WAKES_OFF =
  'Not done: wakes are off on this gateway: an operator turns them on with kanban.wake.enabled: true in config.yaml, and a restart';

let t: TestDb;
let seq = 0;

beforeEach(() => {
  clearSecrets();
  t = testDb();
});
afterEach(() => {
  clearSecrets();
  t.close();
});

function harness(wake = { enabled: true, maxDepth: 5 }): { chat: KanbanChat; service: KanbanService } {
  const authorizer = new Authorizer({ ...defaultAuthConfig(OWNER.openId), allowTalk: [OWNER.openId, GUEST.openId] });
  const people = new PeopleDirectory({
    db: t.db,
    appId: 'cli_app',
    canTalk: ({ openId, unionId }) => authorizer.canTalk({ openId: openId ?? '', unionId, displayName: null }),
  });
  const service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
    people,
    wake,
  });
  const chat = new KanbanChat({ service, hasTier: (p, tier) => authorizer.hasTier(p, tier), people, appId: 'cli_app' });
  return { chat, service };
}

function message(sender: Principal, key: BindingKey): InboundMessage {
  return {
    messageId: `om_${++seq}`,
    appId: 'cli_app',
    chatId: key.conversationId,
    chatType: 'group',
    threadId: key.threadId,
    rootId: 'om_root',
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

async function say(chat: KanbanChat, arg: string, sender: Principal = OWNER, key: BindingKey = KEY): Promise<string> {
  return (await chat.run(arg, message(sender, key), key)).text;
}

function created(reply: string): string {
  const m = /^Created `(k_[0-9a-z]+)`/.exec(reply);
  if (m?.[1] === undefined) throw new Error(`not created: ${reply}`);
  return m[1];
}

describe('/kanban task new with a wake: line', () => {
  it('turns wake on as the sender, and says so in the reply', async () => {
    const { chat } = harness();
    const reply = await say(chat, 'task new Book the venue\nassignee: implementer\nwake: on');
    const task = getTask(t.db, created(reply));
    expect(task).toMatchObject({ wakeBy: 'lark:on_owner', wakeDepth: 0 });
    expect(reply).toMatch(/Its outcomes wake the agent here\.$/);
    expect(eventsOf(t.db, task?.taskId ?? '').map((e) => e.kind)).toContain('wake_set');
  });

  it('leaves wake off for wake: off, and with no line', async () => {
    const { chat } = harness();
    for (const text of ['task new Book the venue\nwake: off', 'task new Book the venue', 'task new Book the venue\nWAKE: Off']) {
      const reply = await say(chat, text);
      expect(getTask(t.db, created(reply))?.wakeBy).toBeNull();
      expect(reply).not.toContain('wake the agent');
    }
  });

  it('refuses a wake: line that is neither on, off nor one word, and one given twice', async () => {
    const { chat } = harness();
    expect(await say(chat, 'task new Book the venue\nwake: maybe later')).toBe('`wake:` is `on`, `off` or a role.');
    expect(await say(chat, 'task new Book the venue\nwake: on\nwake: off')).toBe('`wake:` is given twice.');
  });

  it('refuses wake: on while wakes are off, and makes nothing', async () => {
    const { chat } = harness({ enabled: false, maxDepth: 5 });
    expect(await say(chat, 'task new Book the venue\nwake: on')).toBe(WAKES_OFF);
    expect(t.db.prepare('SELECT count(*) AS n FROM kanban_tasks').get()).toEqual({ n: 0 });
  });
});

describe('/kanban task wake', () => {
  it('turns wake on at talk tier, run as the sender, says when it is already on, and turns it off', async () => {
    const { chat } = harness();
    const taskId = created(await say(chat, 'task new Book the venue'));
    expect(await say(chat, `task wake ${taskId} on`, GUEST)).toBe(
      `Wake is on for \`${taskId}\`: its outcomes now start a turn of the agent where it is followed, run as Kevin Tu.`,
    );
    expect(getTask(t.db, taskId)?.wakeBy).toBe('lark:on_guest');
    expect(await say(chat, `task wake ${taskId} on`, GUEST)).toBe(`Wake is already on for \`${taskId}\`, run as Kevin Tu.`);
    // Another setter replaces the first.
    expect(await say(chat, `task wake ${taskId} ON`)).toContain('run as Zhixi Sun.');
    expect(getTask(t.db, taskId)?.wakeBy).toBe('lark:on_owner');
    // Anyone with talk tier may turn it off.
    expect(await say(chat, `task wake ${taskId} off`, GUEST)).toBe(`Wake is off for \`${taskId}\`: its outcomes are notices only.`);
    expect(getTask(t.db, taskId)?.wakeBy).toBeNull();
    expect(await say(chat, `task wake ${taskId} off`, GUEST)).toBe(`Wake is off for \`${taskId}\`: its outcomes are notices only.`);
  });

  it('takes a task followed in any thread of this chat, or at its chat scope', async () => {
    const { chat } = harness();
    const taskId = created(await say(chat, 'task new Book the venue'));
    const elsewhere: BindingKey = { ...KEY, threadId: '' };
    expect(await say(chat, `task wake ${taskId} on`, OWNER, elsewhere)).toContain(`Wake is on for \`${taskId}\``);
  });

  it('refuses a task another chat follows', async () => {
    const { chat } = harness();
    const taskId = created(await say(chat, 'task new Book the venue'));
    const other: BindingKey = { ...KEY, conversationId: 'oc_other', threadId: '' };
    expect(await say(chat, `task wake ${taskId} on`, OWNER, other)).toBe(
      `Not done: \`${taskId}\` is followed by another chat, so its wake is set there, or from the terminal`,
    );
    expect(getTask(t.db, taskId)?.wakeBy).toBeNull();
  });

  it('refuses a task no chat follows', async () => {
    const { chat, service } = harness();
    const r = service.create({ title: 'Book the venue', createdBy: 'lark:on_owner', createdVia: { kind: 'operator' } });
    if (!r.ok) throw new Error(r.message);
    expect(await say(chat, `task wake ${r.task.taskId} on`)).toBe(
      // A refusal's words are escaped, as every refusal chat shows.
      `Not done: a wake needs a chat that follows the task, and no chat follows ${r.task.taskId.replace('_', '\\_')}: a chat is chosen when a task is made`,
    );
  });

  it('refuses wake on while wakes are off, and still turns it off', async () => {
    const on = harness();
    const taskId = created(await say(on.chat, 'task new Book the venue\nwake: on'));
    const off = harness({ enabled: false, maxDepth: 5 });
    expect(await say(off.chat, `task wake ${taskId} on`, GUEST)).toBe(WAKES_OFF);
    expect(await say(off.chat, `task wake ${taskId} off`)).toBe(`Wake is off for \`${taskId}\`: its outcomes are notices only.`);
  });

  it('notes a task too deep, and leaves its wake off', async () => {
    const { chat, service } = harness();
    const r = service.create({
      title: 'Book the venue',
      createdBy: 'lark:on_owner',
      createdVia: { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic', chatType: 'group' },
      wake: { by: null, depth: 5 },
    });
    if (!r.ok) throw new Error(r.message);
    expect(await say(chat, `task wake ${r.task.taskId} on`)).toBe(`\`${r.task.taskId}\` is 5 tasks deep in woken turns, so it stays notice-only.`);
    expect(getTask(t.db, r.task.taskId)?.wakeBy).toBeNull();
  });

  it('keeps a wake already on past a max_depth lowered since, and says it stays on, as its setter', async () => {
    const { chat } = harness();
    const taskId = created(await say(chat, 'task new Book the venue'));
    await say(chat, `task wake ${taskId} on`, GUEST);
    t.db.prepare('UPDATE kanban_tasks SET wake_depth = 5 WHERE task_id = ?').run(taskId);
    expect(await say(chat, `task wake ${taskId} on`)).toBe(
      `Wake stays on for \`${taskId}\`, run as Kevin Tu: it is 5 tasks deep, so it cannot be set again.`,
    );
    expect(getTask(t.db, taskId)?.wakeBy).toBe('lark:on_guest');
  });

  it('refuses a task another chat also follows, for on and off alike', async () => {
    const { chat } = harness();
    const taskId = created(await say(chat, 'task new Book the venue'));
    t.db
      .prepare(
        `INSERT INTO kanban_subscriptions (task_id, channel, account_id, conversation_id, thread_id, created_at)
         VALUES (?, 'lark', 'cli_app', 'oc_other', '', 0)`,
      )
      .run(taskId);
    const refusal = `Not done: \`${taskId}\` is followed by another chat, so its wake is set there, or from the terminal`;
    expect(await say(chat, `task wake ${taskId} on`)).toBe(refusal);
    expect(await say(chat, `task wake ${taskId} off`)).toBe(refusal);
    expect(getTask(t.db, taskId)?.wakeBy).toBeNull();
  });

  it('answers its usage for anything but on, off or a role', async () => {
    const { chat } = harness();
    for (const text of ['task wake', 'task wake k_one', 'task wake k_one on now']) {
      expect(await say(chat, text)).toBe('Usage: `/kanban task wake <task> on|off|<role>`');
    }
  });
});

describe("chat's role forms (wake spec §19.1)", () => {
  it('reads wake: <role> on task new, and wake:<role> as a start\'s last word', () => {
    const made = parseKanban('task new Book the venue\nwake: reviewer');
    expect(made).toMatchObject({ ok: true, command: { verb: 'new', wake: true, wakeRole: 'reviewer' } });
    expect(parseKanban('workflow start flow topic=x wake:reviewer')).toEqual({
      ok: true,
      command: { verb: 'workflow start', name: 'flow', pairs: [{ key: 'topic', value: 'x', quoted: false }], wake: true, wakeRole: 'reviewer' },
    });
    // `on` and `off` are words, never roles.
    expect(parseKanban('workflow start flow wake:on')).toEqual({ ok: true, command: { verb: 'workflow start', name: 'flow', pairs: [], wake: true } });
    expect(parseKanban('workflow start flow wake:off')).toEqual({ ok: true, command: { verb: 'workflow start', name: 'flow', pairs: [] } });
    expect(parseKanban('task wake k_one reviewer')).toEqual({ ok: true, command: { verb: 'wake', taskId: 'k_one', on: true, role: 'reviewer' } });
    expect(parseKanban('task wake k_one ON')).toEqual({ ok: true, command: { verb: 'wake', taskId: 'k_one', on: true } });
  });

  it('makes a task whose wake targets a role, and says so', async () => {
    const { chat } = harness();
    const reply = await say(chat, 'task new Book the venue\nwake: reviewer');
    expect(reply).toContain('Its outcomes wake role reviewer here.');
    expect(getTask(t.db, created(reply))).toMatchObject({ wakeBy: 'lark:on_owner', wakeRole: 'reviewer' });
  });

  it('refuses a role that is not configured, and makes nothing', async () => {
    const { chat } = harness();
    expect(await say(chat, 'task new Book the venue\nwake: nobody')).toBe('Not done: role "nobody" is not configured');
    expect(t.db.prepare('SELECT count(*) AS n FROM kanban_tasks').get()).toEqual({ n: 0 });
  });

  it('sets a role as the target at operate tier, switches it both ways, and refuses it at talk tier', async () => {
    const { chat } = harness();
    const taskId = created(await say(chat, 'task new Book the venue'));
    expect(await say(chat, `task wake ${taskId} reviewer`, GUEST)).toBe(
      '`/kanban task wake <task> <role>` gives a role work, and needs operator permission.',
    );
    expect(getTask(t.db, taskId)?.wakeBy).toBeNull();
    expect(await say(chat, `task wake ${taskId} reviewer`)).toBe(
      `Wake is on for \`${taskId}\`: its outcomes now make a task for role reviewer where it is followed, set by Zhixi Sun.`,
    );
    expect(getTask(t.db, taskId)).toMatchObject({ wakeBy: 'lark:on_owner', wakeRole: 'reviewer' });
    expect(await say(chat, `task wake ${taskId} reviewer`)).toBe(`Wake is already on for \`${taskId}\`, for role reviewer, set by Zhixi Sun.`);
    expect(await say(chat, `task wake ${taskId} on`)).toContain('start a turn of the agent');
    expect(getTask(t.db, taskId)).toMatchObject({ wakeBy: 'lark:on_owner', wakeRole: null });
    expect(await say(chat, `task wake ${taskId} reviewer`)).toContain('for role reviewer');
    expect(await say(chat, `task wake ${taskId} off`, GUEST)).toBe(`Wake is off for \`${taskId}\`: its outcomes are notices only.`);
    expect(getTask(t.db, taskId)).toMatchObject({ wakeBy: null, wakeRole: null });
  });
});
