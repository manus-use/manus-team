import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commentsOf, getRun, getTask, parentsOf } from '../src/db/kanban-read.js';
import { KanbanService, type CreateRequest } from '../src/kanban/service.js';
import { hashToken, mintToken } from '../src/kanban/token.js';
import type { RunRow, TaskRow } from '../src/kanban/types.js';
import { WORKER_LIMITS, WorkerApi, type WorkerResponse } from '../src/kanban/worker.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * The worker API over JSON, against a real board: what `mt kanban` sends,
 * without the socket. A run is claimed through the service with a token whose
 * hash it records, as the dispatcher claims one.
 */

interface Board {
  t: TestDb;
  service: KanbanService;
  api: WorkerApi;
  changes: number;
  create(req?: Partial<CreateRequest>): TaskRow;
  /** Claim the task's next run with a fresh token, and a way to ask as that run. */
  claim(taskId: string): { run: RunRow; token: string; ask(command: string, input?: unknown): WorkerResponse };
}

let b: Board;

function board(): Board {
  const t = testDb();
  const service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
  });
  const out: Board = {
    t,
    service,
    api: new WorkerApi({ db: t.db, service, changed: () => (out.changes += 1) }),
    changes: 0,
    create(req = {}) {
      const r = service.create({ title: 'a task', assignee: 'implementer', workspace: 'web', createdBy: ALICE, createdVia: VIA, ...req });
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      return r.task;
    },
    claim(taskId) {
      const token = mintToken();
      const r = service.claim(taskId, { tokenHash: hashToken(token) });
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      const run = r.run;
      return { run, token, ask: (command, input = {}) => out.api.handle({ run: run.runId, token, command, input }) };
    },
  };
  return out;
}

beforeEach(() => {
  clearSecrets();
  b = board();
});
afterEach(() => {
  clearSecrets();
  b.t.close();
});

