import { afterEach, describe, expect, it } from 'vitest';
import { SessionActor } from '../src/core/session-actor.js';
import { createSession } from '../src/db/sessions.js';
import { bindSession } from '../src/db/bindings.js';
import { lastSeq, readEvents } from '../src/db/events.js';
import { getApproval } from '../src/db/approvals.js';
import { FORWARDED_MAX, KANBAN_CHANNEL, KanbanSink } from '../src/kanban/sink.js';
import type { BindingKey } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { FakeDriver } from './helpers/driver.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { newTask } from './helpers/kanban.js';

const NOW = 1_760_000_000_000;
const open: TestDb[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

describe('KanbanSink', () => {
  it('is the kanban channel, and discards text and cards', async () => {
    const sink = new KanbanSink(() => NOW);
    expect(sink.id).toBe(KANBAN_CHANNEL);
    expect(await sink.sendText({ chatId: 'k_1', threadId: 'r_1' }, 'hello', 'u1')).toEqual({
      messageId: 'kanban:u1',
      deduped: false,
    });
    const card = await sink.openCard({ chatId: 'k_1', threadId: 'r_1' }, 'starting', 'u2');
    expect(card).toMatchObject({ messageId: 'kanban:u2', createdAt: NOW });
    await card.set('more');
    await card.finish('done');
    await sink.react('m', 'OK');
    await sink.unreact('m', 'OK');
    await sink.updateApprovalCard('m', { action: 'a', choice: 'b', answeredBy: 'c' });
  });

  it("lets a run's turn complete with every event in the session log", async () => {
    const h = testDb();
    open.push(h);
    const clock = new ManualClock(NOW);
    const key: BindingKey = { channel: KANBAN_CHANNEL, appId: 'cli_app', conversationId: 'k_1', threadId: 'r_1' };
    createSession(h.db, { id: 's_run', agentId: 'implementer', workspaceId: 'default', ownerPrincipal: 'kanban' }, NOW);
    bindSession(h.db, key, 's_run', NOW);
    const driver = new FakeDriver();
    driver.scripts.push((ctl) => {
      ctl.emit({ kind: 'message-chunk', text: 'working' });
      ctl.end('completed');
    });
    const actor = new SessionActor({
      db: h.db,
      sessionId: 's_run',
      driver,
      channel: new KanbanSink(() => clock.now()),
      key,
      target: { chatId: 'k_1', threadId: 'r_1' },
      cwd: '/tmp/workspace',
      clock,
    });

    expect(await actor.submit({ messageId: 'kanban:r_1:0', appId: 'cli_app', input: { text: 'go', paths: [] } })).toBe(
      'completed',
    );
    await actor.close();
    expect(readEvents(h.db, 's_run', 0, lastSeq(h.db, 's_run')).map((e) => e.type)).toContain('agent_message_chunk');
  });

  it('refuses an approval card, so the agent is released as cancelled rather than left waiting', async () => {
    const h = testDb();
    open.push(h);
    const clock = new ManualClock(NOW);
    const key: BindingKey = { channel: KANBAN_CHANNEL, appId: 'cli_app', conversationId: 'k_1', threadId: 'r_1' };
    createSession(h.db, { id: 's_run', agentId: 'implementer', workspaceId: 'default', ownerPrincipal: 'kanban' }, NOW);
    bindSession(h.db, key, 's_run', NOW);
    const driver = new FakeDriver();
    let answer: unknown;
    driver.scripts.push(async (ctl) => {
      answer = await ctl.ask('edit src/a.ts', [{ optionId: 'allow', name: 'Allow' }]);
      ctl.end('completed');
    });
    const actor = new SessionActor({
      db: h.db,
      sessionId: 's_run',
      driver,
      channel: new KanbanSink(() => clock.now()),
      key,
      target: { chatId: 'k_1', threadId: 'r_1' },
      cwd: '/tmp/workspace',
      clock,
    });

    await actor.submit({ messageId: 'kanban:r_1:0', appId: 'cli_app', input: { text: 'go', paths: [] } });
    await actor.close();
    expect(answer).toEqual({ kind: 'cancelled' });
    const errors = readEvents(h.db, 's_run', 0, lastSeq(h.db, 's_run')).filter((e) => e.type === 'agent_error');
    expect(JSON.stringify(errors.map((e) => e.payload))).toContain('forwards no approval card to a chat');
    const approvalId = (
      readEvents(h.db, 's_run', 0, lastSeq(h.db, 's_run')).find((e) => e.type === 'approval_requested')?.payload as {
        approvalId: string;
      }
    ).approvalId;
    expect(getApproval(h.db, approvalId)?.cardMessageId).toBeNull();
  });
});

describe('KanbanSink forwarding approvals (spec §7.1)', () => {
  function actorOn(h: TestDb, taskId: string, sink: KanbanSink, driver: FakeDriver, clock: ManualClock): SessionActor {
    const key: BindingKey = { channel: KANBAN_CHANNEL, appId: 'cli_app', conversationId: taskId, threadId: 'r_1' };
    createSession(h.db, { id: 's_run', agentId: 'watched', workspaceId: 'default', ownerPrincipal: 'kanban' }, NOW);
    bindSession(h.db, key, 's_run', NOW);
    return new SessionActor({
      db: h.db,
      sessionId: 's_run',
      driver,
      channel: sink,
      key,
      target: { chatId: taskId, threadId: 'r_1' },
      cwd: '/tmp/workspace',
      clock,
    });
  }

  it("posts a supervised agent's approval card to the task's first subscription, naming the task, and redraws it there", async () => {
    const h = testDb();
    open.push(h);
    const clock = new ManualClock(NOW);
    // A long title is cut on a code point: an emoji at the cut is dropped whole.
    const task = newTask(h.db, { title: `Rotate the logs ${'x'.repeat(183)}😀😀` });
    const lark = new FakeChannel({ id: 'lark', clock });
    const sink = new KanbanSink(() => clock.now(), { db: h.db, channels: new Map([['lark', lark]]), appId: 'cli_app' });
    const driver = new FakeDriver();
    let answer: unknown;
    driver.scripts.push(async (ctl) => {
      answer = await ctl.ask('delete old.log', [{ optionId: 'allow', name: 'Allow' }]);
      ctl.end('completed');
    });
    const actor = actorOn(h, task.taskId, sink, driver, clock);
    const turn = actor.submit({ messageId: 'kanban:r_1:0', appId: 'cli_app', input: { text: 'go', paths: [] } });
    for (let i = 0; i < 50 && lark.approvalCards.length === 0; i += 1) await new Promise((r) => setImmediate(r));
    expect(lark.approvalCards.map((c) => [c.target, c.spec.action])).toEqual([
      [{ chatId: 'oc_chat', threadId: '' }, `Task ${task.taskId}, Rotate the logs ${'x'.repeat(183)}…, asks: delete old.log`],
    ]);
    const card = lark.approvalCards[0]!;
    const report = actor.resolveFromCard({
      approvalId: card.spec.approvalId,
      optionId: 'allow',
      nonce: card.spec.nonce,
      principal: { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' },
      via: 'lark',
    });
    expect(report.kind).toBe('resolved');
    expect(await turn).toBe('completed');
    expect(answer).toEqual({ kind: 'selected', optionId: 'allow' });
    await actor.close();
    expect(lark.approvalUpdates.map((u) => u.messageId)).toEqual(['om_approval_1']);
    // Redrawn once, then forgotten: the sink holds no card it has no more use for.
    await sink.updateApprovalCard('om_approval_1', { action: 'a', choice: 'b', answeredBy: 'c' });
    expect(lark.approvalUpdates).toHaveLength(1);
    expect(getApproval(h.db, card.spec.approvalId)?.cardMessageId).toBe('om_approval_1');
  });

  it('remembers at most FORWARDED_MAX forwarded cards for their redraw, forgetting the oldest', async () => {
    const h = testDb();
    open.push(h);
    const clock = new ManualClock(NOW);
    const task = newTask(h.db, { title: 'Rotate the logs' });
    const lark = new FakeChannel({ id: 'lark', clock });
    const sink = new KanbanSink(() => clock.now(), { db: h.db, channels: new Map([['lark', lark]]), appId: 'cli_app' });
    const sent: string[] = [];
    for (let i = 0; i <= FORWARDED_MAX; i += 1) {
      const spec = { approvalId: `a_${i}`, action: 'delete old.log', options: [{ optionId: 'allow', name: 'Allow' }], nonce: 'n' };
      sent.push((await sink.sendApprovalCard({ chatId: task.taskId, threadId: 'r_1' }, spec, `u_${i}`)).messageId);
    }
    const view = { action: 'a', choice: 'b', answeredBy: 'c' };
    // The first, one past the bound, is forgotten: not this process's to redraw any more.
    await sink.updateApprovalCard(sent[0]!, view);
    expect(lark.approvalUpdates).toEqual([]);
    await sink.updateApprovalCard(sent[1]!, view);
    await sink.updateApprovalCard(sent[FORWARDED_MAX]!, view);
    expect(lark.approvalUpdates.map((u) => u.messageId)).toEqual([sent[1], sent[FORWARDED_MAX]]);
  });

  it("asks no chat of another bot's, and releases the agent as cancelled", async () => {
    const h = testDb();
    open.push(h);
    const clock = new ManualClock(NOW);
    const task = newTask(h.db, { title: 'Rotate the logs' });
    const lark = new FakeChannel({ id: 'lark', clock });
    const sink = new KanbanSink(() => clock.now(), { db: h.db, channels: new Map([['lark', lark]]), appId: 'cli_other' });
    const driver = new FakeDriver();
    let answer: unknown;
    driver.scripts.push(async (ctl) => {
      answer = await ctl.ask('delete old.log', [{ optionId: 'allow', name: 'Allow' }]);
      ctl.end('completed');
    });
    const actor = actorOn(h, task.taskId, sink, driver, clock);
    await actor.submit({ messageId: 'kanban:r_1:0', appId: 'cli_app', input: { text: 'go', paths: [] } });
    await actor.close();
    expect(answer).toEqual({ kind: 'cancelled' });
    expect(lark.approvalCards).toEqual([]);
  });

  it('releases the agent as cancelled when nobody follows the task', async () => {
    const h = testDb();
    open.push(h);
    const clock = new ManualClock(NOW);
    const lark = new FakeChannel({ id: 'lark', clock });
    const sink = new KanbanSink(() => clock.now(), { db: h.db, channels: new Map([['lark', lark]]), appId: 'cli_app' });
    const driver = new FakeDriver();
    let answer: unknown;
    driver.scripts.push(async (ctl) => {
      answer = await ctl.ask('delete old.log', [{ optionId: 'allow', name: 'Allow' }]);
      ctl.end('completed');
    });
    const actor = actorOn(h, 'k_nobody', sink, driver, clock);
    await actor.submit({ messageId: 'kanban:r_1:0', appId: 'cli_app', input: { text: 'go', paths: [] } });
    await actor.close();
    expect(answer).toEqual({ kind: 'cancelled' });
    expect(lark.approvalCards).toEqual([]);
  });
});
