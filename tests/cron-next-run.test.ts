import { describe, expect, it } from 'vitest';
import {
  MISSED_COUNT_MAX,
  firstRun,
  lateLimit,
  missedSlots,
  nextRun,
  parseSchedule,
  periodAt,
  runAfter,
  toInstant,
  type CronFields,
  type Schedule,
  type SearchStats,
} from '../src/cron/schedule.js';

/**
 * The next run (the cron spec, §2.1, §2.2, §4.3), against fixed instants: New
 * York across 2026-03-08 and 2026-11-01, London, Lord Howe's half-hour change,
 * Kathmandu and UTC.
 */

const NY = 'America/New_York';
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi);

function schedule(text: string): Schedule {
  const r = parseSchedule(text);
  if (!r.ok) throw new Error(r.message);
  return r.schedule;
}

function cron(text: string): CronFields {
  const s = schedule(text);
  if (s.kind !== 'cron') throw new Error(text);
  return s.fields;
}

/** The next `n` runs after `after`. */
function runs(text: string, tz: string, after: number, n: number): number[] {
  const out: number[] = [];
  let at = after;
  for (let i = 0; i < n; i += 1) {
    const next = nextRun(cron(text), tz, at);
    if (next === undefined) break;
    out.push(next);
    at = next;
  }
  return out;
}

describe('toInstant', () => {
  it('maps a wall time once, the earlier of a repeated one, and one in a gap to the change', () => {
    expect(toInstant(NY, { y: 2026, mo: 6, d: 1, h: 9, mi: 0, s: 0 })).toEqual({ instant: utc(2026, 6, 1, 13), gap: false });
    expect(toInstant(NY, { y: 2026, mo: 11, d: 1, h: 1, mi: 30, s: 0 })).toEqual({ instant: utc(2026, 11, 1, 5, 30), gap: false });
    expect(toInstant(NY, { y: 2026, mo: 3, d: 8, h: 2, mi: 30, s: 0 })).toEqual({ instant: utc(2026, 3, 8, 7), gap: true });
    expect(toInstant('Australia/Lord_Howe', { y: 2026, mo: 10, d: 4, h: 2, mi: 15, s: 0 })).toEqual({ instant: utc(2026, 10, 3, 15, 30), gap: true });
  });
});

describe('nextRun across daylight saving time', () => {
  it('fires a slot in the gap at the change, once', () => {
    expect(runs('30 2 * * *', NY, utc(2026, 3, 7, 12), 2)).toEqual([utc(2026, 3, 8, 7), utc(2026, 3, 9, 6, 30)]);
    // Every five minutes: once at the change for the twelve slots in the gap.
    expect(runs('*/5 * * * *', NY, utc(2026, 3, 8, 6, 58), 3)).toEqual([utc(2026, 3, 8, 7), utc(2026, 3, 8, 7, 5), utc(2026, 3, 8, 7, 10)]);
  });

  it('fires each minute of the repeated hour once', () => {
    expect(runs('30 1 * * *', NY, utc(2026, 11, 1, 4), 2)).toEqual([utc(2026, 11, 1, 5, 30), utc(2026, 11, 2, 6, 30)]);
    expect(runs('*/15 * * * *', NY, utc(2026, 11, 1, 4, 59), 5)).toEqual([
      utc(2026, 11, 1, 5),
      utc(2026, 11, 1, 5, 15),
      utc(2026, 11, 1, 5, 30),
      utc(2026, 11, 1, 5, 45),
      utc(2026, 11, 1, 7),
    ]);
  });

  it('keeps every day 09:00 on the wall clock, where every 1d keeps its 24 hours', () => {
    const slot = utc(2026, 3, 7, 14);
    expect(runAfter(schedule('every day 09:00'), NY, slot, slot)).toBe(utc(2026, 3, 8, 13));
    expect(runAfter(schedule('every 1d'), NY, slot, slot)).toBe(utc(2026, 3, 8, 14));
  });

  it('follows London, Lord Howe and Kathmandu, and UTC', () => {
    expect(runs('30 1 * * *', 'Europe/London', utc(2026, 3, 28, 12), 2)).toEqual([utc(2026, 3, 29, 1), utc(2026, 3, 30, 0, 30)]);
    expect(runs('30 1 * * *', 'Europe/London', utc(2026, 10, 24, 12), 2)).toEqual([utc(2026, 10, 25, 0, 30), utc(2026, 10, 26, 1, 30)]);
    // Lord Howe goes forward half an hour, from 02:00 to 02:30, and back from 02:00 to 01:30.
    expect(runs('15 2 * * *', 'Australia/Lord_Howe', utc(2026, 10, 3, 0), 2)).toEqual([utc(2026, 10, 3, 15, 30), utc(2026, 10, 4, 15, 15)]);
    expect(runs('45 1 * * *', 'Australia/Lord_Howe', utc(2026, 4, 4, 0), 2)).toEqual([utc(2026, 4, 4, 14, 45), utc(2026, 4, 5, 15, 15)]);
    expect(runs('0 9 * * *', 'Asia/Kathmandu', utc(2026, 11, 17), 1)).toEqual([utc(2026, 11, 17, 3, 15)]);
    expect(runs('0 0 1 1 *', 'UTC', utc(2026, 11, 17), 1)).toEqual([utc(2027, 1, 1)]);
  });
});

