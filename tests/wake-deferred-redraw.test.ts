import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buttonDue, buttonSent, deferButton, unblock } from '../src/db/kanban.js';
import { subscriptionsOf } from '../src/db/kanban-read.js';
import { AGENT_FIRST_LINE, AGENT_COULD_NOT_LINE, agentCouldNotTyped, renderUnblockRedraw, unblockButton, type UnblockShown } from '../src/kanban/chat-render.js';
import { KanbanService } from '../src/kanban/service.js';
import { UnblockRedraws } from '../src/kanban/unblock-redraw.js';
import type { TaskRow } from '../src/kanban/types.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { ALICE, newTask, WORKSPACES } from './helpers/kanban.js';
import { APP, IN_THREAD } from './helpers/waker.js';

/**
 * The redraw of a notice that deferred a button (wake spec §5.9): for each of
 * its `has_button` 0 rows whose button card was sent, that block's "The agent
 * is looking at it first." reads "The agent could not lift it; the Unblock
 * button is below.", the Nth sentence the Nth such row's by block event; every
 * lifted row gains its lifted line, button or not; and buttons are drawn only
 * for rows with a button and no lift. A card that went as text, so no button
 * came, has the typed command said instead; and only the line the notifier
 * wrote is replaced, never the sentence quoted in a block's reason.
 */

const when = (): string => '14:05';

function notice(blocks: number): string {
  return Array.from({ length: blocks }, (_x, i) => `\`k_${i}\` is blocked: why ${i}?\n${AGENT_FIRST_LINE}`).join('\n\n');
}

describe('renderUnblockRedraw of a notice with deferred buttons', () => {
  it('leaves a held deferral as sent, and draws no button for it', () => {
    const view = renderUnblockRedraw(APP, notice(1), [{ taskId: 'k_0', blockEvent: 7, hasButton: false, deferred: 'held' }], when);
    expect(view).toEqual({ markdown: notice(1), buttons: [] });
  });

  it("replaces a sent deferral's sentence with the line that the button is below", () => {
    const view = renderUnblockRedraw(APP, notice(1), [{ taskId: 'k_0', blockEvent: 7, hasButton: false, deferred: 'sent' }], when);
    expect(view.markdown).toBe(`\`k_0\` is blocked: why 0?\n${AGENT_COULD_NOT_LINE}`);
    expect(AGENT_COULD_NOT_LINE).toBe('The agent could not lift it; the Unblock button is below.');
    expect(view.buttons).toEqual([]);
  });

  it('says the typed command instead when the button card went as text, so no button came', () => {
    const view = renderUnblockRedraw(APP, notice(1), [{ taskId: 'k_0', blockEvent: 7, hasButton: false, deferred: 'sent', deferredAsText: true }], when);
    expect(view.markdown).toBe('`k_0` is blocked: why 0?\nThe agent could not lift it; `/kanban task unblock k_0` lifts it.');
    expect(agentCouldNotTyped('k_0')).toBe('The agent could not lift it; `/kanban task unblock k_0` lifts it.');
  });

  it('replaces only the line the notifier wrote, never the sentence quoted in a reason', () => {
    const quoted = `\`k_0\` is blocked: they said "The agent is looking at it first." twice\n${AGENT_FIRST_LINE}`;
    const inline = `\`k_1\` is blocked: why?\nThe agent is looking at it first. Or not.\n${AGENT_FIRST_LINE}`;
    const rows: UnblockShown[] = [
      { taskId: 'k_0', blockEvent: 7, hasButton: false, deferred: 'sent' },
      { taskId: 'k_1', blockEvent: 8, hasButton: false, deferred: 'sent' },
    ];
    const view = renderUnblockRedraw(APP, `${quoted}\n\n${inline}`, rows, when);
    expect(view.markdown).toBe(
      `\`k_0\` is blocked: they said "The agent is looking at it first." twice\n${AGENT_COULD_NOT_LINE}\n\n` +
        `\`k_1\` is blocked: why?\nThe agent is looking at it first. Or not.\n${AGENT_COULD_NOT_LINE}`,
    );
  });

  it('replaces the Nth sentence for the Nth deferred row, in block event order', () => {
    const rows: UnblockShown[] = [
      { taskId: 'k_0', blockEvent: 7, hasButton: false, deferred: 'held' },
      { taskId: 'k_1', blockEvent: 8, hasButton: false, deferred: 'sent' },
      { taskId: 'k_2', blockEvent: 9, hasButton: false, deferred: 'due' },
    ];
    const view = renderUnblockRedraw(APP, notice(3), rows, when);
    expect(view.markdown.split('\n').filter((l) => l === AGENT_FIRST_LINE || l === AGENT_COULD_NOT_LINE)).toEqual([
      AGENT_FIRST_LINE,
      AGENT_COULD_NOT_LINE,
      AGENT_FIRST_LINE,
    ]);
  });

  it('adds the lifted line for a deferred row, and draws a button only for a real one not lifted', () => {
    const rows: UnblockShown[] = [
      { taskId: 'k_0', blockEvent: 7, hasButton: false, deferred: 'lifted', lift: { kind: 'unblocked', actor: ALICE, at: 1, woken: true } },
      { taskId: 'k_1', blockEvent: 8, hasButton: true },
    ];
    const view = renderUnblockRedraw(APP, notice(1), rows, when, (p) => (p === ALICE ? 'Zhixi Sun' : undefined));
    expect(view.markdown).toBe(`${notice(1)}\n\n\`k_0\`: Unblocked by Zhixi Sun (woken by the board) at 14:05`);
    expect(view.buttons).toEqual([unblockButton(APP, { id: 8, taskId: 'k_1' })]);
  });
});

