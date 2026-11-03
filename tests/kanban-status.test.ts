import { describe, expect, it } from 'vitest';
import { displayStatus } from '../src/kanban/status.js';

describe('displayStatus', () => {
  it('shows an open task as todo until every parent is finished, then ready', () => {
    expect(displayStatus({ phase: 'open', parentsFinished: false, undecidedRun: undefined })).toBe('todo');
    expect(displayStatus({ phase: 'open', parentsFinished: true, undecidedRun: undefined })).toBe('ready');
  });

  it('shows an open task with an undecided run as running', () => {
    expect(displayStatus({ phase: 'open', parentsFinished: true, undecidedRun: 'work' })).toBe('running');
  });

  it('shows a task in review as waiting for a reviewer until a review run is undecided on it', () => {
    expect(displayStatus({ phase: 'review', parentsFinished: true, undecidedRun: undefined })).toBe('review');
    expect(displayStatus({ phase: 'review', parentsFinished: true, undecidedRun: 'review' })).toBe('reviewing');
  });

  it('shows a review waiting on a parent as todo, since nobody can act on it yet', () => {
    // A reviewer's dependency block adds parents to a task in review (spec §5.4).
    expect(displayStatus({ phase: 'review', parentsFinished: false, undecidedRun: undefined })).toBe('todo');
  });

  it('shows blocked, done and archived as they are, whatever else is true', () => {
    for (const phase of ['blocked', 'done', 'archived'] as const) {
      expect(displayStatus({ phase, parentsFinished: false, undecidedRun: 'work' })).toBe(phase);
      expect(displayStatus({ phase, parentsFinished: true, undecidedRun: undefined })).toBe(phase);
    }
  });
});
