import { beforeEach, describe, expect, it } from 'vitest';
import { ChannelError } from '../src/channel/types.js';
import { MEMBERS_FAILED_MS, MEMBERS_MS, Membership, NO_MEMBERS_SCOPE } from '../src/kanban/members.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock } from './helpers/db.js';

/**
 * Who is a member of a group (spec §19.3): Lark's chat members API, asked once
 * for a group and trusted five minutes, a failure remembered one minute, a
 * missing permission said once, and a lookup bounded in time.
 */

let clock: ManualClock;
let lark: FakeChannel;
let notes: string[];

beforeEach(() => {
  clock = new ManualClock();
  lark = new FakeChannel({ id: 'lark', clock });
  lark.members.set('oc_team', ['on_alice', 'on_bob']);
  lark.members.set('oc_other', ['on_carol']);
  notes = [];
});

function membership(timeoutMs = 30_000): Membership {
  return new Membership({ channel: lark, appId: 'cli_app', clock, timeoutMs, note: (line) => notes.push(line) });
}

describe('Membership', () => {
  it('asks Lark once for a group, and answers every person in it from that for five minutes', async () => {
    const m = membership();
    expect(await m.isMember('oc_team', 'on_alice')).toBe(true);
    expect(await m.isMember('oc_team', 'on_carol')).toBe(false);
    expect(await m.isMember('oc_other', 'on_carol')).toBe(true);
    expect(lark.memberLookups).toEqual(['oc_team', 'oc_other']);
    clock.advance(MEMBERS_MS - 1);
    lark.members.set('oc_team', ['on_alice', 'on_bob', 'on_carol']);
    expect(await m.isMember('oc_team', 'on_carol')).toBe(false);
    // Added to the group: their cards come there within five minutes.
    clock.advance(1);
    expect(await m.isMember('oc_team', 'on_carol')).toBe(true);
    expect(lark.memberLookups).toEqual(['oc_team', 'oc_other', 'oc_team']);
  });

  it('takes a person not among the members it could read of a large group as no member', async () => {
    lark.incomplete.add('oc_team');
    const m = membership();
    expect(await m.isMember('oc_team', 'on_alice')).toBe(true);
    expect(await m.isMember('oc_team', 'on_dan')).toBe(false);
  });

  it('remembers a failed lookup for one minute, and says once per boot that the app lacks the permission', async () => {
    const m = membership();
    lark.failNext('chatMembers', new ChannelError(99991672, 'Access denied', false));
    expect(await m.isMember('oc_team', 'on_alice')).toBe(false);
    clock.advance(MEMBERS_FAILED_MS - 1);
    expect(await m.isMember('oc_team', 'on_alice')).toBe(false);
    expect(lark.memberLookups).toEqual(['oc_team']);
    clock.advance(1);
    lark.failNext('chatMembers', new ChannelError(99991672, 'Access denied', false));
    expect(await m.isMember('oc_team', 'on_alice')).toBe(false);
    expect(lark.memberLookups).toEqual(['oc_team', 'oc_team']);
    expect(notes).toEqual([NO_MEMBERS_SCOPE]);
    // Any other failure is said with its reason, by ids only.
    lark.failNext('chatMembers', new ChannelError(500, 'internal error', true));
    expect(await m.isMember('oc_other', 'on_carol')).toBe(false);
    expect(notes.at(-1)).toBe('kanban: the members of chat oc_other could not be read (internal error (code 500)); its cards go by direct message for a minute');
    clock.advance(MEMBERS_FAILED_MS);
    expect(await m.isMember('oc_team', 'on_alice')).toBe(true);
  });

  it('takes a lookup that outlasts its time for a failed one', async () => {
    const m = membership(20);
    lark.hold();
    expect(await m.isMember('oc_team', 'on_alice')).toBe(false);
    expect(notes).toEqual(['kanban: the members of chat oc_team could not be read (the lookup took longer than 20 ms); its cards go by direct message for a minute']);
    lark.release();
    expect(await m.isMember('oc_team', 'on_alice')).toBe(false);
    expect(lark.memberLookups).toEqual(['oc_team']);
  });
});
