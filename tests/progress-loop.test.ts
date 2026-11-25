import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelError } from '../src/channel/types.js';
import { progressCardUuid } from '../src/core/ids.js';
import { appendEvents } from '../src/db/events.js';
import { chatKindOf, getRun, progressCard, runsOf } from '../src/db/kanban-read.js';
import { createSession, setExecution } from '../src/db/sessions.js';
import { CARD_BACKOFF_MAX_MS } from '../src/kanban/cards.js';
import { FOLD_EVENTS, ProgressCards, type ProgressCardsDeps } from '../src/kanban/progress.js';
import { KanbanService, type CreateRequest } from '../src/kanban/service.js';
import type { CreatedVia, RunRow, TaskRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import type { NewEvent } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES, dispatchHarness, reportComplete, until as dispatchUntil, type DispatchHarness } from './helpers/dispatch.js';
import type { TurnControl } from './helpers/driver.js';
import { ALICE } from './helpers/kanban.js';

/**
 * The progress card loop (progress cards spec §7, §9, §10), on a fake clock
 * with the fake channel, driven round by round: which runs get a card and
 * where, the fold, the pace and the holds, the final draw, and the errors.
 */

// Called through, and counted: how often the loop looks a chat's kind up.
vi.mock('../src/db/kanban-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/kanban-read.js')>();
  return { ...actual, chatKindOf: vi.fn(actual.chatKindOf) };
});

const APP = 'cli_app';
const PLACES = Array.from({ length: 14 }, (_, i) => `w${i + 1}`);

let t: TestDb;
let clock: ManualClock;
let service: KanbanService;
let lark: FakeChannel;
let notes: string[];
let cards: ProgressCards;
let made: number;
let sessions: number;

function chat(extra: { conversationId: string; threadId?: string; rootId?: string; chatType?: 'p2p' | 'group' }): CreatedVia {
  return { kind: 'chat', channel: 'lark', appId: APP, threadId: '', ...extra };
}

const THREAD = chat({ conversationId: 'oc_team', threadId: 'omt_1', rootId: 'om_root', chatType: 'group' });
const DM = chat({ conversationId: 'oc_dm', chatType: 'p2p' });
const GROUP = chat({ conversationId: 'oc_team', chatType: 'group' });

beforeEach(() => {
  clearSecrets();
  t = testDb();
  clock = new ManualClock();
  service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: new Set(PLACES),
    clock,
    maxRunning: 20,
    people: { canTalk: () => true },
  });
  lark = new FakeChannel({ id: 'lark', clock });
  notes = [];
  made = 0;
  sessions = 0;
  cards = loop();
});
afterEach(() => {
  cards.stop();
  clearSecrets();
  t.close();
});

function loop(over: Partial<ProgressCardsDeps> = {}): ProgressCards {
  return new ProgressCards({
    db: t.db,
    service,
    channels: new Map([['lark', lark]]),
    appId: APP,
    minSeconds: 30,
    failureLimit: 2,
    clock,
    note: (line) => notes.push(line),
    nameOf: (p) => (p === ALICE ? 'Alice' : undefined),
    ...over,
  });
}

function create(via: CreatedVia = THREAD, req: Partial<CreateRequest> = {}): TaskRow {
  const r = service.create({ title: 'Fix the login test', assignee: 'implementer', createdBy: ALICE, createdVia: via, workspace: PLACES[made++] ?? 'w1', ...req });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.task;
}

/** A run claimed on the task, its session made and attached. */
function started(taskId: string, withSession = true): RunRow {
  const c = service.claim(taskId);
  if (!c.ok) throw new Error(`${c.code}: ${c.message}`);
  if (!withSession) return c.run;
  const id = `s_run_${++sessions}`;
  createSession(t.db, { id, agentId: 'implementer', workspaceId: 'w1', ownerPrincipal: 'kanban' }, clock.now());
  const a = service.attachSession(c.run.runId, id);
  if (!a.ok) throw new Error(a.code);
  return a.run;
}

function say(run: RunRow, events: NewEvent[]): void {
  if (run.sessionId === null) throw new Error('no session');
  appendEvents(t.db, run.sessionId, events, clock.now());
}

const tool = (id: string, title: string, status = 'in_progress'): NewEvent => ({ type: 'tool_call', actor: 'agent', payload: { toolCallId: id, title, status } });
const done = (id: string, status = 'completed'): NewEvent => ({ type: 'tool_call_update', actor: 'agent', payload: { toolCallId: id, status } });
const words = (text: string): NewEvent => ({ type: 'agent_message_chunk', actor: 'agent', payload: { text } });

