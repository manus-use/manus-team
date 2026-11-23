import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { grantTier, tierReader } from '../src/db/grants.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { Authorizer, defaultAuthConfig, tiersOf, type AuthConfig } from '../src/policy/auth.js';
import type { Tier } from '../src/types.js';
import { testDb, type TestDb } from './helpers/db.js';

/**
 * What the waker asks of the policy (wake spec §2.1, §5.3, §13): whether the
 * gateway acts in a conversation at all, and whether the person who set a wake
 * has operate tier, judged as the authorizer judges it.
 */

const auth = (over: Partial<AuthConfig> = {}): Authorizer => new Authorizer({ ...defaultAuthConfig('ou_owner'), ...over });

describe('Authorizer.admitsConversation', () => {
  it('admits any chat when auth.chats is empty, and only the listed ones when it is not', () => {
    expect(auth().admitsConversation('oc_any', 'group')).toBeUndefined();
    expect(auth({ allowChats: ['oc_team'] }).admitsConversation('oc_team', 'group')).toBeUndefined();
    expect(auth({ allowChats: ['oc_team'] }).admitsConversation('oc_other', 'group')).toBe('chat_not_allowed');
  });

  it('refuses a direct message while direct messages are off, and admits one while they are on', () => {
    expect(auth().admitsConversation('oc_dm', 'p2p')).toBeUndefined();
    expect(auth({ allowDirectMessages: false }).admitsConversation('oc_dm', 'p2p')).toBe('dm_disabled');
    expect(auth({ allowDirectMessages: false }).admitsConversation('oc_team', 'group')).toBeUndefined();
  });

  it('judges a chat of no known kind by auth.chats alone', () => {
    expect(auth({ allowDirectMessages: false }).admitsConversation('oc_dm', null)).toBeUndefined();
    expect(auth({ allowChats: ['oc_team'] }).admitsConversation('oc_dm', null)).toBe('chat_not_allowed');
  });

  it('is asked first: a chat outside the list is refused before the direct-message check', () => {
    expect(auth({ allowChats: ['oc_team'], allowDirectMessages: false }).admitsConversation('oc_dm', 'p2p')).toBe('chat_not_allowed');
  });
});

describe('PeopleDirectory.canOperate', () => {
  let h: TestDb;
  let people: PeopleDirectory;
  const CONFIG = { ...defaultAuthConfig('ou_owner'), allowTalk: ['ou_owner', 'ou_talker', 'ou_operator'], allowOperate: ['ou_owner', 'ou_operator', 'ou_listless'] };
  const ACTOR = { by: 'operator:alice', via: 'terminal' as const, chat: null };

  beforeEach(() => {
    h = testDb();
    const authorizer = new Authorizer(CONFIG, { grants: { tierOf: tierReader(h.db, 'cli_app') } });
    people = new PeopleDirectory({
      db: h.db,
      appId: 'cli_app',
      canTalk: (person) => tiersOf(CONFIG, person.openId, authorizer.grantOf(person.unionId)).talk,
      canOperate: (person) => tiersOf(CONFIG, person.openId, authorizer.grantOf(person.unionId)).operate,
    });
    for (const who of ['talker', 'operator', 'listless', 'granted']) people.saw({ openId: `ou_${who}`, unionId: `on_${who}`, name: who });
  });
  afterEach(() => h.close());

  function grant(unionId: string, tier: Tier): void {
    grantTier(h.db, { appId: 'cli_app', unionId, openId: `ou_${unionId.slice(3)}`, tier, ...ACTOR }, () => ({ write: 'insert' as const }), 1);
  }

  it('is true for a person in the operate list, and false for one only in the talk list', () => {
    expect(people.canOperate('lark:on_operator')).toBe(true);
    expect(people.canOperate('lark:on_talker')).toBe(false);
  });

  it('counts a grant of operate, seen or not, and not a grant of talk', () => {
    grant('on_granted', 'talk');
    expect(people.canOperate('lark:on_granted')).toBe(false);
    grant('on_unseen', 'operate');
    expect(people.canOperate('lark:on_unseen')).toBe(true);
  });

  it('is false for an operate entry without talk, a person nobody granted and nobody saw, and a principal that is no person', () => {
    expect(people.canOperate('lark:on_listless')).toBe(false);
    expect(people.canOperate('lark:on_stranger')).toBe(false);
    expect(people.canOperate('operator:alice')).toBe(false);
  });

  it('is false for everyone when the gateway gives no operate check', () => {
    const plain = new PeopleDirectory({ db: h.db, appId: 'cli_app', canTalk: () => true });
    expect(plain.canOperate('lark:on_operator')).toBe(false);
  });
});
