import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CardView } from '../src/channel/types.js';
import type { InboundCardAction } from '../src/core/router.js';
import { commentsOf, eventsOf, gatesOf, getRun, getTask, subscriptionsOf } from '../src/db/kanban-read.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { renderTaskCard } from '../src/kanban/chat-render.js';
import type { GateExit } from '../src/kanban/gates.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import type { RunRow } from '../src/kanban/types.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import type { BindingKey, InboundMention, InboundMessage, Principal } from '../src/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES, role, until } from './helpers/dispatch.js';
import { WORKSPACES } from './helpers/kanban.js';

/**
 * /kanban in chat (spec §9.1): tiers, the identity the board records, people
 * named by @-mention, their own reports and the buttons of their cards, and
 * every change done through the service, with the dispatcher told.
 */

const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const GUEST: Principal = { openId: 'ou_guest', unionId: 'on_guest', displayName: 'Guest' };
const ALICE: Principal = { openId: 'ou_alice', unionId: 'on_alice', displayName: 'Alice Smith' };
const BOB: Principal = { openId: 'ou_bob', unionId: 'on_bob', displayName: 'Bob' };
const NAMELESS: Principal = { openId: 'ou_owner', unionId: null, displayName: 'Owner' };
const KEY: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' };

/** As Lark sends a mention of each: its key, the name the text shows, and the ids. */
const AT_ALICE: InboundMention = { key: '@_user_1', name: 'Alice Smith', openId: 'ou_alice', unionId: 'on_alice' };
const AT_BOB: InboundMention = { key: '@_user_2', name: 'Bob', openId: 'ou_bob', unionId: 'on_bob' };
/** Someone the bot answers nobody for: no talk tier. */
const AT_CAROL: InboundMention = { key: '@_user_3', name: 'Carol', openId: 'ou_carol', unionId: 'on_carol' };

let t: TestDb;
let service: KanbanService;
let chat: KanbanChat;
let passes: number;
let cancelled: string[];
let redrawn: Array<{ messageId: string; view: CardView }>;
/** How the next gate exits, by command: a command missing exits 0. */
let exits: Map<string, Partial<GateExit>>;
/** Gates held until the test lets them go, by command. */
let holds: Map<string, Promise<void>>;
let seq = 0;

beforeEach(() => {
  clearSecrets();
  t = testDb();
  const authorizer = new Authorizer({
    ...defaultAuthConfig(OWNER.openId),
    allowTalk: [OWNER.openId, GUEST.openId, ALICE.openId, BOB.openId],
  });
  const people = new PeopleDirectory({
    db: t.db,
    appId: 'cli_app',
    canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }),
  });
  exits = new Map();
  holds = new Map();
  service = new KanbanService({
    db: t.db,
    roles: new Map(
      [...DEFAULT_ROLES, role('default'), role('watched', { agent: { ...DEFAULT_ROLES[0]!.agent, unsupervised: false } })].map(
        (r) => [r.name, r],
      ),
    ),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
    people,
    supervisedRoles: true,
    checks: {
      workspaceDirs: new Map([...WORKSPACES].map((w) => [w, `/ws/${w}`])),
      env: {},
      runGate: async (command, opts) => {
        // A held gate ends when the test lets it go, or when the gateway stops, as a killed one does.
        const stopped = new Promise<'stopped'>((resolve) => opts.signal?.addEventListener('abort', () => resolve('stopped')));
        if ((await Promise.race([holds.get(command), stopped])) === 'stopped') {
          return { exitCode: null, signal: 'SIGTERM', timedOut: false, output: '' };
        }
        return { exitCode: 0, signal: null, timedOut: false, output: '', ...exits.get(command) };
      },
    },
  });
  passes = 0;
  cancelled = [];
  redrawn = [];
  chat = new KanbanChat({
    service,
    hasTier: (p, tier) => authorizer.hasTier(p, tier),
    people,
    appId: 'cli_app',
    redraw: async (messageId, view) => {
      redrawn.push({ messageId, view });
    },
    changed: () => (passes += 1),
    cancel: (runId) => cancelled.push(runId),
  });
});
afterEach(() => {
  clearSecrets();
  t.close();
});

function message(sender: Principal = OWNER, messageId = `om_${++seq}`, mentions: InboundMention[] = []): InboundMessage {
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
    mentions,
    attachments: [],
    createTime: 0,
  };
}

