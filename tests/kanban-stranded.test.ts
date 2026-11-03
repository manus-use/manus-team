import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventsOf, getRun, getTask } from '../src/db/kanban-read.js';
import { KanbanService } from '../src/kanban/service.js';
import type { Role } from '../src/roles.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { ALICE, WORKSPACES, newTask } from './helpers/kanban.js';

let h: TestDb;
let clock: ManualClock;
let service: KanbanService;

const IMPLEMENTER: Role = {
  name: 'implementer',
  source: 'directory',
  dir: undefined,
  description: undefined,
  workspace: undefined,
  agent: {
    driver: 'structured-cli',
    command: 'bytesec',
    args: ['run'],
    env: {},
    unsupervised: true,
    passEnv: [],
    readOnlyTools: [],
    maskExempt: [],
  },
  roleMdPath: undefined,
  skills: [],
  secretValues: [],
};

beforeEach(() => {
  h = testDb();
  clock = new ManualClock();
  service = new KanbanService({
    db: h.db,
    roles: new Map([['implementer', IMPLEMENTER]]),
    workspaces: WORKSPACES,
    clock,
  });
});

afterEach(() => h.close());

const MINUTE = 60_000;

/** A ready task for a role that is not configured: the claim notes it unassignable. */
function stranded(): string {
  const task = newTask(h.db, { assignee: { kind: 'role', name: 'gone' } }, clock.now());
  const r = service.claim(task.taskId);
  expect(r).toMatchObject({ ok: false, code: 'unassignable' });
  return task.taskId;
}

function kinds(taskId: string): string[] {
  return eventsOf(h.db, taskId).map((e) => e.kind);
}

describe('noteStranded', () => {
  it('tells once, after the task has sat unclaimable since the cutoff', () => {
    const taskId = stranded();
    const skippedAt = clock.now();
    clock.advance(30 * MINUTE);

    // Not yet: the skip is after the cutoff.
    expect(service.noteStranded(taskId, 'role "gone" is not configured', skippedAt - 1)).toEqual({
      ok: true,
      written: false,
    });
    expect(service.noteStranded(taskId, 'role "gone" is not configured', skippedAt)).toEqual({
      ok: true,
      written: true,
    });
    expect(getTask(h.db, taskId)?.strandedNotifiedAt).toBe(clock.now());
    const last = eventsOf(h.db, taskId).at(-1);
    expect(last).toMatchObject({ kind: 'stranded', actor: 'gateway', payload: { reason: 'role "gone" is not configured' } });

    // Once: a second sweep, and a second pass noting the skip, add nothing.
    expect(service.noteStranded(taskId, 'role "gone" is not configured', clock.now())).toEqual({
      ok: true,
      written: false,
    });
    expect(service.claim(taskId)).toMatchObject({ ok: false, code: 'unassignable' });
    expect(kinds(taskId)).toEqual(['created', 'skipped_unassignable', 'stranded']);
  });

  it('does not tell when something has happened since the skip', () => {
    const taskId = stranded();
    const cutoff = clock.now();
    clock.advance(MINUTE);
    expect(service.comment(taskId, 'looking at it', ALICE).ok).toBe(true);
    expect(service.noteStranded(taskId, 'role "gone" is not configured', cutoff + MINUTE)).toEqual({
      ok: true,
      written: false,
    });
  });

  it('does not tell for a task that is not waiting to be claimed', () => {
    const taskId = stranded();
    expect(service.archive(taskId, ALICE).ok).toBe(true);
    expect(service.noteStranded(taskId, 'role "gone" is not configured', clock.now())).toEqual({
      ok: true,
      written: false,
    });
  });

  it('is cleared by a claim, so a task stranded again is told again', () => {
    const taskId = stranded();
    expect(service.noteStranded(taskId, 'role "gone" is not configured', clock.now()).ok).toBe(true);
    expect(service.assign(taskId, 'implementer', ALICE).ok).toBe(true);
    const r = service.claim(taskId);
    if (!r.ok) throw new Error(r.message);
    expect(getTask(h.db, taskId)?.strandedNotifiedAt).toBeNull();
  });

  it('refuses a task that does not exist', () => {
    expect(service.noteStranded('k_none', 'x', clock.now())).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('countSubmission', () => {
  it("counts each prompt into an agent run, returning the count before it, for the prompt's key", () => {
    const task = newTask(h.db);
    const r = service.claim(task.taskId);
    if (!r.ok) throw new Error(r.message);
    expect(service.countSubmission(r.run.runId)).toEqual({ ok: true, n: 0 });
    expect(service.countSubmission(r.run.runId)).toEqual({ ok: true, n: 1 });
    expect(getRun(h.db, r.run.runId)?.submissions).toBe(2);
    expect(eventsOf(h.db, task.taskId).filter((e) => e.kind === 'submitted').map((e) => e.payload)).toEqual([
      { n: 0 },
      { n: 1 },
    ]);
  });

  it('refuses a closed run, and one that does not exist', () => {
    const task = newTask(h.db);
    const r = service.claim(task.taskId);
    if (!r.ok) throw new Error(r.message);
    expect(service.endRun(r.run.runId, { outcome: 'failed' }).ok).toBe(true);
    expect(service.closeRun(r.run.runId).ok).toBe(true);
    expect(service.countSubmission(r.run.runId)).toMatchObject({ ok: false, code: 'already_closed' });
    expect(service.countSubmission('r_none')).toMatchObject({ ok: false, code: 'not_found' });
  });
});
