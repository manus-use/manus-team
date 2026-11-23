import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noticeBatchUuid, wakeBatchUuid } from '../src/core/ids.js';
import { notePerson, personByOpenId } from '../src/db/people.js';
import { createSession } from '../src/db/sessions.js';
import { createTurn, turnByKey } from '../src/db/turns.js';
import { testDb, type TestDb } from './helpers/db.js';
import { NOW } from './helpers/kanban.js';

/**
 * Three small reads the waker and the terminal need (wake spec §13): a batch's
 * uuid, a turn by its key, and a person by their open_id.
 */

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

describe('wakeBatchUuid', () => {
  it("is the batch's pairs', in any order, and the bot's: never the notices' uuid for the same pairs", () => {
    const one = wakeBatchUuid('cli_app', [
      [1, 10],
      [2, 11],
    ]);
    expect(one).toMatch(/^[0-9a-f]{50}$/);
    expect(
      wakeBatchUuid('cli_app', [
        [2, 11],
        [1, 10],
        [1, 10],
      ]),
    ).toBe(one);
    expect(wakeBatchUuid('cli_other', [[1, 10], [2, 11]])).not.toBe(one);
    expect(wakeBatchUuid('cli_app', [[1, 10]])).not.toBe(one);
    expect(noticeBatchUuid('cli_app', [[1, 10], [2, 11]])).not.toBe(one);
  });
});

describe('turnByKey', () => {
  it("finds a session's turn by its idempotency key, and no other session's", () => {
    createSession(h.db, { id: 's_1', agentId: 'default', workspaceId: 'default', ownerPrincipal: 'lark:on_alice' }, NOW);
    createSession(h.db, { id: 's_2', agentId: 'default', workspaceId: 'default', ownerPrincipal: 'lark:on_alice' }, NOW);
    createTurn(h.db, { sessionId: 's_1', turnId: 't_1', generation: 0, idempotencyKey: 'key-1' }, NOW);
    expect(turnByKey(h.db, 's_1', 'key-1')).toMatchObject({ sessionId: 's_1', turnId: 't_1', idempotencyKey: 'key-1', state: 'pending' });
    expect(turnByKey(h.db, 's_1', 'key-2')).toBeUndefined();
    expect(turnByKey(h.db, 's_2', 'key-1')).toBeUndefined();
  });
});

describe('personByOpenId', () => {
  it("finds the person this bot saw with an open_id, by this bot's app id only", () => {
    notePerson(h.db, { appId: 'cli_app', unionId: 'on_owner', openId: 'ou_owner', name: 'Zhixi Sun' }, NOW);
    notePerson(h.db, { appId: 'cli_other', unionId: 'on_else', openId: 'ou_else', name: 'Kevin Tu' }, NOW);
    expect(personByOpenId(h.db, 'cli_app', 'ou_owner')).toEqual({
      appId: 'cli_app',
      unionId: 'on_owner',
      openId: 'ou_owner',
      name: 'Zhixi Sun',
      seenAt: NOW,
    });
    expect(personByOpenId(h.db, 'cli_app', 'ou_else')).toBeUndefined();
    expect(personByOpenId(h.db, 'cli_app', 'ou_nobody')).toBeUndefined();
  });
});
