import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboundCardAction } from '../src/core/router.js';
import { boardCardNonce } from '../src/core/ids.js';
import { appendEvents } from '../src/db/events.js';
import { getRun, getTask, progressCard } from '../src/db/kanban-read.js';
import { notePerson } from '../src/db/people.js';
import { createSession } from '../src/db/sessions.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { ProgressCards } from '../src/kanban/progress.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import type { CreatedVia, RunRow, TaskRow } from '../src/kanban/types.js';
import type { Principal, Tier } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';

/**
 * A progress card's Stop (progress cards spec §8): judged by `KanbanChat` --
 * operate tier read live, the card's run, the board's stop bound to that run --
 * and redrawn by `ProgressCards`: at once after a stop, final with "This run
 * has ended." for a stale press, and with its try bumped for a press refused
 * for tier.
 */

const APP = 'cli_app';
const PLACES = ['w1', 'w2', 'w3', 'w4'];
const ALICE: Principal = { openId: 'ou_alice', unionId: 'on_alice', displayName: 'Alice' };
const BOB: Principal = { openId: 'ou_bob', unionId: 'on_bob', displayName: 'Bob' };
const VIA: CreatedVia = { kind: 'chat', channel: 'lark', appId: APP, conversationId: 'oc_team', threadId: 'omt_1', rootId: 'om_root', chatType: 'group' };

let t: TestDb;
let clock: ManualClock;
let service: KanbanService;
let lark: FakeChannel;
let cards: ProgressCards;
let chat: KanbanChat;
let operators: Set<string>;
let cancelled: string[];
let made: number;

beforeEach(() => {
  t = testDb();
  clock = new ManualClock();
  service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: new Set(PLACES),
    clock,
    maxRunning: 8,
    people: { canTalk: () => true },
  });
  lark = new FakeChannel({ id: 'lark', clock });
  operators = new Set(['ou_alice']);
  cancelled = [];
  made = 0;
  const people = new PeopleDirectory({ db: t.db, appId: APP, canTalk: () => true });
  notePerson(t.db, { appId: APP, unionId: 'on_alice', openId: 'ou_alice', name: 'Alice' }, clock.now());
  notePerson(t.db, { appId: APP, unionId: 'on_bob', openId: 'ou_bob', name: 'Bob' }, clock.now());
  cards = new ProgressCards({
    db: t.db,
    service,
    channels: new Map([['lark', lark]]),
    appId: APP,
    minSeconds: 30,
    failureLimit: 2,
    clock,
    nameOf: (p) => people.chatName(p),
  });
  chat = new KanbanChat({
    service,
    hasTier: (p: Principal, tier: Tier) => tier === 'talk' || operators.has(p.openId),
    people,
    appId: APP,
    cancel: (runId) => cancelled.push(runId),
    progressRedraw: (runId) => cards.redrawNow(runId),
    progressEnded: (messageId, runId) => cards.redrawEnded(messageId, runId),
    progressRefused: (messageId, runId) => cards.refusedTier(messageId, runId),
  });
});
afterEach(() => {
  cards.stop();
  t.close();
});

function create(): TaskRow {
  const r = service.create({ title: 'Fix the login test', assignee: 'implementer', createdBy: 'lark:on_alice', createdVia: VIA, workspace: PLACES[made++] ?? 'w1' });
  if (!r.ok) throw new Error(r.message);
  return r.task;
}

function started(taskId: string): RunRow {
  const c = service.claim(taskId);
  if (!c.ok) throw new Error(c.message);
  const id = `s_${c.run.runId}`;
  createSession(t.db, { id, agentId: 'implementer', workspaceId: 'w1', ownerPrincipal: 'kanban' }, clock.now());
  const a = service.attachSession(c.run.runId, id);
  if (!a.ok) throw new Error(a.code);
  return a.run;
}

/** A run with its card sent: the message the presses are on. */
async function withCard(): Promise<{ task: TaskRow; run: RunRow; messageId: string; value: Readonly<Record<string, string>> }> {
  const task = create();
  const run = started(task.taskId);
  clock.advance(30_000);
  await cards.round();
  const messageId = progressCard(t.db, run.runId)?.messageId;
  const value = lark.boardCards.at(-1)?.view.buttons[0]?.value;
  if (messageId === null || messageId === undefined || value === undefined) throw new Error('no card');
  return { task, run, messageId, value };
}

/** The Stop button of the card as last drawn. */
function stopValue(): Readonly<Record<string, string>> {
  const view = lark.cardUpdates.at(-1)?.view ?? lark.boardCards.at(-1)?.view;
  const value = view?.buttons.find((b) => b.label === 'Stop')?.value;
  if (value === undefined) throw new Error('no Stop button');
  return value;
}

