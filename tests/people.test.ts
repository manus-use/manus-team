import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notePerson, personOf } from '../src/db/people.js';
import { PeopleDirectory, unionIdOf } from '../src/kanban/people.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';

/**
 * The people the gateway has seen (migration 005): the board knows a person by
 * union_id, the tiers by open_id, and a person named only by principal is checked
 * through the open_id last seen with it (spec §4.2).
 */

let t: TestDb;
let clock: ManualClock;
let people: PeopleDirectory;
const TALK = new Set(['ou_alice']);

beforeEach(() => {
  t = testDb();
  clock = new ManualClock();
  people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: ({ openId }) => openId !== null && TALK.has(openId), clock });
});
afterEach(() => t.close());

describe('notePerson', () => {
  it('keeps the last ids and name Lark gave, and a known name when it gave none', () => {
    notePerson(t.db, { appId: 'cli_app', unionId: 'on_alice', openId: 'ou_alice', name: 'Alice' }, 1);
    notePerson(t.db, { appId: 'cli_app', unionId: 'on_alice', openId: 'ou_alice2', name: null }, 2);
    expect(personOf(t.db, 'cli_app', 'on_alice')).toEqual({
      appId: 'cli_app',
      unionId: 'on_alice',
      openId: 'ou_alice2',
      name: 'Alice',
      seenAt: 2,
    });
    notePerson(t.db, { appId: 'cli_app', unionId: 'on_alice', openId: 'ou_alice2', name: 'Alice Smith' }, 3);
    expect(personOf(t.db, 'cli_app', 'on_alice')?.name).toBe('Alice Smith');
    // Per bot: another app's open_ids are another app's.
    expect(personOf(t.db, 'cli_other', 'on_alice')).toBeUndefined();
  });
});

describe('PeopleDirectory', () => {
  it('gives a person their principal once Lark gave both ids, and checks their tier by open_id', () => {
    expect(people.canTalk('lark:on_alice')).toBe(false);
    expect(people.saw({ openId: 'ou_alice', unionId: 'on_alice', name: 'Alice' })).toBe('lark:on_alice');
    expect(people.canTalk('lark:on_alice')).toBe(true);
    expect(people.nameOf('lark:on_alice')).toBe('Alice');
    expect(people.saw({ openId: 'ou_bob', unionId: 'on_bob', name: null })).toBe('lark:on_bob');
    expect(people.canTalk('lark:on_bob')).toBe(false);
    expect(people.nameOf('lark:on_bob')).toBeUndefined();
  });

  it('notes nobody who came without both ids, and knows no role or stranger', () => {
    expect(people.saw({ openId: 'ou_carol', unionId: null, name: 'Carol' })).toBeUndefined();
    expect(people.saw({ openId: null, unionId: 'on_carol', name: 'Carol' })).toBeUndefined();
    expect(people.canTalk('lark:on_carol')).toBe(false);
    expect(people.canTalk('implementer')).toBe(false);
    expect(people.canTalk('lark:')).toBe(false);
    expect(unionIdOf('lark:on_x')).toBe('on_x');
    expect(unionIdOf('implementer')).toBeUndefined();
  });

  it("asks about a person by union_id, with the open_id people holds or none, so a grant is found without a row (tier grants spec §4.3)", () => {
    const asked: Array<{ openId: string | null; unionId: string }> = [];
    const granted = new PeopleDirectory({
      db: t.db,
      appId: 'cli_app',
      canTalk: (person) => {
        asked.push(person);
        return person.unionId === 'on_granted';
      },
    });
    people.saw({ openId: 'ou_alice', unionId: 'on_alice', name: 'Alice' });
    expect(granted.canTalk('lark:on_granted')).toBe(true);
    expect(granted.canTalk('lark:on_alice')).toBe(false);
    expect(granted.canTalk('implementer')).toBe(false);
    expect(asked).toEqual([
      { openId: null, unionId: 'on_granted' },
      { openId: 'ou_alice', unionId: 'on_alice' },
    ]);
  });
});

describe('PeopleDirectory.chatName', () => {
  afterEach(() => clearSecrets());

  it("gives a person's name, nothing for a principal it has no name for or one that is not a person's", () => {
    notePerson(t.db, { appId: 'cli_app', unionId: 'on_alice', openId: 'ou_alice', name: 'Alice Smith' }, 1);
    notePerson(t.db, { appId: 'cli_app', unionId: 'on_quiet', openId: 'ou_quiet', name: null }, 1);
    expect(people.chatName('lark:on_alice')).toBe('Alice Smith');
    expect(people.chatName('lark:on_quiet')).toBeUndefined();
    expect(people.chatName('lark:on_nobody')).toBeUndefined();
    expect(people.chatName('operator:alice')).toBeUndefined();
  });

  it('tells apart two people of one name across the people table, by the start of the union_id, and only this bot', () => {
    notePerson(t.db, { appId: 'cli_app', unionId: 'on_8ba330a6567863a9d92c2268d2197f1e', openId: 'ou_h1', name: 'Hemanth' }, 1);
    expect(people.chatName('lark:on_8ba330a6567863a9d92c2268d2197f1e')).toBe('Hemanth');
    // Another bot's people are another bot's: no clash.
    notePerson(t.db, { appId: 'cli_other', unionId: 'on_ffff0000', openId: 'ou_x', name: 'Hemanth' }, 1);
    expect(people.chatName('lark:on_8ba330a6567863a9d92c2268d2197f1e')).toBe('Hemanth');
    notePerson(t.db, { appId: 'cli_app', unionId: 'on_c0ffee12', openId: 'ou_h2', name: 'Hemanth' }, 2);
    expect(people.chatName('lark:on_8ba330a6567863a9d92c2268d2197f1e')).toBe('Hemanth (on_8ba3…)');
    expect(people.chatName('lark:on_c0ffee12')).toBe('Hemanth (on_c0ff…)');
    // The agent's prompts keep the plain name.
    expect(people.nameOf('lark:on_c0ffee12')).toBe('Hemanth');
    // A start another of the name shares is made longer, and the whole id is shown where nothing shorter differs.
    notePerson(t.db, { appId: 'cli_app', unionId: 'on_c0ffee1234', openId: 'ou_h3', name: 'Hemanth' }, 3);
    expect(people.chatName('lark:on_c0ffee12')).toBe('Hemanth (on_c0ffee12)');
    expect(people.chatName('lark:on_c0ffee1234')).toBe('Hemanth (on_c0ffee123…)');
    expect(people.chatName('lark:on_8ba330a6567863a9d92c2268d2197f1e')).toBe('Hemanth (on_8ba3…)');
  });

  it('cuts a shared long name so its tag shows, masked before the cut', () => {
    const secret = 'sk-name-1234567890abcdef';
    addSecrets([secret]);
    const long = `${'x'.repeat(50)} ${secret}`;
    notePerson(t.db, { appId: 'cli_app', unionId: 'on_aaaa1111', openId: 'ou_a', name: long }, 1);
    notePerson(t.db, { appId: 'cli_app', unionId: 'on_bbbb2222', openId: 'ou_b', name: long }, 1);
    const shown = people.chatName('lark:on_aaaa1111') ?? '';
    expect(shown.endsWith(' (on_aaaa…)')).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(60 + ' (on_aaaa…)'.length);
    expect(shown).not.toContain('sk-name');
  });
});
