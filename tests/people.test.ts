import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notePerson, personOf } from '../src/db/people.js';
import { PeopleDirectory, unionIdOf } from '../src/kanban/people.js';
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
  people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: (openId) => TALK.has(openId), clock });
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
});
