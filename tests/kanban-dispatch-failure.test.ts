import { afterEach, describe, expect, it } from 'vitest';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import type { TurnControl } from './helpers/driver.js';
import { completes, dispatchHarness, reportComplete, role, type DispatchHarness } from './helpers/dispatch.js';

const open: DispatchHarness[] = [];

function harness(...args: Parameters<typeof dispatchHarness>): DispatchHarness {
  const h = dispatchHarness(...args);
  open.push(h);
  return h;
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

/** A turn that fails the way an agent's does: an error, then a terminal. */
function fails(message: string, terminal: 'failed' | 'ambiguous' = 'failed', calls: readonly string[] = []) {
  return (ctl: TurnControl): void => {
    calls.forEach((title, i) =>
      ctl.emit({ kind: 'tool-call', toolCallId: `c${i}`, title, status: 'completed', raw: {} }),
    );
    ctl.emit({ kind: 'error', message, retryable: false });
    ctl.end(terminal);
  };
}

describe('Dispatcher: a run that fails is classified (spec §8.1)', () => {
  it('blocks at once as capability when the provider refused the credentials', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    h.driver('implementer').scripts.push(fails('API Error: 401 {"error":{"type":"authentication_error"}}'));

    h.dispatcher.pass();
    await h.dispatcher.idle();

    expect(runsOf(h.t.db, task.taskId).map((r) => [r.outcome, r.error])).toEqual([
      ['terminal_provider', 'API Error: 401 {"error":{"type":"authentication_error"}}'],
    ]);
    expect(getTask(h.t.db, task.taskId)).toMatchObject({ phase: 'blocked', blockKind: 'capability' });
  });

  it('holds a throttled task in its cooldown, uncounted, and claims it again once the cooldown is over', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    implementer.scripts.push(fails('429 Too Many Requests', 'ambiguous'));
    completes(h, implementer);

    h.dispatcher.pass();
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, task.taskId).map((r) => r.outcome)).toEqual(['rate_limited']);
    expect(getTask(h.t.db, task.taskId)).toMatchObject({
      phase: 'open',
      consecutiveFailures: 0,
      cooldownUntil: h.clock.now() + 300_000,
    });

    h.clock.advance(299_999);
    h.dispatcher.pass();
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, task.taskId)).toHaveLength(1);

    h.clock.advance(1);
    h.dispatcher.pass();
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, task.taskId).map((r) => r.outcome)).toEqual(['rate_limited', 'completed']);
  });

  it('counts a crash, and retries it in a fresh session told what the crashed run did', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    implementer.scripts.push((ctl) => {
      ctl.emit({ kind: 'message-chunk', text: 'Editing the parser.' });
      fails('the agent exited without finishing its turn', 'ambiguous', ['edit', 'bash'])(ctl);
    });
    completes(h, implementer);

    h.dispatcher.pass();
    await h.dispatcher.idle();

    const [crashed, retry] = runsOf(h.t.db, task.taskId);
    expect(crashed).toMatchObject({ outcome: 'crashed', lastOutput: 'Editing the parser.' });
    expect(retry).toMatchObject({ outcome: 'completed' });
    expect(retry?.sessionId).not.toBe(crashed?.sessionId);
    const prompt = implementer.runtimes[1]?.prompts[0]?.text ?? '';
    expect(prompt).toContain(
      '## Attempt 1 (work, implementer): crashed\nError: the agent exited without finishing its turn\n' +
        'Last output: Editing the parser.\nTool calls:\n- edit (completed)\n- bash (completed)',
    );
    expect(getTask(h.t.db, task.taskId)).toMatchObject({ phase: 'done', consecutiveFailures: 0 });
  });

  it("gives up at the task's failure limit", async () => {
    const h = harness();
    const task = h.create({ workspace: 'web', failureLimit: 3 });
    const implementer = h.driver('implementer');
    for (let i = 0; i < 3; i += 1) implementer.scripts.push(fails('the agent reported a failed turn'));

    h.dispatcher.pass();
    await h.dispatcher.idle();

    expect(runsOf(h.t.db, task.taskId).map((r) => r.outcome)).toEqual(['failed', 'failed', 'failed']);
    expect(getTask(h.t.db, task.taskId)).toMatchObject({ phase: 'blocked', blockKind: 'gave_up', consecutiveFailures: 3 });
  });

  it('records why a runtime would not start, as an ordinary failure', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    h.driver('implementer').failStartWith = new Error('spawn bytesec ENOENT');

    h.dispatcher.pass();
    await h.dispatcher.idle();

    expect(runsOf(h.t.db, task.taskId).map((r) => [r.outcome, r.error])).toEqual([
      ['failed', 'spawn bytesec ENOENT'],
      ['failed', 'spawn bytesec ENOENT'],
    ]);
  });

  it('keeps a report when the turn fails after it: the board believes the worker, not its exit', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    implementer.scripts.push(async (ctl) => {
      await reportComplete(h, implementer);
      fails('Error: 429 Too Many Requests', 'ambiguous')(ctl);
    });

    h.dispatcher.pass();
    await h.dispatcher.idle();

    expect(runsOf(h.t.db, task.taskId).map((r) => r.outcome)).toEqual(['completed']);
    expect(getTask(h.t.db, task.taskId)?.phase).toBe('done');
  });
});

describe('Dispatcher: retry_on_crash if-no-side-effects (spec §8.3)', () => {
  it("retries a run whose tool calls were all its role's read-only tools", async () => {
    const h = harness({ roles: [role('implementer', {}, ['read', 'grep'])] });
    const task = h.create({ workspace: 'web', retryOnCrash: 'if-no-side-effects' });
    const implementer = h.driver('implementer');
    implementer.scripts.push(fails('the agent exited', 'ambiguous', ['read', 'grep']));
    completes(h, implementer);

    h.dispatcher.pass();
    await h.dispatcher.idle();

    expect(runsOf(h.t.db, task.taskId).map((r) => r.outcome)).toEqual(['crashed', 'completed']);
  });

  it('holds a run that changed something for a person, rather than retrying it', async () => {
    const h = harness({ roles: [role('implementer', {}, ['read', 'grep'])] });
    const task = h.create({ workspace: 'web', retryOnCrash: 'if-no-side-effects' });
    h.driver('implementer').scripts.push(fails('the agent exited', 'ambiguous', ['read', 'edit']));

    h.dispatcher.pass();
    await h.dispatcher.idle();

    expect(runsOf(h.t.db, task.taskId).map((r) => r.outcome)).toEqual(['crashed']);
    expect(getTask(h.t.db, task.taskId)).toMatchObject({
      phase: 'blocked',
      blockKind: 'needs_input',
      blockReason: 'the run ended crashed after changing things; look before it is retried',
    });
  });
});
