import { describe, expect, it } from 'vitest';
import type { ListSources } from '../src/config.js';
import {
  actorOf,
  decideGrant,
  decideRevoke,
  grantReply,
  revokeReply,
  type Actor,
  type Held,
  type Sources,
  type Target,
  type Words,
} from '../src/policy/grants.js';
import type { Tier } from '../src/types.js';

/**
 * Who may grant and revoke what (the tier grants spec §5), as tables: every
 * actor against every kind of target, each outcome and its words, granting
 * and revoking yourself included.
 */

const NONE: Sources = { owner: false, talk: false, operate: false };
const GRANT = (tier: Tier): Held => ({ tier, by: 'lark:on_alice', at: Date.UTC(2026, 10, 18, 2) });

const TARGETS: Record<string, Target> = {
  owner: { sources: { owner: true, talk: true, operate: true }, grant: undefined },
  configTalk: { sources: { ...NONE, talk: true }, grant: undefined },
  configOperate: { sources: { ...NONE, talk: true, operate: true }, grant: undefined },
  operateOnly: { sources: { ...NONE, operate: true }, grant: undefined },
  talkGrant: { sources: NONE, grant: GRANT('talk') },
  operateGrant: { sources: NONE, grant: GRANT('operate') },
  none: { sources: NONE, grant: undefined },
};

const FROM: ListSources = { owner: 'auth.owner', talk: 'auth.talk', operate: 'auth.operate' };

function words(via: Words['via'] = 'chat', from: ListSources = FROM): Words {
  return { via, who: 'Carol', principal: 'lark:on_c', by: 'Bob', from, held: (g) => `${g.by === 'lark:on_alice' ? 'Alice' : g.by} on 2026-11-18` };
}

describe('actorOf', () => {
  it('is the owner, an operator by the configuration or by a grant, or talk', () => {
    expect(actorOf({ owner: true, talk: true, operate: true }, undefined)).toBe('owner');
    expect(actorOf({ ...NONE, talk: true, operate: true }, undefined)).toBe('operator');
    expect(actorOf(NONE, 'operate')).toBe('operator');
    expect(actorOf({ ...NONE, operate: true }, 'talk')).toBe('operator');
    expect(actorOf({ ...NONE, talk: true }, 'talk')).toBe('talk');
    expect(actorOf({ ...NONE, operate: true }, undefined)).toBe('talk');
  });
});

