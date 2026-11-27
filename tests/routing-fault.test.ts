import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, getInstance, getTask, membersOf, parentsOf, pendingOf, settledOf } from '../src/db/kanban-read.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed, newTask } from './helpers/kanban.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * A fault in the routing (workflow routing spec §9.4): its savepoint rolled back
 * alone, the transition kept, the instance marked once, one workflow_route_failed
 * event a fault, `first` only on the one that set the mark; and, when SQLite
 * rolled the whole transaction back, the error rethrown and nothing committed.
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
    outputs: { go: boolean }
  c:
    title: c
    assignee: verifier
    parents: [a, b]
    when: [{ step: a, output: go, is: true }]
`;

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  b = viBoard(h);
  writeFileSync(join(b.dir, 'flow.yaml'), FLOW);
});
afterEach(() => h.close());

function start() {
  return madeOf(b.service.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
}

async function done(taskId: string): Promise<void> {
  const run = claimed(h.db, taskId);
  const r = await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'did it', metadata: { go: true } });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  closeRun(h.db, run.runId, NOW);
}

const failed = (taskId: string) => eventsOf(h.db, taskId).filter((e) => e.kind === 'workflow_route_failed').map((e) => e.payload);

describe('a fault in the routing', () => {
  it('rolls back its savepoint alone, keeping the completion, marking the instance once, one event a fault, first on the first only', async () => {
    const w = start();
    const [a, bb] = [w.tasks[0]?.taskId ?? '', w.tasks[1]?.taskId ?? ''];
    h.db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled BEGIN SELECT RAISE(ABORT, 'the settled rows cannot be written'); END;");
    await done(a);
    expect(getTask(h.db, a)?.phase).toBe('done');
    expect(settledOf(h.db, w.instance.instanceId)).toEqual([]);
    expect(getInstance(h.db, w.instance.instanceId)?.routingFailedAt).toBe(NOW);
    expect(failed(a)).toEqual([{ workflow: w.instance.instanceId, workflowName: 'flow', error: 'the settled rows cannot be written', first: true }]);
    await done(bb);
    expect(failed(bb)).toEqual([{ workflow: w.instance.instanceId, workflowName: 'flow', error: 'the settled rows cannot be written', first: false }]);
    expect(pendingOf(h.db, w.instance.instanceId).map((p) => p.state)).toEqual(['waiting']);
    expect(membersOf(h.db, w.instance.instanceId).length).toBe(2);
  });

  it('cuts the error at 500 characters by code points, never splitting one', async () => {
    const w = start();
    const a = w.tasks[0]?.taskId ?? '';
    // 499 characters, then one outside the BMP: two UTF-16 units, which a cut by units would split.
    h.db.exec(`CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled BEGIN SELECT RAISE(ABORT, '${'x'.repeat(499)}\u{1F600}tail'); END;`);
    await done(a);
    expect((failed(a)[0] as { error: string }).error).toBe(`${'x'.repeat(499)}\u{1F600}`);
  });

  it("opens no savepoint for a task of no planned instance, and one for a planned instance's", async () => {
    const spy = vi.spyOn(h.db, 'transaction');
    try {
      const plain = newTask(h.db, { assignee: { kind: 'role', name: 'verifier' } });
      await done(plain.taskId);
      expect(spy).not.toHaveBeenCalled();
      await done(start().tasks[0]?.taskId ?? '');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('rethrows when SQLite rolled the whole transaction back, so nothing is committed', async () => {
    const w = start();
    const a = w.tasks[0]?.taskId ?? '';
    h.db.exec("CREATE TEMP TRIGGER gone BEFORE INSERT ON kanban_workflow_settled BEGIN SELECT RAISE(ROLLBACK, 'the transaction is gone'); END;");
    const run = claimed(h.db, a);
    await expect(b.service.complete(a, { kind: 'run', runId: run.runId }, { summary: 'did it', metadata: { go: true } })).rejects.toThrow('the transaction is gone');
    expect(getTask(h.db, a)?.phase).toBe('open');
    expect(eventsOf(h.db, a).some((e) => e.kind === 'completed' || e.kind === 'workflow_route_failed')).toBe(false);
    expect(getInstance(h.db, w.instance.instanceId)?.routingFailedAt).toBeNull();
  });

  it('lets txImmediate retry the whole transition when the routing finds the database busy, nothing marked', async () => {
    const w = start();
    const a = w.tasks[0]?.taskId ?? '';
    let busy = 1;
    h.db.function('busy_once', () => {
      if (busy-- > 0) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      return 0;
    });
    h.db.exec('CREATE TEMP TRIGGER busy BEFORE INSERT ON kanban_workflow_settled BEGIN SELECT busy_once(); END;');
    await done(a);
    expect(eventsOf(h.db, a).filter((e) => e.kind === 'completed').length).toBe(1);
    expect(failed(a)).toEqual([]);
    expect(settledOf(h.db, w.instance.instanceId).map((s) => s.step)).toEqual(['a']);
    expect(getInstance(h.db, w.instance.instanceId)?.routingFailedAt).toBeNull();
  });

  it.each([
    ['a', 'b'],
    ['b', 'a'],
  ])('decides as before once the fault is gone, %s settling before %s', async (first, second) => {
    const w = start();
    const task = (step: string) => w.tasks[step === 'a' ? 0 : 1]?.taskId ?? '';
    h.db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    await done(task(first));
    h.db.exec('DROP TRIGGER boom');
    await done(task(second));
    expect(settledOf(h.db, w.instance.instanceId).map((s) => [s.step, s.how])).toEqual([
      ['a', 'done'],
      ['b', 'done'],
    ]);
    const members = membersOf(h.db, w.instance.instanceId);
    expect(members.map((m) => m.step)).toEqual(['a', 'b', 'c']);
    const c = members.find((m) => m.step === 'c')?.taskId ?? '';
    expect(parentsOf(h.db, c).map((p) => p.taskId)).toEqual([task('a'), task('b')]);
    expect(pendingOf(h.db, w.instance.instanceId).find((p) => p.step === 'c')).toMatchObject({ state: 'made', reason: { why: 'a.go is true' } });
  });
});
