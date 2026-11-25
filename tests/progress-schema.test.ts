import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun, decideRunForTest } from './helpers/progress.js';
import {
  openProgressCard,
  progressCardDrawn,
  progressCardFinal,
  progressCardLetGo,
  progressCardRefused,
  progressCardSent,
} from '../src/db/kanban.js';
import { testDb, type TestDb } from './helpers/db.js';
import { NOW, claimed, newTask } from './helpers/kanban.js';

/**
 * Migration 014 (progress cards spec §4): one row a board run's progress card,
 * written before its first send with its "run N of M" read by the insert, then
 * its message, what its last landed draw showed, Lark's refusals in a row, and
 * its state, moving from `open` once.
 */

let h: TestDb;

beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

interface Row {
  run_id: string;
  task_id: string;
  app_id: string;
  channel: string;
  message_id: string | null;
  read_seq: number;
  drawn_at: number | null;
  failures: number;
  state: string;
  try_number: number;
  try_limit: number;
  opened_at: number;
}

function row(runId: string): Row | undefined {
  return h.db.prepare<[string], Row>('SELECT * FROM kanban_progress_cards WHERE run_id = ?').get(runId);
}

function open(runId: string, failureLimit = 2): boolean {
  const r = openProgressCard(h.db, { runId, appId: 'cli_app', channel: 'lark', failureLimit }, NOW + 30_000);
  if (!r.ok) throw new Error(r.message);
  return r.opened;
}

/** Each in a workspace of its own: one open agent run a workspace. */
const PLACES = ['default', 'web', 'api', 'docs'];
let made = 0;

function agentRun(t: Parameters<typeof newTask>[1] = {}): { taskId: string; runId: string } {
  const task = newTask(h.db, { workspace: PLACES[made++ % PLACES.length] ?? 'default', ...t });
  const run = claimed(h.db, task.taskId);
  return { taskId: task.taskId, runId: run.runId };
}

describe('migration 014', () => {
  it('is migrated to version 14, its table STRICT, with its columns and its partial index', () => {
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(14);
    expect(h.db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 14 });
    expect(h.db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'kanban_progress_cards'").get()).toEqual({ strict: 1 });
    const cols = h.db
      .prepare<[], { name: string; notnull: number; dflt_value: string | null; pk: number }>("SELECT name, \"notnull\", dflt_value, pk FROM pragma_table_info('kanban_progress_cards')")
      .all();
    expect(cols.map((c) => c.name)).toEqual([
      'run_id',
      'task_id',
      'app_id',
      'channel',
      'message_id',
      'read_seq',
      'drawn_at',
      'failures',
      'state',
      'try_number',
      'try_limit',
      'opened_at',
    ]);
    expect(cols.find((c) => c.name === 'run_id')?.pk).toBe(1);
    expect(cols.find((c) => c.name === 'state')).toMatchObject({ notnull: 1, dflt_value: "'open'" });
    const indexes = h.db
      .prepare<[], { name: string; partial: number }>("SELECT name, partial FROM pragma_index_list('kanban_progress_cards') WHERE origin = 'c'")
      .all();
    expect(indexes).toEqual([{ name: 'idx_kanban_progress_cards_open', partial: 1 }]);
  });

  it('refuses a state it does not know', () => {
    const { runId } = agentRun();
    open(runId);
    expect(() => h.db.prepare("UPDATE kanban_progress_cards SET state = 'done' WHERE run_id = ?").run(runId)).toThrow(/CHECK constraint failed/);
  });
});

describe('openProgressCard', () => {
  it('writes an open undecided run its row, with run 1 of the gateway limit, once', () => {
    const { taskId, runId } = agentRun();
    expect(open(runId)).toBe(true);
    expect(row(runId)).toEqual({
      run_id: runId,
      task_id: taskId,
      app_id: 'cli_app',
      channel: 'lark',
      message_id: null,
      read_seq: 0,
      drawn_at: null,
      failures: 0,
      state: 'open',
      try_number: 1,
      try_limit: 2,
      opened_at: NOW + 30_000,
    });
    expect(open(runId)).toBe(false);
  });

  it("reads the task's own failure limit and its counted failures", () => {
    const { taskId, runId } = agentRun({ failureLimit: 3 });
    h.db.prepare('UPDATE kanban_tasks SET consecutive_failures = 1 WHERE task_id = ?').run(taskId);
    open(runId);
    expect(row(runId)).toMatchObject({ try_number: 2, try_limit: 3 });
  });

  it('gives a decided run, and a closed one, no row', () => {
    const a = agentRun();
    decideRunForTest(h.db, a.runId, 'completed');
    expect(open(a.runId)).toBe(false);
    const b = agentRun();
    decideRunForTest(h.db, b.runId, 'completed');
    closeRun(h.db, b.runId);
    expect(open(b.runId)).toBe(false);
    expect(row(a.runId)).toBeUndefined();
    expect(row(b.runId)).toBeUndefined();
  });
});

describe('the writers', () => {
  it('records the message once, with what it showed and when', () => {
    const { runId } = agentRun();
    open(runId);
    expect(progressCardSent(h.db, runId, 'om_1', 7, NOW + 31_000)).toEqual({ ok: true, changed: true });
    expect(progressCardSent(h.db, runId, 'om_2', 9, NOW + 32_000)).toEqual({ ok: true, changed: false });
    expect(row(runId)).toMatchObject({ message_id: 'om_1', read_seq: 7, drawn_at: NOW + 31_000 });
  });

  it('counts refusals in a row, and a landed draw sets them back to 0', () => {
    const { runId } = agentRun();
    open(runId);
    expect(progressCardRefused(h.db, runId)).toEqual({ ok: true, failures: 1 });
    expect(progressCardRefused(h.db, runId)).toEqual({ ok: true, failures: 2 });
    // No message yet: an update has nothing to draw on.
    expect(progressCardDrawn(h.db, runId, 3, NOW)).toEqual({ ok: true, changed: false });
    progressCardSent(h.db, runId, 'om_1', 1, NOW + 1);
    expect(row(runId)?.failures).toBe(0);
    progressCardRefused(h.db, runId);
    expect(progressCardDrawn(h.db, runId, 5, NOW + 2)).toEqual({ ok: true, changed: true });
    expect(row(runId)).toMatchObject({ failures: 0, read_seq: 5, drawn_at: NOW + 2 });
  });

  it('moves the state from open once: final, or let go of, and never back', () => {
    const a = agentRun();
    open(a.runId);
    progressCardSent(h.db, a.runId, 'om_a', 1, NOW);
    expect(progressCardFinal(h.db, a.runId, 4, NOW + 5)).toEqual({ ok: true, changed: true });
    expect(progressCardLetGo(h.db, a.runId)).toEqual({ ok: true, changed: false });
    expect(progressCardDrawn(h.db, a.runId, 9, NOW + 9)).toEqual({ ok: true, changed: false });
    expect(progressCardRefused(h.db, a.runId)).toEqual({ ok: true, failures: 0 });
    expect(row(a.runId)).toMatchObject({ state: 'final', read_seq: 4, drawn_at: NOW + 5 });

    const b = agentRun();
    open(b.runId);
    expect(progressCardLetGo(h.db, b.runId)).toEqual({ ok: true, changed: true });
    expect(progressCardFinal(h.db, b.runId, 1, NOW)).toEqual({ ok: true, changed: false });
    expect(progressCardSent(h.db, b.runId, 'om_b', 1, NOW)).toEqual({ ok: true, changed: false });
    expect(row(b.runId)?.state).toBe('let_go');
  });
});
