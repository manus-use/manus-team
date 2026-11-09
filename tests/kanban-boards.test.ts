import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archive, archiveBoard, createBoard, setBoard, useBoard } from '../src/db/kanban.js';
import { boardSummaries, boardsOf, chatBoardOf, getBoard } from '../src/db/kanban-read.js';
import type { ChatAt } from '../src/kanban/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, newTask } from './helpers/kanban.js';

/**
 * Boards in the board's writer (spec §16): created, set, archived, and the board
 * each chat is on. Whether a workspace is configured, and why a name is not
 * well formed, are the service's; what the rows allow is here, with a cheap
 * name check behind the service's.
 */

let h: TestDb;

beforeEach(() => {
  h = testDb();
});

afterEach(() => h.close());

const CHAT: ChatAt = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat' };

function made(name: string): void {
  const r = createBoard(h.db, name, ALICE, NOW);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
}

describe('createBoard', () => {
  it('creates a board with no limit or workspace of its own, by who asked', () => {
    expect(createBoard(h.db, 'web-app', ALICE, NOW)).toEqual({
      ok: true,
      board: {
        name: 'web-app',
        maxRunning: null,
        workspace: null,
        createdBy: ALICE,
        createdAt: NOW,
        updatedBy: null,
        updatedAt: null,
        archivedAt: null,
      },
    });
    expect(getBoard(h.db, 'web-app')?.name).toBe('web-app');
  });

  it('refuses a name a board already has, default and archived ones too', () => {
    made('web-app');
    expect(archiveBoard(h.db, 'web-app', ALICE, NOW).ok).toBe(true);
    for (const name of ['web-app', 'default']) {
      expect(createBoard(h.db, name, ALICE, NOW)).toMatchObject({ ok: false, code: 'invalid' });
    }
  });
});

describe('createBoard: the name, checked again', () => {
  it('refuses a name outside the grammar, or reserved, though the service checks it first', () => {
    for (const name of ['Web', 'a/b', '', 'web\u200bapp', 'none', 'all']) {
      expect(createBoard(h.db, name, ALICE, NOW)).toMatchObject({ ok: false, code: 'invalid' });
      expect(getBoard(h.db, name)).toBeUndefined();
    }
  });
});

describe('setBoard', () => {
  it('sets and clears its max_running and workspace, one at a time, recording who', () => {
    made('web-app');
    expect(setBoard(h.db, 'web-app', { maxRunning: 2 }, 'lark:on_bob', NOW + 1)).toMatchObject({
      ok: true,
      board: { maxRunning: 2, workspace: null, updatedBy: 'lark:on_bob', updatedAt: NOW + 1 },
    });
    expect(setBoard(h.db, 'web-app', { workspace: 'web' }, ALICE, NOW + 2)).toMatchObject({
      ok: true,
      board: { maxRunning: 2, workspace: 'web', updatedBy: ALICE },
    });
    expect(setBoard(h.db, 'web-app', { maxRunning: null }, ALICE, NOW + 3)).toMatchObject({
      ok: true,
      board: { maxRunning: null, workspace: 'web' },
    });
  });

  it('sets default too, and refuses a board that does not exist or is archived', () => {
    expect(setBoard(h.db, 'default', { maxRunning: 1 }, ALICE, NOW)).toMatchObject({ ok: true, board: { maxRunning: 1 } });
    expect(setBoard(h.db, 'nowhere', { maxRunning: 1 }, ALICE, NOW)).toMatchObject({ ok: false, code: 'unknown_board' });
    made('old');
    expect(archiveBoard(h.db, 'old', ALICE, NOW).ok).toBe(true);
    expect(setBoard(h.db, 'old', { maxRunning: 1 }, ALICE, NOW)).toMatchObject({ ok: false, code: 'board_archived' });
  });
});

