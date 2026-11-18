import { sourceText, type ListSources } from '../config.js';
import type { GrantRow, NamedGrant } from '../db/grants.js';
import type { PersonRow } from '../db/people.js';
import type { Tier } from '../types.js';
import { sourcesOf, tiersFrom } from './auth.js';

/**
 * Who may grant and revoke what (the tier grants spec §5): one pure decision
 * for a grant and one for a revoke, and the words for each outcome, which chat
 * and the terminal both give. `db/grants.ts` runs a decision inside its
 * transaction, on the grants read there, so chat and the terminal cannot judge
 * a case differently, nor on a stale read.
 *
 * The owner grants and revokes anything a grant can hold; an operator, by the
 * configuration or by a grant, talk only, so every operator is one the owner
 * or the configuration made; the terminal as the owner; talk tier nothing.
 * Nothing removes a configuration entry or the owner: a grant only adds.
 */

/** Who asks: the owner, an operator, a person at talk tier alone, or the operator's terminal. */
export type Actor = 'owner' | 'operator' | 'talk' | 'terminal';

/** Whether an open_id is the owner, and whether it is in each of the configuration's lists. */
export interface Sources {
  owner: boolean;
  talk: boolean;
  operate: boolean;
}

/** A person's active grant, as a decision and its words need it. */
export interface Held {
  tier: Tier;
  /** Who made it: `lark:<union_id>` or `operator:<login>`. */
  by: string;
  at: number;
}

/** The person a grant or revoke is for: their configuration's sources, and their active grant, if any. */
export interface Target {
  sources: Sources;
  grant: Held | undefined;
}

/** A sender in chat as an actor: the owner, else an operator by the configuration or a grant, else talk. */
export function actorOf(sources: Sources, grant: Tier | undefined): Actor {
  if (sources.owner) return 'owner';
  return tiersFrom(sources, grant).operate ? 'operator' : 'talk';
}

/** Why a grant was refused. */
export type GrantRefusal = 'not_operator' | 'operate_is_owners' | 'operate_listed';

/** Why a revoke was refused. */
export type RevokeRefusal = 'not_operator' | 'is_owner' | 'from_config' | 'operate_grant_is_owners' | 'operate_listed';

/** Where a tier a person already has comes from: the owner, the configuration, or their grant. */
export type HeldFrom = 'owner' | 'config' | 'grant';

export type GrantDecision =
  | { write: 'insert'; outcome: 'granted'; tier: Tier }
  | { write: 'replace'; outcome: 'replaced'; tier: 'operate' }
  | { write: 'none'; outcome: 'already'; tier: Tier; from: HeldFrom; asked: Tier }
  | { write: 'none'; outcome: 'refused'; code: GrantRefusal };

export type RevokeDecision =
  | { write: 'end'; outcome: 'revoked'; grant: Tier; left: Tier | null; owner: boolean }
  | { write: 'none'; outcome: 'no_grant' }
  | { write: 'none'; outcome: 'refused'; code: RevokeRefusal };

/** The tier a person has, or null for none. */
function tierOf(t: { talk: boolean; operate: boolean }): Tier | null {
  return t.operate ? 'operate' : t.talk ? 'talk' : null;
}

/** Where an operate tier comes from: the configuration when both its lists give it, else the grant. */
function operateFrom(target: Target): HeldFrom {
  return target.grant?.tier === 'operate' && !(target.sources.talk && target.sources.operate) ? 'grant' : 'config';
}

/**
 * Grant `tier` (§5.2), the first case that applies deciding: talk tier alone
 * may grant nothing; the owner already has both; a tier already held is a
 * no-op, talk to an operator included, as operate includes talk; operate is
 * the owner's and the terminal's, in place of a talk grant when there is one;
 * an operator's talk to a person in `auth.operate` alone, which would make
 * them an operator, is refused.
 */
