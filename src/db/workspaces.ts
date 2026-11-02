import type { Db } from './open.js';
import { txImmediate } from './open.js';

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
        return {
          error:
            `workspace ${name} is ${row.root_path} (recorded when the name was first used), but the config ` +
            `now resolves to ${path}. A workspace's directory never moves: the sessions opened in it would be ` +
            'orphaned. Give the new directory a new name.',
        };
      }
    }

    const insert = d.prepare(
      "INSERT INTO workspaces (id, kind, root_path, created_at) VALUES (?, 'plain-dir', ?, ?)",
    );
    for (const [name, path] of fresh) insert.run(name, path, now);
    return { ok: true, added: fresh.map(([name]) => name) };
  });
}
