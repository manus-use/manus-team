import { describe, expect, it } from 'vitest';
import {
  FORMS,
  checkZone,
  formatWall,
  isOneOff,
  isoWithOffset,
  parseSchedule,
  type CronFields,
  type Schedule,
} from '../src/cron/schedule.js';

/**
 * The schedule grammar (the cron spec, §2.1), as tables: each form, each
 * refusal, keywords in any case, names in ranges, 7 as Sunday, the day fields'
 * or-rule, `a/n`, every refused extension named, and the 5-minute rule on the
 * minute circle.
 */

function parsed(text: string): Schedule {
  const r = parseSchedule(text);
  if (!r.ok) throw new Error(`${text}: ${r.message}`);
  return r.schedule;
}

function fields(text: string): CronFields {
  const s = parsed(text);
  if (s.kind !== 'cron') throw new Error(`${text} is not a clock time`);
  return s.fields;
}

function refusal(text: string): string {
  const r = parseSchedule(text);
  if (r.ok) throw new Error(`${text} was taken`);
  return r.message;
}

const range = (a: number, b: number, by = 1): number[] => Array.from({ length: Math.floor((b - a) / by) + 1 }, (_, i) => a + i * by);

describe('parseSchedule: cron expressions', () => {
  it.each([
    ['0 9 * * 1-5', { minutes: [0], hours: [9], weekdays: [1, 2, 3, 4, 5], anyDay: true, anyWeekday: false }],
    ['*/5 * * * *', { minutes: range(0, 55, 5), hours: range(0, 23), anyDay: true, anyWeekday: true }],
    ['0,30 8-18/2 * * *', { minutes: [0, 30], hours: [8, 10, 12, 14, 16, 18] }],
    ['15 3/6 * * *', { minutes: [15], hours: [3, 9, 15, 21] }],
    ['0 0 1,15 * *', { minutes: [0], hours: [0], days: [1, 15], anyDay: false, anyWeekday: true }],
    ['0 12 * jan-mar mon-fri', { months: [1, 2, 3], weekdays: [1, 2, 3, 4, 5] }],
    ['0 12 * JAN,Dec SUN', { months: [1, 12], weekdays: [0] }],
    ['0 12 * * 7', { weekdays: [0] }],
    ['0 12 * * 5-7', { weekdays: [0, 5, 6] }],
    ['0\t12  *\t* *', { minutes: [0], hours: [12] }],
    ['0 9 */2 * 1', { days: range(1, 31, 2), weekdays: [1], anyDay: true, anyWeekday: false }],
  ])('%s', (text, want) => {
    const f = fields(text);
    const got = {
      minutes: f.minutes,
      hours: f.hours,
      days: [...f.days].sort((a, b) => a - b),
      months: [...f.months].sort((a, b) => a - b),
      weekdays: [...f.weekdays].sort((a, b) => a - b),
      anyDay: f.anyDay,
      anyWeekday: f.anyWeekday,
    };
    expect(got).toMatchObject(want);
  });

  it('keeps the schedule as written, trimmed', () => {
    expect(parsed('  0 9 * * 1-5 ')).toMatchObject({ kind: 'cron', text: '0 9 * * 1-5' });
  });

  it.each([
    ['@daily', '"@daily" is not taken: write the five fields, as 0 0 * * * for @daily'],
    ['@reboot', '"@reboot" is not taken: write the five fields, as 0 0 * * * for @daily'],
    ['0 0 9 * * *', 'a seconds field is not taken: a cron expression has five fields, minute hour day-of-month month day-of-week'],
    ['0 9 L * *', '"L" is not taken: L, W, # and ? mean different things to different cron implementations'],
    ['0 9 15W * *', '"W" is not taken: L, W, # and ? mean different things to different cron implementations'],
    ['0 9 * * 1#2', '"#" is not taken: L, W, # and ? mean different things to different cron implementations'],
    ['0 9 ? * 1', '"?" is not taken: L, W, # and ? mean different things to different cron implementations'],
    ['60 9 * * *', 'the minute field has 60, outside 0 to 59'],
    ['0 24 * * *', 'the hour field has 24, outside 0 to 23'],
    ['0 9 0 * *', 'the day of month field has 0, outside 1 to 31'],
    ['0 9 * 13 *', 'the month field has 13, outside 1 to 12'],
    ['0 9 * * 8', 'the day of week field has 8, outside 0 to 7'],
    ['0 9 * * fri-mon', 'the day of week field has "fri-mon", a range that runs backwards'],
    ['0 9 * * -1', 'the day of week field has "", which is not a number or a name'],
    ['0 9 * foo *', 'the month field has "foo", which is not a number or a name'],
    ['0 9 * * 1,', 'the day of week field has an empty item'],
    ['*/0 9 * * *', 'the minute field has "*/0", whose step is not a whole number of at least 1'],
    ['0 9 * *', FORMS],
    ['', FORMS],
    ['0 9 * * *\n', FORMS],
  ])('refuses %j', (text, message) => {
    expect(refusal(text)).toBe(message);
  });
});

