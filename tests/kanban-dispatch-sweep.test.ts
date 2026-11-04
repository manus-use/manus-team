import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventsOf, getTask, runsOf } from '../src/db/kanban-read.js';
import { lastSeq, readEvents } from '../src/db/events.js';
import { getSession } from '../src/db/sessions.js';
import { ALICE } from './helpers/kanban.js';
import { completes, dispatchHarness, holds, reportComplete, until, type DispatchHarness } from './helpers/dispatch.js';

const open: DispatchHarness[] = [];

function harness(...args: Parameters<typeof dispatchHarness>): DispatchHarness {
  const h = dispatchHarness(...args);
  open.push(h);
  return h;
}

afterEach(() => {
  vi.useRealTimers();
  while (open.length > 0) open.pop()?.close();
});

const MINUTE = 60_000;

describe('Dispatcher: the runtime limit (spec §8.5)', () => {
  it('ends a run past its limit timed_out, recorded before its turn is cancelled, so the classifier never sees it', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web', maxRuntimeS: 60 });
    const implementer = h.driver('implementer');
    let release: (() => void) | undefined;
    const cancelled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    implementer.scripts.push(async (ctl) => {
      started = true;
      await cancelled;
      // What a provider error at the moment of cancelling looks like: the classifier would say terminal_provider.
      ctl.emit({ kind: 'error', message: 'Error: 401 Unauthorized', retryable: false });
      ctl.end('failed');
    });
    completes(h, implementer);

    h.dispatcher.pass();
    await until(() => started, 'the run to start');
    h.clock.advance(59_999);
    h.dispatcher.sweep();
    expect(runsOf(h.t.db, task.taskId)[0]?.outcome).toBeNull();

    h.clock.advance(1);
    h.dispatcher.sweep();
    const [run] = runsOf(h.t.db, task.taskId);
    expect(run).toMatchObject({ outcome: 'timed_out', error: 'the run passed its limit of 60 s', endedAt: null });
    expect(implementer.runtimes[0]?.cancels).toBe(1);

    // A second sweep does not cancel again.
    h.dispatcher.sweep();
    expect(implementer.runtimes[0]?.cancels).toBe(1);

    release?.();
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, task.taskId).map((r) => r.outcome)).toEqual(['timed_out', 'completed']);
    expect(getTask(h.t.db, task.taskId)?.phase).toBe('done');
  });

  it('cancels a run whose agent was still starting at the limit, at the first sweep after it has started', async () => {
    const h = harness({ settings: { defaultMaxRuntimeS: 60 } });
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
    h.clock.advance(60_000);
    h.dispatcher.sweep();
    // Recorded at once; there is no turn to cancel yet.
    expect(runsOf(h.t.db, task.taskId)[0]?.outcome).toBe('timed_out');

    release?.();
    await until(() => held.started, 'the agent to start');
    expect(implementer.runtimes[0]?.cancels).toBe(0);
    h.dispatcher.sweep();
    expect(implementer.runtimes[0]?.cancels).toBe(1);

    implementer.onStart = undefined;
    held.end('cancelled');
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, task.taskId)[0]?.endedAt).not.toBeNull();
  });

  it('releases the session of a turn that ignores its cancel at the next sweep, and closes the run', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web', maxRuntimeS: 60, failureLimit: 1 });
    h.clock.advance(1);
    const next = h.create({ title: 'next', workspace: 'web' });
    const implementer = h.driver('implementer');
    // An agent that never acts on a cancel: its turn ends only when the test says.
    const stubborn = holds(implementer);
    completes(h, implementer);

    h.dispatcher.pass();
    await until(() => stubborn.started, 'the run to start');
    h.clock.advance(60_000);
    h.dispatcher.sweep();
    expect(implementer.runtimes[0]?.cancels).toBe(1);
    expect(runsOf(h.t.db, task.taskId)[0]?.endedAt).toBeNull();

    h.dispatcher.sweep();
    await until(() => runsOf(h.t.db, task.taskId)[0]?.endedAt !== null, 'the run to close');
    const [run] = runsOf(h.t.db, task.taskId);
    expect(run?.outcome).toBe('timed_out');
    expect(implementer.runtimes[0]?.closes).toBe(1);
    expect(getSession(h.t.db, run?.sessionId ?? '')?.state).toBe('archived');

    // Its workspace is free again.
    await until(() => runsOf(h.t.db, next.taskId)[0]?.endedAt !== null, 'the next task to run');
    expect(runsOf(h.t.db, next.taskId).map((r) => r.outcome)).toEqual(['completed']);
    stubborn.end('completed');
    await h.dispatcher.idle();
  });

  it('closes a released run once when closing its agent ends the turn', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web', maxRuntimeS: 60 });
    const implementer = h.driver('implementer');
    const stubborn = holds(implementer);
    // What a real process does: it ignores the cancel, but dies when closed, and its turn ends cancelled.
    implementer.onClose = () => stubborn.end('cancelled');

    h.dispatcher.pass();
    await until(() => stubborn.started, 'the run to start');
    h.clock.advance(60_000);
    h.dispatcher.sweep();
    h.dispatcher.sweep();
    await h.dispatcher.idle();

    const [run] = runsOf(h.t.db, task.taskId);
    expect(run).toMatchObject({ outcome: 'timed_out' });
    expect(run?.endedAt).not.toBeNull();
    const sessionId = run?.sessionId ?? '';
    const archived = readEvents(h.t.db, sessionId, 0, lastSeq(h.t.db, sessionId)).filter(
      (e) => e.type === 'session_state_changed' && (e.payload as { state?: string }).state === 'archived',
    );
    expect(archived).toHaveLength(1);
    expect(h.notes.filter((n) => n.includes(`run ${run?.runId ?? ''} closed`))).toHaveLength(1);
    expect(h.notes.filter((n) => n.includes('already_closed'))).toEqual([]);
    expect(h.dispatcher.pinned(sessionId)).toBe(false);
  });

  it('keeps the outcome of a run that has reported, and only closes it', async () => {
    const h = harness({ settings: { defaultMaxRuntimeS: 120 } });
    const task = h.create({ workspace: 'web' });
    const held = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started, 'the run to start');
    await reportComplete(h, h.driver('implementer'));

    h.clock.advance(120 * 1000);
    h.dispatcher.sweep();
    expect(h.driver('implementer').runtimes[0]?.cancels).toBe(1);
    held.end('cancelled');
    await h.dispatcher.idle();

    const [run] = runsOf(h.t.db, task.taskId);
    expect(run?.outcome).toBe('completed');
    expect(run?.endedAt).not.toBeNull();
    expect(getTask(h.t.db, task.taskId)).toMatchObject({ phase: 'done', consecutiveFailures: 0 });
  });
});

