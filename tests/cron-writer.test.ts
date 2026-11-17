import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cronUuid, newCronJobId } from '../src/core/ids.js';
import { bindSession, revokeBindingsAt } from '../src/db/bindings.js';
import {
  CRON_LIMITS,
  addJob,
  attachFireSession,
  dropStaleStamps,
  dueJobs,
  editJob,
  endFire,
  firesOf,
  getFire,
  getJob,
  interruptOpenFires,
  lastResult,
  listJobs,
  markDelivered,
  pauseJob,
  pendingDeliveries,
  purgeRemoved,
  removeJob,
  requestRun,
  resumeJob,
  runningFire,
  scheduleAfter,
  skipFire,
  startFire,
  type JobRow,
} from '../src/db/cron.js';
import { appendEvent, lastEventAt } from '../src/db/events.js';
import { createSession } from '../src/db/sessions.js';
import { createTurn } from '../src/db/turns.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { NOW, TEAM, jobInput, newJob } from './helpers/cron.js';
import { testDb, type TestDb } from './helpers/db.js';

/**
 * The cron writer (the cron spec, §3): every write one transaction that
 * re-reads what it decides on, the limits counted inside it, the failures in
 * endFire and skipFire alone, and a pruned fire's session deleted with it.
 */

let h: TestDb;
beforeEach(() => {
  clearSecrets();
  h = testDb();
});
afterEach(() => {
  clearSecrets();
  h.close();
});

const HOUR = 3_600_000;

/** Fire a job's due slot now. */
function fire(job: JobRow, now = NOW, maxRunning = 2): number {
  const r = startFire(
    h.db,
    { jobId: job.jobId, trigger: 'schedule', slot: job.nextRunAt ?? 0, schedule: job.schedule, tz: job.tz, next: (job.nextRunAt ?? 0) + HOUR, scheduledAt: job.nextRunAt ?? 0, maxRunning },
    now,
  );
  if (!r.ok) throw new Error(r.message);
  return r.fire.fireId;
}

/** A fire's session, bound on the cron channel at the job and the fire, its binding revoked as an archive leaves it. */
function fireSession(jobId: string, fireId: number, extra: { also?: string } = {}): string {
  const id = `s_${fireId}_${jobId}`;
  createSession(h.db, { id, agentId: 'worker', workspaceId: 'default', ownerPrincipal: 'cron' }, NOW);
  appendEvent(h.db, id, { type: 'turn_submitted', actor: 'user', turnId: 't_1', payload: { text: 'go' } }, NOW);
  createTurn(h.db, { sessionId: id, turnId: 't_1', generation: 0, idempotencyKey: `k_${fireId}` }, NOW);
  const key = { channel: 'cron', appId: 'cli_app', conversationId: jobId, threadId: String(fireId) };
  bindSession(h.db, key, id, NOW);
  revokeBindingsAt(h.db, key, NOW + 1);
  if (extra.also !== undefined) bindSession(h.db, { channel: extra.also, appId: 'cli_app', conversationId: 'oc_team', threadId: '' }, id, NOW);
  attachFireSession(h.db, fireId, id);
  return id;
}

const count = (table: string, where = '1 = 1', ...args: unknown[]): number =>
  (h.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...args) as { n: number }).n;

