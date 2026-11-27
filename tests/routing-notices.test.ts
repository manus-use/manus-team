import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, getTask, membersOf } from '../src/db/kanban-read.js';
import { renderNotice } from '../src/kanban/chat-render.js';
import type { KanbanEvent } from '../src/kanban/types.js';
import { WAKE_KINDS } from '../src/kanban/waker.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * The routing's notices (workflow routing spec §12.2): `workflow_routed`, after
 * the transition that decided, one line a decision, made, skipped, fanned out,
 * routed, stood in, over the limit, over the cap and left open, rendered from
 * its payload alone, masked; `workflow_route_failed` said once a fault; neither
 * an outcome that wakes.
 */

const SECRET = 'sk-live-1234567890';
let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  addSecrets([SECRET]);
  h = testDb();
  b = viBoard(h, { limits: { failureLimit: 1, transientLimit: 10, transientCooldownS: 300 } });
});
afterEach(() => {
  clearSecrets();
  h.close();
});

let instance = '';
const ids = (text: string) => text.replace(/k_[a-z0-9]+/g, 'k_…').replace(/w_[a-z0-9]+/g, 'w_…');
const step = (s: string) => membersOf(h.db, instance).filter((m) => m.step === s).map((m) => m.taskId);

async function report(taskId: string, metadata: Record<string, unknown> = {}): Promise<void> {
  const run = claimed(h.db, taskId);
  const r = await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'done', metadata });
  if (!r.ok) throw new Error(r.message);
  closeRun(h.db, run.runId, NOW);
}

function giveUp(taskId: string): void {
  const run = claimed(h.db, taskId);
  b.service.endRun(run.runId, { outcome: 'crashed' });
  closeRun(h.db, run.runId, NOW);
}

/** The notices of a task's routing events, as the chat hears them. */
function notices(taskId: string, kind = 'workflow_routed'): Array<string | undefined> {
  const task = getTask(h.db, taskId);
  if (task === undefined) throw new Error('no task');
  return eventsOf(h.db, taskId)
    .filter((e) => e.kind === kind)
    .map((e) => {
      const text = renderNotice(e, task, { blockRecurrenceLimit: 3 });
      return text === undefined ? undefined : ids(text);
    });
}

async function start(caseId = 'CVE-1'): Promise<string> {
  const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: caseId } }, createdBy: ALICE, createdVia: VIA }));
  instance = w.instance.instanceId;
  return w.tasks[0]?.taskId ?? '';
}

