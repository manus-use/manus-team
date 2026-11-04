import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * A run's worker token (spec §7.2): its authority to report on its own task,
 * and to comment on and create tasks, for as long as the run is open.
 *
 * 256 random bits, base64url: 43 characters, none of which a shell or JSON
 * needs to quote. Only its SHA-256 is stored, as the run's `token_hash`; the
 * token itself lives in the dispatcher's memory, the run's environment and the
 * masker, and nowhere else.
 */

/** A token as mintToken makes one. Anything else is refused before it is hashed. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The hash a run stores: SHA-256, lower-case hex. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Whether two token hashes are the same, compared in constant time. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}
