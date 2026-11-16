import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyDag, archiveBoard, archiveWorkflow, createBoard, createTask, type NewInstance, type NewMember } from '../src/db/kanban.js';
import {
  eventsOf,
  gatesOf,
  getInstance,
  getRun,
  getTask,
  hasWorkflows,
  instancesOn,
  memberOf,
  membersOf,
  parentsOf,
  relatedTasks,
  subscriptionsOf,
} from '../src/db/kanban-read.js';
import { migrate, openDb } from '../src/db/open.js';
import { checkDagShape, type Dag } from '../src/kanban/dag.js';
import type { CreatedVia } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed, newTask } from './helpers/kanban.js';

/**
 * The writer of a workflow's instance (spec §21.8): everything in one
 * transaction, a refusal rolling all of it back, each task's `created` event
 * carrying the instance, the gates' `created_by`, the key looked up again, the
 * stored DAG masked but for its gates; the archive of every member; and the
 * reads of an instance, its members and its related tasks.
 */

const SECRET = 'sk-live-1234567890';
let h: TestDb;
beforeEach(() => {
  clearSecrets();
  addSecrets([SECRET]);
  h = testDb();
});
afterEach(() => {
  clearSecrets();
  h.close();
});

/** A DAG of a root, two items after it, and a fan-in after both, its second item's gate given. */
function dag(extra: Record<string, unknown> = {}): { dag: Dag; sha256: string } {
  const r = checkDagShape(
    {
      format: 1,
      workflow: 'vendor-eval',
      params: { topic: `logs ${SECRET}` },
      board: 'default',
      tasks: [
        { ref: 'shortlist', title: 'Shortlist', assignee: 'worker' },
        { ref: 'evaluate:1', step: 'evaluate', item: 'acme', title: 'Evaluate acme', assignee: 'worker', parents: ['shortlist'] },
        {
          ref: 'evaluate:2',
          step: 'evaluate',
          item: `globex ${SECRET}`,
          title: `Evaluate globex ${SECRET}`,
          assignee: 'worker',
          parents: ['shortlist'],
          gates: [{ command: 'test -s evaluation.md', timeout_s: 30 }],
        },
        { ref: 'recommend', title: 'Recommend', assignee: 'worker', parents: ['evaluate:1', 'evaluate:2'] },
      ],
      ...extra,
    },
    'expansion',
  );
  if (!r.ok) throw new Error(r.message);
  return { dag: r.dag, sha256: r.sha256 };
}

function instance(over: Partial<NewInstance> = {}): NewInstance {
  const d = dag();
  return { name: 'vendor-eval', dag: d.dag, sha256: d.sha256, source: 'start', board: 'default', createdBy: ALICE, createdVia: VIA, idempotencyKey: null, ...over };
}

/** The writer's members for a DAG, as the service makes them. */
function members(d: Dag): NewMember[] {
  return d.tasks.map((t) => ({
    task: { title: t.title, assignee: t.assignee === null ? null : { kind: 'role', name: t.assignee } },
    ref: t.ref,
    step: t.step,
    item: t.item,
    parents: t.parents.map((p) => d.tasks.findIndex((x) => x.ref === p)),
    gates: t.gates.map((g) => ({ command: g.command, timeoutS: g.timeout_s })),
  }));
}

function apply(over: Partial<NewInstance> = {}, list?: NewMember[]) {
  const i = instance(over);
  const r = applyDag(h.db, i, list ?? members(i.dag), NOW);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r;
}

