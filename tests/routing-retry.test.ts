import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, getInstance, membersOf } from '../src/db/kanban-read.js';
import { clearSecrets } from '../src/secrets.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { dispatchHarness } from './helpers/dispatch.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * A faulted routing retried (workflow routing spec §9.4, §11): the dispatcher's
 * pass calls the service's one hook, which reconciles every faulted instance at
 * most once a minute, clearing its mark on success, the reconciliation's
 * decisions in one workflow_routed event on the member whose settling decided.
 */

const FLOW = `board: vi
steps:
  a:
    title: a
    assignee: vi-coordinator
    outputs: { go: boolean }
  b:
    title: b
    assignee: verifier
    parents: [a]
    when: [{ step: a, output: go, is: true }]
`;

let h: TestDb;
let b: ViBoard;
let clock: ManualClock;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  clock = new ManualClock(NOW);
  b = viBoard(h, { clock });
  writeFileSync(join(b.dir, 'flow.yaml'), FLOW);
});
afterEach(() => h.close());

async function faulted(): Promise<{ instanceId: string; a: string }> {
  const w = madeOf(b.service.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
  const a = w.tasks[0]?.taskId ?? '';
  h.db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  const run = claimed(h.db, a);
  const r = await b.service.complete(a, { kind: 'run', runId: run.runId }, { summary: 'did it', metadata: { go: true } });
  if (!r.ok) throw new Error(r.message);
  closeRun(h.db, run.runId, NOW);
  return { instanceId: w.instance.instanceId, a };
}

describe('retrying a faulted routing', () => {
  it('reconciles a faulted instance, clearing its mark, its decisions on the member whose settling decided', async () => {
    const { instanceId, a } = await faulted();
    h.db.exec('DROP TRIGGER boom');
    expect(b.service.retryRouting()).toBe(1);
    expect(getInstance(h.db, instanceId)?.routingFailedAt).toBeNull();
    const made = membersOf(h.db, instanceId).find((m) => m.step === 'b');
    expect(eventsOf(h.db, a).filter((e) => e.kind === 'workflow_routed').map((e) => e.payload)).toEqual([
      { workflow: instanceId, workflowName: 'flow', step: 'a', cause: 'reconciled', decisions: [{ step: 'b', outcome: 'made', why: 'a.go is true', taskIds: [made?.taskId] }] },
    ]);
    expect(b.service.retryRouting()).toBe(0);
  });

  it('tries an instance still faulted at most once a minute, keeping its mark', async () => {
    const { instanceId } = await faulted();
    expect(b.service.retryRouting()).toBe(0);
    expect(getInstance(h.db, instanceId)?.routingFailedAt).toBe(NOW);
    h.db.exec('DROP TRIGGER boom');
    clock.advance(59_000);
    expect(b.service.retryRouting()).toBe(0);
    clock.advance(1_000);
    expect(b.service.retryRouting()).toBe(1);
    expect(getInstance(h.db, instanceId)?.routingFailedAt).toBeNull();
  });

  it('decides nothing twice: a second reconciliation writes no row and no event, and one whose commit found the database busy is retried whole', async () => {
    const { instanceId } = await faulted();
    h.db.exec('DROP TRIGGER boom');
    const count = (from: string) => (h.db.prepare(`SELECT count(*) AS n FROM ${from}`).get() as { n: number }).n;
    const counts = () => ['kanban_tasks', 'kanban_workflow_settled', 'kanban_workflow_pending', "kanban_events WHERE kind = 'workflow_routed'", 'kanban_events'].map(count);
    const exec = h.db.exec.bind(h.db);
    let busy = 1;
    const spy = vi.spyOn(h.db, 'exec').mockImplementation((sql: string) => {
      if (sql === 'COMMIT' && busy-- > 0) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      return exec(sql);
    });
    const before = counts();
    try {
      expect(b.service.reconcileWorkflow(instanceId)).toMatchObject({ ok: true, decisions: [{ step: 'b', outcome: 'made' }] });
    } finally {
      spy.mockRestore();
    }
    expect(busy).toBe(-1);
    // One task, one settled row, one routing event: what a single reconciliation writes, the task's own created event beside it.
    expect(counts().map((n, i) => n - (before[i] ?? 0))).toEqual([1, 1, 0, 1, 2]);
    const after = counts();
    expect(b.service.reconcileWorkflow(instanceId)).toMatchObject({ ok: true, decisions: [] });
    expect(counts()).toEqual(after);
  });

  it('reconciles an instance with nothing due to no decision, and refuses one that does not exist', () => {
    const w = madeOf(b.service.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
    expect(b.service.reconcileWorkflow(w.instance.instanceId)).toMatchObject({ ok: true, decisions: [] });
    expect(b.service.reconcileWorkflow('w_nope')).toEqual({ ok: false, code: 'not_found', message: 'no workflow instance w_nope' });
  });
});

describe("the dispatcher's pass", () => {
  it("calls the service's routing hook once a pass", () => {
    const d = dispatchHarness();
    try {
      const retry = vi.spyOn(d.service, 'retryRouting');
      d.dispatcher.pass();
      d.dispatcher.pass();
      expect(retry).toHaveBeenCalledTimes(2);
    } finally {
      d.close();
    }
  });
});
