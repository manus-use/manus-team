import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { showJson, wokenShowText } from '../src/cli/plain.js';
import { block, closeRun, complete, setWake } from '../src/db/kanban.js';
import { commentsOf, eventsOf, getTask, openRunOf, subscriptionsOf, wokenUnblocksSince } from '../src/db/kanban-read.js';
import { KanbanService } from '../src/kanban/service.js';
import { hashToken, mintToken } from '../src/kanban/token.js';
import type { CreatedVia } from '../src/kanban/types.js';
import { WakeApi } from '../src/kanban/wake-api.js';
import { WORKER_COMMANDS, WorkerApi, type WorkerResponse } from '../src/kanban/worker.js';
import type { Role } from '../src/roles.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, NOW, WORKSPACES, claimed, newTask } from './helpers/kanban.js';

/**
 * A reaction task's run's scope (wake spec §19.8): `mt kanban wake-show` and
 * `wake-unblock`, worker commands carried by the run's own token, scoped by
 * its task's wake to the tasks the wake carried, judged by the wake's setter's
 * tiers, live, with §9.2's checks; and a run's `link` of a reaction task
 * refused (§19.3).
 */

const APP = 'cli_app';
const THREAD: CreatedVia = { kind: 'chat', channel: 'lark', appId: APP, conversationId: 'oc_team', threadId: 'omt_1', rootId: 'om_root', chatType: 'group' };
const ROLES: ReadonlyMap<string, Role> = new Map([
  ['implementer', role('implementer')],
  ['vi-coordinator', role('vi-coordinator')],
]);

let t: TestDb;
let service: KanbanService;
let api: WorkerApi;
let wakesOn: boolean;
let talk: Set<string>;
let operate: Set<string>;
let changes: number;
let lark: FakeChannel;

beforeEach(() => {
  t = testDb();
  service = new KanbanService({ db: t.db, roles: ROLES, workspaces: WORKSPACES, clock: new ManualClock(NOW + 100) });
  wakesOn = true;
  talk = new Set([ALICE]);
  operate = new Set([ALICE]);
  changes = 0;
  lark = new FakeChannel();
  const wakes = new WakeApi({
    db: t.db,
    service,
    tokens: { lookup: () => undefined },
    people: { canTalk: (p) => talk.has(p), canOperate: (p) => talk.has(p) && operate.has(p), chatNames: () => (p) => (p === ALICE ? 'Zhixi Sun' : undefined) },
    blockRecurrenceLimit: 3,
    render: { lines: wokenShowText, json: showJson },
    channels: new Map([['lark', lark]]),
    appId: APP,
    zone: 'UTC',
    nudge: () => (changes += 1),
  });
  api = new WorkerApi({ db: t.db, service, changed: () => (changes += 1), wakes: () => (wakesOn ? wakes : undefined) });
});
afterEach(() => t.close());

/** A source task blocked by its run, wake on for vi-coordinator; its reaction task, made by the wake; and a run of it, with its token. */
function reaction(blocks = 1): { source: string; other: string; react: string; ask: (command: string, input?: Record<string, unknown>) => Promise<WorkerResponse> } {
  const source = newTask(t.db, { createdVia: THREAD, assignee: { kind: 'role', name: 'implementer' } });
  const set = setWake(t.db, source.taskId, { on: true, as: ALICE, maxDepth: 5, role: 'vi-coordinator' }, ALICE, APP, NOW);
  if (!set.ok) throw new Error(set.message);
  const run = claimed(t.db, source.taskId);
  const blocked = block(t.db, source.taskId, { kind: 'run', runId: run.runId }, { kind: 'needs_input', reason: 'Which one?' }, NOW + 1);
  if (!blocked.ok) throw new Error(blocked.message);
  closeRun(t.db, run.runId, NOW + 2);
  const other = newTask(t.db, { createdVia: THREAD });
  const sub = subscriptionsOf(t.db, source.taskId)[0]?.id ?? 0;
  const events = eventsOf(t.db, source.taskId).filter((e) => e.kind === 'blocked').slice(0, blocks);
  const made = service.recordRoleWake({
    uuid: `u-${source.taskId}`,
    channel: 'lark',
    appId: APP,
    conversationId: 'oc_team',
    threadId: 'omt_1',
    principal: ALICE,
    depth: 0,
    events: events.map((e) => ({ subscriptionId: sub, eventId: e.id, taskId: source.taskId })),
    role: 'vi-coordinator',
    title: `React to board updates: ${source.taskId} blocked`,
    body: 'Board update: …',
  });
  if (!made.ok || 'skipped' in made) throw new Error('no reaction task');
  const token = mintToken();
  const c = service.claim(made.task.taskId, { tokenHash: hashToken(token) });
  if (!c.ok) throw new Error(c.message);
  return {
    source: source.taskId,
    other: other.taskId,
    react: made.task.taskId,
    ask: (command, input = {}) => api.handle({ run: c.run.runId, token, command, input }),
  };
}

