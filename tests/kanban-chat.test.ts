import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commentsOf, eventsOf, gatesOf, getRun, getTask, subscriptionsOf } from '../src/db/kanban-read.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { KanbanService } from '../src/kanban/service.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import type { BindingKey, InboundMessage, Principal } from '../src/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES, role } from './helpers/dispatch.js';
import { WORKSPACES } from './helpers/kanban.js';

/**
 * /kanban in chat (spec §9.1): tiers, the identity the board records, the
 * refusals of what arrives in a later update (plan D2), and every change done through the
 * service, with the dispatcher told.
 */

const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const GUEST: Principal = { openId: 'ou_guest', unionId: 'on_guest', displayName: 'Guest' };
const NAMELESS: Principal = { openId: 'ou_owner', unionId: null, displayName: 'Owner' };
const KEY: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' };

let t: TestDb;
let service: KanbanService;
let chat: KanbanChat;
let passes: number;
let cancelled: string[];
let seq = 0;

beforeEach(() => {
  clearSecrets();
  t = testDb();
  service = new KanbanService({
    db: t.db,
    roles: new Map(
      [...DEFAULT_ROLES, role('watched', { agent: { ...DEFAULT_ROLES[0]!.agent, unsupervised: false } })].map((r) => [
        r.name,
        r,
      ]),
    ),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
  });
  const authorizer = new Authorizer({ ...defaultAuthConfig(OWNER.openId), allowTalk: [OWNER.openId, GUEST.openId] });
  passes = 0;
  cancelled = [];
  chat = new KanbanChat({
    service,
    hasTier: (p, tier) => authorizer.hasTier(p, tier),
    changed: () => (passes += 1),
    cancel: (runId) => cancelled.push(runId),
  });
});
afterEach(() => {
  clearSecrets();
  t.close();
});

function message(sender: Principal = OWNER, messageId = `om_${++seq}`): InboundMessage {
  return {
    messageId,
    appId: 'cli_app',
    chatId: 'oc_team',
    chatType: 'group',
    threadId: 'omt_topic',
    sender,
    senderIsBot: false,
    text: '',
    mentionedBot: true,
    mentionAll: false,
    attachments: [],
    createTime: 0,
  };
}

function say(arg: string, sender: Principal = OWNER): Promise<string> {
  return chat.run(arg, message(sender), KEY);
}

/** The id of the task a `Created` reply names. */
function created(reply: string): string {
  const m = /^Created `(k_[0-9a-z]+)`/.exec(reply);
  if (m?.[1] === undefined) throw new Error(`not created: ${reply}`);
  return m[1];
}

function taskCount(): number {
  return t.db.prepare<[], { n: number }>('SELECT count(*) AS n FROM kanban_tasks').get()?.n ?? 0;
}

