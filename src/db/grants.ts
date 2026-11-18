import type { Tier } from '../types.js';
import type { Db } from './open.js';
import { txImmediate } from './open.js';

/**
 * Tier grants (migration 011, the tier grants spec §3): a person given talk or
 * operate tier by a row, beside the configuration's lists, keyed by this bot's
 * app id and the person's union_id. The only writer of `tier_grants`
 * (src/db/WRITERS.md).
 *
 * A row is one grant and its one end: a revocation writes the `revoked_*`
 * columns and `ended` once, on an active row, and a grant made again is a new
 * row, so the table is the audit trail. At most one active grant a person, as
 * the unique index holds: an operate grant to a person with a talk grant ends
 * it `replaced`, in the transaction that inserts the operate one.
 *
 * Every write decides inside its transaction, on the target's and the actor's
 * active grants read there: the actor's own tier can come from a grant the
 * owner is revoking at the same moment, from chat or from another process.
 */

export type Via = 'chat' | 'terminal';

export interface GrantRow {
  grantId: number;
  appId: string;
  unionId: string;
  /** As Lark gave it with the grant: a record of whom it was made for, never matched on by a check; a chat revoke by principal of a person `people` does not hold finds their configuration lists by it. */
  openId: string;
  tier: Tier;
  /** `lark:<union_id>` or `operator:<login>`. */
  grantedBy: string;
  grantedVia: Via;
  /** The chat it was made in; null at the terminal. */
  grantedChat: string | null;
  grantedAt: number;
  revokedAt: number | null;
  revokedBy: string | null;
  revokedVia: Via | null;
  revokedChat: string | null;
  ended: 'revoked' | 'replaced' | null;
}

/** An active grant, with the name `people` last holds for its person, for the lists. */
export interface NamedGrant extends GrantRow {
  name: string | null;
}

interface GrantRaw {
  grant_id: number;
  app_id: string;
  union_id: string;
  open_id: string;
  tier: Tier;
  granted_by: string;
  granted_via: Via;
  granted_chat: string | null;
  granted_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
  revoked_via: Via | null;
  revoked_chat: string | null;
  ended: 'revoked' | 'replaced' | null;
}

const COLUMNS =
  'g.grant_id, g.app_id, g.union_id, g.open_id, g.tier, g.granted_by, g.granted_via, g.granted_chat, g.granted_at, ' +
  'g.revoked_at, g.revoked_by, g.revoked_via, g.revoked_chat, g.ended';

function rowOf(r: GrantRaw): GrantRow {
  return {
    grantId: r.grant_id,
    appId: r.app_id,
    unionId: r.union_id,
    openId: r.open_id,
    tier: r.tier,
    grantedBy: r.granted_by,
    grantedVia: r.granted_via,
    grantedChat: r.granted_chat,
    grantedAt: r.granted_at,
    revokedAt: r.revoked_at,
    revokedBy: r.revoked_by,
    revokedVia: r.revoked_via,
    revokedChat: r.revoked_chat,
    ended: r.ended,
  };
}

/** Who asks for a grant or a revoke: their principal, how, and the chat when in one. */
export interface Actor {
  by: string;
  via: Via;
  chat: string | null;
}

export interface GrantRequest extends Actor {
  appId: string;
  unionId: string;
  openId: string;
  tier: Tier;
}

export interface RevokeRequest extends Actor {
  appId: string;
  unionId: string;
}

/** What a decision asks of `grantTier`: a new grant, an operate grant in place of a talk one, or nothing. */
export type GrantWrite = 'insert' | 'replace' | 'none';

/** What a decision asks of `revokeGrant`: the target's active grant ended, or nothing. */
export type RevokeWrite = 'end' | 'none';

/** The target's and the actor's active grants, as read inside the transaction. */
export type Decide<D> = (target: GrantRow | undefined, actor: GrantRow | undefined) => D;

/** The union_id in an actor's principal, when it is a person's: an operator's login has no grant. */
function actorUnionId(by: string): string | undefined {
  return by.startsWith('lark:') && by.length > 'lark:'.length ? by.slice('lark:'.length) : undefined;
}

function active(db: Db, appId: string, unionId: string | undefined): GrantRow | undefined {
  if (unionId === undefined) return undefined;
  const r = db
    .prepare<[string, string], GrantRaw>(`SELECT ${COLUMNS} FROM tier_grants g WHERE g.app_id = ? AND g.union_id = ? AND g.revoked_at IS NULL`)
    .get(appId, unionId);
  return r === undefined ? undefined : rowOf(r);
}

function byId(db: Db, grantId: number): GrantRow {
  const r = db.prepare<[number], GrantRaw>(`SELECT ${COLUMNS} FROM tier_grants g WHERE g.grant_id = ?`).get(grantId);
  if (r === undefined) throw new Error(`grant ${grantId} is not in tier_grants`);
  return rowOf(r);
}

/** End an active grant, once: the `revoked_*` columns and `ended` together. */
function end(db: Db, grantId: number, who: Actor, ended: 'revoked' | 'replaced', now: number): void {
  const r = db
    .prepare(
      `UPDATE tier_grants SET revoked_at = ?, revoked_by = ?, revoked_via = ?, revoked_chat = ?, ended = ?
        WHERE grant_id = ? AND revoked_at IS NULL`,
    )
    .run(now, who.by, who.via, who.chat, ended, grantId);
  if (r.changes !== 1) throw new Error(`grant ${grantId} is not active`);
}

