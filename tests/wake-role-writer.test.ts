import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addComment, archive, archiveBoard, claim, createBoard, createTask, recordWake, type NewRoleWake } from '../src/db/kanban.js';
import { eventsOf, getTask, getWake, subscriptionsOf, wakeEventsOf } from '../src/db/kanban-read.js';
import { registerWorktree } from '../src/db/workspaces.js';
import { briefFor } from '../src/kanban/brief.js';
import { KanbanService } from '../src/kanban/service.js';
import type { Role } from '../src/roles.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, NOW, WORKSPACES, claimantFor, claimed, newTask } from './helpers/kanban.js';

/**
 * `recordRoleWake` (wake spec §19.3, §19.8): a role's batch made into one
 * reaction task in one transaction, with its `kanban_wakes` row, already
 * delivered, its events, its subscription and the wake cursors; `createTask`'s
 * checks in order, the key first, an archived board and a role removed each a
 * skip, a title cut and never refused, a refusal rolling everything back; and
 * `wake_root`, written for a reaction task and every task made from one,
 * however deep, and for no other.
 */

const APP = 'cli_app';
const THREAD = { kind: 'chat' as const, channel: 'lark', appId: APP, conversationId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root', chatType: 'group' as const };
const ROLES: ReadonlyMap<string, Role> = new Map([
  ['implementer', role('implementer')],
  ['vi-coordinator', role('vi-coordinator')],
]);

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

function service(roles: ReadonlyMap<string, Role> = ROLES): KanbanService {
  return new KanbanService({ db: h.db, roles, workspaces: WORKSPACES, clock: new ManualClock(NOW + 10) });
}

const count = (table: string): number => (h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

/** A task with wake on for vi-coordinator in thread omt_topic, an outcome-like event of it, and the batch of that event. */
function batch(over: Partial<NewRoleWake> = {}, board?: string): { source: string; event: number; sub: number; b: NewRoleWake } {
  const source = newTask(h.db, { createdVia: THREAD, wake: { by: ALICE, depth: 1, role: 'vi-coordinator' }, ...(board === undefined ? {} : { board }) });
  addComment(h.db, source.taskId, ALICE, 'an outcome stands in here', NOW + 1, false);
  const event = eventsOf(h.db, source.taskId).at(-1)?.id ?? 0;
  const sub = subscriptionsOf(h.db, source.taskId)[0]?.id ?? 0;
  return {
    source: source.taskId,
    event,
    sub,
    b: {
      uuid: 'u-1',
      channel: 'lark',
      appId: APP,
      conversationId: 'oc_team',
      threadId: 'omt_topic',
      principal: ALICE,
      depth: 1,
      events: [{ subscriptionId: sub, eventId: event, taskId: source.taskId }],
      role: 'vi-coordinator',
      title: `React to board updates: ${source.taskId} completed`,
      body: 'Board update: you are this task\'s run …',
      ...over,
    },
  };
}

function made(r: ReturnType<KanbanService['recordRoleWake']>): { wakeId: number; taskId: string; existing: boolean } {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  if (!('wake' in r)) throw new Error(`skipped: ${r.reason}`);
  return { wakeId: r.wake.wakeId, taskId: r.task.taskId, existing: r.existing };
}

describe('recordRoleWake', () => {
  it('makes the reaction task with its row, its events, its subscription and the cursors, in one transaction', () => {
    const { source, event, sub, b } = batch();
    const { wakeId, taskId, existing } = made(service().recordRoleWake(b));
    expect(existing).toBe(false);
    expect(getWake(h.db, wakeId)).toMatchObject({
      state: 'delivered',
      deliveredAt: NOW + 10,
      targetRole: 'vi-coordinator',
      reactionTask: taskId,
      sessionId: null,
      principal: ALICE,
      depth: 1,
    });
    expect(wakeEventsOf(h.db, wakeId)).toEqual([{ wakeId, subscriptionId: sub, eventId: event, taskId: source }]);
    expect(subscriptionsOf(h.db, source)[0]?.wakeCursor).toBe(event);
    const task = getTask(h.db, taskId);
    expect(task).toMatchObject({
      title: `React to board updates: ${source} completed`,
      body: "Board update: you are this task's run …",
      assignee: { kind: 'role', name: 'vi-coordinator' },
      board: 'default',
      createdBy: ALICE,
      createdVia: { kind: 'wake', wakeId },
      createdFromTask: source,
      idempotencyKey: 'wake:u-1',
      wakeBy: null,
      wakeRole: null,
      wakeDepth: 2,
      reactionOf: wakeId,
      wakeRoot: taskId,
      phase: 'open',
    });
    expect(subscriptionsOf(h.db, taskId)).toEqual([
      expect.objectContaining({ appId: APP, conversationId: 'oc_team', threadId: 'omt_topic', rootMessageId: 'om_root', chatType: 'group', wakeCursor: 0 }),
    ]);
    // Not a link: it is ready at once.
    expect(h.db.prepare('SELECT count(*) AS n FROM kanban_links WHERE child_id = ?').get(taskId)).toEqual({ n: 0 });
  });

  it('answers a second attempt with the same uuid by its key, and writes nothing', () => {
    const { b } = batch();
    const first = made(service().recordRoleWake(b));
    const [tasks, wakes, events] = [count('kanban_tasks'), count('kanban_wakes'), count('kanban_events')];
    expect(made(service().recordRoleWake(b))).toEqual({ ...first, existing: true });
    expect([count('kanban_tasks'), count('kanban_wakes'), count('kanban_events')]).toEqual([tasks, wakes, events]);
  });

  it('skips the wake for a board archived since, and writes nothing', () => {
    createBoard(h.db, 'research', ALICE, NOW);
    const { source, b } = batch({}, 'research');
    archive(h.db, source, ALICE, NOW + 2);
    archiveBoard(h.db, 'research', ALICE, NOW + 3);
    const [tasks, wakes] = [count('kanban_tasks'), count('kanban_wakes')];
    expect(service().recordRoleWake(b)).toEqual({ ok: true, skipped: 'board', reason: 'board research is archived' });
    expect([count('kanban_tasks'), count('kanban_wakes')]).toEqual([tasks, wakes]);
  });

  it('skips the wake for a role removed since the round began', () => {
    const { b } = batch();
    const r = service(new Map([['implementer', role('implementer')]])).recordRoleWake(b);
    expect(r).toEqual({ ok: true, skipped: 'role', reason: 'role "vi-coordinator" is not configured' });
    expect(count('kanban_wakes')).toBe(0);
  });

  it('cuts a title past its limit, never refusing it', () => {
    const { b } = batch({ title: `React to board updates: ${'x'.repeat(600)}` });
    const { taskId } = made(service().recordRoleWake(b));
    expect(getTask(h.db, taskId)?.title.length).toBe(512);
  });

  it('cuts a title and a body by their bytes, on a whole character', () => {
    const { b } = batch({ title: '\u8bae'.repeat(300), body: '\u00e9'.repeat(40_000) });
    const task = getTask(h.db, made(service().recordRoleWake(b)).taskId);
    expect(Buffer.byteLength(task?.title ?? '')).toBe(510);
    expect(task?.title).toBe('\u8bae'.repeat(170));
    expect(Buffer.byteLength(task?.body ?? '')).toBe(64 * 1024);
    expect(task?.body).not.toContain('\ufffd');
  });

  it("answers a uuid already recorded by its wake row first, skipping a chat turn's", () => {
    const { b } = batch();
    const turn = recordWake(h.db, { ...b }, NOW + 2);
    if (!turn.ok) throw new Error(turn.message);
    const [tasks, wakes] = [count('kanban_tasks'), count('kanban_wakes')];
    expect(service().recordRoleWake(b)).toEqual({ ok: true, skipped: 'turn', reason: 'wake u-1 is recorded already, as a turn of the chat session, and makes no reaction task' });
    expect([count('kanban_tasks'), count('kanban_wakes')]).toEqual([tasks, wakes]);
  });

  it('skips a batch of a conversation whose subscription is gone, and writes nothing', () => {
    const { source, event, b } = batch();
    const gone = { ...b, events: [{ subscriptionId: 999, eventId: event, taskId: source }] };
    const [tasks, wakes] = [count('kanban_tasks'), count('kanban_wakes')];
    expect(service().recordRoleWake(gone)).toEqual({ ok: true, skipped: 'subscription', reason: 'no subscription 999 for the reaction task to follow' });
    expect([count('kanban_tasks'), count('kanban_wakes')]).toEqual([tasks, wakes]);
  });

  it("tells the reaction task's run of its source task's own directory", () => {
    const source = newTask(h.db, { createdVia: THREAD, workspace: 'web', wake: { by: ALICE, depth: 0, role: 'vi-coordinator' } });
    const run = claim(h.db, { taskId: source.taskId, claimant: claimantFor(h.db, source.taskId), workspaces: new Set(['web']), isolated: new Set(['web']) }, NOW + 1);
    if (!run.ok) throw new Error(run.message);
    registerWorktree(h.db, { id: `wt:${source.taskId}`, kind: 'git-worktree', rootPath: `/home/mt/worktrees/web/${source.taskId}`, repoRoot: '/srv/web', branch: `mt/${source.taskId}` }, NOW + 1);
    addComment(h.db, source.taskId, ALICE, 'an outcome stands in here', NOW + 2, false);
    const event = eventsOf(h.db, source.taskId).at(-1)?.id ?? 0;
    const sub = subscriptionsOf(h.db, source.taskId)[0]?.id ?? 0;
    const { b } = { b: { ...batch().b, uuid: 'u-dir', events: [{ subscriptionId: sub, eventId: event, taskId: source.taskId }] } };
    const reaction = made(service().recordRoleWake(b)).taskId;
    const claimedRun = claim(h.db, { taskId: reaction, claimant: claimantFor(h.db, reaction), workspaces: new Set(['web']), isolated: new Set(['web']) }, NOW + 3);
    if (!claimedRun.ok) throw new Error(claimedRun.message);
    const brief = briefFor(h.db, { run: claimedRun.run, task: claimedRun.task, roleMd: undefined, role: undefined });
    expect(brief.workdir?.upstream).toEqual([
      { taskId: source.taskId, path: `/home/mt/worktrees/web/${source.taskId}`, branch: `mt/${source.taskId}`, abandoned: false },
    ]);
  });

  it('rolls everything back on any other refusal, and the batch is tried again with the same key', () => {
    const { b } = batch({ title: '   ' });
    const [tasks, wakes] = [count('kanban_tasks'), count('kanban_wakes')];
    expect(service().recordRoleWake(b)).toEqual({ ok: false, code: 'invalid', message: 'a task needs a title' });
    expect([count('kanban_tasks'), count('kanban_wakes'), count('kanban_wake_events')]).toEqual([tasks, wakes, 0]);
    const again = made(service().recordRoleWake({ ...b, title: 'React to board updates' }));
    expect(getTask(h.db, again.taskId)?.idempotencyKey).toBe('wake:u-1');
  });
});

describe('wake_root', () => {
  it("is passed on to a reaction run's follow-ups however deep, and to a workflow its run applies", () => {
    const { taskId } = made(service().recordRoleWake(batch().b));
    const run = claimed(h.db, taskId, { assignee: { kind: 'role', name: 'vi-coordinator' } });
    const follow = createTask(
      h.db,
      // Another workspace: the reaction run still holds the default one.
      { title: 'a follow-up', assignee: { kind: 'role', name: 'implementer' }, workspace: 'web', createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } },
      NOW + 20,
    );
    if (!follow.ok) throw new Error(follow.message);
    expect(follow.task.wakeRoot).toBe(taskId);
    const deeper = claimed(h.db, follow.task.taskId);
    const next = createTask(h.db, { title: 'a follow-up of it', createdBy: `run:${deeper.runId}`, createdVia: { kind: 'run', runId: deeper.runId } }, NOW + 30);
    if (!next.ok) throw new Error(next.message);
    expect(next.task.wakeRoot).toBe(taskId);
    const applied = service().applyDag({ dag: { format: 1, tasks: [{ ref: 'a', title: 'A' }] }, createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } });
    if (!applied.ok || !('instance' in applied)) throw new Error('not applied');
    expect(applied.tasks.map((t) => t.task.wakeRoot)).toEqual([taskId]);
  });

  it('is none for a task made by chat, the terminal or an ordinary run', () => {
    const chat = newTask(h.db, { createdVia: THREAD });
    const terminal = newTask(h.db, { createdVia: { kind: 'operator' } });
    const run = claimed(h.db, chat.taskId);
    const follow = createTask(h.db, { title: 'a follow-up', createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } }, NOW + 1);
    if (!follow.ok) throw new Error(follow.message);
    expect([chat.wakeRoot, terminal.wakeRoot, follow.task.wakeRoot]).toEqual([null, null, null]);
  });
});
