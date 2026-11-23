import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addComment, applyDag, createTask, setWake } from '../src/db/kanban.js';
import { eventsOf, getTask, subscriptionsOf } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import type { Dag } from '../src/kanban/dag.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, newTask } from './helpers/kanban.js';

/**
 * `setWake`, the writer's (wake spec §3.1, §3.3, §3.4, §4.3): wake turned on and
 * off with its `wake_set` event, the setter replaced, the same setter again
 * changing nothing, the cursor set to the `wake_set` in its transaction, a task
 * too deep left as it is with a note, and a task no chat of this bot follows
 * refused.
 */

const APP = 'cli_app';
const BOB = 'lark:on_bob';
const ON = { on: true, as: ALICE, maxDepth: 5 } as const;

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

function wakeSets(taskId: string): Array<{ id: number; actor: string; payload: unknown }> {
  return eventsOf(h.db, taskId)
    .filter((e) => e.kind === 'wake_set')
    .map((e) => ({ id: e.id, actor: e.actor, payload: e.payload }));
}

describe('setWake', () => {
  it("turns wake on, as its setter, with a wake_set by its actor, and sets the cursor to that event", () => {
    const task = newTask(h.db);
    addComment(h.db, task.taskId, ALICE, 'an old comment', NOW, false);
    const r = setWake(h.db, task.taskId, ON, ALICE, APP, NOW + 1);
    expect(r).toMatchObject({ ok: true, changed: true, tooDeep: false, task: { wakeBy: ALICE, wakeDepth: 0 } });
    const [set] = wakeSets(task.taskId);
    expect(set).toMatchObject({ actor: ALICE, payload: { on: true, as: ALICE, depth: 0 } });
    // The wake_set is the task's latest event, and the cursor is on it: nothing older is replayed.
    expect(eventsOf(h.db, task.taskId).at(-1)?.id).toBe(set?.id);
    expect(subscriptionsOf(h.db, task.taskId).map((s) => s.wakeCursor)).toEqual([set?.id]);
  });

  it('records who set it apart from whom it runs as', () => {
    const task = newTask(h.db);
    setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5 }, 'operator:x', APP, NOW);
    expect(wakeSets(task.taskId)).toEqual([expect.objectContaining({ actor: 'operator:x', payload: { on: true, as: ALICE, depth: 0 } })]);
  });

  it('changes nothing, and writes no event, for the same setter again', () => {
    const task = newTask(h.db);
    setWake(h.db, task.taskId, ON, ALICE, APP, NOW);
    const cursor = subscriptionsOf(h.db, task.taskId)[0]?.wakeCursor;
    addComment(h.db, task.taskId, ALICE, 'later', NOW + 1, false);
    expect(setWake(h.db, task.taskId, ON, ALICE, APP, NOW + 2)).toMatchObject({ ok: true, changed: false, task: { wakeBy: ALICE } });
    expect(wakeSets(task.taskId)).toHaveLength(1);
    expect(subscriptionsOf(h.db, task.taskId)[0]?.wakeCursor).toBe(cursor);
  });

  it('replaces another setter, and starts the cursor again at the latest event', () => {
    const task = newTask(h.db);
    setWake(h.db, task.taskId, ON, ALICE, APP, NOW);
    addComment(h.db, task.taskId, ALICE, 'later', NOW + 1, false);
    const r = setWake(h.db, task.taskId, { on: true, as: BOB, maxDepth: 5 }, BOB, APP, NOW + 2);
    expect(r).toMatchObject({ ok: true, changed: true, task: { wakeBy: BOB } });
    const sets = wakeSets(task.taskId);
    expect(sets).toHaveLength(2);
    expect(subscriptionsOf(h.db, task.taskId)[0]?.wakeCursor).toBe(sets[1]?.id);
  });

  it('turns wake off, leaving the cursor where it is, and off again changes nothing', () => {
    const task = newTask(h.db);
    setWake(h.db, task.taskId, ON, ALICE, APP, NOW);
    const cursor = subscriptionsOf(h.db, task.taskId)[0]?.wakeCursor;
    expect(setWake(h.db, task.taskId, { on: false }, BOB, APP, NOW + 1)).toMatchObject({ ok: true, changed: true, task: { wakeBy: null } });
    expect(wakeSets(task.taskId).at(-1)).toMatchObject({ actor: BOB, payload: { on: false } });
    expect(subscriptionsOf(h.db, task.taskId)[0]?.wakeCursor).toBe(cursor);
    expect(setWake(h.db, task.taskId, { on: false }, BOB, APP, NOW + 2)).toMatchObject({ ok: true, changed: false });
    expect(wakeSets(task.taskId)).toHaveLength(2);
  });

  it('leaves a task too deep with wake off, its wake_set the note, and its cursor unmoved', () => {
    const task = newTask(h.db, { wake: { by: null, depth: 5 } });
    const r = setWake(h.db, task.taskId, ON, ALICE, APP, NOW);
    expect(r).toMatchObject({ ok: true, changed: false, tooDeep: true, task: { wakeBy: null, wakeDepth: 5 } });
    expect(wakeSets(task.taskId)).toEqual([expect.objectContaining({ actor: ALICE, payload: { on: false, refused: 'too_deep', depth: 5 } })]);
    expect(subscriptionsOf(h.db, task.taskId)[0]?.wakeCursor).toBe(0);
  });

  it('leaves a wake already set as it is, writing nothing, when max_depth was lowered past its depth', () => {
    const task = newTask(h.db, { wake: { by: ALICE, depth: 3 } });
    const before = wakeSets(task.taskId);
    const r = setWake(h.db, task.taskId, { on: true, as: BOB, maxDepth: 2 }, BOB, APP, NOW + 1);
    expect(r).toMatchObject({ ok: true, changed: false, tooDeep: true, task: { wakeBy: ALICE, wakeDepth: 3 } });
    expect(wakeSets(task.taskId)).toEqual(before);
    expect(getTask(h.db, task.taskId)?.wakeBy).toBe(ALICE);
  });

  it('turns wake on for a task at a depth below the limit', () => {
    const task = newTask(h.db, { wake: { by: null, depth: 4 } });
    expect(setWake(h.db, task.taskId, ON, ALICE, APP, NOW)).toMatchObject({ ok: true, changed: true, task: { wakeBy: ALICE, wakeDepth: 4 } });
  });

  it("refuses wake on for a task no chat of this bot follows, and leaves it as it was", () => {
    const task = newTask(h.db, { createdVia: { kind: 'operator' } });
    expect(setWake(h.db, task.taskId, ON, ALICE, APP, NOW)).toEqual({
      ok: false,
      code: 'invalid',
      message: `a wake needs a chat that follows the task, and no chat follows ${task.taskId}: a chat is chosen when a task is made`,
    });
    const other = newTask(h.db);
    expect(setWake(h.db, other.taskId, ON, ALICE, 'cli_other', NOW)).toMatchObject({ ok: false, code: 'invalid' });
    expect(getTask(h.db, task.taskId)?.wakeBy).toBeNull();
    expect(wakeSets(task.taskId)).toEqual([]);
    // Off needs no chat.
    expect(setWake(h.db, task.taskId, { on: false }, ALICE, APP, NOW)).toMatchObject({ ok: true, changed: false });
  });

  it('refuses a task that does not exist', () => {
    expect(setWake(h.db, 'k_nope', ON, ALICE, APP, NOW)).toEqual({ ok: false, code: 'not_found', message: 'no task k_nope' });
  });
});

