import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventsOf, getTask, subscriptionsOf } from '../src/db/kanban-read.js';
import { KanbanService } from '../src/kanban/service.js';
import type { CreatedVia } from '../src/kanban/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { WORKSPACES } from './helpers/kanban.js';

/**
 * A task an operator creates at a terminal (spec §3.1, §2.6): created via the
 * operator, by `operator:<login>`, and followed by no chat.
 */

const ME = 'operator:alice';
let t: TestDb;
let service: KanbanService;

beforeEach(() => {
  t = testDb();
  service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
  });
});

afterEach(() => t.close());

describe('a task created by the operator', () => {
  it('records the operator as its creator, and no chat follows it', () => {
    const r = service.create({ title: 'From a shell', assignee: 'implementer', createdBy: ME, createdVia: { kind: 'operator' } });
    if (!r.ok) throw new Error(r.message);
    expect(getTask(t.db, r.task.taskId)).toMatchObject({ createdBy: ME, createdVia: { kind: 'operator' }, createdFromTask: null });
    expect(subscriptionsOf(t.db, r.task.taskId)).toEqual([]);
    expect(eventsOf(t.db, r.task.taskId).map((e) => [e.kind, e.actor])).toEqual([['created', ME]]);
  });

  it("refuses an operator's created_via with anything more in it, and a chat's idempotency key", () => {
    const via = { kind: 'operator', conversationId: 'oc_chat' } as unknown as CreatedVia;
    expect(service.create({ title: 'x', createdBy: ME, createdVia: via })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'created_via is a chat, with text fields, a run id, or the operator',
    });
    expect(service.create({ title: 'x', createdBy: ME, createdVia: { kind: 'operator' }, idempotencyKey: 'lark:om_1' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });
});
