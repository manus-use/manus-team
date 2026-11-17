import { afterEach, describe, expect, it } from 'vitest';
import { cronUuid } from '../src/core/ids.js';
import { bindingsOnChannel } from '../src/db/bindings.js';
import { endFire, firesOf, getFire, getJob, removeJob, requestRun, runningFire, startFire, type JobRow } from '../src/db/cron.js';
import { getSession } from '../src/db/sessions.js';
import { clearSecrets } from '../src/secrets.js';
import { NOW, answers, cronHarness, holdsTurn, type CronHarness } from './helpers/cron.js';
import { role } from './helpers/dispatch.js';

/**
 * The scheduler's tick (the cron spec, §4), with a fake clock, a fake driver
 * and the fake chat: what is due fired, late within half a period fired, past
 * it skipped as one row, max_running holding a job, a running fire's slot
 * skipped, stamps fired or waiting, a removed job's fire stopped once, the boot
 * of §4.4, and delivery from the record and the log.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const open: CronHarness[] = [];

afterEach(() => {
  clearSecrets();
  while (open.length > 0) open.pop()?.close();
});

function harness(...args: Parameters<typeof cronHarness>): CronHarness {
  const h = cronHarness(...args);
  open.push(h);
  return h;
}

const job = (h: CronHarness, id: string): JobRow => getJob(h.t.db, id) as JobRow;

describe('a due job', () => {
  it('fires into a session of its role, posts the header and the answer once, and archives the session', async () => {
    const h = harness();
    const j = h.add();
    answers(h.driver, 'Two open: ', '#12 and #14.');
    h.clock.advance(HOUR + 3 * MIN);
    await h.tick();
    await h.scheduler.idle();
    const [fire] = firesOf(h.t.db, j.jobId);
    expect(fire).toMatchObject({ trigger: 'schedule', scheduledAt: NOW + HOUR, outcome: 'posted', result: 'Two open: #12 and #14.', delivery: 'sent' });
    expect(h.lark.texts).toEqual([
      { target: { chatId: 'oc_team', threadId: '' }, text: '**Daily PRs** · 2026-11-17 10:00 Asia/Shanghai · 0s\nTwo open: #12 and #14.', uuid: cronUuid('cli_app', j.jobId, fire?.fireId ?? 0, 0) },
    ]);
    // The next slot after now, on the grid.
    expect(job(h, j.jobId).nextRunAt).toBe(NOW + 2 * HOUR);
    const session = getSession(h.t.db, fire?.sessionId ?? '');
    expect(session).toMatchObject({ state: 'archived', ownerPrincipal: 'cron', agentId: 'worker' });
    expect(h.archives).toEqual([String(fire?.fireId)]);
    expect(h.driver.runtimes[0]?.prompts[0]?.text).toMatch(/^This is a scheduled job, \*Daily PRs\*/);
    expect(bindingsOnChannel(h.t.db, 'cron', 'cli_app')).toEqual([]);
  });

  it('posts nothing for [nothing to report], and a line for a failed agent', async () => {
    const h = harness();
    const quiet = h.add();
    answers(h.driver, ' \n[nothing to report]\n');
    h.clock.advance(HOUR);
    await h.tick();
    await h.scheduler.idle();
    expect(firesOf(h.t.db, quiet.jobId)[0]).toMatchObject({ outcome: 'nothing', delivery: 'none' });
    expect(h.lark.texts).toEqual([]);
    h.driver.scripts.push((ctl) => {
      ctl.emit({ kind: 'error', message: 'Error: 429 Too Many Requests', retryable: false } as never);
      ctl.end('failed');
    });
    h.clock.advance(HOUR);
    await h.tick();
    await h.scheduler.idle();
    expect(firesOf(h.t.db, quiet.jobId)[0]).toMatchObject({ outcome: 'agent_failed', delivery: 'sent' });
    expect(h.lark.texts.map((t) => t.text)).toEqual([expect.stringMatching(/^\*\*Daily PRs\*\* · 2026-11-17 11:00 Asia\/Shanghai: the agent failed: /)]);
    expect(job(h, quiet.jobId).failures).toBe(1);
  });

  it('fires a slot late within half its period, and skips one past it as one row for many slots', async () => {
    const h = harness();
    const j = h.add();
    h.clock.advance(HOUR + 29 * MIN);
    await h.tick();
    await h.scheduler.idle();
    expect(firesOf(h.t.db, j.jobId).map((f) => f.outcome)).toEqual(['posted']);
    // Down for a day, and the newest slot too late as well: one skip, from the first slot missed, saying how many.
    h.clock.advance(24 * HOUR + 2 * MIN);
    await h.tick();
    await h.scheduler.idle();
    const [skip] = firesOf(h.t.db, j.jobId);
    expect(skip).toMatchObject({ outcome: 'skipped_missed', scheduledAt: NOW + 2 * HOUR, error: '24 slots missed', startedAt: null, delivery: 'none' });
    expect(job(h, j.jobId).nextRunAt).toBe(NOW + 26 * HOUR);
    expect(h.notes.some((n) => n.startsWith(`cron: job ${j.jobId} skipped its slot`) && n.endsWith('24 slots missed'))).toBe(true);
  });

  it('fires the newest slot of an hourly job down for hours if it is fresh, the ones before it one skip', async () => {
    const h = harness();
    const j = h.add();
    // Down from 09:00 to 15:20: 10:00 to 14:00 missed, 15:00 late by 20 minutes, within half the hour.
    h.clock.advance(6 * HOUR + 20 * MIN);
    await h.tick();
    await h.scheduler.idle();
    const [fired, skip] = firesOf(h.t.db, j.jobId);
    expect(skip).toMatchObject({ outcome: 'skipped_missed', scheduledAt: NOW + HOUR, error: '5 slots missed', startedAt: null, delivery: 'none' });
    expect(fired).toMatchObject({ outcome: 'posted', scheduledAt: NOW + 6 * HOUR, trigger: 'schedule' });
    expect(job(h, j.jobId).nextRunAt).toBe(NOW + 7 * HOUR);
    expect(h.lark.texts).toHaveLength(1);
    expect(h.notes.some((n) => n.startsWith(`cron: job ${j.jobId} skipped its slot`) && n.endsWith('5 slots missed'))).toBe(true);
  });

  it("fires today's daily brief after a downtime that took yesterday's, which is recorded missed", async () => {
    const h = harness();
    // Asia/Shanghai: down from Nov 17 09:00 to Nov 18 10:10.
    const j = h.add({ schedule: 'every day 10:00' });
    h.clock.advance(25 * HOUR + 10 * MIN);
    await h.tick();
    await h.scheduler.idle();
    const [fired, skip] = firesOf(h.t.db, j.jobId);
    expect(skip).toMatchObject({ outcome: 'skipped_missed', scheduledAt: NOW + HOUR, error: '1 slot missed' });
    expect(fired).toMatchObject({ outcome: 'posted', scheduledAt: NOW + 25 * HOUR });
    expect(h.lark.texts.map((t) => t.text)).toEqual([expect.stringMatching(/^\*\*Daily PRs\*\* · 2026-11-18 10:00 Asia\/Shanghai/)]);
    expect(job(h, j.jobId).nextRunAt).toBe(NOW + 49 * HOUR);
  });

  it('gives a one-off an hour: fired within it and done, skipped past it and done', async () => {
    const h = harness();
    const late = h.add({ schedule: 'in 30m' });
    const fine = h.add({ schedule: 'in 40m' });
    // Late by 65 and 55 minutes: a one-off is fired up to an hour late.
    h.clock.advance(95 * MIN);
    await h.tick();
    await h.scheduler.idle();
    expect(firesOf(h.t.db, late.jobId).map((f) => f.outcome)).toEqual(['skipped_missed']);
    expect(firesOf(h.t.db, fine.jobId).map((f) => f.outcome)).toEqual(['posted']);
    expect([job(h, late.jobId).state, job(h, fine.jobId).state]).toEqual(['done', 'done']);
  });

  it('holds a job at max_running, and skips it as late once it is held too long', async () => {
    const h = harness({ settings: { maxRunning: 1 } });
    const first = h.add({ schedule: 'every 2h' });
    h.clock.advance(MIN);
    const second = h.add({ schedule: 'every 2h' });
    const held = holdsTurn(h.driver);
    h.clock.advance(2 * HOUR);
    await h.tick();
    expect(held.started).toBe(true);
    expect(firesOf(h.t.db, first.jobId)).toHaveLength(1);
    // The first is running; the second waits, its next run unchanged.
    expect(firesOf(h.t.db, second.jobId)).toEqual([]);
    expect(job(h, second.jobId).nextRunAt).toBe(NOW + 2 * HOUR + MIN);
    h.clock.advance(61 * MIN);
    await h.tick();
    // Held past half its period: skipped, not fired late.
    expect(firesOf(h.t.db, second.jobId).map((f) => f.outcome)).toEqual(['skipped_missed']);
    held.end('completed');
    await h.scheduler.idle();
  });

  it("skips a slot due while the job's previous fire runs, and that fire goes on", async () => {
    const h = harness({ settings: { idleTimeoutS: 3600 } });
    const j = h.add({ schedule: 'every 10m' });
    const held = holdsTurn(h.driver);
    h.clock.advance(10 * MIN);
    await h.tick();
    h.clock.advance(10 * MIN);
    await h.tick();
    expect(firesOf(h.t.db, j.jobId).map((f) => f.outcome)).toEqual(['skipped_running', null]);
    expect(job(h, j.jobId).nextRunAt).toBe(NOW + 30 * MIN);
    held.end('completed');
    await h.scheduler.idle();
    expect(firesOf(h.t.db, j.jobId).map((f) => f.outcome)).toEqual(['skipped_running', 'posted']);
  });
});

