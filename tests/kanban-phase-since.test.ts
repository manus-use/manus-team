import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ageText } from '../src/cli/plain.js';
import {
  addComment,
  archive,
  block,
  closeRun,
  complete,
  createBoard,
  endRun,
  link,
  requestChanges,
  requestReview,
  stop,
  unblock,
  DEFAULT_LIMITS,
} from '../src/db/kanban.js';
import { phaseSince } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import type { Reporter } from '../src/kanban/types.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { ALICE, claimed, newTask, NOW } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * Times in the task list (kanban spec §22.3): `status_since`, the time of a
 * task's latest phase-changing event, read for a whole board in one query; and
 * the plain list's `age` column, in minutes, hours or days.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let t: TestDb;
beforeEach(() => {
  clearSecrets();
  t = testDb();
});
afterEach(() => t.close());

const since = (taskId: string): number | undefined => phaseSince(t.db, 'default').get(taskId);
const by = (runId: string): Reporter => ({ kind: 'run', runId });
const OPERATOR: Reporter = { kind: 'person', principal: ALICE, as: 'operator' };
const ok = (r: { ok: boolean; message?: string }): void => {
  if (!r.ok) throw new Error(r.message);
};

describe('phaseSince', () => {
  it('is moved by each of the nine kinds that set a phase, at its time', () => {
    let at = NOW;
    const step = (): number => (at += HOUR);
    const task = newTask(t.db, { failureLimit: 1, reviewer: { kind: 'role', name: 'reviewer' } }, at);
    expect(since(task.taskId)).toBe(NOW);
    // blocked, then unblocked
    let run = claimed(t.db, task.taskId, {}, step());
    ok(block(t.db, task.taskId, by(run.runId), { kind: 'needs_input', reason: 'which venue?' }, step()));
    expect(since(task.taskId)).toBe(at);
    ok(closeRun(t.db, run.runId, at));
    ok(unblock(t.db, task.taskId, ALICE, undefined, step()));
    expect(since(task.taskId)).toBe(at);
    // stopped
    run = claimed(t.db, task.taskId, {}, step());
    ok(stop(t.db, task.taskId, ALICE, step()));
    expect(since(task.taskId)).toBe(at);
    ok(closeRun(t.db, run.runId, at));
    ok(unblock(t.db, task.taskId, ALICE, undefined, step()));
    // a run whose end blocked the task
    run = claimed(t.db, task.taskId, {}, step());
    ok(endRun(t.db, run.runId, { outcome: 'failed', error: 'exit 1' }, { ...DEFAULT_LIMITS, failureLimit: 1 }, step()));
    expect(since(task.taskId)).toBe(at);
    ok(closeRun(t.db, run.runId, at));
    ok(unblock(t.db, task.taskId, ALICE, undefined, step()));
    // review requested, then changes requested
    run = claimed(t.db, task.taskId, {}, step());
    ok(requestReview(t.db, task.taskId, by(run.runId), { summary: 'booked' }, step()));
    expect(since(task.taskId)).toBe(at);
    ok(closeRun(t.db, run.runId, at));
    ok(requestChanges(t.db, task.taskId, OPERATOR, 'a cheaper one', step()));
    expect(since(task.taskId)).toBe(at);
    // completed by the reviewer's approval, then archived
    run = claimed(t.db, task.taskId, {}, step());
    ok(requestReview(t.db, task.taskId, by(run.runId), { summary: 'cheaper' }, step()));
    ok(closeRun(t.db, run.runId, at));
    ok(complete(t.db, task.taskId, OPERATOR, { summary: 'approved' }, step()));
    expect(since(task.taskId)).toBe(at);
    ok(archive(t.db, task.taskId, ALICE, step()));
    expect(since(task.taskId)).toBe(at);
  });

  it('is the second block for a task blocked, unblocked and blocked again', () => {
    const task = newTask(t.db, {}, NOW);
    for (const at of [NOW + HOUR, NOW + 3 * HOUR]) {
      const run = claimed(t.db, task.taskId, {}, at - MIN);
      ok(block(t.db, task.taskId, by(run.runId), { kind: 'needs_input', reason: 'why' }, at));
      ok(closeRun(t.db, run.runId, at));
      if (at === NOW + HOUR) ok(unblock(t.db, task.taskId, ALICE, undefined, NOW + 2 * HOUR));
    }
    expect(since(task.taskId)).toBe(NOW + 3 * HOUR);
  });

  it('is not moved by a dependency block, a claim, a comment or a link', () => {
    const task = newTask(t.db, {}, NOW);
    const parent = newTask(t.db, { title: 'parent' }, NOW);
    const other = newTask(t.db, { title: 'other' }, NOW);
    const run = claimed(t.db, task.taskId, {}, NOW + HOUR);
    ok(addComment(t.db, task.taskId, ALICE, 'note', NOW + 2 * HOUR, true));
    ok(link(t.db, other.taskId, parent.taskId, ALICE, NOW + 3 * HOUR));
    ok(block(t.db, task.taskId, by(run.runId), { kind: 'dependency', reason: 'needs the parent', parents: [parent.taskId] }, NOW + 4 * HOUR));
    expect([since(task.taskId), since(parent.taskId)]).toEqual([NOW, NOW]);
  });

  it("reads a board's tasks in one query, whatever its size, and none of another board's", () => {
    ok(createBoard(t.db, 'web-app', ALICE, NOW));
    const ids = Array.from({ length: 50 }, (_, i) => newTask(t.db, { title: `task ${i}` }, NOW + i).taskId);
    const elsewhere = newTask(t.db, { board: 'web-app' }, NOW);
    const prepare = vi.spyOn(t.db, 'prepare');
    const all = phaseSince(t.db, 'default');
    expect(prepare).toHaveBeenCalledTimes(1);
    prepare.mockRestore();
    expect(all.size).toBe(50);
    expect(all.get(ids[49] ?? '')).toBe(NOW + 49);
    expect(all.has(elsewhere.taskId)).toBe(false);
  });
});