describe('the routing notices', () => {
  it('says each decision of a completion, after it, in one notice', async () => {
    const intake = await start();
    await report(intake, { kind: 'cve', verify: false, patch: false, bnpm: false, packages: ['lodash', 'minimist', 'qs'] });
    expect(notices(intake)).toEqual([
      ['After **CVE-1 · intake** `k_…`, in vi-workflow `w_…`:', '- ✓ va made: `k_…`', '- ⏭ verify skipped: intake.verify is false', '- ⏭ registry skipped: intake.bnpm is false', '- ⏭ patch skipped: intake.patch is false'].join('\n'),
    ]);
  });

  it("says a route after a give-up, a stand-in's settling and the fan-out it let through, and a stand-in left open", async () => {
    const intake = await start();
    await report(intake, { kind: 'cve', verify: false, patch: false, bnpm: false, packages: ['lodash', 'minimist', 'qs'] });
    const va = step('va')[0] ?? '';
    giveUp(va);
    expect(notices(va)).toEqual(['After **CVE-1 · va** `k_…` gave up, in vi-workflow `w_…`:\n- ↪ escalate routed from va: `k_…`, standing in']);
    const escalate = step('escalate')[0] ?? '';
    await report(escalate, { reachable: true });
    expect(notices(escalate)).toEqual([
      [
        'After **CVE-1 · va, escalated** `k_…`, in vi-workflow `w_…`:',
        '- ✓ escalate stands in for va: reachable=true; `k_…` va archived',
        '- ▶ exposure fanned out, 3 tasks: lodash, minimist, qs',
      ].join('\n'),
    ]);
  });

  it('says a route after the transient limit stopped its task, by its throttles', async () => {
    const intake = await start();
    await report(intake, { kind: 'cve', verify: false, patch: false, bnpm: false, packages: [] });
    const va = step('va')[0] ?? '';
    for (let n = 1; n <= 10; n += 1) {
      // The cooldown lifted at once: the clock here does not move.
      h.db.prepare('UPDATE kanban_tasks SET cooldown_until = NULL WHERE task_id = ?').run(va);
      const run = claimed(h.db, va);
      b.service.endRun(run.runId, { outcome: 'rate_limited' });
      closeRun(h.db, run.runId, NOW);
    }
    expect(notices(va)).toEqual(['After **CVE-1 · va** `k_…` stopped after 10 throttles, in vi-workflow `w_…`:\n- ↪ escalate routed from va: `k_…`, standing in']);
  });

  it("says a fourth give-up over the limit, and a stand-in left open once the routed task's own completion won", async () => {
    const intake = await start();
    await report(intake, { kind: 'cve', verify: false, patch: false, bnpm: false, packages: [] });
    const va = step('va')[0] ?? '';
    for (let n = 0; n < 4; n += 1) {
      giveUp(va);
      expect(b.service.unblock(va, ALICE).ok).toBe(true);
    }
    expect(notices(va)[3]).toBe(
      'After **CVE-1 · va** `k_…` gave up, in vi-workflow `w_…`:\n- `k_…` va gave up again, and has been routed to escalate 3 times: it waits for a person now (/kanban task unblock k_… [comment])',
    );
    await report(va, { reachable: false });
    expect(notices(va).at(-1)?.split('\n')[1]).toBe('- escalate `k_…` is left open: va was completed by its own task');
  });

  it('records a route past the cap over_cap, and says it waits for a person', async () => {
    const intake = await start();
    await report(intake, { kind: 'cve', verify: false, patch: false, bnpm: false, packages: [] });
    // Members to the cap, as rows: tasks the instance made, which nothing here reads but the count.
    const task = h.db.prepare(
      `INSERT INTO kanban_tasks (task_id, title, contract, phase, created_by, created_via, created_at, board)
       VALUES (?, 'filler', jsonb('{}'), 'open', ?, jsonb('{"kind":"operator"}'), ?, 'vi')`,
    );
    const member = h.db.prepare("INSERT INTO kanban_workflow_tasks (task_id, instance_id, ref, step, item, position) VALUES (?, ?, ?, 'filler', NULL, ?)");
    const base = membersOf(h.db, instance).length;
    for (let i = 0; i < 500 - base; i += 1) {
      task.run(`k_fill${i}`, ALICE, NOW);
      member.run(`k_fill${i}`, instance, `filler:${i + 1}`, base + i);
    }
    const va = step('va')[0] ?? '';
    giveUp(va);
    expect(step('escalate')).toEqual([]);
    expect(h.db.prepare('SELECT outcome FROM kanban_workflow_routes').all()).toEqual([{ outcome: 'over_cap' }]);
    expect(notices(va)).toEqual([
      'After **CVE-1 · va** `k_…` gave up, in vi-workflow `w_…`:\n- `k_…` va gave up, and is not routed to escalate: the instance has 500 tasks; it waits for a person (/kanban task unblock k_… [comment])',
    ]);
  });

  it('masks what a notice quotes, and says a routing fault once', async () => {
    const intake = await start(`CVE ${SECRET}`);
    h.db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled BEGIN SELECT RAISE(ABORT, 'cannot write'); END;");
    await report(intake, { kind: 'cve', verify: false, patch: false, bnpm: false, packages: [] });
    expect(notices(intake, 'workflow_route_failed')).toEqual([
      `Routing of vi-workflow \`w_…\` failed after **CVE ${MASK} · intake** \`k_…\`: cannot write. The gateway tries again; \`mt kanban workflow reconcile w_…\` tries now.`,
    ]);
    const task = getTask(h.db, intake);
    if (task === undefined) throw new Error('no task');
    const again: KanbanEvent = { id: 99, taskId: intake, runId: null, kind: 'workflow_route_failed', actor: 'gateway', payload: { workflow: instance, error: 'x', first: false }, createdAt: NOW };
    expect(renderNotice(again, task, { blockRecurrenceLimit: 3 })).toBeUndefined();
  });

  it('wakes nothing: neither kind is an outcome', () => {
    expect(WAKE_KINDS.has('workflow_routed')).toBe(false);
    expect(WAKE_KINDS.has('workflow_route_failed')).toBe(false);
  });
});
