import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelError, type SendTarget } from '../src/channel/types.js';
import { boardCardUuid } from '../src/core/ids.js';
import { eventsOf } from '../src/db/kanban-read.js';
import { notePerson } from '../src/db/people.js';
import { CardPoster } from '../src/kanban/cards.js';
import { MEMBERS_MS } from '../src/kanban/members.js';
import { KanbanService } from '../src/kanban/service.js';
import type { CreatedVia, RunRow, TaskRow } from '../src/kanban/types.js';
import { clearSecrets } from '../src/secrets.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * Where a person's card goes (spec §19.2): in its task's thread for a member of
 * the group, mentioning them; by direct message otherwise; a direct message that
 * cannot reach them to the thread; a card refused in the thread by direct
 * message, never at the top of the chat; routed afresh at each try; recorded
 * where Lark says it went; and a held task's card kept back.
 */

const ALICE = 'lark:on_alice';
const BOB = 'lark:on_bob';
const TOPIC: CreatedVia = { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' };
const THREAD: SendTarget = { chatId: 'oc_team', threadId: 'omt_topic', root: 'om_root', stayInThread: true };
const dm = (unionId: string): SendTarget => ({ chatId: unionId, threadId: '', receiveIdType: 'union_id' });

let t: TestDb;
let clock: ManualClock;
let service: KanbanService;
let lark: FakeChannel;
let notes: string[];
let held: Set<string>;

beforeEach(() => {
  clearSecrets();
  t = testDb();
  clock = new ManualClock();
  service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock,
    people: { canTalk: (p) => p === ALICE || p === BOB },
  });
  lark = new FakeChannel({ id: 'lark', clock });
  lark.members.set('oc_team', ['on_alice', 'on_owner']);
  // Alice was mentioned in a command, so her open_id for this bot is known; Bob's is not.
  notePerson(t.db, { appId: 'cli_app', unionId: 'on_alice', openId: 'ou_alice', name: 'Alice' }, clock.now());
  notes = [];
  held = new Set();
});
afterEach(() => t.close());

function poster(opts: { sendTimeoutMs?: number } = {}): CardPoster {
  return new CardPoster({
    db: t.db,
    service,
    channel: lark,
    appId: 'cli_app',
    clock,
    note: (line) => notes.push(line),
    held: (taskId) => held.has(taskId),
    ...opts,
  });
}

function ready(assignee = ALICE, createdVia: CreatedVia = TOPIC, title = 'Check the links'): { task: TaskRow; run: RunRow } {
  const r = service.create({ title, assignee, createdBy: ALICE, createdVia });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  const c = service.claim(r.task.taskId);
  if (!c.ok) throw new Error(`${c.code}: ${c.message}`);
  return { task: r.task, run: c.run };
}

function sentPayload(taskId: string): unknown {
  return eventsOf(t.db, taskId).find((e) => e.kind === 'card_sent')?.payload;
}