describe('addJob', () => {
  it('masks the name, the prompt and created_via, never the script', () => {
    addSecrets(['sk-live-1234567890']);
    const job = newJob(h.db, {
      name: 'key sk-live-1234567890',
      prompt: 'use sk-live-1234567890',
      script: 'echo sk-live-1234567890',
      createdVia: { kind: 'chat', chatId: 'oc_sk-live-1234567890' },
    });
    expect(job).toMatchObject({ name: `key ${MASK}`, prompt: `use ${MASK}`, script: 'echo sk-live-1234567890', createdVia: { kind: 'chat', chatId: `oc_${MASK}` } });
    expect(job.state).toBe('active');
  });

  it('answers a repeated key with the job it made', () => {
    const a = newJob(h.db, { idempotencyKey: 'lark:om_1' });
    const r = addJob2({ idempotencyKey: 'lark:om_1', name: 'another' });
    expect(r).toMatchObject({ ok: true, existing: true, job: { jobId: a.jobId, name: 'Daily PRs' } });
  });

  it('refuses a key whose job was removed, adding nothing', () => {
    const a = newJob(h.db, { idempotencyKey: 'lark:om_9' });
    expect(removeJob(h.db, a.jobId, NOW).ok).toBe(true);
    expect(addJob2({ idempotencyKey: 'lark:om_9' })).toEqual({ ok: false, code: 'state', message: 'the job of that key was removed' });
    expect(h.db.prepare('SELECT count(*) AS n FROM cron_jobs').get()).toEqual({ n: 1 });
  });

  it('counts 50 active jobs a gateway and 10 a chat, in its transaction; pausing frees a place and resuming takes one', () => {
    const here = Array.from({ length: CRON_LIMITS.chatJobs }, () => newJob(h.db));
    expect(addJob2({})).toEqual({ ok: false, code: 'too_many', message: 'this chat has 10 active cron jobs, and the limit is 10: pause or remove one first' });
    // Another thread of the chat counts toward it too; a job delivering nowhere does not.
    expect(addJob2({ delivery: { ...TEAM, thread: 'omt_1' } }).ok).toBe(false);
    expect(addJob2({ delivery: null }).ok).toBe(true);
    const first = here[0] as JobRow;
    expect(pauseJob(h.db, first.jobId, NOW).ok).toBe(true);
    expect(addJob2({}).ok).toBe(true);
    expect(resumeJob(h.db, first.jobId, NOW + HOUR, NOW)).toMatchObject({ ok: false, code: 'too_many' });
    for (let i = 0; i < CRON_LIMITS.activeJobs - 11; i += 1) newJob(h.db, { delivery: { ...TEAM, chat: `oc_${i}` } });
    expect(addJob2({ delivery: null })).toEqual({
      ok: false,
      code: 'too_many',
      message: 'this gateway has 50 active cron jobs, and the limit is 50: pause or remove one first',
    });
  });
});

function addJob2(extra: Parameters<typeof jobInput>[0]): ReturnType<typeof addJob> {
  return addJob(h.db, jobInput(extra), NOW);
}

describe('the job states', () => {
  it('pauses, resumes with no failures, removes, and refuses what its state does not allow', () => {
    const job = newJob(h.db);
    expect(resumeJob(h.db, job.jobId, NOW, NOW)).toEqual({ ok: false, code: 'state', message: `cron job ${job.jobId} is active` });
    expect(pauseJob(h.db, job.jobId, NOW)).toMatchObject({ ok: true, job: { state: 'paused', nextRunAt: null } });
    h.db.prepare('UPDATE cron_jobs SET failures = 2 WHERE job_id = ?').run(job.jobId);
    expect(resumeJob(h.db, job.jobId, NOW + 5, NOW)).toMatchObject({ ok: true, job: { state: 'active', nextRunAt: NOW + 5, failures: 0 } });
    expect(removeJob(h.db, job.jobId, NOW)).toMatchObject({ ok: true, job: { state: 'removed', nextRunAt: null } });
    expect(pauseJob(h.db, job.jobId, NOW)).toMatchObject({ ok: false, code: 'not_found' });
    expect(listJobs(h.db)).toEqual([]);
  });

  it('edits a job, moving its next run only when told, and counts an active job moved to a full chat', () => {
    const job = newJob(h.db);
    expect(editJob(h.db, job.jobId, { prompt: 'Other.' }, NOW)).toMatchObject({ ok: true, job: { prompt: 'Other.', nextRunAt: job.nextRunAt } });
    expect(editJob(h.db, job.jobId, { schedule: 'every 2h', nextRunAt: NOW + 2 * HOUR }, NOW)).toMatchObject({ ok: true, job: { nextRunAt: NOW + 2 * HOUR } });
    for (let i = 0; i < 10; i += 1) newJob(h.db, { delivery: { ...TEAM, chat: 'oc_full' } });
    expect(editJob(h.db, job.jobId, { delivery: { ...TEAM, chat: 'oc_full' } }, NOW)).toMatchObject({ ok: false, code: 'too_many' });
    expect(editJob(h.db, job.jobId, { delivery: null }, NOW)).toMatchObject({ ok: true, job: { delivery: null } });
  });

  it("sets one stamp however often a run is asked, and refuses one while a fire runs", () => {
    const job = newJob(h.db);
    expect(requestRun(h.db, job.jobId, NOW)).toMatchObject({ ok: true, job: { runRequestedAt: NOW } });
    expect(requestRun(h.db, job.jobId, NOW + 5)).toMatchObject({ ok: true, job: { runRequestedAt: NOW } });
    fire(getJob(h.db, job.jobId) as JobRow, job.nextRunAt ?? 0);
    expect(requestRun(h.db, job.jobId, NOW)).toMatchObject({ ok: false, code: 'running', running: { jobId: job.jobId } });
  });
});

