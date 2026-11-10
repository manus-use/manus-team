import { copyFileSync, fstatSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The service's log, `$MT_HOME/logs/gateway.log`, which launchd or systemd
 * opens for the gateway's stdout and stderr, both, appending.
 *
 * Rotated by size when the gateway starts, so every restart, a deploy's or a
 * crash's, keeps it bounded with no newsyslog or logrotate set up: a log over
 * LOG_MAX_BYTES is copied to `gateway.log.1`, replacing the one before, and
 * emptied in place. In place, not renamed, because the file launchd or systemd
 * opened is the one the gateway's stdout still writes to, appending; a rename
 * would leave it writing to `.1`. Only when the gateway's own stdout is that
 * file, so a gateway run by hand, `npm run dev`, never empties the service's log.
 */

export const LOG_MAX_BYTES = 10 * 1024 * 1024;

export function serviceLogPath(mtHome: string): string {
  return join(mtHome, 'logs', 'gateway.log');
}

/** Copy `path` to `path.1` and empty it, when it is over `maxBytes`. True when it was rotated. */
export function rotateLog(path: string, maxBytes: number): boolean {
  const st = statSync(path, { throwIfNoEntry: false });
  if (st === undefined || !st.isFile() || st.size <= maxBytes) return false;
  copyFileSync(path, `${path}.1`);
  truncateSync(path, 0);
  return true;
}

/** Rotate the service's log at start, when this process's stdout is it. True when it was rotated. */
export function rotateOwnLog(
  mtHome: string,
  stdout: () => { dev: number; ino: number } = () => fstatSync(1),
  maxBytes: number = LOG_MAX_BYTES,
): boolean {
  const path = serviceLogPath(mtHome);
  const st = statSync(path, { throwIfNoEntry: false });
  if (st === undefined) return false;
  const out = stdout();
  if (out.dev !== st.dev || out.ino !== st.ino) return false;
  return rotateLog(path, maxBytes);
}
