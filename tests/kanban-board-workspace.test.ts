import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claim, closeRun, complete, createBoard, createTask, setBoard } from '../src/db/kanban.js';
import { getTask } from '../src/db/kanban-read.js';
import { resolveTaskWorkspace } from '../src/kanban/workspace.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, WORKSPACES, claimantFor, claimed, newTask } from './helpers/kanban.js';

/**
 * A board's workspace (spec §16) is where its tasks work when nothing else says:
 * it takes the place of `default` in spec §2.3's rule 4, and of nothing before it.
 */

let h: TestDb;

beforeEach(() => {
  h = testDb();
  const made = createBoard(h.db, 'docs-site', ALICE, NOW);
  const set = setBoard(h.db, 'docs-site', { workspace: 'docs' }, ALICE, NOW);
  if (!made.ok || !set.ok) throw new Error('no board');
});

afterEach(() => h.close());

describe('resolveTaskWorkspace with a board workspace', () => {
  it('uses it last, in place of default, and never over a conflict', () => {
    const facts = { own: null, roleWorkspace: undefined, upstream: [], boardWorkspace: 'docs' };
    expect(resolveTaskWorkspace(facts)).toEqual({ workspace: 'docs' });
    expect(resolveTaskWorkspace({ ...facts, upstream: ['web'] })).toEqual({ workspace: 'web' });
    expect(resolveTaskWorkspace({ ...facts, roleWorkspace: 'api' })).toEqual({ workspace: 'api' });
    expect(resolveTaskWorkspace({ ...facts, own: 'web' })).toEqual({ workspace: 'web' });
    expect(resolveTaskWorkspace({ ...facts, upstream: ['web', 'api'] })).toEqual({ conflict: ['api', 'web'] });
    expect(resolveTaskWorkspace({ ...facts, boardWorkspace: null })).toEqual({ workspace: 'default' });
  });
});

describe('a claim on a board with a workspace', () => {
  it("fixes the board's workspace on a task nothing else places, for an agent and for a person", () => {
    const agent = newTask(h.db, { board: 'docs-site' });
    expect(claimed(h.db, agent.taskId).workspace).toBe('docs');
    const person = newTask(h.db, { board: 'docs-site', assignee: { kind: 'human', name: ALICE } });
    expect(claimed(h.db, person.taskId).workspace).toBe('docs');
    expect(getTask(h.db, person.taskId)?.workspace).toBe('docs');
  });

  it("leaves a task's own workspace, its role's, and its parents' before the board's", () => {
    const own = newTask(h.db, { board: 'docs-site', workspace: 'web' });
    expect(claimed(h.db, own.taskId).workspace).toBe('web');
    const role = newTask(h.db, { board: 'docs-site' });
    expect(claimed(h.db, role.taskId, { roleWorkspace: 'api' }).workspace).toBe('api');
    const parent = newTask(h.db, { board: 'docs-site', workspace: 'default' });
    const run = claimed(h.db, parent.taskId);
    expect(complete(h.db, parent.taskId, { kind: 'run', runId: run.runId }, { summary: 'ok' }, NOW).ok).toBe(true);
    expect(closeRun(h.db, run.runId, NOW).ok).toBe(true);
    const child = newTask(h.db, { board: 'docs-site', parents: [parent.taskId] });
    expect(claimed(h.db, child.taskId).workspace).toBe('default');
  });

  it("makes an agent task unassignable once the board's workspace is no longer configured", () => {
    const task = newTask(h.db, { board: 'docs-site' });
    const configured = new Set([...WORKSPACES].filter((w) => w !== 'docs'));
    const r = claim(h.db, { taskId: task.taskId, claimant: claimantFor(h.db, task.taskId), workspaces: configured }, NOW);
    expect(r).toMatchObject({ ok: false, code: 'unassignable' });
    expect(getTask(h.db, task.taskId)?.workspace).toBeNull();
  });

  it('places nothing on another board, default included', () => {
    const task = createTask(h.db, { title: 'x', assignee: { kind: 'role', name: 'implementer' }, createdBy: ALICE, createdVia: VIA }, NOW);
    expect(task.ok && claimed(h.db, task.task.taskId).workspace).toBe('default');
  });
});
