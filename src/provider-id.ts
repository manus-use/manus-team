/**
 * Whether a stored provider session id is one a driver may hand back to its agent
 * to resume (architecture §6.3, native resume): one argv word, starting with a letter or
 * a digit, so it can never be read as a flag, and at most 200 characters.
 *
 * A `cli:<nonce>` id, which the CLI driver stored before it could resume, is not
 * one: it names a runtime, not a provider's session. So it is never passed back
 * as `--session`, never seeds a rework (spec §5.3), and never shows in `/status`.
 */
const RESUMABLE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

export function isResumableProviderId(id: unknown): id is string {
  return typeof id === 'string' && RESUMABLE.test(id);
}