/** Move the clock and run a round. */
async function after(ms: number): Promise<number> {
  clock.advance(ms);
  return cards.round();
}

/** Close the run as its turn's end does: decided, then closed. */
function closeAs(run: RunRow, how: 'completed' | 'failed'): void {
  if (how === 'completed') {
    const r = service.closeRun(run.runId);
    if (!r.ok) throw new Error(r.code);
  } else {
    const e = service.endRun(run.runId, { outcome: 'failed', error: 'boom', hadSideEffects: false });
    if (!e.ok) throw new Error(e.code);
    const r = service.closeRun(run.runId);
    if (!r.ok) throw new Error(r.code);
  }
}

async function complete(run: RunRow): Promise<void> {
  const r = await service.complete(run.taskId, { kind: 'run', runId: run.runId }, { summary: 'done' });
  if (!r.ok) throw new Error(r.code);
  closeAs(run, 'completed');
}

describe('which runs get a card, and where', () => {
  it('opens no card before min_seconds, then one, in the thread, replying to its root, with the run uuid, once', async () => {
    const task = create();
    const run = started(task.taskId);
    say(run, [tool('c1', 'Read')]);
    expect(await after(29_000)).toBe(0);
    expect(lark.boardCards).toEqual([]);
    expect(await after(1_000)).toBe(1);
    expect(lark.boardCards).toHaveLength(1);
    const sent = lark.boardCards[0]!;
    expect(sent.target).toEqual({ chatId: 'oc_team', threadId: 'omt_1', root: 'om_root' });
    expect(sent.uuid).toBe(progressCardUuid(APP, run.runId));
    expect(sent.view.markdown).toContain(`⚙️ **Fix the login test** \`${task.taskId}\``);
    expect(sent.view.markdown).toContain('⏳ Read');
    expect(sent.view.buttons.map((b) => b.label)).toEqual(['Stop']);
    expect(progressCard(t.db, run.runId)).toMatchObject({ messageId: 'om_board_1', state: 'open', tryNumber: 1, tryLimit: 2 });
    await after(60_000);
    expect(lark.boardCards).toHaveLength(1);
  });

  it('sends to a direct message, and nothing at a group chat scope', async () => {
    started(create(DM).taskId);
    started(create(GROUP).taskId);
    await after(30_000);
    expect(lark.boardCards.map((c) => c.target.chatId)).toEqual(['oc_dm']);
  });

  it("reads a null chat type from another subscription of the chat, and looks a miss up again at the next round, never writing it back", async () => {
    const unknown = chat({ conversationId: 'oc_somebody' });
    const task = create(unknown);
    started(task.taskId);
    await after(30_000);
    expect(lark.boardCards).toEqual([]);
    expect(await after(3_000)).toBe(0);
    // A task typed in that direct message tells its kind: the next round finds it.
    expect(service.create({ title: 'Another', assignee: ALICE, createdBy: ALICE, createdVia: chat({ conversationId: 'oc_somebody', chatType: 'p2p' }) }).ok).toBe(true);
    await after(3_000);
    expect(lark.boardCards.map((c) => c.target.chatId)).toEqual(['oc_somebody']);
    const kinds = t.db.prepare<[string], { chat_type: string | null }>('SELECT chat_type FROM kanban_subscriptions WHERE task_id = ?').get(task.taskId);
    expect(kinds?.chat_type).toBeNull();
  });

  it('looks a found chat kind up once a boot, and a miss at most once a round', async () => {
    const lookups = (conversationId: string): number => vi.mocked(chatKindOf).mock.calls.filter((c) => c[3] === conversationId).length;
    vi.mocked(chatKindOf).mockClear();
    expect(service.create({ title: 'Known', assignee: ALICE, createdBy: ALICE, createdVia: chat({ conversationId: 'oc_known', chatType: 'p2p' }) }).ok).toBe(true);
    const found = started(create(chat({ conversationId: 'oc_known' })).taskId);
    started(create(chat({ conversationId: 'oc_nobody' })).taskId);
    started(create(chat({ conversationId: 'oc_nobody' })).taskId);
    await after(30_000);
    expect(lark.boardCards.map((c) => c.target.chatId)).toEqual(['oc_known']);
    let rounds = 1;
    for (let i = 0; i < 4; i += 1) {
      say(found, [tool(`c${i}`, 'Read')]);
      await after(5_000);
      rounds += 1;
    }
    expect(lark.cardUpdates.length).toBeGreaterThan(0);
    expect(lookups('oc_known')).toBe(1);
    expect(lookups('oc_nobody')).toBe(rounds);
  });

  it("gives a group's chat kind no card", async () => {
    expect(service.create({ title: 'Known', assignee: ALICE, createdBy: ALICE, createdVia: chat({ conversationId: 'oc_big', chatType: 'group' }) }).ok).toBe(true);
    started(create(chat({ conversationId: 'oc_big' })).taskId);
    await after(30_000);
    await after(3_000);
    expect(lark.boardCards).toEqual([]);
  });

  it("passes over a held task, a person's run, and a channel this gateway has not got, said once", async () => {
    const held = create();
    started(held.taskId);
    const person = create(DM, { assignee: ALICE });
    expect(service.claim(person.taskId).ok).toBe(true);
    const elsewhere = create(chat({ conversationId: 'oc_x', threadId: 'omt_x', rootId: 'om_x' }));
    t.db.prepare("UPDATE kanban_subscriptions SET channel = 'slack' WHERE task_id = ?").run(elsewhere.taskId);
    started(elsewhere.taskId);
    cards = loop({ held: (id) => id === held.taskId });
    await after(30_000);
    await after(3_000);
    expect(lark.boardCards).toEqual([]);
    expect(notes.filter((n) => n.includes('cannot go to channel slack'))).toHaveLength(1);
  });

  it('draws Starting for a run whose session has nothing yet', async () => {
    started(create().taskId, false);
    await after(30_000);
    expect(lark.boardCards[0]?.view.markdown).toContain('_Starting…_');
  });
});

