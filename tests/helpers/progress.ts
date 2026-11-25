import type { Db } from '../../src/db/open.js';
import { closeRun as boardCloseRun } from '../../src/db/kanban.js';
import type { RunOutcome } from '../../src/kanban/types.js';
import { NOW } from './kanban.js';

/** Building blocks for the progress cards' tests (progress cards spec §14). */

/**
 * Decide a run as a test needs it, with no event and no change to its task: a
 * shortcut past the report or the ending that would decide it, for a test of
 * what the progress cards read of a decided run.
 */
export function decideRunForTest(db: Db, runId: string, outcome: RunOutcome): void {
  db.prepare('UPDATE kanban_runs SET outcome = ? WHERE run_id = ? AND outcome IS NULL').run(outcome, runId);
}

/** Close a decided run, as the dispatcher does once its turn has ended. */
export function closeRun(db: Db, runId: string, now = NOW): void {
  const r = boardCloseRun(db, runId, now);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
}