/**
 * Grant `req.tier` to a person: inside one transaction, the target's and the
 * actor's active grants are read, `decide` is given them, and its answer is
 * written: a new grant, or the target's talk grant ended `replaced` and an
 * operate one inserted, with the same time and actor, or nothing for a no-op
 * or a refusal. Returns the decision and the rows written, in order.
 */
export function grantTier<D extends { write: GrantWrite }>(
  db: Db,
  req: GrantRequest,
  decide: Decide<D>,
  now: number,
): { decision: D; written: GrantRow[] } {
  return txImmediate(db, (d) => {
    const target = active(d, req.appId, req.unionId);
    const decision = decide(target, active(d, req.appId, actorUnionId(req.by)));
    if (decision.write === 'none') return { decision, written: [] };
    const written: GrantRow[] = [];
    let tier = req.tier;
    if (decision.write === 'replace') {
      if (target === undefined || target.tier !== 'talk') throw new Error(`a replace needs an active talk grant for ${req.unionId}`);
      end(d, target.grantId, req, 'replaced', now);
      written.push(byId(d, target.grantId));
      tier = 'operate';
    }
    const id = d
      .prepare(
        `INSERT INTO tier_grants (app_id, union_id, open_id, tier, granted_by, granted_via, granted_chat, granted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(req.appId, req.unionId, req.openId, tier, req.by, req.via, req.chat, now).lastInsertRowid;
    written.push(byId(d, Number(id)));
    return { decision, written };
  });
}

/**
 * Revoke a person's active grant: inside one transaction, the same two grants
 * are read and given to `decide`, and the target's grant is ended `revoked`
 * when it says so. Returns the decision and the row ended, if any.
 */
export function revokeGrant<D extends { write: RevokeWrite }>(
  db: Db,
  req: RevokeRequest,
  decide: Decide<D>,
  now: number,
): { decision: D; written: GrantRow[] } {
  return txImmediate(db, (d) => {
    const target = active(d, req.appId, req.unionId);
    const decision = decide(target, active(d, req.appId, actorUnionId(req.by)));
    if (decision.write === 'none') return { decision, written: [] };
    if (target === undefined) throw new Error(`there is no active grant for ${req.unionId} to end`);
    end(d, target.grantId, req, 'revoked', now);
    return { decision, written: [byId(d, target.grantId)] };
  });
}

/** This bot's active grant for the person with this union_id, by the unique index; undefined with none. */
export function activeGrant(db: Db, appId: string, unionId: string): GrantRow | undefined {
  return active(db, appId, unionId);
}

/**
 * The tier of this bot's active grant for a union_id, with its statement
 * prepared once: what the gateway's `Authorizer` reads at each check.
 */
export function tierReader(db: Db, appId: string): (unionId: string) => Tier | undefined {
  const statement = db.prepare<[string, string], { tier: Tier }>(
    'SELECT tier FROM tier_grants WHERE app_id = ? AND union_id = ? AND revoked_at IS NULL',
  );
  return (unionId) => statement.get(appId, unionId)?.tier;
}

/** This bot's active grants, each with the name `people` last holds for its person, oldest first. */
export function activeGrants(db: Db, appId: string): NamedGrant[] {
  return db
    .prepare<[string], GrantRaw & { name: string | null }>(
      `SELECT ${COLUMNS}, p.name AS name FROM tier_grants g
         LEFT JOIN people p ON p.app_id = g.app_id AND p.union_id = g.union_id
        WHERE g.app_id = ? AND g.revoked_at IS NULL ORDER BY g.grant_id`,
    )
    .all(appId)
    .map((r) => ({ ...rowOf(r), name: r.name }));
}

/** The talk grants a principal made that are still active: what a revoked operator leaves behind (tier grants spec §6.1). */
export function talkGrantsMadeBy(db: Db, appId: string, by: string): number {
  const row = db
    .prepare<[string, string], { n: number }>(
      "SELECT count(*) AS n FROM tier_grants WHERE app_id = ? AND granted_by = ? AND tier = 'talk' AND revoked_at IS NULL",
    )
    .get(appId, by);
  return row?.n ?? 0;
}

/**
 * Active grants by tier for this bot, and the active grants under any other
 * app id, which count for nothing here: the startup line's (tier grants spec §8.4).
 */
export function grantCounts(db: Db, appId: string): { talk: number; operate: number; otherApps: number } {
  const rows = db
    .prepare<[string], { mine: number; tier: Tier; n: number }>(
      `SELECT app_id = ? AS mine, tier, count(*) AS n FROM tier_grants WHERE revoked_at IS NULL GROUP BY mine, tier`,
    )
    .all(appId);
  const count = (mine: number, tier?: Tier): number =>
    rows.filter((r) => r.mine === mine && (tier === undefined || r.tier === tier)).reduce((n, r) => n + r.n, 0);
  return { talk: count(1, 'talk'), operate: count(1, 'operate'), otherApps: count(0) };
}
