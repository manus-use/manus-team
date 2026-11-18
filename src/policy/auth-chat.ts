import { mentionedPerson } from '../channel/mentions.js';
import { sourceText, type GatewayConfig } from '../config.js';
import { formatWall } from '../cron/schedule.js';
import { activeGrants, grantTier, revokeGrant, talkGrantsMadeBy, type GrantRow } from '../db/grants.js';
import type { Db } from '../db/open.js';
import { peopleOf, personOf } from '../db/people.js';
import { label } from '../kanban/chat-render.js';
import { personPrincipal, unionIdOf, type PeopleDirectory } from '../kanban/people.js';
import { systemClock, type Clock } from '../time.js';
import type { InboundMention, InboundMessage, Principal } from '../types.js';
import type { Authorizer } from './auth.js';
import {
  actorOf,
  decideGrant,
  decideRevoke,
  grantReply,
  revokeReply,
  tierEntries,
  type Actor,
  type Held,
  type Target,
  type TierEntry,
  type Words,
} from './grants.js';

/**
 * `/auth` in chat (the tier grants spec §6.1, §8.1): `list` at talk tier, and
 * `grant @Name talk|operate` and `revoke @Name` or `revoke lark:<union_id>`,
 * each judged by `decideGrant` or `decideRevoke` inside the writer's
 * transaction. A grant takes an @-mention only, so it is always made with the
 * ids Lark sent: nobody types an id. Always on, the board and cron off or not.
 *
 * The reply is the announcement: one line in the chat or thread it was typed
 * in, naming the person by the name Lark's mention showed, never by a mention
 * of its own. Names are shown through `label`, masked, and the router masks
 * the whole reply once more.
 */

export interface AuthChatDeps {
  db: Db;
  /** This bot: grants are per app id. */
  appId: string;
  /** The owner and the sources a decision is fed: the router's authorizer. */
  authorizer: Authorizer;
  /** The configuration's owner and lists, and where each came from, for the list and the words. */
  auth: Pick<GatewayConfig['auth'], 'ownerOpenId' | 'allowTalk' | 'allowOperate' | 'from'>;
  /** Who the gateway has seen: each sender and mention is noted here first. */
  people: PeopleDirectory;
  /** The zone a grant's day is said in: `cron.tz`, else the process's. */
  zone: string;
  clock?: Clock;
  /** The log: one line a change, ids only (§7). */
  note?: (line: string) => void;
}

/** At most this many lines of `/auth list`, then how many more. */
export const AUTH_LIST_MAX = 50;

const HELP = [
  '`/auth list`: everyone with a tier, and where it comes from.',
  "`/auth grant @Name talk` or `/auth grant @Name operate`: give a tier beside the configuration's lists. An operator grants talk; only the owner grants operate.",
  '`/auth revoke @Name` or `/auth revoke lark:<union_id>`: end a grant. The configuration and the owner are never changed from chat.',
].join('\n');

const NO_UNION_ID =
  'Lark did not say who you are (no union_id came with the message), and a grant records who made or ended it. Ask the operator to check the app can read user ids.';

/** What Lark gave for a sender or a mention, as the people directory notes it. */
function seen(p: Principal | InboundMention): { openId: string | null; unionId: string | null; name: string | null } {
  return 'key' in p ? { openId: p.openId, unionId: p.unionId, name: p.name } : { openId: p.openId, unionId: p.unionId, name: p.displayName };
}

/** A grant's maker and moment, as a decision's words need them. */
function held(g: GrantRow | undefined): Held | undefined {
  return g === undefined ? undefined : { tier: g.tier, by: g.grantedBy, at: g.grantedAt };
}

/** The person a command names: their union_id, the open_id to judge them by, and the name to call them. */
interface Named {
  unionId: string;
  openId: string | null;
  who: string;
}

/** Why a command names no one: the reply, and whether the message mentions no one by the name typed. */
interface Unnamed {
  refused: string;
  notMentioned: boolean;
}

export class AuthChat {
  readonly #deps: AuthChatDeps;
  readonly #clock: Clock;

  constructor(deps: AuthChatDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
  }