const count = (table: string): number => (h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const counts = () => ['kanban_tasks', 'kanban_links', 'kanban_gates', 'kanban_workflow_instances', 'kanban_workflow_tasks', 'kanban_events', 'kanban_subscriptions'].map(count);

describe('applyDag', () => {
  it('makes 100 tasks, each after every earlier one, 4,950 links, in one call', () => {
    const r = checkDagShape(
      { format: 1, tasks: Array.from({ length: 100 }, (_, i) => ({ ref: `t${i}`, title: `Task ${i}`, assignee: 'worker', parents: Array.from({ length: i }, (_, j) => `t${j}`) })) },
      'terminal',
    );
    if (!r.ok) throw new Error(r.message);
    const made = apply({ dag: r.dag, sha256: r.sha256, source: 'apply', name: null }, members(r.dag));
    expect(made.members).toHaveLength(100);
    expect(count('kanban_links')).toBe(4950);
    expect(count('kanban_workflow_tasks')).toBe(100);
    expect((h.db.prepare("SELECT count(*) AS n FROM kanban_events WHERE kind = 'created'").get() as { n: number }).n).toBe(100);
    expect(parentsOf(h.db, made.members[99]?.taskId ?? '')).toHaveLength(99);
  });

  it('makes every task, link, gate and member, in order, on the board', () => {
    const r = apply();
    expect(r.existing).toBe(false);
    expect(r.instance).toMatchObject({ name: 'vendor-eval', source: 'start', board: 'default', createdBy: ALICE, createdVia: VIA, idempotencyKey: null });
    expect(r.instance.instanceId).toMatch(/^w_/);
    expect(r.members.map((m) => [m.position, m.ref, m.step, m.item])).toEqual([
      [0, 'shortlist', 'shortlist', null],
      [1, 'evaluate:1', 'evaluate', 'acme'],
      [2, 'evaluate:2', 'evaluate', `globex ${MASK}`],
      [3, 'recommend', 'recommend', null],
    ]);
    const [shortlist, e1, e2, recommend] = r.members.map((m) => m.task);
    expect(parentsOf(h.db, recommend?.taskId ?? '').map((p) => p.taskId).sort()).toEqual([e1?.taskId, e2?.taskId].sort());
    expect(parentsOf(h.db, e1?.taskId ?? '').map((p) => p.taskId)).toEqual([shortlist?.taskId]);
    expect(e2?.title).toBe(`Evaluate globex ${MASK}`);
    expect(gatesOf(h.db, e2?.taskId ?? '')).toEqual([expect.objectContaining({ command: 'test -s evaluation.md', timeoutS: 30, createdBy: ALICE })]);
    expect(counts()).toEqual([4, 4, 1, 1, 4, 5, 4]);
    expect(membersOf(h.db, r.instance.instanceId).map((m) => m.taskId)).toEqual(r.members.map((m) => m.taskId));
  });

  it('writes each task its own created event, carrying the instance, and each gate its gate_added', () => {
    const r = apply();
    const e2 = r.members[2]?.task.taskId ?? '';
    const events = eventsOf(h.db, e2);
    expect(events.map((e) => e.kind)).toEqual(['created', 'gate_added']);
    expect(events[0]?.payload).toMatchObject({
      title: `Evaluate globex ${MASK}`,
      workflow: r.instance.instanceId,
      workflowName: 'vendor-eval',
      ref: 'evaluate:2',
      step: 'evaluate',
      item: `globex ${MASK}`,
    });
    expect(events[1]).toMatchObject({ actor: ALICE, payload: { command: 'test -s evaluation.md', timeoutS: 30, workflow: r.instance.instanceId } });
  });

  it('stores the DAG masked but for its gates, and the hash it was given, taken before masking', () => {
    const plain = dag();
    const r = apply({ dag: plain.dag, sha256: plain.sha256 });
    const stored = getInstance(h.db, r.instance.instanceId);
    expect(stored?.dagSha256).toBe(plain.sha256);
    expect(stored?.dag.params).toEqual({ topic: `logs ${MASK}` });
    expect(stored?.dag.tasks[2]).toMatchObject({ title: `Evaluate globex ${MASK}`, item: `globex ${MASK}`, gates: [{ command: 'test -s evaluation.md', timeout_s: 30 }] });
  });

  it('subscribes the chat to every task, and from a run gives each its task\'s subscriptions, on its board, created from it', () => {
    const r = apply();
    for (const m of r.members) expect(subscriptionsOf(h.db, m.taskId)).toEqual([expect.objectContaining({ conversationId: 'oc_chat', threadId: '' })]);
    const planner = newTask(h.db, { createdVia: { ...VIA, threadId: 'omt_topic', rootId: 'om_root' } as CreatedVia });
    const run = claimed(h.db, planner.taskId);
    const fromRun = apply({ createdVia: { kind: 'run', runId: run.runId }, createdBy: `run:${run.runId}`, board: 'elsewhere', source: 'apply', name: null });
    expect(fromRun.instance.board).toBe('default');
    for (const m of fromRun.members) {
      expect(m.task.createdFromTask).toBe(planner.taskId);
      expect(subscriptionsOf(h.db, m.taskId)).toEqual([expect.objectContaining({ threadId: 'omt_topic', rootMessageId: 'om_root' })]);
    }
    const operator = apply({ createdVia: { kind: 'operator' }, createdBy: 'operator:me' });
    for (const m of operator.members) expect(subscriptionsOf(h.db, m.taskId)).toEqual([]);
  });

  it('rolls everything back on a refusal inside the transaction', () => {
    const before = counts();
    const list = members(dag().dag);
    const tooMany = { ...list[3]!, gates: Array.from({ length: 21 }, () => ({ command: 'true', timeoutS: 1 })) };
    const r = applyDag(h.db, instance(), [list[0]!, list[1]!, list[2]!, tooMany], NOW);
    expect(r).toEqual({ ok: false, code: 'invalid', message: expect.stringMatching(/^recommend: task k_\w+ has 20 gates, the most a task may have$/) });
    expect(counts()).toEqual(before);
    createBoard(h.db, 'old', ALICE, NOW);
    archiveBoard(h.db, 'old', ALICE, NOW);
    expect(applyDag(h.db, instance({ board: 'old' }), members(dag().dag), NOW)).toEqual({
      ok: false,
      code: 'board_archived',
      message: 'board old is archived; nothing is added to it',
    });
    expect(applyDag(h.db, instance({ board: 'nowhere' }), members(dag().dag), NOW)).toMatchObject({ ok: false, code: 'unknown_board' });
    expect(counts()).toEqual(before);
  });

  it('is refused by the members\' unique ref, a backstop, rolling all of it back', () => {
    const before = counts();
    const list = members(dag().dag);
    expect(() => applyDag(h.db, instance(), [list[0]!, { ...list[1]!, ref: 'shortlist' }], NOW)).toThrow(/UNIQUE constraint failed: kanban_workflow_tasks.instance_id, kanban_workflow_tasks.ref/);
    expect(counts()).toEqual(before);
  });

  it('answers a repeated key with its instance, existing, making nothing; refuses another board, kind, workflow or DAG', () => {
    const first = apply({ idempotencyKey: 'operator:k' });
    const before = counts();
    const again = apply({ idempotencyKey: 'operator:k' });
    expect(again).toMatchObject({ existing: true, instance: { instanceId: first.instance.instanceId } });
    expect(again.members.map((m) => m.taskId)).toEqual(first.members.map((m) => m.taskId));
    expect(counts()).toEqual(before);
    createBoard(h.db, 'research', ALICE, NOW);
    const id = first.instance.instanceId;
    const refused = (over: Partial<NewInstance>) => applyDag(h.db, instance({ idempotencyKey: 'operator:k', ...over }), [], NOW);
    expect(refused({ board: 'research' })).toEqual({ ok: false, code: 'other_board', message: `instance ${id} was made with this idempotency key on board default, not research` });
    expect(refused({ source: 'apply' })).toEqual({
      ok: false,
      code: 'invalid',
      message: `this idempotency key was used to start a workflow, as ${id}; a key used by a start is not used by an apply, nor the reverse`,
    });
    expect(refused({ name: 'release' })).toEqual({ ok: false, code: 'invalid', message: `this idempotency key was used to start workflow vendor-eval, as ${id}, not release` });
    expect(counts()).toEqual(before);
    const applied = apply({ idempotencyKey: 'operator:a', source: 'apply' });
    const other = dag({ board: null });
    const after = counts();
    expect(applyDag(h.db, instance({ idempotencyKey: 'operator:a', source: 'apply', dag: other.dag, sha256: other.sha256 }), [], NOW)).toEqual({
      ok: false,
      code: 'invalid',
      message: `this idempotency key was used to apply another DAG, as ${applied.instance.instanceId}`,
    });
    expect(counts()).toEqual(after);
  });

  it("keeps an archived instance's key used", () => {
    const first = apply({ idempotencyKey: 'operator:k' });
    expect(archiveWorkflow(h.db, first.instance.instanceId, ALICE, NOW).ok).toBe(true);
    expect(apply({ idempotencyKey: 'operator:k' })).toMatchObject({ existing: true, instance: { instanceId: first.instance.instanceId } });
  });
});

describe('archiveWorkflow', () => {
  it('archives every member in one transaction, superseding an undecided run, and leaves related tasks alone', () => {
    const r = apply();
    const [shortlist] = r.members;
    const run = claimed(h.db, shortlist?.taskId ?? '');
    const follow = createTask(h.db, { title: 'A follow-up', createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } }, NOW);
    if (!follow.ok) throw new Error(follow.message);
    const done = archiveWorkflow(h.db, r.instance.instanceId, ALICE, NOW + 1);
    if (!done.ok) throw new Error(done.message);
    expect(done.archived.map((t) => t.taskId)).toEqual(r.members.map((m) => m.taskId));
    expect(done.runs.map((x) => [x.runId, x.outcome])).toEqual([[run.runId, 'superseded']]);
    expect(getRun(h.db, run.runId)?.outcome).toBe('superseded');
    for (const m of r.members) {
      expect(getTask(h.db, m.taskId)?.phase).toBe('archived');
      expect(eventsOf(h.db, m.taskId).at(-1)).toMatchObject({ kind: 'archived', payload: { workflow: r.instance.instanceId } });
    }
    expect(getTask(h.db, follow.task.taskId)?.phase).toBe('open');
    expect(relatedTasks(h.db, r.instance.instanceId).map((t) => t.taskId)).toEqual([follow.task.taskId]);
    const events = count('kanban_events');
    expect(archiveWorkflow(h.db, r.instance.instanceId, ALICE, NOW + 2)).toMatchObject({ ok: true, archived: [], runs: [] });
    expect(count('kanban_events')).toBe(events);
    expect(archiveWorkflow(h.db, 'w_none', ALICE, NOW)).toEqual({ ok: false, code: 'not_found', message: 'no workflow instance w_none' });
  });
});

