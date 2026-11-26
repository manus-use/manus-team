import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelError, type CardView, type Channel } from '../src/channel/types.js';
import type { InboundCardAction } from '../src/core/router.js';
import { eventsOf, subscriptionsOf } from '../src/db/kanban-read.js';
import { notePerson } from '../src/db/people.js';
import { unblockButton } from '../src/kanban/chat-render.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { NOTICE_SEND_MS, Notifier } from '../src/kanban/notices.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import type { CreatedVia, KanbanEvent, TaskRow } from '../src/kanban/types.js';
import { REDRAW_POLL_MS, REDRAW_TRIES, ROUND_REDRAWS, REDRAW_UPDATE_MS, UnblockRedraws } from '../src/kanban/unblock-redraw.js';
import type { Principal } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock, settle, testDb, type TestDb } from './helpers/db.js';
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
    clock,
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

  it('logs a redraw Lark refused, does not throw, and does not try it again', async () => {
    const a = create('Draft the notes');
    block(a, 'which wiki?');
    await notifier().deliver();
    expect(service.unblock(a.taskId, 'operator:hemanth').ok).toBe(true);
    lark.failNext('updateCard', new ChannelError(230011, 'card gone', false));
    const r = redraws();
    await expect(r.redrawDue()).resolves.toBe(1);
    expect(notes.some((n) => n.includes('om_text_1') && n.includes('card gone'))).toBe(true);
    expect(await r.redrawDue()).toBe(0);
    expect(lark.calls.filter((c) => c === 'updateCard')).toHaveLength(1);
  });

  it('goes on without a redraw that takes too long, and says so', async () => {
    const a = create('Draft the notes');
    block(a, 'which wiki?');
    await notifier().deliver();
    expect(service.unblock(a.taskId, 'operator:hemanth').ok).toBe(true);
    lark.hold();
    const r = redraws({ redrawTimeoutMs: 20 });
    await expect(r.redrawDue()).resolves.toBe(1);
    expect(notes.some((n) => n.includes('om_text_1') && n.includes('longer than 20 ms'))).toBe(true);
    // In its pause: not tried again yet.
    expect(await r.redrawDue()).toBe(0);
    lark.release();
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

describe('a redraw that did not land', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** One notice with an Unblock button for each title, all lifted but the ones `keep` names. */
  async function lifted(titles: string[], keep: string[] = []): Promise<TaskRow[]> {
    const tasks = titles.map((x) => create(x));
    for (const task of tasks) block(task, `about ${task.title}?`);
    await notifier().deliver();
    expect(lark.texts).toHaveLength(1);
    for (const task of tasks) if (!keep.includes(task.title)) expect(service.unblock(task.taskId, 'operator:hemanth').ok).toBe(true);
    return tasks;
  }

  function redrawnFor(): Array<number | null> {
    return t.db
      .prepare<[], { redrawn_for: number | null }>('SELECT redrawn_for FROM kanban_unblock_buttons ORDER BY block_event')
      .all()
      .map((r) => r.redrawn_for);
  }

  function liftOf(task: TaskRow): number {
    const e = eventsOf(t.db, task.taskId).findLast((x) => x.kind === 'unblocked');
    if (e === undefined) throw new Error('not unblocked');
    return e.id;
  }

  it('is not marked when it timed out, and is tried again by the loop after its pause, then marked once it lands', async () => {
    const [a] = await lifted(['Draft the notes']);
    lark.hold();
    const r = redraws({ redrawTimeoutMs: 20 });
    expect(await r.redrawDue()).toBe(1);
    expect(redrawnFor()).toEqual([null]);
    // That update never answers after all.
    lark.failNext('updateCard', new ChannelError(0, 'socket hang up', false));
    lark.release();
    await settle();
    expect(notes).toContain('kanban: redrawing notice om_text_1 failed after timing out: socket hang up (code 0)');
    expect(redrawnFor()).toEqual([null]);
    // Its pause, 2 s, not over yet.
    clock.advance(1_999);
    expect(await r.redrawDue()).toBe(0);
    clock.advance(1);
    expect(await r.redrawDue()).toBe(1);
    expect(lark.cardUpdates).toHaveLength(1);
    expect(redrawnFor()).toEqual([liftOf(a!)]);
    expect(await r.redrawDue()).toBe(0);
  });

  it('is not marked when it got no answer, and is tried again', async () => {
    await lifted(['Draft the notes']);
    lark.failNext('updateCard', new ChannelError(0, 'ECONNRESET', false));
    const r = redraws();
    expect(await r.redrawDue()).toBe(1);
    expect(notes).toContain('kanban: redrawing notice om_text_1 failed: ECONNRESET (code 0)');
    expect(redrawnFor()).toEqual([null]);
    clock.advance(2_000);
    expect(await r.redrawDue()).toBe(1);
    expect(lark.cardUpdates).toHaveLength(1);
    expect(redrawnFor()).not.toEqual([null]);
  });

  it(`is marked after ${REDRAW_TRIES} timeouts in a row, the pause doubling, with one line saying it was given up on`, async () => {
    const [a] = await lifted(['Draft the notes']);
    lark.hold();
    const r = redraws({ redrawTimeoutMs: 10 });
    for (const [i, pause] of [0, 2_000, 4_000, 8_000, 16_000].entries()) {
      if (pause > 0) {
        clock.advance(pause - 1);
        expect(await r.redrawDue()).toBe(0);
        clock.advance(1);
      }
      expect(await r.redrawDue()).toBe(1);
      expect(redrawnFor()).toEqual([i === REDRAW_TRIES - 1 ? liftOf(a!) : null]);
    }
    expect(REDRAW_TRIES).toBe(5);
    expect(lark.calls.filter((c) => c === 'updateCard')).toHaveLength(5);
    expect(notes.filter((n) => n.includes('was not redrawn'))).toEqual([
      'kanban: notice om_text_1 was not redrawn after 5 tries: took longer than 10 ms',
    ]);
    clock.advance(60_000);
    expect(await r.redrawDue()).toBe(0);
    // The five land at last: each said, none drawn again.
    lark.release();
    await settle();
    expect(notes.filter((n) => /^kanban: redrawing notice om_text_1 landed after \d+ ms$/.test(n))).toHaveLength(5);
    expect(lark.calls.filter((c) => c === 'updateCard')).toHaveLength(5);
  });

  it('is marked at once when Lark refused it', async () => {
    const [a] = await lifted(['Draft the notes']);
    lark.failNext('updateCard', new ChannelError(230002, 'bot not in chat', false));
    const r = redraws();
    expect(await r.redrawDue()).toBe(1);
    expect(notes).toContain('kanban: redrawing notice om_text_1 failed: bot not in chat (code 230002)');
    expect(redrawnFor()).toEqual([liftOf(a!)]);
    clock.advance(60_000);
    expect(await r.redrawDue()).toBe(0);
  });

  it('is marked at once when its card is gone, even were it said retryable', async () => {
    await lifted(['Draft the notes']);
    lark.failNext('updateCard', new ChannelError(200740, 'card entity not found', true));
    const r = redraws();
    expect(await r.redrawDue()).toBe(1);
    expect(redrawnFor()).not.toEqual([null]);
    clock.advance(60_000);
    expect(await r.redrawDue()).toBe(0);
  });

  it('waits the time Lark asked for after a retryable refusal', async () => {
    await lifted(['Draft the notes']);
    lark.failNext('updateCard', new ChannelError(99991400, 'rate limited', true, 5_000));
    const r = redraws();
    expect(await r.redrawDue()).toBe(1);
    expect(redrawnFor()).toEqual([null]);
    clock.advance(2_000);
    expect(await r.redrawDue()).toBe(0);
    clock.advance(2_999);
    expect(await r.redrawDue()).toBe(0);
    clock.advance(1);
    expect(await r.redrawDue()).toBe(1);
    expect(redrawnFor()).not.toEqual([null]);
  });

  it('marks, once a timed-out update lands late, only the lifts it drew, and the loop draws the newer one', async () => {
    const [a, b] = await lifted(['Draft the notes', 'Check the links'], ['Check the links']);
    lark.hold();
    const r = redraws({ redrawTimeoutMs: 20 });
    expect(await r.redrawDue()).toBe(1);
    // B is unblocked while the update that drew only A is still out.
    expect(service.unblock(b!.taskId, 'operator:hemanth').ok).toBe(true);
    clock.advance(1_500);
    lark.release();
    await settle();
    expect(notes).toContain('kanban: redrawing notice om_text_1 landed after 1500 ms');
    expect(redrawnFor()).toEqual([liftOf(a!), null]);
    expect(lark.cardUpdates.map((u) => u.view.buttons.length)).toEqual([1]);
    // A's landing ended its pause: B is drawn at the next round.
    expect(await r.redrawDue()).toBe(1);
    expect(lark.cardUpdates.map((u) => u.view.buttons.length)).toEqual([1, 0]);
    expect(redrawnFor()).toEqual([liftOf(a!), liftOf(b!)]);
  });

  it('draws the message again when an older timed-out view lands after a newer one, and tries that again should it time out', async () => {
    const [a, b] = await lifted(['Draft the notes', 'Check the links'], ['Check the links']);
    // The first update is held until the test lets it go, the third never answers; the others land at once.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const slow: Channel = Object.assign(Object.create(lark) as Channel, {
      updateCard: async (messageId: string, view: CardView) => {
        calls += 1;
        if (calls === 1) await held;
        if (calls === 3) await new Promise<never>(() => undefined);
        return lark.updateCard(messageId, view);
      },
    });
    const r = redraws({ channel: slow, redrawTimeoutMs: 20 });
    expect(await r.redrawDue()).toBe(1);
    expect(service.unblock(b!.taskId, 'operator:hemanth').ok).toBe(true);
    // B's press draws both while A's older view is still out.
    await r.redrawMessage('om_text_1');
    expect(lark.cardUpdates.map((u) => u.view.buttons.length)).toEqual([0]);
    expect(redrawnFor()).toEqual([liftOf(a!), liftOf(b!)]);
    release();
    await settle();
    await r.idle(1_000);
    // The older view landed last, marking nothing more: the newer one is sent again over it, and times out.
    expect(lark.cardUpdates.map((u) => u.view.buttons.length)).toEqual([0, 1]);
    expect(redrawnFor()).toEqual([liftOf(a!), liftOf(b!)]);
    expect(calls).toBe(3);
    // Every row marked, so not in the due list: tried again from memory after its pause.
    clock.advance(1_999);
    expect(await r.redrawDue()).toBe(0);
    clock.advance(1);
    expect(await r.redrawDue()).toBe(1);
    expect(lark.cardUpdates.map((u) => u.view.buttons.length)).toEqual([0, 1, 0]);
    clock.advance(60_000);
    expect(await r.redrawDue()).toBe(0);
  });

  it('is marked at once, as a refusal, when the update throws something that is no ChannelError', async () => {
    const [a] = await lifted(['Draft the notes']);
    lark.failNext('updateCard', new TypeError('view.buttons is not iterable'));
    const r = redraws();
    expect(await r.redrawDue()).toBe(1);
    expect(notes).toContain('kanban: redrawing notice om_text_1 failed: view.buttons is not iterable');
    expect(redrawnFor()).toEqual([liftOf(a!)]);
    clock.advance(60_000);
    expect(await r.redrawDue()).toBe(0);
  });

  it('ends its round at an update that timed out, the rest waiting for the next', async () => {
    const a = create('Draft the notes');
    const b = create('Check the links');
    block(a, 'which wiki?');
    await notifier().deliver();
    block(b, 'which links?');
    await notifier().deliver();
    expect(service.unblock(a.taskId, 'operator:hemanth').ok).toBe(true);
    expect(service.unblock(b.taskId, 'operator:hemanth').ok).toBe(true);
    lark.hold();
    const r = redraws({ redrawTimeoutMs: 20 });
    expect(await r.redrawDue()).toBe(1);
    expect(lark.calls.filter((c) => c === 'updateCard')).toHaveLength(1);
    lark.release();
    await settle();
    expect(await r.redrawDue()).toBe(1);
    expect(redrawnFor().every((x) => x !== null)).toBe(true);
  });

  it('marks nothing once stopped, for an update landing late or within its bound', async () => {
    await lifted(['Draft the notes']);
    lark.hold();
    const late = redraws({ redrawTimeoutMs: 20 });
    expect(await late.redrawDue()).toBe(1);
    late.stop();
    lark.release();
    await settle();
    expect(notes.some((n) => /^kanban: redrawing notice om_text_1 landed after \d+ ms$/.test(n))).toBe(true);
    expect(redrawnFor()).toEqual([null]);
    // And one that lands within its bound, after the stop.
    lark.hold();
    const within = redraws({ redrawTimeoutMs: 1_000 });
    const round = within.redrawDue();
    await settle();
    within.stop();
    lark.release();
    expect(await round).toBe(1);
    expect(lark.cardUpdates).toHaveLength(2);
    expect(redrawnFor()).toEqual([null]);
    // Nor is anything redrawn once stopped.
    await within.redrawMessage('om_text_1');
    expect(lark.cardUpdates).toHaveLength(2);
  });

  it('leaves a press redraw that timed out unmarked, for the loop to try again', async () => {
    const [a] = await lifted(['Draft the notes']);
    lark.hold();
    const r = redraws({ redrawTimeoutMs: 20 });
    await r.redrawMessage('om_text_1');
    expect(notes).toContain('kanban: redrawing notice om_text_1 took longer than 20 ms; trying it again later');
    lark.failNext('updateCard', new ChannelError(0, 'socket hang up', false));
    lark.release();
    await settle();
    expect(redrawnFor()).toEqual([null]);
    clock.advance(2_000);
    expect(await r.redrawDue()).toBe(1);
    expect(redrawnFor()).toEqual([liftOf(a!)]);
  });

  it(`waits ${REDRAW_UPDATE_MS} ms for an update, as a notice's send is waited for`, async () => {
    expect(REDRAW_UPDATE_MS).toBe(30_000);
    expect(REDRAW_UPDATE_MS).toBe(NOTICE_SEND_MS);
    await lifted(['Draft the notes']);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    lark.hold();
    const r = redraws();
    const round = r.redrawDue();
    await vi.advanceTimersByTimeAsync(REDRAW_UPDATE_MS - 1);
    expect(notes.some((n) => n.includes('longer than'))).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await round).toBe(1);
    expect(notes).toContain('kanban: redrawing notice om_text_1 took longer than 30000 ms; trying it again later');
    vi.useRealTimers();
    lark.release();
  });

  it("is waited for by the shutdown drain only within the drain's bound", async () => {
    await lifted(['Draft the notes']);
    lark.hold();
    const r = redraws();
    const round = r.redrawDue();
    await settle();
    const started = Date.now();
    expect(await r.idle(50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    r.stop();
    lark.release();
    expect(await round).toBe(1);
    expect(await r.idle(1_000)).toBe(true);
  });

  it('takes no more than a round of redraws, passing over the ones in their pause to the ones after', async () => {
    const tasks: TaskRow[] = [];
    for (let i = 0; i < ROUND_REDRAWS + 2; i += 1) {
      const task = create(`Task ${i}`);
      block(task, 'which?');
      await notifier().deliver();
      tasks.push(task);
    }
    expect(lark.texts).toHaveLength(ROUND_REDRAWS + 2);
    for (const task of tasks) expect(service.unblock(task.taskId, 'operator:hemanth').ok).toBe(true);
    for (let i = 0; i < ROUND_REDRAWS; i += 1) lark.failNext('updateCard', new ChannelError(0, 'ECONNRESET', false));
    const r = redraws();
    expect(await r.redrawDue()).toBe(ROUND_REDRAWS);
    expect(lark.cardUpdates).toHaveLength(0);
    // The first ten in their pause: the two after them are drawn.
    expect(await r.redrawDue()).toBe(2);
    expect(lark.cardUpdates).toHaveLength(2);
    expect(await r.redrawDue()).toBe(0);
    clock.advance(2_000);
    expect(await r.redrawDue()).toBe(ROUND_REDRAWS);
    expect(new Set(lark.cardUpdates.map((u) => u.messageId)).size).toBe(ROUND_REDRAWS + 2);
    expect(redrawnFor().every((x) => x !== null)).toBe(true);
  });
});