describe('startFire and skipFire', () => {
  it('fires one slot once: a second start on the same slot is refused, and the job advanced with the fire', () => {
    const job = newJob(h.db);
    const at = job.nextRunAt ?? 0;
    fire(job, at);
    expect(getJob(h.db, job.jobId)?.nextRunAt).toBe(at + HOUR);
    expect(
      startFire(h.db, { jobId: job.jobId, trigger: 'schedule', slot: at, schedule: job.schedule, tz: job.tz, next: at + HOUR, scheduledAt: at, maxRunning: 2 }, at),
    ).toEqual({ ok: false, code: 'moved', message: `cron job ${job.jobId} is no longer due at that slot` });
    expect(firesOf(h.db, job.jobId)).toHaveLength(1);
  });

  it('refuses a second running fire of a job, and one past max_running; a one-off is done once it fires', () => {
    const a = newJob(h.db);
    const b = newJob(h.db);
    requestRun(h.db, a.jobId, NOW);
    fire(a, NOW, 1);
    const bAt = b.nextRunAt ?? 0;
    expect(
      startFire(h.db, { jobId: b.jobId, trigger: 'schedule', slot: bAt, schedule: b.schedule, tz: b.tz, next: bAt + HOUR, scheduledAt: bAt, maxRunning: 1 }, NOW),
    ).toMatchObject({ ok: false, code: 'at_limit' });
    expect(
      startFire(h.db, { jobId: a.jobId, trigger: 'run', schedule: a.schedule, tz: a.tz, scheduledAt: NOW, maxRunning: 5 }, NOW),
    ).toMatchObject({ ok: false, code: 'running' });
    const once = newJob(h.db, { schedule: 'in 30m', nextRunAt: NOW + 1800_000 });
    startFire(h.db, { jobId: once.jobId, trigger: 'schedule', slot: NOW + 1800_000, schedule: 'in 30m', tz: once.tz, scheduledAt: NOW + 1800_000, maxRunning: 5 }, NOW);
    expect(getJob(h.db, once.jobId)).toMatchObject({ state: 'done', nextRunAt: null });
  });

  it("fires a stamp, clearing it, and leaves the job's state and next run", () => {
    const job = newJob(h.db);
    pauseJob(h.db, job.jobId, NOW);
    requestRun(h.db, job.jobId, NOW);
    const r = startFire(h.db, { jobId: job.jobId, trigger: 'run', schedule: job.schedule, tz: job.tz, scheduledAt: NOW, maxRunning: 2 }, NOW);
    expect(r).toMatchObject({ ok: true, fire: { trigger: 'run', scheduledAt: NOW } });
    expect(getJob(h.db, job.jobId)).toMatchObject({ state: 'paused', nextRunAt: null, runRequestedAt: null });
  });

  it('records a skip with the advance; an unavailable one counts a failure, is to be said, and pauses at three', () => {
    const job = newJob(h.db);
    const skip = (outcome: 'skipped_missed' | 'skipped_unavailable') => {
      const now = getJob(h.db, job.jobId) as JobRow;
      const at = now.nextRunAt ?? 0;
      return skipFire(h.db, { jobId: job.jobId, trigger: 'schedule', slot: at, schedule: job.schedule, tz: job.tz, next: at + HOUR, scheduledAt: at, outcome, error: 'role worker is not configured' }, at);
    };
    expect(skip('skipped_missed')).toMatchObject({ ok: true, paused: false, fire: { outcome: 'skipped_missed', startedAt: null, delivery: 'none' } });
    expect(getJob(h.db, job.jobId)?.failures).toBe(0);
    expect(skip('skipped_unavailable')).toMatchObject({ ok: true, paused: false, fire: { delivery: 'pending' } });
    skip('skipped_unavailable');
    expect(skip('skipped_unavailable')).toMatchObject({ ok: true, paused: true });
    expect(getJob(h.db, job.jobId)).toMatchObject({ state: 'paused', failures: 3, nextRunAt: null });
  });

  it('advances a job without a fire, compared as a fire is', () => {
    const job = newJob(h.db);
    const at = job.nextRunAt ?? 0;
    expect(scheduleAfter(h.db, { jobId: job.jobId, trigger: 'schedule', slot: at, schedule: job.schedule, tz: job.tz, next: at + HOUR }, NOW)).toMatchObject({
      ok: true,
      job: { nextRunAt: at + HOUR },
    });
    expect(scheduleAfter(h.db, { jobId: job.jobId, trigger: 'schedule', slot: at, schedule: job.schedule, tz: job.tz, next: at + HOUR }, NOW).ok).toBe(false);
    expect(firesOf(h.db, job.jobId)).toEqual([]);
  });
});

