import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindingsForSession } from '../src/db/bindings.js';
import { getRun, getTask, openRunOf, openRuns, runsOf } from '../src/db/kanban-read.js';
import { getSession, setExecution } from '../src/db/sessions.js';
import { KANBAN_OWNER, runKey } from '../src/kanban/dispatcher.js';
import { ALICE, claimed, newTask } from './helpers/kanban.js';
import type { TurnControl } from './helpers/driver.js';
import {
  APP,
  completes,
  dispatchHarness,
  reportComplete,
  role,
  until,
  type DispatchHarness,
} from './helpers/dispatch.js';

const open: DispatchHarness[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

/**
 * The gateway before the restart: a run whose agent made a tool call and is
 * still working when the process dies. Its turn never ends here.
 */
async function before(opts: Parameters<typeof dispatchHarness>[0] = {}, report = false) {
  const h = dispatchHarness(opts);
  open.push(h);
  const task = h.create({ title: 'Build', workspace: 'web' });
  const implementer = h.driver('implementer');
  let running = false;
  implementer.scripts.push(async (ctl: TurnControl) => {
    ctl.emit({ kind: 'tool-call', toolCallId: 'c1', title: 'edit', status: 'completed', raw: {} });
    if (report) await reportComplete(h, implementer);
    running = true;
    await new Promise<void>(() => undefined);
  });
  h.dispatcher.pass();
  await until(() => running, 'the run to be working');
  const run = runsOf(h.t.db, task.taskId)[0];
  if (run?.sessionId === null || run === undefined) throw new Error('no run');
  // Its handle names the boot that died, as a real restart would find it.
  setExecution(h.t.db, run.sessionId, 'previous-boot:0', 'implementer');
  // The old process is gone: nothing it holds runs again.
  h.dispatcher.stop();
  return { task, run, sessionId: run.sessionId };
}

/** The gateway after the restart, on the same database. */
function after(h0: DispatchHarness, opts: Parameters<typeof dispatchHarness>[0] = {}): DispatchHarness {
  return dispatchHarness({ ...opts, t: h0.t, clock: h0.clock });
}

describe('Dispatcher: a gateway restart (spec §8.4)', () => {
  it('ends an undecided run interrupted, uncounted, archives its session, and tells the retry', async () => {
    const { task, run, sessionId } = await before();
    const h = after(open[0] as DispatchHarness);

    const findings = h.registry.reconcileBoot();
    expect(findings.find((f) => f.sessionId === sessionId)?.bindings).toEqual([
      runKey(APP, { taskId: task.taskId, runId: run.runId }),
    ]);
    await h.dispatcher.boot();

    expect(runsOf(h.t.db, task.taskId)[0]).toMatchObject({
      outcome: 'interrupted',
      error: 'the gateway restarted during the run',
    });
    expect(openRunOf(h.t.db, task.taskId)).toBeUndefined();
    expect(getTask(h.t.db, task.taskId)).toMatchObject({ phase: 'open', consecutiveFailures: 0 });
    expect(getSession(h.t.db, sessionId)?.state).toBe('archived');
    expect(bindingsForSession(h.t.db, sessionId)).toEqual([]);

    const implementer = h.driver('implementer');
    completes(h, implementer);
    h.dispatcher.pass();
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, task.taskId).map((r) => r.outcome)).toEqual(['interrupted', 'completed']);
    expect(implementer.runtimes[0]?.prompts[0]?.text).toContain(
      '## Attempt 1 (work, implementer): interrupted\nError: the gateway restarted during the run\nTool calls:\n- edit (completed)',
    );
  });

  it('keeps the outcome of a run that had reported, and only closes it', async () => {
    const { task } = await before({}, true);
    const h = after(open[0] as DispatchHarness);
    h.registry.reconcileBoot();
    await h.dispatcher.boot();

    const [run] = runsOf(h.t.db, task.taskId);
    expect(run?.outcome).toBe('completed');
    expect(run?.endedAt).not.toBeNull();
    expect(getTask(h.t.db, task.taskId)?.phase).toBe('done');
  });

  it('holds an interrupted run that changed something for a person under if-no-side-effects', async () => {
    const opts = { roles: [role('implementer', {}, ['read'])] };
    const h0 = dispatchHarness(opts);
    open.push(h0);
    const task = h0.create({ workspace: 'web', retryOnCrash: 'if-no-side-effects' });
    const implementer = h0.driver('implementer');
    let running = false;
    implementer.scripts.push(async (ctl: TurnControl) => {
      ctl.emit({ kind: 'tool-call', toolCallId: 'c1', title: 'edit', status: 'completed', raw: {} });
      running = true;
      await new Promise<void>(() => undefined);
    });
    h0.dispatcher.pass();
    await until(() => running, 'the run to be working');
    h0.dispatcher.stop();

    const h = after(h0, opts);
    await h.dispatcher.boot();
    expect(getTask(h.t.db, task.taskId)).toMatchObject({ phase: 'blocked', blockKind: 'needs_input' });
  });

  it("leaves a person's run alone: it holds no process", async () => {
    const h0 = dispatchHarness();
    open.push(h0);
    const task = newTask(h0.t.db, { assignee: { kind: 'human', name: ALICE } });
    const run = claimed(h0.t.db, task.taskId);
    await h0.dispatcher.boot();
    expect(openRunOf(h0.t.db, task.taskId)?.runId).toBe(run.runId);
  });

  it("refuses to rebuild an open run's session without its environment, and ends the run interrupted", async () => {
    const { task, run, sessionId } = await before();
    const h = after(open[0] as DispatchHarness);

    await expect(h.registry.actorFor(sessionId, runKey(APP, run))).rejects.toThrow(
      `run ${run.runId} is being ended interrupted: its environment did not survive a restart`,
    );
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, task.taskId)[0]).toMatchObject({ outcome: 'interrupted' });
    expect(openRunOf(h.t.db, task.taskId)).toBeUndefined();
    expect(getSession(h.t.db, sessionId)?.state).toBe('archived');
    expect(h.driver('implementer').starts).toEqual([]);
  });
});