describe('UnblockRedraws of a buttonless notice', () => {
  let t: TestDb;
  let clock: ManualClock;
  let service: KanbanService;
  let lark: FakeChannel;
  beforeEach(() => {
    t = testDb();
    clock = new ManualClock();
    service = new KanbanService({ db: t.db, roles: new Map(), workspaces: WORKSPACES, clock });
    lark = new FakeChannel({ id: 'lark', clock });
  });
  afterEach(() => t.close());

  function redraws(): UnblockRedraws {
    return new UnblockRedraws({ db: t.db, service, channels: new Map([['lark', lark]]), appId: APP, zone: 'UTC' });
  }

  function deferredNotice(): { task: TaskRow; sub: number; event: number } {
    const task = newTask(t.db, { createdVia: IN_THREAD });
    t.db.prepare("UPDATE kanban_tasks SET phase = 'blocked', blocked_from = 'open', block_kind = 'needs_input' WHERE task_id = ?").run(task.taskId);
    t.db
      .prepare("INSERT INTO kanban_events (task_id, kind, actor, payload, created_at) VALUES (?, 'blocked', 'run:r_1', jsonb(?), ?)")
      .run(task.taskId, JSON.stringify({ kind: 'needs_input', reason: 'which?' }), clock.now());
    const event = t.db.prepare<[], { id: number }>('SELECT max(id) AS id FROM kanban_events').get()?.id ?? 0;
    const sub = subscriptionsOf(t.db, task.taskId)[0]?.id ?? 0;
    const key = { subscriptionId: sub, eventId: event };
    for (const r of [
      deferButton(t.db, key, clock.now()),
      service.recordUnblockButtons({
        messageId: 'om_notice',
        channel: 'lark',
        appId: APP,
        markdown: `\`${task.taskId}\` is blocked: which?\n${AGENT_FIRST_LINE}`,
        buttons: [{ taskId: task.taskId, blockEvent: event, hasButton: false }],
      }),
    ]) {
      if (!r.ok) throw new Error(r.message);
    }
    return { task, sub, event };
  }

  it('redraws the notice once its button card is sent, its sentence replaced and no button drawn', async () => {
    const n = deferredNotice();
    const key = { subscriptionId: n.sub, eventId: n.event };
    for (const r of [
      buttonDue(t.db, key, 'tried'),
      buttonSent(t.db, key, 'om_card', clock.now()),
      // The card, recorded as the waker records one that went as a card.
      service.recordUnblockButtons({ messageId: 'om_card', channel: 'lark', appId: APP, markdown: 'card', buttons: [{ taskId: n.task.taskId, blockEvent: n.event }] }),
    ]) {
      if (!r.ok) throw new Error(r.message);
    }
    await redraws().redrawMessage('om_notice');
    expect(lark.cardUpdates).toEqual([
      { messageId: 'om_notice', view: { markdown: `\`${n.task.taskId}\` is blocked: which?\n${AGENT_COULD_NOT_LINE}`, buttons: [] } },
    ]);
  });

  it('redraws it with the typed command when the button card went as text, unrecorded', async () => {
    const n = deferredNotice();
    const key = { subscriptionId: n.sub, eventId: n.event };
    for (const r of [buttonDue(t.db, key, 'tried'), buttonSent(t.db, key, 'om_plain', clock.now())]) if (!r.ok) throw new Error(r.message);
    await redraws().redrawMessage('om_notice');
    expect(lark.cardUpdates[0]?.view.markdown).toBe(
      `\`${n.task.taskId}\` is blocked: which?\nThe agent could not lift it; \`/kanban task unblock ${n.task.taskId}\` lifts it.`,
    );
  });

  it("is found by the loop once its block is lifted, and gains the lift's line", async () => {
    const n = deferredNotice();
    const r = unblock(t.db, n.task.taskId, ALICE, undefined, clock.now(), { blockedAt: n.event });
    if (!r.ok) throw new Error(r.message);
    expect(await redraws().redrawDue()).toBe(1);
    expect(lark.cardUpdates[0]?.view.markdown).toMatch(new RegExp(`^\`${n.task.taskId}\` is blocked: which\\?\\n${AGENT_FIRST_LINE}\\n\\n\`${n.task.taskId}\`: Unblocked by `));
    expect(lark.cardUpdates[0]?.view.buttons).toEqual([]);
  });
});
