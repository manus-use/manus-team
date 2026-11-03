import type { Phase, RunKind } from './types.js';

/**
 * What a person sees, derived from the phase and two facts (spec §4.1).
 *
 * todo, ready and running are facts about other rows -- the parents, the runs.
 * Stored, each would have to be rewritten wherever those change, and a status
 * written from many places is how a task comes to say "running" with no run.
 * Derived, it cannot disagree with the rows it describes. Session status follows
 * the same rule (core/status.ts).
 */

export type DisplayStatus = 'todo' | 'ready' | 'running' | 'review' | 'reviewing' | 'blocked' | 'done' | 'archived';

export interface StatusFacts {
  phase: Phase;
  /**
   * Every parent is done or archived. True for a task with no parents. A task
   * held back by a parent shows todo, in `open` or in `review`.
   */
  parentsFinished: boolean;
  /**
   * The kind of the task's undecided run, if it has one. Undecided, not open: a
   * run that has reported is no longer working on the task, even while its
   * process finishes (spec §3.3).
   */
  undecidedRun: RunKind | undefined;
}

export function displayStatus(f: StatusFacts): DisplayStatus {
  switch (f.phase) {
    case 'open':
      if (f.undecidedRun !== undefined) return 'running';
      return f.parentsFinished ? 'ready' : 'todo';
    case 'review':
      // A reviewer's dependency block leaves the review waiting on new parents
      // (spec §5.4): todo, because nobody can act until they are done.
      if (f.undecidedRun === 'review') return 'reviewing';
      return f.parentsFinished ? 'review' : 'todo';
    case 'blocked':
    case 'done':
    case 'archived':
      return f.phase;
  }
}
