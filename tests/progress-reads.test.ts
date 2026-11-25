import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvents, lastAgentEventAt, lastEventBefore, readEventsOfTypes } from '../src/db/events.js';
import { DEFAULT_LIMITS, endRun, openProgressCard, progressCardFinal, stop } from '../src/db/kanban.js';
import {
  chatKindOf,
  countOpenProgressCards,
  openProgressCards,
  progressCard,
  progressDue,
  runEndedOf,
  stoppedOf,
} from '../src/db/kanban-read.js';
import { createSession } from '../src/db/sessions.js';
import type { CreatedVia } from '../src/kanban/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, claimed, newTask } from './helpers/kanban.js';
import { decideRunForTest } from './helpers/progress.js';

/**
 * What the progress cards read (progress cards spec §2, §5): the runs due a
 * card, the open cards, a run's end and its stop, a chat's kind, and a
 * session's tool events and its agent's last output.
 */

let h: TestDb;
const PLACES = ['default', 'web', 'api', 'docs'];
let made = 0;

beforeEach(() => {
  h = testDb();
  made = 0;
});
afterEach(() => h.close());

/** A chat a task was created in, by this bot on Lark unless said otherwise. */
function chat(extra: { conversationId: string; threadId?: string; rootId?: string; chatType?: 'p2p' | 'group'; channel?: string; appId?: string }): CreatedVia {
  return { kind: 'chat', channel: 'lark', appId: 'cli_app', threadId: '', ...extra };
}

const THREAD = chat({ conversationId: 'oc_team', threadId: 'omt_1', rootId: 'om_root', chatType: 'group' });
const DM = chat({ conversationId: 'oc_dm', chatType: 'p2p' });
const GROUP = chat({ conversationId: 'oc_team', chatType: 'group' });
const UNKNOWN = chat({ conversationId: 'oc_unknown' });

function agentRun(createdVia: CreatedVia, now = NOW, extra: Parameters<typeof newTask>[1] = {}): { taskId: string; runId: string } {
  const task = newTask(h.db, { workspace: PLACES[made++ % PLACES.length] ?? 'default', createdVia, ...extra }, now);
  const run = claimed(h.db, task.taskId, {}, now);
  return { taskId: task.taskId, runId: run.runId };
}

function open(runId: string, appId = 'cli_app', now = NOW): void {
  openProgressCard(h.db, { runId, appId, channel: 'lark', failureLimit: 2 }, now);
}

describe('progressDue', () => {
  it('finds the open undecided agent runs started by the cut, followed in a thread, a direct message, or a chat of unknown kind', () => {
    const thread = agentRun(THREAD);
    const dm = agentRun(DM);
    const unknown = agentRun(UNKNOWN);
    const group = agentRun(GROUP);
    const due = progressDue(h.db, 'cli_app', NOW);
    expect(due.map((d) => d.run.runId)).toEqual([thread.runId, dm.runId, unknown.runId]);
    expect(due[0]?.sub).toMatchObject({ conversationId: 'oc_team', threadId: 'omt_1', rootMessageId: 'om_root' });
    expect(due[1]?.sub.chatType).toBe('p2p');
    expect(due[2]?.sub.chatType).toBeNull();
    expect(due.some((d) => d.run.runId === group.runId)).toBe(false);
  });

  it("passes over a person's run, a later run, a decided run, one with a row, and one no chat of this bot follows", () => {
    const person = newTask(h.db, { workspace: 'web', createdVia: DM, assignee: { kind: 'human', name: ALICE } });
    claimed(h.db, person.taskId);
    made = 2;
    const later = agentRun(DM, NOW + 10_000);
    const decided = agentRun(DM);
    decideRunForTest(h.db, decided.runId, 'completed');
    const withRow = agentRun(DM);
    open(withRow.runId);
    expect(progressDue(h.db, 'cli_app', NOW)).toEqual([]);
    expect(progressDue(h.db, 'cli_other', NOW + 10_000)).toEqual([]);
    expect(progressDue(h.db, 'cli_app', NOW + 10_000).map((d) => d.run.runId)).toEqual([later.runId]);
  });
});

describe('the open cards', () => {
  it("reads this bot's open rows, the oldest first, a run's row in any state, and counts the open", () => {
    const a = agentRun(DM);
    const b = agentRun(DM);
    const c = agentRun(DM);
    open(b.runId, 'cli_app', NOW + 1);
    open(a.runId, 'cli_app', NOW + 2);
    open(c.runId, 'cli_other', NOW);
    expect(openProgressCards(h.db, 'cli_app').map((r) => r.runId)).toEqual([b.runId, a.runId]);
    expect(countOpenProgressCards(h.db)).toBe(3);
    progressCardFinal(h.db, b.runId, 0, NOW + 3);
    expect(openProgressCards(h.db, 'cli_app').map((r) => r.runId)).toEqual([a.runId]);
    expect(progressCard(h.db, b.runId)).toMatchObject({ state: 'final', tryNumber: 1, tryLimit: 2, messageId: null });
    expect(progressCard(h.db, 'r_none')).toBeUndefined();
  });
});

