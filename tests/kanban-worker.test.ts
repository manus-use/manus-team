import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claim } from '../src/db/kanban.js';
import { commentsOf, getRun, getTask, parentsOf } from '../src/db/kanban-read.js';
import { KanbanService, type CreateRequest } from '../src/kanban/service.js';
import { hashToken, mintToken } from '../src/kanban/token.js';
import type { RunRow, TaskRow } from '../src/kanban/types.js';
import { WORKER_LIMITS, WorkerApi, type WorkerResponse } from '../src/kanban/worker.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { ALICE, NOW, VIA, WORKSPACES, claimantFor, newTask } from './helpers/kanban.js';

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
  claim(taskId: string): { run: RunRow; token: string; ask(command: string, input?: unknown): Promise<WorkerResponse> };
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
  it('refuses a token that is malformed, unknown, or not the named run’s, and never echoes it', async () => {
    const task = b.create();
    const { run, token } = b.claim(task.taskId);
    const other = mintToken();
    const asks: Array<[unknown, string]> = [
      [{ run: run.runId, token: 'short', command: 'show' }, 'MT_KANBAN_TOKEN is not a run token'],
      [{ run: run.runId, token: other, command: 'show' }, 'no run has this MT_KANBAN_TOKEN'],
      [{ run: 'r_someone_else', token, command: 'show' }, 'MT_KANBAN_RUN is not the run this token belongs to'],
    ];
    for (const [req, message] of asks) {
      const r = await b.api.handle(req);
      expect(r).toEqual({ ok: false, code: 'unauthorized', message });
      expect(JSON.stringify(r)).not.toContain(token);
      expect(JSON.stringify(r)).not.toContain(other);
    }
  });

  it('refuses a person’s run: it reports through chat, not mt kanban', async () => {
    // Under the service, which gives no person work before plan D: as the board would claim one.
    const task = newTask(b.t.db, { assignee: { kind: 'human', name: 'lark:on_bob' }, workspace: 'web' });
    const token = mintToken();
    const claimed = claim(
      b.t.db,
      { taskId: task.taskId, claimant: claimantFor(b.t.db, task.taskId), tokenHash: hashToken(token), workspaces: WORKSPACES },
      NOW,
    );
    if (!claimed.ok) throw new Error(claimed.message);
    const { run } = claimed;
    const ask = (command: string, input: unknown) => b.api.handle({ run: run.runId, token, command, input });
    expect(run.assignee.kind).toBe('human');
    for (const command of ['show', 'complete']) {
      expect(await ask(command, command === 'show' ? {} : { summary: 'x' })).toEqual({
        ok: false,
        code: 'unauthorized',
        message: `run ${run.runId} is a person’s; it reports through chat, not mt kanban`,
      });
    }
    expect(getRun(b.t.db, run.runId)?.outcome).toBeNull();
  });

  it('refuses what is not a request, and an unknown command', async () => {
    const task = b.create();
    const { run, token } = b.claim(task.taskId);
    expect(await b.api.handle('show')).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await b.api.handle({ run: run.runId, token, command: 'show', input: {}, extra: 1 })).toMatchObject({
      ok: false,
      code: 'bad_request',
      message: 'a request has only run, token, command, input',
    });
    expect(await b.api.handle({ run: run.runId, token })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await b.api.handle({ run: run.runId, token, command: 'finish' })).toEqual({
      ok: false,
      code: 'unknown_command',
      message: 'no command "finish" (one of show, complete, review, changes, block, comment, create, link)',
    });
  });
});

