import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelError } from '../src/channel/types.js';
import { boardCardUuid } from '../src/core/ids.js';
import { cardsDue, eventsOf, getRun, runsOf } from '../src/db/kanban-read.js';
import { CARD_BACKOFF_MAX_MS, CardPoster } from '../src/kanban/cards.js';
import { KanbanService, type CreateRequest } from '../src/kanban/service.js';
import type { RunRow, TaskRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES, dispatchHarness } from './helpers/dispatch.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * A person's cards (spec §9.2): sent as a direct message by union_id when their
 * run is claimed, recorded once, sent again after a restart only if they were
 * not recorded, with the same uuid; a card Lark refuses for good recorded, for
 * its subscribers to hear; an outage tried again after a pause.
 */

const BOB = 'lark:on_bob';

let t: TestDb;
let clock: ManualClock;
let service: KanbanService;
let lark: FakeChannel;
let notes: string[];

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
  notes = [];
});
afterEach(() => {
  clearSecrets();
  t.close();
});

function poster(opts: { canTalk?: (p: string) => boolean } = {}): CardPoster {
  return new CardPoster({
    ...(opts.canTalk === undefined ? {} : { canTalk: opts.canTalk }),
    db: t.db,
    service,
    channel: lark,
    appId: 'cli_app',
    nameOf: (p) => (p === BOB ? 'Bob' : undefined),
    clock,
    note: (line) => notes.push(line),
  });
}

function create(req: Partial<CreateRequest> = {}): TaskRow {
  const r = service.create({ title: 'Check the links', assignee: ALICE, createdBy: BOB, createdVia: VIA, ...req });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.task;
}

function claim(taskId: string): RunRow {
  const r = service.claim(taskId);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.run;
}

