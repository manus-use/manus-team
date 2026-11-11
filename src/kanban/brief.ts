import type { Db } from '../db/open.js';
import { worktreeOf } from '../db/workspaces.js';
import {
  changesAsked,
  childrenOf,
  commentsOf,
  gatesOf,
  getTask,
  parentsInLinkOrder,
  lastGateRun,
  latestCompletion,
  latestReviewRequest,
  parentsOf,
  runsOf,
} from '../db/kanban-read.js';
import type { Attempt, OwnDirectory, ParentHandoff, RunBrief } from './prompt.js';
import type { Claimed } from './service.js';
import { toolCallsOf } from './session-log.js';
import { ENDED_OUTCOMES, type RunRow } from './types.js';

/**
 * Gather what a run's prompt is composed from (spec §7.1), as the board holds it
 * when the run is claimed: each parent's latest handoff, every earlier attempt,
 * the comment thread and the children; the task's gates and their last run; and
 * for a review the handoff it reviews, for a rework the reviewer's reason and the
 * handoff it revises (spec §5.3).
 */

/**
 * A run that ended without a report: failed, crashed, timed out, throttled,
 * interrupted, or a protocol violation. A retry is told the tool calls it made,
 * from its own session's log, so it knows what it is retrying after (spec §8.3).
 */
export function endedUnreported(run: RunRow): boolean {
  return run.outcome !== null && (ENDED_OUTCOMES as readonly string[]).includes(run.outcome);
}

/**
 * `native`: the run's role was rendered as a native agent package, so its prompt leaves role.md and the skills out.
 * `nameOf`: a person's name as the gateway last saw it, for a person reviewer the prompt names.
 */
export function briefFor(
  db: Db,
  c: Claimed,
  opts: { native?: boolean; nameOf?: (principal: string) => string | undefined } = {},
): RunBrief {
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
  const last = lastGateRun(db, taskId);
  const review = c.run.kind === 'review' ? latestReviewRequest(db, taskId) : undefined;
  const changes = c.run.kind === 'work' ? changesAsked(db, taskId) : undefined;
  const reviewer = c.task.reviewer;
  const reviewerName = reviewer?.kind === 'human' ? opts.nameOf?.(reviewer.name) : undefined;
  const workdir = ownDirectory(db, c.task);
  return {
    kind: c.run.kind,
    roleMd: c.roleMd,
    skills: c.role?.skills ?? [],
    ...(opts.native === true ? { native: true } : {}),
    task: c.task,
    parents,
    attempts,
    // Only comments that may steer: a talk-tier comment is for people (spec §9.1).
    comments: commentsOf(db, taskId, { steering: true }),
    children: childrenOf(db, taskId),
    gates: gatesOf(db, taskId),
    ...(last === undefined ? {} : { lastGateRun: last }),
    ...(review === undefined ? {} : { review }),
    ...(changes === undefined ? {} : { rework: { ...changes, handoff: latestReviewRequest(db, taskId) } }),
    ...(reviewerName === undefined ? {} : { reviewerName }),
    ...(workdir === undefined ? {} : { workdir }),
  };
}

/**
 * The task's own directory (spec §18), if it has one, and those of the tasks it
 * follows -- its parents in link order, or with none the task that created it --
 * that have one, an archived one marked as abandoned; undefined when there is
 * neither. A task in a shared directory is still told where its parents' are.
 * A folder's task is told the workspace's own folder too, for shared inputs.
 */
function ownDirectory(db: Db, task: Claimed['task']): OwnDirectory | undefined {
  const own = task.worktree === null ? undefined : worktreeOf(db, task.worktree);
  const parents = parentsInLinkOrder(db, task.taskId);
  const from = parents.length === 0 && task.createdFromTask !== null ? getTask(db, task.createdFromTask) : undefined;
  const upstream = (parents.length > 0 ? parents : from === undefined ? [] : [from]).flatMap((p) => {
    const dir = p.worktree === null ? undefined : worktreeOf(db, p.worktree);
    return dir === undefined ? [] : [{ taskId: p.taskId, path: dir.rootPath, branch: dir.branch, abandoned: p.phase === 'archived' }];
  });
  if (own === undefined && upstream.length === 0) return undefined;
  // A folder's task also reads the workspace's own folder, for inputs its tasks share; a worktree has the repository's files.
  const shared = own?.kind === 'plain-dir' ? { workspacePath: own.repoRoot } : {};
  return { path: own?.rootPath ?? null, branch: own?.branch ?? null, ...shared, upstream };
}
