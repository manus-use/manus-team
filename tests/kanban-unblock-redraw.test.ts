import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardView, Channel } from '../src/channel/types.js';
import type { InboundCardAction } from '../src/core/router.js';
import { eventsOf, subscriptionsOf } from '../src/db/kanban-read.js';
import { notePerson } from '../src/db/people.js';
import { unblockButton } from '../src/kanban/chat-render.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { Notifier } from '../src/kanban/notices.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import type { CreatedVia, KanbanEvent, TaskRow } from '../src/kanban/types.js';
import { REDRAW_POLL_MS, UnblockRedraws } from '../src/kanban/unblock-redraw.js';
import type { Principal } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { WORKSPACES } from './helpers/kanban.js';

/**
 * The unblock redraw (kanban spec §9.2, amended): each message of notices that
 * carries Unblock buttons is recorded with its message id, and once a block is
 * lifted, by a press, by chat's or the terminal's unblock, or by an agent's mt,
 * the message is redrawn with a line in place of that button, its other buttons
 * left as they were.
 */

const VIA: CreatedVia = { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: '' };
const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const ALICE = 'lark:on_alice';
/** 2025-10-09 08:53 UTC: the ManualClock's start. */
const AT = '08:53';

let t: TestDb;
let clock: ManualClock;
let service: KanbanService;
let lark: FakeChannel;
let people: PeopleDirectory;
let notes: string[];

beforeEach(() => {
  t = testDb();
  clock = new ManualClock();
  people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: () => true });
  service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock,
  });
  lark = new FakeChannel({ id: 'lark', clock });
  notes = [];
  notePerson(t.db, { appId: 'cli_app', unionId: 'on_owner', openId: 'ou_owner', name: 'Owner' }, clock.now());
});
afterEach(() => {
  t.close();
});

function notifier(): Notifier {
  return new Notifier({
    db: t.db,
    service,
    channels: new Map([['lark', lark]]),
    appId: 'cli_app',
    blockRecurrenceLimit: 2,
    clock,
    note: (line) => notes.push(line),
  });
}

function redraws(opts: { redrawTimeoutMs?: number; zone?: string; channel?: Channel } = {}): UnblockRedraws {
  const { channel, ...rest } = opts;
  return new UnblockRedraws({
    db: t.db,
    service,
    channels: new Map([['lark', channel ?? lark]]),
    appId: 'cli_app',
    nameOf: (p) => people.chatName(p),
    zone: 'UTC',
    note: (line) => notes.push(line),
    ...rest,
  });
}

function create(title: string): TaskRow {
  const r = service.create({ title, assignee: 'implementer', createdBy: ALICE, createdVia: VIA });
  if (!r.ok) throw new Error(r.message);
  return r.task;
}

function block(task: TaskRow, reason: string): KanbanEvent {
  const r = service.block(task.taskId, { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason });
  if (!r.ok) throw new Error(r.message);
  const e = eventsOf(t.db, task.taskId).findLast((x) => x.kind === 'blocked');
  if (e === undefined) throw new Error('not blocked');
  return e;
}

function chat(liftedNotice: (messageId: string) => Promise<void>): KanbanChat {
  return new KanbanChat({
    service,
    hasTier: () => true,
    people,
    appId: 'cli_app',
    redraw: async () => undefined,
    liftedNotice,
  });
}

function press(event: KanbanEvent, messageId: string): InboundCardAction {
  return { chatId: 'oc_team', messageId, operator: OWNER, value: unblockButton('cli_app', event).value };
}