describe('parseSchedule: the 5-minute rule, on the minute circle', () => {
  it.each(['*/5 * * * *', '55,0 * * * *', '0 * * * *', '0,30 * * * *', '0 9 * * *', '0-55/5 9 * * *'])('takes %s', (text) => {
    expect(parseSchedule(text).ok).toBe(true);
  });

  it.each([
    ['* * * * *', 1],
    ['*/4 * * * *', 4],
    ['0,3 * * * *', 3],
    ['58,1 * * * *', 3],
    ['0,57 9 * * *', 3],
  ])('refuses %s, %i minutes apart', (text, apart) => {
    expect(refusal(text)).toMatch(new RegExp(`^the schedule fires ${apart} minutes? apart, and a schedule's period is at least 5 minutes`));
  });
});

describe('parseSchedule: every and in', () => {
  it.each([
    ['every 5m', 5 * 60_000],
    ['every 2h', 2 * 3_600_000],
    ['EVERY 1D', 86_400_000],
    ['every 365d', 365 * 86_400_000],
  ])('%s is a fixed period', (text, ms) => {
    expect(parsed(text)).toMatchObject({ kind: 'every', periodMs: ms });
  });

  it.each([
    ['every day 09:00', '0 9 * * *'],
    ['Every Weekday 9:30', '30 9 * * 1-5'],
    ['every monday 23:59', '59 23 * * 1'],
    ['every sun 0:00', '0 0 * * 0'],
    ['every Saturday 12:05', '5 12 * * 6'],
  ])('%s is the cron expression %s', (text, expr) => {
    const a = fields(text);
    const b = fields(expr);
    expect({ ...a, days: [...a.days], months: [...a.months], weekdays: [...a.weekdays] }).toEqual({
      ...b,
      days: [...b.days],
      months: [...b.months],
      weekdays: [...b.weekdays],
    });
    expect(parsed(text).text).toBe(text);
  });

  it.each([
    ['in 30m', 30 * 60_000],
    ['in 1m', 60_000],
    ['IN 2H', 2 * 3_600_000],
    ['in 365d', 365 * 86_400_000],
  ])('%s is a one-off', (text, ms) => {
    expect(parsed(text)).toMatchObject({ kind: 'in', afterMs: ms });
    expect(isOneOff(parsed(text))).toBe(true);
  });

  it.each([
    ['every 4m', "every 4m is under 5 minutes, and a schedule's period is at least 5 minutes"],
    ['every 0h', 'every 0h: n is at least 1'],
    ['in 0m', 'in 0m: n is at least 1'],
    ['every 366d', 'every 366d is more than 365 days'],
    ['every 8761h', 'every 8761h is more than 365 days'],
    ['in 366d', 'in 366d is more than 365 days'],
    ['every -5m', FORMS],
    ['every 5', FORMS],
    ['every 5s', FORMS],
    ['every day 24:00', '"24:00" is not a time of day: write HH:MM, from 00:00 to 23:59'],
    ['every day 9', '"9" is not a time of day: write HH:MM, from 00:00 to 23:59'],
    ['every someday 09:00', FORMS],
    ['every day', FORMS],
    ['in 30m now', FORMS],
  ])('refuses %j', (text, message) => {
    expect(refusal(text)).toBe(message);
  });
});

