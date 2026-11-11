import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claim } from '../src/db/kanban.js';
import { taskView } from '../src/db/kanban-read.js';
import { registerWorktree } from '../src/db/workspaces.js';
import { renderShow } from '../src/kanban/chat-render.js';
import { testDb, type TestDb } from './helpers/db.js';
import { claimantFor, NOW, WORKSPACES, newTask } from './helpers/kanban.js';

/** `/kanban task show` and a task's own directory (spec §18): where it is, and its branch, escaped as any text. */

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

function show(taskId: string): string {
  const view = taskView(h.db, taskId);
  if (view === undefined) throw new Error('no view');
  return renderShow(view, []);
}

describe('/kanban task show', () => {
  it("says where a task's own directory is, once made, and nothing for a shared one", () => {
    const task = newTask(h.db, { workspace: 'web' });
    claim(h.db, { taskId: task.taskId, claimant: claimantFor(h.db, task.taskId), workspaces: WORKSPACES, isolated: new Set(['web']) }, NOW);
    expect(show(task.taskId).split('\n')).toContain('directory: its own, not made yet: it is made when an agent next takes the task up');
    registerWorktree(
      h.db,
      { id: `wt:${task.taskId}`, kind: 'git-worktree', rootPath: `/home/mt/worktrees/web/${task.taskId}`, repoRoot: '/srv/web', branch: `mt/${task.taskId}` },
      NOW,
    );
    // Escaped for Lark's markdown, as every piece of text is: an id's `_` would start emphasis.
    const id = task.taskId.replace(/_/g, '\\_');
    expect(show(task.taskId).split('\n')).toContain(`directory: /home/mt/worktrees/web/${id} · branch mt/${id}`);
    expect(show(newTask(h.db, { workspace: 'web' }).taskId)).not.toContain('directory:');
  });
});
