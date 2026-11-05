import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent } from '../src/db/events.js';
import {
  addComment,
  addGate,
  archive,
  attachSession,
  block,
  closeRun,
  complete,
  DEFAULT_LIMITS,
  endRun,
  recordGates,
  requestChanges,
  requestReview,
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
    expect(addComment(h.db, task.taskId, ALICE, 'Mind the BOM.', NOW, true).ok).toBe(true);

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

describe('briefFor: a native run', () => {
  it("says so, and still carries the role's files, which the prompt then leaves out", () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    const c = { run, task, roleMd: 'Be careful.', role: ROLE };
    expect(briefFor(h.db, c, { native: true })).toMatchObject({ native: true, roleMd: 'Be careful.' });
    expect(briefFor(h.db, c)).not.toHaveProperty('native');
  });
});

describe("briefFor: a person reviewer's name", () => {
  it('gives the name the gateway knows for a person reviewer, and none for a role or a stranger', () => {
    const names = new Map([['lark:on_bob', 'Bob Li']]);
    const nameOf = (p: string) => names.get(p);
    const bob = newTask(h.db, { reviewer: { kind: 'human', name: 'lark:on_bob' }, workspace: 'web' });
    const c = { run: claimed(h.db, bob.taskId), task: bob, roleMd: undefined, role: undefined };
    expect(briefFor(h.db, c, { nameOf }).reviewerName).toBe('Bob Li');
    expect(briefFor(h.db, c)).not.toHaveProperty('reviewerName');
    const carol = newTask(h.db, { reviewer: { kind: 'human', name: 'lark:on_carol' }, workspace: 'api' });
    expect(briefFor(h.db, { run: claimed(h.db, carol.taskId), task: carol, roleMd: undefined, role: undefined }, { nameOf })).not.toHaveProperty('reviewerName');
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

describe('briefFor: gates, review and rework', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const REVIEWER = { kind: 'role', name: 'reviewer' } as const;

  it("gathers the task's gates and their latest run", () => {
    const task = newTask(h.db);
    expect(addGate(h.db, task.taskId, { command: 'npm test', timeoutS: 60 }, ALICE, NOW).ok).toBe(true);
    const result = { gateId: 1, command: 'npm test', exitCode: 1, signal: null, timedOut: false, durationMs: 3, output: 'FAIL' };
    const by = { runId: null, actor: ALICE };
    recordGates(h.db, task.taskId, by, 'complete', { passed: false, aborted: false, notRun: 0, results: [result] }, NOW);
    const passed = { passed: true, aborted: false, notRun: 0, results: [{ ...result, exitCode: 0, output: '' }] };
    recordGates(h.db, task.taskId, by, 'complete', passed, NOW + 1);
    const run = claimed(h.db, task.taskId);
    const brief = briefFor(h.db, { run, task, roleMd: undefined, role: ROLE });
    expect(brief.gates).toEqual([expect.objectContaining({ command: 'npm test', timeoutS: 60, createdBy: ALICE })]);
    expect(brief.lastGateRun).toMatchObject({ passed: true, actor: ALICE, at: NOW + 1, results: [{ exitCode: 0 }] });
    expect(brief.review).toBeUndefined();
    expect(brief.rework).toBeUndefined();
  });

  it('gives a review run the handoff it reviews, and a rework the reason and the handoff it revises', () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const work = claimed(h.db, task.taskId);
    const handoff = { summary: 'Parser written.', metadata: { pr: 7 }, reportedCommit: SHA, reportedDirty: false };
    expect(requestReview(h.db, task.taskId, { kind: 'run', runId: work.runId }, handoff, NOW).ok).toBe(true);
    expect(closeRun(h.db, work.runId, NOW).ok).toBe(true);
    const review = claimed(h.db, task.taskId);
    const asked = { runId: work.runId, actor: `run:${work.runId}`, ...handoff };
    expect(briefFor(h.db, { run: review, task, roleMd: undefined, role: ROLE }).review).toEqual(asked);

    expect(requestChanges(h.db, task.taskId, { kind: 'run', runId: review.runId }, 'Handle an empty file.', NOW).ok).toBe(true);
    expect(closeRun(h.db, review.runId, NOW).ok).toBe(true);
    const rework = claimed(h.db, task.taskId);
    const brief = briefFor(h.db, { run: rework, task, roleMd: undefined, role: ROLE });
    expect(brief.rework).toEqual({ reason: 'Handle an empty file.', actor: `run:${review.runId}`, handoff: asked });
    expect(brief.review).toBeUndefined();
  });

  it("reads a person's request and changes from their events, and no rework once a review is asked for again", () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const person = { kind: 'person', principal: ALICE } as const;
    expect(requestReview(h.db, task.taskId, person, { summary: 'Have a look.' }, NOW).ok).toBe(true);
    expect(requestChanges(h.db, task.taskId, person, 'Rename it.', NOW).ok).toBe(true);
    const rework = claimed(h.db, task.taskId);
    expect(briefFor(h.db, { run: rework, task, roleMd: undefined, role: ROLE }).rework).toEqual({
      reason: 'Rename it.',
      actor: ALICE,
      handoff: { runId: null, actor: ALICE, summary: 'Have a look.', metadata: null, reportedCommit: null, reportedDirty: null },
    });
    expect(requestReview(h.db, task.taskId, { kind: 'run', runId: rework.runId }, { summary: 'Renamed.' }, NOW).ok).toBe(true);
    expect(closeRun(h.db, rework.runId, NOW).ok).toBe(true);
    const later = claimed(h.db, task.taskId);
    expect(later.kind).toBe('review');
    expect(briefFor(h.db, { run: later, task, roleMd: undefined, role: ROLE }).review).toMatchObject({ summary: 'Renamed.' });
  });
});