describe('Dispatcher: stranded tasks (spec §4.2)', () => {
  /** A task whose parents finished in different workspaces: nobody may guess which to use. */
  async function unclaimable(h: DispatchHarness): Promise<string> {
    const web = h.create({ title: 'web half', workspace: 'web' });
    const api = h.create({ title: 'api half', workspace: 'api' });
    for (const parent of [web, api]) {
      expect((await h.service.complete(parent.taskId, { kind: 'person', principal: ALICE }, { summary: 'done' })).ok).toBe(true);
    }
    return h.create({ title: 'join', parents: [web.taskId, api.taskId] }).taskId;
  }

  function stranded(h: DispatchHarness, taskId: string): unknown[] {
    return eventsOf(h.t.db, taskId)
      .filter((e) => e.kind === 'stranded')
      .map((e) => e.payload);
  }

  it('reports a task nobody can be given once it has waited strandedAfterS, and only once', async () => {
    const h = harness();
    const taskId = await unclaimable(h);

    h.dispatcher.sweep();
    h.clock.advance(30 * MINUTE - 1);
    h.dispatcher.sweep();
    expect(stranded(h, taskId)).toEqual([]);

    h.clock.advance(1);
    h.dispatcher.sweep();
    expect(stranded(h, taskId)).toEqual([
      { reason: expect.stringContaining('parents are in different workspaces') },
    ]);
    expect(getTask(h.t.db, taskId)?.strandedNotifiedAt).toBe(h.clock.now());

    h.clock.advance(60 * MINUTE);
    h.dispatcher.sweep();
    expect(stranded(h, taskId)).toHaveLength(1);
  });

  it('never reports a task that is only waiting its turn behind a busy workspace', async () => {
    const h = harness();
    h.create({ title: 'running', workspace: 'web' });
    const queued = h.create({ title: 'queued', workspace: 'web' });
    const held = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started, 'the run to start');

    h.clock.advance(31 * MINUTE);
    h.dispatcher.sweep();
    expect(stranded(h, queued.taskId)).toEqual([]);
    expect(eventsOf(h.t.db, queued.taskId).map((e) => e.kind)).toEqual(['created']);

    held.end('completed', () => reportComplete(h, h.driver('implementer')));
    completes(h, h.driver('implementer'));
    await h.dispatcher.idle();
  });
});

