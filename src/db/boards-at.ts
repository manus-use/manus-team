import { openDbReadOnly } from './open.js';

/** How long a read of the boards waits on a lock (workflows spec §19.4), as `openDb`'s busy timeout. */
export const BOARDS_BUSY_TIMEOUT_MS = 1000;

/** The boards at a path, by name, each with whether it is archived; or why they could not be read. */
export type BoardsAt = { ok: true; boards: Map<string, boolean> } | { ok: false; why: string };

/**
 * The boards of the database at `dbPath`, read-only (workflows spec §19.4), for the
 * startup and the terminal's preview, which have no database open of their own.
 * No database, or one from before migration 006, told by its `user_version`, has
 * what the migration makes, `default` alone. A database that cannot be read
 * answers why, so the caller says so and goes on.
 */
export function boardsAt(dbPath: string): BoardsAt {
  const only = (): BoardsAt => ({ ok: true, boards: new Map([['default', false]]) });
  try {
    const db = openDbReadOnly(dbPath, BOARDS_BUSY_TIMEOUT_MS);
    if (db === undefined) return only();
    try {
      if (Number(db.pragma('user_version', { simple: true })) < 6) return only();
      const rows = db.prepare<[], { name: string; archived_at: number | null }>('SELECT name, archived_at FROM kanban_boards').all();
      return { ok: true, boards: new Map(rows.map((r) => [r.name, r.archived_at !== null])) };
    } finally {
      db.close();
    }
  } catch (err) {
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  }
}
