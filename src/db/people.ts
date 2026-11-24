import type { Db } from './open.js';
import { txImmediate } from './open.js';

/**
 * The people the gateway has seen in Lark (migration 005): for each union_id,
 * the open_id and name Lark last gave with it. The board knows people by
 * union_id, and the tiers by open_id, so this is how a person named only as
 * `lark:<union_id>` is checked for talk tier (spec §4.2). The only writer of
 * `people` (src/db/WRITERS.md).
 */

export interface PersonRow {
  appId: string;
  unionId: string;
  openId: string;
  name: string | null;
  seenAt: number;
}

interface PersonRaw {
  app_id: string;
  union_id: string;
  open_id: string;
  name: string | null;
  seen_at: number;
}

/**
 * Note a person as Lark gave them: the open_id and name replace what was known,
 * so a renamed person shows their new name. A name Lark did not give keeps the
 * one known.
 */
export function notePerson(
  db: Db,
  p: { appId: string; unionId: string; openId: string; name: string | null },
  now: number,
): void {
  txImmediate(db, (d) =>
    d
      .prepare(
        `INSERT INTO people (app_id, union_id, open_id, name, seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (app_id, union_id) DO UPDATE
           SET open_id = excluded.open_id, name = coalesce(excluded.name, people.name), seen_at = excluded.seen_at`,
      )
      .run(p.appId, p.unionId, p.openId, p.name, now),
  );
}

/** The person with this union_id, as this bot last saw them; undefined if never. */
export function personOf(db: Db, appId: string, unionId: string): PersonRow | undefined {
  const row = db
    .prepare<[string, string], PersonRaw>(
      'SELECT app_id, union_id, open_id, name, seen_at FROM people WHERE app_id = ? AND union_id = ?',
    )
    .get(appId, unionId);
  return row === undefined
    ? undefined
    : { appId: row.app_id, unionId: row.union_id, openId: row.open_id, name: row.name, seenAt: row.seen_at };
}

/**
 * The person this bot last saw with this open_id; undefined if never (wake spec
 * §3.2): how the terminal finds the owner's union_id, the principal a wake set
 * from it runs as. An open_id is one person's for one app, so at most one row
 * holds it; should two, the one seen last is taken.
 */
export function personByOpenId(db: Db, appId: string, openId: string): PersonRow | undefined {
  const row = db
    .prepare<[string, string], PersonRaw>(
      'SELECT app_id, union_id, open_id, name, seen_at FROM people WHERE app_id = ? AND open_id = ? ORDER BY seen_at DESC LIMIT 1',
    )
    .get(appId, openId);
  return row === undefined
    ? undefined
    : { appId: row.app_id, unionId: row.union_id, openId: row.open_id, name: row.name, seenAt: row.seen_at };
}

/**
 * Every person this bot has seen (kanban spec §22.2), for `mt kanban people`:
 * by the name Lark last gave, then by union_id, those with no name last.
 */
export function peopleOf(db: Db, appId: string): PersonRow[] {
  return db
    .prepare<[string], PersonRaw>(
      `SELECT app_id, union_id, open_id, name, seen_at FROM people WHERE app_id = ?
        ORDER BY name IS NULL, name, union_id`,
    )
    .all(appId)
    .map((row) => ({ appId: row.app_id, unionId: row.union_id, openId: row.open_id, name: row.name, seenAt: row.seen_at }));
}

/**
 * Every person this bot has seen with a name, their union_id and that name
 * (kanban spec §9.3): read once for a chat reply, which tells apart two of one name.
 */
export function namedPeopleOf(db: Db, appId: string): Array<{ unionId: string; name: string }> {
  return db
    .prepare<[string], { union_id: string; name: string }>('SELECT union_id, name FROM people WHERE app_id = ? AND name IS NOT NULL ORDER BY union_id')
    .all(appId)
    .map((r) => ({ unionId: r.union_id, name: r.name }));
}