describe('ageText', () => {
  it('says whole minutes under an hour, whole hours under a day, and whole days after', () => {
    expect([0, MIN - 1, MIN, 45 * MIN, HOUR - 1].map(ageText)).toEqual(['0m', '0m', '1m', '45m', '59m']);
    expect([HOUR, 5 * HOUR + 59 * MIN, DAY - 1].map(ageText)).toEqual(['1h', '5h', '23h']);
    expect([DAY, 3 * DAY + 23 * HOUR, 400 * DAY].map(ageText)).toEqual(['1d', '3d', '400d']);
    expect(ageText(-5 * MIN)).toBe('0m');
  });
});

describe('mt kanban task list', () => {
  let fx: MtFixture;
  let db: Db;
  afterEach(() => {
    db?.close();
    fx?.cleanup();
  });

  it('gives created_at and status_since in milliseconds, and an age column between the status and the assignee', async () => {
    fx = mtFixture();
    db = openDb(join(fx.home, 'team.db'));
    migrate(db, SCHEMA_DIR);
    const now = Date.now();
    const old = newTask(db, { title: 'Old', assignee: { kind: 'role', name: 'default' } }, now - 3 * DAY - HOUR);
    const run = claimed(db, old.taskId, {}, now - 3 * DAY);
    ok(block(db, old.taskId, by(run.runId), { kind: 'needs_input', reason: 'which?' }, now - 5 * HOUR - MIN));
    const fresh = newTask(db, { title: 'Fresh', assignee: null }, now - 45 * MIN - 30_000);
    const json = JSON.parse((await fx.run(['kanban', 'task', 'list', '--json'])).out);
    expect(json.tasks).toEqual([
      { task_id: fresh.taskId, status: 'ready', title: 'Fresh', assignee: null, assignee_kind: null, created_at: now - 45 * MIN - 30_000, status_since: now - 45 * MIN - 30_000, reacts_to: null },
      { task_id: old.taskId, status: 'blocked', title: 'Old', assignee: 'default', assignee_kind: 'role', created_at: now - 3 * DAY - HOUR, status_since: now - 5 * HOUR - MIN, reacts_to: null },
    ]);
    const lines = (await fx.run(['kanban', 'task', 'list'])).out.split('\n');
    expect(lines[0]).toMatch(/^task\s+status\s+age\s+assignee\s+title$/);
    expect(lines[1]).toMatch(new RegExp(`^${fresh.taskId}\\s+ready\\s+45m\\s+nobody\\s+Fresh$`));
    expect(lines[2]).toMatch(new RegExp(`^${old.taskId}\\s+blocked\\s+5h\\s+role default\\s+Old$`));
  });
});
