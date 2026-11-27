import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, getTask, membersOf } from '../src/db/kanban-read.js';
import { isOutcome } from '../src/kanban/waker.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * A task made late checked against the team (workflow routing spec §7.4, §9.3):
 * the service hands the writer the team it holds, and a step's task whose role is
 * no longer configured is made, and blocked at once by the gateway as
 * `needs_input`, which routes nothing and is no state a clause reads.
 */

const FLOW = `board: vi
steps:
  intake:
    title: intake
    assignee: vi-coordinator
    outputs: { kind: { enum: [cve, supplychain] } }
  va:
    title: va
    assignee: vulnerability-analyst
    parents: [intake]
    when: [{ step: intake, output: kind, equals: cve }]
    on_blocked: { route: help }
  help:
    title: help
    assignee: verifier
    handler: true
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

describe('the team check of a task made late', () => {
  it('makes a task whose role is no longer configured, blocked at once by the gateway, which routes nothing', async () => {
    const w = madeOf(b.service.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
    const intake = w.tasks[0]?.taskId ?? '';
    b.roles.delete('vulnerability-analyst');
    const run = claimed(h.db, intake);
    expect((await b.service.complete(intake, { kind: 'run', runId: run.runId }, { summary: 'x', metadata: { kind: 'cve' } })).ok).toBe(true);
    closeRun(h.db, run.runId, NOW);
    const va = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'va')?.taskId ?? '';
    expect(getTask(h.db, va)).toMatchObject({
      phase: 'blocked',
      blockKind: 'needs_input',
      blockReason: `role vulnerability-analyst is not configured, so this step's task cannot be given to it: /kanban task assign ${va} <role>`,
    });
    const blocked = eventsOf(h.db, va).at(-1);
    expect(blocked).toMatchObject({ kind: 'blocked', actor: 'gateway' });
    // The gateway's block is no run's: it wakes nothing (wake spec §2.2).
    expect(blocked !== undefined && isOutcome(blocked)).toBe(false);
    expect(eventsOf(h.db, va).some((e) => e.kind === 'workflow_routed')).toBe(false);
    expect(membersOf(h.db, w.instance.instanceId).map((m) => m.step)).toEqual(['intake', 'va']);
  });

  it('names the review command when the role refused is the reviewer', async () => {
    writeFileSync(join(b.dir, 'flow.yaml'), FLOW.replace('    assignee: vulnerability-analyst\n', '    assignee: vulnerability-analyst\n    reviewer: assessment-reviewer\n'));
    const w = madeOf(b.service.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
    const intake = w.tasks[0]?.taskId ?? '';
    b.roles.delete('assessment-reviewer');
    const run = claimed(h.db, intake);
    expect((await b.service.complete(intake, { kind: 'run', runId: run.runId }, { summary: 'x', metadata: { kind: 'cve' } })).ok).toBe(true);
    closeRun(h.db, run.runId, NOW);
    const va = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'va')?.taskId ?? '';
    expect(getTask(h.db, va)).toMatchObject({
      phase: 'blocked',
      blockKind: 'needs_input',
      blockReason: `role assessment-reviewer is not configured, so this step's task cannot be reviewed by it: /kanban task review ${va}, with a line reviewer: <role or @person>`,
    });
  });
});