describe('endFire', () => {
  it('ends a fire once, counting failures, resetting them, and pausing at three in its own transaction', () => {
    const job = newJob(h.db);
    const end = (outcome: 'agent_failed' | 'posted' | 'interrupted') => {
      const now = getJob(h.db, job.jobId) as JobRow;
      const id = fire(now, now.nextRunAt ?? 0);
      return endFire(h.db, { fireId: id, outcome, error: 'boom', message: true }, now.nextRunAt ?? 0);
    };
    end('agent_failed');
    end('agent_failed');
    expect(end('posted')).toMatchObject({ ok: true, paused: false, job: { failures: 0 } });
    end('agent_failed');
    expect(end('interrupted')).toMatchObject({ job: { failures: 1 } });
    end('agent_failed');
    expect(end('agent_failed')).toMatchObject({ ok: true, paused: true, job: { state: 'paused', failures: 3 } });
    const last = firesOf(h.db, job.jobId)[0];
    expect(endFire(h.db, { fireId: last?.fireId ?? 0, outcome: 'posted', message: true }, NOW)).toMatchObject({ ok: false, code: 'state' });
  });

  it('masks and cuts the error to 2 KiB and the result to 8 KiB, and is pending only for a message with a delivery', () => {
    addSecrets(['sk-live-1234567890']);
    const job = newJob(h.db);
    const id = fire(job, job.nextRunAt ?? 0);
    const r = endFire(h.db, { fireId: id, outcome: 'posted', result: `sk-live-1234567890 ${'é'.repeat(9000)}`, error: 'x'.repeat(3000), message: true }, NOW);
    expect(r.ok && r.fire.result?.startsWith(MASK)).toBe(true);
    expect(Buffer.byteLength(r.ok ? (r.fire.result ?? '') : '', 'utf8')).toBeLessThanOrEqual(CRON_LIMITS.resultBytes);
    expect(r.ok ? r.fire.error?.length : 0).toBe(CRON_LIMITS.errorBytes);
    expect(r).toMatchObject({ fire: { delivery: 'pending' } });
    expect(pendingDeliveries(h.db).map((f) => f.fireId)).toEqual([id]);
    markDelivered(h.db, id, 'sent');
    markDelivered(h.db, id, 'failed');
    expect(getFire(h.db, id)?.delivery).toBe('sent');
    expect(lastResult(h.db, job.jobId)?.fireId).toBe(id);

    const nowhere = newJob(h.db, { delivery: null });
    const other = fire(nowhere, nowhere.nextRunAt ?? 0);
    expect(endFire(h.db, { fireId: other, outcome: 'posted', message: true }, NOW)).toMatchObject({ fire: { delivery: 'none' } });
  });

  it('keeps a job’s newest 50 fires, deleting the sessions of the pruned with their events, turns and bindings', () => {
    const job = newJob(h.db);
    const sessions: string[] = [];
    for (let i = 0; i < CRON_LIMITS.history + 1; i += 1) {
      const now = getJob(h.db, job.jobId) as JobRow;
      const id = fire(now, now.nextRunAt ?? 0);
      sessions.push(fireSession(job.jobId, id));
      endFire(h.db, { fireId: id, outcome: 'nothing', message: false }, now.nextRunAt ?? 0);
    }
    expect(firesOf(h.db, job.jobId, 100)).toHaveLength(CRON_LIMITS.history);
    const first = sessions[0] ?? '';
    for (const table of ['events', 'turns', 'channel_bindings']) expect(count(table, 'session_id = ?', first)).toBe(0);
    expect(count('sessions', 'id = ?', first)).toBe(0);
    expect(count('sessions', 'id = ?', sessions[1] ?? '')).toBe(1);
    expect(lastEventAt(h.db, sessions[1] ?? '')).toBe(NOW);
  });
});

