import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addComment, createTask, type NewTask } from '../src/db/kanban.js';
import { childrenOf, commentsOf, eventsOf, getTask, parentsOf, taskView } from '../src/db/kanban-read.js';
import type { TaskRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';

const NOW = 1_760_000_000_000;
const VIA = { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat', threadId: '' } as const;
let h: TestDb;

beforeEach(() => {
  clearSecrets();
  h = testDb();
});

afterEach(() => {
  h.close();
  clearSecrets();
});

function create(t: Partial<NewTask> = {}): TaskRow {
  const r = createTask(h.db, { title: 'Write the parser', createdBy: 'lark:on_alice', createdVia: VIA, ...t }, NOW);
  if (!r.ok) throw new Error(r.message);
  return r.task;
}

function taskCount(): number {
  return h.db.prepare<[], { n: number }>('SELECT count(*) AS n FROM kanban_tasks').get()?.n ?? -1;
}

describe('createTask', () => {
  it('creates an open task, and records its creation', () => {
    const task = create({
      body: 'Parse the config file.',
      contract: { outcome: 'config parses', stop_when: 'the format is unclear' },
      assignee: { kind: 'role', name: 'implementer' },
      workspace: 'web',
      priority: 2,
    });
    expect(task).toMatchObject({
      title: 'Write the parser',
      body: 'Parse the config file.',
      contract: { outcome: 'config parses', stop_when: 'the format is unclear' },
      assignee: { kind: 'role', name: 'implementer' },
      reviewer: null,
      workspace: 'web',
      phase: 'open',
      priority: 2,
      retryOnCrash: 'always',
      consecutiveFailures: 0,
      createdBy: 'lark:on_alice',
      createdVia: VIA,
      createdAt: NOW,
      closedAt: null,
      createdFromTask: null,
    });
    expect(task.taskId).toMatch(/^k_/);
    expect(eventsOf(h.db, task.taskId).map((e) => [e.kind, e.actor, e.payload])).toEqual([
      [
        'created',
        'lark:on_alice',
        {
          title: 'Write the parser',
          assignee: 'implementer',
          assigneeKind: 'role',
          reviewer: null,
          reviewerKind: null,
          workspace: 'web',
          parents: [],
          createdFromTask: null,
          board: 'default',
        },
      ],
    ]);
  });

  it('links a new task to its parents in the same transaction', () => {
    const a = create({ title: 'a' });
    const b = create({ title: 'b' });
    const c = create({ title: 'c', parents: [a.taskId, b.taskId, a.taskId] });
    expect(parentsOf(h.db, c.taskId).map((t) => t.title)).toEqual(['a', 'b']);
    expect(childrenOf(h.db, a.taskId).map((t) => t.title)).toEqual(['c']);
  });

  it('refuses an unknown parent, and writes nothing', () => {
    const a = create({ title: 'a' });
    const r = createTask(
      h.db,
      { title: 'b', parents: [a.taskId, 'k_missing'], createdBy: 'lark:on_alice', createdVia: VIA },
      NOW,
    );
    expect(r).toEqual({ ok: false, code: 'not_found', message: 'no task k_missing to be a parent' });
    expect(taskCount()).toBe(1);
  });

  it('refuses a creating run that does not exist', () => {
    const r = createTask(
      h.db,
      { title: 'b', createdBy: 'run:r_missing', createdVia: { kind: 'run', runId: 'r_missing' } },
      NOW,
    );
    expect(r).toMatchObject({ ok: false, code: 'not_found' });
    expect(taskCount()).toBe(0);
  });

  it('returns the existing task for a repeated idempotency key, and changes nothing', () => {
    // Lark redelivers; an agent re-runs a command whose output it did not see.
    const first = create({ idempotencyKey: 'lark:om_1' });
    const again = createTask(
      h.db,
      { title: 'something else', idempotencyKey: 'lark:om_1', createdBy: 'lark:on_bob', createdVia: VIA },
      NOW + 1,
    );
    expect(again).toEqual({ ok: true, task: first, existing: true });
    expect(taskCount()).toBe(1);
    expect(eventsOf(h.db, first.taskId)).toHaveLength(1);
  });

  it('masks free text and event payloads on write, but not names', () => {
    addSecrets(['sk-test-123456']);
    const task = create({
      title: 'rotate sk-test-123456',
      body: 'the old key is sk-test-123456',
      contract: { verification: 'curl -H sk-test-123456' },
      assignee: { kind: 'role', name: 'sk-test-123456' },
      workspace: 'sk-test-123456',
    });
    const stored = getTask(h.db, task.taskId);
    expect(stored).toMatchObject({
      title: `rotate ${MASK}`,
      body: `the old key is ${MASK}`,
      contract: { verification: `curl -H ${MASK}` },
      assignee: { kind: 'role', name: 'sk-test-123456' },
      workspace: 'sk-test-123456',
    });
    expect(eventsOf(h.db, task.taskId)[0]?.payload).toMatchObject({
      title: `rotate ${MASK}`,
      assignee: 'sk-test-123456',
      workspace: 'sk-test-123456',
    });
  });

  it('masks every contract value, whatever its field is called', () => {
    // `workspace` is a key the global masker leaves alone; in a contract it is free text.
    addSecrets(['sk-test-123456']);
    const task = create({ contract: { workspace: 'use sk-test-123456', outcome: 'sk-test-123456' } as never });
    expect(getTask(h.db, task.taskId)?.contract).toEqual({ workspace: `use ${MASK}`, outcome: MASK });
  });
});

describe('addComment', () => {
  it('adds comments in order, masked, each with an event', () => {
    addSecrets(['sk-test-123456']);
    const task = create();
    addComment(h.db, task.taskId, 'lark:on_alice', 'first', NOW, true);
    const r = addComment(h.db, task.taskId, 'run:r_1', 'used sk-test-123456', NOW + 1, true);
    expect(r).toMatchObject({ ok: true, comment: { author: 'run:r_1', body: `used ${MASK}` } });
    expect(commentsOf(h.db, task.taskId).map((c) => [c.author, c.body])).toEqual([
      ['lark:on_alice', 'first'],
      ['run:r_1', `used ${MASK}`],
    ]);
    expect(eventsOf(h.db, task.taskId).map((e) => [e.kind, e.payload])).toEqual([
      ['created', expect.anything()],
      ['commented', { body: 'first' }],
      ['commented', { body: `used ${MASK}` }],
    ]);
  });

  it('refuses a comment on an unknown task', () => {
    expect(addComment(h.db, 'k_missing', 'lark:on_alice', 'hi', NOW, true)).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('taskView', () => {
  it('shows a task with no parents as ready, and its child as todo', () => {
    const parent = create({ title: 'parent' });
    const child = create({ title: 'child', parents: [parent.taskId] });
    expect(taskView(h.db, parent.taskId)).toMatchObject({ status: 'ready', parents: [], runs: [], comments: [] });
    expect(taskView(h.db, child.taskId)).toMatchObject({ status: 'todo', parents: [{ title: 'parent' }] });
    expect(taskView(h.db, parent.taskId)?.children.map((t) => t.title)).toEqual(['child']);
    expect(taskView(h.db, 'k_missing')).toBeUndefined();
  });
});
