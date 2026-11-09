import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { complete, type BoardChange } from '../src/db/kanban.js';
import { getBoard } from '../src/db/kanban-read.js';
import { KanbanService, type CreateRequest } from '../src/kanban/service.js';
import type { ChatAt } from '../src/kanban/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { ALICE, NOW, VIA, WORKSPACES, claimed } from './helpers/kanban.js';

/**
 * Boards through the service (spec §16): the names it accepts, the limits a
 * board may set, the board each chat is on, and the board a task is created on.
 */

let h: TestDb;
let s: KanbanService;
const CHAT: ChatAt = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat' };

beforeEach(() => {
  h = testDb();
  s = new KanbanService({
    db: h.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock: new ManualClock(NOW),
    maxRunning: 4,
  });
});

afterEach(() => h.close());

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

function request(extra: Partial<CreateRequest> = {}): CreateRequest {
  return { title: 'a task', assignee: 'implementer', createdBy: ALICE, createdVia: VIA, ...extra };
}

describe('KanbanService: creating a board', () => {
  it('takes a name in the grammar of roles and workspaces, and refuses any other', () => {
    expect(ok(s.createBoard('web-app', ALICE)).board.name).toBe('web-app');
    for (const name of ['Web', 'a/b', '../x', 'x-', 'lark:x', '', '1st', 'a'.repeat(41)]) {
      expect(s.createBoard(name, ALICE)).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(s.createBoard(3 as unknown as string, ALICE)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('refuses none and all, which the board commands read as clear and every board', () => {
    for (const name of ['none', 'all']) {
      const r = s.createBoard(name, ALICE);
      expect(r).toMatchObject({ ok: false, code: 'invalid' });
      expect(r.ok ? '' : r.message).toBe(`board name "${name}" is reserved: none clears a setting, and all lists every board`);
    }
  });

  it('shows a hidden character in a refused name, so the refusal does not look like a valid name', () => {
    const r = s.createBoard('web\u200bapp', ALICE);
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
    expect(r.ok ? '' : r.message).toContain('board name "web\\u200bapp" must be');
    const used = s.useBoard(CHAT, 'web\u00adapp', ALICE);
    expect(used).toMatchObject({ ok: false, code: 'unknown_board' });
    expect(used.ok ? '' : used.message).toBe('there is no board web\\u00adapp');
  });
});

describe('KanbanService: a board’s own settings', () => {
  it("takes a max_running from 1 to the gateway's, and none", () => {
    ok(s.createBoard('web-app', ALICE));
    expect(ok(s.setBoard('web-app', { maxRunning: 4 }, ALICE)).board.maxRunning).toBe(4);
    for (const n of [0, 5, 1.5, -1]) {
      const r = s.setBoard('web-app', { maxRunning: n }, ALICE);
      expect(r).toMatchObject({ ok: false, code: 'invalid' });
      expect(r.ok ? '' : r.message).toContain("the gateway's kanban.max_running, 4");
    }
    expect(ok(s.setBoard('web-app', { maxRunning: null }, ALICE)).board.maxRunning).toBeNull();
  });

  it('refuses a change that changes nothing, leaving the board unstamped', () => {
    ok(s.createBoard('web-app', ALICE));
    // An explicit undefined is what a caller outside TypeScript can send.
    for (const change of [{}, { maxRunning: undefined }, { workspace: undefined }] as BoardChange[]) {
      const r = s.setBoard('web-app', change, ALICE);
      expect(r).toMatchObject({ ok: false, code: 'invalid' });
      expect(r.ok ? '' : r.message).toBe("a board's change sets its max_running, its workspace, or both");
    }
    expect(getBoard(h.db, 'web-app')).toMatchObject({ updatedBy: null, updatedAt: null });
  });

  it('takes a configured workspace, and none', () => {
    ok(s.createBoard('web-app', ALICE));
    expect(ok(s.setBoard('web-app', { workspace: 'web' }, ALICE)).board.workspace).toBe('web');
    expect(s.setBoard('web-app', { workspace: 'elsewhere' }, ALICE)).toMatchObject({ ok: false, code: 'unknown_workspace' });
    expect(s.setBoard('web-app', { workspace: '/tmp' }, ALICE)).toMatchObject({ ok: false, code: 'unknown_workspace' });
    expect(ok(s.setBoard('web-app', { workspace: null }, ALICE)).board.workspace).toBeNull();
  });
});

describe('KanbanService: the board a chat is on', () => {
  it('is default until the chat uses another, and refuses one archived', () => {
    expect(s.chatBoard(CHAT).name).toBe('default');
    ok(s.createBoard('web-app', ALICE));
    ok(s.useBoard(CHAT, 'web-app', ALICE));
    expect(s.chatBoard(CHAT).name).toBe('web-app');
    ok(s.createBoard('old', ALICE));
    ok(s.archiveBoard('old', ALICE));
    expect(s.useBoard(CHAT, 'old', ALICE)).toMatchObject({ ok: false, code: 'board_archived' });
    expect(s.useBoard(CHAT, 'Web', ALICE)).toMatchObject({ ok: false, code: 'unknown_board' });
    expect(s.chatBoard(CHAT).name).toBe('web-app');
  });
});

describe('KanbanService: tasks on a board', () => {
  it('creates a task on the board asked for, and lists only that board', () => {
    ok(s.createBoard('web-app', ALICE));
    const web = ok(s.create(request({ board: 'web-app' }))).task;
    const plain = ok(s.create(request())).task;
    expect([web.board, plain.board]).toEqual(['web-app', 'default']);
    expect(s.list('web-app').map((e) => e.task.taskId)).toEqual([web.taskId]);
    expect(s.list().map((e) => e.task.taskId)).toEqual([web.taskId, plain.taskId]);
    expect(s.create(request({ board: 'nowhere' }))).toMatchObject({ ok: false, code: 'unknown_board' });
    expect(s.create(request({ board: 7 as unknown as string }))).toMatchObject({ ok: false, code: 'invalid' });
  });

  it("puts a done task's follow-up on its board, and refuses another", () => {
    ok(s.createBoard('web-app', ALICE));
    const done = ok(s.create(request({ board: 'web-app' }))).task;
    const run = claimed(h.db, done.taskId);
    ok(complete(h.db, done.taskId, { kind: 'run', runId: run.runId }, { summary: 'ok' }, NOW));
    expect(ok(s.followUp(done.taskId, request({ title: 'more' }))).task.board).toBe('web-app');
    expect(s.followUp(done.taskId, request({ title: 'more', board: 'default' }))).toMatchObject({ ok: false, code: 'other_board' });
  });

  it('lists the boards with their tasks by phase', () => {
    ok(s.createBoard('web-app', ALICE));
    ok(s.create(request({ board: 'web-app' })));
    expect(s.boards().map((b) => [b.board.name, b.counts.open])).toEqual([
      ['default', 0],
      ['web-app', 1],
    ]);
  });
});
