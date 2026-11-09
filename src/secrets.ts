/**
 * The secrets the gateway knows, masked wherever they would leave it (spec §10.1).
 *
 * What the registry holds:
 * - the Lark app secret;
 * - every environment value given to an agent, except names its role lists in
 *   maskExempt;
 * - from plan C, every live worker token.
 *
 * It is process-wide on purpose. The escapers and the renderer are pure functions,
 * and threading a secret set through every call site would put it at the mercy of
 * the one site that forgets. So the projection is pure *given the secret set*, and
 * tests set the set explicitly.
 *
 * Exact matches only, but for the characters that show nothing (`INVISIBLE`:
 * bidi controls, zero-width characters, direction marks). A secret split by one
 * still reads whole on screen, so it is matched as if they were not there, and
 * masked with them. They are not stripped: outside a secret, a joined emoji and
 * right-to-left text need them. A secret the agent found by itself, a known
 * secret encoded or reformatted otherwise, and anything shorter than
 * MIN_SECRET_LENGTH are not caught.
 *
 * This is not `mask()` in channel/escape.ts. That one shows a secret's prefix in a
 * render that means to show the secret.
 */

import { INVISIBLE, isInvisible, stripControl } from './text.js';

export const MASK = '••••';

/** Shorter values are not secrets: masking `1` or `true` would mangle ordinary text. */
export const MIN_SECRET_LENGTH = 8;

/** A trailing fragment shorter than this is too common to be worth withholding. */
const MIN_PREFIX_LENGTH = 4;

/**
 * Keys whose values identify rather than say something. A string under one is left
 * alone, as identifying columns are: masking an id would break the lookups that
 * use it. Workspace and assignee names identify too (spec §10.1).
 */
const IDENTIFYING_KEYS: ReadonlySet<string> = new Set([
  'approvalId',
  'toolCallId',
  'requestId',
  'optionId',
  'optionIds',
  'messageId',
  'replyTo',
  'turnId',
  'sessionId',
  'idempotencyKey',
  'conversationId',
  'threadId',
  'owner',
  'role',
  'workspace',
  'sender',
  'resolvedBy',
  'resolvedVia',
]);

/**
 * Each known form, and how many registrations hold it. Counted, because one value
 * can be registered twice -- a worker token equal to a configured secret, or two
 * values with the same stripped form -- and removing one registration must leave
 * the value masked while the other holds it.
 */
const secrets = new Map<string, number>();
/** Longest first. Rebuilt on change. */
let ordered: string[] = [];

function reorder(): void {
  ordered = [...secrets.keys()].sort((a, b) => b.length - a.length);
}

/**
 * The forms a value is known by: itself, itself with control characters
 * stripped, because the escapers strip before they match, and that without its
 * invisible characters, which matching skips. A form shorter than
 * MIN_SECRET_LENGTH is not a secret. A value containing MASK's character is
 * ignored, so that withholding a fragment of it can never eat a MASK.
 *
 * A value of MIN_SECRET_LENGTH or more whose stripped form is shorter is
 * registered only in its raw form: the escapers, which match the stripped text,
 * will not mask it.
 */
function forms(value: string): string[] {
  if (value.includes('•')) return [];
  const out: string[] = [];
  if (value.length >= MIN_SECRET_LENGTH) out.push(value);
  const stripped = stripControl(value);
  if (stripped !== value && stripped.length >= MIN_SECRET_LENGTH) out.push(stripped);
  const seen = stripped.replace(INVISIBLE, '');
  if (seen !== stripped && seen.length >= MIN_SECRET_LENGTH) out.push(seen);
  return out;
}

/** Register each value: one more registration of each of its forms. */
export function addSecrets(values: Iterable<string>): void {
  for (const value of values) for (const form of forms(value)) secrets.set(form, (secrets.get(form) ?? 0) + 1);
  reorder();
}

/**
 * Undo one registration of each value, as a run's token leaves when its run
 * closes. A form is forgotten only when nothing else holds it, so removing a
 * token never unmasks a configured secret with the same value. Removing a value
 * that was never added changes nothing.
 */
export function removeSecrets(values: Iterable<string>): void {
  for (const value of values) {
    for (const form of forms(value)) {
      const held = secrets.get(form);
      if (held === undefined) continue;
      if (held > 1) secrets.set(form, held - 1);
      else secrets.delete(form);
    }
  }
  reorder();
}

/** Test-only: the registry is process-wide. */
export function clearSecrets(): void {
  secrets.clear();
  reorder();
}

/** Whether text holds any of INVISIBLE's characters: not global, so it keeps no state between calls. */
const ANY_INVISIBLE = new RegExp(INVISIBLE.source);

/**
 * Text as it reads on screen, without its invisible characters, and where in
 * the text they were, in order; or undefined when it has none, the common case,
 * which then costs one regular expression test.
 */
interface OnScreen {
  text: string;
  invisible: number[];
}

