import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateDir } from '../kanban/socket.js';
import { checkZone } from './schedule.js';

/**
 * The gateway's zone, as the terminal reads it (the cron spec, §2.2, §10):
 * `$MT_HOME/run/gateway.tz`, written at each start, once the home is held, with
 * the zone the gateway uses, `cron.tz` or its resolved one. `0600` in the
 * private directory, written whole and renamed into place.
 */

export function gatewayZonePath(home: string): string {
  return join(home, 'run', 'gateway.tz');
}

export function writeGatewayZone(home: string, zone: string): void {
  const dir = join(home, 'run');
  privateDir(dir, "the gateway's zone");
  const staging = join(dir, `.gateway.tz-${randomUUID()}`);
  try {
    writeFileSync(staging, `${zone}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(staging, gatewayZonePath(home));
  } finally {
    rmSync(staging, { force: true });
  }
}

/** The zone the gateway last recorded, or undefined for none, or one that is no zone. */
export function readGatewayZone(home: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(gatewayZonePath(home), 'utf8').trim();
  } catch {
    return undefined;
  }
  const zone = checkZone(text);
  return zone.ok ? zone.zone : undefined;
}