export function decideGrant(actor: Actor, target: Target, tier: Tier): GrantDecision {
  if (actor === 'talk') return { write: 'none', outcome: 'refused', code: 'not_operator' };
  if (target.sources.owner) return { write: 'none', outcome: 'already', tier: 'operate', from: 'owner', asked: tier };
  const now = tiersFrom(target.sources, target.grant?.tier);
  if (now.operate) return { write: 'none', outcome: 'already', tier: 'operate', from: operateFrom(target), asked: tier };
  if (tier === 'talk' && now.talk) {
    return { write: 'none', outcome: 'already', tier: 'talk', from: target.sources.talk ? 'config' : 'grant', asked: tier };
  }
  if (tier === 'operate') {
    if (actor === 'operator') return { write: 'none', outcome: 'refused', code: 'operate_is_owners' };
    return target.grant?.tier === 'talk' ? { write: 'replace', outcome: 'replaced', tier: 'operate' } : { write: 'insert', outcome: 'granted', tier: 'operate' };
  }
  if (actor === 'operator' && target.sources.operate) return { write: 'none', outcome: 'refused', code: 'operate_listed' };
  return { write: 'insert', outcome: 'granted', tier: 'talk' };
}

/**
 * Revoke a person's grant (§5.2), which ends the whole grant: talk tier alone
 * may revoke nothing; the owner cannot be revoked, but a grant left over from
 * before they were the owner ends; with no grant, a configuration's tier is
 * refused and none is a no-op; an operate grant is the owner's to revoke, and
 * so is the talk grant that makes a person in `auth.operate` an operator.
 */
export function decideRevoke(actor: Actor, target: Target): RevokeDecision {
  if (actor === 'talk') return { write: 'none', outcome: 'refused', code: 'not_operator' };
  const grant = target.grant;
  if (grant === undefined) {
    if (target.sources.owner) return { write: 'none', outcome: 'refused', code: 'is_owner' };
    if (tiersFrom(target.sources, undefined).talk) return { write: 'none', outcome: 'refused', code: 'from_config' };
    return { write: 'none', outcome: 'no_grant' };
  }
  if (target.sources.owner) return { write: 'end', outcome: 'revoked', grant: grant.tier, left: 'operate', owner: true };
  if (actor === 'operator' && grant.tier === 'operate') return { write: 'none', outcome: 'refused', code: 'operate_grant_is_owners' };
  if (actor === 'operator' && target.sources.operate && !target.sources.talk) return { write: 'none', outcome: 'refused', code: 'operate_listed' };
  return { write: 'end', outcome: 'revoked', grant: grant.tier, left: tierOf(tiersFrom(target.sources, undefined)), owner: false };
}

/** What a reply needs beside the decision: where it is said, and the names, already made safe to show there. */
export interface Words {
  via: 'chat' | 'terminal';
  /** The person: their name, or their principal. */
  who: string;
  /** Their principal, `lark:<union_id>`, for the command that undoes a grant. */
  principal: string;
  /** Who acted. */
  by: string;
  /** Where the configuration's lists came from. */
  from: ListSources;
  /** A grant's maker and day, as `Alice on 2026-11-18`. */
  held: (grant: Held) => string;
}

/** Clauses as a reply: sentences in chat, one line joined with `; ` at the terminal. */
function say(via: Words['via'], clauses: readonly string[]): string {
  if (via === 'chat') return clauses.map((c) => `${c}.`).join(' ');
  return clauses.map((c, i) => (i === 0 ? c : `${c.charAt(0).toLowerCase()}${c.slice(1)}`)).join('; ');
}

/** A command, as a reply names it: in a code span in chat. */
function command(via: Words['via'], text: string): string {
  return via === 'chat' ? `\`/auth ${text}\`` : `mt auth ${text}`;
}

/** Whether a person is an operator by `auth.operate` and their talk grant together: in the operate list alone, with a talk grant. */
function listedWithTalkGrant(target: Target): boolean {
  return target.sources.operate && !target.sources.talk && target.grant?.tier === 'talk';
}

