import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getJob, runningFire, startFire } from '../src/db/cron.js';
import { CronService, defaultName } from '../src/cron/service.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { NOW, TEAM } from './helpers/cron.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';

/**
 * CronService (the cron spec, §2, §6, §8, §9): each change checked against the
 * schedule, the zone, the team, the limits and the script, and scoped to a chat
 * or a creator.
 */

let h: TestDb;
let clock: ManualClock;
let service: CronService;

beforeEach(() => {
  clearSecrets();
  h = testDb();
  clock = new ManualClock(NOW);
  const roles = new Map([
    ['worker', role('worker')],
    ['docs', role('docs', { workspace: 'docs' })],
    ['careful', role('careful', { agent: { ...role('careful').agent, unsupervised: false } })],
  ]);
  service = new CronService({ db: h.db, roles, workspaces: new Set(['default', 'docs']), zone: 'Asia/Shanghai', clock });
});
afterEach(() => {
  clearSecrets();
  h.close();
});

const base = { schedule: 'every weekday 09:00', role: 'worker', prompt: 'List the open PRs.', delivery: TEAM, createdBy: 'lark:on_alice', createdVia: { kind: 'operator' } };

function added(extra: Partial<Parameters<CronService['add']>[0]> = {}) {
  const r = service.add({ ...base, ...extra });
  if (!r.ok) throw new Error(r.message);
  return r.job;
}

describe('CronService.add', () => {
  it("stores the gateway's zone, the role's workspace, a default name, and the next run", () => {
    // 2026-11-17 is a Tuesday; 09:00 in Shanghai is 01:00Z, now: the next is tomorrow's.
    const job = added();
    expect(job).toMatchObject({ tz: 'Asia/Shanghai', workspace: 'default', name: 'List the open PRs.', state: 'active', nextRunAt: Date.UTC(2026, 10, 18, 1) });
    expect(added({ role: 'docs' }).workspace).toBe('docs');
    expect(added({ tz: 'utc' }).tz).toBe('UTC');
    expect(defaultName(`\n  ${'x'.repeat(60)}\nmore`)).toBe(`${'x'.repeat(47)}…`);
  });

  it('refuses a schedule, a zone, a role, a workspace, sizes and a script it cannot take, saying why', () => {
    const no = (extra: Partial<Parameters<CronService['add']>[0]>) => service.add({ ...base, ...extra });
    expect(no({ schedule: 'every 2m' })).toMatchObject({ ok: false, code: 'invalid', message: "every 2m is under 5 minutes, and a schedule's period is at least 5 minutes" });
    expect(no({ schedule: '2026-11-16 09:00' })).toMatchObject({ ok: false, message: '2026-11-16 09:00 is in the past' });
    expect(no({ tz: 'Nowhere/City' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(no({ role: 'ghost' })).toMatchObject({ ok: false, code: 'unavailable', message: 'role ghost is not configured' });
    expect(no({ role: 'careful' })).toMatchObject({ ok: false, code: 'unavailable', message: expect.stringMatching(/^role careful is not unsupervised/) });
    expect(no({ workspace: 'web' })).toMatchObject({ ok: false, message: 'workspace web is not configured' });
    expect(no({ prompt: 'x'.repeat(8193) })).toMatchObject({ ok: false, code: 'too_large' });
    expect(no({ prompt: '  ' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(no({ name: 'a\nb' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(no({ name: 'n'.repeat(101) })).toMatchObject({ ok: false, code: 'too_large' });
    expect(no({ script: 's'.repeat(4097) })).toMatchObject({ ok: false, code: 'too_large' });
    addSecrets(['sk-live-1234567890']);
    for (const script of ['echo sk-live-1234567890', "echo 'sk-live-''1234567890'", `echo ${MASK}`]) {
      expect(no({ script })).toMatchObject({ ok: false, code: 'invalid' });
    }
  });

  it('answers a repeated key with its job', () => {
    const a = added({ idempotencyKey: 'lark:om_1' });
    expect(service.add({ ...base, idempotencyKey: 'lark:om_1', prompt: 'Other.' })).toMatchObject({ ok: true, existing: true, job: { jobId: a.jobId } });
  });
});

describe('CronService: scope, states and edits', () => {
  it("answers another chat's job as unknown, and another creator's as not yours", () => {
    const job = added();
    expect(service.show(job.jobId, { chat: { channel: 'lark', account: 'cli_app', chat: 'oc_other' } })).toEqual({
      ok: false,
      code: 'not_found',
      message: `there is no cron job ${job.jobId}`,
    });
    expect(service.show(job.jobId, { chat: { channel: 'lark', account: 'cli_app', chat: 'oc_team' } }).ok).toBe(true);
    expect(service.pause(job.jobId, { own: 'session:s_1' })).toMatchObject({ ok: false, code: 'not_yours' });
    expect(service.list({ channel: 'lark', account: 'cli_app', chat: 'oc_other' })).toEqual([]);
  });

  it('resumes from now, checking the role again, and refuses a run while a fire runs, saying when it started', () => {
    const job = added({ schedule: 'every 2h' });
    service.pause(job.jobId);
    clock.advance(17 * 60_000);
    expect(service.resume(job.jobId)).toMatchObject({ ok: true, job: { nextRunAt: NOW + 17 * 60_000 + 2 * 3_600_000 } });
    const at = getJob(h.db, job.jobId)?.nextRunAt ?? 0;
    startFire(h.db, { jobId: job.jobId, trigger: 'schedule', slot: at, schedule: job.schedule, tz: job.tz, next: at + 7_200_000, scheduledAt: at, maxRunning: 2 }, at);
    expect(runningFire(h.db, job.jobId)).toBeDefined();
    expect(service.run(job.jobId)).toEqual({ ok: false, code: 'running', message: `a fire of ${job.jobId} is running; it started at 11:17` });
  });

  it('moves the next run for an edit of the schedule or the zone, and leaves it for any other', () => {
    const job = added({ schedule: 'every 2h' });
    clock.advance(60 * 60_000);
    expect(service.edit(job.jobId, { prompt: 'Other.' })).toMatchObject({ ok: true, job: { nextRunAt: job.nextRunAt, prompt: 'Other.' } });
    expect(service.edit(job.jobId, { schedule: 'every 3h' })).toMatchObject({ ok: true, job: { nextRunAt: NOW + 4 * 3_600_000 } });
    expect(service.edit(job.jobId, { tz: 'UTC' })).toMatchObject({ ok: true, job: { tz: 'UTC', nextRunAt: NOW + 4 * 3_600_000 } });
    expect(service.edit(job.jobId, { role: 'careful' })).toMatchObject({ ok: false, code: 'unavailable' });
    expect(service.edit(job.jobId, { script: null, delivery: null })).toMatchObject({ ok: true, job: { script: null, delivery: null } });
  });

  it('refuses a resume of a job whose role was made supervised', () => {
    const job = added();
    service.pause(job.jobId);
    const roles = new Map([['worker', role('worker', { agent: { ...role('worker').agent, unsupervised: false } })]]);
    const later = new CronService({ db: h.db, roles, workspaces: new Set(['default']), zone: 'UTC', clock });
    expect(later.resume(job.jobId)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(later.unavailable('worker', 'default')).toMatch(/^role worker is not unsupervised/);
  });
});
