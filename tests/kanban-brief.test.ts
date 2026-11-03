import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent } from '../src/db/events.js';
import {
  addComment,
  archive,
  attachSession,
  block,
  closeRun,
  complete,
  DEFAULT_LIMITS,
  endRun,
  unblock,
} from '../src/db/kanban.js';
import { createSession } from '../src/db/sessions.js';
import { briefFor, endedUnreported } from '../src/kanban/brief.js';
import type { Role } from '../src/roles.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, claimed, newTask } from './helpers/kanban.js';

let h: TestDb;

beforeEach(() => {
  h = testDb();
});

afterEach(() => h.close());

const ROLE: Role = {
  name: 'implementer',
  source: 'directory',
  dir: '/r',
  description: undefined,
  workspace: undefined,
  agent: {
    driver: 'structured-cli',
    command: 'bytesec',
    args: [],
    env: {},
    unsupervised: true,
    passEnv: [],
    readOnlyTools: [],
    maskExempt: [],
  },
  roleMdPath: '/r/role.md',
  skills: [{ name: 'testing', description: 'How to test', dir: '/r/skills/testing', path: '/r/skills/testing/SKILL.md' }],
  secretValues: [],
};

/** A session for a run, with one tool call in its log. */
function sessionWithCall(id: string, title: string): string {
  createSession(h.db, { id, agentId: 'implementer', workspaceId: 'default', ownerPrincipal: 'kanban' }, NOW);
  appendEvent(h.db, id, { type: 'turn_submitted', actor: 'user', turnId: 't_1', payload: { text: 'go' } }, NOW);
  appendEvent(
    h.db,
    id,
    { type: 'tool_call', actor: 'agent', turnId: 't_1', payload: { toolCallId: 'c1', title, status: 'completed', raw: {} } },
    NOW,
  );
  return id;
}

describe('briefFor', () => {
  it("gathers the parents' handoffs, the earlier attempts with their tool calls, comments and children", () => {
    const parent = newTask(h.db, { title: 'Design' });
    const p = claimed(h.db, parent.taskId);
    expect(
      complete(h.db, parent.taskId, { kind: 'run', runId: p.runId }, { summary: 'Use YAML.', metadata: { doc: 'a.md' } }, NOW)
        .ok,
    ).toBe(true);
    expect(closeRun(h.db, p.runId, NOW).ok).toBe(true);

    const task = newTask(h.db, { title: 'Build', parents: [parent.taskId] });
    const child = newTask(h.db, { title: 'Review', parents: [task.taskId] });
    const first = claimed(h.db, task.taskId);
    expect(attachSession(h.db, first.runId, sessionWithCall('s_first', 'edit'), NOW).ok).toBe(true);
    expect(endRun(h.db, first.runId, { outcome: 'crashed', error: 'exited' }, DEFAULT_LIMITS, NOW).ok).toBe(true);
    expect(closeRun(h.db, first.runId, NOW).ok).toBe(true);
    expect(addComment(h.db, task.taskId, ALICE, 'Mind the BOM.', NOW).ok).toBe(true);

    const second = claimed(h.db, task.taskId);
    const brief = briefFor(h.db, { run: second, task, roleMd: 'Be careful.', role: ROLE });

    expect(brief.kind).toBe('work');
    expect(brief.roleMd).toBe('Be careful.');
    expect(brief.skills.map((s) => s.name)).toEqual(['testing']);
    expect(brief.parents).toEqual([
      expect.objectContaining({ summary: 'Use YAML.', metadata: { doc: 'a.md' }, task: expect.objectContaining({ title: 'Design' }) }),
    ]);
    expect(brief.attempts).toHaveLength(1);
    expect(brief.attempts[0]?.run).toMatchObject({ runId: first.runId, outcome: 'crashed', error: 'exited' });
    expect(brief.attempts[0]?.toolCalls).toEqual([{ toolCallId: 'c1', title: 'edit', status: 'completed' }]);
    expect(brief.comments.map((c) => c.body)).toEqual(['Mind the BOM.']);
    expect(brief.children.map((c) => c.taskId)).toEqual([child.taskId]);
  });

  it('gives an archived parent no handoff, and an attempt that reported no tool calls', () => {
    const parent = newTask(h.db, { title: 'Dropped' });
    expect(archive(h.db, parent.taskId, ALICE, NOW).ok).toBe(true);
    const task = newTask(h.db, { parents: [parent.taskId] });
    const first = claimed(h.db, task.taskId);
    expect(attachSession(h.db, first.runId, sessionWithCall('s_first', 'edit'), NOW).ok).toBe(true);
    const by = { kind: 'run', runId: first.runId } as const;
    expect(block(h.db, task.taskId, by, { kind: 'needs_input', reason: 'which format?' }, NOW).ok).toBe(true);
    expect(closeRun(h.db, first.runId, NOW).ok).toBe(true);
    expect(unblock(h.db, task.taskId, ALICE, 'YAML', NOW).ok).toBe(true);

    const second = claimed(h.db, task.taskId);
    const brief = briefFor(h.db, { run: second, task, roleMd: undefined, role: undefined });
    expect(brief.parents).toEqual([expect.objectContaining({ summary: null, metadata: null })]);
    expect(brief.skills).toEqual([]);
    expect(brief.attempts).toEqual([{ run: expect.objectContaining({ outcome: 'blocked' }), toolCalls: undefined }]);
  });
});

describe('endedUnreported', () => {
  it('is true for the outcomes of a run that ended without a report, and for nothing else', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    expect(endedUnreported(run)).toBe(false);
    for (const outcome of ['failed', 'crashed', 'timed_out', 'protocol_violation', 'rate_limited', 'interrupted', 'terminal_provider'] as const) {
      expect(endedUnreported({ ...run, outcome })).toBe(true);
    }
    for (const outcome of ['completed', 'review_requested', 'changes_requested', 'blocked', 'cancelled', 'superseded'] as const) {
      expect(endedUnreported({ ...run, outcome })).toBe(false);
    }
  });
});
