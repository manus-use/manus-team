import { afterEach, describe, expect, it } from 'vitest';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import { getSession } from '../src/db/sessions.js';
import { registerWorktree, worktreeOf } from '../src/db/workspaces.js';
import type { TaskRow } from '../src/kanban/types.js';
import type { Prepared, Workdirs } from '../src/kanban/worktree.js';
import { NOW } from './helpers/kanban.js';
import { completes, dispatchHarness, holds, until, type DispatchHarness } from './helpers/dispatch.js';

/**
 * The dispatcher and a task's own directory (spec §18): made before the task's
 * first run, so the tasks of one isolated workspace run side by side, each in
 * its own; found again by a retry; and one that cannot be made blocking its task
 * for a person, uncounted, while the pass goes on.
 */

const open: DispatchHarness[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

/** A stand-in for the real directories: records each ask, and makes `/own/<task>` unless told to refuse. */
class FakeWorkdirs implements Workdirs {
  readonly asked: string[] = [];
  readonly refuse = new Map<string, string>();
  h!: DispatchHarness;

  async prepare(task: TaskRow): Promise<Prepared> {
    this.asked.push(task.taskId);
    const reason = this.refuse.get(task.taskId);
    if (reason !== undefined) return { ok: false, reason };
    const id = task.worktree ?? '';
    const dir = { id, kind: 'git-worktree' as const, rootPath: `/own/${task.taskId}`, repoRoot: '/tmp/ws-web', branch: `mt/${task.taskId}` };
    registerWorktree(this.h.t.db, dir, NOW);
    return { ok: true, dir: worktreeOf(this.h.t.db, id) ?? dir };
  }
}

function harness(): { h: DispatchHarness; dirs: FakeWorkdirs } {
  const dirs = new FakeWorkdirs();
  const h = dispatchHarness({ isolated: new Set(['web']), workdirs: dirs, settings: { maxRunning: 4 } });
  dirs.h = h;
  open.push(h);
  return { h, dirs };
}

describe('Dispatcher: tasks in an isolated workspace', () => {
  it('runs two at once, each in a directory of its own', async () => {
    const { h, dirs } = harness();
    const a = h.create({ title: 'a', workspace: 'web' });
    const b = h.create({ title: 'b', workspace: 'web' });
    const implementer = h.driver('implementer');
    const first = holds(implementer);
    const second = holds(implementer);
    h.dispatcher.pass();
    await until(() => first.started && second.started, 'both runs to start');
    expect(dirs.asked.sort()).toEqual([a.taskId, b.taskId].sort());
    expect(implementer.starts.map((s) => s.cwd).sort()).toEqual([`/own/${a.taskId}`, `/own/${b.taskId}`].sort());
    const [run] = runsOf(h.t.db, a.taskId);
    expect(getSession(h.t.db, run?.sessionId ?? '')).toMatchObject({ workspaceId: `wt:${a.taskId}` });
    // Its prompt says where it is, and that its branch is where the work goes.
    const prompt = implementer.runtimes.map((r) => r.prompts[0]?.text ?? '').find((p) => p.includes(`${a.taskId}: a`)) ?? '';
    expect(prompt).toContain(`Your directory, the current one, is /own/${a.taskId}: a git worktree of this task's own, on its branch mt/${a.taskId}.`);
    first.end();
    second.end();
    await h.dispatcher.idle();
  });

  it('runs a retry in the same directory', async () => {
    const { h, dirs } = harness();
    const task = h.create({ title: 'a', workspace: 'web' });
    const implementer = h.driver('implementer');
    implementer.scripts.push((ctl) => ctl.end('failed'));
    completes(h, implementer);
    h.dispatcher.pass();
    await until(() => getTask(h.t.db, task.taskId)?.phase === 'done', 'the retry to complete');
    await h.dispatcher.idle();
    expect(dirs.asked).toEqual([task.taskId, task.taskId]);
    expect(implementer.starts.map((s) => s.cwd)).toEqual([`/own/${task.taskId}`, `/own/${task.taskId}`]);
  });

  it('blocks a task whose directory cannot be made, for a person, uncounted, and goes on to the next', async () => {
    const { h, dirs } = harness();
    const stuck = h.create({ title: 'stuck', workspace: 'web', priority: 1 });
    const next = h.create({ title: 'next', workspace: 'web' });
    dirs.refuse.set(stuck.taskId, 'merging conflicts in README');
    const implementer = h.driver('implementer');
    completes(h, implementer);
    h.dispatcher.pass();
    await until(() => getTask(h.t.db, next.taskId)?.phase === 'done', 'the next task to complete');
    await h.dispatcher.idle();
    expect(getTask(h.t.db, stuck.taskId)).toMatchObject({
      phase: 'blocked',
      blockKind: 'needs_input',
      blockReason: 'merging conflicts in README',
      consecutiveFailures: 0,
    });
    const [run] = runsOf(h.t.db, stuck.taskId);
    expect(run).toMatchObject({ outcome: 'failed', error: 'the run could not start: merging conflicts in README', sessionId: null });
    expect(run?.endedAt).not.toBeNull();
    // No agent started for it.
    expect(implementer.starts.map((s) => s.cwd)).toEqual([`/own/${next.taskId}`]);
  });

  it("tells a task in a shared directory where its parents' own directories are", async () => {
    const { h } = harness();
    const parent = h.create({ title: 'a', workspace: 'web' });
    const child = h.create({ title: 'b', workspace: 'api', parents: [parent.taskId] });
    const implementer = h.driver('implementer');
    completes(h, implementer);
    completes(h, implementer);
    h.dispatcher.pass();
    await until(() => getTask(h.t.db, child.taskId)?.phase === 'done', 'the child to complete');
    await h.dispatcher.idle();
    const prompt = implementer.runtimes[1]?.prompts[0]?.text ?? '';
    expect(prompt).not.toContain('Your directory');
    expect(prompt).toContain(`- ${parent.taskId}: /own/${parent.taskId} (branch mt/${parent.taskId})`);
    expect(implementer.starts[1]?.cwd).toBe('/tmp/ws-api');
  });

  it('keeps a task in a workspace that is not isolated in the shared directory, asking for nothing', async () => {
    const { h, dirs } = harness();
    const task = h.create({ title: 'a', workspace: 'api' });
    const implementer = h.driver('implementer');
    completes(h, implementer);
    h.dispatcher.pass();
    await h.dispatcher.idle();
    expect(getTask(h.t.db, task.taskId)).toMatchObject({ phase: 'done', worktree: null });
    expect(dirs.asked).toEqual([]);
    expect(implementer.starts[0]?.cwd).toBe('/tmp/ws-api');
  });
});