  /** `/auth <arg>` from this message: the reply. */
  run(arg: string, message: InboundMessage): string {
    const head = /^\s*(\S*)\s*/.exec(arg)?.[0] ?? '';
    const verb = head.trim().toLowerCase();
    const rest = arg.slice(head.length).trim();
    // Noted first, as /kanban notes them: the person granted can be named by principal at once, and has a name in the lists.
    this.#deps.people.saw(seen(message.sender));
    for (const m of message.mentions ?? []) this.#deps.people.saw(seen(m));
    switch (verb) {
      case 'list':
        return rest === '' ? this.#list() : HELP;
      case 'grant':
        return this.#grant(rest, message);
      case 'revoke':
        return this.#revoke(rest, message);
      default:
        return HELP;
    }
  }

  #grant(rest: string, message: InboundMessage): string {
    const parts = /^(.*\S)\s+(\S+)$/.exec(rest);
    const tier = parts?.[2]?.toLowerCase();
    if (parts === null || (tier !== 'talk' && tier !== 'operate')) {
      return '`/auth grant` takes the person, then the tier: `/auth grant @Name talk` or `/auth grant @Name operate`.';
    }
    const name = (parts[1] ?? '').trim();
    if (name.startsWith('lark:')) {
      return 'A grant takes an @-mention, so it is made with the ids Lark sends: type @ and pick them. `lark:<union_id>` is for `/auth revoke`.';
    }
    if (!name.startsWith('@')) return HELP;
    const by = this.#by(message);
    if (by === undefined) return NO_UNION_ID;
    const found = this.#mentioned(name, message);
    if ('refused' in found) {
      // In a direct message, a person can be @-mentioned only where Lark lets them be.
      return message.chatType === 'p2p' && found.notMentioned
        ? `${found.refused} In a direct message, grant in a group they are in, or with \`mt auth grant\` at the terminal.`
        : found.refused;
    }
    if (found.openId === null) {
      return `Lark did not say who ${label(name, 80)} is (no open_id came with the mention). Ask the operator to check the app can read user ids.`;
    }
    const sources = this.#deps.authorizer.sourcesOf(found.openId);
    let target: Target = { sources, grant: undefined };
    const r = grantTier(
      this.#deps.db,
      { appId: this.#deps.appId, unionId: found.unionId, openId: found.openId, tier, by, via: 'chat', chat: message.chatId },
      (grant, actorGrant) => {
        target = { sources, grant: held(grant) };
        return decideGrant(this.#actor(message.sender, actorGrant), target, tier);
      },
      this.#clock.now(),
    );
    const d = r.decision;
    const principal = personPrincipal(found.unionId);
    if (d.outcome === 'granted') this.#note(`auth: ${d.tier} granted to ${principal} by ${by} in chat ${message.chatId}`);
    if (d.outcome === 'replaced') this.#note(`auth: operate granted to ${principal} by ${by} in chat ${message.chatId} (replacing talk)`);
    return grantReply(d, target, this.#words(found.who, principal, message.sender));
  }

  #revoke(rest: string, message: InboundMessage): string {
    if (rest === '') return '`/auth revoke` takes the person: `/auth revoke @Name`, or `/auth revoke lark:<union_id>` for someone who can no longer be mentioned.';
    const by = this.#by(message);
    if (by === undefined) return NO_UNION_ID;
    let found: Named | Unnamed;
    if (rest.startsWith('lark:')) {
      const unionId = unionIdOf(rest);
      if (unionId === undefined || !/^[A-Za-z0-9_-]{1,64}$/.test(unionId)) return `${label(rest, 80)} is not a person: a person is \`lark:<union_id>\`, which \`/auth list\` shows.`;
      const p = personOf(this.#deps.db, this.#deps.appId, unionId);
      found = { unionId, openId: p?.openId ?? null, who: p?.name === null || p?.name === undefined ? label(rest, 80) : label(p.name, 80) };
    } else if (rest.startsWith('@')) {
      found = this.#mentioned(rest, message);
    } else {
      return HELP;
    }
    if ('refused' in found) return found.refused;
    const named = found;
    let target: Target = { sources: this.#deps.authorizer.sourcesOf(named.openId), grant: undefined };
    const r = revokeGrant(
      this.#deps.db,
      { appId: this.#deps.appId, unionId: named.unionId, by, via: 'chat', chat: message.chatId },
      (grant, actorGrant) => {
        // A principal people holds no row for has no open_id but the grant's own, which the configuration's lists are matched by.
        target = { sources: this.#deps.authorizer.sourcesOf(named.openId ?? grant?.openId ?? null), grant: held(grant) };
        return decideRevoke(this.#actor(message.sender, actorGrant), target);
      },
      this.#clock.now(),
    );
    const d = r.decision;
    const principal = personPrincipal(named.unionId);
    let made = 0;
    if (d.outcome === 'revoked') {
      this.#note(`auth: ${d.grant} grant of ${principal} revoked by ${by} in chat ${message.chatId}`);
      if (d.grant === 'operate') made = talkGrantsMadeBy(this.#deps.db, this.#deps.appId, principal);
    }
    return revokeReply(d, target, this.#words(named.who, principal, message.sender), made);
  }

  /** `/auth list` (§8.1): everyone with a tier, the owner first, at most `AUTH_LIST_MAX` lines. */
  #list(): string {
    const { auth, db, appId } = this.#deps;
    const entries = tierEntries({ owner: auth.ownerOpenId, talk: auth.allowTalk, operate: auth.allowOperate }, activeGrants(db, appId), peopleOf(db, appId));
    const lines = entries.map((e) => this.#line(e));
    if (lines.length <= AUTH_LIST_MAX) return lines.join('\n');
    return [...lines.slice(0, AUTH_LIST_MAX), `and ${lines.length - AUTH_LIST_MAX} more: \`mt auth list\` at the terminal lists everyone`].join('\n');
  }

  #line(e: TierEntry): string {
    const from = this.#deps.auth.from;
    const who =
      e.unionId === null
        ? label(e.openId ?? '', 80)
        : e.name === null
          ? label(personPrincipal(e.unionId), 80)
          : `${label(e.name, 80)} (${label(personPrincipal(e.unionId), 80)})`;
    const unseen = e.unionId === null ? '; not seen by this bot yet' : '';
    const g = e.grant;
    const granted = g === undefined ? '' : `granted by ${this.#nameOf(g.grantedBy)} on ${this.#day(g.grantedAt)}`;
    if (e.sources.owner) return `Owner: ${who}, ${sourceText(from.owner)}${g === undefined ? '' : `; also a ${g.tier} grant, ${granted}`}${unseen}`;
    if (e.tier === null) return `${who}: in ${from.operate} without talk tier, so no tier${unseen}`;
    let why: string;
    if (e.tier === 'operate') {
      if (e.sources.operate && e.sources.talk) why = `${sourceText(from.operate)}${g === undefined ? '' : `; also a ${g.tier} grant, ${granted}`}`;
      else if (g?.tier === 'operate') why = `${granted}${e.sources.talk ? `; talk also ${sourceText(from.talk)}` : ''}`;
      else why = `${sourceText(from.operate)}, with talk ${granted}`;
    } else {
      why = e.sources.talk ? `${sourceText(from.talk)}${g === undefined ? '' : `; also ${granted}`}` : granted;
    }
    return `${who}: ${e.tier}, ${why}${unseen}`;
  }

  /** The sender's principal, which a grant records; undefined when Lark gave no union_id. */
  #by(message: InboundMessage): string | undefined {
    const u = message.sender.unionId;
    return u === null || u === '' ? undefined : personPrincipal(u);
  }

  /** The sender as an actor, by the grant read inside the transaction. */
  #actor(sender: Principal, grant: GrantRow | undefined): Actor {
    if (this.#deps.authorizer.isOwner(sender)) return 'owner';
    return actorOf(this.#deps.authorizer.sourcesOf(sender.openId), grant?.tier);
  }

  /** The person an `@Name` stands for, by the name Lark's mention showed; or why not. */
  #mentioned(name: string, message: InboundMessage): Named | Unnamed {
    const found = mentionedPerson(name, message);
    if (!found.ok) return { refused: found.reply, notMentioned: found.reason === 'not_mentioned' };
    return { unionId: found.unionId, openId: found.openId, who: label(found.name ?? name.slice(1).trim(), 80) };
  }

  #words(who: string, principal: string, sender: Principal): Words {
    const u = sender.unionId;
    const by = sender.displayName === null || sender.displayName === '' ? label(u === null ? sender.openId : personPrincipal(u), 80) : label(sender.displayName, 80);
    return { via: 'chat', who, principal, by, from: this.#deps.auth.from, held: (g) => `${this.#nameOf(g.by)} on ${this.#day(g.at)}` };
  }

  /** A grant's maker, by the name Lark last gave for them, else their principal. */
  #nameOf(principal: string): string {
    const name = this.#deps.people.nameOf(principal);
    return label(name ?? principal, 80);
  }

  #day(at: number): string {
    return formatWall(this.#deps.zone, at).slice(0, 10);
  }

  #note(line: string): void {
    try {
      this.#deps.note?.(line);
    } catch {
      // The log is told, never relied on.
    }
  }
}