function say(arg: string, sender: Principal = OWNER, mentions: InboundMention[] = []): Promise<string> {
  return chat.run(arg, message(sender, undefined, mentions), KEY);
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
      `Created \`${taskId}\`: **Draft the Q3 summary**, for role docs-writer, in docs. ` +
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
    expect(long).toContain(`: **${'x'.repeat(199)}…**, for nobody yet`);
  });

  it('makes one task of one message, however often it arrives', async () => {
    const first = created(await chat.run('new Once', message(OWNER, 'om_same'), KEY));
    expect(await chat.run('new Once', message(OWNER, 'om_same'), KEY)).toBe(`Already created, as \`${first}\`.`);
    expect(taskCount()).toBe(1);
  });

  it('refuses an unknown role or workspace, and an oversized task, creating nothing', async () => {
    expect(await say('new t\nassignee: nobody-here')).toBe('Not done: role "nobody-here" is not configured');
    expect(await say('new t\nassignee: implementer\nworkspace: nowhere')).toBe(
      'Not done: workspace "nowhere" is not configured',
    );
    expect(await say(`new ${'t'.repeat(513)}`)).toBe('A title is at most 512 bytes; put the rest in the body.');
    expect(await say('new t\noutcome: ' + 'x'.repeat(8193))).toBe("The contract's outcome is at most 8192 bytes.");
    expect(taskCount()).toBe(0);
  });

  it("gives a task to a role whose agent is supervised: its approvals go to the chat that follows it", async () => {
    const taskId = created(await say('new Rotate the logs\nassignee: watched'));
    expect(getTask(t.db, taskId)?.assignee).toEqual({ kind: 'role', name: 'watched' });
  });
});

describe('people, named by @-mention', () => {
  it('gives a task to the person a mention names, by their union_id, and says they get a card', async () => {
    const reply = await say('new Check the links\nassignee: @Alice Smith\nreviewer: @Bob', OWNER, [AT_ALICE, AT_BOB]);
    const taskId = created(reply);
    expect(reply).toBe(
      `Created \`${taskId}\`: **Check the links**, for Alice Smith (lark:on\\_alice). ` +
        'They are sent it as a card, in a direct message, once it is ready. ' +
        'This chat hears when it is done, needs review, blocks, is retried after a failure, gives up or is stranded.',
    );
    expect(getTask(t.db, taskId)).toMatchObject({
      assignee: { kind: 'human', name: 'lark:on_alice' },
      reviewer: { kind: 'human', name: 'lark:on_bob' },
    });
    // Once seen, a person may be named by principal too.
    expect(created(await say('new Again\nassignee: lark:on_alice'))).toMatch(/^k_/);
  });

  it('refuses a person without talk tier, one the message does not mention, and one never seen, creating nothing', async () => {
    expect(await say('new t\nassignee: @Carol', OWNER, [AT_CAROL])).toBe(
      '@Carol cannot be given work: being assigned lets a person report on the task, which needs talk tier, ' +
        'and the gateway does not know them to have it.',
    );
    expect(await say('new t\nreviewer: @Dan Lee', OWNER, [AT_ALICE])).toBe(
      '@Dan Lee is not someone this message mentions: type @ and pick them, so Lark says who they are.',
    );
    expect(await say('new t\nassignee: lark:on_stranger')).toMatch(/^lark:on\\_stranger cannot be given work/);
    expect(await say('new t\nassignee: @Alice Smith', OWNER, [{ ...AT_ALICE, unionId: null }])).toMatch(
      /^Lark did not say who @Alice Smith is/,
    );
    expect(taskCount()).toBe(0);
  });

  it('assigns a task to a person, and says when they have it already', async () => {
    const taskId = created(await say('new Survey the vendors\nassignee: implementer'));
    expect(await say(`assign ${taskId} @Alice Smith`, OWNER, [AT_ALICE])).toBe(
      `\`${taskId}\` is now for Alice Smith (lark:on\\_alice).`,
    );
    expect(await say(`assign ${taskId} @Alice Smith`, OWNER, [AT_ALICE])).toBe(
      `\`${taskId}\` is already assigned to Alice Smith (lark:on\\_alice).`,
    );
  });
});

/** A task for Alice, reviewed by Bob, with Alice's run open: what the dispatcher would have claimed. */
/** Alice's task with no reviewer: her done completes it. */
function soloTask(): Promise<{ taskId: string; run: RunRow }> {
  return aliceTask('Check the links', false);
}

async function aliceTask(title = 'Check the links', reviewer = true): Promise<{ taskId: string; run: RunRow }> {
  const taskId = created(
    await say(`new ${title}\nassignee: @Alice Smith${reviewer ? '\nreviewer: @Bob' : ''}`, OWNER, [AT_ALICE, AT_BOB]),
  );
  const claim = service.claim(taskId);
  if (!claim.ok) throw new Error(claim.message);
  return { taskId, run: claim.run };
}

