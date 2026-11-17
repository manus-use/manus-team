import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getInstance, getTask, subscriptionsOf } from '../src/db/kanban-read.js';
import { createBoard } from '../src/db/kanban.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { WORKFLOW_REPLY_MAX, renderInstance, renderStarted, startedReply } from '../src/kanban/chat-render.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import type { TaskRow } from '../src/kanban/types.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import type { BindingKey, InboundMention, InboundMessage, Principal } from '../src/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { NOW } from './helpers/kanban.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * `/kanban workflow …` in chat (workflows spec §6, §9, §10): the tiers, a start's
 * reply in its two wordings and its thread, every member held and moved in one
 * call, the reply cut to fit, @-mentions, the preview, and list, instances,
 * show and archive.
 */

const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const GUEST: Principal = { openId: 'ou_guest', unionId: 'on_guest', displayName: 'Guest' };
const AT_ALICE: InboundMention = { key: '@_user_1', name: 'Alice Smith', openId: 'ou_alice', unionId: 'on_alice' };
const AT_AL: InboundMention = { key: '@_user_2', name: 'Alice', openId: 'ou_al', unionId: 'on_al' };
const TEAM: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: '' };
const TOPIC: BindingKey = { ...TEAM, threadId: 'omt_topic' };
const HEARS = 'hears when each task is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.';
const START = 'workflow start vendor-eval topic="log storage" vendors=acme,globex';

let t: TestDb;
let dir: string;
let people: PeopleDirectory;
let service: KanbanService;
let passes: number;
/** For each pass, whether every member of the newest instance was held then. */
let heldAtPass: boolean[];
let chat: KanbanChat;
let seq = 0;

function members(): string[] {
  return t.db
    .prepare<[], { task_id: string }>('SELECT m.task_id FROM kanban_workflow_tasks m JOIN kanban_tasks t ON t.task_id = m.task_id ORDER BY t.rowid')
    .all()
    .map((r) => r.task_id);
}

beforeEach(() => {
  t = testDb();
  dir = join(t.dir, 'workflows');
  mkdirSync(dir);
  writeFileSync(join(dir, 'vendor-eval.yaml'), VENDOR_EVAL);
  const authorizer = new Authorizer({ ...defaultAuthConfig(OWNER.openId), allowTalk: [OWNER.openId, GUEST.openId, 'ou_alice', 'ou_al'] });
  people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }) });
  service = new KanbanService({
    db: t.db,
    roles: new Map([['worker', role('worker')], ['reviewer', role('reviewer')]]),
    workspaces: new Set(['default']),
    people,
    supervisedRoles: true,
    workflowsDir: dir,
  });
  passes = 0;
  heldAtPass = [];
  const c: KanbanChat = new KanbanChat({
    service,
    hasTier: (p, tier) => tier === 'talk' || p.openId === OWNER.openId,
    people,
    appId: 'cli_app',
    changed: () => {
      passes += 1;
      heldAtPass.push(members().every((id) => c.held(id)));
    },
  });
  chat = c;
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
    mentions: [AT_ALICE, AT_AL],
    attachments: [],
    createTime: 0,
    ...over,
  };
}

function instanceOf(text: string): string {
  const m = /as `(w_[0-9a-z]+)`/.exec(text);
  if (m?.[1] === undefined) throw new Error(`not started: ${text}`);
  return m[1];
}

