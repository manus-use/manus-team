import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ListSources } from '../src/config.js';
import { activeGrant, grantTier } from '../src/db/grants.js';
import { personOf } from '../src/db/people.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { AUTH_LIST_MAX, AuthChat } from '../src/policy/auth-chat.js';
import { Authorizer, defaultAuthConfig, tiersOf } from '../src/policy/auth.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import type { InboundMention, InboundMessage, Principal } from '../src/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';

/**
 * `/auth` in chat (the tier grants spec §6.1, §8.1): its parse, the mention
 * it resolves as `/kanban` does, who may do what, every reply's words, the
 * people it notes, the log's ids, masking, and `/auth list` with its cut.
 */

const NOW = Date.UTC(2026, 10, 18, 2, 0);
const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Alice' };
const BOB: Principal = { openId: 'ou_bob', unionId: 'on_bob', displayName: 'Bob' };
const TESS: Principal = { openId: 'ou_tess', unionId: 'on_tess', displayName: 'Tess' };
const DAN: Principal = { openId: 'ou_dan', unionId: 'on_dan', displayName: 'Dan' };

const mention = (n: number, name: string, id: string): InboundMention => ({ key: `@_user_${n}`, name, openId: `ou_${id}`, unionId: `on_${id}` });
const AT_CAROL = mention(1, 'Carol Wu', 'carol');
const AT_DAN = mention(2, 'Dan', 'dan');
const AT_OLGA = mention(3, 'Olga', 'olga');
const AT_TESS = mention(4, 'Tess', 'tess');
const AT_ERIN = mention(5, 'Erin', 'erin');
const AT_OWNER = mention(6, 'Alice', 'owner');

const LISTS = {
  allowTalk: ['ou_owner', 'ou_tess', 'ou_bob', 'ou_ghost'],
  allowOperate: ['ou_owner', 'ou_bob', 'ou_olga'],
};
const FROM: ListSources = { owner: 'auth.owner', talk: 'auth.talk', operate: 'auth.operate' };

let t: TestDb;
let authorizer: Authorizer;
let people: PeopleDirectory;
let notes: string[];
let seq = 0;

function chat(from: ListSources = FROM): AuthChat {
  return new AuthChat({
    db: t.db,
    appId: 'cli_app',
    authorizer,
    auth: { ownerOpenId: 'ou_owner', ...LISTS, from },
    people,
    zone: 'Asia/Shanghai',
    clock: new ManualClock(NOW),
    note: (line) => notes.push(line),
  });
}

beforeEach(() => {
  clearSecrets();
  t = testDb();
  notes = [];
  authorizer = new Authorizer({ ...defaultAuthConfig('ou_owner'), ...LISTS }, { grants: { tierOf: (u) => activeGrant(t.db, 'cli_app', u)?.tier } });
  people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: (p) => tiersOf(LISTS, p.openId, authorizer.grantOf(p.unionId)).talk });
});
afterEach(() => {
  clearSecrets();
  t.close();
});

function message(sender: Principal, mentions: InboundMention[], chatType: 'group' | 'p2p'): InboundMessage {
  return {
    messageId: `om_${++seq}`,
    appId: 'cli_app',
    chatId: 'oc_team',
    chatType,
    threadId: '',
    sender,
    senderIsBot: false,
    text: '/auth',
    mentionedBot: true,
    mentionAll: false,
    mentions,
    attachments: [],
    createTime: NOW,
  };
}

function say(arg: string, sender: Principal = OWNER, mentions: InboundMention[] = [], chatType: 'group' | 'p2p' = 'group', from?: ListSources): string {
  return chat(from).run(arg, message(sender, mentions, chatType));
}

const HELP = [
  '`/auth list`: everyone with a tier, and where it comes from.',
  "`/auth grant @Name talk` or `/auth grant @Name operate`: give a tier beside the configuration's lists. An operator grants talk; only the owner grants operate.",
  '`/auth revoke @Name` or `/auth revoke lark:<union_id>`: end a grant. The configuration and the owner are never changed from chat.',
].join('\n');