describe("a person's own reports", () => {
  it('lets the assignee report done, at talk tier, and nobody else', async () => {
    const { taskId, run } = await soloTask();
    expect(await say(`done ${taskId} all links answer`, GUEST)).toBe(
      `\`/kanban done\` is for the person a task is assigned to; \`${taskId}\` is for Alice Smith (lark:on\\_alice).`,
    );
    // Not even an operator: done is the assignee's report.
    expect(await say(`done ${taskId} all links answer`)).toMatch(/^`\/kanban done` is for the person a task is assigned to/);
    const before = passes;
    expect(await say(`done ${taskId} all links answer`, ALICE)).toBe(`Done: \`${taskId}\` is complete.`);
    expect(getRun(t.db, run.runId)).toMatchObject({ outcome: 'completed', summary: 'all links answer' });
    expect(getTask(t.db, taskId)?.phase).toBe('done');
    expect(passes).toBe(before + 1);
  });

  it("lets the assignee block their task as needing input, and ask for review of a reviewer they mention", async () => {
    const { taskId } = await aliceTask();
    expect(await say(`block ${taskId} which wiki?`, ALICE)).toBe(
      `Blocked \`${taskId}\` (needs\\_input). An operator unblocks it with \`/kanban unblock ${taskId} [comment]\`.`,
    );
    expect(getTask(t.db, taskId)).toMatchObject({ phase: 'blocked', blockKind: 'needs_input', blockReason: 'which wiki?' });
    expect(await say(`unblock ${taskId}`)).toContain('is unblocked');
    expect(service.claim(taskId).ok).toBe(true);
    expect(await say(`review ${taskId} checked them all\nreviewer: @Bob`, ALICE, [AT_BOB])).toBe(
      `\`${taskId}\` is waiting for review, by Bob (lark:on\\_bob).`,
    );
    expect(getTask(t.db, taskId)).toMatchObject({ phase: 'review', reviewer: { kind: 'human', name: 'lark:on_bob' } });
    // Once in review, the assignee's own reports are not the answer.
    expect(await say(`done ${taskId} x`, ALICE)).toBe(`\`${taskId}\` is review: \`/kanban done\` reports on work being done.`);
  });

  it('lets the named reviewer answer at talk tier, and an operator answer any review', async () => {
    const { taskId } = await aliceTask();
    expect(await say(`approve ${taskId}`, BOB)).toBe(`\`${taskId}\` is not waiting for review: it is open.`);
    expect(await say(`review ${taskId} checked them all`, ALICE)).toContain('is waiting for review, by Bob');
    expect(await say(`approve ${taskId}`, GUEST)).toBe(
      `\`/kanban approve\` answers a review, and is for \`${taskId}\`'s reviewer (Bob (lark:on\\_bob)) or an operator.`,
    );
    expect(await say(`changes ${taskId} cite the source of each link`, BOB)).toBe(
      `Changes requested on \`${taskId}\`: it goes back to its assignee, with your reason.`,
    );
    expect(getTask(t.db, taskId)?.phase).toBe('open');
    expect(service.claim(taskId).ok).toBe(true);
    expect(await say(`review ${taskId} sources added`, ALICE)).toContain('is waiting for review');
    // An operator answers a review that is not theirs.
    expect(await say(`approve ${taskId} fine by me`)).toBe(`Approved: \`${taskId}\` is complete.`);
    expect(getTask(t.db, taskId)?.phase).toBe('done');
  });

  it("lets an operator answer a role's review", async () => {
    const taskId = created(await say('new Fix the footer\nassignee: implementer\nreviewer: reviewer'));
    const work = service.claim(taskId);
    if (!work.ok) throw new Error(work.message);
    expect((await service.requestReview(taskId, { kind: 'run', runId: work.run.runId }, { summary: 'moved it' })).ok).toBe(true);
    expect(service.closeRun(work.run.runId).ok).toBe(true);
    expect(await say(`changes ${taskId} keep the old colour`)).toContain('Changes requested on');
    expect(getTask(t.db, taskId)?.phase).toBe('open');
  });

  it("sends the assignee's done for review when the task names a reviewer, and says so", async () => {
    const { taskId, run } = await aliceTask();
    expect(await say(`gate add ${taskId} test -f links.md`)).toContain('Gate 1 added');
    expect(await say(`done ${taskId} all links answer`, ALICE)).toBe(
      `Sent \`${taskId}\` for review to Bob (lark:on\\_bob): the task names a reviewer, so done asks for review.`,
    );
    expect(getRun(t.db, run.runId)).toMatchObject({ outcome: 'review_requested', summary: 'all links answer' });
    expect(getTask(t.db, taskId)?.phase).toBe('review');
    // The gates ran once, as for a review.
    expect(eventsOf(t.db, taskId).filter((e) => e.kind === 'gates_ran').map((e) => (e.payload as { for: string }).for)).toEqual(['review']);
    expect(eventsOf(t.db, taskId).map((e) => e.kind)).toContain('review_requested');
  });

  it("lets an operator answer a role's review while its run is open, ending that run", async () => {
    const taskId = created(await say('new Fix the footer\nassignee: implementer\nreviewer: reviewer'));
    const work = service.claim(taskId);
    if (!work.ok) throw new Error(work.message);
    expect((await service.complete(taskId, { kind: 'run', runId: work.run.runId }, { summary: 'moved it' })).ok).toBe(true);
    expect(service.closeRun(work.run.runId).ok).toBe(true);
    const review = service.claim(taskId);
    if (!review.ok) throw new Error(review.message);
    // Not someone who is neither the reviewer nor an operator.
    expect(await say(`approve ${taskId}`, GUEST)).toBe(
      `\`/kanban approve\` answers a review, and is for \`${taskId}\`'s reviewer (role reviewer) or an operator.`,
    );
    expect(getRun(t.db, review.run.runId)?.outcome).toBeNull();
    // Its gates run in the workspace the reviewer's own run holds: that run is not another task's agent.
    expect(await say(`gate add ${taskId} test -f footer.css`)).toContain('Gate 1 added');
    expect(await say(`approve ${taskId} fine by me`)).toBe(`Approved: \`${taskId}\` is complete; the review run of role reviewer was ended.`);
    expect(getTask(t.db, taskId)?.phase).toBe('done');
    expect(getRun(t.db, review.run.runId)?.outcome).toBe('superseded');
    expect(cancelled).toEqual([review.run.runId]);
    expect(eventsOf(t.db, taskId).filter((e) => e.kind === 'gates_ran')).toHaveLength(1);
    // The reviewer's own report, later, is refused.
    expect(await service.complete(taskId, { kind: 'run', runId: review.run.runId }, { summary: 'approved' })).toMatchObject({
      ok: false,
      code: 'run_superseded',
    });
  });

  it("lets an operator ask for changes while a role's review run is open, and the rework goes to the assignee", async () => {
    const taskId = created(await say('new Fix the footer\nassignee: implementer\nreviewer: reviewer'));
    const work = service.claim(taskId);
    if (!work.ok) throw new Error(work.message);
    expect((await service.requestReview(taskId, { kind: 'run', runId: work.run.runId }, { summary: 'moved it' })).ok).toBe(true);
    expect(service.closeRun(work.run.runId).ok).toBe(true);
    const review = service.claim(taskId);
    if (!review.ok) throw new Error(review.message);
    expect(await say(`changes ${taskId} keep the old colour`)).toBe(
      `Changes requested on \`${taskId}\`: it goes back to its assignee, with your reason; the review run of role reviewer was ended.`,
    );
    expect(cancelled).toEqual([review.run.runId]);
    expect(service.closeRun(review.run.runId).ok).toBe(true);
    const rework = service.claim(taskId);
    expect(rework).toMatchObject({ ok: true, run: { kind: 'work', assignee: { kind: 'role', name: 'implementer' } } });
  });

  it("shows a gate's refusal, its output masked and escaped, and applies nothing", async () => {
    const { taskId, run } = await aliceTask();
    expect(await say(`gate add ${taskId} test -f links.md`)).toContain('Gate 1 added');
    addSecrets(['sk-gate-12345678']);
    exits.set('test -f links.md', { exitCode: 1, output: 'no links.md <at id=all></at> sk-gate-12345678' });
    const reply = await say(`done ${taskId} all links answer`, ALICE);
    expect(reply).toBe(
      'Not done: the gate test -f links.md exited 1, so the report was not applied. Fix it, then report again.\n' +
        `Its output:\n> no links.md \\<at id=all\\>\\</at\\> ${MASK}`,
    );
    expect(getRun(t.db, run.runId)?.outcome).toBeNull();
  });

  it('refuses a typed done on a run the task no longer has, once its gates are done: reassigned while they ran', async () => {
    const { taskId, run } = await aliceTask();
    expect(await say(`gate add ${taskId} test -f links.md`)).toContain('Gate 1 added');
    let release!: () => void;
    holds.set('test -f links.md', new Promise<void>((resolve) => (release = resolve)));
    const reply = say(`done ${taskId} all links answer`, ALICE);
    await new Promise((resolve) => setImmediate(resolve));
    // While the gates run, the task is given to someone else.
    expect(await say(`assign ${taskId} implementer`)).toContain('is now for role implementer');
    release();
    expect(await reply).toBe(`Not done: run ${run.runId.replace(/_/g, '\\_')} of task ${taskId.replace(/_/g, '\\_')} is over: the task has moved on since this report was made`);
    expect(getTask(t.db, taskId)).toMatchObject({ phase: 'open', assignee: { kind: 'role', name: 'implementer' } });
  });

  it('refuses a typed done made while no run was open, once the task is reassigned while its gates run', async () => {
    // Not claimed: the person reports with no run open.
    const taskId = created(await say('new Check the links\nassignee: @Alice Smith\nworkspace: docs', OWNER, [AT_ALICE]));
    expect(await say(`gate add ${taskId} test -f links.md`)).toContain('Gate 1 added');
    let release!: () => void;
    holds.set('test -f links.md', new Promise<void>((resolve) => (release = resolve)));
    const reply = say(`done ${taskId} all links answer`, ALICE);
    await new Promise((resolve) => setImmediate(resolve));
    expect(await say(`assign ${taskId} implementer`)).toContain('is now for role implementer');
    release();
    expect(await reply).toMatch(/^Not done: .*the task has moved on since this report was made/);
    expect(getTask(t.db, taskId)).toMatchObject({ phase: 'open', assignee: { kind: 'role', name: 'implementer' } });
  });

  it("refuses a typed approve of a review not yet claimed, once its reviewer is changed while the gates run", async () => {
    const { taskId } = await aliceTask();
    expect(await say(`review ${taskId} checked them all`, ALICE)).toContain('is waiting for review, by Bob');
    expect(await say(`gate add ${taskId} test -f links.md`)).toContain('Gate 1 added');
    let release!: () => void;
    holds.set('test -f links.md', new Promise<void>((resolve) => (release = resolve)));
    const reply = say(`approve ${taskId} fine`, BOB);
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.assignReviewer(taskId, 'reviewer', 'lark:on_owner').ok).toBe(true);
    release();
    expect(await reply).toMatch(/^Not done: .*the task has moved on since this report was made/);
    expect(getTask(t.db, taskId)).toMatchObject({ phase: 'review', reviewer: { kind: 'role', name: 'reviewer' } });
  });

  it("lets the named assignee's comment steer, as an operator's does", async () => {
    const { taskId } = await aliceTask();
    expect(await say(`comment ${taskId} the wiki moved`, ALICE)).toContain('An agent working on it gets it');
    expect(await say(`comment ${taskId} the reviewer agrees`, BOB)).toContain('An agent working on it gets it');
    expect(await say(`comment ${taskId} me too`, GUEST)).toContain('for people');
    expect(commentsOf(t.db, taskId, { steering: true }).map((c) => c.author)).toEqual(['lark:on_alice', 'lark:on_bob']);
  });
});

