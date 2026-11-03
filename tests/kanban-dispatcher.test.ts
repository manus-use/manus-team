import { afterEach, describe, expect, it } from 'vitest';
import { bindingsForSession, resolveBinding } from '../src/db/bindings.js';
import { lastSeq, readEvents } from '../src/db/events.js';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import { getSession } from '../src/db/sessions.js';
import { runKey } from '../src/kanban/dispatcher.js';
import {
  APP,
  completes,
  dispatchHarness,
  holds,
  reportComplete,
  until,
  type DispatchHarness,
} from './helpers/dispatch.js';

const open: DispatchHarness[] = [];

function harness(...args: Parameters<typeof dispatchHarness>): DispatchHarness {
  const h = dispatchHarness(...args);
  open.push(h);
  return h;
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

describe('Dispatcher: a run is a session', () => {
  it('claims a ready task and runs it in a fresh session on the kanban channel, then closes it', async () => {
    const h = harness();
    const task = h.create({ title: 'Write the parser', workspace: 'web' });
    const implementer = h.driver('implementer');
    completes(h, implementer, 'parsed');

    h.dispatcher.pass();
    await h.dispatcher.idle();

    const [run] = runsOf(h.t.db, task.taskId);
    expect(run).toMatchObject({ outcome: 'completed', summary: 'parsed', submissions: 1 });
    expect(run?.endedAt).not.toBeNull();
    expect(getTask(h.t.db, task.taskId)?.phase).toBe('done');

    // The agent ran as the role, in the task's workspace, with the run in its environment.
    expect(implementer.starts).toHaveLength(1);
    expect(implementer.starts[0]).toMatchObject({ cwd: '/tmp/ws-web', env: { MT_KANBAN_RUN: run?.runId } });
    expect(implementer.runtimes[0]?.prompts[0]?.text).toContain(`${task.taskId}: Write the parser`);

    // Its own session, bound at the run's key, archived once the run closed.
    const sessionId = run?.sessionId ?? '';
    expect(getSession(h.t.db, sessionId)).toMatchObject({ agentId: 'implementer', workspaceId: 'web', state: 'archived' });
    expect(resolveBinding(h.t.db, runKey(APP, { taskId: task.taskId, runId: run?.runId ?? '' }))).toBeUndefined();
    expect(bindingsForSession(h.t.db, sessionId)).toEqual([]);
    const submitted = readEvents(h.t.db, sessionId, 0, lastSeq(h.t.db, sessionId)).find((e) => e.type === 'turn_submitted');
    expect(submitted?.payload).toMatchObject({ messageId: `kanban:${run?.runId}:0` });

    // Nothing went to Lark.
    expect(h.lark.calls).toEqual([]);
  });

  it('ends a turn that finishes without a report as a protocol violation, and retries it in a new session', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    implementer.scripts.push((ctl) => {
      ctl.emit({ kind: 'message-chunk', text: 'Next I will run the tests.' });
      ctl.end('completed');
    });

    h.dispatcher.pass();
    await h.dispatcher.idle();

    // The default failure limit is 2: the first attempt, one retry, then the task gives up.
    const runs = runsOf(h.t.db, task.taskId);
    expect(runs.map((r) => r.outcome)).toEqual(['protocol_violation', 'protocol_violation']);
    expect(runs[0]).toMatchObject({ lastOutput: 'Next I will run the tests.', error: 'the run ended its turn without reporting' });
    expect(new Set(runs.map((r) => r.sessionId)).size).toBe(2);
    expect(getTask(h.t.db, task.taskId)).toMatchObject({ phase: 'blocked', blockKind: 'gave_up' });
  });

  it("seeds a rework's session from the provider session of the work it resumes", async () => {
    const h = harness();
    const task = h.create({ workspace: 'web', reviewer: 'reviewer' });
    const implementer = h.driver('implementer');
    implementer.providerSessionId = 'prov_impl';
    implementer.scripts.push((ctl) => {
      const run = h.runOf(implementer);
      expect(h.service.requestReview(task.taskId, { kind: 'run', runId: run.runId }, { summary: 'please look' }).ok).toBe(
        true,
      );
      ctl.end('completed');
    });
    const reviewer = h.driver('reviewer');
    reviewer.scripts.push((ctl) => {
      const run = h.runOf(reviewer);
      expect(h.service.requestChanges(task.taskId, { kind: 'run', runId: run.runId }, 'add a test').ok).toBe(true);
      ctl.end('completed');
    });
    completes(h, implementer, 'with a test');

    h.dispatcher.pass();
    await h.dispatcher.idle();

    const runs = runsOf(h.t.db, task.taskId);
    expect(runs.map((r) => [r.kind, r.outcome])).toEqual([
      ['work', 'review_requested'],
      ['review', 'changes_requested'],
      ['work', 'completed'],
    ]);
    expect(runs[2]?.seededFromRun).toBe(runs[0]?.runId);
    expect(implementer.starts.map((s) => s.providerSessionId)).toEqual([undefined, 'prov_impl']);
    expect(reviewer.starts[0]?.cwd).toBe('/tmp/ws-web');
  });
});