/** Where the tier a person has comes from, as a no-op says it: both sources for operate by `auth.operate` and a talk grant. */
function heldText(d: { tier: Tier; from: HeldFrom }, target: Target, w: Words): string {
  if (d.from === 'grant' && target.grant !== undefined) return `by a grant from ${w.held(target.grant)}`;
  if (d.tier === 'operate' && target.grant !== undefined && listedWithTalkGrant(target)) {
    return `${sourceText(w.from.operate)} with a talk grant from ${w.held(target.grant)}`;
  }
  return sourceText(d.tier === 'operate' ? w.from.operate : w.from.talk);
}

/** A grant's outcome, in the words §5.2 and §6.1 give it. */
export function grantReply(d: GrantDecision, target: Target, w: Words): string {
  switch (d.outcome) {
    case 'granted':
      return say(w.via, [`${w.who} now has ${d.tier} tier, granted by ${w.by}`, `${command(w.via, `revoke ${w.principal}`)} takes it back`]);
    case 'replaced':
      return say(w.via, [`${w.who} now has operate tier, in place of talk, granted by ${w.by}`, `${command(w.via, `revoke ${w.principal}`)} takes it back`]);
    case 'already': {
      if (d.from === 'owner') return say(w.via, [`${w.who} is the owner, who has both tiers always`]);
      const has = `${w.who} already has ${d.tier} tier, ${heldText(d, target, w)}`;
      if (d.asked === 'talk' && d.tier === 'operate') {
        // Talk alone is a grant's to give, unless auth.operate makes any talk an operator's: then it is the configuration's.
        const alone =
          d.from === 'grant'
            ? ['To leave them talk alone, the owner revokes and grants talk again']
            : listedWithTalkGrant(target)
              ? [`To leave them talk alone, the operator takes them out of ${w.from.operate} and restarts the gateway`]
              : [];
        return say(w.via, [`${has}, which includes talk`, ...alone]);
      }
      return say(w.via, [has]);
    }
    case 'refused':
      switch (d.code) {
        case 'not_operator':
          return say(w.via, [`${command(w.via, 'grant')} needs operator permission: an operator grants talk tier, and the owner operate`]);
        case 'operate_is_owners':
          return say(w.via, ['Only the owner grants operate tier: an operator cannot make another operator']);
        case 'operate_listed':
          return say(w.via, [`${w.who} is in ${w.from.operate}, so talk tier would make them an operator, which is the owner's to grant`]);
      }
  }
}

/** A revoke's outcome, in the words §5.2 and §6.1 give it; `made`, for a revoked operate grant, the talk grants its holder made that are still in force. */
export function revokeReply(d: RevokeDecision, target: Target, w: Words, made = 0): string {
  switch (d.outcome) {
    case 'revoked': {
      if (d.owner) return say(w.via, [`${w.who}'s ${d.grant} grant is revoked; they keep both tiers as the owner`]);
      const still =
        d.grant === 'operate' && made > 0
          ? [`They made ${made} talk grant${made === 1 ? '' : 's'} still in force; ${command(w.via, 'list')} shows them`]
          : [];
      // An operate grant to a person both lists make an operator: the grant ends, and their tier is the configuration's still.
      if (d.grant === 'operate' && d.left === 'operate') {
        return say(w.via, [`${w.who}'s operate grant is revoked by ${w.by}; their tier is unchanged, operate ${sourceText(w.from.operate)}`, ...still]);
      }
      // The talk grant that made a person in auth.operate alone an operator: with it goes their operate tier.
      const operated = d.grant === 'talk' && d.left === null && target.sources.operate ? ', and so no longer operates' : '';
      const left = d.left === null ? '' : `; they keep ${d.left} tier ${sourceText(d.left === 'operate' ? w.from.operate : w.from.talk)}`;
      return say(w.via, [`${w.who} no longer has ${d.grant} tier${operated}: revoked by ${w.by}${left}`, ...still]);
    }
    case 'no_grant':
      return say(w.via, [`${w.who} has no grant to revoke`]);
    case 'refused':
      switch (d.code) {
        case 'not_operator':
          return say(w.via, [`${command(w.via, 'revoke')} needs operator permission`]);
        case 'is_owner':
          return say(w.via, [`${w.who} is the owner, ${sourceText(w.from.owner)}, and cannot be revoked`]);
        case 'from_config': {
          const operate = target.sources.operate && target.sources.talk;
          const tier = operate ? `operate tier ${sourceText(w.from.operate)}` : `talk tier ${sourceText(w.from.talk)}`;
          const who = w.via === 'chat' ? 'chat' : 'mt auth';
          return say(w.via, [`${w.who} has ${tier}, which ${who} cannot change: the operator edits it and restarts the gateway`]);
        }
        case 'operate_grant_is_owners':
          return say(w.via, [`${w.who} has operate tier by a grant, which only the owner revokes`]);
        case 'operate_listed':
          return say(w.via, [`${w.who} is in ${w.from.operate}: their talk grant is what makes them an operator, so only the owner revokes it`]);
      }
  }
}