describe('a send', () => {
  it('is made once for a fire however many paths ask for it at once', async () => {
    const h = harness();
    const j = h.add();
    const later = cronHarness({ t: h.t, clock: h.clock, roles: [role('other')] });
    h.lark.hold();
    later.lark.hold();
    h.clock.advance(HOUR);
    // The skip sends its line; the ticks and a nudge's tick right after find it pending and in its send.
    later.scheduler.tick();
    later.scheduler.tick();
    later.scheduler.tick();
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
    later.lark.release();
    await later.scheduler.idle();
    later.scheduler.stop();
    expect(later.lark.texts.map((t) => t.text)).toEqual(['**Daily PRs** · 2026-11-17 10:00 Asia/Shanghai: skipped: role worker is not configured']);
    expect(firesOf(h.t.db, j.jobId)[0]?.delivery).toBe('sent');
    h.lark.release();
  });

  it('under way when the gateway stops is left pending, and the next boot sends it with the same uuids', async () => {
    const first = harness();
    const j = first.add();
    answers(first.driver, 'Two open.');
    first.lark.hold();
    first.clock.advance(HOUR);
    await first.tick();
    for (let i = 0; i < 20 && first.lark.texts.length === 0; i += 1) await new Promise((r) => setImmediate(r));
    expect(first.lark.calls).toContain('sendText');
    // Stopped mid-send: the adapter's disconnect fails the send.
    first.scheduler.stop();
    first.lark.failNext('sendText', new Error('the connection is closed'));
    first.lark.release();
    await first.scheduler.idle();
    const fire = firesOf(first.t.db, j.jobId)[0];
    expect(fire).toMatchObject({ outcome: 'posted', delivery: 'pending' });

    const second = harness({ t: first.t, clock: first.clock });
    open.splice(open.indexOf(first), 1);
    await second.scheduler.boot();
    second.scheduler.start();
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
    await second.scheduler.idle();
    second.scheduler.stop();
    expect(second.lark.texts).toEqual([
      { target: { chatId: 'oc_team', threadId: '' }, text: expect.stringMatching(/Two open\.$/), uuid: cronUuid('cli_app', j.jobId, fire?.fireId ?? 0, 0) },
    ]);
    expect(getFire(second.t.db, fire?.fireId ?? 0)?.delivery).toBe('sent');
  });
});