describe('the prune, sparing what can still be reached', () => {
  it("keeps a fire whose delivery is pending past the newest 50, with its session", () => {
    const job = newJob(h.db);
    let first = 0;
    let session = '';
    for (let i = 0; i < CRON_LIMITS.history + 1; i += 1) {
      const now = getJob(h.db, job.jobId) as JobRow;
      const id = fire(now, now.nextRunAt ?? 0);
      if (i === 0) {
        first = id;
        session = fireSession(job.jobId, id);
      }
      endFire(h.db, { fireId: id, outcome: i === 0 ? 'posted' : 'nothing', message: i === 0 }, now.nextRunAt ?? 0);
    }
    expect(getFire(h.db, first)?.delivery).toBe('pending');
    expect(firesOf(h.db, job.jobId, 100)).toHaveLength(CRON_LIMITS.history + 1);
    expect(count('sessions', 'id = ?', session)).toBe(1);
    markDelivered(h.db, first, 'sent');
    const now = getJob(h.db, job.jobId) as JobRow;
    endFire(h.db, { fireId: fire(now, now.nextRunAt ?? 0), outcome: 'nothing', message: false }, NOW);
    expect(getFire(h.db, first)).toBeUndefined();
    expect(count('sessions', 'id = ?', session)).toBe(0);
  });

  it('keeps the session of a pruned or purged fire that is still bound, and drops only its row', () => {
    const job = newJob(h.db);
    const id = fire(job, job.nextRunAt ?? 0);
    const session = fireSession(job.jobId, id);
    // Bound again on the cron channel, not yet archived.
    bindSession(h.db, { channel: 'cron', appId: 'cli_app', conversationId: job.jobId, threadId: String(id) }, session, NOW + 2);
    endFire(h.db, { fireId: id, outcome: 'posted', message: false }, NOW);
    removeJob(h.db, job.jobId, NOW);
    expect(purgeRemoved(h.db)).toEqual([job.jobId]);
    expect(getFire(h.db, id)).toBeUndefined();
    expect(count('sessions', 'id = ?', session)).toBe(1);
  });
});

