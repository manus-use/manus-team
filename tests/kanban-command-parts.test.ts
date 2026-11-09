import { describe, expect, it } from 'vitest';
import { boardSetting, tooBig } from '../src/kanban/chat-parse.js';
import { listed } from '../src/kanban/chat-render.js';
import type { BoardEntry } from '../src/db/kanban-read.js';
import type { DisplayStatus } from '../src/kanban/status.js';
import { WORKER_LIMITS } from '../src/kanban/worker.js';

/**
 * The parts of a `/kanban` command that chat and the terminal share: a board's
 * setting, a new task's limits, and which tasks a list shows, in what order.
 */

describe('boardSetting', () => {
  it('reads max_running as a whole number from 1, or none, and workspace as a name, or none', () => {
    expect(boardSetting('max_running', '2')).toEqual({ maxRunning: 2 });
    expect(boardSetting('MAX_RUNNING', 'None')).toEqual({ maxRunning: null });
    expect(boardSetting('workspace', 'web')).toEqual({ workspace: 'web' });
    expect(boardSetting('Workspace', 'NONE')).toEqual({ workspace: null });
    for (const [setting, value] of [
      ['max_running', '0'],
      ['max_running', '01'],
      ['max_running', 'two'],
      ['max_running', '99999999999999999999'],
      ['colour', 'blue'],
    ] as const) {
      expect(boardSetting(setting, value)).toBeUndefined();
    }
  });
});

describe('tooBig', () => {
  it('says which part of a new task is over its limit, the field named as the caller says', () => {
    const fits = { title: 't', body: 'b', contract: { outcome: 'o' } };
    expect(tooBig(fits)).toBeUndefined();
    expect(tooBig({ ...fits, title: 'x'.repeat(WORKER_LIMITS.title + 1) })).toBe(
      `A title is at most ${WORKER_LIMITS.title} bytes; put the rest in the body.`,
    );
    expect(tooBig({ ...fits, body: 'x'.repeat(WORKER_LIMITS.body + 1) })).toBe(`A body is at most ${WORKER_LIMITS.body} bytes.`);
    const contract = { stop_when: 'x'.repeat(WORKER_LIMITS.contractField + 1) };
    expect(tooBig({ ...fits, contract })).toBe(`The contract's stop_when is at most ${WORKER_LIMITS.contractField} bytes.`);
    expect(tooBig({ ...fits, contract }, (f) => `<${f}>`)).toBe(
      `The contract's <stop_when> is at most ${WORKER_LIMITS.contractField} bytes.`,
    );
  });
});

describe('listed', () => {
  const entry = (taskId: string, status: DisplayStatus) => ({ task: { taskId }, status }) as unknown as BoardEntry;
  const board = [entry('k_1', 'done'), entry('k_2', 'ready'), entry('k_3', 'running'), entry('k_4', 'blocked'), entry('k_5', 'ready')];
  const ids = (entries: BoardEntry[]) => entries.map((e) => e.task.taskId);

  it('shows the active tasks, grouped by status, running first and blocked last', () => {
    expect(ids(listed(board, undefined))).toEqual(['k_3', 'k_2', 'k_5', 'k_4']);
  });

  it("with a status, those of it; with all, every task, in the board's order", () => {
    expect(ids(listed(board, 'ready'))).toEqual(['k_2', 'k_5']);
    expect(ids(listed(board, 'all'))).toEqual(['k_1', 'k_2', 'k_3', 'k_4', 'k_5']);
    expect(listed(board, 'archived')).toEqual([]);
  });
});