function onScreen(text: string): OnScreen | undefined {
  if (!ANY_INVISIBLE.test(text)) return undefined;
  const invisible: number[] = [];
  for (const m of text.matchAll(INVISIBLE)) invisible.push(m.index);
  return { text: text.replace(INVISIBLE, ''), invisible };
}

/**
 * Where in the text the on-screen unit `k` is. The invisible character `j`
 * comes after `invisible[j] - j` visible ones, which never decreases as `j`
 * grows, so the ones before unit `k` are found by a binary search.
 */
function fromScreen(seen: OnScreen, k: number): number {
  let lo = 0;
  let hi = seen.invisible.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((seen.invisible[mid] as number) - mid <= k) lo = mid + 1;
    else hi = mid;
  }
  return k + lo;
}

/** How many on-screen units come before position `at` of the text. */
function toScreen(seen: OnScreen, at: number): number {
  let lo = 0;
  let hi = seen.invisible.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((seen.invisible[mid] as number) < at) lo = mid + 1;
    else hi = mid;
  }
  return at - lo;
}

/** Every known secret's occurrences in `text`, a run of overlapping or touching ones of a secret as one span. */
function occurrences(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const secret of ordered) {
    // One secret's occurrences come in order, so an overlapping or touching one
    // extends the last span: a run of overlapping matches stays one span.
    let last: [number, number] | undefined;
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
      if (last !== undefined && at <= last[1]) {
        last[1] = at + secret.length;
      } else {
        last = [at, at + secret.length];
        spans.push(last);
      }
    }
  }
  return spans;
}

/** Whether `text` from `from` to `to` holds only invisible characters. */
function onlyInvisible(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i += 1) if (!isInvisible(text.charCodeAt(i))) return false;
  return true;
}

/**
 * Every occurrence of a known secret, replaced with MASK: as written, and as it
 * reads on screen, without its invisible characters, which are masked with it.
 *
 * Occurrences are found for every secret first, overlapping ones included, and
 * spans that overlap or touch, or are apart only by invisible characters, become
 * one MASK. Masking one secret at a time would leave the rest of an overlapping
 * one in plain view.
 */
export function redactKnownSecrets(text: string): string {
  if (ordered.length === 0) return text;
  const spans = occurrences(text);
  const seen = onScreen(text);
  if (seen !== undefined) {
    for (const [s, e] of occurrences(seen.text)) spans.push([fromScreen(seen, s), fromScreen(seen, e - 1) + 1]);
  }
  if (spans.length === 0) return text;
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let written = 0;
  let [start, end] = spans[0] as [number, number];
  for (const [s, e] of spans) {
    if (s <= end || (seen !== undefined && onlyInvisible(text, end, s))) {
      end = Math.max(end, e);
      continue;
    }
    out += text.slice(written, start) + MASK;
    written = end;
    [start, end] = [s, e];
  }
  return out + text.slice(written, start) + MASK + text.slice(end);
}

/**
 * The part of raw text that is safe to show while it may still be streaming.
 *
 * A card re-renders while an answer streams in, so a secret whose first chunk has
 * arrived would briefly show as a prefix. Trailing text that is the start of a
 * known secret is dropped; mid-stream it reappears, masked, once the rest
 * arrives. On a final render the turn ended part-way through a secret, and
 * dropping the fragment is the right outcome.
 *
 * Apply this to raw text, before redactKnownSecrets, and mask what it returns.
 * Masked first, a secret inside a longer one would hide the longer one's start.
 * A complete secret is never cut part-way: when the cut falls inside one, it
 * moves back to that secret's start, so the kept text never ends in a fragment
 * that no longer matches. A fragment split by an invisible character is
 * withheld too, as redactKnownSecrets matches one.
 */
export function withholdSecretPrefix(text: string): string {
  const keep = prefixKept(text);
  const seen = onScreen(text);
  if (seen === undefined) return text.slice(0, keep);
  const kept = prefixKept(seen.text);
  const stricter = Math.min(keep, kept >= seen.text.length ? text.length : fromScreen(seen, kept));
  return text.slice(0, settleKept(text, seen, stricter));
}

/**
 * The stricter of the two cuts may fall inside a secret complete in the other
 * form: one holding an invisible character, whole on screen but cut as written.
 * So the cut moves back to the start of any secret it falls inside, as written
 * or on screen, until it stops moving. Each move is backwards, so this ends.
 */
function settleKept(text: string, seen: OnScreen, from: number): number {
  let keep = from;
  for (let moved = true; moved; ) {
    moved = false;
    for (const secret of ordered) {
      const at = text.indexOf(secret, Math.max(0, keep - secret.length + 1));
      if (at !== -1 && at < keep) {
        keep = at;
        moved = true;
      }
    }
    let shown = toScreen(seen, keep);
    for (const secret of ordered) {
      const at = seen.text.indexOf(secret, Math.max(0, shown - secret.length + 1));
      if (at !== -1 && at < shown) {
        keep = fromScreen(seen, at);
        shown = at;
        moved = true;
      }
    }
  }
  return keep;
}

