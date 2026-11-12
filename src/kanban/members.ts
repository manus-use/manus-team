import { ChannelError, type Channel, type ChatMembers } from '../channel/types.js';
import { BoundedMap } from '../core/bounded-map.js';
import { redactKnownSecrets } from '../secrets.js';
import { systemClock, type Clock } from '../time.js';

/**
 * Who is a member of a group (spec §19.3), for the card poster: whether a
 * person's card can go in a task's thread there.
 *
 * **From Lark's chat members API**, the channel's `chatMembers`: a whole group
 * read at once, so one lookup serves every card in it, kept `MEMBERS_MS` per bot
 * and group, at most `MEMBERS_CHATS` groups. A person added to a group gets their
 * cards there within five minutes; one who left may get one there within five.
 *
 * **A lookup that failed**, Lark refusing, or past `timeoutMs`, is remembered
 * `MEMBERS_FAILED_MS`, and meanwhile the group's members are taken as unknown, so
 * every card goes by direct message, as before there were threads. A missing
 * permission is said once per boot; any other failure each time it is
 * remembered afresh, by ids only. Memory only: a restart asks again.
 */

/** How long a group's members are trusted. */
export const MEMBERS_MS = 5 * 60_000;
/** How long a failed lookup is remembered, so a missing permission is not asked of Lark at every card round. */
export const MEMBERS_FAILED_MS = 60_000;
/** Groups remembered at most. */
export const MEMBERS_CHATS = 256;
/** Lark's code for an app without the permission an API needs: taken as this, to be confirmed by the smoke checklist. */
export const NO_PERMISSION = 99991672;
/** Said once per boot, at the first lookup Lark refuses for a missing permission. */
export const NO_MEMBERS_SCOPE =
  "kanban: cards go by direct message: the app lacks im:chat.members:read, which Lark's chat members API needs";

export interface MembershipDeps {
  /** The channel the cards go by: its `chatMembers`. */
  channel: Channel;
  /** This bot: a group's members are its own to ask about. */
  appId: string;
  /** The longest a whole lookup, every page, is waited for: the card poster's `CARD_SEND_MS`. */
  timeoutMs: number;
  clock?: Clock;
  /** Metadata only: ids, and Lark's error, masked. */
  note?: (line: string) => void;
}

/**
 * Assumes one caller at a time, as the card poster posts one card at a time: two
 * lookups of the same group at once would each ask Lark.
 */
export class Membership {
  readonly #deps: MembershipDeps;
  readonly #members: BoundedMap<string, ChatMembers>;
  readonly #failed: BoundedMap<string, true>;
  #scopeSaid = false;

  constructor(deps: MembershipDeps) {
    this.#deps = deps;
    const clock = deps.clock ?? systemClock;
    this.#members = new BoundedMap({ ttlMs: MEMBERS_MS, maxEntries: MEMBERS_CHATS }, clock);
    this.#failed = new BoundedMap({ ttlMs: MEMBERS_FAILED_MS, maxEntries: MEMBERS_CHATS }, clock);
  }

  /**
   * Whether the person is a member of the group, as far as Lark said: false when
   * they are not among the members read, and when the members could not be read.
   * Never rejects.
   */
  async isMember(chatId: string, unionId: string): Promise<boolean> {
    const key = `${this.#deps.appId}\u0000${chatId}`;
    if (this.#failed.has(key)) return false;
    let members = this.#members.get(key);
    if (members === undefined) {
      try {
        members = await this.#bounded(this.#deps.channel.chatMembers(chatId));
      } catch (err) {
        this.#failed.set(key, true);
        this.#said(chatId, err);
        return false;
      }
      this.#members.set(key, members);
    }
    return members.unionIds.has(unionId);
  }

  #said(chatId: string, err: unknown): void {
    let line: string;
    if (err instanceof ChannelError && err.code === NO_PERMISSION) {
      if (this.#scopeSaid) return;
      this.#scopeSaid = true;
      line = NO_MEMBERS_SCOPE;
    } else {
      const why = redactKnownSecrets(err instanceof Error ? err.message : String(err));
      line = `kanban: the members of chat ${chatId} could not be read (${why}); its cards go by direct message for a minute`;
    }
    try {
      this.#deps.note?.(line);
    } catch {
      // Nowhere left to say it.
    }
  }

  /** A lookup, waited for at most `timeoutMs`: one that outlasts it is a failed lookup. */
  async #bounded<T>(lookup: Promise<T>): Promise<T> {
    const ms = this.#deps.timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      const took = ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
      timer = setTimeout(() => reject(new Error(`the lookup took longer than ${took}`)), ms);
    });
    try {
      return await Promise.race([lookup, late]);
    } finally {
      clearTimeout(timer);
      lookup.catch(() => undefined);
    }
  }
}
