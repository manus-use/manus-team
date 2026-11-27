import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventsOf, membersOf, pendingOf, routingDue, settledOf } from '../src/db/kanban-read.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA } from './helpers/kanban.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * Cancelling a case is `workflow archive` (workflow routing spec §9.1): every
 * member archived, every waiting step skipped, `the instance was archived`, and
 * nothing decided or made; the members' rows and the skipped steps' settling
 * written in the same transaction, so the instance is never due.
 */

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  b = viBoard(h);
});
afterEach(() => h.close());

describe('archiving a routed instance', () => {
  it('skips every waiting step without deciding, makes nothing, and settles every step', () => {
    const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
    const r = b.service.archiveWorkflow(w.instance.instanceId, ALICE);
    expect(r.ok).toBe(true);
    const pending = pendingOf(h.db, w.instance.instanceId);
    expect(pending.map((p) => [p.step, p.state])).toEqual([
      ['exposure', 'skipped'],
      ['patch', 'skipped'],
      ['registry', 'skipped'],
      ['report', 'skipped'],
      ['va', 'skipped'],
      ['verify', 'skipped'],
    ]);
    expect(pending[0]).toMatchObject({ reason: { by: 'instance', why: 'the instance was archived' }, decidedAt: NOW, causeEvent: null });
    expect(membersOf(h.db, w.instance.instanceId).length).toBe(1);
    expect(settledOf(h.db, w.instance.instanceId).map((s) => [s.step, s.how])).toEqual(
      ['exposure', 'intake', 'patch', 'registry', 'report', 'va', 'verify'].map((step) => [step, 'archived']),
    );
    expect(routingDue(h.db)).toEqual([]);
    expect(eventsOf(h.db, w.tasks[0]?.taskId ?? '').some((e) => e.kind === 'workflow_routed')).toBe(false);
  });
});
