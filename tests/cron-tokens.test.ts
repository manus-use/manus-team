import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { turnIdempotencyKey } from '../src/core/ids.js';
import { Router } from '../src/core/router.js';
import { bindSession, revokeBindingsAt } from '../src/db/bindings.js';
import { createSession } from '../src/db/sessions.js';
import { createTurn, endTurn, setTurnState } from '../src/db/turns.js';
import { CronTokens } from '../src/cron/tokens.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import { MASK, clearSecrets, redactKnownSecrets } from '../src/secrets.js';
import type { BindingKey, InboundMessage } from '../src/types.js';
import { SessionRegistry } from '../src/core/registry.js';
import { NamedWorkspaces } from '../src/core/workspace.js';
import { FakeChannel } from './helpers/channel.js';
import { cronHarness, holdsTurn, type CronHarness } from './helpers/cron.js';
import { FakeDriver } from './helpers/driver.js';
import { testDb, type TestDb } from './helpers/db.js';

/**
 * The cron tokens (the cron spec, §7): a chat session's per actor build, usable
 * only while a turn is open where it was minted; a fire's while it runs; the
 * tier of each turn recorded by the router.
 */

let h: TestDb;
const KEY: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: '' };
const WORKER = { socket: '/home/run/kanban.sock', mtDir: '/home/bin', path: '/usr/bin' };
const NOW = 1_760_000_000_000;

beforeEach(() => {
  clearSecrets();
  h = testDb();
  createSession(h.db, { id: 's_chat', agentId: 'default', workspaceId: 'default', ownerPrincipal: 'on_alice' }, NOW);
  bindSession(h.db, KEY, 's_chat', NOW);
});
afterEach(() => {
  clearSecrets();
  h.close();
});

function turn(id: string, key: string): void {
  createTurn(h.db, { sessionId: 's_chat', turnId: id, generation: 0, idempotencyKey: key }, NOW);
}

