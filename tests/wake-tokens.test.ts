import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindSession, revokeBindingsAt } from '../src/db/bindings.js';
import { createSession } from '../src/db/sessions.js';
import { createTurn, endTurn } from '../src/db/turns.js';
import { WakeTokens } from '../src/kanban/wake-tokens.js';
import { MASK, clearSecrets, redactKnownSecrets } from '../src/secrets.js';
import type { BindingKey } from '../src/types.js';
import { role } from './helpers/dispatch.js';
import { testDb, type TestDb } from './helpers/db.js';

/**
 * The wake tokens (wake spec §9.2): a Lark chat session's, minted at each actor
 * build whether cron is on or off, that works only while it is the session's
 * newest, the session is still bound where it was minted, and a turn is open.
 * One that once worked and no longer does is stale, not unknown.
 */

let h: TestDb;
const KEY: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_1' };
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

function tokenOf(tokens: WakeTokens): string {
  return tokens.envFor('s_chat', KEY)?.['MT_WAKE_TOKEN'] ?? '';
}

describe("a chat session's wake token", () => {
  it('is minted for a Lark binding, with the socket and the shim first on PATH, and none for another channel', () => {
    const tokens = new WakeTokens({ db: h.db, worker: WORKER });
    expect(tokens.envFor('s_chat', KEY)).toEqual({
      MT_KANBAN_SOCKET: '/home/run/kanban.sock',
      PATH: '/home/bin:/usr/bin',
      MT_WAKE_TOKEN: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(tokens.envFor('s_chat', { ...KEY, channel: 'kanban' })).toBeUndefined();
    expect(tokens.envFor('s_chat', { ...KEY, channel: 'cron' })).toBeUndefined();
  });

  it("puts the shim before the session's role's own PATH, if its agent.env sets one", () => {
    createSession(h.db, { id: 's_ops', agentId: 'ops', workspaceId: 'default', ownerPrincipal: 'on_alice' }, NOW);
    const ops = role('ops');
    const roles = new Map([['ops', { ...ops, agent: { ...ops.agent, env: { PATH: '/opt/ops/bin' } } }]]);
    const tokens = new WakeTokens({ db: h.db, worker: WORKER, roles });
    expect(tokens.envFor('s_ops', KEY)?.['PATH']).toBe('/home/bin:/opt/ops/bin');
    expect(tokens.envFor('s_chat', KEY)?.['PATH']).toBe('/home/bin:/usr/bin');
  });

  it('works during a turn, and is stale between turns, after /new, and once the actor is built again', () => {
    const tokens = new WakeTokens({ db: h.db });
    const token = tokenOf(tokens);
    expect(tokens.lookup(token)).toEqual({ stale: true });
    turn('t_1', 'k1');
    expect(tokens.lookup(token)).toEqual({ works: { sessionId: 's_chat', key: KEY } });
    endTurn(h.db, 's_chat', 't_1', 'completed', NOW);
    expect(tokens.lookup(token)).toEqual({ stale: true });
    turn('t_2', 'k2');
    revokeBindingsAt(h.db, KEY, NOW);
    expect(tokens.lookup(token)).toEqual({ stale: true });
    bindSession(h.db, KEY, 's_chat', NOW);
    expect(tokens.lookup(token)).toEqual({ works: { sessionId: 's_chat', key: KEY } });
    const next = tokenOf(tokens);
    expect(tokens.lookup(token)).toEqual({ stale: true });
    expect(tokens.lookup(next)).toEqual({ works: { sessionId: 's_chat', key: KEY } });
  });

  it('answers nothing for a token it never held, one of another form, or one a restart forgot', () => {
    const tokens = new WakeTokens({ db: h.db });
    turn('t_1', 'k1');
    const token = tokenOf(tokens);
    expect(tokens.lookup('not a token')).toBeUndefined();
    expect(tokens.lookup('A'.repeat(43))).toBeUndefined();
    // A gateway's restart: a new WakeTokens, which never held it.
    expect(new WakeTokens({ db: h.db }).lookup(token)).toBeUndefined();
  });

  it('is masked while held and not once expired, and one past the cap drops the oldest held, which stays stale', () => {
    const tokens = new WakeTokens({ db: h.db, max: 2 });
    const first = tokenOf(tokens);
    expect(redactKnownSecrets(`t=${first}`)).toBe(`t=${MASK}`);
    const second = tokenOf(tokens);
    expect(redactKnownSecrets(`t=${first}`)).toBe(`t=${first}`);
    expect(redactKnownSecrets(`t=${second}`)).toBe(`t=${MASK}`);
    for (const id of ['s_b', 's_c']) {
      createSession(h.db, { id, agentId: 'default', workspaceId: 'default', ownerPrincipal: 'on_alice' }, NOW);
    }
    const b = tokens.envFor('s_b', KEY)?.['MT_WAKE_TOKEN'] ?? '';
    tokens.envFor('s_c', KEY);
    // Three held for a cap of two: s_chat's, the oldest, is dropped, and stale.
    expect(tokens.lookup(second)).toEqual({ stale: true });
    expect(redactKnownSecrets(second)).toBe(second);
    expect(redactKnownSecrets(b)).toBe(MASK);
  });

  it("names its own session, never another's, though both have a turn open", () => {
    const tokens = new WakeTokens({ db: h.db });
    const other: BindingKey = { ...KEY, threadId: 'omt_2' };
    createSession(h.db, { id: 's_b', agentId: 'default', workspaceId: 'default', ownerPrincipal: 'on_alice' }, NOW);
    bindSession(h.db, other, 's_b', NOW);
    const a = tokenOf(tokens);
    const b = tokens.envFor('s_b', other)?.['MT_WAKE_TOKEN'] ?? '';
    turn('t_a', 'ka');
    createTurn(h.db, { sessionId: 's_b', turnId: 't_b', generation: 0, idempotencyKey: 'kb' }, NOW);
    expect(tokens.lookup(a)).toEqual({ works: { sessionId: 's_chat', key: KEY } });
    expect(tokens.lookup(b)).toEqual({ works: { sessionId: 's_b', key: other } });
  });

  it('is stale, said once, when two of its conditions fail at once', () => {
    const tokens = new WakeTokens({ db: h.db });
    const token = tokenOf(tokens);
    // No turn open, and the binding moved: one answer.
    revokeBindingsAt(h.db, KEY, NOW);
    expect(tokens.lookup(token)).toEqual({ stale: true });
  });

  it("works while its turn is open, whatever the turn's wake row says: the gateway, not the token, reads the wake", () => {
    const tokens = new WakeTokens({ db: h.db });
    const token = tokenOf(tokens);
    // A turn whose wake's settling write has not landed yet is still an open turn.
    turn('t_1', 'wake-key');
    expect(tokens.lookup(token)).toEqual({ works: { sessionId: 's_chat', key: KEY } });
  });

  it('keeps at most as many expired hashes beyond those held, forgetting the oldest first', () => {
    const tokens = new WakeTokens({ db: h.db, max: 2 });
    const expired = [tokenOf(tokens), tokenOf(tokens), tokenOf(tokens)];
    tokenOf(tokens);
    // Three expired, two remembered: the first is forgotten.
    expect(tokens.lookup(expired[0] ?? '')).toBeUndefined();
    expect(tokens.lookup(expired[1] ?? '')).toEqual({ stale: true });
    expect(tokens.lookup(expired[2] ?? '')).toEqual({ stale: true });
  });
});
