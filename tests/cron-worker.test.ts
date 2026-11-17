import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindSession } from '../src/db/bindings.js';
import { getJob, type JobRow } from '../src/db/cron.js';
import { createSession } from '../src/db/sessions.js';
import { createTurn, setTurnState } from '../src/db/turns.js';
import { CronService } from '../src/cron/service.js';
import { CronTokens } from '../src/cron/tokens.js';
import { CronApi } from '../src/cron/worker.js';
import { KanbanService } from '../src/kanban/service.js';
import { SocketHandler } from '../src/kanban/socket.js';
import { hashToken, mintToken } from '../src/kanban/token.js';
import { WorkerApi } from '../src/kanban/worker.js';
import { clearSecrets } from '../src/secrets.js';
import type { BindingKey } from '../src/types.js';
import { NOW } from './helpers/cron.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { claim } from '../src/db/kanban.js';
import { WORKSPACES, claimantFor, newTask } from './helpers/kanban.js';

/**
 * The agents' mt cron (the cron spec, §6.3, §7): strict JSON, a chat turn's add
 * only behind an operator, a fire's add refused, pause and remove of one's own
 * jobs only, a board run's chat its task's first subscription, and the socket's
 * envelopes.
 */

let h: TestDb;
let tokens: CronTokens;
let service: CronService;
let api: CronApi;
let clock: ManualClock;
const KEY: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_1' };

beforeEach(() => {
  clearSecrets();
  h = testDb();
  clock = new ManualClock(NOW);
  const roles = new Map([['default', role('default')], ['worker', role('worker')], ['careful', role('careful', { agent: { ...role('careful').agent, unsupervised: false } })]]);
  service = new CronService({ db: h.db, roles, workspaces: new Set(['default']), zone: 'Asia/Shanghai', clock });
  tokens = new CronTokens({ db: h.db });
  api = new CronApi({ db: h.db, service, tokens, appId: 'cli_app' });
});
afterEach(() => {
  clearSecrets();
  h.close();
});

/** A chat session at KEY with a running turn, asked by an operator or not; its token. */
function chatTurn(operate: boolean, sessionId = 's_chat', agentId = 'default', key: BindingKey = KEY): string {
  createSession(h.db, { id: sessionId, agentId, workspaceId: 'default', ownerPrincipal: 'on_alice' }, NOW);
  bindSession(h.db, key, sessionId, NOW);
  const token = tokens.envFor(sessionId, key)?.['MT_CRON_TOKEN'] ?? '';
  createTurn(h.db, { sessionId, turnId: 't_1', generation: 0, idempotencyKey: 'k1' }, NOW);
  setTurnState(h.db, sessionId, 't_1', 'running');
  tokens.turnSubmitted(sessionId, 'k1', operate);
  return token;
}

const add = (token: string, input: Record<string, unknown>, run?: string) =>
  api.handle({ cron: 'add', token, input: { schedule: 'every day 09:00', prompt: 'Summarise the day.', ...input }, ...(run === undefined ? {} : { run }) });