describe('archiveBoard', () => {
  it('never archives default', () => {
    expect(archiveBoard(h.db, 'default', ALICE, NOW)).toMatchObject({ ok: false, code: 'invalid' });
    expect(getBoard(h.db, 'default')?.archivedAt).toBeNull();
  });

  it('refuses while a task on the board is not done or archived, and archives it once none is', () => {
    made('web-app');
    const task = newTask(h.db, { board: 'web-app' });
    const r = archiveBoard(h.db, 'web-app', ALICE, NOW);
    expect(r).toMatchObject({ ok: false, code: 'illegal_transition' });
    expect(r.ok ? '' : r.message).toContain('1 task');
    expect(archive(h.db, task.taskId, ALICE, NOW).ok).toBe(true);
    expect(archiveBoard(h.db, 'web-app', 'lark:on_bob', NOW + 5)).toMatchObject({
      ok: true,
      board: { archivedAt: NOW + 5, updatedBy: 'lark:on_bob' },
    });
    expect(archiveBoard(h.db, 'web-app', ALICE, NOW)).toMatchObject({ ok: false, code: 'board_archived' });
    expect(archiveBoard(h.db, 'nowhere', ALICE, NOW)).toMatchObject({ ok: false, code: 'unknown_board' });
  });
});

describe('the board a chat is on', () => {
  it('is none until a chat uses one, and is the conversation’s alone', () => {
    made('web-app');
    expect(chatBoardOf(h.db, CHAT)).toBeUndefined();
    expect(useBoard(h.db, CHAT, 'web-app', ALICE, NOW)).toMatchObject({ ok: true, board: { name: 'web-app' } });
    expect(chatBoardOf(h.db, CHAT)).toBe('web-app');
    expect(chatBoardOf(h.db, { ...CHAT, conversationId: 'oc_other' })).toBeUndefined();
    expect(chatBoardOf(h.db, { ...CHAT, appId: 'cli_other' })).toBeUndefined();
    expect(useBoard(h.db, CHAT, 'default', ALICE, NOW + 1).ok).toBe(true);
    expect(chatBoardOf(h.db, CHAT)).toBe('default');
  });

  it('refuses a board that does not exist or is archived, and leaves the chat where it was', () => {
    made('old');
    expect(archiveBoard(h.db, 'old', ALICE, NOW).ok).toBe(true);
    expect(useBoard(h.db, CHAT, 'nowhere', ALICE, NOW)).toMatchObject({ ok: false, code: 'unknown_board' });
    expect(useBoard(h.db, CHAT, 'old', ALICE, NOW)).toMatchObject({ ok: false, code: 'board_archived' });
    expect(chatBoardOf(h.db, CHAT)).toBeUndefined();
  });
});

describe('reading the boards', () => {
  it('lists archived boards only when asked, or when one is the board asked to include', () => {
    made('old');
    expect(archiveBoard(h.db, 'old', ALICE, NOW).ok).toBe(true);
    expect(boardSummaries(h.db).map((s) => s.board.name)).toEqual(['default']);
    expect(boardSummaries(h.db, { including: 'old' }).map((s) => s.board.name)).toEqual(['default', 'old']);
    expect(boardSummaries(h.db, { including: 'nowhere' }).map((s) => s.board.name)).toEqual(['default']);
  });

  it('lists default first, then by name, archived ones only when asked, each with its tasks by phase', () => {
    made('zeta');
    made('alpha');
    made('old');
    expect(archiveBoard(h.db, 'old', ALICE, NOW).ok).toBe(true);
    newTask(h.db);
    const gone = newTask(h.db);
    expect(archive(h.db, gone.taskId, ALICE, NOW).ok).toBe(true);
    newTask(h.db, { board: 'alpha' });

    expect(boardsOf(h.db).map((b) => b.name)).toEqual(['default', 'alpha', 'zeta']);
    expect(boardsOf(h.db, { archived: true }).map((b) => b.name)).toEqual(['default', 'alpha', 'old', 'zeta']);
    // A chat's own board is listed even archived, so the chat can see it is on one.
    expect(boardsOf(h.db, { including: 'old' }).map((b) => b.name)).toEqual(['default', 'alpha', 'old', 'zeta']);
    expect(boardsOf(h.db, { including: 'alpha' }).map((b) => b.name)).toEqual(['default', 'alpha', 'zeta']);
    const counts = Object.fromEntries(boardSummaries(h.db).map((s) => [s.board.name, s.counts]));
    expect(counts).toEqual({
      default: { open: 1, review: 0, blocked: 0, done: 0, archived: 1 },
      alpha: { open: 1, review: 0, blocked: 0, done: 0, archived: 0 },
      zeta: { open: 0, review: 0, blocked: 0, done: 0, archived: 0 },
    });
  });
});
