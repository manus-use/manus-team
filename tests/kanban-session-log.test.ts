import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent } from '../src/db/events.js';
import { createSession } from '../src/db/sessions.js';
import { LAST_OUTPUT_CHARS, hadSideEffects, lastTurnOf, toolCallsOf } from '../src/kanban/session-log.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import type { NewEvent } from '../src/types.js';
import { testDb, type TestDb } from './helpers/db.js';

let h: TestDb;
const NOW = 1_760_000_000_000;
const S = 's_run';

beforeEach(() => {
  clearSecrets();
  h = testDb();
  createSession(h.db, { id: S, agentId: 'implementer', workspaceId: 'default', ownerPrincipal: 'kanban' }, NOW);
});

afterEach(() => {
  clearSecrets();
  h.close();
});

function log(...events: NewEvent[]): void {
  for (const e of events) appendEvent(h.db, S, e, NOW);
}

const submitted = (turnId: string): NewEvent => ({ type: 'turn_submitted', actor: 'user', turnId, payload: { text: 'go' } });
const said = (turnId: string, text: string): NewEvent => ({
  type: 'agent_message_chunk',
  actor: 'agent',
  turnId,
  payload: { text },
});
const failed = (turnId: string, message: string): NewEvent => ({
  type: 'agent_error',
  actor: 'agent',
  turnId,
  payload: { message, retryable: false },
});
const tool = (turnId: string, toolCallId: string, title: string, status = 'pending'): NewEvent => ({
  type: 'tool_call',
  actor: 'agent',
  turnId,
  payload: { toolCallId, title, status, raw: {} },
});
const update = (turnId: string, toolCallId: string, status: string): NewEvent => ({
  type: 'tool_call_update',
  actor: 'agent',
  turnId,
  payload: { toolCallId, status, raw: {} },
});

describe('toolCallsOf', () => {
  it('lists every call in the session in order, with its latest status', () => {
    log(
      submitted('t_1'),
      tool('t_1', 'c1', 'read'),
      tool('t_1', 'c2', 'bash'),
      update('t_1', 'c2', 'failed'),
      update('t_1', 'c1', 'completed'),
      submitted('t_2'),
      tool('t_2', 'c3', 'edit', 'completed'),
    );
    expect(toolCallsOf(h.db, S)).toEqual([
      { toolCallId: 'c1', title: 'read', status: 'completed' },
      { toolCallId: 'c2', title: 'bash', status: 'failed' },
      { toolCallId: 'c3', title: 'edit', status: 'completed' },
    ]);
  });

  it('keeps a call whose update arrived before its tool_call, in arrival order', () => {
    log(
      submitted('t_1'),
      tool('t_1', 'c1', 'read', 'completed'),
      update('t_1', 'c2', 'in_progress'),
      tool('t_1', 'c3', 'grep', 'completed'),
    );
    // Dropped, a run whose only write arrived this way would look read-only.
    expect(toolCallsOf(h.db, S)).toEqual([
      { toolCallId: 'c1', title: 'read', status: 'completed' },
      { toolCallId: 'c2', title: 'tool', status: 'in_progress' },
      { toolCallId: 'c3', title: 'grep', status: 'completed' },
    ]);
    expect(hadSideEffects(toolCallsOf(h.db, S), ['read', 'grep'])).toBe(true);
  });

  it('lets a later tool_call for the same id fill in its title, but not clear what is known', () => {
    log(
      submitted('t_1'),
      update('t_1', 'c1', 'in_progress'),
      tool('t_1', 'c1', 'bash', ''),
      tool('t_1', 'c2', 'edit', 'completed'),
      { type: 'tool_call', actor: 'agent', turnId: 't_1', payload: { toolCallId: 'c2', title: '', raw: {} } },
    );
    expect(toolCallsOf(h.db, S)).toEqual([
      { toolCallId: 'c1', title: 'bash', status: 'in_progress' },
      { toolCallId: 'c2', title: 'edit', status: 'completed' },
    ]);
  });

  it('is empty for a session that made none', () => {
    log(submitted('t_1'), said('t_1', 'nothing to do'));
    expect(toolCallsOf(h.db, S)).toEqual([]);
  });
});

describe('hadSideEffects', () => {
  const calls = [
    { toolCallId: 'c1', title: 'read', status: 'completed' },
    { toolCallId: 'c2', title: 'grep', status: 'completed' },
  ];

  it('is false when every call is one the role lists as read-only', () => {
    expect(hadSideEffects(calls, ['read', 'grep', 'ls'])).toBe(false);
    expect(hadSideEffects([], [])).toBe(false);
  });

  it('is true for any call not on the list, and for every call when the list is empty', () => {
    expect(hadSideEffects([...calls, { toolCallId: 'c3', title: 'bash', status: 'completed' }], ['read', 'grep'])).toBe(
      true,
    );
    expect(hadSideEffects(calls, [])).toBe(true);
  });
});

describe('lastTurnOf', () => {
  it("gives the last turn's errors and what the agent said in it, and nothing from earlier turns", () => {
    log(
      submitted('t_1'),
      said('t_1', 'first turn'),
      failed('t_1', 'old error'),
      submitted('t_2'),
      said('t_2', 'Working on '),
      said('t_2', 'it.'),
      failed('t_2', 'Error: 429 Too Many Requests'),
    );
    expect(lastTurnOf(h.db, S)).toEqual({ errors: ['Error: 429 Too Many Requests'], output: 'Working on it.' });
  });

  it('is empty for a session that has had no turn', () => {
    expect(lastTurnOf(h.db, S)).toEqual({ errors: [], output: '' });
  });

  it('keeps the tail of a long output', () => {
    log(submitted('t_1'), said('t_1', `${'a'.repeat(LAST_OUTPUT_CHARS)}END`));
    const { output } = lastTurnOf(h.db, S);
    expect(output).toHaveLength(LAST_OUTPUT_CHARS);
    expect(output.endsWith('aEND')).toBe(true);
  });

  it('masks a secret split across two chunks, and drops one the turn ended part-way through', () => {
    addSecrets(['sk-live-1234567890']);
    log(submitted('t_1'), said('t_1', 'key is sk-live-'), said('t_1', '1234567890; then sk-live-12'));
    expect(lastTurnOf(h.db, S).output).toBe(`key is ${MASK}; then `);
  });
});
