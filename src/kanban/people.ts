import type { Db } from '../db/open.js';
import { namedPeopleOf, notePerson, personOf } from '../db/people.js';
import { sharedName } from './chat-render.js';
import { systemClock, type Clock } from '../time.js';
import type { People } from './service.js';

/**
 * The people the board can give work to (spec §4.2, §9.1), as the gateway has
 * seen them in Lark.
 *
 * The board knows a person as `lark:<union_id>`; the configuration's tiers are
 * decided by open_id. Lark gives both for a sender, for whoever presses a
 * card's button, and for each person a message mentions, so each is noted as
 * it is seen, and a person named by principal alone -- typed out, or by an
 * agent's `mt kanban create` -- is checked through the open_id last seen with
 * their union_id, and by a grant to their union_id (tier grants spec §4.3). A
 * person the gateway has never seen is in no list, and is given work only by
 * a grant.
 */

export interface PeopleDeps {
  db: Db;
  /** This bot: open_ids are per app. */
  appId: string;
  /**
   * Whether a person has talk tier (tier grants spec §4.3): by the open_id
   * `people` holds for them with this app id, null when it holds none, in the
   * configuration's lists, or by their union_id's active grant.
   */
  canTalk(person: { openId: string | null; unionId: string }): boolean;
  clock?: Clock;
}

/** Someone Lark identified: a sender, a card's presser, or a person a message mentions. */
export interface SeenPerson {
  openId: string | null;
  unionId: string | null;
  name: string | null;
}

const PREFIX = 'lark:';

/** A person's principal on the board (spec §3.1). */
export function personPrincipal(unionId: string): string {
  return `${PREFIX}${unionId}`;
}

/** The union_id in a person's principal, or undefined for anything else. */
export function unionIdOf(principal: string): string | undefined {
  return principal.startsWith(PREFIX) && principal.length > PREFIX.length ? principal.slice(PREFIX.length) : undefined;
}

export class PeopleDirectory implements People {
  readonly #deps: PeopleDeps;
  readonly #clock: Clock;

  constructor(deps: PeopleDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
  }

  /**
   * Note a person Lark identified, and give their principal. One that came
   * without both ids is not noted, and has no principal: the board records
   * people by union_id, and checks them by open_id.
   */
  saw(p: SeenPerson): string | undefined {
    if (p.unionId === null || p.unionId === '' || p.openId === null || p.openId === '') return undefined;
    notePerson(this.#deps.db, { appId: this.#deps.appId, unionId: p.unionId, openId: p.openId, name: p.name }, this.#clock.now());
    return personPrincipal(p.unionId);
  }

  /**
   * Whether this person may be given work: at talk tier by the open_id last
   * seen for them, or by a grant to their union_id, which needs no row here.
   */
  canTalk(principal: string): boolean {
    const unionId = unionIdOf(principal);
    if (unionId === undefined) return false;
    const person = personOf(this.#deps.db, this.#deps.appId, unionId);
    return this.#deps.canTalk({ openId: person?.openId ?? null, unionId });
  }

  /** The name Lark last gave for this person, if any: what a notice calls them. */
  nameOf(principal: string): string | undefined {
    const unionId = unionIdOf(principal);
    if (unionId === undefined) return undefined;
    return personOf(this.#deps.db, this.#deps.appId, unionId)?.name ?? undefined;
  }

  /**
   * What chat calls this person (spec §9.3): the name Lark last gave, or, when
   * another person this bot has seen has the same name, collapsed and trimmed,
   * that name with the start of their union_id, "Hemanth (on_8ba3…)"
   * (`sharedName`). Undefined where no name is known, and chat shows the
   * principal. Agents' prompts take `nameOf`, unchanged. One lookup reads the
   * table; a reply naming several people takes `chatNames`.
   */
  chatName(principal: string): string | undefined {
    return this.chatNames()(principal);
  }

  /**
   * `chatName` for one reply: the people table read once, at the first name
   * asked for, and every name after answered from what was read.
   */
  chatNames(): (principal: string) => string | undefined {
    let read: { names: Map<string, string>; byName: Map<string, string[]> } | undefined;
    return (principal) => {
      const unionId = unionIdOf(principal);
      if (unionId === undefined) return undefined;
      read ??= this.#read();
      const name = read.names.get(unionId);
      if (name === undefined) return undefined;
      const others = (read.byName.get(collapsed(name)) ?? []).filter((u) => u !== unionId);
      return others.length === 0 ? name : sharedName(name, unionId, others);
    };
  }

  #read(): { names: Map<string, string>; byName: Map<string, string[]> } {
    const names = new Map<string, string>();
    const byName = new Map<string, string[]>();
    for (const p of namedPeopleOf(this.#deps.db, this.#deps.appId)) {
      const key = collapsed(p.name);
      if (key === '') continue;
      names.set(p.unionId, p.name);
      byName.set(key, [...(byName.get(key) ?? []), p.unionId]);
    }
    return { names, byName };
  }
}

/** A name as two are compared (spec §9.3): white space collapsed, and trimmed. */
function collapsed(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}
