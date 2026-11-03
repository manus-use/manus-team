import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun, endRun, DEFAULT_LIMITS } from '../src/db/kanban.js';
import { eventsOf, getRun } from '../src/db/kanban-read.js';
import { KanbanService } from '../src/kanban/service.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { AGENT, NOW, WORKSPACES, claimed, newTask } from './helpers/kanban.js';

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
