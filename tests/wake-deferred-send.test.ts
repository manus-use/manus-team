import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deferButton, unblock } from '../src/db/kanban.js';
import { deferredButton, hasUnblockButton, subscriptionsOf } from '../src/db/kanban-read.js';
import { replyUuid } from '../src/core/ids.js';
import { unblockButton } from '../src/kanban/chat-render.js';
import { ROUND_MARKER_MS, WAKE_REFUSALS } from '../src/kanban/waker.js';
import type { DeferredWhy, TaskRow } from '../src/kanban/types.js';
import { ChannelError } from '../src/channel/types.js';
import { clearSecrets } from '../src/secrets.js';
import { ALICE, NOW } from './helpers/kanban.js';
import { APP, wakeHarness, type WakeHarness } from './helpers/waker.js';

/**
 * Sending a due button (wake spec §5.9): each round, a due row's lift is read
 * first, and a lifted one owes no card; otherwise one card goes to its
 * conversation, replying to the thread's root, with one Unblock button for the
 * block, its words by why, its uuid the same however often it is tried; once
 * sent, the row is `sent` with the card's message id, the card is recorded for
 * the unblock redraw, and the notice that deferred it is redrawn. A send that
 * fails is tried again after the notifier's pause, and after ten failures, or
 * at once when the notifier has let the conversation go, the row is `failed`.
 * These sends share the round's marker budget.
 */

let letGo: boolean;
let redrawn: string[];
let h: WakeHarness;
function harness(extra: Parameters<typeof wakeHarness>[0] = {}): WakeHarness {
  return wakeHarness({ letGo: () => letGo, redrawNotice: async (messageId) => void redrawn.push(messageId), ...extra });
}
beforeEach(() => {
  clearSecrets();
  letGo = false;
  redrawn = [];
  h = harness();
});
afterEach(() => {
  clearSecrets();
  h.t.close();
});

/**
 * A run's block of a wake-on task whose notice went without its button, as
 * `om_notice`, recorded for its redraw, and whose button is now due with `why`.
 */
function dueBlock(why: DeferredWhy, title = 'Draft the agenda'): { task: TaskRow; sub: number; event: number } {
  const task = h.woken(ALICE, { title });
  h.db.prepare("UPDATE kanban_tasks SET phase = 'blocked', blocked_from = 'open', block_kind = 'needs_input' WHERE task_id = ?").run(task.taskId);
  const event = h.event(task, 'blocked', 'run:r_1', { kind: 'needs_input', reason: 'which speaker?', blockRecurrences: 1 });
  const sub = subscriptionsOf(h.db, task.taskId)[0]?.id ?? 0;
  const key = { subscriptionId: sub, eventId: event };
  const deferred = deferButton(h.db, key, h.clock.now());
  if (!deferred.ok) throw new Error(deferred.message);
  const recorded = h.service.recordUnblockButtons({
    messageId: `om_notice_${event}`,
    channel: 'lark',
    appId: APP,
    markdown: 'blocked: which speaker?\nThe agent is looking at it first.',
    buttons: [{ taskId: task.taskId, blockEvent: event, hasButton: false }],
  });
  if (!recorded.ok) throw new Error(recorded.message);
  const due = h.service.buttonDue(key, why);
  if (!due.ok) throw new Error(due.message);
  // Its wake is past: the turn it was woken for has been and gone.
  h.db.prepare('UPDATE kanban_subscriptions SET wake_cursor = cursor WHERE id = ?').run(sub);
  return { task, sub, event };
}

/** A card's words: its line by why, then the typed command, as Lark may take the card as text. */
function words(line: string, taskId: string): string {
  return `${line}\n\`/kanban task unblock ${taskId}\` lifts it too.`;
}

function buttonCards(): typeof h.lark.texts {
  return h.lark.texts.filter((t) => t.buttons !== undefined);
}