describe('CardPoster', () => {
  it("sends a person's run its task card by union_id, records it once, and sends nothing more", async () => {
    addSecrets(['sk-body-12345678']);
    const task = create({ body: 'the key is sk-body-12345678' });
    const run = claim(task.taskId);
    const p = poster();
    expect(await p.deliver()).toBe(1);
    expect(lark.boardCards).toHaveLength(1);
    const card = lark.boardCards[0]!;
    expect(card.target).toEqual({ chatId: 'on_alice', threadId: '', receiveIdType: 'union_id' });
    expect(card.uuid).toBe(boardCardUuid('cli_app', run.runId));
    expect(card.view.markdown).toContain(`📋 For you to do: **Check the links** \`${task.taskId}\``);
    expect(card.view.markdown).toContain(`> the key is ${MASK}`);
    expect(card.view.buttons.map((b) => b.label)).toEqual(['Done', 'Block']);
    expect(eventsOf(t.db, task.taskId).at(-1)).toMatchObject({ kind: 'card_sent', runId: run.runId, payload: { messageId: 'om_board_1' } });
    expect(await p.deliver()).toBe(0);
    expect(lark.boardCards).toHaveLength(1);
  });

  it("sends a person's review its review card, with the reviewer's rework after changes on the next task card", async () => {
    const task = create({ reviewer: BOB });
    const work = claim(task.taskId);
    expect((await service.requestReview(task.taskId, { kind: 'person', principal: ALICE, runId: work.runId }, { summary: 'all answer' })).ok).toBe(
      true,
    );
    const review = claim(task.taskId);
    const p = poster();
    await p.deliver();
    const card = lark.boardCards.at(-1)!;
    expect(card.target.chatId).toBe('on_bob');
    expect(card.view.markdown).toContain('🔎 For you to review: ');
    expect(card.view.markdown).toContain('**The handoff**, from lark:on\\_alice:\n> all answer');
    expect(card.view.buttons.map((b) => b.value['run'])).toEqual([review.runId, review.runId]);
    expect(service.requestChanges(task.taskId, { kind: 'person', principal: BOB, runId: review.runId }, 'cite them').ok).toBe(true);
    claim(task.taskId);
    await p.deliver();
    expect(lark.boardCards.at(-1)?.view.markdown).toContain('**Changes asked** by Bob:\n> cite them');
  });

  it('sends no card for an agent run', async () => {
    const task = create({ assignee: 'implementer' });
    claim(task.taskId);
    expect(await poster().deliver()).toBe(0);
    expect(lark.boardCards).toEqual([]);
  });

  it('records a card Lark refuses for good, once, and never sends it again', async () => {
    const task = create();
    const run = claim(task.taskId);
    lark.failNext('sendCard', new ChannelError(230013, 'Bot has NO availability to this user', false));
    const p = poster();
    expect(await p.deliver()).toBe(0);
    expect(eventsOf(t.db, task.taskId).at(-1)).toMatchObject({
      kind: 'card_failed',
      runId: run.runId,
      payload: { kind: 'work', to: ALICE, error: 'Bot has NO availability to this user (code 230013)' },
    });
    expect(cardsDue(t.db)).toEqual([]);
    clock.advance(CARD_BACKOFF_MAX_MS);
    expect(await p.deliver()).toBe(0);
    expect(lark.calls.filter((c) => c === 'sendCard')).toHaveLength(1);
    expect(notes.some((n) => n.includes(`the card of run ${run.runId} cannot be sent`))).toBe(true);
  });

  it("takes any other refusal for the gateway's problem: a scope Lark refuses, or a bad request, is tried again", async () => {
    const task = create();
    const run = claim(task.taskId);
    lark.failNext('sendCard', new ChannelError(99991672, 'Access denied: scope missing', false));
    lark.failNext('sendCard', new ChannelError(400, 'Bad Request', false));
    const p = poster();
    expect(await p.deliver()).toBe(0);
    clock.advance(2_000);
    expect(await p.deliver()).toBe(0);
    clock.advance(4_000);
    expect(await p.deliver()).toBe(1);
    expect(eventsOf(t.db, task.taskId).some((e) => e.kind === 'card_failed')).toBe(false);
    expect(notes.filter((n) => n.startsWith(`kanban: the card of run ${run.runId} was not sent`))).toHaveLength(2);
  });

  it('sends no card to a person who no longer has talk tier, and records why', async () => {
    const task = create();
    const run = claim(task.taskId);
    expect(await poster({ canTalk: () => false }).deliver()).toBe(0);
    expect(lark.boardCards).toEqual([]);
    expect(eventsOf(t.db, task.taskId).at(-1)).toMatchObject({
      kind: 'card_failed',
      runId: run.runId,
      payload: { error: `${ALICE} no longer has talk tier on this gateway` },
    });
  });

  it('sends no card for a run that ended while the round was under way', async () => {
    const first = create();
    claim(first.taskId);
    const second = create({ title: 'Tidy the docs' });
    const run = claim(second.taskId);
    expect(cardsDue(t.db).map((r) => r.taskId)).toEqual([first.taskId, second.taskId]);
    lark.hold();
    const round = poster().deliver();
    await new Promise((resolve) => setImmediate(resolve));
    // While the first card is being sent, the second's run ends.
    expect(service.stop(second.taskId, BOB).ok).toBe(true);
    expect(getRun(t.db, run.runId)?.endedAt).not.toBeNull();
    lark.release();
    expect(await round).toBe(1);
    expect(lark.boardCards.map((c) => c.view.markdown.includes('Tidy the docs'))).toEqual([false]);
  });

  it('says honestly that nobody is told of a card it cannot send, once its run ended while the round was under way', async () => {
    const first = create();
    claim(first.taskId);
    const second = create({ title: 'Tidy the docs', assignee: BOB });
    const run = claim(second.taskId);
    lark.hold();
    const round = poster({ canTalk: (p) => p !== BOB }).deliver();
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.stop(second.taskId, ALICE).ok).toBe(true);
    lark.release();
    expect(await round).toBe(1);
    expect(eventsOf(t.db, second.taskId).some((e) => e.kind === 'card_failed')).toBe(false);
    expect(notes).toContain(
      `kanban: the card of run ${run.runId} cannot be sent (${BOB} no longer has talk tier on this gateway); ` +
        'its run is over, or its card was recorded already, so nobody is told',
    );
  });

  it('sends a card that could not be recorded once, and not again until a restart, saying so once', async () => {
    const task = create();
    const run = claim(task.taskId);
    // A board that will not take the record: the database locked, say.
    service.recordCard = () => ({ ok: false, code: 'invalid', message: 'locked' });
    const p = poster();
    expect(await p.deliver()).toBe(1);
    clock.advance(CARD_BACKOFF_MAX_MS);
    expect(await p.deliver()).toBe(0);
    expect(lark.boardCards).toHaveLength(1);
    expect(notes.filter((n) => n.includes(`the card of run ${run.runId} was sent, and not recorded`))).toHaveLength(1);
  });

  it('tries a card again after an outage, the pause doubling, and sends it once it can', async () => {
    const task = create();
    claim(task.taskId);
    lark.failNext('sendCard', new ChannelError(0, 'socket hang up', false));
    lark.failNext('sendCard', new ChannelError(500, 'internal error', true));
    const p = poster();
    expect(await p.deliver()).toBe(0);
    // Held back 2 s.
    clock.advance(1_000);
    expect(await p.deliver()).toBe(0);
    expect(lark.calls.filter((c) => c === 'sendCard')).toHaveLength(1);
    clock.advance(1_000);
    expect(await p.deliver()).toBe(0);
    // Then 4 s.
    clock.advance(3_000);
    expect(await p.deliver()).toBe(0);
    clock.advance(1_000);
    expect(await p.deliver()).toBe(1);
    expect(lark.boardCards).toHaveLength(1);
    expect(eventsOf(t.db, task.taskId).some((e) => e.kind === 'card_failed')).toBe(false);
  });

  it('after a restart, sends again only a card that was not recorded, with the same uuid', async () => {
    const sentBefore = create({ title: 'Sent before' });
    const sentRun = claim(sentBefore.taskId);
    await poster().deliver();
    // A card sent just before a stop, and not recorded: the send outlives the process.
    const unsent = create({ title: 'Not recorded' });
    const unsentRun = claim(unsent.taskId);
    const first = lark.boardCards.length;
    // A new poster is a new process: it knows only what the database does.
    await poster().deliver();
    expect(lark.boardCards.slice(first).map((c) => c.uuid)).toEqual([boardCardUuid('cli_app', unsentRun.runId)]);
    expect(lark.boardCards.map((c) => c.uuid)).not.toContain(undefined);
    expect(lark.boardCards.filter((c) => c.uuid === boardCardUuid('cli_app', sentRun.runId))).toHaveLength(1);
  });
});

