/**
 * A cron job's schedule (the cron spec, §2.1, §2.2): its grammar, and its next
 * time after an instant in its zone. Pure: nothing here reads a clock or the
 * database, so every rule is tested as a table.
 *
 * **Three kinds, told apart by their first word.** A 5-field cron expression and
 * `every day HH:MM`, `every weekday HH:MM`, `every <day> HH:MM` recur at clock
 * times in the job's zone, the latter three computed as the cron expressions
 * they are (`M H * * *`, `M H * * 1-5`, `M H * * <d>`), so the two forms cannot
 * drift. `every <n>m|h|d` recurs at a fixed period of elapsed time, whatever the
 * zone. `in <n>m|h|d` and an ISO 8601 time happen once.
 *
 * **Our own parser, not a library's** (§2.1): a library's grammar would bring
 * its extensions, and its idea of daylight saving time would be ours. Nothing
 * beyond cron(5)'s fields is taken: no macros, no seconds, no `L`, `W`, `#` or
 * `?`, which differ between implementations.
 *
 * **Wall time to an instant** (§2.2): a wall-clock time that happens once maps
 * to that instant; one that happens twice, in the hour the clocks go back, to
 * its earlier instant; one that does not happen, in the gap the clocks go
 * forward over, to the instant of the change. The next run after an instant is
 * the least mapped instant after it of the wall times the schedule matches,
 * found by walking the zone's calendar a day at a time, and then a matching
 * day's hours and minutes, never minute by minute. The zone's offset is read
 * with `Intl.DateTimeFormat`, Node's own ICU being the only source of its rules.
 */

/** The longest schedule, as written, in UTF-8 bytes (§8). */
export const SCHEDULE_MAX_BYTES = 100;
/** The shortest period a schedule may have (§2.1). */
export const MIN_PERIOD_MS = 5 * 60_000;
/** The furthest a one-off, an `every` or an `in` may reach (§2.1). */
export const MAX_AHEAD_MS = 365 * 24 * 3_600_000;
/** How far the next run of a cron expression is looked for: 29 February can be eight years from the last one, across 2100. */
export const SEARCH_YEARS = 8;
/** How late a one-off is still fired (§4.3): a reminder late is worth more than one lost, within an hour. */
export const ONE_OFF_GRACE_MS = 3_600_000;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SEARCH_DAYS = SEARCH_YEARS * 366 + 2;

/** A cron expression's matching values, each field as a sorted list. */
export interface CronFields {
  minutes: readonly number[];
  hours: readonly number[];
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 to 6, Sunday 0; a 7 written is a 0. */
  weekdays: ReadonlySet<number>;
  /** The day of month field starts with `*`: unrestricted, for the or-rule of cron(5). */
  anyDay: boolean;
  /** The day of week field starts with `*`. */
  anyWeekday: boolean;
}

/** A wall-clock time in a zone, to the second. */
export interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export type Schedule =
  | { kind: 'cron'; text: string; fields: CronFields }
  | { kind: 'every'; text: string; periodMs: number }
  | { kind: 'in'; text: string; afterMs: number }
  | { kind: 'at'; text: string; instant: number }
  | { kind: 'wall'; text: string; wall: Wall };

export type Parsed = { ok: true; schedule: Schedule } | { ok: false; message: string };
export type Planned = { ok: true; at: number } | { ok: false; message: string };

/** The three forms, for a refusal of anything else. */
export const FORMS =
  'a schedule is a cron expression of five fields (0 9 * * 1-5), every with a period or a clock time (every 2h, every day 09:00, every monday 09:00), ' +
  'or a one-off (in 30m, 2026-11-17 09:00)';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES: Readonly<Record<string, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const UNITS: Readonly<Record<string, number>> = { m: MINUTE, h: HOUR, d: DAY };

function refused(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

const NUMBER = /^[0-9]+$/;

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
  /** Where the first name stands: `jan` is 1, `sun` is 0. */
  namesFrom?: number;
}

