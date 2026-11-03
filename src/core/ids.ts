import { createHash, randomBytes } from 'node:crypto';

/**
 * Identifier minting. Two families live here, and they must not be confused.
 *
 * - **Random** ids (`newSessionId`, `newTurnId`, `newApprovalId`) name a thing
 *   that did not exist before. They are unguessable and never reproducible.
 * - **Derived** ids (`sendUuid`, `approvalNonce`) are pure functions of facts
 *   already in the log. Recomputing one after a crash yields the same value,
 *   which is the entire mechanism behind idempotent retry.
 *
 * Using a random id where a derived one belongs turns an idempotent retry into a
 * duplicate. Using a derived id where a random one belongs makes it guessable.
 *
 * Every derived id joins its inputs with `SEP`, and it is spelled as an escape
 * rather than typed as a raw byte: a literal NUL in the source makes this file
 * binary to git -- no reviewable diff -- and any editor that quietly strips it
 * would silently change every value computed here, breaking send dedup and
 * approval nonces across the change with nothing to show why.
 */

/**
 * Field separator for a canonical string.
 *
 * NUL cannot occur in any id the platform mints, so joining with it makes the
 * encoding unambiguous: no combination of inputs can produce the same canonical
 * string as a different combination.
 */
const SEP = '\u0000';

/** Base32-ish, lowercase, no vowels lookalikes. Readable in a chat transcript. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

function randomToken(bytes: number): string {
  const buf = randomBytes(bytes);
  let out = '';
  for (const b of buf) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function newSessionId(): string {
  return `s_${randomToken(16)}`;
}

export function newTurnId(): string {
  return `t_${randomToken(12)}`;
}

export function newApprovalId(): string {
  return `a_${randomToken(12)}`;
}

/** A kanban task (spec §3.1). Opaque: nothing reads meaning into it. */
export function newTaskId(): string {
  return `k_${randomToken(12)}`;
}

/** One attempt at a kanban task (spec §3.3). */
export function newRunId(): string {
  return `r_${randomToken(12)}`;
}

/**
 * A per-process boot id, minted once at import time.
 *
 * Bound into every callback token so that a button rendered before a restart
 * cannot resolve against the process that came after it. The generation CAS
 * catches the cases where session state moved on; this catches the case where it
 * did not move on but the in-memory runtime it referred to is simply gone.
 */
export const BOOT_ID = randomToken(10);

/**
 * The `uuid` field on an IM send.
 *
 * Feishu deduplicates sends by this value for exactly one hour, returning the
 * original `message_id` for a repeat. That makes a send idempotent against the
 * event log: replaying after a crash reuses the message rather than posting the
 * answer twice.
 *
 * `appId` is in the canonical string on purpose. Two bots writing identical text
 * to the same chat are two distinct effects, not a duplicate of one -- keying
 * without it would let one bot's send swallow the other's.
 *
 * Truncated to 50 characters because that is the field's limit. Truncating a
 * hex sha256 keeps 200 bits, so collisions are not a consideration.
 */
export function sendUuid(appId: string, sessionId: string, eventSeq: number): string {
  const canonical = [appId, sessionId, eventSeq].join(SEP);
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 50);
}

/**
 * The `uuid` for a control reply -- a rejection, an error, `/help` output.
 *
 * Keyed on the inbound message rather than on an event seq, because these replies
 * are not events in any session's log: there may not be a session at all. Feishu's
 * re-push ladder can deliver one message four times over six hours, and without
 * this the user gets four copies of the same refusal.
 */
export function replyUuid(appId: string, messageId: string, purpose: string): string {
  const canonical = [appId, messageId, purpose].join(SEP);
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 50);
}

/**
 * The opaque value carried in a card button's `action.value`.
 *
 * This round-trips through the client and Lark does **not** verify it, so it is
 * untrusted input on the way back. It is therefore a *pointer*, not a claim:
 * it says which approval and which generation the card was rendered for, and
 * nothing about who clicked. Identity comes from `operator.openId` on the
 * callback, never from here.
 *
 * The HMAC-free hash is sufficient because the value grants nothing on its own
 * -- `resolveApproval` re-checks the generation against the log before acting.
 * A signature would only prove the card was ours, which is not the property that
 * was ever in doubt.
 */
export function approvalNonce(sessionId: string, approvalId: string, generation: number): string {
  const canonical = [BOOT_ID, sessionId, approvalId, generation].join(SEP);
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Idempotency key for a turn, derived from the inbound message that caused it.
 *
 * Keyed on `message_id`, which is stable across Feishu's re-push ladder, so a
 * redelivery that somehow got past `seen_messages` still cannot open a second
 * turn.
 */
export function turnIdempotencyKey(appId: string, messageId: string): string {
  const canonical = [appId, messageId].join(SEP);
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}