describe('/auth grant', () => {
  it('grants by @-mention, a name with spaces and the tier last in any case; notes the sender and the mention; logs ids only', () => {
    expect(say('grant @Carol Wu TALK', OWNER, [AT_CAROL])).toBe('Carol Wu now has talk tier, granted by Alice. `/auth revoke lark:on_carol` takes it back.');
    expect(activeGrant(t.db, 'cli_app', 'on_carol')).toMatchObject({ tier: 'talk', openId: 'ou_carol', grantedBy: 'lark:on_owner', grantedVia: 'chat', grantedChat: 'oc_team', grantedAt: NOW });
    expect(personOf(t.db, 'cli_app', 'on_carol')?.name).toBe('Carol Wu');
    expect(personOf(t.db, 'cli_app', 'on_owner')?.name).toBe('Alice');
    expect(notes).toEqual(['auth: talk granted to lark:on_carol by lark:on_owner in chat oc_team']);
    // At once, with no restart.
    expect(authorizer.canTalk({ openId: 'ou_carol', unionId: 'on_carol', displayName: null })).toBe(true);
    expect(people.canTalk('lark:on_carol')).toBe(true);
  });

  it('puts operate in place of a talk grant, and says a tier already held, from where', () => {
    say('grant @Carol Wu talk', OWNER, [AT_CAROL]);
    expect(say('grant @Carol Wu talk', BOB, [AT_CAROL])).toBe('Carol Wu already has talk tier, by a grant from Alice on 2026-11-18.');
    expect(say('grant @Carol Wu operate', OWNER, [AT_CAROL])).toBe(
      'Carol Wu now has operate tier, in place of talk, granted by Alice. `/auth revoke lark:on_carol` takes it back.',
    );
    expect(notes.at(-1)).toBe('auth: operate granted to lark:on_carol by lark:on_owner in chat oc_team (replacing talk)');
    expect(say('grant @Tess talk', BOB, [AT_TESS])).toBe('Tess already has talk tier, from auth.talk in config.yaml.');
    expect(say('grant @Tess talk', BOB, [AT_TESS], 'group', { ...FROM, talk: 'MT_ALLOW_TALK' })).toBe('Tess already has talk tier, from MT_ALLOW_TALK.');
    expect(say('grant @Alice talk', BOB, [AT_OWNER])).toBe('Alice is the owner, who has both tiers always.');
  });

  it("holds each tier's rule: talk tier grants nothing, an operator talk only, and not to a person in auth.operate alone", () => {
    expect(say('grant @Carol Wu talk', TESS, [AT_CAROL])).toBe('`/auth grant` needs operator permission: an operator grants talk tier, and the owner operate.');
    expect(say('grant @Carol Wu operate', BOB, [AT_CAROL])).toBe('Only the owner grants operate tier: an operator cannot make another operator.');
    expect(say('grant @Olga talk', BOB, [AT_OLGA])).toBe("Olga is in auth.operate, so talk tier would make them an operator, which is the owner's to grant.");
    expect(activeGrant(t.db, 'cli_app', 'on_carol')).toBeUndefined();
    expect(say('grant @Olga talk', OWNER, [AT_OLGA])).toMatch(/^Olga now has talk tier/);
    expect(authorizer.canOperate({ openId: 'ou_olga', unionId: 'on_olga', displayName: null })).toBe(true);
    // An operator by grant grants talk.
    say('grant @Dan operate', OWNER, [AT_DAN]);
    expect(say('grant @Carol Wu talk', DAN, [AT_CAROL])).toBe('Carol Wu now has talk tier, granted by Dan. `/auth revoke lark:on_carol` takes it back.');
  });

  it('takes a mention only: a typed principal, a bare word and a missing or unknown tier are refused', () => {
    expect(say('grant lark:on_carol talk')).toBe(
      'A grant takes an @-mention, so it is made with the ids Lark sends: type @ and pick them. `lark:<union_id>` is for `/auth revoke`.',
    );
    expect(say('grant Carol talk')).toBe(HELP);
    for (const arg of ['grant @Carol Wu', 'grant @Carol Wu admin', 'grant', 'grant talk']) {
      expect(say(arg, OWNER, [AT_CAROL]), arg).toBe('`/auth grant` takes the person, then the tier: `/auth grant @Name talk` or `/auth grant @Name operate`.');
    }
    expect(activeGrant(t.db, 'cli_app', 'on_carol')).toBeUndefined();
  });

  it("refuses a mention as /kanban does, a bot's included, and in a direct message points at a group or the terminal", () => {
    expect(say('grant @Dan talk', OWNER, [AT_CAROL])).toBe('@Dan is not someone this message mentions: type @ and pick them, so Lark says who they are.');
    expect(say('grant @Dan talk', OWNER, [AT_CAROL], 'p2p')).toBe(
      '@Dan is not someone this message mentions: type @ and pick them, so Lark says who they are. In a direct message, grant in a group they are in, or with `mt auth grant` at the terminal.',
    );
    expect(say('grant @Carol Wu talk', OWNER, [{ ...AT_CAROL, unionId: null }])).toBe(
      'Lark did not say who @Carol Wu is (no union_id came with the mention). Ask the operator to check the app can read user ids.',
    );
    expect(say('grant @Carol Wu talk', OWNER, [AT_CAROL, { ...AT_CAROL, key: '@_user_9', unionId: 'on_other' }])).toMatch(/^More than one person mentioned is called @Carol Wu/);
    expect(say('grant @Helper talk', OWNER, [{ key: '@_user_7', name: 'Helper', openId: 'ou_helper', unionId: null, isBot: true }])).toBe(
      "@Helper is a bot, and a bot's tier is configuration's.",
    );
    // Mentioned in a direct message, as Lark lets one be: granted.
    expect(say('grant @Carol Wu talk', OWNER, [AT_CAROL], 'p2p')).toMatch(/^Carol Wu now has talk tier/);
  });

  it('refuses a sender Lark gave no union_id, as the grant records who made it', () => {
    expect(say('grant @Carol Wu talk', { ...OWNER, unionId: null }, [AT_CAROL])).toBe(
      'Lark did not say who you are (no union_id came with the message), and a grant records who made or ended it. Ask the operator to check the app can read user ids.',
    );
    expect(activeGrant(t.db, 'cli_app', 'on_carol')).toBeUndefined();
  });

  it('masks a name holding a known secret', () => {
    addSecrets(['sk-live-1234567890']);
    const reply = say('grant @Carol sk-live-1234567890 talk', OWNER, [{ ...AT_CAROL, name: 'Carol sk-live-1234567890' }]);
    expect(reply).toBe(`Carol ${MASK} now has talk tier, granted by Alice. \`/auth revoke lark:on_carol\` takes it back.`);
  });
});