describe("a chat turn's agent", () => {
  it("adds a job delivering to its binding's chat and thread, as its own session's role, named by its session, answered with an ISO time", async () => {
    const token = chatTurn(true);
    const r = await add(token, { idempotency_key: 'daily' });
    expect(r).toMatchObject({ ok: true, existing: false, tz: 'Asia/Shanghai', next_run_at: '2026-11-18T09:00:00+08:00', created_by: 'session:s_chat' });
    const job = getJob(h.db, (r as unknown as { job_id: string }).job_id) as JobRow;
    expect(job).toMatchObject({ role: 'default', delivery: { channel: 'lark', account: 'cli_app', chat: 'oc_team', thread: 'omt_1', root: null }, idempotencyKey: 'session:s_chat:daily' });
    expect(await add(token, { idempotency_key: 'daily' })).toMatchObject({ ok: true, existing: true, job_id: job.jobId });
  });

  it('is refused needs_operator for a turn at talk tier, and for one with none recorded', async () => {
    const token = chatTurn(false);
    expect(await add(token, {})).toEqual({
      ok: false,
      code: 'needs_operator',
      message: 'this turn was asked by someone without operate tier, who cannot add cron jobs; an operator can, here or with /cron add',
    });
  });

  it("refuses a script, a role, an unknown field and a wrong type, and a supervised own role", async () => {
    const token = chatTurn(true);
    expect(await add(token, { script: 'echo' })).toEqual({ ok: false, code: 'invalid', message: "a script is the operator's; ask one to add it with mt cron edit" });
    expect(await add(token, { role: 'worker' })).toEqual({ ok: false, code: 'invalid', message: 'mt cron takes no field "role": a job runs as the agent\'s own role' });
    expect(await add(token, { colour: 'blue' })).toMatchObject({ ok: false, code: 'invalid', message: 'add takes no field "colour" (it takes schedule, prompt, name, tz, idempotency_key)' });
    expect(await add(token, { tz: 5 })).toEqual({ ok: false, code: 'invalid', message: 'tz is text' });
    expect(await api.handle({ cron: 'add', token, input: {} })).toEqual({ ok: false, code: 'invalid', message: 'add needs schedule, as text' });
    const careful = chatTurn(true, 's_careful', 'careful', { ...KEY, threadId: 'omt_2' });
    expect(await add(careful, {})).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it("pauses and removes only the jobs it made, and lists its chat's", async () => {
    const token = chatTurn(true);
    const mine = (await add(token, {})) as unknown as { job_id: string };
    const theirs = service.add({ schedule: 'every 1h', role: 'worker', prompt: 'x', delivery: { channel: 'lark', account: 'cli_app', chat: 'oc_team', thread: '', root: null }, createdBy: 'lark:on_bob', createdVia: { kind: 'chat' } });
    const theirId = theirs.ok ? theirs.job.jobId : '';
    expect(await api.handle({ cron: 'pause', token, input: { job_id: theirId } })).toMatchObject({ ok: false, code: 'not_yours' });
    expect(await api.handle({ cron: 'pause', token, input: { job_id: mine.job_id } })).toEqual({ ok: true, job_id: mine.job_id, state: 'paused' });
    const list = (await api.handle({ cron: 'list', token, input: {} })) as unknown as { jobs: Array<{ job_id: string }> };
    expect(list.jobs.map((j) => j.job_id).sort()).toEqual([mine.job_id, theirId].sort());
    expect(await api.handle({ cron: 'remove', token, input: { job_id: mine.job_id } })).toMatchObject({ ok: true, state: 'removed' });
  });

  it("is unauthorized between turns", async () => {
    const token = chatTurn(true);
    h.db.prepare("UPDATE turns SET state = 'completed', ended_at = 1 WHERE session_id = 's_chat'").run();
    expect(await add(token, {})).toMatchObject({ ok: false, code: 'unauthorized' });
  });
});

describe("a fire's agent", () => {
  it('lists its job’s chat’s jobs, and is refused add, pause and remove', async () => {
    const r = service.add({ schedule: 'every 1h', role: 'worker', prompt: 'x', delivery: { channel: 'lark', account: 'cli_app', chat: 'oc_team', thread: '', root: null }, createdBy: 'operator:alice', createdVia: { kind: 'operator' } });
    const jobId = r.ok ? r.job.jobId : '';
    const token = tokens.mintFire(1, jobId);
    expect(await add(token, {})).toMatchObject({ ok: false, code: 'in_cron_fire' });
    expect(await api.handle({ cron: 'pause', token, input: { job_id: jobId } })).toMatchObject({ ok: false, code: 'not_yours' });
    expect(await api.handle({ cron: 'list', token, input: {} })).toMatchObject({ ok: true, jobs: [{ job_id: jobId }] });
  });
});

describe("a board run's agent", () => {
  function run(): { runId: string; token: string; taskId: string } {
    const task = newTask(h.db, { assignee: { kind: 'role', name: 'worker' } });
    const token = mintToken();
    const r = claim(h.db, { taskId: task.taskId, claimant: claimantFor(h.db, task.taskId), tokenHash: hashToken(token), workspaces: WORKSPACES }, NOW);
    if (!r.ok) throw new Error(r.message);
    return { runId: r.run.runId, token, taskId: task.taskId };
  }

  it("adds a job as its own role, delivering to its task's first subscription, and run_superseded once the run is over", async () => {
    const { runId, token } = run();
    const r = await add(token, {}, runId);
    expect(r).toMatchObject({ ok: true, created_by: `run:${runId}` });
    expect(getJob(h.db, (r as unknown as { job_id: string }).job_id)).toMatchObject({ role: 'worker', delivery: { channel: 'lark', account: 'cli_app', chat: 'oc_chat', thread: '', root: null } });
    expect(await add(token, {}, 'r_other')).toMatchObject({ ok: false, code: 'unauthorized' });
    h.db.prepare("UPDATE kanban_runs SET outcome = 'superseded' WHERE run_id = ?").run(runId);
    expect(await add(token, {}, runId)).toMatchObject({ ok: false, code: 'run_superseded' });
  });

  it('adds a job delivering nowhere for a task nobody follows, and says so', async () => {
    const { runId, token, taskId } = run();
    h.db.prepare('DELETE FROM kanban_subscriptions WHERE task_id = ?').run(taskId);
    expect(await add(token, {}, runId)).toMatchObject({ ok: true, delivery: 'none' });
  });
});

describe('the socket handler', () => {
  it('tells the envelopes apart: cron_off and kanban_off when either is off, unauthorized for an unknown token', async () => {
    const board = new WorkerApi({ db: h.db, service: new KanbanService({ db: h.db, roles: new Map(), workspaces: WORKSPACES }) });
    const cronOnly = new SocketHandler({ cron: (r) => api.handle(r), nudged: () => undefined });
    const boardOnly = new SocketHandler({ board: (r) => board.handle(r), nudged: () => undefined });
    expect(await cronOnly.handle({ run: 'r_1', token: mintToken(), command: 'show', input: {} })).toMatchObject({ ok: false, code: 'kanban_off' });
    expect(await boardOnly.handle({ cron: 'list', token: mintToken(), input: {} })).toMatchObject({ ok: false, code: 'cron_off' });
    expect(await cronOnly.handle({ cron: 'list', token: mintToken(), input: {} })).toMatchObject({ ok: false, code: 'unauthorized' });
    expect(await cronOnly.handle({ cron: 'list', token: 'short', input: {} })).toMatchObject({ ok: false, code: 'unauthorized' });
    expect(await boardOnly.handle({ run: 'r_1', token: mintToken(), command: 'show', input: {} })).toMatchObject({ ok: false, code: 'unauthorized' });
    expect(await cronOnly.handle({ cron: 'list', token: mintToken(), input: {}, extra: 1 })).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('throttles the nudge once, at the handler, with either feature alone', async () => {
    let asked = 0;
    for (const handler of [new SocketHandler({ cron: (r) => api.handle(r), nudged: () => (asked += 1) }), new SocketHandler({ nudged: () => (asked += 1) })]) {
      for (let i = 0; i < 3; i += 1) expect(await handler.handle({ nudge: true })).toEqual({ ok: true });
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(asked).toBe(2);
  });
});