describe('nextRun: the day fields', () => {
  it('takes either day when both are restricted, and both when one starts with *', () => {
    // The 13th, or a Friday.
    expect(runs('0 9 13 * 5', 'UTC', utc(2026, 11, 1), 2)).toEqual([utc(2026, 11, 6, 9), utc(2026, 11, 13, 9)]);
    // */2 is unrestricted: Mondays that are odd days of the month, 9 and 23 November.
    expect(runs('0 9 */2 * 1', 'UTC', utc(2026, 11, 1), 2)).toEqual([utc(2026, 11, 9, 9), utc(2026, 11, 23, 9)]);
  });

  it('finds 29 February eight years on, across 2100', () => {
    expect(runs('0 0 29 2 *', 'UTC', utc(2097, 3, 1), 1)).toEqual([utc(2104, 2, 29)]);
  });

  it('walks a day at a time: a schedule that never comes is about 3,000 days, not four million minutes', () => {
    const stats: SearchStats = { days: 0, times: 0 };
    expect(nextRun(cron('0 0 30 2 *'), 'UTC', utc(2026, 11, 17), stats)).toBeUndefined();
    expect(stats.days).toBeGreaterThan(2900);
    expect(stats.days).toBeLessThan(3000);
    expect(stats.times).toBe(0);
  });
});

describe('firstRun', () => {
  const now = utc(2026, 11, 17, 10, 17);

  it("is now plus the period for every and in, and the next slot for a clock time", () => {
    expect(firstRun(schedule('every 2h'), NY, now)).toEqual({ ok: true, at: utc(2026, 11, 17, 12, 17) });
    expect(firstRun(schedule('in 30m'), NY, now)).toEqual({ ok: true, at: utc(2026, 11, 17, 10, 47) });
    expect(firstRun(schedule('every day 09:00'), 'UTC', now)).toEqual({ ok: true, at: utc(2026, 11, 18, 9) });
  });

  it('refuses a schedule that never comes', () => {
    expect(firstRun(schedule('0 0 30 2 *'), 'UTC', now)).toEqual({ ok: false, message: '0 0 30 2 * never comes: it has no time in the next 8 years' });
  });

  it('refuses a one-off in the past or more than 365 days ahead, and a wall time the clocks skip', () => {
    expect(firstRun(schedule('2026-11-17T09:00Z'), 'UTC', now)).toEqual({ ok: false, message: '2026-11-17T09:00Z is in the past' });
    expect(firstRun(schedule('2027-12-01 09:00'), 'UTC', now)).toEqual({ ok: false, message: '2027-12-01 09:00 is more than 365 days ahead' });
    expect(firstRun(schedule('2027-03-14 02:30'), NY, now)).toEqual({
      ok: false,
      message: '2027-03-14 02:30 does not happen in America/New_York: the clocks go forward over it',
    });
    expect(firstRun(schedule('2027-11-07 01:30'), NY, now)).toEqual({ ok: true, at: utc(2027, 11, 7, 5, 30) });
    expect(firstRun(schedule('2026-11-18 09:00+08:00'), NY, now)).toEqual({ ok: true, at: utc(2026, 11, 18, 1) });
  });
});

describe('runAfter: a fixed period keeps its grid', () => {
  const s = schedule('every 2h');
  const slot = utc(2026, 11, 17, 12, 17);

  it('fired late, or skipped, the next run is the grid slot after now', () => {
    expect(runAfter(s, 'UTC', slot, utc(2026, 11, 17, 12, 50))).toBe(utc(2026, 11, 17, 14, 17));
    expect(runAfter(s, 'UTC', slot, utc(2026, 11, 17, 16))).toBe(utc(2026, 11, 17, 16, 17));
    expect(runAfter(s, 'UTC', slot, slot)).toBe(utc(2026, 11, 17, 14, 17));
  });

  it('is the next slot after now for a clock time, and none for a one-off', () => {
    expect(runAfter(schedule('0 9 * * *'), 'UTC', utc(2026, 11, 17, 9), utc(2026, 11, 19, 10))).toBe(utc(2026, 11, 20, 9));
    expect(runAfter(schedule('in 30m'), 'UTC', slot, slot)).toBeUndefined();
  });
});

describe('periodAt and missedSlots', () => {
  it('is the period, or the time to the next slot in the zone; a one-off has its grace', () => {
    expect(periodAt(schedule('every 30m'), NY, 0)).toBe(30 * MIN);
    expect(periodAt(schedule('0 9 * * *'), NY, utc(2026, 11, 17, 14))).toBe(DAY);
    // The day the clocks go forward is 23 hours long.
    expect(periodAt(schedule('0 9 * * *'), NY, utc(2026, 3, 7, 14))).toBe(23 * HOUR);
    expect(periodAt(schedule('0 9 * * 1-5'), 'UTC', utc(2026, 11, 20, 9))).toBe(3 * DAY);
    expect(periodAt(schedule('in 30m'), NY, 0)).toBe(HOUR);
  });

  it('lets a slot be half its period late, and a one-off an hour', () => {
    expect(lateLimit(schedule('every 30m'), NY, 0)).toBe(15 * MIN);
    expect(lateLimit(schedule('0 9 * * *'), NY, utc(2026, 11, 17, 14))).toBe(12 * HOUR);
    expect(lateLimit(schedule('in 30m'), NY, 0)).toBe(HOUR);
    expect(lateLimit(schedule('2026-12-01 09:00'), NY, 0)).toBe(HOUR);
  });

  it('counts the slots a job missed, from its first', () => {
    const slot = utc(2026, 11, 17, 9);
    expect(missedSlots(schedule('every 5m'), 'UTC', slot, slot + DAY)).toBe(289);
    expect(missedSlots(schedule('0 9 * * *'), 'UTC', slot, slot + 3 * DAY + HOUR)).toBe(4);
    expect(missedSlots(schedule('in 30m'), 'UTC', slot, slot + DAY)).toBe(1);
    expect(missedSlots(schedule('every 5m'), 'UTC', slot, slot + 400 * DAY)).toBe(MISSED_COUNT_MAX);
  });
});
