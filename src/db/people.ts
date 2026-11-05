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