const FIELDS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, namesFrom: 1 },
  { name: 'day of week', min: 0, max: 7, names: WEEKDAYS, namesFrom: 0 },
];

/** One value of a field: a number in its bounds, or a name it takes. */
function value(spec: FieldSpec, text: string): number | string {
  const lower = text.toLowerCase();
  const at = spec.names?.indexOf(lower) ?? -1;
  if (at !== -1) return at + (spec.namesFrom ?? 0);
  if (!NUMBER.test(text)) return `the ${spec.name} field has ${JSON.stringify(text)}, which is not a number${spec.names === undefined ? '' : ' or a name'}`;
  const n = Number(text);
  if (n < spec.min || n > spec.max) return `the ${spec.name} field has ${n}, outside ${spec.min} to ${spec.max}`;
  return n;
}

/** A field's values, or why not: `*`, `a`, `a-b`, `*\/n`, `a-b/n`, `a/n`, joined by commas. */
function field(spec: FieldSpec, text: string): Set<number> | string {
  const out = new Set<number>();
  for (const item of text.split(',')) {
    if (item === '') return `the ${spec.name} field has an empty item`;
    const [range = '', step, extra] = item.split('/');
    if (extra !== undefined) return `the ${spec.name} field has ${JSON.stringify(item)}, with two steps`;
    let by = 1;
    if (step !== undefined) {
      if (!NUMBER.test(step) || Number(step) < 1) return `the ${spec.name} field has ${JSON.stringify(item)}, whose step is not a whole number of at least 1`;
      by = Number(step);
    }
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = spec.min;
      hi = spec.max;
    } else {
      const [a = '', b, more] = range.split('-');
      if (more !== undefined) return `the ${spec.name} field has ${JSON.stringify(item)}, which is not a range`;
      const first = value(spec, a);
      if (typeof first === 'string') return first;
      lo = first;
      if (b === undefined) {
        // `a/n` runs from a to the field's end; a lone `a` is itself.
        hi = step === undefined ? first : spec.max;
      } else {
        const last = value(spec, b);
        if (typeof last === 'string') return last;
        if (last < first) return `the ${spec.name} field has ${JSON.stringify(item)}, a range that runs backwards`;
        hi = last;
      }
    }
    for (let v = lo; v <= hi; v += by) out.add(v);
  }
  return out;
}

/** Why a cron expression's minutes come closer than 5 apart, read as a circle of 60, or undefined (§2.1). */
function tooFrequent(minutes: readonly number[]): string | undefined {
  if (minutes.length < 2) return undefined;
  let closest = 60;
  for (let i = 0; i < minutes.length; i += 1) {
    const a = minutes[i] ?? 0;
    const b = i + 1 < minutes.length ? (minutes[i + 1] ?? 0) : (minutes[0] ?? 0) + 60;
    closest = Math.min(closest, b - a);
  }
  if (closest >= 5) return undefined;
  return (
    `the schedule fires ${closest} minute${closest === 1 ? '' : 's'} apart, and a schedule's period is at least 5 minutes; ` +
    'the check reads the minute field alone, across the hour too, so write two jobs for minutes that are close only across an hour that never fires'
  );
}

