import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { claim } from '../src/db/kanban.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { registerWorktree } from '../src/db/workspaces.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { claimantFor, NOW, newTask } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * A task's own directory at the terminal (spec §18): `mt kanban task show` says
 * where it is, and `mt kanban task worktree` prints it alone, to `cd` to.
 */

let f: MtFixture;
let gateway: Db;

beforeEach(() => {
  clearSecrets();
  f = mtFixture((workspace) => {
    // web is isolated, its tasks each in a directory of their own; default is shared.
    const web = join(dirname(workspace), 'web');
    mkdirSync(web);
    return [
      'workspaces:',
      `  default: ${workspace}`,
      '  web:',
      `    path: ${web}`,
      '    isolated: true',
      'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n');
  });
  gateway = openDb(join(f.home, 'team.db'));
  migrate(gateway, SCHEMA_DIR);
});

afterEach(() => {
  clearSecrets();
  gateway.close();
  f.cleanup();
});

async function mt(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMt(['kanban', ...argv], {
    env: { ...f.env, HOME: f.root },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    stdinIsTTY: false,
    stdin: async () => '',
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** A task claimed in an isolated default, its directory made or not. */
function isolatedTask(made: boolean): { taskId: string; path: string } {
  const task = newTask(gateway, { assignee: { kind: 'role', name: 'default' }, workspace: 'default' });
  const r = claim(
    gateway,
    { taskId: task.taskId, claimant: claimantFor(gateway, task.taskId), workspaces: new Set(['default']), isolated: new Set(['default']) },
    NOW,
  );
  if (!r.ok) throw new Error(r.message);
  const path = join(f.home, 'worktrees', 'default', task.taskId);
  if (made) {
    registerWorktree(gateway, { id: `wt:${task.taskId}`, kind: 'git-worktree', rootPath: path, repoRoot: f.workspace, branch: `mt/${task.taskId}` }, NOW);
  }
  return { taskId: task.taskId, path };
}

describe('mt kanban task worktree', () => {
  it("prints a task's own directory alone, and in JSON its branch", async () => {
    const { taskId, path } = isolatedTask(true);
    expect(await mt(['task', 'worktree', taskId])).toEqual({ code: 0, out: path, err: '' });
    const json = await mt(['task', 'worktree', taskId, '--json']);
    expect(JSON.parse(json.out)).toEqual({ ok: true, task_id: taskId, workspace: 'default', path, branch: `mt/${taskId}` });
  });

  it('refuses a task in a shared directory, and one whose directory is not made yet', async () => {
    const shared = newTask(gateway, { workspace: 'default' });
    expect(await mt(['task', 'worktree', shared.taskId])).toEqual({
      code: 1,
      out: '',
      err: `mt: task ${shared.taskId} works in the shared directory of workspace default, not a directory of its own`,
    });
    const { taskId } = isolatedTask(false);
    expect(JSON.parse((await mt(['task', 'worktree', taskId, '--json'])).out)).toEqual({
      ok: false,
      code: 'no_worktree',
      message: `task ${taskId}'s own directory is not made yet: it is made when an agent next takes the task up`,
    });
    expect((await mt(['task', 'worktree'])).code).toBe(2);
  });

  it('says of a task in an isolated workspace that no agent has taken up yet that its directory is made when one first does', async () => {
    const fresh = newTask(gateway, { assignee: { kind: 'role', name: 'default' }, workspace: 'web' });
    expect(await mt(['task', 'worktree', fresh.taskId])).toEqual({
      code: 1,
      out: '',
      err: `mt: task ${fresh.taskId}'s own directory is not made yet: it is made when an agent first takes the task up`,
    });
  });
});

describe('a task with a folder of its own', () => {
  it('reads as a folder: no branch, in show or worktree', async () => {
    const task = newTask(gateway, { assignee: { kind: 'role', name: 'default' }, workspace: 'default' });
    const r = claim(
      gateway,
      { taskId: task.taskId, claimant: claimantFor(gateway, task.taskId), workspaces: new Set(['default']), isolated: new Set(['default']) },
      NOW,
    );
    if (!r.ok) throw new Error(r.message);
    const path = join(f.home, 'worktrees', 'default', task.taskId);
    registerWorktree(gateway, { id: `wt:${task.taskId}`, kind: 'plain-dir', rootPath: path, repoRoot: f.workspace, branch: null }, NOW);
    const shown = (await mt(['task', 'show', task.taskId])).out;
    expect(shown.split('\n')).toContain(`directory: ${path}`);
    expect(shown).not.toContain('branch');
    expect(await mt(['task', 'worktree', task.taskId])).toEqual({ code: 0, out: path, err: '' });
    expect(JSON.parse((await mt(['task', 'worktree', task.taskId, '--json'])).out)).toMatchObject({ path, branch: null });
  });
});

describe('mt kanban task show', () => {
  it("says where a task's own directory is, and its branch", async () => {
    const { taskId, path } = isolatedTask(true);
    const r = await mt(['task', 'show', taskId]);
    expect(r.out.split('\n')).toContain(`directory: ${path} · branch mt/${taskId}`);
    expect(JSON.parse((await mt(['task', 'show', taskId, '--json'])).out).task.worktree).toEqual({ path, branch: `mt/${taskId}` });
    const later = isolatedTask(false);
    expect((await mt(['task', 'show', later.taskId])).out.split('\n')).toContain('directory: its own, not made yet: it is made when an agent next takes the task up');
    const shared = newTask(gateway, { workspace: 'default' });
    expect((await mt(['task', 'show', shared.taskId])).out).not.toContain('directory:');
    expect(JSON.parse((await mt(['task', 'show', shared.taskId, '--json'])).out).task.worktree).toBeNull();
  });

  it('says of a task in an isolated workspace that no agent has taken up yet that its directory is made when one first does', async () => {
    const fresh = newTask(gateway, { assignee: { kind: 'role', name: 'default' }, workspace: 'web' });
    const shown = (await mt(['task', 'show', fresh.taskId])).out;
    expect(shown.split('\n')).toContain('directory: its own, not made yet: it is made when an agent first takes the task up');
    expect(shown).not.toMatch(/git/i);
    expect(JSON.parse((await mt(['task', 'show', fresh.taskId, '--json'])).out).task.worktree).toEqual({ path: null, branch: null });
  });
});
