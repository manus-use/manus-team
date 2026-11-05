import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cardsDue, eventsOf, getRun, getTask } from '../src/db/kanban-read.js';
import type { GateExit, GateRunOptions } from '../src/kanban/gates.js';
import { KanbanService, type CreateRequest } from '../src/kanban/service.js';
import type { RunRow, TaskRow } from '../src/kanban/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES, role } from './helpers/dispatch.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * What the board checks of a person's report, from plan D2 (spec §5.1, §7.7,
 * §9.2): a card's run, re-checked in the transaction, so a card for a run that is
 * over does nothing; a person's report refused while another task's agent run
 * is open in the workspace its gates would run in; a person's claim told as
 * one; a card recorded once; and an Unblock for a block already lifted refused.
 */

const BOB = 'lark:on_bob';
const DIRS = new Map([...WORKSPACES].map((w) => [w, `/ws/${w}`]));

let t: TestDb;
let service: KanbanService;
let ran: string[];

beforeEach(() => {
  t = testDb();
  ran = [];
  const runGate = async (command: string, _opts: GateRunOptions): Promise<GateExit> => {
    ran.push(command);
    return { exitCode: 0, signal: null, timedOut: false, output: '' };
  };
  service = new KanbanService({
    db: t.db,
    // Gates on a task no agent has run on run as the role default (spec §7.7).
    roles: new Map([...DEFAULT_ROLES, role('default')].map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
    people: { canTalk: (p) => p === ALICE || p === BOB },
    checks: { workspaceDirs: DIRS, env: {}, runGate },
  });
});
afterEach(() => t.close());

function create(req: Partial<CreateRequest> = {}): TaskRow {
  const r = service.create({ title: 'Check the links', assignee: ALICE, workspace: 'docs', createdBy: BOB, createdVia: VIA, ...req });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.task;
}

function claim(taskId: string): RunRow {
  const r = service.claim(taskId);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.run;
}

describe("a person's report through a card", () => {
  it('decides the run the card was for, and does nothing once that run is over', async () => {
    const task = create();
    const first = claim(task.taskId);
    // Reassigned and back: a new run, and the first card is out of date.
    expect(service.assign(task.taskId, BOB, BOB).ok).toBe(true);
    expect(service.assign(task.taskId, ALICE, BOB).ok).toBe(true);
    const second = claim(task.taskId);
    const stale = await service.complete(task.taskId, { kind: 'person', principal: ALICE, runId: first.runId }, { summary: 'all fine' });
    expect(stale).toMatchObject({ ok: false, code: 'run_superseded' });
    expect(getRun(t.db, second.runId)?.outcome).toBeNull();
    const fresh = await service.complete(task.taskId, { kind: 'person', principal: ALICE, runId: second.runId }, { summary: 'all fine' });
    expect(fresh.ok).toBe(true);
    expect(getRun(t.db, second.runId)).toMatchObject({ outcome: 'completed', summary: 'all fine' });
    expect(getRun(t.db, second.runId)?.endedAt).not.toBeNull();
  });

  it('refuses a block or a change through a card for a run that is over', () => {
    const task = create();
    const run = claim(task.taskId);
    expect(service.block(task.taskId, { kind: 'person', principal: ALICE, runId: 'r_gone' }, { kind: 'needs_input', reason: 'which wiki?' }))
      .toMatchObject({ ok: false, code: 'run_superseded' });
    expect(service.block(task.taskId, { kind: 'person', principal: ALICE, runId: run.runId }, { kind: 'needs_input', reason: 'which wiki?' }).ok)
      .toBe(true);
    expect(getTask(t.db, task.taskId)?.phase).toBe('blocked');
  });
});

describe("a person's report as typed, bound to what was checked", () => {
  it('refuses a report made while no run was open, once one is', async () => {
    const task = create();
    const run = claim(task.taskId);
    const none = { kind: 'person', principal: ALICE, runId: null, as: 'assignee' } as const;
    expect(await service.complete(task.taskId, none, { summary: 'done' })).toMatchObject({ ok: false, code: 'run_superseded' });
    expect(service.block(task.taskId, none, { kind: 'needs_input', reason: 'which wiki?' })).toMatchObject({ ok: false, code: 'run_superseded' });
    expect(getRun(t.db, run.runId)?.outcome).toBeNull();
  });

  it("refuses an assignee's report once the task is someone else's, and a reviewer's once the review is", async () => {
    const task = create({ reviewer: BOB });
    const asAlice = { kind: 'person', principal: ALICE, runId: null, as: 'assignee' } as const;
    expect(service.assign(task.taskId, 'implementer', BOB).ok).toBe(true);
    expect(await service.complete(task.taskId, asAlice, { summary: 'done' })).toMatchObject({ ok: false, code: 'run_superseded' });
    expect(await service.requestReview(task.taskId, asAlice, { summary: 'done' })).toMatchObject({ ok: false, code: 'run_superseded' });
    expect(service.block(task.taskId, asAlice, { kind: 'needs_input', reason: 'x' })).toMatchObject({ ok: false, code: 'run_superseded' });
    expect(service.assign(task.taskId, ALICE, BOB).ok).toBe(true);
    expect((await service.requestReview(task.taskId, asAlice, { summary: 'done' })).ok).toBe(true);
    expect(service.assignReviewer(task.taskId, 'reviewer', BOB).ok).toBe(true);
    const asBob = { kind: 'person', principal: BOB, runId: null, as: 'reviewer' } as const;
    expect(await service.complete(task.taskId, asBob, { summary: 'fine' })).toMatchObject({ ok: false, code: 'run_superseded' });
    expect(service.requestChanges(task.taskId, asBob, 'redo')).toMatchObject({ ok: false, code: 'run_superseded' });
    // An operator may answer any review.
    const asOperator = { kind: 'person', principal: BOB, runId: null, as: 'operator' } as const;
    expect((await service.complete(task.taskId, asOperator, { summary: 'fine' })).ok).toBe(true);
    expect(getTask(t.db, task.taskId)?.phase).toBe('done');
  });

  it("refuses an assignee's done once the task is in review, and an answer while it is not", async () => {
    const task = create({ reviewer: BOB });
    expect((await service.requestReview(task.taskId, { kind: 'person', principal: ALICE, runId: null, as: 'assignee' }, { summary: 'done' })).ok).toBe(true);
    expect(await service.complete(task.taskId, { kind: 'person', principal: ALICE, runId: null, as: 'assignee' }, { summary: 'done' }))
      .toMatchObject({ ok: false, code: 'run_superseded' });
    const other = create({ title: 'Tidy the docs' });
    expect(await service.complete(other.taskId, { kind: 'person', principal: BOB, runId: null, as: 'operator' }, { summary: 'done' }))
      .toMatchObject({ ok: false, code: 'run_superseded' });
  });
});

describe("a person's report beside another task's agent", () => {
  it('is refused while that agent run is open in the workspace its gates run in, and runs no gate', async () => {
    const task = create();
    expect(service.addGate(task.taskId, { command: 'test -f notes.md' }, BOB).ok).toBe(true);
    const run = claim(task.taskId);
    const other = create({ assignee: 'implementer', title: 'Tidy the docs' });
    const agent = service.claim(other.taskId);
    if (!agent.ok) throw new Error(agent.message);
    const refused = await service.complete(task.taskId, { kind: 'person', principal: ALICE, runId: run.runId }, { summary: 'done' });
    expect(refused).toMatchObject({ ok: false, code: 'workspace_busy' });
    if (refused.ok) throw new Error('not refused');
    expect(refused.message).toContain(`where task ${other.taskId}'s agent run ${agent.run.runId} is open`);
    expect(ran).toEqual([]);
    // A review asked for by the person is refused the same way: it runs the gates too.
    expect(await service.requestReview(task.taskId, { kind: 'person', principal: ALICE }, { summary: 'done', reviewer: BOB }))
      .toMatchObject({ ok: false, code: 'workspace_busy' });
    // Once the agent run is over, the report goes through, its gates run.
    expect(service.endRun(agent.run.runId, { outcome: 'failed', error: 'x', hadSideEffects: false }).ok).toBe(true);
    expect(service.closeRun(agent.run.runId).ok).toBe(true);
    expect((await service.complete(task.taskId, { kind: 'person', principal: ALICE }, { summary: 'done' })).ok).toBe(true);
    expect(ran).toEqual(['test -f notes.md']);
  });

  it('goes through when the task has no gate: nothing would run in the checkout', async () => {
    const task = create();
    claim(task.taskId);
    const other = create({ assignee: 'implementer', title: 'Tidy the docs' });
    expect(service.claim(other.taskId).ok).toBe(true);
    expect((await service.complete(task.taskId, { kind: 'person', principal: ALICE }, { summary: 'done' })).ok).toBe(true);
  });
});

describe("a person's claim, and their card", () => {
  it('records the claim as a person\'s, and lists the run as due a card until one is recorded, once', () => {
    const task = create();
    const run = claim(task.taskId);
    expect(eventsOf(t.db, task.taskId).find((e) => e.kind === 'claimed')?.payload).toMatchObject({
      assignee: ALICE,
      assigneeKind: 'human',
    });
    expect(cardsDue(t.db).map((r) => r.runId)).toEqual([run.runId]);
    expect(service.recordCard(run.runId, { messageId: 'om_card' })).toEqual({ ok: true, recorded: true });
    expect(service.recordCard(run.runId, { error: 'later' })).toEqual({ ok: true, recorded: false });
    expect(cardsDue(t.db)).toEqual([]);
    expect(eventsOf(t.db, task.taskId).filter((e) => e.kind.startsWith('card_')).map((e) => [e.kind, e.payload])).toEqual([
      ['card_sent', { kind: 'work', to: ALICE, messageId: 'om_card' }],
    ]);
  });

  it("records a card refused for good, and none for an agent's run", () => {
    const task = create();
    const run = claim(task.taskId);
    expect(service.recordCard(run.runId, { error: 'the user is not in the app' })).toEqual({ ok: true, recorded: true });
    expect(cardsDue(t.db)).toEqual([]);
    const agentTask = create({ assignee: 'implementer' });
    const agent = service.claim(agentTask.taskId);
    if (!agent.ok) throw new Error(agent.message);
    expect(service.recordCard(agent.run.runId, { messageId: 'om_x' })).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('an Unblock for a block already lifted', () => {
  it('is refused, and one for the block that stands goes through', () => {
    const task = create();
    claim(task.taskId);
    expect(service.block(task.taskId, { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason: 'which wiki?' }).ok).toBe(true);
    const first = eventsOf(t.db, task.taskId).findLast((e) => e.kind === 'blocked')?.id ?? 0;
    expect(service.unblock(task.taskId, BOB, undefined, { blockedAt: first }).ok).toBe(true);
    claim(task.taskId);
    expect(service.block(task.taskId, { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason: 'still unsure' }).ok).toBe(true);
    // The first notice's button: its block was lifted, and this is another.
    expect(service.unblock(task.taskId, BOB, undefined, { blockedAt: first })).toMatchObject({ ok: false, code: 'stale' });
    expect(getTask(t.db, task.taskId)?.phase).toBe('blocked');
    const second = eventsOf(t.db, task.taskId).findLast((e) => e.kind === 'blocked')?.id ?? 0;
    // A button's event must be a block of this task: another task's, or a claim, is no pointer to one.
    const claimEvent = eventsOf(t.db, task.taskId).findLast((e) => e.kind === 'claimed')?.id ?? 0;
    expect(service.unblock(task.taskId, BOB, undefined, { blockedAt: claimEvent })).toMatchObject({ ok: false, code: 'invalid' });
    const other = create({ title: 'Another' });
    const otherEvent = eventsOf(t.db, other.taskId).at(-1)?.id ?? 0;
    expect(service.unblock(task.taskId, BOB, undefined, { blockedAt: otherEvent })).toMatchObject({ ok: false, code: 'invalid' });
    expect(service.unblock(task.taskId, BOB, undefined, { blockedAt: second }).ok).toBe(true);
  });

  it("takes a run's end as the block only when the task blocked there", () => {
    const task = create({ assignee: 'implementer' });
    const first = claim(task.taskId);
    // A failure the task is retried after: no block, so no Unblock's pointer.
    expect(service.endRun(first.runId, { outcome: 'failed', error: 'x', hadSideEffects: false })).toMatchObject({ ok: true, next: 'retry' });
    expect(service.closeRun(first.runId).ok).toBe(true);
    const retried = eventsOf(t.db, task.taskId).findLast((e) => e.kind === 'run_ended')?.id ?? 0;
    claim(task.taskId);
    expect(service.stop(task.taskId, BOB).ok).toBe(true);
    expect(service.unblock(task.taskId, BOB, undefined, { blockedAt: retried })).toMatchObject({ ok: false, code: 'invalid' });
    expect(getTask(t.db, task.taskId)?.phase).toBe('blocked');
    const stopped = eventsOf(t.db, task.taskId).findLast((e) => e.kind === 'stopped')?.id ?? 0;
    expect(service.unblock(task.taskId, BOB, undefined, { blockedAt: stopped }).ok).toBe(true);
    // A run's end that blocked the task is its block.
    const once = create({ assignee: 'implementer', title: 'Once', failureLimit: 1, workspace: 'web' });
    const run = claim(once.taskId);
    expect(service.endRun(run.runId, { outcome: 'failed', error: 'x', hadSideEffects: false })).toMatchObject({ ok: true, next: 'blocked' });
    const gaveUp = eventsOf(t.db, once.taskId).findLast((e) => e.kind === 'run_ended')?.id ?? 0;
    expect(service.unblock(once.taskId, BOB, undefined, { blockedAt: gaveUp }).ok).toBe(true);
  });
});