describe('the fold', () => {
  it('reads at most 5,000 events a round, the first included, and sends only once caught up', async () => {
    const run = started(create().taskId);
    say(run, Array.from({ length: 12_000 }, (_, i) => words(i === 11_999 ? 'the end' : '.')));
    await after(30_000);
    expect(lark.boardCards).toEqual([]);
    await after(3_000);
    expect(lark.boardCards).toEqual([]);
    await after(3_000);
    expect(lark.boardCards).toHaveLength(1);
    expect(lark.boardCards[0]?.view.markdown).toContain('the end');
    expect(FOLD_EVENTS).toBe(5_000);
  });

  it("moves to each range's bound, so a final whose last events are not tools reaches the session's last seq", async () => {
    const run = started(create().taskId);
    say(run, [tool('c1', 'Read')]);
    await after(30_000);
    say(run, [done('c1'), ...Array.from({ length: 6_000 }, () => words('.'))]);
    await complete(run);
    await after(5_000);
    expect(lark.cardUpdates).toEqual([]);
    await after(5_000);
    expect(lark.cardUpdates).toHaveLength(1);
    expect(lark.cardUpdates[0]?.view.markdown).toContain('✓ completed');
    expect(lark.cardUpdates[0]?.view.markdown).toContain('✅ Read');
    expect(progressCard(t.db, run.runId)?.state).toBe('final');
  });
});

describe("a press's reads", () => {
  it('reads at most four folds a press, and the loop reads the rest and draws it', async () => {
    const run = started(create().taskId);
    await after(30_000);
    say(run, Array.from({ length: 4 * FOLD_EVENTS + 1_000 }, (_, i) => words(i === 4 * FOLD_EVENTS + 999 ? ' the end' : '.')));
    await cards.redrawNow(run.runId);
    expect(lark.cardUpdates).toHaveLength(1);
    expect(lark.cardUpdates[0]?.view.markdown).not.toContain('the end');
    await after(5_000);
    expect(lark.cardUpdates).toHaveLength(2);
    expect(lark.cardUpdates[1]?.view.markdown).toContain('the end');
  });

  it("draws a press's final from four folds, and leaves the row open for the loop to finish and mark final", async () => {
    const run = started(create().taskId);
    await after(30_000);
    say(run, [...Array.from({ length: 4 * FOLD_EVENTS }, () => words('.')), tool('c1', 'Read'), done('c1')]);
    closeAs(run, 'failed');
    await cards.redrawNow(run.runId);
    expect(lark.cardUpdates).toHaveLength(1);
    expect(lark.cardUpdates[0]?.view.markdown).toContain('✗ failed');
    expect(lark.cardUpdates[0]?.view.markdown).not.toContain('Read');
    expect(progressCard(t.db, run.runId)?.state).toBe('open');
    await after(5_000);
    expect(lark.cardUpdates.at(-1)?.view.markdown).toContain('✅ Read');
    expect(progressCard(t.db, run.runId)?.state).toBe('final');
  });
});

