/**
 * Strip control characters that corrupt a card payload.
 *
 * Tab, newline and carriage return survive; everything else in C0/C1 goes. A raw
 * control byte inside a JSON string is rejected by the API with an error that
 * names the whole payload rather than the offending byte, which is far more
 * expensive to debug than it is to prevent here. U+FFFE and U+FFFF are
 * non-characters and are dropped for the same reason.
 *
 * Its own module so that both the escapers and the secret registry can use it
 * without importing each other.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]/gu;

export function stripControl(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}

/**
 * The characters that reorder what follows them: the bidi embeddings and
 * overrides, U+202A to U+202E, and the isolates, U+2066 to U+2069.
 */
export const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;

/**
 * The characters that show nothing: the bidi controls (`BIDI`), the zero-width
 * space, non-joiner and joiner (U+200B to U+200D), the byte order mark (U+FEFF),
 * and the direction marks (U+200E, U+200F, U+061C). Split by one, a word still
 * reads whole on screen.
 */
export const INVISIBLE = /[\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Whether `code`, one UTF-16 unit, is one of `INVISIBLE`'s characters. */
export function isInvisible(code: number): boolean {
  return (
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}