/** Someone with a tier, or in `auth.operate` without one, as the lists show them (tier grants spec §8). */
export interface TierEntry {
  /** Null for a configuration entry `people` does not hold. */
  unionId: string | null;
  /** The open_id `people` holds, or the configuration's entry's; null for a grant to a person `people` does not hold. */
  openId: string | null;
  name: string | null;
  sources: Sources;
  grant: GrantRow | undefined;
  tier: Tier | null;
}

/** The configuration's owner and lists, by open_id, as the gateway or this shell reads them. */
export interface ConfigLists {
  owner: string;
  talk: readonly string[];
  operate: readonly string[];
}

/** The order the lists give: the owner first, then operators, then talk, then those with no tier, each by name. */
function rank(e: TierEntry): number {
  if (e.sources.owner) return 0;
  return e.tier === 'operate' ? 1 : e.tier === 'talk' ? 2 : 3;
}

/**
 * Everyone with a tier, from the configuration's lists and this bot's active
 * grants: a configuration entry named by the person `people` holds with its
 * open_id, a grant by its union_id, one entry a person. A person in
 * `auth.operate` without talk, the case a grant to them guards, is listed
 * with no tier. Sorted as the lists give them.
 */
export function tierEntries(lists: ConfigLists, grants: readonly NamedGrant[], people: readonly PersonRow[]): TierEntry[] {
  const byOpenId = new Map(people.map((p) => [p.openId, p]));
  const byUnionId = new Map(people.map((p) => [p.unionId, p]));
  const config = { ownerOpenId: lists.owner, allowTalk: lists.talk, allowOperate: lists.operate };
  const entries = new Map<string, Omit<TierEntry, 'sources' | 'tier'>>();
  for (const g of grants) {
    const p = byUnionId.get(g.unionId);
    entries.set(`u:${g.unionId}`, { unionId: g.unionId, openId: p?.openId ?? null, name: p?.name ?? g.name, grant: g });
  }
  for (const openId of new Set([lists.owner, ...lists.talk, ...lists.operate])) {
    const p = byOpenId.get(openId);
    const key = p === undefined ? `o:${openId}` : `u:${p.unionId}`;
    if (!entries.has(key)) entries.set(key, { unionId: p?.unionId ?? null, openId, name: p?.name ?? null, grant: undefined });
  }
  const out = [...entries.values()].map((e) => {
    const sources = sourcesOf(config, e.openId);
    return { ...e, sources, tier: tierOf(tiersFrom(sources, e.grant?.tier)) };
  });
  const sortName = (e: TierEntry): string => e.name ?? (e.unionId === null ? (e.openId ?? '') : `lark:${e.unionId}`);
  return out.sort((a, b) => rank(a) - rank(b) || sortName(a).localeCompare(sortName(b)) || (a.unionId ?? a.openId ?? '').localeCompare(b.unionId ?? b.openId ?? ''));
}
