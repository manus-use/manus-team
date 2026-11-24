import { afterEach, describe, expect, it } from 'vitest';
import { SessionActor, type SubmitRequest } from '../src/core/session-actor.js';
import { createSession } from '../src/db/sessions.js';
import { bindSession } from '../src/db/bindings.js';
import { lastSeq, readEvents } from '../src/db/events.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import type { BindingKey, Event } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { FakeDriver } from './helpers/driver.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';

/**
 * What the session layer gains for a turn the board woke (wake spec §6.1): a
 * submit's `origin`, written into its `turn_submitted`, and two callbacks, so the
 * waker can tell a prompt that reached the agent from a start that failed, and a
 * duplicate from a refusal, without a read of the turns table.
 */

const NOW = 1_760_000_000_000;
const KEY: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat', threadId: 'omt_1' };

const open: TestDb[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
  clearSecrets();
});

function harness() {
  const db = testDb();
  open.push(db);
  const clock = new ManualClock(NOW);
  const driver = new FakeDriver();
  const notes: string[] = [];
  createSession(db.db, { id: 's_1', agentId: 'fake', workspaceId: 'plain-dir:x', ownerPrincipal: 'on_owner' }, NOW);
  bindSession(db.db, KEY, 's_1', NOW);
  const actor = new SessionActor({
    db: db.db,
    sessionId: 's_1',
    driver,
    channel: new FakeChannel({ clock }),
    key: KEY,
    target: { chatId: KEY.conversationId, threadId: KEY.threadId },
    cwd: '/tmp/workspace',
    clock,
    note: (line) => notes.push(line),
  });
  const events = (): readonly Event[] => readEvents(db.db, 's_1', 0, lastSeq(db.db, 's_1'));
  return { db, actor, driver, notes, events };
}

function woken(extra: Partial<SubmitRequest> = {}): SubmitRequest {
  return { messageId: 'wake:abc', appId: KEY.appId, input: { text: 'Board update: …', paths: [] }, ...extra };
}

describe('onTurn', () => {
  it('is called once, with created true, before the prompt reaches the agent', async () => {
    const h = harness();
    const calls: string[] = [];
    h.driver.scripts = [
      (ctl) => {
        calls.push('agent');
        ctl.end('completed');
      },
    ];
    const terminal = await h.actor.submit(
      woken({ onTurn: (t) => calls.push(`turn ${String(t.created)}`), onPrompted: () => calls.push('prompted') }),
    );
    expect(terminal).toBe('completed');
    expect(calls).toEqual(['turn true', 'prompted', 'agent']);
  });

  it('says created false for a submit whose key already made its turn, and never prompts for it', async () => {
    const h = harness();
    await h.actor.submit(woken());
    const calls: string[] = [];
    await h.actor.submit(woken({ onTurn: (t) => calls.push(`turn ${String(t.created)}`), onPrompted: () => calls.push('prompted') }));
    expect(calls).toEqual(['turn false']);
    expect(h.driver.lastRuntime?.prompts).toHaveLength(1);
  });

  it('notes a throw from it and runs the turn all the same', async () => {
    const h = harness();
    const terminal = await h.actor.submit(
      woken({
        onTurn: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(terminal).toBe('completed');
    expect(h.notes.some((n) => n.includes('onTurn') && n.includes('boom'))).toBe(true);
  });
});

describe('onPrompted', () => {
  it('is not called when the agent fails to start', async () => {
    const h = harness();
    h.driver.failStartWith = new Error('spawn ENOENT');
    let prompted = 0;
    let created: boolean | undefined;
    const terminal = await h.actor.submit(woken({ onTurn: (t) => (created = t.created), onPrompted: () => (prompted += 1) }));
    expect(terminal).toBe('failed');
    expect(created).toBe(true);
    expect(prompted).toBe(0);
  });

  it('is called once for a turn that fails after the agent started', async () => {
    const h = harness();
    h.driver.scripts = [
      (ctl) => {
        ctl.emit({ kind: 'error', message: 'model overloaded', retryable: true });
        ctl.end('failed');
      },
    ];
    let prompted = 0;
    expect(await h.actor.submit(woken({ onPrompted: () => (prompted += 1) }))).toBe('failed');
    expect(prompted).toBe(1);
  });

  it('notes a throw from it and never fails the turn', async () => {
    const h = harness();
    const terminal = await h.actor.submit(
      woken({
        onPrompted: () => {
          throw new Error('kaput');
        },
      }),
    );
    expect(terminal).toBe('completed');
    expect(h.notes.some((n) => n.includes('onPrompted') && n.includes('kaput'))).toBe(true);
  });
});

describe('origin', () => {
  it('is written into turn_submitted as wake, beside the text, the paths and the message id', async () => {
    const h = harness();
    await h.actor.submit(woken({ origin: { wake: { id: 7, by: 'lark:on_zhixi', name: 'Zhixi Sun' } } }));
    const submitted = h.events().find((e) => e.type === 'turn_submitted');
    expect(submitted?.actor).toBe('user');
    expect(submitted?.payload).toEqual({
      text: 'Board update: …',
      paths: [],
      messageId: 'wake:abc',
      wake: { id: 7, by: 'lark:on_zhixi', name: 'Zhixi Sun' },
    });
  });

  it('writes the name masked, on one line, cut at 80', async () => {
    addSecrets(['sk-secret-9876']);
    const h = harness();
    const long = `Zhixi\nSun sk-secret-9876 ${'x'.repeat(200)}`;
    await h.actor.submit(woken({ origin: { wake: { id: 7, by: 'lark:on_zhixi', name: long } } }));
    const payload = h.events().find((e) => e.type === 'turn_submitted')?.payload as { wake: { name: string } };
    expect(payload.wake.name.startsWith(`Zhixi Sun ${MASK} x`)).toBe(true);
    expect(payload.wake.name).not.toContain('\n');
    expect([...payload.wake.name].length).toBeLessThanOrEqual(80);
  });

  it('is absent from a typed turn', async () => {
    const h = harness();
    await h.actor.submit({ messageId: 'om_1', appId: KEY.appId, input: { text: 'hi', paths: [] } });
    const payload = h.events().find((e) => e.type === 'turn_submitted')?.payload as Record<string, unknown>;
    expect(payload['wake']).toBeUndefined();
  });
});