describe("a person's card", () => {
  /** Press a button of the run's card as `presser`, with what the box held; the value as given, or as the card has it. */
  function press(
    run: RunRow,
    act: string,
    presser: Principal,
    input?: string,
    value: Record<string, unknown> = {},
  ): Promise<string> {
    const card = renderTaskCard({ task: getTask(t.db, run.taskId)!, run, parents: [] }, 'cli_app');
    const base = card.buttons.find((b) => b.value['act'] === 'done')?.value ?? {};
    const action: InboundCardAction = {
      chatId: 'oc_dm',
      messageId: 'om_card',
      operator: presser,
      value: { ...base, act, ...value },
      ...(input === undefined ? {} : { input }),
    };
    return chat.card(action);
  }

  it("answers at once, reports through the card's run in the background, and redraws the card as worked on, then with what happened", async () => {
    const { taskId, run } = await soloTask();
    expect(await say(`gate add ${taskId} test -f links.md`)).toContain('Gate 1 added');
    let release!: () => void;
    holds.set('test -f links.md', new Promise<void>((resolve) => (release = resolve)));
    // Answered before the gate ends: Lark waits about three seconds for a callback's answer.
    expect(await press(run, 'done', ALICE, 'all links answer')).toBe(`Completing \`${taskId}\`: the card shows how it goes.`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(getRun(t.db, run.runId)?.outcome).toBeNull();
    expect(redrawn.map((r) => r.view.markdown)).toEqual([`**Check the links** \`${taskId}\`\nWorking on it…`]);
    release();
    expect(await chat.idle(5_000)).toBe(true);
    expect(getRun(t.db, run.runId)).toMatchObject({ outcome: 'completed', summary: 'all links answer' });
    expect(redrawn.at(-1)).toEqual({
      messageId: 'om_card',
      view: { markdown: `**Check the links** \`${taskId}\`\nDone by Alice Smith.`, buttons: [] },
    });
  });

  it('sends a Done pressed on a task that names a reviewer for review, and the card says so', async () => {
    const { taskId, run } = await aliceTask();
    expect(await press(run, 'done', ALICE, 'all links answer')).toBe(`Completing \`${taskId}\`: the card shows how it goes.`);
    expect(await chat.idle(5_000)).toBe(true);
    expect(getRun(t.db, run.runId)).toMatchObject({ outcome: 'review_requested', summary: 'all links answer' });
    expect(getTask(t.db, taskId)?.phase).toBe('review');
    expect(redrawn.at(-1)?.view.markdown).toBe(
      `**Check the links** \`${taskId}\`\nSent for review to Bob (lark:on\\_bob) by Alice Smith.`,
    );
  });

  it("names a presser it has no name for through Lark's person element, not their id", async () => {
    const { taskId, run } = await soloTask();
    await press(run, 'done', { ...ALICE, displayName: null }, 'all links answer');
    expect(await chat.idle(5_000)).toBe(true);
    expect(redrawn.at(-1)).toEqual({
      messageId: 'om_card',
      view: { markdown: `**Check the links** \`${taskId}\`\nDone.`, buttons: [], byOpenId: 'ou_alice' },
    });
  });

  it('redraws a card it refused for what a press carried live, saying why, with buttons a new press can be made with', async () => {
    const { taskId, run } = await aliceTask();
    expect(await press(run, 'block', ALICE, '  ')).toBe('Type why it is blocked in the box, then press Block.');
    const first = redrawn.at(-1)?.view;
    expect(first?.markdown).toContain('**Not done.** Type why it is blocked in the box, then press Block.');
    // The value differs from the button pressed, first: the SDK drops a press it has seen, by the value's start.
    expect(first?.buttons.map((b) => Object.keys(b.value)[0])).toEqual(['try', 'try']);
    expect(first?.buttons.map((b) => b.value['try'])).toEqual(['1', '1']);
    // And in the buttons' names, which the SDK keys a press on whole: the card carries the attempt.
    expect(first?.attempt).toBe(1);
    // A gate's refusal, in the background, the same way; the attempt goes on from the button pressed.
    expect(await say(`gate add ${taskId} test -f links.md`)).toContain('Gate 1 added');
    exits.set('test -f links.md', { exitCode: 1, output: 'no links.md' });
    await press(run, 'done', ALICE, 'all links answer', { try: '1' });
    await chat.idle(5_000);
    const second = redrawn.at(-1)?.view;
    // Said once: the card's own "Not done." heads the board's refusal.
    expect(second?.markdown).toContain('**Not done.** The gate test -f links.md exited 1');
    expect(second?.markdown).not.toContain('Not done:');
    expect(second?.markdown).toContain('> no links.md');
    expect(second?.buttons.map((b) => [b.label, b.value['try']])).toEqual([
      ['Done', '2'],
      ['Block', '2'],
    ]);
    expect(second?.attempt).toBe(2);
    // An attempt that cannot be read starts over.
    await press(run, 'block', ALICE, '', { try: 'x' });
    expect(redrawn.at(-1)?.view.attempt).toBe(1);
    expect(getRun(t.db, run.runId)?.outcome).toBeNull();
  });

  it('takes no second press of a card while one is worked on, so neither redraws over the other', async () => {
    const { taskId, run } = await soloTask();
    expect(await say(`gate add ${taskId} test -f links.md`)).toContain('Gate 1 added');
    let release!: () => void;
    holds.set('test -f links.md', new Promise<void>((resolve) => (release = resolve)));
    await press(run, 'done', ALICE, 'all links answer');
    expect(await press(run, 'block', ALICE, '')).toBe('That card is being worked on: it shows the outcome when it is done.');
    await new Promise((resolve) => setImmediate(resolve));
    expect(redrawn.map((r) => r.view.markdown)).toEqual([`**Check the links** \`${taskId}\`\nWorking on it…`]);
    release();
    await chat.idle(5_000);
    expect(redrawn.at(-1)?.view.markdown).toContain('Done by Alice Smith.');
  });

  it('redraws a card as out of date, not live, when its run ended while the refused report ran', async () => {
    const { taskId, run } = await aliceTask();
    expect(await say(`gate add ${taskId} test -f links.md`)).toContain('Gate 1 added');
    let release!: () => void;
    holds.set('test -f links.md', new Promise<void>((resolve) => (release = resolve)));
    exits.set('test -f links.md', { exitCode: 1, output: 'no links.md' });
    await press(run, 'done', ALICE, 'all links answer');
    await new Promise((resolve) => setImmediate(resolve));
    expect(await say(`stop ${taskId}`)).toContain('Stopped');
    release();
    await chat.idle(5_000);
    expect(redrawn.at(-1)?.view).toEqual({
      markdown: `**Check the links** \`${taskId}\`\nThis card is out of date: the task has moved on since it was sent.`,
      buttons: [],
    });
  });

  it("kills a press's gates when the gateway stops, applying nothing, and says so on the card", async () => {
    const { taskId, run } = await aliceTask();
    expect(await say(`gate add ${taskId} test -f links.md`)).toContain('Gate 1 added');
    holds.set('test -f links.md', new Promise<void>(() => undefined));
    await press(run, 'done', ALICE, 'all links answer');
    await new Promise((resolve) => setImmediate(resolve));
    chat.stop();
    expect(await chat.idle(5_000)).toBe(true);
    expect(getRun(t.db, run.runId)?.outcome).toBeNull();
    expect(redrawn.at(-1)?.view.markdown).toContain('**Not done.** The gateway is stopping');
    // A typed report's gates too.
    const typed = say(`done ${taskId} again`, ALICE);
    expect(await typed).toContain('the gateway is stopping');
  });

  /** A chat whose redraw is `redraw`, waited for `ms`, its notes in `notes`. */
  function chatWith(redraw: (messageId: string, view: CardView) => Promise<void>, ms: number, notes: string[]): KanbanChat {
    return new KanbanChat({
      service,
      hasTier: (p, tier) => new Authorizer({ ...defaultAuthConfig(OWNER.openId), allowTalk: [OWNER.openId, ALICE.openId] }).hasTier(p, tier),
      people: new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: () => true }),
      appId: 'cli_app',
      redraw,
      redrawTimeoutMs: ms,
      note: (line) => notes.push(line),
    });
  }

  function doneAction(run: RunRow, input: string): InboundCardAction {
    const card = renderTaskCard({ task: getTask(t.db, run.taskId)!, run, parents: [] }, 'cli_app');
    const value = card.buttons.find((b) => b.value['act'] === 'done')?.value ?? {};
    return { chatId: 'oc_dm', messageId: 'om_card', operator: ALICE, value, input };
  }

  it('bounds a redraw that never answers: the press ends, the card is not held, and an ended run is still told out of date', async () => {
    const notes: string[] = [];
    let first = true;
    // The first redraw never answers, as an update with no timeout of its own may not.
    const hung = chatWith(
      async (messageId, view) => {
        if (first) {
          first = false;
          return new Promise<void>(() => undefined);
        }
        redrawn.push({ messageId, view });
      },
      50,
      notes,
    );
    const { taskId, run } = await aliceTask();
    expect(await say(`gate add ${taskId} test -f links.md`)).toContain('Gate 1 added');
    let release!: () => void;
    holds.set('test -f links.md', new Promise<void>((resolve) => (release = resolve)));
    const action = doneAction(run, 'all links answer');
    await hung.card(action);
    await new Promise((resolve) => setImmediate(resolve));
    // While the press's gates run, the run ends another way; a press of the card is told it is out of date.
    expect(await say(`stop ${taskId}`)).toContain('Stopped');
    expect(await hung.card(action)).toBe(`That card is out of date: \`${taskId}\` has moved on. \`/kanban show ${taskId}\` says where it is.`);
    release();
    expect(await hung.idle(5_000)).toBe(true);
    expect(notes).toContain('kanban: redrawing card om_card took longer than 50 ms; going on without it');
    expect(redrawn.at(-1)?.view.markdown).toContain('This card is out of date');
  });

  it('applies a press at once while its "Working on it" redraw hangs, and redraws the outcome only after it', async () => {
    const notes: string[] = [];
    const order: string[] = [];
    let first = true;
    const hung = chatWith(
      async (_messageId, view) => {
        if (first) {
          first = false;
          order.push('working');
          return new Promise<void>(() => undefined);
        }
        order.push(view.markdown);
      },
      1_000,
      notes,
    );
    const { run } = await soloTask();
    await hung.card(doneAction(run, 'all links answer'));
    // Applied long before the hung redraw is given up on.
    await until(() => getRun(t.db, run.runId)?.outcome === 'completed', 'the press to be applied');
    expect(getRun(t.db, run.runId)).toMatchObject({ outcome: 'completed', summary: 'all links answer' });
    expect(order).toEqual(['working']);
    expect(await hung.idle(5_000)).toBe(true);
    expect(order).toHaveLength(2);
    expect(order[1]).toContain('Done by Alice Smith.');
  });

  it('applies a press whose redraw throws at once, and notes the failure', async () => {
    const notes: string[] = [];
    const throws = chatWith(
      (() => {
        throw new Error('no card update');
      }) as (messageId: string, view: CardView) => Promise<void>,
      1_000,
      notes,
    );
    const { run } = await soloTask();
    await throws.card(doneAction(run, 'all links answer'));
    expect(await throws.idle(5_000)).toBe(true);
    expect(getRun(t.db, run.runId)).toMatchObject({ outcome: 'completed', summary: 'all links answer' });
    expect(notes).toContain('kanban: redrawing card om_card failed: no card update');
  });

  it("refuses a press on a card for a run that is not a person's, changing nothing", async () => {
    const taskId = created(await say('new Fix the footer\nassignee: implementer\nreviewer: reviewer'));
    const work = service.claim(taskId);
    if (!work.ok) throw new Error(work.message);
    expect(await press(work.run, 'done', OWNER, 'x')).toBe("That button is not for a person's card.");
    expect((await service.requestReview(taskId, { kind: 'run', runId: work.run.runId }, { summary: 'moved it' })).ok).toBe(true);
    expect(service.closeRun(work.run.runId).ok).toBe(true);
    const review = service.claim(taskId);
    if (!review.ok) throw new Error(review.message);
    // Even an operator, who may answer any review: a role's review run has no card.
    expect(await press(review.run, 'approve', OWNER, 'fine')).toBe("That button is not for a person's card.");
    await chat.idle(5_000);
    expect(redrawn).toEqual([]);
    expect(getRun(t.db, review.run.runId)?.outcome).toBeNull();
  });

  it('refuses a press by someone else, and an altered payload, changing nothing, the card left as it was', async () => {
    const { run } = await aliceTask();
    expect(await press(run, 'done', BOB, 'x')).toBe('This card is for Alice Smith (lark:on\\_alice).');
    expect(await press(run, 'done', ALICE, 'x', { run: 'r_other' })).toBe('That button does not match the card it is on.');
    expect(await press(run, 'done', { openId: 'ou_stranger', unionId: 'on_stranger', displayName: 'S' }, 'x')).toBe(
      'You are not on the allowlist.',
    );
    await chat.idle(5_000);
    expect(redrawn).toEqual([]);
    expect(getRun(t.db, run.runId)?.outcome).toBeNull();
  });

  it('does nothing for a card whose run is over, and redraws it as out of date', async () => {
    const { taskId, run } = await soloTask();
    expect(await say(`done ${taskId} typed it instead`, ALICE)).toContain('is complete');
    expect(await press(run, 'done', ALICE, 'again')).toBe(
      `That card is out of date: \`${taskId}\` has moved on. \`/kanban show ${taskId}\` says where it is.`,
    );
    expect(redrawn.map((r) => r.view.markdown)).toEqual([
      `**Check the links** \`${taskId}\`\nThis card is out of date: the task has moved on since it was sent.`,
    ]);
    expect(getRun(t.db, run.runId)?.summary).toBe('typed it instead');
  });

  it("unblocks from a notice's button at operator tier, once", async () => {
    const { taskId } = await aliceTask();
    expect(await say(`block ${taskId} which wiki?`, ALICE)).toContain('Blocked');
    const blocked = eventsOf(t.db, taskId).findLast((e) => e.kind === 'blocked');
    if (blocked === undefined) throw new Error('not blocked');
    const { unblockButton } = await import('../src/kanban/chat-render.js');
    const value = unblockButton('cli_app', blocked).value;
    const action = (presser: Principal): InboundCardAction => ({ chatId: 'oc_team', messageId: 'om_notice', operator: presser, value });
    expect(await chat.card(action(ALICE))).toBe('Unblock changes the board, and needs operator permission.');
    expect(await chat.card(action(OWNER))).toBe(`\`${taskId}\` is unblocked, back to open.`);
    expect(await chat.card(action(OWNER))).toBe(
      `\`${taskId}\` is not blocked as that notice said any more: \`/kanban show ${taskId}\` says where it is.`,
    );
  });
});