/** A 5-field cron expression's fields, or why not. */
function cronFields(words: readonly string[]): CronFields | string {
  if (words.length === 6) {
    return 'a seconds field is not taken: a cron expression has five fields, minute hour day-of-month month day-of-week';
  }
  if (words.length !== 5) return FORMS;
  for (const w of words) {
    const odd = /[LW#?]/i.exec(w.replace(/[a-z]{3}/gi, (name) => (MONTHS.includes(name.toLowerCase()) || WEEKDAYS.includes(name.toLowerCase()) ? '' : name)));
    if (odd !== null) {
      return `${JSON.stringify(odd[0])} is not taken: L, W, # and ? mean different things to different cron implementations`;
    }
  }
  const sets: Set<number>[] = [];
  for (const [i, spec] of FIELDS.entries()) {
    const set = field(spec, words[i] ?? '');
    if (typeof set === 'string') return set;
    sets.push(set);
  }
  const [minutes, hours, days, months, weekdays] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  const sorted = (s: Set<number>): number[] => [...s].sort((a, b) => a - b);
  return {
    minutes: sorted(minutes),
    hours: sorted(hours),
    days,
    months,
    weekdays,
    anyDay: (words[2] ?? '').startsWith('*'),
    anyWeekday: (words[4] ?? '').startsWith('*'),
  };
}

const CLOCK = /^([0-9]{1,2}):([0-9]{2})$/;

/** `every day|weekday|<day> HH:MM` as the cron expression it is. */
function clockTime(day: string, time: string): string | readonly string[] {
  const m = CLOCK.exec(time);
  const h = Number(m?.[1]);
  const mi = Number(m?.[2]);
  if (m === null || h > 23 || mi > 59) return `${JSON.stringify(time)} is not a time of day: write HH:MM, from 00:00 to 23:59`;
  const lower = day.toLowerCase();
  const dow = lower === 'day' ? '*' : lower === 'weekday' ? '1-5' : DAY_NAMES[lower];
  if (dow === undefined) return FORMS;
  return [String(mi), String(h), '*', '*', String(dow)];
}

/** `<n><unit>`, as a period, or why not. */
function amount(word: string, kind: 'every' | 'in'): number | string {
  const m = /^([0-9]+)([mhd])$/i.exec(word);
  if (m === null) return FORMS;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  if (n < 1) return `${kind} ${word}: n is at least 1`;
  const ms = n * (UNITS[unit] ?? MINUTE);
  if (kind === 'every' && ms < MIN_PERIOD_MS) return `every ${word} is under 5 minutes, and a schedule's period is at least 5 minutes`;
  if (ms > MAX_AHEAD_MS) return `${kind} ${word} is more than 365 days`;
  return ms;
}

const ISO = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?(Z|[+-][0-9]{2}:[0-9]{2})?$/i;

function daysIn(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** An ISO 8601 time: an instant with its offset or `Z`, else a wall-clock time in the job's zone. */
function iso(text: string): Schedule | string {
  const m = ISO.exec(text);
  if (m === null) return FORMS;
  const [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(m[i]));
  const s = m[6] === undefined ? 0 : Number(m[6]);
  if (
    y === undefined ||
    mo === undefined ||
    d === undefined ||
    h === undefined ||
    mi === undefined ||
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    d > daysIn(y, mo) ||
    h > 23 ||
    mi > 59 ||
    s > 59
  ) {
    return `${JSON.stringify(text)} is not a time that exists on the calendar`;
  }
  const wall: Wall = { y, mo, d, h, mi, s };
  const zone = m[7];
  if (zone === undefined) return { kind: 'wall', text, wall };
  let offset = 0;
  if (zone.toUpperCase() !== 'Z') {
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) return `${JSON.stringify(text)} has an offset that is not one`;
    offset = (zone.startsWith('-') ? -1 : 1) * (oh * HOUR + om * MINUTE);
  }
  return { kind: 'at', text, instant: wallMs(wall) - offset };
}

/**
 * A schedule as written, read, or why not (§2.1). Keywords in any case; words
 * apart by spaces or tabs. The 5-minute period and the 365 days of `every` and
 * `in` are checked here; what needs the zone and the clock, `firstRun`.
 */
export function parseSchedule(text: string): Parsed {
  if (Buffer.byteLength(text, 'utf8') > SCHEDULE_MAX_BYTES) return refused(`a schedule is at most ${SCHEDULE_MAX_BYTES} bytes`);
  const trimmed = text.replace(/^[ \t]+|[ \t]+$/g, '');
  if (trimmed === '') return refused(FORMS);
  if (/[^\x21-\x7e \t]/.test(trimmed)) return refused(FORMS);
  if (trimmed.startsWith('@')) {
    return refused(`${JSON.stringify(trimmed.split(/[ \t]/)[0])} is not taken: write the five fields, as 0 0 * * * for @daily`);
  }
  const words = trimmed.split(/[ \t]+/);
  const first = (words[0] ?? '').toLowerCase();
  if (first === 'every') {
    if (words.length === 2) {
      const ms = amount(words[1] ?? '', 'every');
      return typeof ms === 'string' ? refused(ms) : { ok: true, schedule: { kind: 'every', text: trimmed, periodMs: ms } };
    }
    if (words.length !== 3) return refused(FORMS);
    // `every 2 h`: a period with a space in it, not a day and a time.
    if (/^[0-9]+$/.test(words[1] ?? '')) {
      const n = words[1] ?? '';
      const unit = (words[2] ?? '').charAt(0).toLowerCase();
      return refused(/^[mhd]$/.test(unit) ? `write every ${n}${unit}, with no space` : `write every ${n}h, every ${n}m or every ${n}d, with no space`);
    }
    const expr = clockTime(words[1] ?? '', words[2] ?? '');
    if (typeof expr === 'string') return refused(expr);
    const fields = cronFields(expr);
    return typeof fields === 'string' ? refused(fields) : { ok: true, schedule: { kind: 'cron', text: trimmed, fields } };
  }
  if (first === 'in') {
    if (words.length !== 2) return refused(FORMS);
    const ms = amount(words[1] ?? '', 'in');
    return typeof ms === 'string' ? refused(ms) : { ok: true, schedule: { kind: 'in', text: trimmed, afterMs: ms } };
  }
  if (/^[0-9]{4}-/.test(trimmed)) {
    const one = iso(trimmed);
    return typeof one === 'string' ? refused(one) : { ok: true, schedule: one };
  }
  const fields = cronFields(words);
  if (typeof fields === 'string') return refused(fields);
  const frequent = tooFrequent(fields.minutes);
  if (frequent !== undefined) return refused(frequent);
  return { ok: true, schedule: { kind: 'cron', text: trimmed, fields } };
}

// ---------------------------------------------------------------------------
// Zones

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

/**
 * An IANA zone as Intl names it, or why not (§2.2): `utc` is `UTC`. Checked by
 * building a formatter with it, which refuses an unknown one; an offset, which
 * Intl would take, is refused first.
 */
export function checkZone(tz: string): { ok: true; zone: string } | { ok: false; message: string } {
  if (tz.trim() === '' || Buffer.byteLength(tz, 'utf8') > 64) return refused(`${JSON.stringify(tz)} is not a time zone: name one as the IANA database does, as Asia/Shanghai`);
  // Intl takes an offset as a zone, but an offset has no daylight saving and is no IANA name (§2.2).
  if (/^[+-]\d/.test(tz.trim())) return refused(`${JSON.stringify(tz)} is an offset, not a time zone: name one as the IANA database does, as Asia/Shanghai`);
  try {
    return { ok: true, zone: new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone };
  } catch {
    return refused(`${JSON.stringify(tz)} is not a time zone: name one as the IANA database does, as Asia/Shanghai`);
  }
}

/** The zone this process resolves, as `cron.tz` unset falls back to (§2.2). */
export function processZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function wallMs(w: Wall): number {
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
}

/** The wall-clock time an instant is in a zone, to the second. */
export function wallOf(tz: string, instant: number): Wall {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(instant))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return { y: parts['year'] ?? 0, mo: parts['month'] ?? 1, d: parts['day'] ?? 1, h: parts['hour'] ?? 0, mi: parts['minute'] ?? 0, s: parts['second'] ?? 0 };
}