describe("an instance's reads", () => {
  it('lists a board\'s instances newest first, with how many in all, and finds a member\'s instance', () => {
    const a = apply();
    h.db.prepare('UPDATE kanban_workflow_instances SET created_at = ? WHERE instance_id = ?').run(NOW - 10, a.instance.instanceId);
    const b = apply({ idempotencyKey: 'operator:b' });
    expect(instancesOn(h.db, 'default', 200).instances.map((i) => i.instanceId)).toEqual([b.instance.instanceId, a.instance.instanceId]);
    expect(instancesOn(h.db, 'default', 1)).toMatchObject({ total: 2, instances: [{ instanceId: b.instance.instanceId }] });
    const m = b.members[1];
    expect(memberOf(h.db, m?.taskId ?? '')).toEqual({
      taskId: m?.taskId,
      instanceId: b.instance.instanceId,
      ref: 'evaluate:1',
      step: 'evaluate',
      item: 'acme',
      position: 1,
      name: 'vendor-eval',
    });
    expect(memberOf(h.db, newTask(h.db).taskId)).toBeUndefined();
  });

  it('finds a related task by a link from a member, and reads nothing on a database with no workflows yet', () => {
    const r = apply();
    const linked = newTask(h.db, { parents: [r.members[3]?.taskId ?? ''] });
    expect(relatedTasks(h.db, r.instance.instanceId).map((t) => t.taskId)).toEqual([linked.taskId]);
    const dir = mkdtempSync(join(tmpdir(), 'mt-wf-old-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) if (/^00[1-8]_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      const old = openDb(join(dir, 'team.db'));
      try {
        migrate(old, only);
        expect(hasWorkflows(old)).toBe(false);
        expect(memberOf(old, newTask(old).taskId)).toBeUndefined();
      } finally {
        old.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
