import { DEFAULT_WORKSPACE } from '../core/registry.js';

/**
 * Which workspace a task works in, decided at a claim while it is still null
 * (spec §2.3). Pure: the claim gathers the facts inside its transaction.
 *
 * The rules, first match wins:
 * 1. the task's own workspace;
 * 2. the assignee role's, if the role sets one explicitly;
 * 3. its parents' -- or, with no parents, the task it was created from -- if
 *    those with a fixed workspace all share one;
 * 4. its board's workspace, if the board names one (spec §16); else `default`.
 *
 * When the parents disagree, rule 4 is not applied either: `default` would be the
 * same guess with a different name. The caller decides what that means -- an
 * agent task is unassignable, a person's is claimed with its workspace null.
 */

export interface WorkspaceFacts {
  own: string | null;
  /** Undefined for a person, and for a role that names no workspace. */
  roleWorkspace: string | undefined;
  /**
   * The parents' workspaces, or the creating task's when there are no parents.
   * Null for one never fixed -- an archived parent nobody claimed -- which is ignored.
   */
  upstream: readonly (string | null)[];
  /** The workspace of the task's board, if it names one: rule 4 in place of `default`. */
  boardWorkspace?: string | null;
}

export type WorkspaceResolution = { workspace: string } | { conflict: readonly string[] };

export function resolveTaskWorkspace(f: WorkspaceFacts): WorkspaceResolution {
  if (f.own !== null) return { workspace: f.own };
  if (f.roleWorkspace !== undefined) return { workspace: f.roleWorkspace };
  const fixed = [...new Set(f.upstream.filter((w): w is string => w !== null))].sort();
  const [only] = fixed;
  if (fixed.length === 1 && only !== undefined) return { workspace: only };
  if (fixed.length > 1) return { conflict: fixed };
  return { workspace: f.boardWorkspace ?? DEFAULT_WORKSPACE };
}
