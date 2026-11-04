import { writeSync } from 'node:fs';
import { inspect } from 'node:util';
import { redactKnownSecrets, withholdSecretPrefix } from './secrets.js';

/**
 * A crash's last words, masked (spec §10.1). Left to itself, Node prints an
 * uncaught exception or an unhandled rejection with its message and stack, as
 * they are -- and an error can carry anything: an agent's stderr, a key in a
 * failed request, a run's token. These handlers print it through the masker
 * instead, then exit with 1, the code Node itself exits with for both.
 *
 * Nothing is drained and nothing is closed: after an uncaught error the
 * process's state is unknown, and the next boot reconciles what was running
 * (spec §8.4).
 */

/** What the handlers are installed on: the process, or a test's stand-in. */
export interface CrashSource {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (err: unknown) => void): unknown;
}

/** The longest a crash report's error is shown, in characters; the rest is cut. */
export const CRASH_REPORT_CHARS = 64 * 1024;

/**
 * The one line a crash prints: what happened, and the error as Node would show it, masked.
 *
 * Masking inspect's text alone is not enough. It cuts a long string before the
 * masker sees it, which can leave a secret's start showing, and it escapes `\`
 * and quotes, so that a secret holding them no longer matches. So the error's
 * strings are masked first, value by value (maskDeep), and inspect, shown them
 * whole, is masked again; the text is cut only after that.
 */
export function crashReport(what: string, err: unknown): string {
  const shown = redactKnownSecrets(inspect(maskDeep(err, new WeakMap()), { maxStringLength: Infinity }));
  const text = shown.length <= CRASH_REPORT_CHARS ? shown : `${withholdSecretPrefix(shown.slice(0, CRASH_REPORT_CHARS))} [cut]`;
  return `${what}: ${text}\n`;
}

/** An error's fields that inspect shows though they are not enumerable. */
const ERROR_FIELDS = ['stack', 'message', 'cause', 'errors'] as const;

/**
 * A copy of `value` with every string inspect would show masked: strings, and,
 * in arrays, plain objects and errors, their own enumerable properties, and an
 * error's message, stack, cause and errors, however deep. A cycle maps to the
 * copy, so inspect still shows it as one.
 *
 * No getter of a property inspect leaves alone is called: it is copied as it is,
 * and inspect shows `[Getter]`. An error's own field read through a getter that
 * throws is left out. Any other object -- a Map, a class's instance -- is kept as
 * it is, and only the masking of inspect's text covers it.
 */
function maskDeep(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return redactKnownSecrets(value);
  if (value === null || typeof value !== 'object') return value;
  const done = seen.get(value);
  if (done !== undefined) return done;
  const isError = value instanceof Error;
  const proto: unknown = Object.getPrototypeOf(value);
  let copy: object;
  if (Array.isArray(value)) copy = new Array<unknown>(value.length);
  else if (isError) copy = Object.create(proto as object) as object;
  else if (proto === null || proto === Object.prototype) copy = Object.create(proto as object | null) as object;
  else return value;
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc === undefined || (key === 'length' && Array.isArray(value))) continue;
    const field = isError && (ERROR_FIELDS as readonly PropertyKey[]).includes(key);
    if (!desc.enumerable && !field) continue;
    if ('value' in desc) {
      Object.defineProperty(copy, key, { ...desc, value: maskDeep(desc.value, seen) });
    } else if (field) {
      let read: unknown;
      try {
        read = desc.get?.call(value);
      } catch {
        continue;
      }
      Object.defineProperty(copy, key, { value: maskDeep(read, seen), enumerable: desc.enumerable ?? false, configurable: true, writable: true });
    } else {
      Object.defineProperty(copy, key, desc);
    }
  }
  return copy;
}

/**
 * Writes to stderr synchronously, so the report is out before `exit`: a write to
 * process.stderr may still be queued, on a pipe, when the process ends. What a
 * synchronous write cannot take -- a non-blocking pipe that is full -- goes
 * through process.stderr instead.
 */
export function stderrWriter(
  sync: (fd: number, buf: Buffer) => number = writeSync,
  fallback: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): (text: string) => void {
  return (text) => {
    const buf = Buffer.from(text, 'utf8');
    let at = 0;
    try {
      while (at < buf.length) at += sync(2, buf.subarray(at));
    } catch {
      fallback(buf.subarray(at).toString('utf8'));
    }
  };
}

export function installCrashHandlers(
  source: CrashSource = process,
  write: (text: string) => void = stderrWriter(),
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  const crash = (what: string) => (err: unknown) => {
    try {
      let text: string;
      try {
        text = crashReport(what, err);
      } catch {
        // An error whose inspection throws: say at least what happened.
        text = `${what}: (the error could not be shown)\n`;
      }
      try {
        write(text);
      } catch {
        // Nowhere left to say it; the exit still says something went wrong.
      }
    } finally {
      exit(1);
    }
  };
  source.on('uncaughtException', crash('uncaught exception'));
  source.on('unhandledRejection', crash('unhandled rejection'));
}
