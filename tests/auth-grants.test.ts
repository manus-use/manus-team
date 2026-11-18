import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { grantTier, revokeGrant, tierReader } from '../src/db/grants.js';
import { openDb } from '../src/db/open.js';
import { Authorizer, defaultAuthConfig, sourcesOf, type GrantReader } from '../src/policy/auth.js';
import type { InboundMessage, Principal, Tier } from '../src/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';

/**
 * The Authorizer with grants (the tier grants spec §4.1, §5.1): a grant read at
 * each check, by the principal's union_id, beside the configuration's lists;
 * none without a union_id or a reader; a failed read none, said once a minute;
 * and the owner and the sources a grant's decision is fed.
 */

const OWNER = 'ou_owner';
const CONFIG = { ...defaultAuthConfig(OWNER), allowTalk: [OWNER, 'ou_talk'], allowOperate: [OWNER, 'ou_op_only'] };

function person(openId: string, unionId: string | null = `on_${openId.slice(3)}`): Principal {
  return { openId, unionId, displayName: null };
}

function reader(grants: Record<string, Tier>, asked: string[] = []): GrantReader {
  return {
    tierOf: (unionId) => {
      asked.push(unionId);
      return grants[unionId];
    },
  };
}

function message(sender: Principal): InboundMessage {
  return {
    messageId: 'om_1',
    appId: 'cli_app',
    chatId: 'oc_chat',
    chatType: 'p2p',
    threadId: '',
    sender,
    senderIsBot: false,
    text: 'hello',
    mentionedBot: false,
    mentionAll: false,
    attachments: [],
    createTime: 1,
  };
}

let h: TestDb | undefined;
afterEach(() => {
  h?.close();
  h = undefined;
});

describe('Authorizer with grants', () => {
  it('gives talk and operate by a grant, found by union_id, and operate by a talk grant to a person in auth.operate', () => {
    const a = new Authorizer(CONFIG, { grants: reader({ on_carol: 'talk', on_dan: 'operate', on_op_only: 'talk' }) });
    expect([a.canTalk(person('ou_carol')), a.canOperate(person('ou_carol'))]).toEqual([true, false]);
    expect([a.canTalk(person('ou_dan')), a.canOperate(person('ou_dan'))]).toEqual([true, true]);
    expect([a.canTalk(person('ou_op_only')), a.canOperate(person('ou_op_only'))]).toEqual([true, true]);
    expect([a.canTalk(person('ou_erin')), a.canOperate(person('ou_erin'))]).toEqual([false, false]);
    expect(a.hasTier(person('ou_dan'), 'operate')).toBe(true);
    expect(a.admits(message(person('ou_carol')))).toEqual({ ok: true });
    expect(a.admitsTier(person('ou_carol'), 'operate')).toMatchObject({ ok: false, reason: 'insufficient_tier' });
  });

  it('never asks the reader about a principal with no union_id, and counts no grant for one', () => {
    const asked: string[] = [];
    const a = new Authorizer(CONFIG, { grants: reader({ on_carol: 'operate' }, asked) });
    expect(a.canTalk(person('ou_carol', null))).toBe(false);
    expect(a.canOperate(person('ou_carol', ''))).toBe(false);
    expect(a.canTalk(person('ou_talk', null))).toBe(true);
    expect(asked).toEqual([]);
  });

  it('counts a read that throws as no grant, the configuration still holding, and says so once a minute', () => {
    const clock = new ManualClock(1_000);
    const notes: string[] = [];
    const a = new Authorizer(CONFIG, {
      grants: {
        tierOf: () => {
          throw new Error('database disk image is malformed');
        },
      },
      note: (line) => notes.push(line),
      clock,
    });
    expect(a.canTalk(person('ou_carol'))).toBe(false);
    expect(a.canOperate(person(OWNER))).toBe(true);
    clock.advance(59_999);
    expect(a.canTalk(person('ou_talk'))).toBe(true);
    expect(notes).toEqual(['auth: reading the tier grants failed, so none count until a read succeeds: database disk image is malformed']);
    clock.advance(1);
    a.canTalk(person('ou_carol'));
    expect(notes).toHaveLength(2);
  });

  it('is as before with no reader', () => {
    const a = new Authorizer(CONFIG);
    expect([a.canTalk(person('ou_carol')), a.canTalk(person('ou_talk')), a.canOperate(person('ou_op_only')), a.canOperate(person(OWNER))]).toEqual([false, true, false, true]);
    expect(a.grantOf('on_carol')).toBeUndefined();
  });

  it('says who the owner is, and where an open_id is in the configuration', () => {
    const a = new Authorizer(CONFIG);
    expect(a.isOwner(person(OWNER))).toBe(true);
    expect(a.isOwner(person('ou_talk'))).toBe(false);
    expect(a.sourcesOf(OWNER)).toEqual({ owner: true, talk: true, operate: true });
    expect(a.sourcesOf('ou_talk')).toEqual({ owner: false, talk: true, operate: false });
    expect(a.sourcesOf('ou_op_only')).toEqual({ owner: false, talk: false, operate: true });
    expect(a.sourcesOf(null)).toEqual({ owner: false, talk: false, operate: false });
    expect(sourcesOf({ ownerOpenId: OWNER, allowTalk: [], allowOperate: [] }, OWNER)).toEqual({ owner: true, talk: false, operate: false });
  });

  it('reads the database at each check, so a grant and a revoke from another connection count at once', () => {
    h = testDb();
    const a = new Authorizer(CONFIG, { grants: { tierOf: tierReader(h.db, 'cli_app') } });
    expect(a.canTalk(person('ou_carol'))).toBe(false);
    const other = openDb(join(h.dir, 'team.db'));
    try {
      const actor = { by: 'operator:alice', via: 'terminal' as const, chat: null };
      grantTier(other, { appId: 'cli_app', unionId: 'on_carol', openId: 'ou_carol', tier: 'talk', ...actor }, () => ({ write: 'insert' as const }), 1);
      expect(a.canTalk(person('ou_carol'))).toBe(true);
      // Another bot's grant counts for nothing here.
      grantTier(other, { appId: 'cli_old', unionId: 'on_dan', openId: 'ou_dan', tier: 'operate', ...actor }, () => ({ write: 'insert' as const }), 1);
      expect(a.canTalk(person('ou_dan'))).toBe(false);
      revokeGrant(other, { appId: 'cli_app', unionId: 'on_carol', ...actor }, () => ({ write: 'end' as const }), 2);
      expect(a.canTalk(person('ou_carol'))).toBe(false);
    } finally {
      other.close();
    }
  });
});
