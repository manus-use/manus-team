import type { Db } from '../db/open.js';
import { childrenOf, commentsOf, latestCompletion, parentsOf, runsOf } from '../db/kanban-read.js';
import type { Attempt, ParentHandoff, RunBrief } from './prompt.js';
import type { Claimed } from './service.js';
import { toolCallsOf } from './session-log.js';
import { ENDED_OUTCOMES, type RunRow } from './types.js';

/**
 * Gather what a run's prompt is composed from (spec §7.1), as the board holds it
 * when the run is claimed: each parent's latest handoff, every earlier attempt,
 * the comment thread and the children.
 */

/**
 * A run that ended without a report: failed, crashed, timed out, throttled,
 * interrupted, or a protocol violation. A retry is told the tool calls it made,
 * from its own session's log, so it knows what it is retrying after (spec §8.3).
 */
export function endedUnreported(run: RunRow): boolean {
  return run.outcome !== null && (ENDED_OUTCOMES as readonly string[]).includes(run.outcome);
}

/** `native`: the run's role was rendered as a native agent package, so its prompt leaves role.md and the skills out. */
export function briefFor(db: Db, c: Claimed, opts: { native?: boolean } = {}): RunBrief {
  const taskId = c.task.taskId;
  const parents: ParentHandoff[] = parentsOf(db, taskId).map((task) => {
    const done = latestCompletion(db, task.taskId);
    return { task, summary: done?.summary ?? null, metadata: done?.metadata ?? null };
  });
  const attempts: Attempt[] = runsOf(db, taskId)
    .filter((run) => run.runId !== c.run.runId)
    .map((run) => ({
      run,
      toolCalls: endedUnreported(run) && run.sessionId !== null ? toolCallsOf(db, run.sessionId) : undefined,
    }));
  return {
    kind: c.run.kind,
    roleMd: c.roleMd,
    skills: c.role?.skills ?? [],
    ...(opts.native === true ? { native: true } : {}),
    task: c.task,
    parents,
    attempts,
    comments: commentsOf(db, taskId),
    children: childrenOf(db, taskId),
  };
}