describe('worker API: who is asking', () => {
  it('refuses a token that is malformed, unknown, or not the named run’s, and never echoes it', () => {
    const task = b.create();
    const { run, token } = b.claim(task.taskId);
    const other = mintToken();
    const asks: Array<[unknown, string]> = [
      [{ run: run.runId, token: 'short', command: 'show' }, 'MT_KANBAN_TOKEN is not a run token'],
      [{ run: run.runId, token: other, command: 'show' }, 'no run has this MT_KANBAN_TOKEN'],
      [{ run: 'r_someone_else', token, command: 'show' }, 'MT_KANBAN_RUN is not the run this token belongs to'],
    ];
    for (const [req, message] of asks) {
      const r = b.api.handle(req);
      expect(r).toEqual({ ok: false, code: 'unauthorized', message });
      expect(JSON.stringify(r)).not.toContain(token);
      expect(JSON.stringify(r)).not.toContain(other);
    }
  });

  it('refuses what is not a request, and an unknown command', () => {
    const task = b.create();
    const { run, token } = b.claim(task.taskId);
    expect(b.api.handle('show')).toMatchObject({ ok: false, code: 'bad_request' });
    expect(b.api.handle({ run: run.runId, token, command: 'show', input: {}, extra: 1 })).toMatchObject({
      ok: false,
      code: 'bad_request',
      message: 'a request has only run, token, command, input',
    });
    expect(b.api.handle({ run: run.runId, token })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(b.api.handle({ run: run.runId, token, command: 'finish' })).toEqual({
      ok: false,
      code: 'unknown_command',
      message: 'no command "finish" (one of show, complete, review, changes, block, comment, create, link)',
    });
  });
});

describe('worker API: the run’s scope', () => {
  it('shows the task and its context, without the token or its hash', () => {
    const parent = b.create({ title: 'the parent', workspace: 'web' });
    const p = b.claim(parent.taskId);
    expect(p.ask('complete', { summary: 'parent done', metadata: { pr: 7 } })).toMatchObject({ ok: true });
    b.service.closeRun(p.run.runId);
    const task = b.create({ title: 'the task', body: 'do it', parents: [parent.taskId], contract: { outcome: 'it works' } });
    b.service.comment(task.taskId, 'please hurry', ALICE);
    const { run, token, ask } = b.claim(task.taskId);

    const r = ask('show');
    expect(r).toMatchObject({
      ok: true,
      run: { run_id: run.runId, kind: 'work', attempt: 1, outcome: null },
      task: { task_id: task.taskId, title: 'the task', body: 'do it', contract: { outcome: 'it works' }, assignee: 'implementer', status: 'running' },
      parents: [{ task_id: parent.taskId, title: 'the parent', phase: 'done', summary: 'parent done', metadata: { pr: 7 } }],
      attempts: [],
      comments: [{ author: ALICE, body: 'please hurry' }],
      children: [],
    });
    expect(JSON.stringify(r)).not.toContain(token);
    expect(JSON.stringify(r)).not.toContain(hashToken(token));
    expect(b.changes).toBe(1);
  });

  it('reports complete on its own task, and tells the dispatcher something changed', () => {
    const task = b.create();
    const { run, ask } = b.claim(task.taskId);
    expect(ask('complete', { summary: 'parsed', metadata: { files: ['a.ts'] } })).toEqual({
      ok: true,
      task_id: task.taskId,
      phase: 'done',
      outcome: 'completed',
    });
    expect(getRun(b.t.db, run.runId)).toMatchObject({ outcome: 'completed', summary: 'parsed', metadata: { files: ['a.ts'] } });
    expect(b.changes).toBe(1);
  });

  it('after its own report: show, comment, create and link still work; a second report is already_reported', () => {
    const task = b.create();
    const { ask } = b.claim(task.taskId);
    expect(ask('complete', { summary: 'done' })).toMatchObject({ ok: true });

    expect(ask('show')).toMatchObject({ ok: true, run: { outcome: 'completed' } });
    expect(ask('comment', { body: 'one more thing' })).toMatchObject({ ok: true, task_id: task.taskId });
    const a = ask('create', { title: 'follow-up a', body: '', assignee: 'implementer' });
    const c = ask('create', { title: 'follow-up b', body: '', assignee: 'implementer' });
    expect(a).toMatchObject({ ok: true, existing: false });
    expect(ask('link', { parent_id: a.ok ? a['task_id'] : '', child_id: c.ok ? c['task_id'] : '' })).toEqual({ ok: true, added: true });

    expect(ask('complete', { summary: 'again' })).toMatchObject({ ok: false, code: 'already_reported' });
    expect(ask('block', { kind: 'needs_input', reason: 'hm' })).toMatchObject({ ok: false, code: 'already_reported' });
  });

  it('once the dispatcher has decided the run, nothing works: run_superseded', () => {
    const task = b.create();
    const { run, ask } = b.claim(task.taskId);
    expect(b.service.endRun(run.runId, { outcome: 'timed_out', error: 'too long', hadSideEffects: false }).ok).toBe(true);
    for (const [command, input] of [
      ['show', {}],
      ['comment', { body: 'late' }],
      ['complete', { summary: 'done anyway' }],
    ] as const) {
      expect(ask(command, input)).toEqual({
        ok: false,
        code: 'run_superseded',
        message: `run ${run.runId} was ended (timed_out); its task has moved on without it`,
      });
    }
    expect(commentsOf(b.t.db, task.taskId)).toEqual([]);
  });

  it('a report after the run is closed is run_superseded, and the outcome stands (spec §7.6)', () => {
    const task = b.create();
    const { run, ask } = b.claim(task.taskId);
    expect(ask('block', { kind: 'needs_input', reason: 'which database?' })).toMatchObject({ ok: true, phase: 'blocked' });
    expect(b.service.closeRun(run.runId).ok).toBe(true);
    const message = `run ${run.runId} is over; its task has moved on without it`;
    expect(ask('complete', { summary: 'found it' })).toEqual({ ok: false, code: 'run_superseded', message });
    expect(ask('comment', { body: 'a background job, still talking' })).toEqual({ ok: false, code: 'run_superseded', message });
    expect(getRun(b.t.db, run.runId)?.outcome).toBe('blocked');
    expect(b.changes).toBe(1);
  });
});

describe('worker API: each command', () => {
  it('blocks on a dependency, linking the parents it names', () => {
    const first = b.create({ title: 'first' });
    const task = b.create();
    const { ask } = b.claim(task.taskId);
    expect(ask('block', { kind: 'dependency', reason: 'needs first', parents: [first.taskId] })).toMatchObject({
      ok: true,
      phase: 'open',
      outcome: 'blocked',
    });
    expect(parentsOf(b.t.db, task.taskId).map((p) => p.taskId)).toEqual([first.taskId]);
  });

  it('asks for review by a named reviewer; a reviewer’s changes come from a review run only', () => {
    const task = b.create();
    const work = b.claim(task.taskId);
    expect(work.ask('changes', { reason: 'not mine to ask' })).toMatchObject({ ok: false, code: 'illegal_transition' });
    expect(work.ask('review', { summary: 'have a look', reviewer: 'reviewer' })).toMatchObject({
      ok: true,
      phase: 'review',
      outcome: 'review_requested',
    });
    b.service.closeRun(work.run.runId);
    const review = b.claim(task.taskId);
    expect(review.ask('changes', { reason: 'add a test' })).toMatchObject({ ok: true, phase: 'open', outcome: 'changes_requested' });
  });

  it('creates a task from the run: namespaced key, its creator recorded, a repeat returning the same task', () => {
    const task = b.create();
    const { run, ask } = b.claim(task.taskId);
    const req = { title: 'docs', body: 'write them', assignee: 'docs-writer', idempotency_key: 'docs-1', contract: { outcome: 'written' } };
    const first = ask('create', req);
    expect(first).toMatchObject({ ok: true, existing: false });
    const created = getTask(b.t.db, first.ok ? String(first['task_id']) : '');
    expect(created).toMatchObject({
      createdBy: `run:${run.runId}`,
      createdVia: { kind: 'run', runId: run.runId },
      createdFromTask: task.taskId,
      idempotencyKey: `run-task:${task.taskId}:docs-1`,
      contract: { outcome: 'written' },
    });
    expect(ask('create', req)).toEqual({ ok: true, task_id: created?.taskId, existing: true });
    expect(ask('create', { ...req, idempotency_key: 'docs-2', assignee: 'nobody' })).toMatchObject({ ok: false, code: 'unknown_role' });
  });

  it('links only the tasks its own task created', () => {
    const elsewhere = b.create({ title: 'someone else’s' });
    const task = b.create();
    const { run, ask } = b.claim(task.taskId);
    const mine = ask('create', { title: 'mine', body: '', assignee: 'implementer' });
    const child = mine.ok ? String(mine['task_id']) : '';
    expect(ask('link', { parent_id: elsewhere.taskId, child_id: child })).toEqual({ ok: true, added: true });
    expect(ask('link', { parent_id: child, child_id: elsewhere.taskId })).toEqual({
      ok: false,
      code: 'wrong_task',
      message: `run ${run.runId} may link only the tasks its task created, and ${elsewhere.taskId} is not one`,
    });
    expect(ask('link', { parent_id: child, child_id: 'k_missing' })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('comments on its own task, or on another by task_id, as the run', () => {
    const other = b.create({ title: 'other' });
    const task = b.create();
    const { run, ask } = b.claim(task.taskId);
    expect(ask('comment', { body: 'on mine' })).toMatchObject({ ok: true, task_id: task.taskId });
    expect(ask('comment', { body: 'on yours', task_id: other.taskId })).toMatchObject({ ok: true, task_id: other.taskId });
    expect(commentsOf(b.t.db, other.taskId)).toMatchObject([{ author: `run:${run.runId}`, body: 'on yours' }]);
  });
});

describe('worker API: strict input', () => {
  it('refuses an unknown field, naming the known ones; a missing or mistyped one; and input that is not an object', () => {
    const task = b.create();
    const { ask } = b.claim(task.taskId);
    expect(ask('complete', { sumary: 'typo' })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'complete takes no field "sumary" (it takes summary, metadata)',
    });
    expect(ask('show', { verbose: true })).toEqual({ ok: false, code: 'invalid', message: 'show takes no field "verbose"' });
    expect(ask('complete', {})).toEqual({ ok: false, code: 'invalid', message: 'complete needs summary, as text' });
    expect(ask('complete', { summary: 42 })).toEqual({ ok: false, code: 'invalid', message: 'summary is text' });
    expect(ask('block', { kind: 'dependency', reason: 'x', parents: 'k_1' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(ask('complete', ['done'])).toEqual({ ok: false, code: 'invalid', message: 'complete reads a JSON object on stdin' });
    expect(b.changes).toBe(0);
  });

  it('refuses text over its size, and nothing is written', () => {
    const task = b.create();
    const { run, ask } = b.claim(task.taskId);
    const big = (n: number) => 'x'.repeat(n + 1);
    expect(ask('complete', { summary: big(WORKER_LIMITS.summary) })).toEqual({
      ok: false,
      code: 'too_large',
      message: `summary is ${WORKER_LIMITS.summary + 1} bytes; it may be at most ${WORKER_LIMITS.summary}`,
    });
    expect(ask('complete', { summary: 'ok', metadata: { log: big(WORKER_LIMITS.metadata) } })).toMatchObject({ code: 'too_large' });
    expect(ask('create', { title: big(WORKER_LIMITS.title), body: '', assignee: 'implementer' })).toMatchObject({ code: 'too_large' });
    expect(ask('create', { title: 't', body: big(WORKER_LIMITS.body), assignee: 'implementer' })).toMatchObject({ code: 'too_large' });
    expect(
      ask('create', { title: 't', body: '', assignee: 'implementer', contract: { outcome: big(WORKER_LIMITS.contractField) } }),
    ).toMatchObject({ code: 'too_large' });
    const many = Array.from({ length: WORKER_LIMITS.parents + 1 }, (_, i) => `k_${i}`);
    expect(ask('block', { kind: 'dependency', reason: 'x', parents: many })).toMatchObject({ code: 'too_large' });
    expect(getRun(b.t.db, run.runId)?.outcome).toBeNull();
    expect(b.changes).toBe(0);
  });
});

describe('worker API: masking', () => {
  it('lands agent text on the board through the service, which masks it on write', () => {
    addSecrets(['sk-live-1234567890']);
    const task = b.create();
    const { run, ask } = b.claim(task.taskId);
    expect(ask('comment', { body: 'key sk-live-1234567890' }).ok).toBe(true);
    const created = ask('create', { title: 'use sk-live-1234567890', body: 'with sk-live-1234567890', assignee: 'implementer' });
    expect(ask('complete', { summary: 'used sk-live-1234567890', metadata: { key: 'sk-live-1234567890' } }).ok).toBe(true);

    expect(commentsOf(b.t.db, task.taskId)[0]?.body).toBe(`key ${MASK}`);
    expect(getTask(b.t.db, created.ok ? String(created['task_id']) : '')).toMatchObject({
      title: `use ${MASK}`,
      body: `with ${MASK}`,
    });
    expect(getRun(b.t.db, run.runId)).toMatchObject({ summary: `used ${MASK}`, metadata: { key: MASK } });
  });

  it('keeps answering when telling the dispatcher fails', () => {
    const t = testDb();
    try {
      const service = new KanbanService({ db: t.db, roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])), workspaces: WORKSPACES });
      const api = new WorkerApi({
        db: t.db,
        service,
        changed: () => {
          throw new Error('no dispatcher');
        },
      });
      const created = service.create({ title: 't', assignee: 'implementer', workspace: 'web', createdBy: ALICE, createdVia: VIA });
      const token = mintToken();
      const claimed = created.ok ? service.claim(created.task.taskId, { tokenHash: hashToken(token) }) : undefined;
      const runId = claimed?.ok === true ? claimed.run.runId : '';
      expect(api.handle({ run: runId, token, command: 'complete', input: { summary: 'done' } })).toMatchObject({ ok: true });
    } finally {
      t.close();
    }
  });
});
