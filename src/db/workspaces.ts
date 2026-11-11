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

/** Each registered name → its recorded directory; not a task's own directory. Empty before the migrations create the table. */
export function registeredWorkspaces(db: Db): Map<string, string> {
  try {
    const rows = db
      .prepare<[], { id: string; root_path: string }>(`SELECT id, root_path FROM workspaces WHERE id NOT LIKE 'wt:%'`)
      .all();
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

/**
 * A task's own directory, in an isolated workspace (spec §18): a git worktree on
 * its own branch, or a folder of its own. Its id is `wt:<task_id>`, which no
 * configured name can be, since a name has no `:`.
 */
export interface TaskDirectory {
  id: string;
  kind: 'git-worktree' | 'plain-dir';
  /** Absolute and real; it never moves (architecture Appendix A). */
  rootPath: string;
  /** The workspace's own directory: the repository a worktree belongs to, or the workspace a folder was made for. */
  repoRoot: string;
  /** The worktree's branch; null for a folder. */
  branch: string | null;
}

/** A task's directory id: the task's own, kind-prefixed (spec §2.3). */
export function worktreeId(taskId: string): string {
  return `wt:${taskId}`;
}

export function isWorktreeId(id: string): boolean {
  return id.startsWith('wt:');
}

/**
 * Record a task's directory once it is made, before any session works in it.
 * Written once: the same directory again changes nothing, and another for the
 * same id is refused, as a configured name's is (spec §2.3).
 */
export function registerWorktree(db: Db, dir: TaskDirectory, now: number): RegisterResult {
  if (!isWorktreeId(dir.id)) return { error: `${dir.id} is not a task's directory id` };
  return txImmediate(db, (d) => {
    const row = d.prepare<[string], { root_path: string }>('SELECT root_path FROM workspaces WHERE id = ?').get(dir.id);
    if (row !== undefined) {
      return row.root_path === dir.rootPath
        ? { ok: true, added: [] }
        : { error: `${dir.id} is ${row.root_path}, recorded when it was made, not ${dir.rootPath}` };
    }
    d.prepare('INSERT INTO workspaces (id, kind, root_path, repo_root, branch, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      dir.id,
      dir.kind,
      dir.rootPath,
      dir.repoRoot,
      dir.branch,
      now,
    );
    return { ok: true, added: [dir.id] };
  });
}

/** A task's directory as it was recorded when made; undefined before then. */
export function worktreeOf(db: Db, id: string): TaskDirectory | undefined {
  if (!isWorktreeId(id)) return undefined;
  const row = db
    .prepare<[string], { id: string; kind: string; root_path: string; repo_root: string | null; branch: string | null }>(
      'SELECT id, kind, root_path, repo_root, branch FROM workspaces WHERE id = ?',
    )
    .get(id);
  if (row === undefined) return undefined;
  return {
    id: row.id,
    kind: row.kind === 'git-worktree' ? 'git-worktree' : 'plain-dir',
    rootPath: row.root_path,
    repoRoot: row.repo_root ?? '',
    branch: row.branch,
  };
}
