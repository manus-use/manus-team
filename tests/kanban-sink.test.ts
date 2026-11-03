import { afterEach, describe, expect, it } from 'vitest';
import { SessionActor } from '../src/core/session-actor.js';
import { createSession } from '../src/db/sessions.js';
import { bindSession } from '../src/db/bindings.js';
import { lastSeq, readEvents } from '../src/db/events.js';
import { getApproval } from '../src/db/approvals.js';
import { KANBAN_CHANNEL, KanbanSink } from '../src/kanban/sink.js';
import type { BindingKey } from '../src/types.js';
import { FakeDriver } from './helpers/driver.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';

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
    expect(JSON.stringify(errors.map((e) => e.payload))).toContain('nothing can reach a person for it');
    const approvalId = (
      readEvents(h.db, 's_run', 0, lastSeq(h.db, 's_run')).find((e) => e.type === 'approval_requested')?.payload as {
        approvalId: string;
      }
    ).approvalId;
    expect(getApproval(h.db, approvalId)?.cardMessageId).toBeNull();
  });
});