describe("a person's run, as the dispatcher has it", () => {
  it('is claimed by a pass, holds no workspace and no agent slot, and waits past any runtime limit', async () => {
    const h = dispatchHarness({ people: { canTalk: (p) => p === ALICE }, settings: { maxRunning: 1, defaultMaxRuntimeS: 60 } });
    try {
      const person = h.create({ title: 'Read the draft', assignee: ALICE, workspace: 'web' });
      const agent = h.create({ title: 'Fix the footer', workspace: 'web' });
      const held = h.driver('implementer').scripts;
      held.push(async () => new Promise<void>(() => undefined));
      h.dispatcher.pass();
      await h.dispatcher.idle(50);
      const [personRun] = runsOf(h.t.db, person.taskId);
      expect(personRun).toMatchObject({ kind: 'work', assignee: { kind: 'human', name: ALICE }, sessionId: null, outcome: null });
      // The agent's task in the same workspace was claimed beside it.
      expect(runsOf(h.t.db, agent.taskId)).toHaveLength(1);
      h.clock.advance(10 * 60_000);
      h.dispatcher.sweep();
      // A person taking a day is not a failure: the run parks.
      expect(getRun(h.t.db, personRun!.runId)).toMatchObject({ outcome: null, endedAt: null });
    } finally {
      h.dispatcher.stop();
      await h.registry.closeAll();
      h.close();
    }
  });
});