describe('tiers and identity', () => {
  it('lets a talk-tier sender read and comment, and refuses every change of the board', async () => {
    const taskId = created(await say('new A task\nassignee: implementer'));
    expect(await say('list', GUEST)).toContain(taskId);
    expect(await say(`show ${taskId}`, GUEST)).toContain('**A task**');
    expect(await say(`gate list ${taskId}`, GUEST)).toBe(`Task \`${taskId}\` has no gates.`);
    expect(await say(`comment ${taskId} the 2024 figures, please`, GUEST)).toBe(
      `Comment added to \`${taskId}\`, for people: \`/kanban show\` shows it. Only an operator's comment, or its assignee's or reviewer's, is given to the task's agent.`,
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
    expect(await say(`assign ${child} @Carol Jones`)).toBe(
      '@Carol Jones is not someone this message mentions: type @ and pick them, so Lark says who they are.',
    );
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

describe('a wrong command line', () => {
  it('is answered with its usage, and an unknown task as the board says', async () => {
    expect(await say('done k_missing finished', ALICE)).toBe('Not done: no task k\\_missing');
    expect(await say('show')).toBe('Usage: `/kanban show <task>`');
    expect(await say('show k_missing')).toBe('Not done: no task k\\_missing');
    expect(await say('')).toContain('**The task board.**');
  });
});
