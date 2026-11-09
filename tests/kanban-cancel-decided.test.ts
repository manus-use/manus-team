import { afterEach, describe, expect, it } from 'vitest';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import { dispatchHarness, holds, reportComplete, until, type DispatchHarness } from './helpers/dispatch.js';

/**
 * A run decided by a change the dispatcher was not told of (spec §2.6): an
 * operator's `mt kanban task stop`, assign or archive, made beside the gateway. Its
 * next pass, which the change's nudge asks for, cancels the turn.
 */

const ME = 'operator:alice';
const open: DispatchHarness[] = [];

function harness(): DispatchHarness {
  const h = dispatchHarness();
  open.push(h);
  return h;
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

describe('Dispatcher: a run decided elsewhere', () => {
  it('cancels, at the next pass, the turn of a run a stop decided, once, and closes it', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    const held = holds(implementer);
    h.dispatcher.pass();
    await until(() => held.started, 'the run to start');

    // As another process does it: through the board, and nothing told the dispatcher.
    expect(h.service.stop(task.taskId, ME).ok).toBe(true);
    expect(implementer.runtimes[0]?.cancels).toBe(0);
    h.dispatcher.pass();
    expect(implementer.runtimes[0]?.cancels).toBe(1);
    h.dispatcher.pass();
    expect(implementer.runtimes[0]?.cancels).toBe(1);

    held.end('cancelled');
    await h.dispatcher.idle();
    const [run] = runsOf(h.t.db, task.taskId);
    expect(run).toMatchObject({ outcome: 'cancelled' });
    expect(run?.endedAt).not.toBeNull();
    expect(getTask(h.t.db, task.taskId)?.phase).toBe('blocked');
  });

  it('goes on with the pass when cancelling a run fails, and notes it', async () => {
    const h = harness();
    const stopped = h.create({ workspace: 'web' });
    const held = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started, 'the run to start');
    expect(h.service.stop(stopped.taskId, ME).ok).toBe(true);
    const next = h.create({ workspace: 'api' });
    const started = holds(h.driver('implementer'));
    // The registry fails as the cancel asks it for the stopped run's actor.
    const liveActor = h.registry.liveActor.bind(h.registry);
    h.registry.liveActor = () => {
      throw new Error('the registry failed');
    };
    expect(() => h.dispatcher.pass()).not.toThrow();
    h.registry.liveActor = liveActor;
    const [run] = runsOf(h.t.db, stopped.taskId);
    expect(h.notes).toContain(`kanban: cancelling run ${run?.runId} failed: the registry failed`);
    await until(() => started.started, 'the next task to start');
    expect(runsOf(h.t.db, next.taskId)).toHaveLength(1);
    held.end('cancelled');
    started.end('completed');
    await h.dispatcher.idle();
  });

  it('leaves alone the turn of a run that decided itself, by its report', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    const held = holds(implementer);
    h.dispatcher.pass();
    await until(() => held.started, 'the run to start');

    await reportComplete(h, implementer);
    h.dispatcher.pass();
    expect(implementer.runtimes[0]?.cancels).toBe(0);
    held.end('completed');
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, task.taskId)[0]).toMatchObject({ outcome: 'completed' });
  });
});