describe('parseSchedule: ISO times', () => {
  it.each([
    ['2026-11-17T09:00', { y: 2026, mo: 11, d: 17, h: 9, mi: 0, s: 0 }],
    ['2026-11-17 09:00:30', { y: 2026, mo: 11, d: 17, h: 9, mi: 0, s: 30 }],
    ['2028-02-29 23:59', { y: 2028, mo: 2, d: 29, h: 23, mi: 59, s: 0 }],
  ])('%s is a wall-clock time', (text, wall) => {
    expect(parsed(text)).toEqual({ kind: 'wall', text, wall });
  });

  it.each([
    ['2026-11-17T09:00Z', Date.UTC(2026, 10, 17, 9, 0)],
    ['2026-11-17T09:00:15z', Date.UTC(2026, 10, 17, 9, 0, 15)],
    ['2026-11-17T09:00+08:00', Date.UTC(2026, 10, 17, 1, 0)],
    ['2026-11-17 09:00-05:30', Date.UTC(2026, 10, 17, 14, 30)],
  ])('%s is an instant', (text, instant) => {
    expect(parsed(text)).toEqual({ kind: 'at', text, instant });
  });

  it.each([
    ['2026-02-29 09:00', '"2026-02-29 09:00" is not a time that exists on the calendar'],
    ['2026-13-01 09:00', '"2026-13-01 09:00" is not a time that exists on the calendar'],
    ['2026-11-17 25:00', '"2026-11-17 25:00" is not a time that exists on the calendar'],
    ['2026-11-17 09:00+24:00', '"2026-11-17 09:00+24:00" has an offset that is not one'],
    ['2026-11-17', FORMS],
    ['2026-11-17T9:00', FORMS],
  ])('refuses %j', (text, message) => {
    expect(refusal(text)).toBe(message);
  });

  it('refuses a period written with a space, saying how to write it', () => {
    expect(refusal('every 2 h')).toBe('write every 2h, with no space');
    expect(refusal('every 30 minutes')).toBe('write every 30m, with no space');
    expect(refusal('every 3 weeks')).toBe('write every 3h, every 3m or every 3d, with no space');
  });

  it('refuses a schedule over 100 bytes', () => {
    expect(refusal(`0 9 * * ${'1,'.repeat(50)}1`)).toBe('a schedule is at most 100 bytes');
  });
});

describe('checkZone', () => {
  it('names a zone as Intl does, and refuses an unknown one', () => {
    expect(checkZone('Asia/Shanghai')).toEqual({ ok: true, zone: 'Asia/Shanghai' });
    expect(checkZone('utc')).toEqual({ ok: true, zone: 'UTC' });
    expect(checkZone('Mars/Olympus')).toEqual({
      ok: false,
      message: '"Mars/Olympus" is not a time zone: name one as the IANA database does, as Asia/Shanghai',
    });
    expect(checkZone('').ok).toBe(false);
  });

  it('refuses an offset, which is no IANA zone', () => {
    for (const tz of ['+05:30', '-08:00', '+8']) {
      expect(checkZone(tz)).toEqual({ ok: false, message: `${JSON.stringify(tz)} is an offset, not a time zone: name one as the IANA database does, as Asia/Shanghai` });
    }
  });
});

describe('formatWall and isoWithOffset', () => {
  it("give an instant's wall time in its zone", () => {
    const at = Date.UTC(2026, 10, 17, 1, 0);
    expect(formatWall('Asia/Shanghai', at)).toBe('2026-11-17 09:00');
    expect(isoWithOffset('Asia/Shanghai', at)).toBe('2026-11-17T09:00:00+08:00');
    expect(isoWithOffset('America/New_York', at)).toBe('2026-11-16T20:00:00-05:00');
    expect(isoWithOffset('Asia/Kathmandu', at)).toBe('2026-11-17T06:45:00+05:45');
    expect(isoWithOffset('UTC', at)).toBe('2026-11-17T01:00:00+00:00');
  });
});
