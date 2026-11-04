import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachSession, closeRun, endRun, requestChanges, requestReview, DEFAULT_LIMITS } from '../src/db/kanban.js';
import { eventsOf, getRun } from '../src/db/kanban-read.js';
import { createSession } from '../src/db/sessions.js';
import { KanbanService } from '../src/kanban/service.js';
import type { Rendering, RunRow } from '../src/kanban/types.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { AGENT, ALICE, NOW, WORKSPACES, claimed, newTask } from './helpers/kanban.js';

/**
 * Whether a run ran natively (plan R) is recorded on the run, in its
 * agent_config beside the agent it ran, through the service and db/kanban.ts.
 */

let h: TestDb;
let service: KanbanService;
const HASH = '3f9c2a7be41d08f5c6a9e2b7d4f10c83e5a6b9d2f7c4e1a08b3d6f9c2e5a7b41';
/** A known secret that happens to occur inside HASH: the event keeps the hash whole. */
const SECRET_IN_HASH = HASH.slice(20, 36);

beforeEach(() => {
  clearSecrets();
  addSecrets([SECRET_IN_HASH]);
  h = testDb();
  service = new KanbanService({ db: h.db, roles: new Map(), workspaces: WORKSPACES });
});

afterEach(() => {
  h.close();
  clearSecrets();
});

describe('recordRendering', () => {
  it("adds native and the package hash to the run's agent_config, once, with an event that does not mask the hash", () => {
    const run = claimed(h.db, newTask(h.db).taskId);
    const r = service.recordRendering(run.runId, { native: true, packageHash: HASH });
    expect(r).toMatchObject({ ok: true, run: { agentConfig: { ...AGENT, native: true, packageHash: HASH } } });
    // The read type shows it, as the board's run view does.
    expect(getRun(h.db, run.runId)?.agentConfig).toEqual({ ...AGENT, native: true, packageHash: HASH });
    expect(eventsOf(h.db, run.taskId).filter((e) => e.kind === 'run_rendered')).toEqual([
      expect.objectContaining({ runId: run.runId, actor: 'gateway', payload: { native: true, packageHash: HASH } }),
    ]);
    expect(service.recordRendering(run.runId, { native: false })).toEqual({
      ok: false,
      code: 'invalid',
      message: `run ${run.runId}'s rendering is already recorded`,
    });
  });

  it('records a run that was not rendered as native false, with no hash', () => {
    const run = claimed(h.db, newTask(h.db).taskId);
    expect(service.recordRendering(run.runId, { native: false })).toMatchObject({ ok: true });
    const agent = getRun(h.db, run.runId)?.agentConfig;
    expect(agent).toEqual({ ...AGENT, native: false });
    expect(agent).not.toHaveProperty('packageHash');
  });

  it('refuses a hash that is not one, a hash on a run that was not native, a closed run and a person\'s', () => {
    const run = claimed(h.db, newTask(h.db).taskId);
    for (const bad of [{ native: true, packageHash: 'abc' }, { native: false, packageHash: HASH }] as const) {
      expect(service.recordRendering(run.runId, bad as never)).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(getRun(h.db, run.runId)?.agentConfig).toEqual(AGENT);

    expect(endRun(h.db, run.runId, { outcome: 'failed', error: 'x' }, DEFAULT_LIMITS, NOW).ok).toBe(true);
    expect(closeRun(h.db, run.runId, NOW).ok).toBe(true);
    expect(service.recordRendering(run.runId, { native: false })).toMatchObject({ ok: false, code: 'already_closed' });

    const person = claimed(h.db, newTask(h.db, { assignee: { kind: 'human', name: 'lark:on_bob' } }).taskId);
    expect(service.recordRendering(person.runId, { native: false })).toEqual({
      ok: false,
      code: 'invalid',
      message: `run ${person.runId} is a person's: nothing renders for it`,
    });
    expect(service.recordRendering('r_none', { native: false })).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe("recordRendering settles a rework's seed (spec §5.3)", () => {
  const spaces = [...WORKSPACES];
  let used = 0;

  /**
   * A work run given its role one way, reviewed, changes asked; then the rework,
   * claimed seeded from it. Each in a workspace of its own, as the rework stays open.
   */
  function rework(work: Rendering | undefined): { work: RunRow; rework: RunRow } {
    const task = newTask(h.db, { reviewer: { kind: 'role', name: 'reviewer' }, workspace: spaces[used++ % spaces.length] ?? null });
    const first = claimed(h.db, task.taskId);
    createSession(
      h.db,
      {
        id: `s_${first.runId}`,
        agentId: 'implementer',
        workspaceId: 'default',
        ownerPrincipal: ALICE,
        providerSessionId: 'prov_1',
      },
      NOW,
    );
    if (attachSession(h.db, first.runId, `s_${first.runId}`, NOW).ok !== true) throw new Error('not attached');
    if (work !== undefined && !service.recordRendering(first.runId, work).ok) throw new Error('not recorded');
    requestReview(h.db, task.taskId, { kind: 'run', runId: first.runId }, { summary: 'v1' }, NOW);
    closeRun(h.db, first.runId, NOW);
    const review = claimed(h.db, task.taskId);
    requestChanges(h.db, task.taskId, { kind: 'run', runId: review.runId }, 'add a test', NOW);
    closeRun(h.db, review.runId, NOW);
    const again = claimed(h.db, task.taskId);
    expect(again.seededFromRun).toBe(first.runId);
    return { work: first, rework: again };
  }

  const OTHER = 'a'.repeat(64);

  it('keeps the seed when the rework is given its role as the work was: the same package, or both in the prompt', () => {
    for (const how of [{ native: true, packageHash: HASH }, { native: false }] as const) {
      const r = rework(how);
      expect(service.recordRendering(r.rework.runId, how)).toMatchObject({ ok: true, run: { seededFromRun: r.work.runId } });
      expect(eventsOf(h.db, r.rework.taskId).at(-1)?.payload).toEqual(how);
    }
    // A work run from before plan R recorded neither key: it was not native.
    const old = rework(undefined);
    expect(service.recordRendering(old.rework.runId, { native: false })).toMatchObject({
      run: { seededFromRun: old.work.runId },
    });
  });

  it('drops the seed when the rework is given its role another way, and says so', () => {
    const cases: Array<[Rendering | undefined, Rendering]> = [
      [{ native: true, packageHash: HASH }, { native: true, packageHash: OTHER }],
      [{ native: true, packageHash: HASH }, { native: false }],
      [{ native: false }, { native: true, packageHash: HASH }],
      [undefined, { native: true, packageHash: HASH }],
    ];
    for (const [then, now] of cases) {
      const r = rework(then);
      expect(service.recordRendering(r.rework.runId, now)).toMatchObject({ ok: true, run: { seededFromRun: null } });
      expect(getRun(h.db, r.rework.runId)?.seededFromRun).toBeNull();
      expect(eventsOf(h.db, r.rework.taskId).at(-1)).toMatchObject({
        kind: 'run_rendered',
        payload: { ...now, seedDropped: r.work.runId },
      });
    }
  });
});