describe('wake-show', () => {
  it('is a worker command', () => {
    expect(WORKER_COMMANDS).toContain('wake-show');
    expect(WORKER_COMMANDS).toContain('wake-unblock');
  });

  it("shows a task the wake carried, as the operator's --json, names by principal", async () => {
    const r = reaction();
    const shown = await r.ask('wake-show', { task_id: r.source });
    expect(shown).toMatchObject({ ok: true, task: { task_id: r.source, phase: 'blocked' } });
    expect(changes).toBe(0);
  });

  it('refuses any other task unauthorized, one that exists and one that does not, in the same words', async () => {
    const r = reaction();
    const a = await r.ask('wake-show', { task_id: r.other });
    const b = await r.ask('wake-show', { task_id: 'k_nonesuch1234' });
    expect(a).toMatchObject({ ok: false, code: 'unauthorized' });
    expect(b).toEqual(a);
  });

  it("refuses an ordinary task's run not_woken", async () => {
    const task = service.create({ title: 'Plain', assignee: 'implementer', createdBy: ALICE, createdVia: THREAD });
    if (!task.ok) throw new Error(task.message);
    const token = mintToken();
    const c = service.claim(task.task.taskId, { tokenHash: hashToken(token) });
    if (!c.ok) throw new Error(c.message);
    expect(await api.handle({ run: c.run.runId, token, command: 'wake-show', input: { task_id: task.task.taskId } })).toEqual({
      ok: false,
      code: 'not_woken',
      message: "this run's task was not made by a wake",
    });
  });

  it("refuses needs_talk once the wake's setter has lost talk tier, live", async () => {
    const r = reaction();
    talk.delete(ALICE);
    expect(await r.ask('wake-show', { task_id: r.source })).toMatchObject({ ok: false, code: 'needs_talk' });
  });

  it('refuses wake_off with wakes off', async () => {
    const r = reaction();
    wakesOn = false;
    expect(await r.ask('wake-show', { task_id: r.source })).toMatchObject({ ok: false, code: 'wake_off' });
  });
});

