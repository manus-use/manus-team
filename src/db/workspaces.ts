import type { Db } from './open.js';
import { openDbReadOnly, txImmediate } from './open.js';

/**
 * The `workspaces` table: one row per workspace name, written the first time the
 * name is seen and never updated (spec §2.3).
 *
 * A name's directory never moves. Some agents look their sessions up by directory,
 * so pointing a known name somewhere else orphans every provider session opened in
 * it, and would silently move every task fixed to it. A new directory gets a new
 * name. This is architecture Appendix A's rule that a workspace is never relocated.
 *
 * Names removed from the config keep their rows: the name stays taken, so it can
 * never come back meaning a different directory.
 */

export type RegisterResult = { ok: true; added: string[] } | { error: string };

/**
 * @param workspaces Each name → its realpath, as `resolveWorkspaces` returns them.
 *   A declared path would be compared against a recorded realpath and read as moved.
 */
export function registerWorkspaces(
  db: Db,
  workspaces: ReadonlyMap<string, string>,
  now: number,
): RegisterResult {
  return txImmediate(db, (d) => {
    const find = d.prepare<[string], { root_path: string }>('SELECT root_path FROM workspaces WHERE id = ?');
    const entries = [...workspaces].sort(([a], [b]) => a.localeCompare(b));

    // Every name is checked before any is written, so a refused start changes nothing.
    const fresh: Array<[string, string]> = [];
    for (const [name, path] of entries) {
      const row = find.get(name);
      if (row === undefined) {
        fresh.push([name, path]);
      } else if (row.root_path !== path) {
        return { error: movedMessage(name, row.root_path, path) };
      }
    }

    const insert = d.prepare(
      "INSERT INTO workspaces (id, kind, root_path, created_at) VALUES (?, 'plain-dir', ?, ?)",
    );
    for (const [name, path] of fresh) insert.run(name, path, now);
    return { ok: true, added: fresh.map(([name]) => name) };
  });
}

/** The refusal for a name whose directory moved. Shared with `mt workspace add`. */
export function movedMessage(name: string, recorded: string, path: string): string {
  return (
    `workspace ${name} is ${recorded} (recorded when the name was first used), but the config ` +
    `now resolves to ${path}. A workspace's directory never moves: the sessions opened in it would be ` +
    'orphaned. Give the new directory a new name.'
  );
}

/** Each registered name → its recorded directory. Empty before the migrations create the table. */
export function registeredWorkspaces(db: Db): Map<string, string> {
  try {
    const rows = db.prepare<[], { id: string; root_path: string }>('SELECT id, root_path FROM workspaces').all();
    return new Map(rows.map((r) => [r.id, r.root_path]));
  } catch (err) {
    if (err instanceof Error && /no such table/.test(err.message)) return new Map();
    throw err;
  }
}

/** The registrations in the database at `dbPath`, read without disturbing a running gateway. */
export function registrationsAt(dbPath: string): Map<string, string> {
  const db = openDbReadOnly(dbPath);
  if (db === undefined) return new Map();
  try {
    return registeredWorkspaces(db);
  } finally {
    db.close();
  }
}
