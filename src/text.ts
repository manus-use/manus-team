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