describe('worker API: the run’s scope', () => {
  it('shows the task and its context, without the token or its hash', async () => {
    const parent = b.create({ title: 'the parent', workspace: 'web' });
    const p = b.claim(parent.taskId);
    expect(await p.ask('complete', { summary: 'parent done', metadata: { pr: 7 } })).toMatchObject({ ok: true });
    b.service.closeRun(p.run.runId);
    const task = b.create({ title: 'the task', body: 'do it', parents: [parent.taskId], contract: { outcome: 'it works' } });
    b.service.comment(task.taskId, 'please hurry', ALICE, { steers: true });
    // A talk-tier person's comment is for people: `mt kanban show` leaves it out.
    b.service.comment(task.taskId, 'just watching', 'lark:on_bob', { steers: false });
    const { run, token, ask } = b.claim(task.taskId);

    const r = await ask('show');
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

  it('reports complete on its own task, and tells the dispatcher something changed', async () => {
    const task = b.create();
    const { run, ask } = b.claim(task.taskId);
    expect(await ask('complete', { summary: 'parsed', metadata: { files: ['a.ts'] } })).toEqual({
      ok: true,
      task_id: task.taskId,
      phase: 'done',
      outcome: 'completed',
    });
    expect(getRun(b.t.db, run.runId)).toMatchObject({ outcome: 'completed', summary: 'parsed', metadata: { files: ['a.ts'] } });
    expect(b.changes).toBe(1);
  });

  it("sends complete on a task that names a reviewer for review, and says so", async () => {
    const task = b.create({ reviewer: 'reviewer' });
    const { run, ask } = b.claim(task.taskId);
    expect(await ask('complete', { summary: 'parsed' })).toEqual({
      ok: true,
      task_id: task.taskId,
      phase: 'review',
      outcome: 'review_requested',
      message: 'sent for review to role reviewer: the task names a reviewer, so complete asks for review',
    });
    expect(getRun(b.t.db, run.runId)).toMatchObject({ outcome: 'review_requested', summary: 'parsed' });
  });

  it('names a person reviewer it was sent to by the name the gateway knows, else by id', async () => {
    const people = { canTalk: () => true };
    const service = new KanbanService({ db: b.t.db, roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])), workspaces: WORKSPACES, clock: new ManualClock(), people });
    const api = new WorkerApi({ db: b.t.db, service, nameOf: (p) => (p === 'lark:on_bob' ? 'Bob Li' : undefined) });
    for (const [reviewer, whom, workspace] of [
      ['lark:on_bob', 'Bob Li (lark:on_bob)', 'web'],
      ['lark:on_carol', 'lark:on_carol', 'api'],
    ] as const) {
      const made = service.create({ title: 'a task', assignee: 'implementer', reviewer, workspace, createdBy: ALICE, createdVia: VIA });
      if (!made.ok) throw new Error(made.message);
      const token = mintToken();
      const claimed = service.claim(made.task.taskId, { tokenHash: hashToken(token) });
      if (!claimed.ok) throw new Error(claimed.message);
      expect(await api.handle({ run: claimed.run.runId, token, command: 'complete', input: { summary: 'parsed' } })).toMatchObject({
        ok: true,
        phase: 'review',
        message: `sent for review to ${whom}: the task names a reviewer, so complete asks for review`,
      });
    }
  });

  it("refuses a role reviewer's report once an operator's answer has superseded its run", async () => {
    const task = b.create({ reviewer: 'reviewer' });
    const work = b.claim(task.taskId);
    expect(await work.ask('review', { summary: 'parsed' })).toMatchObject({ ok: true, phase: 'review' });
    b.service.closeRun(work.run.runId);
    const review = b.claim(task.taskId);
    const answer = await b.service.complete(
      task.taskId,
      { kind: 'person', principal: ALICE, runId: review.run.runId, as: 'operator' },
      { summary: 'fine' },
    );
    expect(answer).toMatchObject({ ok: true, task: { phase: 'done' }, run: { outcome: 'superseded' } });
    expect(await review.ask('complete', { summary: 'approved' })).toEqual({
      ok: false,
      code: 'run_superseded',
      message: `run ${review.run.runId} was ended (superseded); its task has moved on without it`,
    });
  });

  it('after its own report: show, comment, create and link still work; a second report is already_reported', async () => {
    const task = b.create();
    const { ask } = b.claim(task.taskId);
    expect(await ask('complete', { summary: 'done' })).toMatchObject({ ok: true });

    expect(await ask('show')).toMatchObject({ ok: true, run: { outcome: 'completed' } });
    expect(await ask('comment', { body: 'one more thing' })).toMatchObject({ ok: true, task_id: task.taskId });
    const a = await ask('create', { title: 'follow-up a', body: '', assignee: 'implementer' });
    const c = await ask('create', { title: 'follow-up b', body: '', assignee: 'implementer' });
    expect(a).toMatchObject({ ok: true, existing: false });
    expect(await ask('link', { parent_id: a.ok ? a['task_id'] : '', child_id: c.ok ? c['task_id'] : '' })).toEqual({ ok: true, added: true });

    expect(await ask('complete', { summary: 'again' })).toMatchObject({ ok: false, code: 'already_reported' });
    expect(await ask('block', { kind: 'needs_input', reason: 'hm' })).toMatchObject({ ok: false, code: 'already_reported' });
  });

  it('once the dispatcher has decided the run, nothing works: run_superseded', async () => {
    const task = b.create();
    const { run, ask } = b.claim(task.taskId);
    expect(b.service.endRun(run.runId, { outcome: 'timed_out', error: 'too long', hadSideEffects: false }).ok).toBe(true);
    for (const [command, input] of [
      ['show', {}],
      ['comment', { body: 'late' }],
      ['complete', { summary: 'done anyway' }],
    ] as const) {
      expect(await ask(command, input)).toEqual({
        ok: false,
        code: 'run_superseded',
        message: `run ${run.runId} was ended (timed_out); its task has moved on without it`,
      });
    }
    expect(commentsOf(b.t.db, task.taskId)).toEqual([]);
  });

  it('a report after the run is closed is run_superseded, and the outcome stands (spec §7.6)', async () => {
    const task = b.create();
    const { run, ask } = b.claim(task.taskId);
    expect(await ask('block', { kind: 'needs_input', reason: 'which database?' })).toMatchObject({ ok: true, phase: 'blocked' });
    expect(b.service.closeRun(run.runId).ok).toBe(true);
    const message = `run ${run.runId} is over; its task has moved on without it`;
    expect(await ask('complete', { summary: 'found it' })).toEqual({ ok: false, code: 'run_superseded', message });
    expect(await ask('comment', { body: 'a background job, still talking' })).toEqual({ ok: false, code: 'run_superseded', message });
    expect(getRun(b.t.db, run.runId)?.outcome).toBe('blocked');
    expect(b.changes).toBe(1);
  });
});

