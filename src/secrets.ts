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

export const MASK = '••••';

/** Shorter values are not secrets: masking `1` or `true` would mangle ordinary text. */
export const MIN_SECRET_LENGTH = 8;

/** A trailing fragment shorter than this is too common to be worth withholding. */
const MIN_PREFIX_LENGTH = 4;

/**
 * Keys whose values identify rather than say something. They are left alone, as
 * identifying columns are: masking an id would break the lookups that use it.
 * Workspace and assignee names identify too (spec §10.1).
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
/** Longest first, so a secret containing another is masked whole. Rebuilt on change. */
let ordered: string[] = [];

function reorder(): void {
  ordered = [...secrets].sort((a, b) => b.length - a.length);
}

export function addSecrets(values: Iterable<string>): void {
  for (const value of values) if (value.length >= MIN_SECRET_LENGTH) secrets.add(value);
  reorder();
}

export function removeSecrets(values: Iterable<string>): void {
  for (const value of values) secrets.delete(value);
  reorder();
}

/** Test-only: the registry is process-wide. */
export function clearSecrets(): void {
  secrets.clear();
  reorder();
}

/** Every exact occurrence of a known secret, replaced with MASK. */
export function redactKnownSecrets(text: string): string {
  let out = text;
  for (const secret of ordered) {
    if (out.includes(secret)) out = out.split(secret).join(MASK);
  }
  return out;
}

/**
 * Drop trailing text that is the start of a known secret.
 *
 * A card re-renders while an answer streams in, so a secret whose first chunk has
 * arrived would briefly show as a prefix. Mid-stream the fragment reappears,
 * masked, once the rest arrives. On a final render the turn ended part-way through
 * a secret, and dropping the fragment is the right outcome.
 *
 * Apply this to text that has already been through redactKnownSecrets. Otherwise
 * the tail of a complete secret could be cut, leaving it unmatched.
 */
export function withholdSecretPrefix(text: string): string {
  let cut = 0;
  for (const secret of ordered) {
    for (let n = Math.min(secret.length - 1, text.length); n >= MIN_PREFIX_LENGTH; n -= 1) {
      if (n > cut && text.endsWith(secret.slice(0, n))) {
        cut = n;
        break;
      }
    }
  }
  return cut === 0 ? text : text.slice(0, text.length - cut);
}

/**
 * Mask the string values of a JSON-shaped payload, value by value. Serialized
 * text is not masked, because JSON escaping changes a secret containing `"` or
 * `\` so that it no longer matches. Values under IDENTIFYING_KEYS are left alone.
 * Returns the input itself when there is nothing to mask.
 */
export function redactValues(value: unknown): unknown {
  if (ordered.length === 0) return value;
  return walk(value);
}

function walk(value: unknown): unknown {
  if (typeof value === 'string') return redactKnownSecrets(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = IDENTIFYING_KEYS.has(key) ? inner : walk(inner);
    }
    return out;
  }
  return value;
}