describe("the delete of a cron fire's session, and the foreign keys on sessions", () => {
  /** Every TypeScript file under src, by its path from the repository, with its comments taken out. */
  function sources(dir = 'src'): Array<[string, string]> {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e): Array<[string, string]> => {
      const path = join(dir, e.name);
      if (e.isDirectory()) return sources(path);
      if (!e.name.endsWith('.ts')) return [];
      // Its code only: a comment may name a column it does not write.
      return [[path, readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')]];
    });
  }

  it('has nothing that writes parent_session_id, fork_of_session_id, workspaces.lock_holder, or a kanban run\'s session but the dispatcher', () => {
    const all = sources();
    for (const column of ['parent_session_id', 'fork_of_session_id', 'lock_holder']) {
      expect(all.filter(([, text]) => text.includes(column)).map(([path]) => path), column).toEqual([]);
    }
    expect(all.filter(([, text]) => /(UPDATE|INSERT INTO)\s+kanban_runs\b[^`']*\bsession_id\b/.test(text)).map(([path]) => path)).toEqual([join('src', 'db', 'kanban.ts')]);
    // A run's session is attached by the dispatcher alone, through the service, to the session it made for the run on the kanban channel.
    expect(all.filter(([, text]) => /\.attachSession\(/.test(text)).map(([path]) => path).sort()).toEqual([join('src', 'kanban', 'dispatcher.ts'), join('src', 'kanban', 'service.ts')]);
  });

  it("deletes a pruned fire's session under the foreign keys, none of them naming it", () => {
    expect(h.db.pragma('foreign_keys', { simple: true })).toBe(1);
    const job = newJob(h.db);
    const id = fire(job, job.nextRunAt ?? 0);
    const session = fireSession(job.jobId, id);
    endFire(h.db, { fireId: id, outcome: 'nothing', message: false }, NOW);
    removeJob(h.db, job.jobId, NOW);
    expect(purgeRemoved(h.db)).toEqual([job.jobId]);
    expect(count('sessions', 'id = ?', session)).toBe(0);
  });
});

describe('interruptOpenFires and the stamps', () => {
  it('ends every open fire interrupted, to be said only for a job with a delivery, not removed, with no failure counted', () => {
    const told = newJob(h.db);
    const silent = newJob(h.db, { delivery: null });
    const gone = newJob(h.db);
    const ids = [told, silent, gone].map((j) => fire(j, j.nextRunAt ?? 0, 5));
    removeJob(h.db, gone.jobId, NOW);
    const ended = interruptOpenFires(h.db, NOW);
    expect(ended.map((f) => [f.fireId, f.outcome, f.delivery])).toEqual([
      [ids[0], 'interrupted', 'pending'],
      [ids[1], 'interrupted', 'none'],
      [ids[2], 'interrupted', 'none'],
    ]);
    expect(getJob(h.db, told.jobId)?.failures).toBe(0);
    expect(runningFire(h.db, told.jobId)).toBeUndefined();
  });

  it('drops the stamps older than it is told', () => {
    const old = newJob(h.db);
    const fresh = newJob(h.db);
    requestRun(h.db, old.jobId, NOW - 2 * HOUR);
    requestRun(h.db, fresh.jobId, NOW);
    expect(dropStaleStamps(h.db, NOW - HOUR, NOW).map((j) => j.jobId)).toEqual([old.jobId]);
    expect(getJob(h.db, fresh.jobId)?.runRequestedAt).toBe(NOW);
  });
});

describe('purgeRemoved', () => {
  it('spares a job with a running fire, or one it is told to keep, and deletes the rest with their fires and sessions', () => {
    const running = newJob(h.db);
    const kept = newJob(h.db);
    const done = newJob(h.db);
    fire(running, running.nextRunAt ?? 0);
    const id = fire(done, done.nextRunAt ?? 0);
    const session = fireSession(done.jobId, id);
    endFire(h.db, { fireId: id, outcome: 'posted', message: false }, NOW);
    for (const j of [running, kept, done]) removeJob(h.db, j.jobId, NOW);
    expect(purgeRemoved(h.db, (jobId) => jobId === kept.jobId)).toEqual([done.jobId]);
    expect(getJob(h.db, done.jobId)).toBeUndefined();
    expect(count('cron_fires', 'job_id = ?', done.jobId)).toBe(0);
    expect(count('sessions', 'id = ?', session)).toBe(0);
    expect(getJob(h.db, running.jobId)?.state).toBe('removed');
  });

  it("leaves a fire's session that has a binding on another channel, and drops only the fire's row, and never a chat's session", () => {
    const job = newJob(h.db);
    const id = fire(job, job.nextRunAt ?? 0);
    const session = fireSession(job.jobId, id, { also: 'lark' });
    createSession(h.db, { id: 's_chat', agentId: 'default', workspaceId: 'default', ownerPrincipal: 'on_alice' }, NOW);
    endFire(h.db, { fireId: id, outcome: 'posted', message: false }, NOW);
    removeJob(h.db, job.jobId, NOW);
    expect(purgeRemoved(h.db)).toEqual([job.jobId]);
    expect(count('cron_fires', 'fire_id = ?', id)).toBe(0);
    expect(count('sessions', 'id = ?', session)).toBe(1);
    expect(count('events', 'session_id = ?', session)).toBe(1);
    expect(count('sessions', "id = 's_chat'")).toBe(1);
  });
});

describe('dueJobs, and the ids', () => {
  it('lists the active jobs due, oldest first', () => {
    const later = newJob(h.db, { nextRunAt: NOW + 2 * HOUR });
    const sooner = newJob(h.db, { nextRunAt: NOW + HOUR });
    newJob(h.db, { nextRunAt: NOW + 5 * HOUR });
    expect(dueJobs(h.db, NOW + 3 * HOUR).map((j) => j.jobId)).toEqual([sooner.jobId, later.jobId]);
  });

  it('makes c_ ids, and a uuid of fifty characters derived from the fire and its part', () => {
    expect(newCronJobId()).toMatch(/^c_[0-9a-hjkmnp-tv-z]{12}$/);
    const u = cronUuid('cli_app', 'c_1', 7, 0);
    expect(u).toMatch(/^[0-9a-f]{50}$/);
    expect(cronUuid('cli_app', 'c_1', 7, 0)).toBe(u);
    expect(new Set([u, cronUuid('cli_app', 'c_1', 7, 1), cronUuid('cli_app', 'c_1', 8, 0), cronUuid('other', 'c_1', 7, 0)]).size).toBe(4);
  });
});