describe('a stamp', () => {
  it('fires a paused job once, as run now, leaving it paused; one meeting a running fire waits', async () => {
    const h = harness();
    const j = h.add();
    h.service.pause(j.jobId);
    expect(h.service.run(j.jobId).ok).toBe(true);
    answers(h.driver, 'ran');
    await h.tick();
    await h.scheduler.idle();
    expect(firesOf(h.t.db, j.jobId)[0]).toMatchObject({ trigger: 'run', outcome: 'posted' });
    expect(h.lark.texts[0]?.text).toMatch(/^\*\*Daily PRs\*\* · run now · 0s\nran$/);
    expect(job(h, j.jobId)).toMatchObject({ state: 'paused', runRequestedAt: null });

    const other = h.add();
    const held = holdsTurn(h.driver);
    h.clock.advance(HOUR);
    await h.tick();
    expect(held.started).toBe(true);
    h.t.db.prepare('UPDATE cron_jobs SET run_requested_at = ? WHERE job_id = ?').run(h.clock.now(), other.jobId);
    await h.tick();
    expect(firesOf(h.t.db, other.jobId)).toHaveLength(1);
    held.end('completed');
    await h.scheduler.idle();
    await h.tick();
    await h.scheduler.idle();
    expect(firesOf(h.t.db, other.jobId).map((f) => f.trigger)).toEqual(['run', 'schedule']);
  });
});