const NOT_MIGRATED = 'the database is not yet migrated to version 13: start the gateway once, so it is migrated';

/** A database migrated to 012 only, as the terminal may open one before the gateway migrated it. */
function withV12(fn: (d: Db) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mt-wake-v12-'));
  try {
    const only = mkdtempSync(join(dir, 'schema-'));
    for (const f of readdirSync(SCHEMA_DIR)) {
      if (/^0(0[1-9]|1[0-2])_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
    }
    const d = openDb(join(dir, 'team.db'));
    try {
      expect(migrate(d, only)).toBe(12);
      fn(d);
    } finally {
      d.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const count = (d: Db, table: string): unknown => d.prepare(`SELECT count(*) AS n FROM ${table}`).get();

describe('a wake on a database not yet migrated to 013', () => {
  it('refuses setWake on, and still answers off', () => {
    withV12((d) => {
      const task = newTask(d);
      expect(setWake(d, task.taskId, ON, ALICE, APP, NOW)).toEqual({ ok: false, code: 'invalid', message: NOT_MIGRATED });
      expect(setWake(d, task.taskId, { on: false }, ALICE, APP, NOW)).toMatchObject({ ok: true, changed: false });
    });
  });

  it('refuses createTask given a wake or a depth, and makes nothing, though a task with none is made', () => {
    withV12((d) => {
      const base = { title: 'a task', assignee: { kind: 'role', name: 'implementer' }, createdBy: ALICE, createdVia: VIA } as const;
      expect(createTask(d, { ...base, wake: { by: ALICE, depth: 0 } }, NOW)).toEqual({ ok: false, code: 'invalid', message: NOT_MIGRATED });
      expect(createTask(d, { ...base, wake: { by: null, depth: 2 } }, NOW)).toEqual({ ok: false, code: 'invalid', message: NOT_MIGRATED });
      expect(count(d, 'kanban_tasks')).toEqual({ n: 0 });
      expect(createTask(d, { ...base, wake: { by: null, depth: 0 } }, NOW).ok).toBe(true);
    });
  });

  it('refuses applyDag with a member given a wake, and makes no instance', () => {
    withV12((d) => {
      const r = applyDag(
        d,
        { name: 'flow', dag: { format: 1, tasks: [] } as unknown as Dag, sha256: 'x', source: 'start', board: 'default', createdBy: ALICE, createdVia: VIA, idempotencyKey: null },
        [{ task: { title: 'a', assignee: { kind: 'role', name: 'implementer' }, wake: { by: ALICE, depth: 0 } }, ref: 'a', step: 'a', item: null, parents: [], gates: [] }],
        NOW,
      );
      expect(r).toEqual({ ok: false, code: 'invalid', message: NOT_MIGRATED });
      expect(count(d, 'kanban_workflow_instances')).toEqual({ n: 0 });
      expect(count(d, 'kanban_tasks')).toEqual({ n: 0 });
    });
  });
});