/** How much of `text` withholdSecretPrefix keeps, as written. */
function prefixKept(text: string): number {
  let cut = 0;
  for (const secret of ordered) {
    const floor = Math.max(cut, MIN_PREFIX_LENGTH - 1);
    for (let n = Math.min(secret.length - 1, text.length); n > floor; n -= 1) {
      if (text.endsWith(secret.slice(0, n))) {
        cut = n;
        break;
      }
    }
  }
  if (cut === 0) return text.length;
  let keep = text.length - cut;
  // Each move is backwards, so this ends.
  for (let moved = true; moved; ) {
    moved = false;
    for (const secret of ordered) {
      // The first occurrence that could straddle the cut: starts before it, ends after.
      const at = text.indexOf(secret, Math.max(0, keep - secret.length + 1));
      if (at !== -1 && at < keep) {
        keep = at;
        moved = true;
      }
    }
  }
  return keep;
}

/**
 * withholdSecretPrefix's mirror, for text whose start was cut away: the last
 * bytes of a gate's output. Leading text that is the end of a known secret is
 * dropped, four characters or more, so a cut through a secret leaves none of it
 * showing once the rest is masked.
 *
 * Apply this to raw text, before redactKnownSecrets, and mask what it returns. A
 * complete secret is never cut part-way: when the cut falls inside one, it moves
 * on to that secret's end. A fragment split by an invisible character is
 * dropped too.
 */
export function withholdSecretSuffix(text: string): string {
  const drop = suffixDropped(text);
  const seen = onScreen(text);
  if (seen === undefined) return text.slice(drop);
  const dropped = suffixDropped(seen.text);
  const stricter = Math.max(drop, dropped === 0 ? 0 : fromScreen(seen, dropped - 1) + 1);
  return text.slice(settleDropped(text, seen, stricter));
}

/** settleKept's mirror: the cut moves on to the end of any secret it falls inside. Each move is forwards, so this ends. */
function settleDropped(text: string, seen: OnScreen, from: number): number {
  let drop = from;
  for (let moved = true; moved; ) {
    moved = false;
    for (const secret of ordered) {
      if (drop === 0) continue;
      const at = text.lastIndexOf(secret, drop - 1);
      if (at !== -1 && at + secret.length > drop) {
        drop = at + secret.length;
        moved = true;
      }
    }
    let shown = toScreen(seen, drop);
    for (const secret of ordered) {
      if (shown === 0) continue;
      const at = seen.text.lastIndexOf(secret, shown - 1);
      if (at !== -1 && at + secret.length > shown) {
        drop = fromScreen(seen, at + secret.length - 1) + 1;
        shown = at + secret.length;
        moved = true;
      }
    }
  }
  return drop;
}

/** How much of `text`'s start withholdSecretSuffix drops, as written. */
function suffixDropped(text: string): number {
  let cut = 0;
  for (const secret of ordered) {
    const floor = Math.max(cut, MIN_PREFIX_LENGTH - 1);
    for (let n = Math.min(secret.length - 1, text.length); n > floor; n -= 1) {
      if (text.startsWith(secret.slice(secret.length - n))) {
        cut = n;
        break;
      }
    }
  }
  if (cut === 0) return 0;
  let drop = cut;
  // Each move is forwards, so this ends.
  for (let moved = true; moved; ) {
    moved = false;
    for (const secret of ordered) {
      // The last occurrence that could straddle the cut: starts before it, ends after.
      if (drop === 0) continue;
      const at = text.lastIndexOf(secret, drop - 1);
      if (at !== -1 && at + secret.length > drop) {
        drop = at + secret.length;
        moved = true;
      }
    }
  }
  return drop;
}

/**
 * Mask the string values of a JSON-shaped payload, value by value. Serialized
 * text is not masked, because JSON escaping changes a secret containing `"` or
 * `\` so that it no longer matches. A string directly under one of
 * IDENTIFYING_KEYS is left alone; an object or array there is still walked.
 * Returns the input itself when there is nothing to mask.
 *
 * `alsoIdentifying` names more keys to leave alone, for one writer's payloads:
 * the board's ids and assignee names (db/kanban.ts). They are not added to
 * IDENTIFYING_KEYS, which also exempts keys in session events and approvals,
 * whose payloads an agent shapes.
 */
export function redactValues(value: unknown, alsoIdentifying?: ReadonlySet<string>): unknown {
  if (ordered.length === 0) return value;
  return walk(value, alsoIdentifying);
}

function walk(value: unknown, also: ReadonlySet<string> | undefined): unknown {
  if (typeof value === 'string') return redactKnownSecrets(value);
  if (Array.isArray(value)) return value.map((inner) => walk(inner, also));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      const identifying = IDENTIFYING_KEYS.has(key) || also?.has(key) === true;
      out[key] = identifying && typeof inner === 'string' ? inner : walk(inner, also);
    }
    return out;
  }
  return value;
}