describe('wake-unblock', () => {
  it("lifts a block the wake carried, as the wake's setter, the wake in its event and its comment the board's", async () => {
    const r = reaction();
    const out = await r.ask('wake-unblock', { task_id: r.source, comment: 'The first one.' });
    expect(out).toMatchObject({ ok: true, task_id: r.source, message: `\`${r.source}\` is unblocked, back to open, as Zhixi Sun (woken by the board)` });
    const lift = eventsOf(t.db, r.source).filter((e) => e.kind === 'unblocked').at(-1);
    expect(lift).toMatchObject({ kind: 'unblocked', actor: ALICE, payload: { wake: getTask(t.db, r.react)?.reactionOf } });
    expect(commentsOf(t.db, r.source).at(-1)).toMatchObject({ author: ALICE, body: '(woken by the board) The first one.' });
    expect(commentsOf(t.db, r.source, { steering: true })).toHaveLength(1);
    expect(changes).toBe(1);
  });

  it('refuses a task the wake did not carry not_this_wake', async () => {
    const r = reaction();
    expect(await r.ask('wake-unblock', { task_id: r.other })).toMatchObject({ ok: false, code: 'not_this_wake' });
  });

  it("refuses needs_operator once the setter has lost operate tier, live", async () => {
    const r = reaction();
    operate.delete(ALICE);
    expect(await r.ask('wake-unblock', { task_id: r.source })).toMatchObject({ ok: false, code: 'needs_operator' });
  });

  it('refuses a block lifted since stale, as the board does, though the task is blocked again', async () => {
    const r = reaction();
    expect(service.unblock(r.source, ALICE, undefined).ok).toBe(true);
    expect(block(t.db, r.source, { kind: 'person', principal: ALICE }, { kind: 'capability', reason: 'No access.' }, NOW + 3).ok).toBe(true);
    expect(getTask(t.db, r.source)?.phase).toBe('blocked');
    expect(await r.ask('wake-unblock', { task_id: r.source })).toMatchObject({ ok: false, code: 'stale' });
    expect(changes).toBe(0);
  });

  it('refuses recurring a block at block_recurrence_limit', async () => {
    const source = newTask(t.db, { createdVia: THREAD, assignee: { kind: 'role', name: 'implementer' } });
    setWake(t.db, source.taskId, { on: true, as: ALICE, maxDepth: 5, role: 'vi-coordinator' }, ALICE, APP, NOW);
    for (let i = 0; i < 4; i += 1) {
      if (i > 0) service.unblock(source.taskId, ALICE, undefined);
      const run = claimed(t.db, source.taskId);
      block(t.db, source.taskId, { kind: 'run', runId: run.runId }, { kind: 'needs_input', reason: 'Which one?' }, NOW + 1);
      closeRun(t.db, run.runId, NOW + 2);
    }
    const last = eventsOf(t.db, source.taskId).filter((e) => e.kind === 'blocked').at(-1);
    expect(last?.payload).toMatchObject({ blockRecurrences: 3 });
    const ask = reactionOf(source.taskId, last?.id ?? 0, 'u-recur');
    expect(await ask({ task_id: source.taskId })).toMatchObject({ ok: false, code: 'recurring' });
  });

  it('lets five woken unblocks through, refuses the sixth with its line once, and starts again after a completion', async () => {
    const source = newTask(t.db, { createdVia: THREAD, assignee: { kind: 'role', name: 'implementer' } });
    setWake(t.db, source.taskId, { on: true, as: ALICE, maxDepth: 5, role: 'vi-coordinator' }, ALICE, APP, NOW);
    let n = 0;
    const cycle = async (blockAgain = true): Promise<WorkerResponse> => {
      n += 1;
      if (!blockAgain) {
        const blocked = eventsOf(t.db, source.taskId).filter((e) => e.kind === 'blocked').at(-1)?.id ?? 0;
        return reactionOf(source.taskId, blocked, `u-cycle-${n}`)({ task_id: source.taskId });
      }
      const run = claimed(t.db, source.taskId);
      block(t.db, source.taskId, { kind: 'run', runId: run.runId }, { kind: n % 2 === 0 ? 'capability' : 'needs_input', reason: 'Which one?' }, NOW + n);
      closeRun(t.db, run.runId, NOW + n);
      const blocked = eventsOf(t.db, source.taskId).filter((e) => e.kind === 'blocked').at(-1)?.id ?? 0;
      return reactionOf(source.taskId, blocked, `u-cycle-${n}`)({ task_id: source.taskId });
    };
    for (let i = 0; i < 5; i += 1) expect(await cycle(), `cycle ${i}`).toMatchObject({ ok: true });
    expect(await cycle()).toMatchObject({ ok: false, code: 'woken_unblock_limit' });
    expect(await cycle(false)).toMatchObject({ ok: false, code: 'woken_unblock_limit' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lark.texts.filter((m) => m.text.includes('unblocked by woken turns'))).toHaveLength(1);
    // A completion resets the count: the task is unblocked by a person, run, and completed. A done task is
    // never reopened on the board, so the reset is read where the limit reads it.
    expect(wokenUnblocksSince(t.db, source.taskId)).toBe(5);
    service.unblock(source.taskId, ALICE, undefined);
    const run = claimed(t.db, source.taskId);
    expect(complete(t.db, source.taskId, { kind: 'run', runId: run.runId }, { summary: 'Done.' }, NOW + 50).ok).toBe(true);
    closeRun(t.db, run.runId, NOW + 50);
    expect(wokenUnblocksSince(t.db, source.taskId)).toBe(0);
  });

  it("refuses not_this_wake once the source task's wake targets another role, as it no longer is the wake's", async () => {
    const r = reaction();
    const moved = setWake(t.db, r.source, { on: true, as: ALICE, maxDepth: 5, role: 'implementer' }, ALICE, APP, NOW + 10);
    expect(moved).toMatchObject({ ok: true, changed: true });
    expect(await r.ask('wake-unblock', { task_id: r.source })).toMatchObject({ ok: false, code: 'not_this_wake' });
    expect(await r.ask('wake-show', { task_id: r.source })).toMatchObject({ ok: false, code: 'unauthorized' });
    expect(getTask(t.db, r.source)?.phase).toBe('blocked');
  });

  it('nudges the dispatcher once for an unblock', async () => {
    const r = reaction();
    await r.ask('wake-unblock', { task_id: r.source });
    expect(changes).toBe(1);
  });
});

/** A reaction task carrying `blockEvent` of `source`, made by a wake of uuid `uuid`, and its run's wake-unblock. */
function reactionOf(source: string, blockEvent: number, uuid: string): (input: Record<string, unknown>) => Promise<WorkerResponse> {
  const sub = subscriptionsOf(t.db, source)[0]?.id ?? 0;
  const made = service.recordRoleWake({
    uuid,
    channel: 'lark',
    appId: APP,
    conversationId: 'oc_team',
    threadId: 'omt_1',
    principal: ALICE,
    depth: 0,
    events: [{ subscriptionId: sub, eventId: blockEvent, taskId: source }],
    role: 'vi-coordinator',
    title: `React to board updates: ${source} blocked`,
    body: 'Board update: …',
  });
  if (!made.ok || 'skipped' in made) throw new Error('no reaction task');
  const token = mintToken();
  const c = service.claim(made.task.taskId, { tokenHash: hashToken(token) });
  if (!c.ok) throw new Error(c.message);
  return async (input) => {
    const out = await api.handle({ run: c.run.runId, token, command: 'wake-unblock', input });
    finish(made.task.taskId);
    return out;
  };
}

/** A task's open run completed and closed, so its workspace is free for the next claim. */
function finish(taskId: string): void {
  const run = openRunOf(t.db, taskId);
  if (run === undefined) return;
  const done = complete(t.db, taskId, { kind: 'run', runId: run.runId }, { summary: 'Done.' }, NOW + 90);
  if (!done.ok) throw new Error(done.message);
  closeRun(t.db, run.runId, NOW + 90);
}

describe('a run linking a reaction task', () => {
  it("is refused wrong_task, though the reaction task's created_from_task is the run's task", async () => {
    const r = reaction();
    const token = mintToken();
    const parent = newTask(t.db, { createdVia: THREAD, assignee: { kind: 'role', name: 'implementer' }, workspace: 'web' });
    t.db.prepare('UPDATE kanban_tasks SET created_from_task = ? WHERE task_id = ?').run(parent.taskId, r.react);
    const c = service.claim(parent.taskId, { tokenHash: hashToken(token) });
    if (!c.ok) throw new Error(c.message);
    expect(await api.handle({ run: c.run.runId, token, command: 'link', input: { parent_id: parent.taskId, child_id: r.react } })).toEqual({
      ok: false,
      code: 'wrong_task',
      message: `run ${c.run.runId} may not link \`${r.react}\`: it is a reaction task, made by a wake, not by this run`,
    });
  });
});

describe("the woken-unblock limit's line of a role's wake with no chat", () => {
  it('is logged, never sent, as no thread follows the task', () => {
    const notes: string[] = [];
    const wakes = new WakeApi({
      db: t.db,
      service,
      tokens: { lookup: () => undefined },
      people: { canTalk: () => true, canOperate: () => true, chatNames: () => () => undefined },
      blockRecurrenceLimit: 3,
      render: { lines: wokenShowText, json: showJson },
      channels: new Map([['lark', lark]]),
      appId: APP,
      zone: 'UTC',
      note: (line) => notes.push(line),
    });
    const task = newTask(t.db, { createdVia: { kind: 'operator' } });
    const line = `\`${task.taskId}\` has been unblocked by woken turns 5 times since it last completed`;
    service.unblockForWake = () => ({ ok: false, code: 'woken_unblock_limit', message: line });
    const wake = { wakeId: 1, channel: 'lark', appId: APP, conversationId: '', threadId: '', principal: ALICE } as Parameters<WakeApi['unblock']>[0];
    expect(wakes.unblock(wake, task.taskId, undefined)).toMatchObject({ ok: false, code: 'woken_unblock_limit' });
    expect(notes).toEqual([`kanban: ${line}`]);
    expect(lark.texts).toEqual([]);
  });
});