describe('the record of an Unblock message', () => {
  it("records the message a notice's Unblock buttons went under, with each task and the event that blocked it", async () => {
    const a = create('Draft the notes');
    const e = block(a, 'which wiki?');
    expect(await notifier().deliver()).toBeGreaterThan(0);
    expect(lark.texts).toHaveLength(1);
    const sent = lark.texts[0]!;
    expect(sent.buttons).toEqual([unblockButton('cli_app', e)]);
    const rows = t.db.prepare('SELECT message_id, channel, app_id, task_id, block_event, markdown, redrawn_for FROM kanban_unblock_buttons').all();
    expect(rows).toEqual([
      { message_id: 'om_text_1', channel: 'lark', app_id: 'cli_app', task_id: a.taskId, block_event: e.id, markdown: sent.text, redrawn_for: null },
    ]);
  });

  it('records nothing for a message without buttons', async () => {
    const a = create('Draft the notes');
    expect((await service.complete(a.taskId, { kind: 'person', principal: ALICE }, { summary: 'merged' })).ok).toBe(true);
    expect(await notifier().deliver()).toBe(1);
    expect(lark.texts[0]?.buttons).toBeUndefined();
    expect(t.db.prepare('SELECT count(*) AS n FROM kanban_unblock_buttons').get()).toEqual({ n: 0 });
  });
});