describe('a removal', () => {
  it("cancels the turn and archives at once, ends the fire once, interrupted, after that archive, and purges the job after", async () => {
    const h = harness();
    const j = h.add();
    const held = holdsTurn(h.driver);
    h.clock.advance(HOUR);
    await h.tick();
    expect(held.started).toBe(true);
    const fireId = runningFire(h.t.db, j.jobId)?.fireId ?? 0;
    removeJob(h.t.db, j.jobId, h.clock.now());
    // The release in the archive closes the actor; the fake's close ends the turn.
    h.driver.onClose = () => held.end('cancelled');
    await h.tick();
    await h.scheduler.idle();
    expect(h.driver.runtimes[0]?.cancels).toBe(1);
    expect(h.archives).toEqual([String(fireId)]);
    expect(h.lark.texts).toEqual([]);
    expect(getFire(h.t.db, fireId)).toMatchObject({ outcome: 'interrupted', error: 'the job was removed', delivery: 'none' });
    // Purged by the next tick, once the fire left the in-flight set.
    await h.tick();
    expect(getJob(h.t.db, j.jobId)).toBeUndefined();
    expect(getFire(h.t.db, fireId)).toBeUndefined();
  });

  it('leaves no actor live for a fire removed while its actor was being made', async () => {
    const h = harness();
    const j = h.add();
    const actorFor = h.registry.actorFor.bind(h.registry);
    let go = (): void => undefined;
    const gate = new Promise<void>((resolve) => (go = resolve));
    h.registry.actorFor = async (sessionId, key) => {
      await gate;
      return actorFor(sessionId, key);
    };
    h.clock.advance(HOUR);
    await h.tick();
    const fire = runningFire(h.t.db, j.jobId);
    const sessionId = fire?.sessionId ?? '';
    expect(sessionId).not.toBe('');
    removeJob(h.t.db, j.jobId, h.clock.now());
    await h.tick();
    await h.scheduler.idle();
    expect(getFire(h.t.db, fire?.fireId ?? 0)).toMatchObject({ outcome: 'interrupted' });
    go();
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
    expect(h.registry.liveActor(sessionId)).toBeUndefined();
    expect(h.driver.starts).toEqual([]);
  });

  it('ends the fire interrupted even when its archive is rejected, and lets it leave the in-flight set', async () => {
    const h = harness();
    const j = h.add();
    const held = holdsTurn(h.driver);
    h.clock.advance(HOUR);
    await h.tick();
    const fireId = runningFire(h.t.db, j.jobId)?.fireId ?? 0;
    h.t.db.prepare("UPDATE cron_jobs SET state = 'removed', next_run_at = NULL WHERE job_id = ?").run(j.jobId);
    h.failNextArchive();
    await h.tick();
    await h.scheduler.idle();
    held.end('cancelled');
    expect(h.scheduler.inFlight(j.jobId)).toBe(false);
    expect(h.notes).toContain(`cron: archiving the session of fire ${fireId} failed; ending the fire anyway`);
  });
});