/** Two runs working when the process dies: in web and in api, as the implementer. */
async function beforeTwo(): Promise<DispatchHarness> {
  const h = dispatchHarness();
  open.push(h);
  h.create({ title: 'web', workspace: 'web' });
  h.create({ title: 'api', workspace: 'api' });
  const implementer = h.driver('implementer');
  let running = 0;
  for (let i = 0; i < 2; i += 1) {
    implementer.scripts.push(async () => {
      running += 1;
      await new Promise<void>(() => undefined);
    });
  }
  h.dispatcher.pass();
  await until(() => running === 2, 'both runs to be working');
  for (const run of openRuns(h.t.db)) setExecution(h.t.db, run.sessionId ?? '', 'previous-boot:0', 'implementer');
  h.dispatcher.stop();
  return h;
}

describe('Dispatcher: a restart, when something fails', () => {
  it("archives each run's session before it closes the run, as a run's own close does", async () => {
    const h0 = await beforeTwo();
    const h = after(h0);
    const archive = h.registry.archive.bind(h.registry);
    const openWhenArchived: boolean[] = [];
    vi.spyOn(h.registry, 'archive').mockImplementation(async (key, reason) => {
      openWhenArchived.push(getRun(h.t.db, key.threadId)?.endedAt === null);
      return archive(key, reason);
    });

    await h.dispatcher.boot();
    expect(openWhenArchived).toEqual([true, true]);
    expect(openRuns(h.t.db)).toEqual([]);
  });

  it('goes on to the other runs when one fails, and never rejects', async () => {
    const h0 = await beforeTwo();
    const h = after(h0);
    const [first, second] = openRuns(h.t.db);
    vi.spyOn(h.registry, 'archive').mockRejectedValueOnce(new Error('the agent would not close'));

    await expect(h.dispatcher.boot()).resolves.toBeUndefined();
    expect(openRuns(h.t.db)).toEqual([]);
    expect(h.notes).toContain(
      `kanban: run ${first?.runId}: archiving its session ${first?.sessionId} failed after a restart`,
    );
    expect(h.notes).toContain(`kanban: run ${second?.runId} closed after a restart`);
  });

  it('notes a run it could not close by its refusal, and one that threw, and goes on', async () => {
    const h0 = await beforeTwo();
    const h = after(h0);
    const [first, second] = openRuns(h.t.db);
    vi.spyOn(h.service, 'closeRun')
      .mockReturnValueOnce({ ok: false, code: 'not_found', message: 'gone' })
      .mockImplementationOnce(() => {
        throw new Error('SQLITE_IOERR');
      });

    await expect(h.dispatcher.boot()).resolves.toBeUndefined();
    expect(h.notes).toContain(`kanban: run ${first?.runId} not closed after a restart: not_found`);
    expect(h.notes).toContain(`kanban: ending run ${second?.runId} after a restart failed: SQLITE_IOERR`);
    expect(h.notes.some((n) => n.endsWith('closed after a restart'))).toBe(false);
  });

  it('archives at boot a kanban session left bound by a failed archive, and one bound with no run', async () => {
    const h0 = dispatchHarness();
    open.push(h0);
    const task = h0.create({ title: 'Build', workspace: 'web' });
    completes(h0, h0.driver('implementer'));
    vi.spyOn(h0.registry, 'archive').mockRejectedValueOnce(new Error('the agent would not close'));
    h0.dispatcher.pass();
    await h0.dispatcher.idle();
    const [run] = runsOf(h0.t.db, task.taskId);
    expect(run?.endedAt).not.toBeNull();
    const closedSession = run?.sessionId ?? '';
    expect(bindingsForSession(h0.t.db, closedSession)).toHaveLength(1);
    // A session bound on the kanban channel at a run the board has never had.
    const stray = h0.registry.create(runKey(APP, { taskId: task.taskId, runId: 'r_missing' }), KANBAN_OWNER).id;
    // One bound elsewhere is not the dispatcher's.
    const chat = h0.registry.create(
      { channel: 'lark', appId: APP, conversationId: 'oc_chat', threadId: 'om_root' },
      KANBAN_OWNER,
    ).id;
    h0.dispatcher.stop();

    const h = after(h0);
    await h.dispatcher.boot();
    for (const sessionId of [closedSession, stray]) {
      expect(bindingsForSession(h.t.db, sessionId)).toEqual([]);
      expect(getSession(h.t.db, sessionId)?.state).toBe('archived');
    }
    expect(bindingsForSession(h.t.db, chat)).toHaveLength(1);
    expect(getSession(h.t.db, chat)?.state).not.toBe('archived');
  });
});