describe('old cards', () => {
  it("forgets an old card once a press has drawn it, landed or not, and bumps no try for a run with no card", async () => {
    const run = started(create().taskId);
    await after(30_000);
    const messageId = progressCard(t.db, run.runId)?.messageId ?? '';
    closeAs(run, 'failed');
    await after(5_000);
    expect(progressCard(t.db, run.runId)?.state).toBe('final');
    await cards.refusedTier(messageId, run.runId);
    expect(lark.cardUpdates).toHaveLength(2);
    expect(cards.tryOf(run.runId)).toBe(0);
    clock.advance(5_000);
    lark.failNext('updateCard', new ChannelError(500, 'server error', true));
    await cards.refusedTier(messageId, run.runId);
    expect(lark.calls.filter((c) => c === 'updateCard')).toHaveLength(3);
    expect(cards.tryOf(run.runId)).toBe(0);
    await cards.refusedTier('om_none', 'r_none');
    expect(cards.tryOf('r_none')).toBe(0);
  });

  it("keeps a let-go card's try while its run is open, so a second refusal draws a higher one", async () => {
    const run = started(create().taskId);
    await after(30_000);
    const messageId = progressCard(t.db, run.runId)?.messageId ?? '';
    service.progressCardLetGo(run.runId);
    await cards.refusedTier(messageId, run.runId);
    expect(lark.cardUpdates.at(-1)?.view.buttons[0]?.value['try']).toBe('1');
    clock.advance(5_000);
    await cards.refusedTier(messageId, run.runId);
    expect(lark.cardUpdates.at(-1)?.view.buttons[0]?.value['try']).toBe('2');
    expect(progressCard(t.db, run.runId)?.state).toBe('let_go');
  });
});

describe('the pace', () => {
  it('redraws as tools run, at most once every 5 s, and not when nothing changed', async () => {
    const run = started(create().taskId);
    say(run, [tool('c1', 'Read')]);
    await after(30_000);
    say(run, [done('c1'), tool('c2', 'Edit')]);
    await after(3_000);
    expect(lark.cardUpdates).toEqual([]);
    await after(2_000);
    expect(lark.cardUpdates).toHaveLength(1);
    expect(lark.cardUpdates[0]?.messageId).toBe('om_board_1');
    expect(lark.cardUpdates[0]?.view.markdown).toContain('✅ Read · ⏳ Edit');
    await after(5_000);
    expect(lark.cardUpdates).toHaveLength(1);
    // Usage changes nothing shown.
    say(run, [{ type: 'usage', actor: 'agent', payload: {} }]);
    await after(5_000);
    expect(lark.cardUpdates).toHaveLength(1);
  });

  it('redraws when the shown minute moves, and when the run is stopped', async () => {
    const task = create();
    const run = started(task.taskId);
    await after(30_000);
    await after(29_000);
    expect(lark.cardUpdates).toEqual([]);
    await after(1_000);
    expect(lark.cardUpdates.at(-1)?.view.markdown).toContain('running 1 min');
    expect(service.stop(task.taskId, ALICE).ok).toBe(true);
    await after(5_000);
    const last = lark.cardUpdates.at(-1);
    expect(last?.view.markdown).toContain('⏸ stopping, asked by Alice');
    expect(last?.view.buttons).toEqual([]);
    expect(getRun(t.db, run.runId)?.outcome).toBe('cancelled');
  });

  it('makes at most ten draws a round, the longest waiting first', async () => {
    const runs: RunRow[] = [];
    for (let i = 0; i < 12; i += 1) {
      runs.push(started(create().taskId));
      clock.advance(1_000);
    }
    await after(30_000);
    expect(lark.boardCards).toHaveLength(10);
    expect(lark.boardCards.map((c) => c.uuid)).toEqual(runs.slice(0, 10).map((r) => progressCardUuid(APP, r.runId)));
    await after(3_000);
    expect(lark.boardCards).toHaveLength(12);
  });
});