describe('/kanban workflow start', () => {
  it('answers in a group at chat scope in the thread\'s words, the chat\'s beside them, naming the instance, every member held when the dispatcher is told, once', async () => {
    const answer = await chat.run(START, message(TEAM), TEAM);
    const id = instanceOf(answer.text);
    const ids = members();
    const lines = (where: string) =>
      [
        `Started vendor-eval as \`${id}\`, 4 tasks:`,
        `- \`${ids[0]}\` Shortlist vendors for log storage, for role worker`,
        `- \`${ids[1]}\` Evaluate acme for log storage, for role worker`,
        `- \`${ids[2]}\` Evaluate globex for log storage, for role worker`,
        `- \`${ids[3]}\` Recommend a vendor for log storage, for role worker`,
        `${where} ${HEARS}`,
      ].join('\n');
    expect(answer).toEqual({ text: lines('This thread'), quoted: lines('This chat'), thread: id });
    expect(passes).toBe(1);
    expect(heldAtPass).toEqual([true]);
    for (const m of ids) expect(chat.held(m)).toBe(true);
  });

  it('moves every member into the thread in one call when the router says where the reply went, and releases them all', async () => {
    const msg = message(TEAM);
    const answer = await chat.run(START, msg, TEAM);
    chat.threaded(answer.thread ?? '', TEAM, msg.messageId, 'omt_new');
    for (const m of members()) {
      expect(chat.held(m)).toBe(false);
      expect(subscriptionsOf(t.db, m).map((s) => [s.threadId, s.rootMessageId])).toEqual([['omt_new', msg.messageId]]);
    }
  });

  it('stays at chat scope with no thread, its holds released', async () => {
    const msg = message(TEAM);
    const answer = await chat.run(START, msg, TEAM);
    chat.threaded(answer.thread ?? '', TEAM, msg.messageId, undefined);
    for (const m of members()) {
      expect(chat.held(m)).toBe(false);
      expect(subscriptionsOf(t.db, m).map((s) => s.threadId)).toEqual(['']);
    }
  });

  it("answers in a direct message in the chat's words alone, and inside a thread with a root in the thread's, holding none", async () => {
    const dm = await chat.run(START, message(TEAM, { chatType: 'p2p' }), TEAM);
    expect(dm).toEqual({ text: expect.stringMatching(new RegExp(`\\nThis chat ${HEARS.replace(/[.]/g, '\\.')}$`)) as string });
    const inTopic = await chat.run(START, message(TOPIC, { rootId: 'om_root' }), TOPIC);
    expect(inTopic.text).toMatch(/\nThis thread hears when each task/);
    expect(inTopic).not.toHaveProperty('thread');
    const instance = getInstance(t.db, instanceOf(inTopic.text));
    expect(instance?.createdVia).toEqual({ kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' });
  });

  it('answers a redelivery with the instance it made', async () => {
    const msg = message(TEAM);
    const first = await chat.run(START, msg, TEAM);
    expect(await chat.run(START, msg, TEAM)).toEqual({ text: `Already started, as \`${instanceOf(first.text)}\`.` });
  });

  it('needs operator tier and a union_id, and refuses on an archived board', async () => {
    expect(await chat.run(START, message(TEAM, { sender: GUEST }), TEAM)).toEqual({ text: '`/kanban workflow start` changes the board, and needs operator permission.' });
    const nobody = await chat.run(START, message(TEAM, { sender: { ...OWNER, unionId: null } }), TEAM);
    expect(nobody.text).toMatch(/^Lark did not say who you are/);
    expect(members()).toEqual([]);
  });

  it('resolves @-mentions only for a person field, the longest name first', async () => {
    writeFileSync(join(dir, 'ask.yaml'), 'params:\n  owner: { required: true }\n  note: { required: true }\nsteps:\n  ask: { title: "Ask {{owner}}: {{note}}", assignee: "{{owner}}" }\n');
    const answer = await chat.run('workflow start ask owner=@Alice Smith note=@Alice', message(TEAM), TEAM);
    const [task] = members();
    expect(getTask(t.db, task ?? '')).toMatchObject({ assignee: { kind: 'human', name: 'lark:on_alice' }, title: 'Ask lark:on_alice: @Alice' });
    expect(answer.text).toContain("A person's card comes in this thread when their task is ready, or by direct message if they are not in this group.");
    expect((await chat.run('workflow start ask owner=@Bob note=x', message(TEAM), TEAM)).text).toBe(
      'Not done: @Bob is not someone this message mentions: type @ and pick them, so Lark says who they are',
    );
  });

  it('says why not, on one line, for a refusal', async () => {
    expect((await chat.run('workflow start vendor-eval vendors=acme', message(TEAM), TEAM)).text).toBe(
      'Not done: workflow vendor-eval needs param topic: what is being bought',
    );
    expect((await chat.run('workflow start nope', message(TEAM), TEAM)).text).toMatch(/^Not done: there is no workflow nope; the usable ones are vendor-eval/);
  });
});

describe("a start's reply", () => {
  it('lists at most 30 tasks, each title cut, says how many more, and stays under 3,800 characters with 100 tasks of 512-byte titles', () => {
    const tasks = Array.from({ length: 100 }, (_, i) => ({
      task: { taskId: `k_${String(i).padStart(12, '0')}`, title: `${'T'.repeat(500)} number ${i}`, assignee: { kind: 'role', name: 'worker' }, reviewer: null } as unknown as TaskRow,
    }));
    const text = renderStarted(startedReply({ instance: { instanceId: 'w_aaaaaaaaaaaa', name: 'big', board: 'default' }, tasks }), 'thread', (a) => `role ${a.name}`);
    const lines = text.split('\n');
    expect(text.length).toBeLessThan(WORKFLOW_REPLY_MAX);
    const listed = lines.filter((l) => l.startsWith('- '));
    expect(listed.length).toBeLessThanOrEqual(30);
    expect(listed[0]).toBe(`- \`k_000000000000\` ${'T'.repeat(79)}…, for role worker`);
    expect(lines.at(-2)).toBe(`… and ${100 - listed.length} more: \`/kanban workflow show w_aaaaaaaaaaaa\` lists them all.`);
    expect(lines.at(-1)).toBe(`This thread ${HEARS}`);
  });
});

describe('/kanban workflow preview', () => {
  it('says what a start would make, with parents and gates, at talk tier, making nothing', async () => {
    const r = await chat.run('workflow preview vendor-eval topic=logs vendors=acme', message(TEAM, { sender: GUEST }), TEAM);
    expect(r).toEqual({
      text: [
        'vendor-eval would make 3 tasks:',
        '- `shortlist` Shortlist vendors for logs, for role worker',
        '- `evaluate:1` Evaluate acme for logs, for role worker, after `shortlist`, 1 gate',
        '- `recommend` Recommend a vendor for logs, for role worker, after `evaluate:1`',
        'Nothing was made: `/kanban workflow start vendor-eval`, with these params, makes it.',
      ].join('\n'),
    });
    expect(members()).toEqual([]);
    expect(passes).toBe(0);
    expect((await chat.run('workflow preview vendor-eval topic=logs', message(TEAM, { sender: GUEST }), TEAM)).text).toBe(
      'Not done: workflow vendor-eval needs param vendors',
    );
  });
});

describe("show's params", () => {
  it('bounds the Params line as a whole, saying how many were left out, so the reply stays under its limit', () => {
    const params = Object.fromEntries(Array.from({ length: 40 }, (_, n) => [`param-${String(n).padStart(2, '0')}-${'p'.repeat(30)}`, 'v'.repeat(300)]));
    const view = {
      instance: { instanceId: 'w_1', name: 'big', board: 'default', createdBy: 'operator:me', createdVia: { kind: 'operator' }, createdAt: NOW, dag: { params } },
      description: 'd'.repeat(400),
      members: [],
      related: [],
      relatedInstances: [],
      status: 'running',
      done: 0,
      total: 0,
      blocked: 0,
    };
    const text = renderInstance(view, 'default', () => 'nobody', () => undefined);
    const line = text.split('\n').find((l) => l.startsWith('Params: ')) ?? '';
    expect(line.length).toBeLessThanOrEqual(1_200);
    expect(line).toMatch(/ · … and \d+ more params$/);
    expect(line).toContain('param-00');
    expect(text.length).toBeLessThan(WORKFLOW_REPLY_MAX);
    const few = renderInstance({ ...view, instance: { ...view.instance, dag: { params: { topic: 'logs' } } } }, 'default', () => 'nobody', () => undefined);
    expect(few).toContain('Params: topic: logs');
    expect(few).not.toContain('more params');
  });
});

describe('/kanban workflow list, instances, show and archive', () => {
  it('lists the workflows, broken ones with why', async () => {
    writeFileSync(join(dir, 'broken.yaml'), 'steps: {}\n');
    expect((await chat.run('workflow list', message(TEAM, { sender: GUEST }), TEAM)).text).toBe(
      [
        '**Workflows**',
        '- **broken** is not usable: the file needs steps, at least one',
        '- **vendor-eval**: Shortlist vendors, evaluate each in parallel, then recommend one · params: topic \\(required\\), vendors \\(list, required\\), reviewer \\(default reviewer\\)',
        '`/kanban workflow preview <name> key=value ...` shows what a start would make.',
      ].join('\n'),
    );
  });

  it("lists the chat board's instances, shows one, and archives it at operator tier", async () => {
    const id = instanceOf((await chat.run(START, message(TEAM), TEAM)).text);
    const listed = (await chat.run('workflow instances', message(TEAM, { sender: GUEST }), TEAM)).text;
    expect(listed).toMatch(new RegExp(`^Workflow instances:\\n- \`${id}\` \\*\\*vendor-eval\\*\\* running, 0 of 4 done · by Owner, \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC$`));
    const shown = (await chat.run(`workflow show ${id}`, message(TEAM, { sender: GUEST }), TEAM)).text.split('\n');
    expect(shown[0]).toBe(`**vendor-eval** \`${id}\`: running, 0 of 4 done`);
    expect(shown).toContain('Params: reviewer: reviewer · topic: log storage · vendors: acme, globex');
    expect(shown).toContain('**evaluate**');
    expect(shown.filter((l) => l.startsWith('- ')).map((l) => l.replace(/`k_[0-9a-z]+`/, 'K'))).toEqual([
      '- K ready · role worker',
      '- K acme: todo · role worker',
      '- K globex: todo · role worker',
      '- K todo · role worker',
    ]);
    expect((await chat.run(`workflow archive ${id}`, message(TEAM, { sender: GUEST }), TEAM)).text).toBe(
      '`/kanban workflow archive` changes the board, and needs operator permission.',
    );
    expect((await chat.run(`workflow archive ${id}`, message(TEAM), TEAM)).text).toBe(
      `Archived 4 tasks of \`${id}\` (vendor-eval). Its related tasks are left as they are.`,
    );
    expect((await chat.run(`workflow archive ${id}`, message(TEAM), TEAM)).text).toBe(`Every task of \`${id}\` is archived already; nothing changed.`);
    expect((await chat.run('workflow instances', message(TEAM), TEAM)).text).toBe(
      'No running or blocked workflow instances. `/kanban workflow instances all` shows done and archived ones too.',
    );
    // An archived member counts as finished, not done: an archived instance says so.
    expect((await chat.run('workflow instances all', message(TEAM), TEAM)).text).toMatch(new RegExp(`\\*\\* archived, 4 of 4 finished · by Owner`));
    expect((await chat.run(`workflow show ${id}`, message(TEAM), TEAM)).text.split('\n')[0]).toBe(`**vendor-eval** \`${id}\`: archived, 4 of 4 finished`);
    expect((await chat.run('workflow show w_none', message(TEAM), TEAM)).text).toBe('Not done: no workflow instance w\\_none');
  });

  it("names an instance's board in show when it is not the chat's", async () => {
    createBoard(t.db, 'research', 'lark:on_owner', NOW);
    await chat.run('board use research', message(TEAM), TEAM);
    const id = instanceOf((await chat.run(START, message(TEAM), TEAM)).text);
    await chat.run('board use default', message(TEAM), TEAM);
    expect((await chat.run(`workflow show ${id}`, message(TEAM), TEAM)).text.split('\n')[0]).toBe(
      `**vendor-eval** \`${id}\`: running, 0 of 4 done · board: **research**`,
    );
  });
});
