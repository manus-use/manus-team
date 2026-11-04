import { afterEach, describe, expect, it } from 'vitest';
import { runsOf } from '../src/db/kanban-read.js';
import { getSession } from '../src/db/sessions.js';
import { completes, dispatchHarness, holds, until, type DispatchHarness } from './helpers/dispatch.js';
import { ALICE } from './helpers/kanban.js';

/** Cancelling a run the board decided without it (spec §5.1): what plan D's assign, stop and archive call. */

const open: DispatchHarness[] = [];

function harness(): DispatchHarness {
  const h = dispatchHarness();
  open.push(h);
  return h;
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

describe('Dispatcher: cancelling a superseded run', () => {
  it('cancels the turn of a run a reassignment superseded, closes it with that outcome, and frees its workspace', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    const held = holds(implementer);
    // What a process does when cancelled: its turn ends.
    completes(h, h.driver('reviewer'));

    h.dispatcher.pass();
    await until(() => held.started, 'the run to start');
    const [run] = runsOf(h.t.db, task.taskId);
    expect(h.service.assign(task.taskId, 'reviewer', ALICE).ok).toBe(true);
    expect(h.dispatcher.cancel(run?.runId ?? '')).toBe(true);
    expect(implementer.runtimes[0]?.cancels).toBe(1);
    // Once is enough.
    expect(h.dispatcher.cancel(run?.runId ?? '')).toBe(false);
    held.end('cancelled');
    await h.dispatcher.idle();

    const runs = runsOf(h.t.db, task.taskId);
    expect(runs.map((r) => r.outcome)).toEqual(['superseded', 'completed']);
    expect(runs[0]?.endedAt).not.toBeNull();
    expect(getSession(h.t.db, run?.sessionId ?? '')?.state).toBe('archived');
    expect(runs[1]?.assignee).toEqual({ kind: 'role', name: 'reviewer' });
    expect(h.notes).toContain(`kanban: run ${run?.runId} was decided superseded by the board; cancelling its turn`);
  });

  it('does not cancel an undecided run, or a run it did not start', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    const held = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started, 'the run to start');
    const [run] = runsOf(h.t.db, task.taskId);
    expect(h.dispatcher.cancel(run?.runId ?? '')).toBe(false);
    expect(h.dispatcher.cancel('r_nobody')).toBe(false);
    expect(h.driver('implementer').runtimes[0]?.cancels).toBe(0);
    held.end('completed');
    await h.dispatcher.idle();
  });

  it('delivers a cancel made while the agent was still starting at the next sweep after it has started', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    let release: (() => void) | undefined;
    const slowStart = new Promise<void>((resolve) => {
      release = resolve;
    });
    implementer.onStart = () => slowStart;
    const held = holds(implementer);

    h.dispatcher.pass();
    await until(() => implementer.starts.length === 1, 'the agent to be starting');
    const [run] = runsOf(h.t.db, task.taskId);
    expect(h.service.archive(task.taskId, ALICE).ok).toBe(true);
    // No turn to stop yet.
    expect(h.dispatcher.cancel(run?.runId ?? '')).toBe(false);

    release?.();
    await until(() => held.started, 'the agent to start');
    expect(implementer.runtimes[0]?.cancels).toBe(0);
    h.dispatcher.sweep();
    expect(implementer.runtimes[0]?.cancels).toBe(1);
    // Once is enough, and the turn gets its grace from the cancel.
    h.dispatcher.sweep();
    expect(implementer.runtimes[0]?.cancels).toBe(1);
    expect(implementer.runtimes[0]?.closes).toBe(0);

    implementer.onStart = undefined;
    held.end('cancelled');
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, task.taskId)[0]).toMatchObject({ outcome: 'superseded' });
    expect(runsOf(h.t.db, task.taskId)[0]?.endedAt).not.toBeNull();
  });

  it('releases a superseded run whose turn ignores the cancel once a sweep interval has passed', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    const stubborn = holds(implementer);
    h.dispatcher.pass();
    await until(() => stubborn.started, 'the run to start');
    const [run] = runsOf(h.t.db, task.taskId);
    expect(h.service.archive(task.taskId, ALICE).ok).toBe(true);
    expect(h.dispatcher.cancel(run?.runId ?? '')).toBe(true);

    // A sweep straight after the cancel gives the turn its grace.
    h.dispatcher.sweep();
    expect(implementer.runtimes[0]?.closes).toBe(0);
    expect(runsOf(h.t.db, task.taskId)[0]?.endedAt).toBeNull();
    h.clock.advance(60_000);
    h.dispatcher.sweep();
    await until(() => runsOf(h.t.db, task.taskId)[0]?.endedAt !== null, 'the run to close');
    expect(runsOf(h.t.db, task.taskId)[0]?.outcome).toBe('superseded');
    expect(implementer.runtimes[0]?.closes).toBe(1);
    stubborn.end('completed');
    await h.dispatcher.idle();
  });
});
