import { systemClock, type Clock } from '../time.js';
import type { InboundMessage, Principal, RejectReason, Tier } from '../types.js';
import type { Sources } from './grants.js';

/**
 * Authorization. Two tiers, two sources each with one write path, closed by default.
 *
 * The three properties below are each stated explicitly because each one is easy
 * to get backwards, and getting any of them backwards fails *open*.
 */

export interface AuthConfig {
  /**
   * `open_id`s permitted to drive the agent.
   *
   * **Empty means closed, not unrestricted.** An empty list reads naturally as "no
   * restrictions configured", which is the opposite of what a missing allowlist
   * should mean. A gateway that starts wide open because its config was
   * incomplete is worse than one that answers nobody.
   */
  allowTalk: readonly string[];
  /** `open_id`s permitted to run mutating control verbs. Must also be in `allowTalk`. */
  allowOperate: readonly string[];
  /**
   * Raw `open_id` of the owner, stored unresolved.
   *
   * Never passed through the contact API, so it stays a usable DM target even when
   * identity resolution is broken -- which is exactly when someone needs to be
   * told the gateway is unhappy.
   */
  ownerOpenId: string;
  /** Chats the bot will act in. Empty means any chat. */
  allowChats: readonly string[];
  /** Bot senders permitted to drive the agent. Almost always empty. */
  allowBots: readonly string[];
  /** Whether a direct message may drive the agent without an explicit @-mention. */
  allowDirectMessages: boolean;
  /** Whether `@all` may trigger the bot. Default false. */
  allowMentionAll: boolean;
}

export function defaultAuthConfig(ownerOpenId: string): AuthConfig {
  return {
    allowTalk: [ownerOpenId],
    allowOperate: [ownerOpenId],
    ownerOpenId,
    allowChats: [],
    allowBots: [],
    allowDirectMessages: true,
    allowMentionAll: false,
  };
}

export type Decision = { ok: true } | { ok: false; reason: RejectReason; detail: string };

/** The configuration's two lists, by open_id, with the owner in both (`loadConfig`). */
export interface TierLists {
  allowTalk: readonly string[];
  allowOperate: readonly string[];
}

/** A person's two tiers. */
export interface Tiers {
  talk: boolean;
  operate: boolean;
}

/**
 * A person's tiers (tier grants spec §2.1), from the configuration's lists and
 * their active grant, if any: talk when the open_id is in `allowTalk` or there
 * is a grant of either tier; operate when they have talk and the open_id is in
 * `allowOperate` or the grant is operate. An open_id of null, a person `people`
 * does not hold, matches no list.
 *
 * One function, which the gateway's `Authorizer` and the terminal both call, so
 * the two cannot come to disagree about who has a tier.
 */
export function tiersOf(lists: TierLists, openId: string | null, grant: Tier | undefined): Tiers {
  return tiersFrom(
    { talk: openId !== null && lists.allowTalk.includes(openId), operate: openId !== null && lists.allowOperate.includes(openId) },
    grant,
  );
}

/** Whether an open_id is the owner, and whether it is in each of the configuration's lists (tier grants spec §5.1). */
export function sourcesOf(lists: TierLists & { ownerOpenId: string }, openId: string | null): Sources {
  if (openId === null) return { owner: false, talk: false, operate: false };
  return { owner: openId === lists.ownerOpenId, talk: lists.allowTalk.includes(openId), operate: lists.allowOperate.includes(openId) };
}

/**
 * The second source of a tier beside the configuration (tier grants spec
 * §4.1): this bot's active grants, read at each check.
 */
export interface GrantReader {
  /** This bot's active grant for the person with this union_id: its tier, or undefined. */
  tierOf(unionId: string): Tier | undefined;
}

export interface AuthorizerDeps {
  /** Grants, read at each check; without, there are none, as before grants. */
  grants?: GrantReader;
  /** Where a failed read of the grants is said, at most once a minute. */
  note?: (line: string) => void;
  clock?: Clock;
}

/** How often a failing grant read is said: once is enough to be seen, and every check would flood the log. */
const READ_FAILURE_NOTE_MS = 60_000;

/**
 * `tiersOf`'s rule, given whether the person is in each list. A grant of
 * operate gives talk too: operate needs talk, and an operate grant that left
 * talk to the configuration would be dead for a person in no list.
 */
export function tiersFrom(listed: { talk: boolean; operate: boolean }, grant: Tier | undefined): Tiers {
  const talk = listed.talk || grant !== undefined;
  return { talk, operate: talk && (listed.operate || grant === 'operate') };
}

const OK: Decision = { ok: true };

/**
 * The single entry point for every inbound authorization question.
 *
 * One function, not a set of predicates called from various places. A second
 * entry point is how a boundary gets silently reopened: the first check is
 * tightened, the second is forgotten, and the forgotten one is the one the
 * request actually takes.
 */
export class Authorizer {
  #config: AuthConfig;
  readonly #deps: AuthorizerDeps;
  readonly #clock: Clock;
  #failedAt: number | undefined;

  constructor(config: AuthConfig, deps: AuthorizerDeps = {}) {
    this.#config = config;
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
  }

  /**
   * Replace the configuration, and only the configuration.
   *
   * The configuration is not edited from chat, so there is no command that
   * reaches this. Grants are a second source, read through the `GrantReader`
   * at each check and written only by `db/grants.ts`, never passed through
   * here; their rules (tier grants spec §5) are what keep a person who got in
   * from keeping themselves in.
   */
  reconfigure(config: AuthConfig): void {
    this.#config = config;
  }