describe('a restart', () => {
  it("ends the open fires interrupted at boot, told in their chat once, archives leftover cron bindings, and drops stamps over an hour old", async () => {
    const first = harness();
    const j = first.add();
    const stale = first.add({ schedule: 'every 6h' });
    const held = holdsTurn(first.driver);
    first.clock.advance(HOUR);
    await first.tick();
    expect(held.started).toBe(true);
    // Stopped mid-turn: the turn the close ends is not taken for the agent's failure.
    first.scheduler.stop();
    await first.registry.closeAll();
    held.end('failed');
    await first.scheduler.idle(1000);
    const fire = firesOf(first.t.db, j.jobId)[0];
    expect(fire).toMatchObject({ endedAt: null, outcome: null });
    requestRun(first.t.db, stale.jobId, first.clock.now());

    first.clock.advance(2 * HOUR);
    const second = harness({ t: first.t, clock: first.clock });
    open.splice(open.indexOf(first), 1);
    await second.scheduler.boot();
    expect(getFire(second.t.db, fire?.fireId ?? 0)).toMatchObject({ outcome: 'interrupted', delivery: 'pending' });
    expect(job(second, j.jobId).failures).toBe(0);
    expect(bindingsOnChannel(second.t.db, 'cron', 'cli_app')).toEqual([]);
    expect(job(second, stale.jobId).runRequestedAt).toBeNull();
    expect(second.notes).toContain(`cron: a run of job ${stale.jobId} asked for while the gateway was down was dropped`);
    second.scheduler.start();
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
    await second.scheduler.idle();
    const told = second.lark.texts.filter((t) => t.text.includes('interrupted by a gateway restart'));
    // 11:00 is too late at 12:00, and 12:00 is fresh: this tick fires it, so the line names it.
    expect(told).toEqual([
      {
        target: { chatId: 'oc_team', threadId: '' },
        text: `**Daily PRs** · 2026-11-17 10:00 Asia/Shanghai: interrupted by a gateway restart; it runs again at ${'2026-11-17 12:00'}`,
        uuid: cronUuid('cli_app', j.jobId, fire?.fireId ?? 0, 0),
      },
    ]);
  });

  it("deletes at boot the session of a removed job's fire whose archive was refused, once the boot has archived it", async () => {
    const first = harness();
    const j = first.add();
    const held = holdsTurn(first.driver);
    first.clock.advance(HOUR);
    await first.tick();
    const fire = runningFire(first.t.db, j.jobId);
    const sessionId = fire?.sessionId ?? '';
    // The archive refused before it revoked anything: the session stays bound on the cron channel.
    const archive = first.registry.archive.bind(first.registry);
    first.registry.archive = async () => {
      first.registry.archive = archive;
      throw new Error('the agent would not close');
    };
    removeJob(first.t.db, j.jobId, first.clock.now());
    await first.tick();
    await first.scheduler.idle();
    await first.tick();
    expect(getJob(first.t.db, j.jobId)).toBeUndefined();
    expect(getSession(first.t.db, sessionId)).toBeDefined();
    first.scheduler.stop();
    await first.registry.closeAll();
    held.end('cancelled');

    const second = harness({ t: first.t, clock: first.clock });
    open.splice(open.indexOf(first), 1);
    await second.scheduler.boot();
    expect(bindingsOnChannel(second.t.db, 'cron', 'cli_app')).toEqual([]);
    expect(getSession(second.t.db, sessionId)).toBeUndefined();
    for (const table of ['events', 'turns', 'channel_bindings']) {
      expect(second.t.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionId)).toEqual({ n: 0 });
    }
  });

  it("keeps at boot the session of a fire still recorded, for its history and its send", async () => {
    const first = harness();
    const j = first.add();
    const held = holdsTurn(first.driver);
    first.clock.advance(HOUR);
    await first.tick();
    const sessionId = runningFire(first.t.db, j.jobId)?.sessionId ?? '';
    first.scheduler.stop();
    await first.registry.closeAll();
    held.end('failed');
    const second = harness({ t: first.t, clock: first.clock });
    open.splice(open.indexOf(first), 1);
    await second.scheduler.boot();
    expect(bindingsOnChannel(second.t.db, 'cron', 'cli_app')).toEqual([]);
    expect(getSession(second.t.db, sessionId)).toMatchObject({ state: 'archived' });
  });

  it('sends a pending answer again from the session log, the same parts with the same uuids, 20,000 characters included', async () => {
    const h = harness();
    const j = h.add();
    const long = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, '0')} ${'z'.repeat(95)}`).join('\n');
    answers(h.driver, long);
    h.clock.advance(HOUR);
    await h.tick();
    await h.scheduler.idle();
    const fire = firesOf(h.t.db, j.jobId)[0];
    const sent = h.lark.texts.map((t) => ({ text: t.text, uuid: t.uuid }));
    expect(sent.length).toBe(6);
    expect((fire?.result ?? '').length).toBeLessThan(long.length);
    // As if the gateway stopped between the send and its mark.
    h.t.db.prepare("UPDATE cron_fires SET delivery = 'pending' WHERE fire_id = ?").run(fire?.fireId);
    await h.tick();
    await h.scheduler.idle();
    expect(h.lark.texts.slice(sent.length).map((t) => ({ text: t.text, uuid: t.uuid }))).toEqual(sent);
  });

  it("sends no pending delivery of a fire still in flight beside its own send", async () => {
    const h = harness();
    const j = h.add();
    h.lark.hold();
    answers(h.driver, 'once');
    h.clock.advance(HOUR);
    await h.tick();
    await h.tick();
    h.lark.release();
    await h.scheduler.idle();
    expect(h.lark.texts.map((t) => t.text)).toEqual([expect.stringMatching(/once$/)]);
    expect(firesOf(h.t.db, j.jobId)[0]?.delivery).toBe('sent');
  });
});

describe('an unavailable role', () => {
  it('skips each fire with one line, and pauses the job after three in a row with the resume hint', async () => {
    const h = harness();
    const j = h.add();
    const later = cronHarness({ t: h.t, clock: h.clock, roles: [role('other')] });
    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(HOUR);
      await later.tick();
      await later.scheduler.idle();
    }
    later.scheduler.stop();
    expect(firesOf(h.t.db, j.jobId).map((f) => f.outcome)).toEqual(['skipped_unavailable', 'skipped_unavailable', 'skipped_unavailable']);
    expect(job(h, j.jobId)).toMatchObject({ state: 'paused', failures: 3 });
    expect(later.lark.texts.map((t) => t.text)).toEqual([
      '**Daily PRs** · 2026-11-17 10:00 Asia/Shanghai: skipped: role worker is not configured',
      '**Daily PRs** · 2026-11-17 11:00 Asia/Shanghai: skipped: role worker is not configured',
      `**Daily PRs** · 2026-11-17 12:00 Asia/Shanghai: skipped: role worker is not configured\nPaused after 3 failures in a row. \`/cron resume ${j.jobId}\` in this chat, or \`mt cron resume ${j.jobId}\`, starts it again.`,
    ]);
  });
});