describe('worker API: each command', () => {
  it('blocks on a dependency, linking the parents it names', async () => {
    const first = b.create({ title: 'first' });
    const task = b.create();
    const { ask } = b.claim(task.taskId);
    expect(await ask('block', { kind: 'dependency', reason: 'needs first', parents: [first.taskId] })).toMatchObject({
      ok: true,
      phase: 'open',
      outcome: 'blocked',
    });
    expect(parentsOf(b.t.db, task.taskId).map((p) => p.taskId)).toEqual([first.taskId]);
  });

  it('asks for review by a named reviewer; a reviewer’s changes come from a review run only', async () => {
    const task = b.create();
    const work = b.claim(task.taskId);
    expect(await work.ask('changes', { reason: 'not mine to ask' })).toMatchObject({ ok: false, code: 'illegal_transition' });
    expect(await work.ask('review', { summary: 'have a look', reviewer: 'reviewer' })).toMatchObject({
      ok: true,
      phase: 'review',
      outcome: 'review_requested',
    });
    b.service.closeRun(work.run.runId);
    const review = b.claim(task.taskId);
    expect(await review.ask('changes', { reason: 'add a test' })).toMatchObject({ ok: true, phase: 'open', outcome: 'changes_requested' });
  });

  it('creates a task from the run: namespaced key, its creator recorded, a repeat returning the same task', async () => {
    const task = b.create();
    const { run, ask } = b.claim(task.taskId);
    const req = { title: 'docs', body: 'write them', assignee: 'docs-writer', idempotency_key: 'docs-1', contract: { outcome: 'written' } };
    const first = await ask('create', req);
    expect(first).toMatchObject({ ok: true, existing: false });
    const created = getTask(b.t.db, first.ok ? String(first['task_id']) : '');
    expect(created).toMatchObject({
      createdBy: `run:${run.runId}`,
      createdVia: { kind: 'run', runId: run.runId },
      createdFromTask: task.taskId,
      idempotencyKey: `run-task:${task.taskId}:docs-1`,
      contract: { outcome: 'written' },
    });
    expect(await ask('create', req)).toEqual({ ok: true, task_id: created?.taskId, existing: true });
    expect(await ask('create', { ...req, idempotency_key: 'docs-2', assignee: 'nobody' })).toMatchObject({ ok: false, code: 'unknown_role' });
  });

  it('links only the tasks its own task created', async () => {
    const elsewhere = b.create({ title: 'someone else’s' });
    const task = b.create();
    const { run, ask } = b.claim(task.taskId);
    const mine = await ask('create', { title: 'mine', body: '', assignee: 'implementer' });
    const child = mine.ok ? String(mine['task_id']) : '';
    expect(await ask('link', { parent_id: elsewhere.taskId, child_id: child })).toEqual({ ok: true, added: true });
    expect(await ask('link', { parent_id: child, child_id: elsewhere.taskId })).toEqual({
      ok: false,
      code: 'wrong_task',
      message: `run ${run.runId} may link only the tasks its task created, and ${elsewhere.taskId} is not one`,
    });
    expect(await ask('link', { parent_id: child, child_id: 'k_missing' })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('comments on its own task, or on another by task_id, as the run', async () => {
    const other = b.create({ title: 'other' });
    const task = b.create();
    const { run, ask } = b.claim(task.taskId);
    expect(await ask('comment', { body: 'on mine' })).toMatchObject({ ok: true, task_id: task.taskId });
    expect(await ask('comment', { body: 'on yours', task_id: other.taskId })).toMatchObject({ ok: true, task_id: other.taskId });
    expect(commentsOf(b.t.db, other.taskId)).toMatchObject([{ author: `run:${run.runId}`, body: 'on yours' }]);
  });
});

describe('worker API: strict input', () => {
  it('refuses an unknown field, naming the known ones; a missing or mistyped one; and input that is not an object', async () => {
    const task = b.create();
    const { ask } = b.claim(task.taskId);
    expect(await ask('complete', { sumary: 'typo' })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'complete takes no field "sumary" (it takes summary, metadata)',
    });
    expect(await ask('show', { verbose: true })).toEqual({ ok: false, code: 'invalid', message: 'show takes no field "verbose"' });
    expect(await ask('complete', {})).toEqual({ ok: false, code: 'invalid', message: 'complete needs summary, as text' });
    expect(await ask('complete', { summary: 42 })).toEqual({ ok: false, code: 'invalid', message: 'summary is text' });
    expect(await ask('block', { kind: 'dependency', reason: 'x', parents: 'k_1' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await ask('complete', ['done'])).toEqual({ ok: false, code: 'invalid', message: 'complete reads a JSON object on stdin' });
    expect(b.changes).toBe(0);
  });

  it('refuses a key that is only inherited, as constructor, toString and __proto__ are, as unknown', async () => {
    const task = b.create();
    const { ask } = b.claim(task.taskId);
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      // Parsed, as the socket parses it: __proto__ is then a key of its own.
      const input: unknown = JSON.parse(`{"summary": "x", ${JSON.stringify(key)}: "y"}`);
      expect(await ask('complete', input)).toEqual({
        ok: false,
        code: 'invalid',
        message: `complete takes no field ${JSON.stringify(key)} (it takes summary, metadata)`,
      });
    }
    expect(b.changes).toBe(0);
  });

  it('takes metadata only as a plain object, at most 64 deep', async () => {
    const task = b.create();
    const { run, ask } = b.claim(task.taskId);
    // `depth` objects and lists inside one another, the outermost an object.
    const nested = (depth: number): unknown => {
      let v: unknown = {};
      for (let i = 2; i < depth; i += 1) v = i % 2 === 0 ? [v] : { a: v };
      return { a: v };
    };
    for (const metadata of ['just text', ['a', 'list'], 7, true]) {
      expect(await ask('complete', { summary: 'x', metadata })).toEqual({ ok: false, code: 'invalid', message: 'metadata is a JSON object' });
    }
    expect(await ask('complete', { summary: 'x', metadata: nested(100) })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'metadata nests more than 64 deep',
    });
    expect(await ask('complete', { summary: 'x', metadata: nested(65) })).toMatchObject({ ok: false, code: 'invalid' });
    expect(getRun(b.t.db, run.runId)?.outcome).toBeNull();
    expect(await ask('complete', { summary: 'x', metadata: nested(64) })).toMatchObject({ ok: true });
  });

  it('refuses text over its size, and nothing is written', async () => {
    const task = b.create();
    const { run, ask } = b.claim(task.taskId);
    const big = (n: number) => 'x'.repeat(n + 1);
    expect(await ask('complete', { summary: big(WORKER_LIMITS.summary) })).toEqual({
      ok: false,
      code: 'too_large',
      message: `summary is ${WORKER_LIMITS.summary + 1} bytes; it may be at most ${WORKER_LIMITS.summary}`,
    });
    expect(await ask('complete', { summary: 'ok', metadata: { log: big(WORKER_LIMITS.metadata) } })).toMatchObject({ code: 'too_large' });
    expect(await ask('create', { title: big(WORKER_LIMITS.title), body: '', assignee: 'implementer' })).toMatchObject({ code: 'too_large' });
    expect(await ask('create', { title: 't', body: big(WORKER_LIMITS.body), assignee: 'implementer' })).toMatchObject({ code: 'too_large' });
    expect(
      await ask('create', { title: 't', body: '', assignee: 'implementer', contract: { outcome: big(WORKER_LIMITS.contractField) } }),
    ).toMatchObject({ code: 'too_large' });
    const many = Array.from({ length: WORKER_LIMITS.parents + 1 }, (_, i) => `k_${i}`);
    expect(await ask('block', { kind: 'dependency', reason: 'x', parents: many })).toMatchObject({ code: 'too_large' });
    expect(getRun(b.t.db, run.runId)?.outcome).toBeNull();
    expect(b.changes).toBe(0);
  });
});

describe('worker API: masking', () => {
  it('masks what a refusal quotes before cutting it, so no part of a secret across the cut is left', async () => {
    const secret = 'Zq9-straddling-secret-77';
    addSecrets([secret]);
    const task = b.create();
    const { run, token, ask } = b.claim(task.taskId);
    // Each placed so the 256-byte cut falls inside the secret.
    const answers = [
      await ask('complete', { summary: 'x', [`${'x'.repeat(250)}${secret}`]: 1 }),
      await b.api.handle({ run: run.runId, token, command: `${'x'.repeat(250)}${secret}`, input: {} }),
      await ask('create', { title: 't', body: '', assignee: 'implementer', contract: { [`${'x'.repeat(252)}${secret}`]: 'y'.repeat(WORKER_LIMITS.contractField + 1) } }),
    ];
    expect(answers.map((r) => r.ok)).toEqual([false, false, false]);
    for (const r of answers) expect(JSON.stringify(r)).not.toContain(secret.slice(0, 3));
  });

  it('lands agent text on the board through the service, which masks it on write', async () => {
    addSecrets(['sk-live-1234567890']);
    const task = b.create();
    const { run, ask } = b.claim(task.taskId);
    expect((await ask('comment', { body: 'key sk-live-1234567890' })).ok).toBe(true);
    const created = await ask('create', { title: 'use sk-live-1234567890', body: 'with sk-live-1234567890', assignee: 'implementer' });
    expect((await ask('complete', { summary: 'used sk-live-1234567890', metadata: { key: 'sk-live-1234567890' } })).ok).toBe(true);

    expect(commentsOf(b.t.db, task.taskId)[0]?.body).toBe(`key ${MASK}`);
    expect(getTask(b.t.db, created.ok ? String(created['task_id']) : '')).toMatchObject({
      title: `use ${MASK}`,
      body: `with ${MASK}`,
    });
    expect(getRun(b.t.db, run.runId)).toMatchObject({ summary: `used ${MASK}`, metadata: { key: MASK } });
  });

  it('keeps answering when telling the dispatcher fails', async () => {
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
      expect(await api.handle({ run: runId, token, command: 'complete', input: { summary: 'done' } })).toMatchObject({ ok: true });
    } finally {
      t.close();
    }
  });
});

describe('worker API: answers', () => {
  it('answers with a promise, as a report waits for its checks', async () => {
    const task = b.create();
    const { run, token } = b.claim(task.taskId);
    const answer = b.api.handle({ run: run.runId, token, command: 'complete', input: { summary: 'done' } });
    expect(answer).toBeInstanceOf(Promise);
    expect(await answer).toMatchObject({ ok: true, phase: 'done' });
  });
});

describe('worker API: show, for gates, review and rework', () => {
  it('shows the gates and their last run', async () => {
    // A board whose gates run, over a runner that starts nothing: this one fails.
    const service = new KanbanService({
      db: b.t.db,
      roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
      workspaces: WORKSPACES,
      clock: new ManualClock(),
      checks: {
        workspaceDirs: new Map([['web', '/ws/web']]),
        env: {},
        runGate: async () => ({ exitCode: 2, signal: null, timedOut: false, output: 'FAIL parser' }),
        readCommit: async () => ({ commit: null, dirty: true }),
      },
    });
    const api = new WorkerApi({ db: b.t.db, service });
    const task = b.create();
    expect(service.addGate(task.taskId, { command: 'npm test', timeoutS: 30 }, ALICE).ok).toBe(true);
    const token = mintToken();
    const claimed = service.claim(task.taskId, { tokenHash: hashToken(token) });
    if (!claimed.ok) throw new Error(claimed.message);
    const ask = (command: string, input: unknown = {}) => api.handle({ run: claimed.run.runId, token, command, input });
    expect(await ask('complete', { summary: 'done' })).toMatchObject({ ok: false, code: 'gate_failed' });
    expect(await ask('show')).toMatchObject({
      ok: true,
      gates: [{ gate_id: expect.any(Number), command: 'npm test', timeout_s: 30 }],
      last_gate_run: {
        for: 'complete',
        by: `run:${claimed.run.runId}`,
        passed: false,
        aborted: false,
        not_run: 0,
        results: [{ command: 'npm test', exit_code: 2, signal: null, timed_out: false, duration_ms: 0, output: 'FAIL parser' }],
      },
      review: null,
      rework: null,
    });
  });

  it('masks a gate command holding a secret registered after it was defined', async () => {
    const task = b.create();
    expect(b.service.addGate(task.taskId, { command: 'curl -H "k: sk-live-1234567890" https://ci' }, ALICE).ok).toBe(true);
    addSecrets(['sk-live-1234567890']);
    const run = b.claim(task.taskId);
    const shown = await run.ask('show');
    expect(shown).toMatchObject({ ok: true, gates: [{ command: `curl -H "k: ${MASK}" https://ci` }] });
    expect(JSON.stringify(shown)).not.toContain('sk-live-1234567890');
  });

  it('shows the commit each attempt reported, and a rework its reason and previous handoff', async () => {
    const task = b.create({ reviewer: 'reviewer' });
    const work = b.claim(task.taskId);
    expect(await work.ask('review', { summary: 'v1' })).toMatchObject({ ok: true });
    b.service.closeRun(work.run.runId);
    const review = b.claim(task.taskId);
    expect(await review.ask('show')).toMatchObject({
      review: { by: `run:${work.run.runId}`, run_id: work.run.runId, summary: 'v1', reported_commit: null, reported_dirty: null },
      rework: null,
    });
    expect(await review.ask('changes', { reason: 'add a test' })).toMatchObject({ ok: true });
    b.service.closeRun(review.run.runId);
    const rework = b.claim(task.taskId);
    expect(await rework.ask('show')).toMatchObject({
      attempts: [
        { attempt: 1, outcome: 'review_requested', reported_commit: null, reported_dirty: null },
        { attempt: 2, outcome: 'changes_requested' },
      ],
      review: null,
      rework: { by: `run:${review.run.runId}`, reason: 'add a test', handoff: { summary: 'v1' } },
    });
  });
});
