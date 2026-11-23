import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTask } from '../src/db/kanban.js';
import { subscriptionsOf } from '../src/db/kanban-read.js';
import { checkTask } from '../src/kanban/task-checks.js';
import type { CreatedVia } from '../src/kanban/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed, newTask } from './helpers/kanban.js';

/**
 * A subscription's chat type (wake spec §2.1): written from the chat's command,
 * copied to a run's follow-ups, and unknown for a terminal's `--chat`, each
 * subscription's wake cursor at 0.
 */

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

const CHAT = { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat', threadId: '' } as const;
const DM: CreatedVia = { ...CHAT, conversationId: 'oc_dm', chatType: 'p2p' };
const GROUP: CreatedVia = { ...CHAT, chatType: 'group' };

describe("a subscription's chat type", () => {
  it("is the command's chat's, a direct message's or a group's, and unknown when the command did not say", () => {
    expect(subscriptionsOf(h.db, newTask(h.db, { createdVia: DM }).taskId)).toEqual([expect.objectContaining({ conversationId: 'oc_dm', chatType: 'p2p', wakeCursor: 0 })]);
    expect(subscriptionsOf(h.db, newTask(h.db, { createdVia: GROUP }).taskId)).toEqual([expect.objectContaining({ chatType: 'group', wakeCursor: 0 })]);
    expect(subscriptionsOf(h.db, newTask(h.db).taskId)).toEqual([expect.objectContaining({ chatType: null, wakeCursor: 0 })]);
  });

  it("is copied to a run's follow-up, with each subscription of its creating task", () => {
    const parent = newTask(h.db, { createdVia: DM });
    const run = claimed(h.db, parent.taskId);
    const r = createTask(h.db, { title: 'a follow-up', createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } }, NOW);
    if (!r.ok) throw new Error(r.message);
    expect(subscriptionsOf(h.db, r.task.taskId)).toEqual([expect.objectContaining({ conversationId: 'oc_dm', chatType: 'p2p', wakeCursor: 0 })]);
  });

  it("is unknown for a chat the terminal names, which cannot ask Lark its kind", () => {
    const task = newTask(h.db, { createdVia: { kind: 'operator' }, follow: { appId: 'cli_app', chatId: 'oc_named', threadId: '', rootId: null } });
    expect(subscriptionsOf(h.db, task.taskId)).toEqual([expect.objectContaining({ conversationId: 'oc_named', chatType: null })]);
  });

  it("is checked as a created_via's field: p2p or group, when given", () => {
    const facts = { roles: new Map(), workspaces: new Set(['default']), supervisedRoles: false };
    const check = (createdVia: unknown) => checkTask({ title: 'x', createdBy: ALICE, createdVia } as never, facts);
    expect(check(GROUP)).toMatchObject({ ok: true });
    expect(check(DM)).toMatchObject({ ok: true });
    expect(check({ ...VIA, chatType: 'topic' })).toEqual({ ok: false, code: 'invalid', message: 'created_via is a chat, with text fields, a run id, or the operator' });
  });
});