  get ownerOpenId(): string {
    return this.#config.ownerOpenId;
  }

  /** Whether this principal is the owner, by the configuration's owner open_id. */
  isOwner(principal: Principal): boolean {
    return principal.openId === this.#config.ownerOpenId;
  }

  /** Whether an open_id is the owner, and in each of the configuration's lists: what a grant's decision is fed. */
  sourcesOf(openId: string | null): Sources {
    return sourcesOf(this.#config, openId);
  }

  /**
   * The tier of this bot's active grant for a union_id, read now: none with no
   * reader or no union_id, and none when the read fails, which is said at most
   * once a minute. Closed, as an empty list is; the configuration's tiers, the
   * owner's included, still hold.
   */
  grantOf(unionId: string | null): Tier | undefined {
    const grants = this.#deps.grants;
    if (grants === undefined || unionId === null || unionId === '') return undefined;
    try {
      return grants.tierOf(unionId);
    } catch (err) {
      const now = this.#clock.now();
      if (this.#failedAt === undefined || now - this.#failedAt >= READ_FAILURE_NOTE_MS) {
        this.#failedAt = now;
        this.#deps.note?.(`auth: reading the tier grants failed, so none count until a read succeeds: ${err instanceof Error ? err.message : String(err)}`);
      }
      return undefined;
    }
  }

  canTalk(principal: Principal): boolean {
    return tiersOf(this.#config, principal.openId, this.grantOf(principal.unionId)).talk;
  }

  /**
   * Whether a principal may run a mutating verb.
   *
   * Requires `canTalk` as well. An operate entry that is not also a talk entry
   * would otherwise let someone `/clear` a session they cannot even read.
   */
  canOperate(principal: Principal): boolean {
    return tiersOf(this.#config, principal.openId, this.grantOf(principal.unionId)).operate;
  }

  hasTier(principal: Principal, tier: Tier): boolean {
    return tier === 'operate' ? this.canOperate(principal) : this.canTalk(principal);
  }

  /**
   * Should this message be acted on at all?
   *
   * Ordered cheapest-and-most-categorical first. The bot-sender check leads
   * because two bots @-ing each other loop forever, and a loop that is also
   * authorized is a loop that runs until someone notices the bill.
   */
  admits(message: InboundMessage): Decision {
    const cfg = this.#config;

    if (message.senderIsBot && !cfg.allowBots.includes(message.sender.openId)) {
      return {
        ok: false,
        reason: 'bot_sender',
        detail: 'Message came from a bot, which is not allowlisted.',
      };
    }

    const conversation = this.admitsConversation(message.chatId, message.chatType);
    if (conversation === 'chat_not_allowed') {
      return { ok: false, reason: 'chat_not_allowed', detail: 'This chat is not allowlisted.' };
    }
    if (conversation === 'dm_disabled') {
      return { ok: false, reason: 'dm_disabled', detail: 'Direct messages are disabled.' };
    }

    if (message.chatType !== 'p2p') {
      // In a group, an unmentioned message is not addressed to us. Acting on it
      // would make the bot answer every message in the room.
      if (!message.mentionedBot) {
        return { ok: false, reason: 'no_mention', detail: 'Not mentioned.' };
      }
      if (message.mentionAll && !cfg.allowMentionAll) {
        return {
          ok: false,
          reason: 'mention_all_blocked',
          detail: '@all does not trigger the bot.',
        };
      }
    }

    if (!this.canTalk(message.sender)) {
      return {
        ok: false,
        reason: 'sender_not_allowed',
        detail: 'You do not have talk tier here.',
      };
    }

    return OK;
  }

  /**
   * Whether the gateway acts in this conversation at all, whoever is in it
   * (wake spec §2.1, §13): a chat outside a non-empty `allowChats`, or a direct
   * message while `allowDirectMessages` is off, is refused with the reason
   * `admits` gives; undefined when admitted. A chat whose kind is not known,
   * null, is judged by `allowChats` alone. `admits` calls it for those two
   * checks, so the waker and the router cannot come to disagree.
   */
  admitsConversation(chatId: string, chatType: 'p2p' | 'group' | null): 'chat_not_allowed' | 'dm_disabled' | undefined {
    const cfg = this.#config;
    if (cfg.allowChats.length > 0 && !cfg.allowChats.includes(chatId)) return 'chat_not_allowed';
    if (chatType === 'p2p' && !cfg.allowDirectMessages) return 'dm_disabled';
    return undefined;
  }

  /** Tier check for a command, after `admits` has already passed. */
  admitsTier(principal: Principal, tier: Tier): Decision {
    if (this.hasTier(principal, tier)) return OK;
    return {
      ok: false,
      reason: 'insufficient_tier',
      detail:
        tier === 'operate'
          ? 'That command changes session state and needs operator permission.'
          : 'You do not have talk tier here.',
    };
  }
}

/**
 * Merge freshly resolved identities into an allowlist, keeping last-known-good
 * entries for anything that failed to resolve.
 *
 * The fallback is the point. Re-resolving an allowlist at boot means a transient
 * contact-API failure can return an empty set, and an allowlist that empties
 * itself locks the owner out of the only tool they have for fixing it. Per-entry
 * last-known-good means a blip degrades to stale data rather than to no data.
 */
export function mergeResolved(
  previous: readonly string[],
  resolved: ReadonlyMap<string, string | undefined>,
): string[] {
  const out: string[] = [];
  for (const entry of previous) {
    const fresh = resolved.get(entry);
    out.push(fresh ?? entry);
  }
  return [...new Set(out)];
}