function press(who: Principal, messageId: string, value: Readonly<Record<string, string>>): InboundCardAction {
  return { chatId: 'oc_team', messageId, operator: who, value: { ...value } };
}

describe('a Stop press', () => {
  it("stops the run as /kanban task stop does, answers at once, and redraws the card as stopping", async () => {
    const { task, run, messageId } = await withCard();
    lark.hold();
    const answer = await chat.card(press(ALICE, messageId, stopValue()));
    // Answered before the redraw, held at the channel, has landed.
    expect(answer).toBe(`Stopping \`${task.taskId}\`: the card shows how it goes.`);
    expect(lark.cardUpdates).toEqual([]);
    expect(getRun(t.db, run.runId)?.outcome).toBe('cancelled');
    expect(getTask(t.db, task.taskId)).toMatchObject({ phase: 'blocked', blockKind: 'needs_input', blockReason: 'stopped by lark:on_alice' });
    expect(cancelled).toEqual([run.runId]);
    lark.release();
    await chat.idle(1_000);
    const drawn = lark.cardUpdates.at(-1);
    expect(drawn?.messageId).toBe(messageId);
    expect(drawn?.view.markdown).toContain('⏸ stopping, asked by Alice');
    expect(drawn?.view.buttons).toEqual([]);
  });

  it('refuses talk tier, redraws the card with its try one higher, and a press of the new value once granted stops', async () => {
    const { run, messageId } = await withCard();
    const answer = await chat.card(press(BOB, messageId, stopValue()));
    expect(answer).toBe('Stop changes the board, and needs operator permission.');
    await chat.idle(1_000);
    expect(getRun(t.db, run.runId)?.outcome).toBeNull();
    expect(stopValue()['try']).toBe('1');
    expect(lark.cardUpdates.at(-1)?.view.attempt).toBe(1);
    operators.add('ou_bob');
    clock.advance(1_000);
    await chat.card(press(BOB, messageId, stopValue()));
    expect(getRun(t.db, run.runId)?.outcome).toBe('cancelled');
  });

  it('redraws two tier refusals within 5 s once, and the loop draws the second try at the pace with nothing else changed', async () => {
    const { messageId } = await withCard();
    const value = stopValue();
    await chat.card(press(BOB, messageId, value));
    await chat.idle(1_000);
    expect(lark.cardUpdates).toHaveLength(1);
    const first = lark.cardUpdates[0]!;
    clock.advance(2_000);
    await chat.card(press({ ...BOB, openId: 'ou_carol', unionId: 'on_carol' }, messageId, stopValue()));
    await chat.idle(1_000);
    expect(lark.cardUpdates).toHaveLength(1);
    clock.advance(3_000);
    await cards.round();
    expect(lark.cardUpdates).toHaveLength(2);
    const second = lark.cardUpdates[1]!;
    expect(second.view.buttons[0]?.value['try']).toBe('2');
    expect(second.view.markdown).toBe(first.view.markdown);
  });

  it("refuses a person's run, a run of another task, and a value that does not match its nonce", async () => {
    const { task, run, messageId, value } = await withCard();
    expect(await chat.card(press(ALICE, messageId, { ...value, run: 'r_other' }))).toBe('That button does not match the card it is on.');
    const other = await withCard();
    const foreign = { ...value, run: other.run.runId, nonce: boardCardNonce(APP, task.taskId, other.run.runId) };
    expect(await chat.card(press(ALICE, messageId, foreign))).toBe('That button is not for a run of this task.');
    const r = service.create({ title: 'Call the venue', assignee: 'lark:on_bob', createdBy: 'lark:on_alice', createdVia: VIA });
    if (!r.ok) throw new Error(r.message);
    const claimed = service.claim(r.task.taskId);
    if (!claimed.ok) throw new Error(claimed.message);
    const personRun = { kind: 'kanban', act: 'stop', task: r.task.taskId, run: claimed.run.runId, nonce: boardCardNonce(APP, r.task.taskId, claimed.run.runId) };
    expect(await chat.card(press(ALICE, 'om_person', personRun))).toBe("That button is not for an agent's run.");
    expect(getRun(t.db, run.runId)?.outcome).toBeNull();
    expect(getRun(t.db, claimed.run.runId)?.outcome).toBeNull();
  });

  it('draws a stale press final with "This run has ended.", one a message every 5 s, the board unchanged', async () => {
    const { task, run, messageId } = await withCard();
    const value = stopValue();
    service.endRun(run.runId, { outcome: 'failed', error: 'boom', hadSideEffects: false });
    service.closeRun(run.runId);
    const answer = await chat.card(press(ALICE, messageId, value));
    expect(answer).toBe(`That run has ended: \`/kanban task show ${task.taskId}\` says where the task is.`);
    await chat.idle(1_000);
    expect(lark.cardUpdates.at(-1)?.view.markdown).toMatch(/✗ failed after 30 s\nThis run has ended\./);
    expect(progressCard(t.db, run.runId)?.state).toBe('final');
    const updates = lark.cardUpdates.length;
    await chat.card(press(BOB, messageId, value));
    await chat.idle(1_000);
    expect(lark.cardUpdates).toHaveLength(updates);
    clock.advance(5_000);
    await chat.card(press(ALICE, messageId, value));
    await chat.idle(1_000);
    expect(lark.cardUpdates).toHaveLength(updates + 1);
    expect(getTask(t.db, task.taskId)?.phase).not.toBe('blocked');
  });

  it('takes a stop refused as run_superseded or no_open_run for a stale press', async () => {
    const { task, run, messageId } = await withCard();
    const value = stopValue();
    // The run ended, and its retry opened, between the check and the stop: the board refuses it.
    const original = service.stop.bind(service);
    service.stop = (taskId, by) => {
      service.endRun(run.runId, { outcome: 'failed', error: 'boom', hadSideEffects: false });
      service.closeRun(run.runId);
      started(taskId);
      return original(taskId, by, { runId: run.runId });
    };
    expect(await chat.card(press(ALICE, messageId, value))).toContain('That run has ended');
    expect(getTask(t.db, task.taskId)?.phase).toBe('open');
    service.stop = () => ({ ok: false, code: 'no_open_run', message: 'none' });
    clock.advance(5_000);
    const other = await withCard();
    expect(await chat.card(press(ALICE, other.messageId, other.value))).toContain('That run has ended');
  });

  it('does nothing more for a press on a run already ending', async () => {
    const { task, run, messageId } = await withCard();
    const value = stopValue();
    expect(service.stop(task.taskId, 'lark:on_bob').ok).toBe(true);
    const before = lark.cardUpdates.length;
    expect(await chat.card(press(ALICE, messageId, value))).toBe('That run is already ending.');
    await chat.idle(1_000);
    expect(lark.cardUpdates).toHaveLength(before);
    expect(cancelled).toEqual([]);
    expect(getRun(t.db, run.runId)?.outcome).toBe('cancelled');
  });

  it("refuses the board's stop for another run's id", async () => {
    const { task } = await withCard();
    expect(service.stop(task.taskId, 'lark:on_alice', { runId: 'r_not_open' })).toMatchObject({ ok: false, code: 'run_superseded' });
    expect(getTask(t.db, task.taskId)?.phase).toBe('open');
  });

  it('lands an update in flight before the stopping redraw', async () => {
    const { run, messageId } = await withCard();
    const value = stopValue();
    appendEvents(t.db, run.sessionId ?? '', [{ type: 'tool_call', actor: 'agent', payload: { toolCallId: 'c1', title: 'Read', status: 'in_progress' } }], clock.now());
    clock.advance(5_000);
    lark.hold();
    const round = cards.round();
    await new Promise((r) => setImmediate(r));
    await chat.card(press(ALICE, messageId, value));
    lark.release();
    await round;
    await chat.idle(1_000);
    expect(lark.cardUpdates.map((u) => u.view.buttons.length)).toEqual([1, 0]);
    expect(lark.cardUpdates.at(-1)?.view.markdown).toContain('⏸ stopping, asked by Alice');
  });

  it('draws a row whose run has closed final and marks it final, and a let-go row final, leaving it let go', async () => {
    const a = await withCard();
    service.endRun(a.run.runId, { outcome: 'failed', error: 'boom', hadSideEffects: false });
    service.closeRun(a.run.runId);
    await cards.redrawNow(a.run.runId);
    expect(lark.cardUpdates.at(-1)?.view.markdown).toContain('✗ failed');
    expect(progressCard(t.db, a.run.runId)?.state).toBe('final');
    const b = await withCard();
    service.progressCardLetGo(b.run.runId);
    await cards.redrawNow(b.run.runId);
    expect(lark.cardUpdates.at(-1)?.messageId).toBe(b.messageId);
    expect(progressCard(t.db, b.run.runId)?.state).toBe('let_go');
  });

  it('stops with progress cards off, and redraws nothing', async () => {
    const { task, run, messageId } = await withCard();
    const value = stopValue();
    const off = new KanbanChat({
      service,
      hasTier: () => true,
      people: new PeopleDirectory({ db: t.db, appId: APP, canTalk: () => true }),
      appId: APP,
    });
    await off.card(press(ALICE, messageId, value));
    await off.idle(1_000);
    expect(getRun(t.db, run.runId)?.outcome).toBe('cancelled');
    expect(getTask(t.db, task.taskId)?.phase).toBe('blocked');
    expect(lark.cardUpdates).toEqual([]);
  });
});