describe('/kanban new', () => {
  it("creates a task from its field lines, as the sender, from this chat, which follows it; and looks for work", async () => {
    const reply = await say('new Draft the Q3 summary\nassignee: docs-writer\nworkspace: docs\noutcome: a page in the wiki\nUse last quarter as the model.');
    const taskId = created(reply);
    expect(reply).toBe(
      `Created \`${taskId}\` — **Draft the Q3 summary**, for role docs-writer, in docs. ` +
        'This chat hears when it is done, needs review, blocks, is retried after a failure, gives up or is stranded.',
    );
    expect(getTask(t.db, taskId)).toMatchObject({
      title: 'Draft the Q3 summary',
      body: 'Use last quarter as the model.',
      contract: { outcome: 'a page in the wiki' },
      assignee: { kind: 'role', name: 'docs-writer' },
      workspace: 'docs',
      createdBy: 'lark:on_owner',
      createdVia: { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' },
    });
    expect(subscriptionsOf(t.db, taskId).map((s) => [s.conversationId, s.threadId])).toEqual([['oc_team', 'omt_topic']]);
    expect(passes).toBe(1);
    // A long title is shown cut to 200 characters, on one line.
    const long = await say(`new ${'x'.repeat(300)}`);
    expect(long).toContain(` — **${'x'.repeat(199)}…**, for nobody yet`);
  });

  it('makes one task of one message, however often it arrives', async () => {
    const first = created(await chat.run('new Once', message(OWNER, 'om_same'), KEY));
    expect(await chat.run('new Once', message(OWNER, 'om_same'), KEY)).toBe(`Already created, as \`${first}\`.`);
    expect(taskCount()).toBe(1);
  });

  it('refuses an unknown role or workspace, a person, and a supervised role, creating nothing', async () => {
    expect(await say('new t\nassignee: nobody-here')).toBe('Not done: role "nobody-here" is not configured');
    expect(await say('new t\nassignee: implementer\nworkspace: nowhere')).toBe(
      'Not done: workspace "nowhere" is not configured',
    );
    for (const line of ['assignee: @Alice', 'reviewer: @Bob', 'assignee: lark:on_alice']) {
      expect(await say(`new t\n${line}`)).toBe(
        'Assigning a task to a person, or naming one as its reviewer, arrives in a later update. ' +
          'For now a task is given to a role: name it as a bare word, such as `implementer`.',
      );
    }
    expect(await say('new t\nassignee: watched')).toBe(
      'role "watched" has a supervised agent; its approval requests cannot be forwarded to a chat yet. That arrives in a later update.',
    );
    expect(await say(`new ${'t'.repeat(513)}`)).toBe('A title is at most 512 bytes; put the rest in the body.');
    expect(await say('new t\noutcome: ' + 'x'.repeat(8193))).toBe("The contract's outcome is at most 8192 bytes.");
    expect(taskCount()).toBe(0);
  });
});

describe('tiers and identity', () => {
  it('lets a talk-tier sender read and comment, and refuses every change of the board', async () => {
    const taskId = created(await say('new A task\nassignee: implementer'));
    expect(await say('list', GUEST)).toContain(taskId);
    expect(await say(`show ${taskId}`, GUEST)).toContain('**A task**');
    expect(await say(`gate list ${taskId}`, GUEST)).toBe(`Task \`${taskId}\` has no gates.`);
    expect(await say(`comment ${taskId} the 2024 figures, please`, GUEST)).toBe(
      `Comment added to \`${taskId}\`, for people: \`/kanban show\` shows it. Only an operator's comment is given to the task's agent.`,
    );
    expect(await say(`comment ${taskId} use the 2023 figures`)).toContain('An agent working on it gets it');
    expect(commentsOf(t.db, taskId).map((c) => [c.author, c.body])).toEqual([
      ['lark:on_guest', 'the 2024 figures, please'],
      ['lark:on_owner', 'use the 2023 figures'],
    ]);
    // Shown to people, and only the operator's steers the agent.
    expect(commentsOf(t.db, taskId, { steering: true }).map((c) => c.author)).toEqual(['lark:on_owner']);
    expect(await say(`show ${taskId}`, GUEST)).toContain('> the 2024 figures, please');
    const before = eventsOf(t.db, taskId).length;
    for (const arg of [
      'new Another',
      `assign ${taskId} reviewer`,
      `link ${taskId} ${taskId}`,
      `workspace ${taskId} web`,
      `unblock ${taskId}`,
      `stop ${taskId}`,
      `archive ${taskId}`,
      `gate add ${taskId} true`,
      `gate remove ${taskId} 1`,
    ]) {
      expect(await say(arg, GUEST)).toMatch(/^`\/kanban [a-z ]+` changes the board, and needs operator permission\.$/);
    }
    expect(eventsOf(t.db, taskId)).toHaveLength(before);
    expect(taskCount()).toBe(1);
  });

  it('lets a sender Lark gave no union_id read the board, and nothing else', async () => {
    expect(await say('list', NAMELESS)).toBe('No open tasks. `/kanban list all` shows done and archived ones too.');
    expect(await say('new A task', NAMELESS)).toMatch(/^Lark did not say who you are/);
    expect(taskCount()).toBe(0);
  });
});

describe('changing a task', () => {
  it('reassigns, stops and archives, cancelling the turn of the run each decided', async () => {
    const taskId = created(await say('new Survey the vendors\nassignee: implementer'));
    const first = service.claim(taskId);
    if (!first.ok) throw new Error(first.message);
    expect(await say(`assign ${taskId} reviewer`)).toBe(
      `\`${taskId}\` is now for role reviewer; its run \`${first.run.runId}\` was superseded.`,
    );
    expect(cancelled).toEqual([first.run.runId]);
    expect(service.closeRun(first.run.runId).ok).toBe(true);

    const second = service.claim(taskId);
    if (!second.ok) throw new Error(second.message);
    expect(await say(`stop ${taskId}`)).toBe(
      `Stopped \`${taskId}\`: its run was cancelled, and the task is blocked (needs\\_input). \`/kanban unblock ${taskId}\` runs it again.`,
    );
    expect(cancelled).toEqual([first.run.runId, second.run.runId]);
    expect(getTask(t.db, taskId)).toMatchObject({ phase: 'blocked', blockKind: 'needs_input', blockReason: 'stopped by lark:on_owner' });
    expect(service.closeRun(second.run.runId).ok).toBe(true);

    expect(await say(`unblock ${taskId} try the 2024 list`)).toBe(`\`${taskId}\` is unblocked, back to open.`);
    expect(commentsOf(t.db, taskId).at(-1)).toMatchObject({ author: 'lark:on_owner', body: 'try the 2024 list' });
    const third = service.claim(taskId);
    if (!third.ok) throw new Error(third.message);
    expect(await say(`archive ${taskId}`)).toBe(`Archived \`${taskId}\`.`);
    expect(getRun(t.db, third.run.runId)?.outcome).toBe('superseded');
    expect(cancelled).toEqual([first.run.runId, second.run.runId, third.run.runId]);
  });

  it('links two tasks, and sets a workspace while it is not yet fixed', async () => {
    const parent = created(await say('new Collect the numbers\nassignee: implementer'));
    const child = created(await say('new Write them up\nassignee: implementer'));
    expect(await say(`link ${parent} ${child}`)).toBe(`\`${child}\` now waits for \`${parent}\`.`);
    expect(await say(`link ${parent} ${child}`)).toBe(`\`${child}\` already waits for \`${parent}\`.`);
    expect(await say(`workspace ${child} docs`)).toBe(`\`${child}\` works in docs.`);
    expect(await say(`workspace ${child} web`)).toBe(
      `Not done: task ${child.replace(/_/g, '\\_')} works in docs; a fixed workspace does not change`,
    );
    expect(await say(`assign ${child} @Carol Jones`)).toContain('arrives in a later update');
    expect(await say(`assign ${child} implementer`)).toBe(`\`${child}\` is already assigned to role implementer.`);
    expect(eventsOf(t.db, child).some((e) => e.kind === 'assignee_set')).toBe(false);
  });

  it('defines, lists and removes gates as the sender, refusing one that holds a known secret, and shows them masked', async () => {
    const taskId = created(await say('new Publish the page\nassignee: implementer'));
    expect(await say(`gate add ${taskId} --timeout 60 curl -fsS https://wiki.example/page`)).toBe(
      `Gate 1 added to \`${taskId}\` (60 s): curl -fsS https://wiki.example/page`,
    );
    addSecrets(['sk-chat-12345678']);
    expect(await say(`gate add ${taskId} curl -H "k: sk-chat-12345678" https://ci`)).toMatch(
      /^Not done: the gate's command holds a known secret/,
    );
    // A command over several lines is stored as written, and echoed on one line.
    expect(await say(`gate add ${taskId} test -f page.md &&\n  grep -q Summary page.md`)).toBe(
      `Gate 2 added to \`${taskId}\` (300 s): test -f page.md && grep -q Summary page.md`,
    );
    expect(await say(`gate remove ${taskId} 2`)).toBe(`Gate 2 removed from \`${taskId}\`: test -f page.md && grep -q Summary page.md`);
    expect(gatesOf(t.db, taskId).map((g) => [g.command, g.createdBy])).toEqual([
      ['curl -fsS https://wiki.example/page', 'lark:on_owner'],
    ]);
    // Defined before the value was known: listed masked.
    expect(service.addGate(taskId, { command: 'echo sk-late-12345678' }, 'operator:alice').ok).toBe(true);
    addSecrets(['sk-late-12345678']);
    expect(await say(`gate list ${taskId}`)).toContain(`2. echo ${MASK} (300 s, by operator:alice)`);
    expect(await say(`gate remove ${taskId} 1`)).toBe(`Gate 1 removed from \`${taskId}\`: curl -fsS https://wiki.example/page`);
    expect(eventsOf(t.db, taskId).at(-1)).toMatchObject({ kind: 'gate_removed', actor: 'lark:on_owner' });
  });
});

describe('what chat cannot do yet', () => {
  it("answers the people's commands with when they arrive, and a wrong command line with its usage", async () => {
    expect(await say('done k_1 finished')).toBe(
      "`/kanban done` is for a person's own task, and arrives in a later update, with people as assignees and reviewers. " +
        'For now tasks go to roles, whose agents report for themselves.',
    );
    expect(await say('approve k_1')).toContain('arrives in a later update');
    expect(await say('show')).toBe('Usage: `/kanban show <task>`');
    expect(await say('show k_missing')).toBe('Not done: no task k\\_missing');
    expect(await say('')).toContain('**The task board.**');
  });
});