describe("a chat session's token", () => {
  it('is minted for a Lark binding, with the socket and the shim first on PATH, and none for another channel', () => {
    const tokens = new CronTokens({ db: h.db, worker: WORKER });
    const env = tokens.envFor('s_chat', KEY);
    expect(env).toEqual({ MT_KANBAN_SOCKET: '/home/run/kanban.sock', PATH: '/home/bin:/usr/bin', MT_CRON_TOKEN: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(tokens.envFor('s_chat', { ...KEY, channel: 'kanban' })).toBeUndefined();
  });

  it('works during a turn, and not between turns, after /new, or once the actor is built again', () => {
    const tokens = new CronTokens({ db: h.db });
    const token = tokens.envFor('s_chat', KEY)?.['MT_CRON_TOKEN'] ?? '';
    expect(tokens.lookup(token)).toBeUndefined();
    turn('t_1', 'k1');
    expect(tokens.lookup(token)).toMatchObject({ kind: 'chat', sessionId: 's_chat', key: KEY });
    endTurn(h.db, 's_chat', 't_1', 'completed', NOW);
    expect(tokens.lookup(token)).toBeUndefined();
    turn('t_2', 'k2');
    revokeBindingsAt(h.db, KEY, NOW);
    expect(tokens.lookup(token)).toBeUndefined();
    bindSession(h.db, KEY, 's_chat', NOW);
    expect(tokens.lookup(token)).toBeDefined();
    const next = tokens.envFor('s_chat', KEY)?.['MT_CRON_TOKEN'] ?? '';
    expect(tokens.lookup(token)).toBeUndefined();
    expect(tokens.lookup(next)).toBeDefined();
    expect(tokens.lookup('not a token')).toBeUndefined();
  });

  it('is masked while held and not after; the 1,001st drops the oldest', () => {
    const tokens = new CronTokens({ db: h.db, max: 1000 });
    const first = tokens.envFor('s_0', KEY)?.['MT_CRON_TOKEN'] ?? '';
    expect(redactKnownSecrets(`t=${first}`)).toBe(`t=${MASK}`);
    for (let i = 1; i <= 1000; i += 1) tokens.envFor(`s_${i}`, KEY);
    expect(redactKnownSecrets(`t=${first}`)).toBe(`t=${first}`);
  });

  it("is judged by the running turn's tier: operate accepted, talk or none refused, a queued turn behind changing nothing", () => {
    const tokens = new CronTokens({ db: h.db });
    turn('t_1', 'k1');
    setTurnState(h.db, 's_chat', 't_1', 'running');
    expect(tokens.runningTurnOperate('s_chat')).toBe(false);
    tokens.turnSubmitted('s_chat', 'k1', true);
    turn('t_2', 'k2');
    tokens.turnSubmitted('s_chat', 'k2', false);
    expect(tokens.runningTurnOperate('s_chat')).toBe(true);
    endTurn(h.db, 's_chat', 't_1', 'completed', NOW);
    setTurnState(h.db, 's_chat', 't_2', 'running');
    expect(tokens.runningTurnOperate('s_chat')).toBe(false);
  });
});

describe("a fire's token", () => {
  it('names its fire and job until dropped', () => {
    const tokens = new CronTokens({ db: h.db });
    const token = tokens.mintFire(7, 'c_1');
    expect(tokens.lookup(token)).toEqual({ kind: 'fire', token, fireId: 7, jobId: 'c_1' });
    tokens.drop(token);
    expect(tokens.lookup(token)).toBeUndefined();
    expect(redactKnownSecrets(token)).toBe(token);
  });

  it('reaches the fire’s agent as MT_CRON_TOKEN with MT_CRON_FIRE, and leaves the masker when the fire ends', async () => {
    const tokens = new CronTokens({ db: h.db });
    const c: CronHarness = cronHarness({ t: h, deps: { tokens } });
    c.add();
    const held = holdsTurn(c.driver);
    c.clock.advance(3_600_000);
    await c.tick();
    const env = c.driver.starts[0]?.env ?? {};
    expect(env['MT_CRON_FIRE']).toBe('1');
    const token = env['MT_CRON_TOKEN'] ?? '';
    expect(tokens.lookup(token)).toMatchObject({ kind: 'fire', fireId: 1 });
    expect(redactKnownSecrets(token)).toBe(MASK);
    held.end('completed');
    await c.scheduler.idle();
    expect(tokens.lookup(token)).toBeUndefined();
    expect(redactKnownSecrets(token)).toBe(token);
    c.scheduler.stop();
  });
});

describe('the registry and the router', () => {
  it("give envFor the binding key, and tell CronTokens each turn's key and its sender's tier before it is submitted", async () => {
    const told: Array<[string, string, boolean]> = [];
    const keys: BindingKey[] = [];
    const lark = new FakeChannel({ id: 'lark' });
    const registry = new SessionRegistry({
      db: h.db,
      drivers: new Map([['default', new FakeDriver()]]),
      channels: new Map([['lark', lark]]),
      envFor: (_sessionId, key) => {
        keys.push(key);
        return undefined;
      },
      workspaces: new NamedWorkspaces(new Map([['default', '/tmp/ws-default']])),
      appId: 'cli_app',
    });
    const router = new Router({
      db: h.db,
      registry,
      authorizer: new Authorizer(defaultAuthConfig('ou_owner')),
      channel: lark,
      channelId: 'lark',
      appId: 'cli_app',
      cronTurns: { turnSubmitted: (sessionId, key, operate) => told.push([sessionId, key, operate]) },
    });
    const message: InboundMessage = {
      messageId: 'om_1',
      appId: 'cli_app',
      chatId: 'oc_dm',
      chatType: 'p2p',
      threadId: '',
      sender: { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' },
      senderIsBot: false,
      text: 'hello',
      mentionedBot: true,
      mentionAll: false,
      mentions: [],
      attachments: [],
      createTime: Date.now(),
    };
    await router.onMessage(message);
    expect(told).toEqual([[expect.stringMatching(/^s_/), turnIdempotencyKey('cli_app', 'om_1'), true]]);
    expect(keys).toEqual([{ channel: 'lark', appId: 'cli_app', conversationId: 'oc_dm', threadId: '' }]);
    await registry.closeAll();
  });
});
