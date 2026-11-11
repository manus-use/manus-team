/**
 * Where a session's work happens.
 *
 * One implementation today: each named workspace is a configured directory, shared
 * by every session that works in it. The interface exists anyway because the
 * alternative -- a git worktree per session -- changes when a directory comes into
 * existence and who is allowed to delete it, and retrofitting that means touching
 * every call site that assumed a path was just a string in the config.
 */

export interface Workspace {
  /** The workspace's name: its row in the workspaces table (spec §2.3). */
  id: string;
  kind: 'plain-dir' | 'git-worktree';
  /** Absolute and realpath-resolved. */
  cwd: string;
}

export interface WorkspaceProvider {
  readonly kind: Workspace['kind'];
  /** Whether a workspace of this name is configured. */
  has(workspaceId: string): boolean;
  /** The workspace a session recorded, by name. Throws for a name no longer configured. */
  acquire(sessionId: string, workspaceId: string): Promise<Workspace>;
  /** Idempotent, and must not throw. Nothing may depend on it having run. */
  release(sessionId: string): Promise<void>;
}

/**
 * A task's own directory (spec §18), by its `wt:` id, as it was recorded when it
 * was made; undefined for one not made.
 */
export type TaskDirLookup = (id: string) => { kind: Workspace['kind']; rootPath: string } | undefined;

/**
 * Each session works in the named workspace it records, and a workspace is one
 * configured directory -- or, for a kanban run's session, its task's own
 * directory (spec §18), looked up by the `wt:` id the session records.
 *
 * Concurrent sessions in the same workspace therefore share a working tree, which
 * is a real limitation and stated here rather than discovered: two agents editing
 * the same files will interleave their edits. It is the honest starting point --
 * the isolation story is worktrees, and pretending a plain directory provides any
 * is worse than the limitation.
 */
export class NamedWorkspaces implements WorkspaceProvider {
  readonly kind = 'plain-dir' as const;
  readonly #paths: ReadonlyMap<string, string>;
  readonly #taskDirs: TaskDirLookup | undefined;

  /**
   * @param paths Workspace name → real path, as `loadTeam` resolved and checked
   *   them at startup. Resolved once, there: a symlink swapped in later cannot
   *   redirect an agent with write access to a different tree.
   * @param taskDirs Tasks' own directories, as recorded when they were made, and
   *   never moved after; absent, none.
   */
  constructor(paths: ReadonlyMap<string, string>, taskDirs?: TaskDirLookup) {
    this.#paths = paths;
    this.#taskDirs = taskDirs;
  }

  has(workspaceId: string): boolean {
    return this.#paths.has(workspaceId) || this.#taskDirs?.(workspaceId) !== undefined;
  }

  async acquire(_sessionId: string, workspaceId: string): Promise<Workspace> {
    const cwd = this.#paths.get(workspaceId);
    if (cwd !== undefined) return { id: workspaceId, kind: this.kind, cwd };
    const own = this.#taskDirs?.(workspaceId);
    if (own === undefined) throw new Error(`workspace ${workspaceId} is not configured`);
    return { id: workspaceId, kind: own.kind, cwd: own.rootPath };
  }

  async release(_sessionId: string): Promise<void> {
    // Nothing to release: the directory is the user's and outlives every session.
    // Deleting it here would be the single most destructive thing this codebase
    // could do.
  }
}