describe('the redraw once a block is lifted', () => {
  it('redraws the message at once when its Unblock is pressed, the button replaced by who unblocked it and when', async () => {
    const a = create('Draft the notes');
    const e = block(a, 'which wiki?');
    await notifier().deliver();
    const sent = lark.texts[0]!;
    const r = redraws();
    const c = chat((m) => r.redrawMessage(m));
    expect(await c.card(press(e, 'om_text_1'))).toBe(`\`${a.taskId}\` is unblocked, back to open.`);
    await c.idle();
    expect(lark.cardUpdates).toEqual([
      { messageId: 'om_text_1', view: { markdown: `${sent.text}\n\n\`${a.taskId}\`: Unblocked by Owner at ${AT}`, buttons: [] } },
    ]);
    // Drawn once: the loop finds nothing left to redraw.
    expect(await r.redrawDue()).toBe(0);
    expect(lark.cardUpdates).toHaveLength(1);
  });

  it("redraws it from the loop after chat's /kanban task unblock, by the person's chat name", async () => {
    const a = create('Draft the notes');
    block(a, 'which wiki?');
    await notifier().deliver();
    const sent = lark.texts[0]!;
    const r = redraws();
    expect(await r.redrawDue()).toBe(0);
    // As chat's /kanban task unblock calls it.
    expect(service.unblock(a.taskId, 'lark:on_owner', 'the team wiki').ok).toBe(true);
    expect(await r.redrawDue()).toBe(1);
    expect(lark.cardUpdates).toEqual([
      { messageId: 'om_text_1', view: { markdown: `${sent.text}\n\n\`${a.taskId}\`: Unblocked by Owner at ${AT}`, buttons: [] } },
    ]);
    expect(await r.redrawDue()).toBe(0);
    expect(lark.cardUpdates).toHaveLength(1);
  });

  it("redraws it from the loop after the terminal's mt kanban task unblock, by the principal where no name is known", async () => {
    const a = create('Draft the notes');
    block(a, 'which wiki?');
    await notifier().deliver();
    const sent = lark.texts[0]!;
    // As the terminal's mt calls it, in another process writing the same database.
    expect(service.unblock(a.taskId, 'operator:hemanth').ok).toBe(true);
    expect(await redraws().redrawDue()).toBe(1);
    expect(lark.cardUpdates.map((u) => u.view)).toEqual([
      { markdown: `${sent.text}\n\n\`${a.taskId}\`: Unblocked by operator:hemanth at ${AT}`, buttons: [] },
    ]);
  });

  it('redraws a stale card when it is pressed after the block was lifted, beside the reply', async () => {
    const a = create('Draft the notes');
    const e = block(a, 'which wiki?');
    await notifier().deliver();
    const sent = lark.texts[0]!;
    expect(service.unblock(a.taskId, 'operator:hemanth').ok).toBe(true);
    const r = redraws();
    expect(await r.redrawDue()).toBe(1);
    const c = chat((m) => r.redrawMessage(m));
    expect(await c.card(press(e, 'om_text_1'))).toBe(
      `\`${a.taskId}\` is not blocked as that notice said any more: \`/kanban task show ${a.taskId}\` says where it is.`,
    );
    await c.idle();
    const drawn = { messageId: 'om_text_1', view: { markdown: `${sent.text}\n\n\`${a.taskId}\`: Unblocked by operator:hemanth at ${AT}`, buttons: [] } };
    expect(lark.cardUpdates).toEqual([drawn, drawn]);
  });

  it("leaves a batch's other button as it was when only one of its two blocked tasks is unblocked", async () => {
    const a = create('Draft the notes');
    const b = create('Check the links');
    const ea = block(a, 'which wiki?');
    const eb = block(b, 'which links?');
    await notifier().deliver();
    expect(lark.texts).toHaveLength(1);
    const sent = lark.texts[0]!;
    expect(sent.buttons).toEqual([unblockButton('cli_app', ea), unblockButton('cli_app', eb)]);
    const r = redraws();
    clock.advance(Date.UTC(2025, 9, 9, 14, 5) - clock.now());
    expect(service.unblock(b.taskId, 'lark:on_owner').ok).toBe(true);
    expect(await r.redrawDue()).toBe(1);
    expect(lark.cardUpdates.at(-1)?.view).toEqual({
      markdown: `${sent.text}\n\n\`${b.taskId}\`: Unblocked by Owner at 14:05`,
      buttons: [unblockButton('cli_app', ea)],
    });
    // The other one later: both lines, no buttons.
    clock.advance(Date.UTC(2025, 9, 9, 15, 30) - clock.now());
    expect(service.unblock(a.taskId, 'operator:hemanth').ok).toBe(true);
    expect(await r.redrawDue()).toBe(1);
    expect(lark.cardUpdates.at(-1)?.view).toEqual({
      markdown: `${sent.text}\n\n\`${a.taskId}\`: Unblocked by operator:hemanth at 15:30\n\`${b.taskId}\`: Unblocked by Owner at 14:05`,
      buttons: [],
    });
    expect(lark.cardUpdates).toHaveLength(2);
  });

  it('logs a redraw that fails, does not throw, and does not try it again', async () => {
    const a = create('Draft the notes');
    block(a, 'which wiki?');
    await notifier().deliver();
    expect(service.unblock(a.taskId, 'operator:hemanth').ok).toBe(true);
    lark.failNext('updateCard', new Error('card gone'));
    const r = redraws();
    await expect(r.redrawDue()).resolves.toBe(1);
    expect(notes.some((n) => n.includes('om_text_1') && n.includes('card gone'))).toBe(true);
    expect(await r.redrawDue()).toBe(0);
    expect(lark.calls.filter((c) => c === 'updateCard')).toHaveLength(1);
  });

  it('gives up on a redraw that takes too long, and says so', async () => {
    const a = create('Draft the notes');
    block(a, 'which wiki?');
    await notifier().deliver();
    expect(service.unblock(a.taskId, 'operator:hemanth').ok).toBe(true);
    lark.hold();
    const r = redraws({ redrawTimeoutMs: 20 });
    await expect(r.redrawDue()).resolves.toBe(1);
    lark.release();
    expect(notes.some((n) => n.includes('om_text_1') && n.includes('longer than'))).toBe(true);
    expect(await r.redrawDue()).toBe(0);
  });

  it('does nothing for a press on a message it has no record of', async () => {
    const a = create('Draft the notes');
    const e = block(a, 'which wiki?');
    const r = redraws();
    const c = chat((m) => r.redrawMessage(m));
    expect(await c.card(press(e, 'om_unknown'))).toBe(`\`${a.taskId}\` is unblocked, back to open.`);
    await c.idle();
    expect(lark.cardUpdates).toEqual([]);
  });

  it("never lets a press's newer view land before the loop's older one of the same message", async () => {
    const a = create('Draft the notes');
    const b = create('Check the links');
    block(a, 'which wiki?');
    const eb = block(b, 'which links?');
    await notifier().deliver();
    const sent = lark.texts[0]!;
    // The first update is held until the test lets it go; any later one lands at once.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    const slow: Channel = Object.assign(Object.create(lark) as Channel, {
      updateCard: async (messageId: string, view: CardView) => {
        if (first) {
          first = false;
          await held;
        }
        return lark.updateCard(messageId, view);
      },
    });
    const r = redraws({ channel: slow });
    expect(service.unblock(a.taskId, 'operator:hemanth').ok).toBe(true);
    const round = r.redrawDue();
    await new Promise((resolve) => setImmediate(resolve));
    // B pressed while the loop's redraw, which still shows B's button, is under way.
    const c = chat((m) => r.redrawMessage(m));
    expect(await c.card(press(eb, 'om_text_1'))).toBe(`\`${b.taskId}\` is unblocked, back to open.`);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await round;
    await c.idle();
    expect(lark.cardUpdates.map((u) => u.view.buttons.length)).toEqual([1, 0]);
    expect(lark.cardUpdates.at(-1)?.view.markdown).toBe(
      `${sent.text}\n\n\`${a.taskId}\`: Unblocked by operator:hemanth at ${AT}\n\`${b.taskId}\`: Unblocked by Owner at ${AT}`,
    );
  });

  it('counts an archive while blocked as the lift, and redraws the card when it is pressed after', async () => {
    const a = create('Draft the notes');
    const e = block(a, 'which wiki?');
    await notifier().deliver();
    const sent = lark.texts[0]!;
    expect(service.archive(a.taskId, 'lark:on_owner').ok).toBe(true);
    const r = redraws();
    expect(await r.redrawDue()).toBe(1);
    const drawn = { messageId: 'om_text_1', view: { markdown: `${sent.text}\n\n\`${a.taskId}\`: Archived by Owner at ${AT}`, buttons: [] } };
    expect(lark.cardUpdates).toEqual([drawn]);
    expect(await r.redrawDue()).toBe(0);
    // Its press finds it no longer blocked, and the card is redrawn again, beside the reply.
    const c = chat((m) => r.redrawMessage(m));
    expect(await c.card(press(e, 'om_text_1'))).toContain('is not blocked as that notice said any more');
    await c.idle();
    expect(lark.cardUpdates).toEqual([drawn, drawn]);
  });

  it('gives the date with the time when the block is lifted on another day than the message was sent', async () => {
    const a = create('Draft the notes');
    block(a, 'which wiki?');
    await notifier().deliver();
    clock.advance(Date.UTC(2025, 9, 10, 9, 0) - clock.now());
    expect(service.unblock(a.taskId, 'operator:hemanth').ok).toBe(true);
    expect(await redraws().redrawDue()).toBe(1);
    expect(lark.cardUpdates[0]?.view.markdown).toMatch(/: Unblocked by operator:hemanth at 10-10 09:00$/);
  });

  it("says the time in the gateway's zone", async () => {
    const a = create('Draft the notes');
    block(a, 'which wiki?');
    await notifier().deliver();
    expect(service.unblock(a.taskId, 'operator:hemanth').ok).toBe(true);
    expect(await redraws({ zone: 'Asia/Shanghai' }).redrawDue()).toBe(1);
    // 08:53 UTC is 16:53 in Shanghai, the same day.
    expect(lark.cardUpdates[0]?.view.markdown).toMatch(/: Unblocked by operator:hemanth at 16:53$/);
  });

  it('redraws the first message after a task blocked again, and leaves the second one its button', async () => {
    const a = create('Draft the notes');
    const e1 = block(a, 'which wiki?');
    await notifier().deliver();
    expect(service.unblock(a.taskId, 'operator:hemanth').ok).toBe(true);
    const e2 = block(a, 'which page?');
    await notifier().deliver();
    const second = lark.texts.find((m) => m.buttons?.some((x) => x.value['event'] === String(e2.id)) === true);
    expect(second).toBeDefined();
    const r = redraws();
    expect(await r.redrawDue()).toBe(1);
    expect(lark.cardUpdates.map((u) => [u.messageId, u.view.buttons.length])).toEqual([['om_text_1', 0]]);
    expect(lark.cardUpdates[0]?.view.markdown).toMatch(/: Unblocked by operator:hemanth at 08:53$/);
    // The first notice's old button is stale: that card is redrawn again, the second left alone.
    const c = chat((m) => r.redrawMessage(m));
    expect(await c.card(press(e1, 'om_text_1'))).toContain('is not blocked as that notice said any more');
    await c.idle();
    expect(lark.cardUpdates.map((u) => [u.messageId, u.view.buttons.length])).toEqual([
      ['om_text_1', 0],
      ['om_text_1', 0],
    ]);
    expect(service.show(a.taskId).ok && service.show(a.taskId)).toMatchObject({ view: { task: { phase: 'blocked' } } });
  });

  it('redraws in the next round a message recorded after its block was already lifted', async () => {
    const a = create('Draft the notes');
    const e = block(a, 'which wiki?');
    expect(service.unblock(a.taskId, 'operator:hemanth').ok).toBe(true);
    await notifier().deliver();
    // The batch told of the block, so it carried its button: by now stale.
    expect(lark.texts[0]?.buttons).toEqual([unblockButton('cli_app', e)]);
    expect(await redraws().redrawDue()).toBe(1);
    expect(lark.cardUpdates.map((u) => u.view.buttons)).toEqual([[]]);
  });
});