describe("a run's end and its stop", () => {
  it('reads the latest run_ended and stopped of the run, not of another', () => {
    const a = agentRun(DM);
    const b = agentRun(DM);
    expect(endRun(h.db, a.runId, { outcome: 'failed', error: 'boom', hadSideEffects: false }, { ...DEFAULT_LIMITS, failureLimit: 1 }, NOW).ok).toBe(true);
    expect(runEndedOf(h.db, a.taskId, a.runId)?.payload).toMatchObject({ outcome: 'failed', next: 'blocked', blockKind: 'gave_up' });
    expect(runEndedOf(h.db, b.taskId, b.runId)).toBeUndefined();
    expect(stop(h.db, b.taskId, ALICE, NOW + 2).ok).toBe(true);
    expect(stoppedOf(h.db, b.taskId, b.runId)?.actor).toBe(ALICE);
    expect(stoppedOf(h.db, a.taskId, a.runId)).toBeUndefined();
  });
});

describe('chatKindOf', () => {
  it('reads a chat kind from another subscription of this bot, channel and chat, and nothing else', () => {
    newTask(h.db, { createdVia: chat({ conversationId: 'oc_dm', chatType: 'p2p' }) });
    newTask(h.db, { createdVia: chat({ channel: 'other', conversationId: 'oc_elsewhere', chatType: 'p2p' }) });
    newTask(h.db, { createdVia: chat({ appId: 'cli_other', conversationId: 'oc_theirs', chatType: 'p2p' }) });
    expect(chatKindOf(h.db, 'cli_app', 'lark', 'oc_dm')).toBe('p2p');
    expect(chatKindOf(h.db, 'cli_app', 'lark', 'oc_elsewhere')).toBeUndefined();
    expect(chatKindOf(h.db, 'cli_app', 'lark', 'oc_theirs')).toBeUndefined();
    expect(chatKindOf(h.db, 'cli_app', 'lark', 'oc_nobody')).toBeUndefined();
  });
});

describe("a session's events", () => {
  function session(): string {
    createSession(h.db, { id: 's_run', agentId: 'implementer', workspaceId: 'default', ownerPrincipal: 'kanban' }, NOW);
    return 's_run';
  }

  it('reads only the types asked, in the range', () => {
    const s = session();
    appendEvents(
      h.db,
      s,
      [
        { type: 'turn_submitted', actor: 'gateway', payload: {} },
        { type: 'tool_call', actor: 'agent', payload: { toolCallId: 't1', title: 'Read', status: 'in_progress' } },
        { type: 'agent_message_chunk', actor: 'agent', payload: { text: 'hi' } },
        { type: 'tool_call_update', actor: 'agent', payload: { toolCallId: 't1', status: 'completed' } },
      ],
      NOW,
    );
    expect(readEventsOfTypes(h.db, s, ['tool_call', 'tool_call_update'], 0, 4).map((e) => e.seq)).toEqual([2, 4]);
    expect(readEventsOfTypes(h.db, s, ['tool_call', 'tool_call_update'], 2, 3)).toEqual([]);
    expect(readEventsOfTypes(h.db, s, [], 0, 4)).toEqual([]);
  });

  it("answers the agent's last output, passing over the boot's own events after it, and the last event before a time", () => {
    const s = session();
    expect(lastAgentEventAt(h.db, s)).toBeUndefined();
    appendEvents(h.db, s, [{ type: 'turn_submitted', actor: 'gateway', payload: {}, ts: NOW + 1 }], NOW);
    expect(lastAgentEventAt(h.db, s)).toBeUndefined();
    appendEvents(
      h.db,
      s,
      [
        { type: 'tool_call', actor: 'agent', payload: { toolCallId: 't1' }, ts: NOW + 5 },
        { type: 'agent_message_chunk', actor: 'agent', payload: { text: 'x' }, ts: NOW + 9 },
        { type: 'usage', actor: 'agent', payload: {}, ts: NOW + 7 },
        { type: 'turn_ended', actor: 'gateway', payload: { terminal: 'ambiguous' }, ts: NOW + 60_000 },
        { type: 'session_state_changed', actor: 'gateway', payload: {}, ts: NOW + 60_001 },
      ],
      NOW,
    );
    expect(lastAgentEventAt(h.db, s)).toBe(NOW + 9);
    expect(lastEventBefore(h.db, s, NOW + 60_000)).toBe(NOW + 7);
    expect(lastEventBefore(h.db, s, NOW + 1)).toBeUndefined();
  });
});