describe("the round's ten", () => {
  it('counts only the draws made, not cards due that had not caught up', async () => {
    const runs: RunRow[] = [];
    for (let i = 0; i < 12; i += 1) runs.push(started(create().taskId));
    for (const r of runs.slice(0, 2)) say(r, Array.from({ length: FOLD_EVENTS + 1 }, () => words('.')));
    expect(await after(30_000)).toBe(10);
    expect(lark.boardCards.map((c) => c.uuid)).toEqual(runs.slice(2).map((r) => progressCardUuid(APP, r.runId)));
  });

  it('counts no draw for a card due whose view had not changed', async () => {
    const runs: RunRow[] = [];
    for (let i = 0; i < 11; i += 1) runs.push(started(create().taskId));
    for (const r of runs) say(r, [words('hello')]);
    await after(30_000);
    await after(3_000);
    expect(lark.boardCards).toHaveLength(11);
    // A usage event makes every card due by the cheap check; the first one's view is all that changed.
    for (const r of runs) say(r, [{ type: 'usage', actor: 'agent', payload: {} }]);
    say(runs[10]!, [tool('c1', 'Read')]);
    expect(await after(5_000)).toBe(1);
    expect(lark.cardUpdates.map((u) => u.messageId)).toEqual([progressCard(t.db, runs[10]!.runId)?.messageId]);
  });
});

describe('the end', () => {
  it('draws the card final when the run closes, with the outcome, the time and the tool line, and no button', async () => {
    const run = started(create().taskId);
    say(run, [tool('c1', 'Read'), done('c1'), words('my summary')]);
    await after(30_000);
    clock.advance(14 * 60_000);
    closeAs(run, 'failed');
    await after(3_000);
    const last = lark.cardUpdates.at(-1);
    expect(last?.view.markdown).toContain('✗ failed after 14 min 30 s');
    expect(last?.view.markdown).toContain('✅ Read');
    expect(last?.view.markdown).not.toContain('my summary');
    expect(last?.view.buttons).toEqual([]);
    expect(progressCard(t.db, run.runId)?.state).toBe('final');
    await after(10_000);
    expect(lark.cardUpdates).toHaveLength(1);
  });

  it('draws a decided open run live until it closes', async () => {
    const run = started(create().taskId);
    await after(30_000);
    const r = await service.complete(run.taskId, { kind: 'run', runId: run.runId }, { summary: 'done' });
    expect(r.ok).toBe(true);
    await after(5_000);
    expect(lark.cardUpdates.at(-1)?.view.markdown).toContain('_Reported completed; finishing._');
    closeAs(run, 'completed');
    await after(5_000);
    expect(lark.cardUpdates.at(-1)?.view.markdown).toContain('✓ completed after');
  });

  it('masks the whole markdown before each send and update', async () => {
    const task = create();
    addSecrets([task.taskId]);
    const run = started(task.taskId);
    await after(30_000);
    expect(lark.boardCards[0]?.view.markdown).not.toContain(task.taskId);
    expect(lark.boardCards[0]?.view.markdown).toContain(MASK);
    say(run, [tool('c1', 'Read')]);
    await after(5_000);
    expect(lark.cardUpdates[0]?.view.markdown).not.toContain(task.taskId);
  });
});

