import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getInstance,
  hasRouting,
  pendingOf,
  plannedMemberOf,
  routeOfHandler,
  routesFrom,
  routesOf,
  settledOf,
} from '../src/db/kanban-read.js';
import { migrate, openDb } from '../src/db/open.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { NOW, newTask } from './helpers/kanban.js';

/**
 * The routing's rows read back (workflow routing spec §8): an instance's plan
 * and fault mark, its pending, settled and route rows, a handler's route by its
 * task, and a member with its planned instance in one read; and nothing of them
 * on a database the gateway has not yet migrated to 015.
 */

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

const PLAN = { format: 1, steps: [{ step: 'intake', made: 'start', parents: [], outputs: { verify: 'boolean' }, on_blocked: 'wait', on_gave_up: 'wait' }] };

function insert(table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  h.db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row));
}

function instance(id: string, plan: unknown = null, failedAt: number | null = null): void {
  insert('kanban_workflow_instances', {
    instance_id: id,
    name: 'vi-workflow',
    dag: '{"format":1}',
    dag_sha256: 'x',
    source: 'start',
    board: 'default',
    created_by: 'lark:on_alice',
    created_via: '{"kind":"operator"}',
    created_at: NOW,
    plan: plan === null ? null : JSON.stringify(plan),
    routing_failed_at: failedAt,
  });
}

function member(taskId: string, instanceId: string, ref: string, step: string, position: number): void {
  insert('kanban_workflow_tasks', { task_id: taskId, instance_id: instanceId, ref, step, item: null, position });
}

describe('the routing rows', () => {
  it("reads an instance's plan and its fault mark, null for an instance with none", () => {
    instance('w_1', PLAN, NOW + 5);
    instance('w_2');
    expect(getInstance(h.db, 'w_1')).toMatchObject({ instanceId: 'w_1', plan: PLAN, routingFailedAt: NOW + 5 });
    expect(getInstance(h.db, 'w_2')).toMatchObject({ instanceId: 'w_2', plan: null, routingFailedAt: null });
    expect(hasRouting(h.db)).toBe(true);
  });

  it('reads the pending, settled and route rows of an instance, decoded', () => {
    instance('w_1', PLAN);
    const [a, b] = [newTask(h.db), newTask(h.db)];
    insert('kanban_workflow_pending', { instance_id: 'w_1', step: 'verify', state: 'waiting' });
    insert('kanban_workflow_pending', {
      instance_id: 'w_1',
      step: 'exposure',
      state: 'made',
      reason: JSON.stringify({ why: 'intake.packages has 1 item' }),
      items: JSON.stringify([{ item: 'lodash', taskId: a.taskId, ref: 'exposure:1' }]),
      cause_event: 4,
      decided_at: NOW,
    });
    insert('kanban_workflow_settled', { instance_id: 'w_1', step: 'intake', ref: 'intake', how: 'done', task_id: a.taskId, event_id: 4, settled_at: NOW });
    insert('kanban_workflow_routes', { instance_id: 'w_1', handler: 'escalate', event_id: 7, from_task: a.taskId, outcome: 'made', task_id: b.taskId, created_at: NOW });
    insert('kanban_workflow_routes', { instance_id: 'w_1', handler: 'escalate', event_id: 9, from_task: a.taskId, outcome: 'over_limit', created_at: NOW });
    expect(pendingOf(h.db, 'w_1')).toEqual([
      {
        instanceId: 'w_1',
        step: 'exposure',
        state: 'made',
        reason: { why: 'intake.packages has 1 item' },
        items: [{ item: 'lodash', taskId: a.taskId, ref: 'exposure:1' }],
        causeEvent: 4,
        decidedAt: NOW,
      },
      { instanceId: 'w_1', step: 'verify', state: 'waiting', reason: null, items: null, causeEvent: null, decidedAt: null },
    ]);
    expect(settledOf(h.db, 'w_1')).toEqual([
      { instanceId: 'w_1', step: 'intake', ref: 'intake', how: 'done', taskId: a.taskId, eventId: 4, settledAt: NOW },
    ]);
    const made = { instanceId: 'w_1', handler: 'escalate', eventId: 7, fromTask: a.taskId, outcome: 'made', taskId: b.taskId, createdAt: NOW };
    const over = { instanceId: 'w_1', handler: 'escalate', eventId: 9, fromTask: a.taskId, outcome: 'over_limit', taskId: null, createdAt: NOW };
    expect(routesOf(h.db, 'w_1')).toEqual([made, over]);
    expect(routesFrom(h.db, a.taskId)).toEqual([made, over]);
    expect(routesFrom(h.db, b.taskId)).toEqual([]);
    expect(routeOfHandler(h.db, b.taskId)).toEqual(made);
    expect(routeOfHandler(h.db, a.taskId)).toBeUndefined();
  });

  it('finds a member with its instance only when the instance has a plan', () => {
    instance('w_1', PLAN);
    instance('w_2');
    const [a, b, c] = [newTask(h.db), newTask(h.db), newTask(h.db)];
    member(a.taskId, 'w_1', 'intake', 'intake', 0);
    member(b.taskId, 'w_2', 'shortlist', 'shortlist', 0);
    expect(plannedMemberOf(h.db, a.taskId)).toMatchObject({
      member: { taskId: a.taskId, instanceId: 'w_1', ref: 'intake', step: 'intake', item: null, position: 0 },
      instance: { instanceId: 'w_1', name: 'vi-workflow', plan: PLAN, board: 'default' },
    });
    expect(plannedMemberOf(h.db, b.taskId)).toBeUndefined();
    expect(plannedMemberOf(h.db, c.taskId)).toBeUndefined();
  });

  it('reads a database at version 14 as having no plan and no row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-routing-rows-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) {
        if (/^01[0-4]_.*\.sql$/.test(f) || /^00[1-9]_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      }
      const d = openDb(join(dir, 'team.db'));
      try {
        expect(migrate(d, only)).toBe(14);
        d.prepare(
          `INSERT INTO kanban_workflow_instances (instance_id, name, dag, dag_sha256, source, board, created_by, created_via, created_at)
           VALUES ('w_old', 'vendor-eval', '{"format":1}', 'x', 'start', 'default', 'lark:on_alice', '{"kind":"operator"}', ?)`,
        ).run(NOW);
        const task = newTask(d);
        d.prepare("INSERT INTO kanban_workflow_tasks (task_id, instance_id, ref, step, item, position) VALUES (?, 'w_old', 'a', 'a', NULL, 0)").run(task.taskId);
        expect(hasRouting(d)).toBe(false);
        expect(getInstance(d, 'w_old')).toMatchObject({ instanceId: 'w_old', plan: null, routingFailedAt: null });
        expect([pendingOf(d, 'w_old'), settledOf(d, 'w_old'), routesOf(d, 'w_old'), routesFrom(d, task.taskId)]).toEqual([[], [], [], []]);
        expect(routeOfHandler(d, task.taskId)).toBeUndefined();
        expect(plannedMemberOf(d, task.taskId)).toBeUndefined();
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