describe('a due button', () => {
  it('goes as one card with one Unblock button, replying in the thread, and is recorded and its notice redrawn', async () => {
    const b = dueBlock('tried');
    await h.round();
    const cards = buttonCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.text).toBe(words(`The agent could not lift the block on \`${b.task.taskId}\` **Draft the agenda**.`, b.task.taskId));
    expect(cards[0]?.buttons).toEqual([unblockButton(APP, { id: b.event, taskId: b.task.taskId })]);
    expect(cards[0]?.uuid).toBe(replyUuid(APP, `wake-button:${b.sub}:${b.event}`, 'unblock'));
    expect(cards[0]?.target).toMatchObject({ chatId: 'oc_chat', threadId: 'omt_1', root: 'om_root' });
    const row = deferredButton(h.db, b.sub, b.event);
    expect(row?.state).toBe('sent');
    expect(row?.messageId).toMatch(/^om_text_/);
    // The card is an Unblock button's record, so a later lift redraws it.
    expect(hasUnblockButton(h.db, APP, b.task.taskId, b.event)).toBe(true);
    expect(redrawn).toEqual([`om_notice_${b.event}`]);
    await h.round();
    expect(buttonCards()).toHaveLength(1);
  });

  it.each([
    ['tried', 'The agent could not lift the block on `{id}` **Draft the agenda**.'],
    ['turn_failed', "The agent's turn ended without lifting the block on `{id}` **Draft the agenda**."],
    ['running', 'The agent is still working on the block on `{id}` **Draft the agenda**; lift it here if you can answer it.'],
    ['not_woken', 'The agent was not woken for the block on `{id}` **Draft the agenda**; lift it here.'],
    ['restart', 'The agent was not woken for the block on `{id}` **Draft the agenda**; lift it here.'],
  ] as const)('says, for %s, %s', async (why, line) => {
    const b = dueBlock(why);
    await h.round();
    expect(buttonCards()[0]?.text).toBe(words(line.replace('{id}', b.task.taskId), b.task.taskId));
  });

  it('owes no card once its block is lifted before the send', async () => {
    const b = dueBlock('tried');
    const r = unblock(h.db, b.task.taskId, ALICE, undefined, NOW + 1, { blockedAt: b.event });
    if (!r.ok) throw new Error(r.message);
    await h.round();
    expect(buttonCards()).toHaveLength(0);
    expect(deferredButton(h.db, b.sub, b.event)?.state).toBe('lifted');
    expect(redrawn).toEqual([]);
  });

  it('is sent, but not recorded for a redraw, when the card went as text', async () => {
    const b = dueBlock('tried');
    h.lark.answerNext('sendText', { messageId: 'om_plain', deduped: false, card: false });
    await h.round();
    expect(deferredButton(h.db, b.sub, b.event)).toMatchObject({ state: 'sent', messageId: 'om_plain' });
    expect(hasUnblockButton(h.db, APP, b.task.taskId, b.event)).toBe(false);
    expect(redrawn).toEqual([`om_notice_${b.event}`]);
  });

  it('is sent and recorded as it stands when its block is lifted during a slow send, so the unblock redraw takes its button', async () => {
    const b = dueBlock('tried');
    const send = h.lark.sendText.bind(h.lark);
    h.lark.sendText = async (...args: Parameters<typeof send>) => {
      const r = unblock(h.db, b.task.taskId, ALICE, undefined, NOW + 1, { blockedAt: b.event });
      if (!r.ok) throw new Error(r.message);
      await h.clock.delay(5_000);
      return send(...args);
    };
    await h.round();
    expect(buttonCards()).toHaveLength(1);
    expect(deferredButton(h.db, b.sub, b.event)?.state).toBe('sent');
    // Recorded with its button: the unblock redraw finds the lift past it and redraws the card.
    expect(hasUnblockButton(h.db, APP, b.task.taskId, b.event)).toBe(true);
  });

  it("is tried again after the notifier's pause, with the same uuid, and failed after ten tries with one log line", async () => {
    const b = dueBlock('tried');
    for (let i = 0; i < WAKE_REFUSALS; i += 1) h.lark.failNext('sendText', new ChannelError(99, 'refused', false));
    await h.round();
    expect(deferredButton(h.db, b.sub, b.event)).toMatchObject({ state: 'due', attempts: 1 });
    h.clock.advance(1_000);
    await h.round();
    expect(deferredButton(h.db, b.sub, b.event)?.attempts).toBe(1);
    h.clock.advance(1_000);
    await h.round();
    expect(deferredButton(h.db, b.sub, b.event)?.attempts).toBe(2);
    for (let i = 2; i < WAKE_REFUSALS; i += 1) {
      h.clock.advance(5 * 60_000);
      await h.round();
    }
    const row = deferredButton(h.db, b.sub, b.event);
    expect(row).toMatchObject({ state: 'failed', attempts: WAKE_REFUSALS });
    expect(h.notes.filter((n) => n.includes('was not sent after'))).toEqual([
      `kanban: the Unblock button of task ${b.task.taskId} (subscription ${b.sub}, event ${b.event}) was not sent after ${WAKE_REFUSALS} tries (refused (code 99)); /kanban task unblock still lifts it`,
    ]);
  });

  it('keeps its uuid after a restart', async () => {
    const b = dueBlock('restart');
    h.lark.failNext('sendText', new ChannelError(99, 'refused', false));
    await h.round();
    h.rebuild();
    await h.round();
    expect(buttonCards().map((c) => c.uuid)).toEqual([replyUuid(APP, `wake-button:${b.sub}:${b.event}`, 'unblock')]);
  });

  it('is failed at once, with one log line and no send, when the notifier has let its conversation go', async () => {
    const b = dueBlock('tried');
    letGo = true;
    await h.round();
    expect(buttonCards()).toHaveLength(0);
    expect(deferredButton(h.db, b.sub, b.event)?.state).toBe('failed');
    expect(h.notes).toContain(
      `kanban: the Unblock button of task ${b.task.taskId} (subscription ${b.sub}, event ${b.event}) is dropped: the notifier has let oc_chat/omt_1 go`,
    );
  });

  it(`shares the round's ROUND_MARKER_MS (${ROUND_MARKER_MS} ms): none starts once it is spent, the rest wait for the next round`, async () => {
    const send = h.lark.sendText.bind(h.lark);
    h.lark.sendText = async (...args: Parameters<typeof send>) => {
      await h.clock.delay(20_000);
      return send(...args);
    };
    const blocks = [dueBlock('tried', 'One'), dueBlock('tried', 'Two'), dueBlock('tried', 'Three')];
    await h.round();
    expect(blocks.map((b) => deferredButton(h.db, b.sub, b.event)?.state)).toEqual(['sent', 'sent', 'due']);
    await h.round();
    expect(blocks.map((b) => deferredButton(h.db, b.sub, b.event)?.state)).toEqual(['sent', 'sent', 'sent']);
  });

  it('shares the budget with the markers: a slow marker leaves the buttons for the next round', async () => {
    const b = dueBlock('tried');
    const task = h.woken(ALICE, { title: 'Book the venue' });
    h.event(task, 'completed', 'run:r_2', { summary: 'booked' });
    h.db.prepare('UPDATE kanban_subscriptions SET cursor = (SELECT max(id) FROM kanban_events) WHERE task_id = ?').run(task.taskId);
    const send = h.lark.sendText.bind(h.lark);
    h.lark.sendText = async (...args: Parameters<typeof send>) => {
      if (args[3] === undefined) await h.clock.delay(ROUND_MARKER_MS);
      return send(...args);
    };
    await h.round();
    expect(h.lark.texts.map((t) => t.text)).toEqual(['Waking the agent for 1 board update.']);
    expect(deferredButton(h.db, b.sub, b.event)?.state).toBe('due');
    await h.round();
    expect(buttonCards()).toHaveLength(1);
    expect(deferredButton(h.db, b.sub, b.event)?.state).toBe('sent');
  });

  it('counts a row whose channel the gateway has not got as a failed send, failed after ten', async () => {
    const b = dueBlock('tried');
    h.db.prepare("UPDATE kanban_subscriptions SET channel = 'teams' WHERE id = ?").run(b.sub);
    await h.round();
    expect(deferredButton(h.db, b.sub, b.event)).toMatchObject({ state: 'due', attempts: 1 });
    for (let i = 1; i < WAKE_REFUSALS; i += 1) {
      h.clock.advance(5 * 60_000);
      await h.round();
    }
    expect(deferredButton(h.db, b.sub, b.event)).toMatchObject({ state: 'failed', attempts: WAKE_REFUSALS });
    expect(h.notes.filter((n) => n.includes('was not sent after'))).toEqual([
      `kanban: the Unblock button of task ${b.task.taskId} (subscription ${b.sub}, event ${b.event}) was not sent after ${WAKE_REFUSALS} tries (no channel teams); /kanban task unblock still lifts it`,
    ]);
    expect(h.lark.texts).toHaveLength(0);
  });

  it('is sent by a waker in release mode too', async () => {
    h.t.close();
    h = harness({ releaseOnly: true });
    const b = dueBlock('not_woken');
    await h.round();
    expect(buttonCards()).toHaveLength(1);
    expect(deferredButton(h.db, b.sub, b.event)?.state).toBe('sent');
  });
});