describe('the record, when it cannot be made', () => {
  it('is noted, and the cursors still move', async () => {
    const a = create('Draft the notes');
    block(a, 'which wiki?');
    vi.spyOn(service, 'recordUnblockButtons').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(await notifier().deliver()).toBe(1);
    expect(notes.some((n) => n.includes('om_text_1') && n.includes('disk full'))).toBe(true);
    expect(subscriptionsOf(t.db, a.taskId)[0]?.cursor).toBe(eventsOf(t.db, a.taskId).at(-1)?.id);
    expect(t.db.prepare('SELECT count(*) AS n FROM kanban_unblock_buttons').get()).toEqual({ n: 0 });
  });

  it('is not made for a notice whose card was refused and that went as text alone', async () => {
    const a = create('Draft the notes');
    block(a, 'which wiki?');
    lark.answerNext('sendText', { messageId: 'om_plain', deduped: false, card: false });
    expect(await notifier().deliver()).toBe(1);
    expect(t.db.prepare('SELECT count(*) AS n FROM kanban_unblock_buttons').get()).toEqual({ n: 0 });
  });
});

describe('the redraw loop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a round as it starts, every REDRAW_POLL_MS after, and none once stopped', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const a = create('Draft the notes');
    const b = create('Check the links');
    block(a, 'which wiki?');
    await notifier().deliver();
    block(b, 'which links?');
    await notifier().deliver();
    expect(service.unblock(a.taskId, 'operator:hemanth').ok).toBe(true);
    const r = redraws();
    r.start();
    expect(await r.idle(1_000)).toBe(true);
    expect(lark.cardUpdates.map((u) => u.messageId)).toEqual(['om_text_1']);
    expect(service.unblock(b.taskId, 'operator:hemanth').ok).toBe(true);
    vi.advanceTimersByTime(REDRAW_POLL_MS);
    expect(await r.idle(1_000)).toBe(true);
    expect(lark.cardUpdates.map((u) => u.messageId)).toEqual(['om_text_1', 'om_text_2']);
    r.stop();
    const c = create('Name the files');
    block(c, 'which names?');
    await notifier().deliver();
    expect(service.unblock(c.taskId, 'operator:hemanth').ok).toBe(true);
    vi.advanceTimersByTime(REDRAW_POLL_MS * 3);
    expect(await r.idle(1_000)).toBe(true);
    expect(lark.cardUpdates).toHaveLength(2);
    // And a press once stopped does nothing.
    await r.redrawMessage('om_text_3');
    expect(lark.cardUpdates).toHaveLength(2);
  });

  it('is not idle while a redraw is held past its bound', async () => {
    const a = create('Draft the notes');
    block(a, 'which wiki?');
    await notifier().deliver();
    expect(service.unblock(a.taskId, 'operator:hemanth').ok).toBe(true);
    lark.hold();
    const r = redraws({ redrawTimeoutMs: 1_000 });
    const drawing = r.redrawMessage('om_text_1');
    expect(await r.idle(20)).toBe(false);
    lark.release();
    await drawing;
    expect(await r.idle(1_000)).toBe(true);
  });
});