describe('Dispatcher: start and stop', () => {
  it('passes at once, sweeps every sweepIntervalS, and does nothing once stopped', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const h = harness({ settings: { sweepIntervalS: 60 } });
    const first = h.create({ title: 'first', workspace: 'web' });
    const implementer = h.driver('implementer');
    completes(h, implementer);
    completes(h, implementer);

    h.dispatcher.start();
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, first.taskId).map((r) => r.outcome)).toEqual(['completed']);

    // A task that no event announced is found by the next sweep.
    const second = h.create({ title: 'second', workspace: 'web' });
    vi.advanceTimersByTime(60_000);
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, second.taskId).map((r) => r.outcome)).toEqual(['completed']);

    h.dispatcher.stop();
    const third = h.create({ title: 'third', workspace: 'web' });
    vi.advanceTimersByTime(120_000);
    h.dispatcher.pass();
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, third.taskId)).toEqual([]);
  });
});

describe('Dispatcher: a run timed out while its agent was being built', () => {
  it('sends no prompt to a run the sweep ended while its actor was built, and closes it', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web', maxRuntimeS: 60 });
    const actorFor = h.registry.actorFor.bind(h.registry);
    vi.spyOn(h.registry, 'actorFor').mockImplementation(async (sessionId, key) => {
      h.clock.advance(MINUTE);
      h.dispatcher.sweep();
      return actorFor(sessionId, key);
    });

    h.dispatcher.pass();
    await h.dispatcher.idle();

    const [run] = runsOf(h.t.db, task.taskId);
    expect(run?.outcome).toBe('timed_out');
    expect(run?.endedAt).not.toBeNull();
    expect(h.driver('implementer').starts).toEqual([]);
    expect(h.dispatcher.pinned(run?.sessionId ?? '')).toBe(false);
    expect(getSession(h.t.db, run?.sessionId ?? '')?.state).toBe('archived');
  });
});

describe('Dispatcher: idle, bounded', () => {
  it('gives up waiting after the bound on a start that never returns, and says so', async () => {
    const h = harness();
    h.create({ workspace: 'web' });
    h.driver('implementer').onStart = () => new Promise<void>(() => undefined);

    h.dispatcher.pass();
    await expect(h.dispatcher.idle(20)).resolves.toBe(false);
  });

  it('says it drained when the work ends within the bound', async () => {
    const h = harness();
    h.create({ workspace: 'web' });
    completes(h, h.driver('implementer'));

    h.dispatcher.pass();
    await expect(h.dispatcher.idle(5_000)).resolves.toBe(true);
  });
});