describe("a person's card, for a task with a thread", () => {
  it("goes in the thread for a member, replying to its root, mentioning them by this bot's open_id, and is recorded there", async () => {
    const { task, run } = ready();
    expect(await poster().deliver()).toBe(1);
    expect(lark.boardCards.map((c) => c.target)).toEqual([THREAD]);
    expect(lark.boardCards[0]?.uuid).toBe(boardCardUuid('cli_app', run.runId));
    expect(lark.boardCards[0]?.view.markdown.startsWith(`<at id=ou_alice></at> 📋 For you to do: **Check the links** \`${task.taskId}\``)).toBe(true);
    expect(sentPayload(task.taskId)).toEqual({ kind: 'work', to: ALICE, messageId: 'om_board_1', in: 'thread' });
    expect(lark.memberLookups).toEqual(['oc_team']);
  });

  it('goes by direct message, unmentioned, to a person not a member, and to anyone when the lookup failed or could not finish', async () => {
    const outside = ready(BOB);
    const p = poster();
    await p.deliver();
    expect(lark.boardCards.map((c) => c.target)).toEqual([dm('on_bob')]);
    expect(lark.boardCards[0]?.view.markdown.startsWith('📋 For you to do: ')).toBe(true);
    expect(sentPayload(outside.task.taskId)).toMatchObject({ in: 'dm' });
    // A new poster, a new boot: the lookup fails.
    lark.failNext('chatMembers', new ChannelError(99991672, 'Access denied', false));
    const failed = ready(ALICE, TOPIC, 'Lookup failed');
    await poster().deliver();
    expect(lark.boardCards.at(-1)?.target).toEqual(dm('on_alice'));
    expect(sentPayload(failed.task.taskId)).toMatchObject({ in: 'dm' });
    // A group past what is read, with Alice not among those read.
    lark.members.set('oc_team', ['on_owner']);
    lark.incomplete.add('oc_team');
    ready(ALICE, TOPIC, 'Large group');
    await poster().deliver();
    expect(lark.boardCards.at(-1)?.target).toEqual(dm('on_alice'));
  });

  it("names a member in plain text, with no mention, when no open_id of theirs is noted", async () => {
    lark.members.set('oc_team', ['on_bob']);
    ready(BOB);
    await poster().deliver();
    expect(lark.boardCards.map((c) => c.target)).toEqual([THREAD]);
    expect(lark.boardCards[0]?.view.markdown).not.toContain('<at id=');
  });

  it('goes to the thread when a direct message cannot reach the person, and is recorded as failed only when there is no thread', async () => {
    const reached = ready(BOB);
    lark.failNext('sendCard', new ChannelError(230013, 'Bot has NO availability to this user', false));
    await poster().deliver();
    expect(lark.boardCards.map((c) => c.target)).toEqual([THREAD]);
    expect(sentPayload(reached.task.taskId)).toMatchObject({ in: 'thread' });
    // No thread: card_failed, as before.
    const nowhere = ready(BOB, VIA, 'At chat scope');
    lark.failNext('sendCard', new ChannelError(230013, 'Bot has NO availability to this user', false));
    await poster().deliver();
    expect(eventsOf(t.db, nowhere.task.taskId).at(-1)).toMatchObject({ kind: 'card_failed', payload: { error: 'Bot has NO availability to this user (code 230013)' } });
    // Refused in the thread too: never back to the direct message, and failed.
    const neither = ready(BOB, TOPIC, 'Refused twice');
    lark.failNext('sendCard', new ChannelError(230013, 'Bot has NO availability to this user', false));
    lark.failNext('sendCard', new ChannelError(232009, 'chat dissolved', false));
    const sends = lark.calls.filter((c) => c === 'sendCard').length;
    await poster().deliver();
    expect(lark.calls.filter((c) => c === 'sendCard').length - sends).toBe(2);
    expect(eventsOf(t.db, neither.task.taskId).at(-1)).toMatchObject({
      kind: 'card_failed',
      payload: { error: "Bot has NO availability to this user (code 230013); and in the task's thread: chat dissolved (code 232009)" },
    });
  });

  it('goes by direct message after any refusal in the thread that will not pass, and never to the top of the chat', async () => {
    for (const code of [230002, 230011, 230017, 230019, 232009, 230018, 230035, 230099, 100290, 404, 400]) {
      const { task } = ready(ALICE, TOPIC, `refused ${code}`);
      lark.failNext('sendCard', new ChannelError(code, `refused ${code}`, false));
      const from = lark.calls.filter((c) => c === 'sendCard').length;
      await poster().deliver();
      const tried = lark.calls.filter((c) => c === 'sendCard').length - from;
      expect(tried).toBe(2);
      expect(lark.boardCards.at(-1)?.target).toEqual(dm('on_alice'));
      // The direct message is not the thread's card: no mention.
      expect(lark.boardCards.at(-1)?.view.markdown).not.toContain('<at id=');
      expect(sentPayload(task.taskId)).toMatchObject({ in: 'dm' });
    }
    expect(lark.boardCards.every((c) => c.target.threadId !== '' || c.target.receiveIdType === 'union_id')).toBe(true);
    // The direct message refused after it: 230013 records the card as failed, never back to the thread; anything else holds it back.
    const unreachable = ready(ALICE, TOPIC, 'Unreachable');
    lark.failNext('sendCard', new ChannelError(232009, 'chat dissolved', false));
    lark.failNext('sendCard', new ChannelError(230013, 'Bot has NO availability to this user', false));
    await poster().deliver();
    expect(eventsOf(t.db, unreachable.task.taskId).at(-1)).toMatchObject({
      kind: 'card_failed',
      payload: { error: 'chat dissolved (code 232009); and by direct message: Bot has NO availability to this user (code 230013)' },
    });
    const later = ready(ALICE, TOPIC, 'Later');
    lark.failNext('sendCard', new ChannelError(232009, 'chat dissolved', false));
    lark.failNext('sendCard', new ChannelError(400, 'Bad Request', false));
    await poster().deliver();
    expect(eventsOf(t.db, later.task.taskId).some((e) => e.kind.startsWith('card_'))).toBe(false);
    expect(notes.some((n) => n.startsWith(`kanban: the card of run ${later.run.runId} was not sent (Bad Request (code 400))`))).toBe(true);
  });

  it('is held back after a failure that may pass, and routed afresh at its next try', async () => {
    const { task, run } = ready();
    lark.failNext('sendCard', new ChannelError(500, 'internal error', true));
    const p = poster();
    expect(await p.deliver()).toBe(0);
    expect(notes.some((n) => n.startsWith(`kanban: the card of run ${run.runId} was not sent (internal error (code 500))`))).toBe(true);
    // Alice leaves the group; once the members are read again, her card goes to her.
    lark.members.set('oc_team', ['on_owner']);
    clock.advance(MEMBERS_MS);
    expect(await p.deliver()).toBe(1);
    expect(lark.calls.filter((c) => c === 'sendCard')).toHaveLength(2);
    expect(lark.boardCards.map((c) => c.target)).toEqual([dm('on_alice')]);
    expect(lark.boardCards[0]?.uuid).toBe(boardCardUuid('cli_app', run.runId));
    expect(sentPayload(task.taskId)).toMatchObject({ in: 'dm' });
  });

  it("is recorded where Lark's answer says it is, an answer deduplicated against the other place included", async () => {
    const toBob = ready(BOB);
    // Sent to the thread before a restart, unrecorded; now routed to Bob, Lark answers with the thread's message.
    lark.answerNext('sendCard', { messageId: 'om_earlier', deduped: true, threadId: 'omt_topic' });
    await poster().deliver();
    expect(lark.boardCards.map((c) => c.target)).toEqual([dm('on_bob')]);
    expect(sentPayload(toBob.task.taskId)).toEqual({ kind: 'work', to: BOB, messageId: 'om_earlier', in: 'thread' });
    const toAlice = ready(ALICE, TOPIC, 'The other way');
    lark.answerNext('sendCard', { messageId: 'om_dm_earlier', deduped: true });
    await poster().deliver();
    expect(lark.boardCards.at(-1)?.target).toEqual(THREAD);
    expect(sentPayload(toAlice.task.taskId)).toMatchObject({ messageId: 'om_dm_earlier', in: 'dm' });
  });

  it("passes over a held task's runs at each send, saying nothing, and sends the card once the hold has ended", async () => {
    const first = ready(ALICE, TOPIC, 'First');
    const second = ready(ALICE, TOPIC, 'Second');
    lark.hold();
    const round = poster().deliver();
    await new Promise((resolve) => setImmediate(resolve));
    // Held while the round is under way, after the round read its runs: checked at its send.
    held.add(second.task.taskId);
    lark.release();
    expect(await round).toBe(1);
    expect(lark.boardCards.map((c) => c.view.markdown.includes('First'))).toEqual([true]);
    expect(notes).toEqual([]);
    held.delete(second.task.taskId);
    expect(await poster().deliver()).toBe(1);
    expect(sentPayload(second.task.taskId)).toMatchObject({ in: 'thread' });
    expect(sentPayload(first.task.taskId)).toMatchObject({ in: 'thread' });
  });

  it('goes by direct message when the lookup outlasts its time', async () => {
    lark.chatMembers = () => new Promise(() => undefined);
    const { task } = ready();
    expect(await poster({ sendTimeoutMs: 20 }).deliver()).toBe(1);
    expect(lark.boardCards.map((c) => c.target)).toEqual([dm('on_alice')]);
    expect(sentPayload(task.taskId)).toMatchObject({ in: 'dm' });
  });
});