describe('errors', () => {
  const refusal = (): ChannelError => new ChannelError(99991663, 'refused', false);

  it('holds a refused send for a pause doubling from 2 s, counts it, and lets the run go at the tenth, said once', async () => {
    const run = started(create().taskId);
    lark.failNext('sendCard', refusal());
    await after(30_000);
    expect(progressCard(t.db, run.runId)?.failures).toBe(1);
    lark.failNext('sendCard', refusal());
    await after(1_000);
    expect(lark.calls.filter((c) => c === 'sendCard')).toHaveLength(1);
    await after(1_000);
    expect(lark.calls.filter((c) => c === 'sendCard')).toHaveLength(2);
    for (let i = 0; i < 8; i += 1) {
      lark.failNext('sendCard', refusal());
      await after(CARD_BACKOFF_MAX_MS);
    }
    expect(progressCard(t.db, run.runId)?.state).toBe('let_go');
    expect(notes.filter((n) => n.includes('was refused 10 times'))).toHaveLength(1);
    await after(CARD_BACKOFF_MAX_MS);
    expect(lark.calls.filter((c) => c === 'sendCard')).toHaveLength(10);
  });

  it('holds a throttle, a 5xx, code 0 and a timeout without counting them, a throttle at least its retry-after', async () => {
    const run = started(create().taskId);
    lark.failNext('sendCard', new ChannelError(230020, 'chat rate limit', true, 7_000));
    await after(30_000);
    await after(3_000);
    expect(lark.calls.filter((c) => c === 'sendCard')).toHaveLength(1);
    lark.failNext('sendCard', new ChannelError(99991400, 'rate limit', true));
    lark.failNext('sendCard', new ChannelError(429, 'too many', true));
    lark.failNext('sendCard', new ChannelError(500, 'server error', true));
    lark.failNext('sendCard', new ChannelError(0, 'network', false));
    for (let i = 0; i < 4; i += 1) await after(CARD_BACKOFF_MAX_MS);
    expect(progressCard(t.db, run.runId)?.failures).toBe(0);
    await after(CARD_BACKOFF_MAX_MS);
    expect(lark.boardCards).toHaveLength(1);
  });

  it('holds a send past its bound without counting it', async () => {
    cards = loop({ sendTimeoutMs: 20 });
    const run = started(create().taskId);
    lark.hold();
    await after(30_000);
    lark.release();
    expect(progressCard(t.db, run.runId)).toMatchObject({ failures: 0, messageId: null });
    expect(notes.some((n) => n.includes('took longer than 20 ms'))).toBe(true);
  });

  it('lets a run go at once when the bot is not in the chat', async () => {
    const run = started(create().taskId);
    lark.failNext('sendCard', new ChannelError(230002, 'bot not in chat', false));
    await after(30_000);
    expect(progressCard(t.db, run.runId)?.state).toBe('let_go');
    expect(notes.some((n) => n.includes('cannot reach oc_team ('))).toBe(true);
  });

  it('lets a row go quietly whose run ended, or whose subscription went, before its send landed', async () => {
    const a = started(create().taskId);
    const b = started(create().taskId);
    lark.failNext('sendCard', refusal());
    lark.failNext('sendCard', refusal());
    await after(30_000);
    closeAs(a, 'failed');
    t.db.prepare('DELETE FROM kanban_subscriptions WHERE task_id = ?').run(b.taskId);
    const before = notes.length;
    await after(3_000);
    expect(progressCard(t.db, a.runId)?.state).toBe('let_go');
    expect(progressCard(t.db, b.runId)?.state).toBe('let_go');
    expect(notes.slice(before)).toEqual([]);
  });

  it('draws on a card whose send was not recorded, this boot', async () => {
    const run = started(create().taskId);
    vi.spyOn(service, 'progressCardSent').mockReturnValueOnce({ ok: false, code: 'invalid', message: 'no' });
    await after(30_000);
    expect(notes.some((n) => n.includes('was sent as om_board_1, and not recorded'))).toBe(true);
    say(run, [tool('c1', 'Read')]);
    await after(5_000);
    expect(lark.cardUpdates.map((u) => u.messageId)).toEqual(['om_board_1']);
  });

  it('counts refused updates, a landed one setting them back, and leaves the card at ten in a row, still drawn final', async () => {
    const run = started(create().taskId);
    await after(30_000);
    let n = 0;
    const next = async (): Promise<void> => {
      say(run, [tool(`c${++n}`, 'Read')]);
      await after(60_000);
    };
    for (let i = 0; i < 9; i += 1) {
      lark.failNext('updateCard', refusal());
      await next();
    }
    expect(progressCard(t.db, run.runId)?.failures).toBe(9);
    await next();
    expect(progressCard(t.db, run.runId)?.failures).toBe(0);
    for (let i = 0; i < 10; i += 1) {
      lark.failNext('updateCard', refusal());
      await next();
    }
    const tried = lark.calls.filter((c) => c === 'updateCard').length;
    await next();
    expect(lark.calls.filter((c) => c === 'updateCard')).toHaveLength(tried);
    expect(notes.filter((l) => l.includes('refused 10 updates in a row'))).toHaveLength(1);
    closeAs(run, 'failed');
    await after(60_000);
    expect(lark.cardUpdates.at(-1)?.view.markdown).toContain('✗ failed');
    expect(progressCard(t.db, run.runId)?.state).toBe('final');
  });

  it('holds a failing update for a pause doubling from 5 s to a minute, and a throttle on an update without counting it', async () => {
    const run = started(create().taskId);
    await after(30_000);
    say(run, [tool('c1', 'Read')]);
    lark.failNext('updateCard', new ChannelError(230020, 'chat rate limit', true));
    await after(5_000);
    const tries = (): number => lark.calls.filter((c) => c === 'updateCard').length;
    expect(tries()).toBe(1);
    expect(progressCard(t.db, run.runId)?.failures).toBe(0);
    // Held 5 s; the next fails too, and is held 10 s.
    lark.failNext('updateCard', new ChannelError(429, 'too many', true));
    await after(5_000);
    expect(tries()).toBe(2);
    await after(5_000);
    expect(tries()).toBe(2);
    await after(5_000);
    expect(tries()).toBe(3);
    expect(lark.cardUpdates).toHaveLength(1);
    expect(progressCard(t.db, run.runId)?.failures).toBe(0);
  });

  it("skips a tier refusal's redraw while the card is held, and the loop draws the bumped try once the hold ends", async () => {
    const run = started(create().taskId);
    await after(30_000);
    const messageId = progressCard(t.db, run.runId)?.messageId ?? '';
    say(run, [tool('c1', 'Read')]);
    lark.failNext('updateCard', new ChannelError(230020, 'chat rate limit', true, 20_000));
    await after(5_000);
    const tries = (): number => lark.calls.filter((c) => c === 'updateCard').length;
    expect(tries()).toBe(1);
    clock.advance(1_000);
    await cards.refusedTier(messageId, run.runId);
    expect(tries()).toBe(1);
    expect(cards.tryOf(run.runId)).toBe(1);
    await after(14_000);
    expect(tries()).toBe(1);
    await after(5_000);
    expect(tries()).toBe(2);
    expect(lark.cardUpdates.at(-1)?.view.buttons[0]?.value['try']).toBe('1');
  });

  it('lets a card go when Lark no longer holds it, or the bot left the chat', async () => {
    const a = started(create().taskId);
    const b = started(create().taskId);
    await after(30_000);
    say(a, [tool('c1', 'Read')]);
    say(b, [tool('c1', 'Read')]);
    lark.failNext('updateCard', new ChannelError(230011, 'withdrawn', false));
    lark.failNext('updateCard', new ChannelError(230002, 'bot not in chat', false));
    await after(5_000);
    expect(progressCard(t.db, a.runId)?.state).toBe('let_go');
    expect(progressCard(t.db, b.runId)?.state).toBe('let_go');
    expect(notes.filter((n) => n.includes('is gone'))).toHaveLength(2);
  });

  it('lets a final draw go after ten refusals in a row', async () => {
    const run = started(create().taskId);
    await after(30_000);
    closeAs(run, 'failed');
    for (let i = 0; i < 10; i += 1) {
      lark.failNext('updateCard', refusal());
      await after(60_000);
    }
    expect(progressCard(t.db, run.runId)?.state).toBe('let_go');
    expect(notes.filter((n) => n.includes('refused its final draw 10 times'))).toHaveLength(1);
  });
});

