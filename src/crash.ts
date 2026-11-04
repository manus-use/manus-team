import { writeSync } from 'node:fs';
import { inspect } from 'node:util';
import { redactKnownSecrets } from './secrets.js';

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

/** The one line a crash prints: what happened, and the error as Node would show it, masked. */
export function crashReport(what: string, err: unknown): string {
  return `${what}: ${redactKnownSecrets(inspect(err))}\n`;
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