describe('/auth revoke', () => {
  it('ends a grant by mention or by principal, says what is left, and logs it', () => {
    say('grant @Carol Wu talk', OWNER, [AT_CAROL]);
    expect(say('revoke @Carol Wu', BOB, [AT_CAROL])).toBe('Carol Wu no longer has talk tier: revoked by Bob.');
    expect(notes.at(-1)).toBe('auth: talk grant of lark:on_carol revoked by lark:on_bob in chat oc_team');
    expect(say('revoke lark:on_carol', BOB)).toBe('Carol Wu has no grant to revoke.');
    expect(say('revoke lark:on_never', BOB)).toBe('lark:on\\_never has no grant to revoke.');
    say('grant @Tess operate', OWNER, [AT_TESS]);
    expect(say('revoke @Tess', OWNER, [AT_TESS])).toBe('Tess no longer has operate tier: revoked by Alice; they keep talk tier from auth.talk in config.yaml.');
    expect(authorizer.canTalk({ openId: 'ou_carol', unionId: 'on_carol', displayName: null })).toBe(false);
  });

  it('counts the talk grants a revoked operator made that are still in force', () => {
    say('grant @Dan operate', OWNER, [AT_DAN]);
    say('grant @Carol Wu talk', DAN, [AT_CAROL]);
    say('grant @Erin talk', DAN, [AT_ERIN]);
    expect(say('revoke @Dan', OWNER, [AT_DAN])).toBe('Dan no longer has operate tier: revoked by Alice. They made 2 talk grants still in force; `/auth list` shows them.');
    expect(activeGrant(t.db, 'cli_app', 'on_carol')?.tier).toBe('talk');
  });

  it("refuses the owner, a configuration's tier, and an operator's revoke of what is the owner's; ends an owner's leftover grant", () => {
    expect(say('revoke @Alice', BOB, [AT_OWNER])).toBe('Alice is the owner, from auth.owner in config.yaml, and cannot be revoked.');
    expect(say('revoke @Tess', OWNER, [AT_TESS])).toBe(
      'Tess has talk tier from auth.talk in config.yaml, which chat cannot change: the operator edits it and restarts the gateway.',
    );
    say('grant @Dan operate', OWNER, [AT_DAN]);
    expect(say('revoke @Dan', BOB, [AT_DAN])).toBe('Dan has operate tier by a grant, which only the owner revokes.');
    say('grant @Olga talk', OWNER, [AT_OLGA]);
    expect(say('revoke @Olga', BOB, [AT_OLGA])).toBe('Olga is in auth.operate: their talk grant is what makes them an operator, so only the owner revokes it.');
    expect(say('revoke @Carol Wu', TESS, [AT_CAROL])).toBe('`/auth revoke` needs operator permission.');
    // By principal, for a person people has no row for: their sources are found by the grant's own open_id.
    grantTier(t.db, { appId: 'cli_app', unionId: 'on_olga2', openId: 'ou_olga', tier: 'talk', by: 'lark:on_owner', via: 'chat', chat: 'oc_team' }, () => ({ write: 'insert' as const }), 1);
    expect(personOf(t.db, 'cli_app', 'on_olga2')).toBeUndefined();
    expect(say('revoke lark:on_olga2', BOB)).toBe(
      'lark:on\\_olga2 is in auth.operate: their talk grant is what makes them an operator, so only the owner revokes it.',
    );
    expect(activeGrant(t.db, 'cli_app', 'on_olga2')?.tier).toBe('talk');
    // A grant from before they were the owner.
    grantTier(t.db, { appId: 'cli_app', unionId: 'on_owner', openId: 'ou_owner', tier: 'talk', by: 'operator:x', via: 'terminal', chat: null }, () => ({ write: 'insert' as const }), 1);
    expect(say('revoke lark:on_owner', OWNER)).toBe("Alice's talk grant is revoked; they keep both tiers as the owner.");
  });

  it('takes a person and nothing else', () => {
    expect(say('revoke')).toBe('`/auth revoke` takes the person: `/auth revoke @Name`, or `/auth revoke lark:<union_id>` for someone who can no longer be mentioned.');
    expect(say('revoke Carol')).toBe(HELP);
    expect(say('revoke lark:on carol')).toBe('lark:on carol is not a person: a person is `lark:<union_id>`, which `/auth list` shows.');
  });
});