describe('the stop', () => {
  it('ends a round after its current draw, and idle settles once it has', async () => {
    started(create().taskId);
    started(create().taskId);
    lark.hold();
    clock.advance(30_000);
    const round = cards.round();
    await new Promise((r) => setImmediate(r));
    cards.stop();
    lark.release();
    expect(await round).toBe(1);
    expect(await cards.idle(1_000)).toBe(true);
    expect(lark.calls.filter((c) => c === 'sendCard')).toHaveLength(1);
  });
});

describe('a run closed by the boot, with nothing to time it by', () => {
  it('draws no time for a run with no session, or with no event before the boot', async () => {
    const bare = started(create().taskId, false);
    const quiet = started(create().taskId);
    const bootAt = clock.now() + 60_000;
    cards = loop({ bootedAt: () => bootAt });
    await after(30_000);
    expect(lark.boardCards).toHaveLength(2);
    clock.advance(60_000);
    say(quiet, [{ type: 'turn_ended', actor: 'gateway', payload: {} }]);
    for (const r of [bare, quiet]) {
      expect(service.endRun(r.runId, { outcome: 'interrupted', hadSideEffects: false }).ok).toBe(true);
      expect(service.closeRun(r.runId).ok).toBe(true);
    }
    await after(5_000);
    const finals = lark.cardUpdates.map((u) => u.view.markdown.split('\n')[2]);
    expect(finals).toEqual(['⏸ interrupted by a restart', '⏸ interrupted by a restart']);
    expect(progressCard(t.db, bare.runId)?.state).toBe('final');
    expect(progressCard(t.db, quiet.runId)?.state).toBe('final');
  });
});

