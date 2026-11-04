import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import type { GateExit } from '../src/kanban/gates.js';
import { clearSecrets } from '../src/secrets.js';
import { ALICE } from './helpers/kanban.js';
import { dispatchHarness, holds, role, until, type DispatchHarness } from './helpers/dispatch.js';

/**
 * A run whose turn ends while its report is running the task's gates (spec
 * §7.7): its agent's shell gave up on `mt kanban` waiting for them. The
 * dispatcher waits for the report before it nudges or decides the run.
 */

const open: DispatchHarness[] = [];

beforeEach(() => clearSecrets());
afterEach(() => {
  clearSecrets();
  while (open.length > 0) open.pop()?.close();
});

/** A harness whose gates are held until the test lets them go. */
function gated(nudgeLimit: number) {
  let started = false;
  let release: (exit: Partial<GateExit>) => void = () => undefined;
  const gate = new Promise<Partial<GateExit>>((resolve) => (release = resolve));
  const h = dispatchHarness({
    roles: [role('default'), role('implementer')],
    settings: { nudgeLimit },
    checks: {
      workspaceDirs: new Map([['web', '/tmp/ws-web']]),
      env: {},
      runGate: async () => {
        started = true;
        return { exitCode: 0, signal: null, timedOut: false, output: '', ...(await gate) };
      },
      readCommit: async () => ({ commit: null, dirty: true }),
    },
  });
  open.push(h);
  return { h, started: () => started, release };
}

describe('a turn that ends while its report runs the gates', () => {
  it('sends no nudge, and decides nothing, until the report is answered: here it is applied', async () => {
    const { h, started, release } = gated(1);
    const task = h.create({ workspace: 'web' });
    expect(h.service.addGate(task.taskId, { command: 'npm test' }, ALICE).ok).toBe(true);
    const implementer = h.driver('implementer');
    implementer.scripts.push((ctl) => {
      const runId = ctl.env?.['MT_KANBAN_RUN'] ?? '';
      // The agent's shell gave up on the command; the report goes on.
      void h.service.complete(task.taskId, { kind: 'run', runId }, { summary: 'done' });
      ctl.end('completed');
    });

    h.dispatcher.pass();
    await until(started, 'the gates to run');
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(implementer.lastRuntime?.prompts).toHaveLength(1);
    expect(runsOf(h.t.db, task.taskId)[0]?.outcome).toBeNull();

    release({});
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, task.taskId).map((r) => [r.outcome, r.submissions])).toEqual([['completed', 1]]);
    expect(getTask(h.t.db, task.taskId)?.phase).toBe('done');
  });

  it('nudges once the report is refused, as for any turn that ended without a report', async () => {
    const { h, started, release } = gated(1);
    const task = h.create({ workspace: 'web' });
    expect(h.service.addGate(task.taskId, { command: 'npm test' }, ALICE).ok).toBe(true);
    const implementer = h.driver('implementer');
    implementer.scripts.push((ctl) => {
      const runId = ctl.env?.['MT_KANBAN_RUN'] ?? '';
      void h.service.complete(task.taskId, { kind: 'run', runId }, { summary: 'done' });
      ctl.end('completed');
    });

    h.dispatcher.pass();
    await until(started, 'the gates to run');
    release({ exitCode: 1, output: 'FAIL' });
    await h.dispatcher.idle();
    const [run] = runsOf(h.t.db, task.taskId);
    expect(run).toMatchObject({ outcome: 'protocol_violation', submissions: 2 });
    expect(implementer.lastRuntime?.prompts[1]?.text).toContain('(reminder 1 of 1)');
  });

  it('decides nothing when the gateway stops while the report runs the gates, whichever closes first: the next boot ends the run', async () => {
    for (const sessionsFirst of [false, true]) {
      const { h, started, release } = gated(1);
      const task = h.create({ workspace: 'web' });
      expect(h.service.addGate(task.taskId, { command: 'npm test' }, ALICE).ok).toBe(true);
      const implementer = h.driver('implementer');
      const held = holds(implementer);
      // Closing the session kills the agent: its turn ends failed, as a dying process's does.
      implementer.onClose = () => held.end('failed');
      const stopping = new AbortController();
      let report: Promise<{ ok: boolean; code?: string }> | undefined;
      h.dispatcher.pass();
      await until(() => held.started, 'the turn to start');
      const runId = h.runOf(implementer).runId;
      // As the worker socket hands a report the gateway's stop signal.
      report = h.service.complete(task.taskId, { kind: 'run', runId }, { summary: 'done' }, { signal: stopping.signal });
      await until(started, 'the gates to run');

      // The gateway's stop, in its order: no more claims or decisions first.
      h.dispatcher.stop();
      const abortReports = async () => {
        stopping.abort();
        release({ exitCode: null, signal: 'SIGTERM' });
        expect(await report).toMatchObject({ ok: false, code: 'gates_cannot_run' });
      };
      if (sessionsFirst) {
        await h.registry.closeAll();
        await abortReports();
      } else {
        await abortReports();
        await h.registry.closeAll();
      }
      expect(await h.dispatcher.idle(5_000)).toBe(true);
      const [run] = runsOf(h.t.db, task.taskId);
      expect([sessionsFirst, run?.outcome, run?.submissions]).toEqual([sessionsFirst, null, 1]);
      expect(getTask(h.t.db, task.taskId)?.phase).toBe('open');
    }
  });
});
