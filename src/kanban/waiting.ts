import { openAgentRunCount, openAgentRunCountAs, openAgentRunCountOn, openAgentRunIn } from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import type { Waiting } from './types.js';

export type { Waiting };

/**
 * The dispatcher skips a claimable agent task with these checks, and `task show`
 * says why with them, so the two cannot drift apart.
 */

/** The limits one agent claim is held to: the gateway's, its board's own, and its role's, when they have one. */
export interface ClaimLimits {
  /** `kanban.max_running`. */
  maxRunning: number;
  board: string;
  /** The board's own `max_running`; null for none. */
  boardMaxRunning: number | null;
  role: string;
  /** The role's own `max_running`, or `kanban.max_running_per_role`; undefined for none. */
  roleMaxRunning: number | undefined;
}

/**
 * Every limit an agent claim would pass that is reached, in the order the pass
 * checks them; with `first`, only the first, as the pass needs. Counted from the board, so a run opened earlier in the same
 * pass counts; a person's run is never counted (spec §6.3).
 */
export function limitsReached(db: Db, l: ClaimLimits, opts: { first?: boolean } = {}): Waiting[] {
  const reached: Waiting[] = [];
  // The pass needs only whether one is reached: it stops at the first, so a full gateway costs one count.
  const done = () => opts.first === true && reached.length > 0;
  if (openAgentRunCount(db) >= l.maxRunning) reached.push({ kind: 'gateway', maxRunning: l.maxRunning });
  if (done()) return reached;
  if (l.boardMaxRunning !== null && openAgentRunCountOn(db, l.board) >= l.boardMaxRunning) {
    reached.push({ kind: 'board', board: l.board, maxRunning: l.boardMaxRunning });
  }
  if (done()) return reached;
  if (l.roleMaxRunning !== undefined && openAgentRunCountAs(db, l.role) >= l.roleMaxRunning) {
    reached.push({ kind: 'role', role: l.role, maxRunning: l.roleMaxRunning });
  }
  return reached;
}

/** The workspace's open agent run, which an agent claim there is refused for: the claim's own query. */
export function workspaceBusy(db: Db, workspace: string): Waiting | undefined {
  const busy = openAgentRunIn(db, workspace);
  return busy === undefined ? undefined : { kind: 'workspace', workspace, taskId: busy.taskId, runId: busy.runId };
}
