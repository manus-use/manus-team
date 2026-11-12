import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advanceSubscription, createTask, threadSubscription } from '../src/db/kanban.js';
import { eventsOf, subscriptionsOf } from '../src/db/kanban-read.js';
import { migrate, openDb } from '../src/db/open.js';
import { KanbanService } from '../src/kanban/service.js';
import type { CreatedVia } from '../src/kanban/types.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { ALICE, NOW, VIA, WORKSPACES, claimed, newTask } from './helpers/kanban.js';

/**
 * The root of a task's thread (spec §19.4, migration 008): written at creation
 * for a task created in a thread, copied to a follow-up, and none at chat scope
 * or for a subscription from before the migration.
 */

/** The chat `VIA` creates its tasks from, as `KanbanChat` names it. */
const CHAT = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat' };
const THREAD: CreatedVia = { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' };

let h: TestDb;

beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

describe('migration 008', () => {
  it('gives every subscription already on the board no root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-roots-schema-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) {
        if (/^00[1-7]_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      }
      const d = openDb(join(dir, 'team.db'));
      try {
        expect(migrate(d, only)).toBe(7);
        d.prepare(
          `INSERT INTO kanban_tasks (task_id, title, contract, phase, created_by, created_via, created_at)
           VALUES ('k_old', 'from before', jsonb('{}'), 'open', 'lark:on_alice', jsonb('{}'), ?)`,
        ).run(NOW);
        d.prepare(
          `INSERT INTO kanban_subscriptions (task_id, channel, account_id, conversation_id, thread_id, created_at)
           VALUES ('k_old', 'lark', 'cli_app', 'oc_team', 'omt_topic', ?)`,
        ).run(NOW);
        expect(migrate(d, SCHEMA_DIR)).toBe(8);
        expect(subscriptionsOf(d, 'k_old')).toMatchObject([{ threadId: 'omt_topic', rootMessageId: null }]);
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a subscription's root", () => {
  it('is written at creation for a task created in a thread, and never at chat scope', () => {
    const inThread = newTask(h.db, { createdVia: THREAD });
    expect(subscriptionsOf(h.db, inThread.taskId).map((s) => [s.threadId, s.rootMessageId])).toEqual([['omt_topic', 'om_root']]);
    // A root given at chat scope is not one: the chat's root comes only from the threaded reply.
    const atChat = newTask(h.db, { createdVia: { ...THREAD, threadId: '' } });
    expect(subscriptionsOf(h.db, atChat.taskId).map((s) => [s.threadId, s.rootMessageId])).toEqual([['', null]]);
    const without = newTask(h.db, { createdVia: { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' } });
    expect(subscriptionsOf(h.db, without.taskId)[0]?.rootMessageId).toBeNull();
  });

  it("is copied to a follow-up, with the creating task's thread", () => {
    const parent = newTask(h.db, { createdVia: THREAD });
    const run = claimed(h.db, parent.taskId);
    const child = createTask(h.db, { title: 'a follow-up', createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } }, NOW);
    if (!child.ok) throw new Error(child.message);
    expect(subscriptionsOf(h.db, child.task.taskId).map((s) => [s.conversationId, s.threadId, s.rootMessageId, s.cursor])).toEqual([
      ['oc_team', 'omt_topic', 'om_root', 0],
    ]);
  });

  it('is refused by the service unless it is text', () => {
    const service = new KanbanService({ db: h.db, roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])), workspaces: WORKSPACES });
    const via = { ...THREAD, rootId: 5 } as unknown as CreatedVia;
    expect(service.create({ title: 't', assignee: 'implementer', createdBy: ALICE, createdVia: via })).toMatchObject({ ok: false, code: 'invalid' });
    expect(service.create({ title: 't', assignee: 'implementer', createdBy: ALICE, createdVia: THREAD }).ok).toBe(true);
  });
});

describe('threadSubscription', () => {
  it('moves a chat-scope subscription into its thread, once, with its root and its cursor, writing no event', () => {
    const task = newTask(h.db, { createdVia: VIA });
    const [before] = subscriptionsOf(h.db, task.taskId);
    const created = eventsOf(h.db, task.taskId).at(-1)?.id ?? 0;
    expect(advanceSubscription(h.db, before?.id ?? 0, created).ok).toBe(true);
    const events = eventsOf(h.db, task.taskId).length;
    expect(threadSubscription(h.db, task.taskId, CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: true });
    expect(subscriptionsOf(h.db, task.taskId)).toEqual([
      { ...before, threadId: 'omt_new', rootMessageId: 'om_cmd', cursor: created },
    ]);
    expect(eventsOf(h.db, task.taskId)).toHaveLength(events);
    // A second call, for that thread or another, changes nothing.
    expect(threadSubscription(h.db, task.taskId, CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: false });
    expect(threadSubscription(h.db, task.taskId, CHAT, 'omt_other', 'om_other')).toEqual({ ok: true, moved: false });
    expect(subscriptionsOf(h.db, task.taskId).map((s) => [s.threadId, s.rootMessageId])).toEqual([['omt_new', 'om_cmd']]);
  });

  it("moves only that task's subscription, at that chat, for this bot, while it is at chat scope", () => {
    const task = newTask(h.db, { createdVia: VIA });
    const neighbour = newTask(h.db, { createdVia: VIA });
    const inThread = newTask(h.db, { createdVia: { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat', threadId: 'omt_topic' } });
    expect(threadSubscription(h.db, task.taskId, { ...CHAT, appId: 'cli_other' }, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: false });
    expect(threadSubscription(h.db, task.taskId, { ...CHAT, conversationId: 'oc_other' }, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: false });
    expect(threadSubscription(h.db, inThread.taskId, CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: false });
    expect(threadSubscription(h.db, task.taskId, CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: true });
    expect(subscriptionsOf(h.db, neighbour.taskId).map((s) => [s.threadId, s.rootMessageId])).toEqual([['', null]]);
    expect(subscriptionsOf(h.db, inThread.taskId).map((s) => [s.threadId, s.rootMessageId])).toEqual([['omt_topic', null]]);
  });

  it('is refused through the service for an empty thread or root, or anything but text', () => {
    const service = new KanbanService({ db: h.db, roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])), workspaces: WORKSPACES });
    const task = newTask(h.db, { createdVia: VIA });
    expect(service.threadSubscription(task.taskId, CHAT, '', 'om_cmd')).toMatchObject({ ok: false, code: 'invalid' });
    expect(service.threadSubscription(task.taskId, CHAT, 'omt_new', '')).toMatchObject({ ok: false, code: 'invalid' });
    expect(service.threadSubscription(task.taskId, { ...CHAT, appId: 7 } as unknown as typeof CHAT, 'omt_new', 'om_cmd')).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(service.threadSubscription(task.taskId, CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: true });
  });
});