describe('/auth list and help', () => {
  it('lists the owner first, then operators, then talk, each by name, and auth.operate without talk last', () => {
    for (const p of [BOB, TESS]) people.saw({ openId: p.openId, unionId: p.unionId, name: p.displayName });
    say('grant @Carol Wu talk', OWNER, [AT_CAROL]);
    say('grant @Dan operate', OWNER, [AT_DAN, AT_OLGA]);
    expect(say('list', TESS).split('\n')).toEqual([
      'Owner: Alice (lark:on\\_owner), from auth.owner in config.yaml',
      'Bob (lark:on\\_bob): operate, from auth.operate in config.yaml',
      'Dan (lark:on\\_dan): operate, granted by Alice on 2026-11-18',
      'Carol Wu (lark:on\\_carol): talk, granted by Alice on 2026-11-18',
      'ou\\_ghost: talk, from auth.talk in config.yaml; not seen by this bot yet',
      'Tess (lark:on\\_tess): talk, from auth.talk in config.yaml',
      'Olga (lark:on\\_olga): in auth.operate without talk tier, so no tier',
    ]);
  });

  it('says a mix of sources, and cuts the list at 50 lines', () => {
    say('grant @Tess operate', OWNER, [AT_TESS]);
    expect(say('list').split('\n')).toContain('Tess (lark:on\\_tess): operate, granted by Alice on 2026-11-18; talk also from auth.talk in config.yaml');
    for (let i = 0; i < 60; i += 1) {
      grantTier(t.db, { appId: 'cli_app', unionId: `on_p${i}`, openId: `ou_p${i}`, tier: 'talk', by: 'lark:on_owner', via: 'chat', chat: 'oc_team' }, () => ({ write: 'insert' as const }), NOW);
    }
    const lines = say('list').split('\n');
    expect(lines).toHaveLength(AUTH_LIST_MAX + 1);
    expect(lines.at(-1)).toBe('and 15 more: `mt auth list` at the terminal lists everyone');
  });

  it('answers help, nothing and an unknown word with the usage', () => {
    for (const arg of ['help', '', 'frobnicate', 'list everyone']) expect(say(arg), arg).toBe(HELP);
  });
});