describe('Dispatcher: one agent run per workspace', () => {
  it('runs one task at a time in a workspace, and tasks in different workspaces at once', async () => {
    const h = harness();
    const first = h.create({ title: 'first', workspace: 'web' });
    const second = h.create({ title: 'second', workspace: 'web' });
    const elsewhere = h.create({ title: 'elsewhere', workspace: 'docs', assignee: 'docs-writer' });
    const held = holds(h.driver('implementer'));
    const docs = holds(h.driver('docs-writer'));

    h.dispatcher.pass();
    await until(() => held.started && docs.started, 'both runs to start');

    expect(runsOf(h.t.db, first.taskId)).toHaveLength(1);
    expect(runsOf(h.t.db, second.taskId)).toHaveLength(0);
    expect(runsOf(h.t.db, elsewhere.taskId)).toHaveLength(1);

    // The first reports and ends; its workspace is free, and the second is claimed.
    completes(h, h.driver('implementer'));
    held.end('completed', () => reportComplete(h, h.driver('implementer')));
    docs.end('completed', () => reportComplete(h, h.driver('docs-writer')));
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, second.taskId).map((r) => r.outcome)).toEqual(['completed']);
  });

  it('holds the workspace until a run that has reported has closed', async () => {
    const h = harness();
    const parent = h.create({ title: 'parent', workspace: 'web' });
    const child = h.create({ title: 'child', parents: [parent.taskId] });
    const implementer = h.driver('implementer');
    let finish: (() => void) | undefined;
    const tidying = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let reported = false;
    implementer.scripts.push(async (ctl) => {
      const run = h.runOf(implementer);
      expect(h.service.complete(parent.taskId, { kind: 'run', runId: run.runId }, { summary: 'done' }).ok).toBe(true);
      reported = true;
      // Still going: summarising, committing, in the same checkout.
      await tidying;
      ctl.end('completed');
    });
    completes(h, implementer);

    h.dispatcher.pass();
    await until(() => reported, 'the parent to report');
    h.dispatcher.pass();

    // The child is ready, but the parent's run is still open in its workspace.
    expect(getTask(h.t.db, parent.taskId)?.phase).toBe('done');
    expect(runsOf(h.t.db, child.taskId)).toHaveLength(0);

    finish?.();
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, child.taskId).map((r) => [r.workspace, r.outcome])).toEqual([['web', 'completed']]);
  });

  it('claims by priority, then age', async () => {
    const h = harness();
    h.create({ title: 'old', workspace: 'web' });
    h.clock.advance(1);
    h.create({ title: 'urgent', workspace: 'web', priority: 5 });
    h.clock.advance(1);
    h.create({ title: 'young', workspace: 'web' });
    const implementer = h.driver('implementer');
    for (let i = 0; i < 3; i += 1) completes(h, implementer);

    h.dispatcher.pass();
    await h.dispatcher.idle();

    const titles = implementer.runtimes.map((r) => /k_\w+: (\w+)/.exec(r.prompts[0]?.text ?? '')?.[1]);
    expect(titles).toEqual(['urgent', 'old', 'young']);
  });

  it('opens one run for a task when two dispatchers pass over one board', async () => {
    const a = harness();
    const b = harness({ t: a.t, clock: a.clock });
    const task = a.create({ workspace: 'web' });
    const held = holds(a.driver('implementer'));

    a.dispatcher.pass();
    b.dispatcher.pass();
    await until(() => held.started, 'the run to start');
    expect(runsOf(a.t.db, task.taskId)).toHaveLength(1);
    expect(b.driver('implementer').starts).toHaveLength(0);
    held.end();
    await a.dispatcher.idle();
  });
});

describe('Dispatcher: an open run is pinned', () => {
  it("keeps an open run's actor live over the registry's cap, and lets it go once closed", async () => {
    const h = harness({ maxLive: 1 });
    const task = h.create({ workspace: 'web' });
    const held = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started, 'the run to start');
    const sessionId = runsOf(h.t.db, task.taskId)[0]?.sessionId ?? '';
    expect(h.dispatcher.pinned(sessionId)).toBe(true);

    // A chat session arrives while the run is the only live actor.
    const at = { channel: 'lark', appId: APP, conversationId: 'oc_chat', threadId: '' };
    const chat = h.registry.bindOrCreate(at, { openId: 'ou_a', unionId: 'on_a', displayName: null }).session;
    await h.registry.actorFor(chat.id, at);
    expect(h.registry.liveActor(sessionId)).toBeDefined();
    expect(h.registry.liveCount).toBe(2);

    held.end();
    await h.dispatcher.idle();
    expect(h.dispatcher.pinned(sessionId)).toBe(false);
    expect(h.registry.liveActor(sessionId)).toBeUndefined();
  });
});

describe('Dispatcher: kanban.maxRunning', () => {
  it('opens no more agent runs than maxRunning, counting runs that have reported and are finishing', async () => {
    const h = harness({ settings: { maxRunning: 2 } });
    const web = h.create({ title: 'web', workspace: 'web' });
    h.clock.advance(1);
    const api = h.create({ title: 'api', workspace: 'api', assignee: 'reviewer' });
    h.clock.advance(1);
    const docs = h.create({ title: 'docs', assignee: 'docs-writer' });
    const implementer = h.driver('implementer');
    let finish: (() => void) | undefined;
    const tidying = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let reported = false;
    implementer.scripts.push(async (ctl) => {
      reportComplete(h, implementer);
      reported = true;
      await tidying;
      ctl.end('completed');
    });
    const other = holds(h.driver('reviewer'));
    const third = holds(h.driver('docs-writer'));

    h.dispatcher.pass();
    await until(() => reported && other.started, 'two runs to start');
    h.dispatcher.pass();
    expect([web, api, docs].map((t) => runsOf(h.t.db, t.taskId).length)).toEqual([1, 1, 0]);

    // Once the reported run has closed, there is room for the third.
    finish?.();
    await until(() => third.started, 'the third run to start');
    expect(runsOf(h.t.db, docs.taskId)).toHaveLength(1);

    other.end('completed', () => reportComplete(h, h.driver('reviewer')));
    third.end('completed', () => reportComplete(h, h.driver('docs-writer')));
    await h.dispatcher.idle();
  });
});