describe('a restart', () => {
  const harnesses: DispatchHarness[] = [];
  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.close();
  });

  /**
   * The gateway before the restart: a run in a thread whose card is sent, and
   * whose agent, `speaksAfter` ms after the card, makes a tool call (or, with
   * none, says nothing), reporting first if `report`. Its turn never ends.
   */
  async function before(speaksAfter: number | undefined, report = false): Promise<{ h0: DispatchHarness; run: RunRow }> {
    const h0 = dispatchHarness();
    harnesses.push(h0);
    const task = h0.create({ title: 'Build', workspace: 'web', createdVia: THREAD });
    const implementer = h0.driver('implementer');
    let speak: (() => void) | undefined;
    const spoken = new Promise<void>((resolve) => {
      speak = resolve;
    });
    let running = false;
    let said = false;
    implementer.scripts.push(async (ctl: TurnControl) => {
      running = true;
      await spoken;
      if (speaksAfter !== undefined) ctl.emit({ kind: 'tool-call', toolCallId: 'c1', title: 'edit', status: 'completed', raw: {} });
      if (report) await reportComplete(h0, implementer);
      said = true;
      await new Promise<void>(() => undefined);
    });
    h0.dispatcher.pass();
    await dispatchUntil(() => running, 'the run to be working');
    const run = runsOf(h0.t.db, task.taskId)[0];
    if (run?.sessionId === null || run === undefined) throw new Error('no run');
    const first = new ProgressCards({ db: h0.t.db, service: h0.service, channels: new Map([['lark', h0.lark]]), appId: APP, minSeconds: 30, failureLimit: 2, clock: h0.clock });
    h0.clock.advance(30_000);
    await first.round();
    expect(h0.lark.boardCards).toHaveLength(1);
    h0.clock.advance(speaksAfter ?? 0);
    speak?.();
    await dispatchUntil(() => said, 'the agent to speak');
    // Its event appended to the session's log.
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    first.stop();
    setExecution(h0.t.db, run.sessionId, 'previous-boot:0', 'implementer');
    h0.dispatcher.stop();
    return { h0, run };
  }

  /** The gateway after a night down: the boot closes the run, then the loop's first round. */
  async function boot(h0: DispatchHarness): Promise<{ h: DispatchHarness; drawn: string | undefined }> {
    h0.clock.advance(5 * 3_600_000);
    const h = dispatchHarness({ t: h0.t, clock: h0.clock });
    harnesses.push(h);
    const bootedAt = h.clock.now();
    h.registry.reconcileBoot();
    await h.dispatcher.boot();
    const next = new ProgressCards({ db: h.t.db, service: h.service, channels: new Map([['lark', h.lark]]), appId: APP, minSeconds: 30, failureLimit: 2, clock: h.clock, bootedAt: () => bootedAt });
    await next.round();
    return { h, drawn: h.lark.cardUpdates.at(-1)?.view.markdown };
  }

  it("draws an interrupted run final, its time ending at its agent's last output, not at the boot's events after it", async () => {
    const { h0, run } = await before(95_000);
    const { h, drawn } = await boot(h0);
    expect(getRun(h.t.db, run.runId)?.outcome).toBe('interrupted');
    // The boot wrote events of its own into the session after the agent's.
    expect(h.t.db.prepare("SELECT count(*) AS n FROM events WHERE session_id = ? AND type IN ('turn_ended', 'session_state_changed')").get(run.sessionId)).not.toEqual({ n: 0 });
    expect(drawn).toContain('⏸ interrupted by a restart after 2 min 5 s');
    expect(drawn).toContain('✅ edit');
    expect(progressCard(h.t.db, run.runId)?.state).toBe('final');
  });

  it('ends the time of a run whose agent said nothing at its last event before the boot', async () => {
    const { h0, run } = await before(undefined);
    const { drawn } = await boot(h0);
    expect(drawn).toContain('⏸ interrupted by a restart after 0 s');
    expect(drawn).not.toContain(' h ');
    expect(getRun(h0.t.db, run.runId)?.endedAt).not.toBeNull();
  });

  it('draws a run that had reported with its outcome, not interrupted', async () => {
    const { h0 } = await before(10_000, true);
    const { drawn } = await boot(h0);
    expect(drawn).toContain('✓ completed after');
    expect(drawn).not.toContain('interrupted');
  });
});
