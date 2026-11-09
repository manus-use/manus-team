import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTask } from '../src/db/kanban-read.js';
import { KanbanService } from '../src/kanban/service.js';
import { hashToken, mintToken } from '../src/kanban/token.js';
import { WorkerApi, type WorkerResponse } from '../src/kanban/worker.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * A board run's agent and boards (spec §16): it names no board. Its show says
 * which board its task is on, and what it creates goes there; a parent or a link
 * on another board is refused, as for anyone.
 */

let t: TestDb;
let service: KanbanService;
let api: WorkerApi;

beforeEach(() => {
  t = testDb();
  service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
  });
  api = new WorkerApi({ db: t.db, service });
  for (const name of ['web-app', 'billing']) {
    if (!service.createBoard(name, ALICE).ok) throw new Error(`no board ${name}`);
  }
});

afterEach(() => t.close());

function task(board: string): string {
  const r = service.create({ title: 'a task', assignee: 'implementer', workspace: 'web', board, createdBy: ALICE, createdVia: VIA });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.task.taskId;
}

/** Claim the task's run with a token, and a way to ask as that run. */
function asRun(taskId: string): (command: string, input?: unknown) => Promise<WorkerResponse> {
  const token = mintToken();
  const r = service.claim(taskId, { tokenHash: hashToken(token) });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return (command, input = {}) => api.handle({ run: r.run.runId, token, command, input });
}

describe('worker API: boards', () => {
  it("shows the run's task's board", async () => {
    const ask = asRun(task('web-app'));
    expect(await ask('show')).toMatchObject({ ok: true, task: { board: 'web-app' } });
  });

  it("creates a follow-up on its task's board, and refuses a parent or a link on another", async () => {
    const ask = asRun(task('web-app'));
    const made = await ask('create', { title: 'follow-up', body: '', assignee: 'implementer' });
    expect(made).toMatchObject({ ok: true });
    const child = made.ok ? String(made['task_id']) : '';
    expect(getTask(t.db, child)?.board).toBe('web-app');

    const elsewhere = task('billing');
    expect(await ask('create', { title: 'x', body: '', assignee: 'implementer', parents: [elsewhere] })).toMatchObject({
      ok: false,
      code: 'other_board',
    });
    expect(await ask('link', { parent_id: elsewhere, child_id: child })).toMatchObject({ ok: false, code: 'other_board' });
  });
});
