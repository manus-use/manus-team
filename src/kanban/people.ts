import type { Db } from '../db/open.js';
import { notePerson, personOf } from '../db/people.js';
import { systemClock, type Clock } from '../time.js';
import type { People } from './service.js';

/**
 * The people the board can give work to (spec §4.2, §9.1), as the gateway has
 * seen them in Lark.
 *
 * The board knows a person as `lark:<union_id>`; the tiers are decided by
 * open_id. Lark gives both for a sender, for whoever presses a card's button,
 * and for each person a message mentions, so each is noted as it is seen, and
 * a person named by principal alone -- typed out, or by an agent's `mt kanban
 * create` -- is checked through the open_id last seen with their union_id. A
 * person the gateway has never seen cannot be checked, and so is not given work.
 */

export interface PeopleDeps {
  db: Db;
  /** This bot: open_ids are per app. */
  appId: string;
  /** Whether an open_id has talk tier: the router's authorizer. */
  canTalk(openId: string): boolean;
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

  /** Whether this person may be given work: seen, and at talk tier by the open_id last seen for them. */
  canTalk(principal: string): boolean {
    const unionId = unionIdOf(principal);
    if (unionId === undefined) return false;
    const person = personOf(this.#deps.db, this.#deps.appId, unionId);
    return person !== undefined && this.#deps.canTalk(person.openId);
  }

  /** The name Lark last gave for this person, if any: what a notice calls them. */
  nameOf(principal: string): string | undefined {
    const unionId = unionIdOf(principal);
    if (unionId === undefined) return undefined;
    return personOf(this.#deps.db, this.#deps.appId, unionId)?.name ?? undefined;
  }
}