describe('decideGrant', () => {
  it('decides every actor and target, for talk and for operate', () => {
    const actors: Actor[] = ['owner', 'operator', 'terminal', 'talk'];
    const table: Record<string, Record<Tier, Record<Actor, string>>> = {
      owner: { talk: { owner: 'already owner', operator: 'already owner', terminal: 'already owner', talk: 'refused not_operator' }, operate: { owner: 'already owner', operator: 'already owner', terminal: 'already owner', talk: 'refused not_operator' } },
      configTalk: { talk: { owner: 'already config talk', operator: 'already config talk', terminal: 'already config talk', talk: 'refused not_operator' }, operate: { owner: 'granted operate', operator: 'refused operate_is_owners', terminal: 'granted operate', talk: 'refused not_operator' } },
      configOperate: { talk: { owner: 'already config operate', operator: 'already config operate', terminal: 'already config operate', talk: 'refused not_operator' }, operate: { owner: 'already config operate', operator: 'already config operate', terminal: 'already config operate', talk: 'refused not_operator' } },
      operateOnly: { talk: { owner: 'granted talk', operator: 'refused operate_listed', terminal: 'granted talk', talk: 'refused not_operator' }, operate: { owner: 'granted operate', operator: 'refused operate_is_owners', terminal: 'granted operate', talk: 'refused not_operator' } },
      talkGrant: { talk: { owner: 'already grant talk', operator: 'already grant talk', terminal: 'already grant talk', talk: 'refused not_operator' }, operate: { owner: 'replaced operate', operator: 'refused operate_is_owners', terminal: 'replaced operate', talk: 'refused not_operator' } },
      operateGrant: { talk: { owner: 'already grant operate', operator: 'already grant operate', terminal: 'already grant operate', talk: 'refused not_operator' }, operate: { owner: 'already grant operate', operator: 'already grant operate', terminal: 'already grant operate', talk: 'refused not_operator' } },
      none: { talk: { owner: 'granted talk', operator: 'granted talk', terminal: 'granted talk', talk: 'refused not_operator' }, operate: { owner: 'granted operate', operator: 'refused operate_is_owners', terminal: 'granted operate', talk: 'refused not_operator' } },
    };
    for (const [name, target] of Object.entries(TARGETS)) {
      for (const tier of ['talk', 'operate'] as const) {
        for (const actor of actors) {
          const d = decideGrant(actor, target, tier);
          const got =
            d.outcome === 'refused' ? `refused ${d.code}` : d.outcome === 'already' ? (d.from === 'owner' ? 'already owner' : `already ${d.from} ${d.tier}`) : `${d.outcome} ${d.tier}`;
          expect(got, `${actor} grants ${name} ${tier}`).toBe(table[name]?.[tier][actor]);
          expect(d.write, `${actor} grants ${name} ${tier}`).toBe(d.outcome === 'granted' ? 'insert' : d.outcome === 'replaced' ? 'replace' : 'none');
        }
      }
    }
  });

  it('lets nobody raise their own tier: an operator granting themselves talk has it already', () => {
    // An operator by configuration, and one by grant, granting themselves.
    expect(decideGrant('operator', TARGETS['configOperate'] as Target, 'talk')).toMatchObject({ outcome: 'already', tier: 'operate' });
    expect(decideGrant('operator', TARGETS['operateGrant'] as Target, 'operate')).toMatchObject({ outcome: 'already', tier: 'operate' });
  });
});

describe('decideRevoke', () => {
  it('decides every actor and target', () => {
    const table: Record<string, Record<Actor, string>> = {
      owner: { owner: 'refused is_owner', operator: 'refused is_owner', terminal: 'refused is_owner', talk: 'refused not_operator' },
      configTalk: { owner: 'refused from_config', operator: 'refused from_config', terminal: 'refused from_config', talk: 'refused not_operator' },
      configOperate: { owner: 'refused from_config', operator: 'refused from_config', terminal: 'refused from_config', talk: 'refused not_operator' },
      operateOnly: { owner: 'no_grant', operator: 'no_grant', terminal: 'no_grant', talk: 'refused not_operator' },
      talkGrant: { owner: 'revoked talk', operator: 'revoked talk', terminal: 'revoked talk', talk: 'refused not_operator' },
      operateGrant: { owner: 'revoked operate', operator: 'refused operate_grant_is_owners', terminal: 'revoked operate', talk: 'refused not_operator' },
      none: { owner: 'no_grant', operator: 'no_grant', terminal: 'no_grant', talk: 'refused not_operator' },
    };
    for (const [name, target] of Object.entries(TARGETS)) {
      for (const actor of ['owner', 'operator', 'terminal', 'talk'] as const) {
        const d = decideRevoke(actor, target);
        const got = d.outcome === 'refused' ? `refused ${d.code}` : d.outcome === 'revoked' ? `revoked ${d.grant}` : d.outcome;
        expect(got, `${actor} revokes ${name}`).toBe(table[name]?.[actor]);
        expect(d.write).toBe(d.outcome === 'revoked' ? 'end' : 'none');
      }
    }
  });

  it("keeps what the configuration gives, ends an owner's leftover grant, and leaves an operator by configuration's talk grant to the owner", () => {
    expect(decideRevoke('operator', { sources: { ...NONE, talk: true }, grant: GRANT('talk') })).toEqual({ write: 'end', outcome: 'revoked', grant: 'talk', left: 'talk', owner: false });
    expect(decideRevoke('owner', { sources: { ...NONE, talk: true, operate: true }, grant: GRANT('operate') })).toMatchObject({ left: 'operate' });
    expect(decideRevoke('operator', { sources: { owner: true, talk: true, operate: true }, grant: GRANT('talk') })).toEqual({ write: 'end', outcome: 'revoked', grant: 'talk', left: 'operate', owner: true });
    // In auth.operate, talk by grant: revoking it unmakes an operator, the owner's to do, the operator's own included.
    const operateListed: Target = { sources: { ...NONE, operate: true }, grant: GRANT('talk') };
    expect(decideRevoke('operator', operateListed)).toMatchObject({ outcome: 'refused', code: 'operate_listed' });
    expect(decideRevoke('owner', operateListed)).toEqual({ write: 'end', outcome: 'revoked', grant: 'talk', left: null, owner: false });
    expect(decideRevoke('terminal', operateListed)).toMatchObject({ outcome: 'revoked' });
  });
});

