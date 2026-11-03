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
 * Exact matches only. A secret the agent found by itself, a known secret encoded
 * or reformatted, and anything shorter than MIN_SECRET_LENGTH are not caught.
 *
 * This is not `mask()` in channel/escape.ts. That one shows a secret's prefix in a
 * render that means to show the secret.
 */

import { stripControl } from './text.js';

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

const secrets = new Set<string>();
/** Longest first. Rebuilt on change. */
let ordered: string[] = [];

function reorder(): void {
  ordered = [...secrets].sort((a, b) => b.length - a.length);
}

/**
 * The forms a value is known by: itself, and itself with control characters
 * stripped, because the escapers strip before they match. A form shorter than
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
  return out;
}

export function addSecrets(values: Iterable<string>): void {
  for (const value of values) for (const form of forms(value)) secrets.add(form);
  reorder();
}

// The registry is a plain set: plan C must reference-count, or keep configured
// secrets apart, or removing a worker token equal to a configured secret unmasks it.
export function removeSecrets(values: Iterable<string>): void {
  for (const value of values) for (const form of forms(value)) secrets.delete(form);
  reorder();
}

/** Test-only: the registry is process-wide. */
export function clearSecrets(): void {
  secrets.clear();
  reorder();
}

/**
 * Every exact occurrence of a known secret, replaced with MASK.
 *
 * Occurrences are found for every secret first, overlapping ones included, and
 * spans that overlap or touch become one MASK. Masking one secret at a time would
 * leave the rest of an overlapping one in plain view.
 */
export function redactKnownSecrets(text: string): string {
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
  if (spans.length === 0) return text;
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let written = 0;
  let [start, end] = spans[0] as [number, number];
  for (const [s, e] of spans) {
    if (s <= end) {
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
 * that no longer matches.
 */
export function withholdSecretPrefix(text: string): string {
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
  if (cut === 0) return text;
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
  return text.slice(0, keep);
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