describe('a schedule that cannot be read', () => {
  it('is noted once for its job however many ticks find it due, and fires nothing', async () => {
    const h = harness();
    const j = h.add();
    h.t.db.prepare("UPDATE cron_jobs SET schedule = 'every now and then' WHERE job_id = ?").run(j.jobId);
    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(HOUR);
      await h.tick();
    }
    expect(h.notes.filter((n) => n.startsWith(`cron: job ${j.jobId}'s schedule cannot be read`))).toHaveLength(1);
    expect(firesOf(h.t.db, j.jobId)).toEqual([]);
  });
});

describe('the writer under the scheduler', () => {
  it('never starts a second fire of a job beside one the scheduler started', async () => {
    const h = harness();
    const j = h.add();
    const held = holdsTurn(h.driver);
    h.clock.advance(HOUR);
    await h.tick();
    const at = job(h, j.jobId).nextRunAt ?? 0;
    expect(startFire(h.t.db, { jobId: j.jobId, trigger: 'schedule', slot: at, schedule: j.schedule, tz: j.tz, next: at + HOUR, scheduledAt: at, maxRunning: 5 }, at)).toMatchObject({
      ok: false,
      code: 'running',
    });
    held.end('completed');
    await h.scheduler.idle();
    expect(endFire(h.t.db, { fireId: firesOf(h.t.db, j.jobId)[0]?.fireId ?? 0, outcome: 'posted', message: false }, NOW).ok).toBe(false);
  });
});