describe('the words', () => {
  const grantSays = (actor: Actor, target: string, tier: Tier, w = words()): string => {
    const t = TARGETS[target] as Target;
    return grantReply(decideGrant(actor, t, tier), t, w);
  };
  const revokeSays = (actor: Actor, target: Target, w = words(), made = 0): string => revokeReply(decideRevoke(actor, target), target, w, made);

  it('say each grant outcome, in chat and at the terminal', () => {
    expect(grantSays('owner', 'none', 'talk')).toBe('Carol now has talk tier, granted by Bob. `/auth revoke lark:on_c` takes it back.');
    expect(grantSays('terminal', 'none', 'operate', words('terminal'))).toBe('Carol now has operate tier, granted by Bob; mt auth revoke lark:on_c takes it back');
    expect(grantSays('owner', 'talkGrant', 'operate')).toBe('Carol now has operate tier, in place of talk, granted by Bob. `/auth revoke lark:on_c` takes it back.');
    expect(grantSays('operator', 'owner', 'talk')).toBe('Carol is the owner, who has both tiers always.');
    expect(grantSays('operator', 'configTalk', 'talk')).toBe('Carol already has talk tier, from auth.talk in config.yaml.');
    expect(grantSays('operator', 'configTalk', 'talk', words('chat', { ...FROM, talk: 'MT_ALLOW_TALK' }))).toBe('Carol already has talk tier, from MT_ALLOW_TALK.');
    expect(grantSays('operator', 'talkGrant', 'talk')).toBe('Carol already has talk tier, by a grant from Alice on 2026-11-18.');
    expect(grantSays('owner', 'operateGrant', 'talk')).toBe(
      'Carol already has operate tier, by a grant from Alice on 2026-11-18, which includes talk. To leave them talk alone, the owner revokes and grants talk again.',
    );
    expect(grantSays('owner', 'configOperate', 'talk')).toBe('Carol already has operate tier, from auth.operate in config.yaml, which includes talk.');
    expect(grantSays('owner', 'operateGrant', 'operate')).toBe('Carol already has operate tier, by a grant from Alice on 2026-11-18.');
    // In auth.operate alone, an operator by their talk grant: both sources named, and the way to talk alone is the configuration's.
    const listedWithTalk: Target = { sources: { ...NONE, operate: true }, grant: GRANT('talk') };
    expect(grantReply(decideGrant('owner', listedWithTalk, 'talk'), listedWithTalk, words())).toBe(
      'Carol already has operate tier, from auth.operate in config.yaml with a talk grant from Alice on 2026-11-18, which includes talk. To leave them talk alone, the operator takes them out of auth.operate and restarts the gateway.',
    );
    expect(grantReply(decideGrant('terminal', listedWithTalk, 'operate'), listedWithTalk, words('terminal', { ...FROM, operate: 'MT_ALLOW_OPERATE' }))).toBe(
      'Carol already has operate tier, from MT_ALLOW_OPERATE with a talk grant from Alice on 2026-11-18',
    );
    expect(grantSays('talk', 'none', 'talk')).toBe('`/auth grant` needs operator permission: an operator grants talk tier, and the owner operate.');
    expect(grantSays('operator', 'none', 'operate')).toBe('Only the owner grants operate tier: an operator cannot make another operator.');
    expect(grantSays('operator', 'operateOnly', 'talk', words('chat', { ...FROM, operate: 'MT_ALLOW_OPERATE' }))).toBe(
      "Carol is in MT_ALLOW_OPERATE, so talk tier would make them an operator, which is the owner's to grant.",
    );
  });

  it('say each revoke outcome, with what is left and the grants a revoked operator made', () => {
    expect(revokeSays('operator', TARGETS['talkGrant'] as Target)).toBe('Carol no longer has talk tier: revoked by Bob.');
    expect(revokeSays('operator', { sources: { ...NONE, talk: true }, grant: GRANT('talk') })).toBe(
      'Carol no longer has talk tier: revoked by Bob; they keep talk tier from auth.talk in config.yaml.',
    );
    expect(revokeSays('owner', TARGETS['operateGrant'] as Target, words(), 2)).toBe(
      'Carol no longer has operate tier: revoked by Bob. They made 2 talk grants still in force; `/auth list` shows them.',
    );
    expect(revokeSays('terminal', TARGETS['operateGrant'] as Target, words('terminal'), 1)).toBe(
      'Carol no longer has operate tier: revoked by Bob; they made 1 talk grant still in force; mt auth list shows them',
    );
    expect(revokeSays('owner', TARGETS['operateGrant'] as Target, words(), 0)).toBe('Carol no longer has operate tier: revoked by Bob.');
    // An operate grant to a person both lists make an operator: their tier is the configuration's, and stays.
    const listedOperator: Target = { sources: { ...NONE, talk: true, operate: true }, grant: GRANT('operate') };
    expect(revokeSays('owner', listedOperator)).toBe("Carol's operate grant is revoked by Bob; their tier is unchanged, operate from auth.operate in config.yaml.");
    expect(revokeSays('terminal', listedOperator, words('terminal', { ...FROM, operate: 'MT_ALLOW_OPERATE' }), 1)).toBe(
      "Carol's operate grant is revoked by Bob; their tier is unchanged, operate from MT_ALLOW_OPERATE; they made 1 talk grant still in force; mt auth list shows them",
    );
    // The talk grant that made a person in auth.operate alone an operator: they lose both.
    const listedWithTalk: Target = { sources: { ...NONE, operate: true }, grant: GRANT('talk') };
    expect(revokeSays('owner', listedWithTalk)).toBe('Carol no longer has talk tier, and so no longer operates: revoked by Bob.');
    expect(revokeSays('terminal', listedWithTalk, words('terminal'))).toBe('Carol no longer has talk tier, and so no longer operates: revoked by Bob');
    expect(revokeSays('owner', { sources: { owner: true, talk: true, operate: true }, grant: GRANT('talk') })).toBe(
      "Carol's talk grant is revoked; they keep both tiers as the owner.",
    );
    expect(revokeSays('owner', TARGETS['none'] as Target)).toBe('Carol has no grant to revoke.');
    expect(revokeSays('talk', TARGETS['talkGrant'] as Target)).toBe('`/auth revoke` needs operator permission.');
    expect(revokeSays('owner', TARGETS['owner'] as Target, words('chat', { ...FROM, owner: 'MT_OWNER_OPEN_ID' }))).toBe(
      'Carol is the owner, from MT_OWNER_OPEN_ID, and cannot be revoked.',
    );
    expect(revokeSays('owner', TARGETS['configTalk'] as Target)).toBe(
      'Carol has talk tier from auth.talk in config.yaml, which chat cannot change: the operator edits it and restarts the gateway.',
    );
    expect(revokeSays('terminal', TARGETS['configOperate'] as Target, words('terminal'))).toBe(
      'Carol has operate tier from auth.operate in config.yaml, which mt auth cannot change: the operator edits it and restarts the gateway',
    );
    expect(revokeSays('operator', TARGETS['operateGrant'] as Target)).toBe('Carol has operate tier by a grant, which only the owner revokes.');
    expect(revokeSays('operator', { sources: { ...NONE, operate: true }, grant: GRANT('talk') })).toBe(
      'Carol is in auth.operate: their talk grant is what makes them an operator, so only the owner revokes it.',
    );
  });
});