/** The zone's offset at an instant: its wall time less the instant, in ms. */
function offsetAt(tz: string, instant: number): number {
  const whole = Math.floor(instant / 1000) * 1000;
  return wallMs(wallOf(tz, whole)) - whole;
}

/**
 * The instant a wall-clock time maps to in a zone (§2.2): itself once; the
 * earlier of two in a repeated hour; the change's in a gap, which `gap` says.
 */
export function toInstant(tz: string, w: Wall): { instant: number; gap: boolean } {
  const local = wallMs(w);
  const before = offsetAt(tz, local - DAY);
  const after = offsetAt(tz, local + DAY);
  const fits = [...new Set([local - before, local - after])].filter((c) => c + offsetAt(tz, c) === local).sort((a, b) => a - b);
  const earliest = fits[0];
  if (earliest !== undefined) return { instant: earliest, gap: false };
  if (before === after) return { instant: local - before, gap: false };
  // In the gap: the offset moves from `before` to `after` somewhere in (lo, hi]; the change is the first second of `after`.
  let lo = local - Math.max(before, after);
  let hi = local - Math.min(before, after);
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (offsetAt(tz, mid) === after) hi = mid;
    else lo = mid;
  }
  return { instant: hi, gap: true };
}

/** `2026-11-17 09:00`: an instant's wall time in its zone, to the minute, as messages give a slot. */
export function formatWall(tz: string, instant: number): string {
  const w = wallOf(tz, instant);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${w.y}-${two(w.mo)}-${two(w.d)} ${two(w.h)}:${two(w.mi)}`;
}

/** `2026-11-17T09:00:00+08:00`: an instant as ISO 8601 with its zone's offset, as an agent is answered (§6.3). */
export function isoWithOffset(tz: string, instant: number): string {
  const w = wallOf(tz, instant);
  const two = (n: number): string => String(Math.abs(n)).padStart(2, '0');
  const offset = Math.round((wallMs(w) - Math.floor(instant / 1000) * 1000) / MINUTE);
  const sign = offset < 0 ? '-' : '+';
  return `${w.y}-${two(w.mo)}-${two(w.d)}T${two(w.h)}:${two(w.mi)}:${two(w.s)}${sign}${two(Math.trunc(Math.abs(offset) / 60))}:${two(Math.abs(offset) % 60)}`;
}

// ---------------------------------------------------------------------------
// The next run

/** What a search walked: for the test that it goes a day at a time. */
export interface SearchStats {
  days: number;
  times: number;
}

function dayMatches(f: CronFields, y: number, mo: number, d: number): boolean {
  if (!f.months.has(mo)) return false;
  const dom = f.days.has(d);
  const dow = f.weekdays.has(new Date(Date.UTC(y, mo - 1, d)).getUTCDay());
  // Both restricted: either; otherwise both, an unrestricted one matching every day (cron(5), Vixie's `*`).
  return f.anyDay || f.anyWeekday ? dom && dow : dom || dow;
}

/**
 * The least mapped instant after `after` of the wall times a cron expression
 * matches in `tz`, within SEARCH_YEARS; undefined when there is none (§2.2).
 */
export function nextRun(fields: CronFields, tz: string, after: number, stats?: SearchStats): number | undefined {
  const start = wallOf(tz, after);
  const day = new Date(Date.UTC(start.y, start.mo - 1, start.d));
  for (let i = 0; i < SEARCH_DAYS; i += 1, day.setUTCDate(day.getUTCDate() + 1)) {
    if (stats !== undefined) stats.days += 1;
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (!dayMatches(fields, y, mo, d)) continue;
    for (const h of fields.hours) {
      if (i === 0 && h < start.h) continue;
      for (const mi of fields.minutes) {
        // Earlier on the first day maps before `after`: the clocks never go back past it.
        if (i === 0 && h === start.h && mi < start.mi) continue;
        if (stats !== undefined) stats.times += 1;
        const { instant } = toInstant(tz, { y, mo, d, h, mi, s: 0 });
        if (instant > after) return instant;
      }
    }
  }
  return undefined;
}

/**
 * The next run of a job just added, resumed, or given a new schedule or zone
 * (§2.1, §2.5), or why it has none: a cron expression whose next time is
 * SEARCH_YEARS away, a one-off in the past or more than 365 days ahead, or a
 * wall-clock one-off in a gap of its zone.
 */
export function firstRun(s: Schedule, tz: string, now: number): Planned {
  switch (s.kind) {
    case 'cron': {
      const at = nextRun(s.fields, tz, now);
      return at === undefined ? refused(`${s.text} never comes: it has no time in the next ${SEARCH_YEARS} years`) : { ok: true, at };
    }
    case 'every':
      return { ok: true, at: now + s.periodMs };
    case 'in':
      return { ok: true, at: now + s.afterMs };
    case 'at':
    case 'wall': {
      let at: number;
      if (s.kind === 'at') at = s.instant;
      else {
        const mapped = toInstant(tz, s.wall);
        if (mapped.gap) return refused(`${s.text} does not happen in ${tz}: the clocks go forward over it`);
        at = mapped.instant;
      }
      if (at <= now) return refused(`${s.text} is in the past`);
      if (at - now > MAX_AHEAD_MS) return refused(`${s.text} is more than 365 days ahead`);
      return { ok: true, at };
    }
  }
}

/** Whether a schedule happens once: its job is done once it has fired or been skipped. */
export function isOneOff(s: Schedule): boolean {
  return s.kind === 'in' || s.kind === 'at' || s.kind === 'wall';
}

/**
 * The next run after the slot `slot` was fired or skipped at `now` (§4.2): the
 * first slot after now, of the same grid for a fixed period, `slot + k·p`;
 * undefined for a one-off, which is then done, and for a cron expression with
 * no time left in its search.
 */
export function runAfter(s: Schedule, tz: string, slot: number, now: number): number | undefined {
  if (s.kind === 'every') return slot + (Math.floor(Math.max(0, now - slot) / s.periodMs) + 1) * s.periodMs;
  if (s.kind === 'cron') return nextRun(s.fields, tz, Math.max(now, slot));
  return undefined;
}

/**
 * A recurring schedule's period at a slot (§4.3): a fixed period's own; for a
 * clock time, the time from the slot to the one after it, in its zone. A
 * one-off has none, and is given its grace.
 */
export function periodAt(s: Schedule, tz: string, slot: number): number {
  if (s.kind === 'every') return s.periodMs;
  if (s.kind === 'cron') return (nextRun(s.fields, tz, slot) ?? slot + SEARCH_YEARS * 366 * DAY) - slot;
  return ONE_OFF_GRACE_MS;
}

/**
 * How late a slot may be and still be fired (§4.3): half its period for a
 * recurring schedule, and ONE_OFF_GRACE_MS, an hour, for a one-off.
 */
export function lateLimit(s: Schedule, tz: string, slot: number): number {
  return isOneOff(s) ? ONE_OFF_GRACE_MS : periodAt(s, tz, slot) / 2;
}

/** The most slots `missedSlots` counts before it says so. */
export const MISSED_COUNT_MAX = 10_000;

/** How many slots fell in `[slot, now]`: one skip says it of a job down for a while (§4.3); at most MISSED_COUNT_MAX. */
export function missedSlots(s: Schedule, tz: string, slot: number, now: number): number {
  if (now < slot) return 0;
  if (s.kind === 'every') return Math.min(MISSED_COUNT_MAX, Math.floor((now - slot) / s.periodMs) + 1);
  if (s.kind !== 'cron') return 1;
  let n = 1;
  for (let at = nextRun(s.fields, tz, slot); at !== undefined && at <= now && n < MISSED_COUNT_MAX; at = nextRun(s.fields, tz, at)) n += 1;
  return n;
}
