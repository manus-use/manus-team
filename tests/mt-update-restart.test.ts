import { appendFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearSecrets } from '../src/secrets.js';
import { OLD, TOP, startupLines, updateFake, type UpdateFake } from './helpers/update.js';

/**
 * `mt update`'s step 7 (spec §20.9): `mt service restart`'s own code, then the
 * service log read past where it was for `connected as` after the schema
 * line, for up to 60 seconds; else the log's tail and the steps back, exit 3,
 * never an automatic going back.
 */

let fx: UpdateFake;
afterEach(() => {
  clearSecrets();
  fx.cleanup();
});

const log = (): string => join(fx.mtHome, 'logs', 'gateway.log');
const NPM = (): string => `PATH='${join(fx.root, 'node bin')}':"$PATH" '${fx.npm}'`;
const MT = (): string => `PATH='${join(fx.root, 'node bin')}':"$PATH" '${fx.node}' '${join(fx.checkout, 'dist', 'mt.js')}'`;
const backup = (): string => join(fx.mtHome, 'backups', readdirSync(join(fx.mtHome, 'backups'))[0] ?? '');

function stepsBack(): string {
  return [
    `  ${MT()} service stop`,
    `  cd '${fx.checkout}'`,
    `  git reset --keep ${OLD}`,
    `  ${NPM()} ci && ${NPM()} run build`,
    `  rm -f '${fx.dbPath}-wal' '${fx.dbPath}-shm'`,
    `  cp '${backup()}' '${fx.dbPath}'`,
    `  ${MT()} service start`,
  ].join('\n');
}

describe('the confirmation', () => {
  it('is connected as, after the schema line', async () => {
    fx = await updateFake();
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('restarting team.manus.gateway');
    expect(r.out).toContain(`the gateway is connected, at schema version ${TOP}`);
  });

  it('is not the schema line alone: none in 60 seconds is the log\'s tail and the steps back, exit 3', async () => {
    fx = await updateFake();
    fx.onStart = () => appendFileSync(log(), `2026-11-12T15:31:00.000Z schema at version ${TOP} (${fx.dbPath})\n`);
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.err).toBe('mt: the new gateway did not say it connected within 60 seconds');
    expect(fx.slept).toBe(60_000);
    expect(r.out).toContain(`the service log's last 30 lines:\n  2026-11-12T09:00:00.000Z connected as ou_bot\n  2026-11-12T15:31:00.000Z schema at version ${TOP}`);
    expect(r.out).toContain(`a restore loses what it wrote since the backup:\n${stepsBack()}`);
    expect(fx.repo.head).not.toBe(OLD);
  });

  it('is not a connected line from before the restart', async () => {
    fx = await updateFake();
    fx.onStart = () => {};
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
  });

  it('is found after the log was rotated at the start, reading it from its beginning', async () => {
    fx = await updateFake();
    appendFileSync(log(), 'x'.repeat(5000) + '\n');
    fx.onStart = () => writeFileSync(log(), startupLines(TOP, fx.dbPath));
    expect((await fx.update(['--yes'])).code).toBe(0);
  });

  it('warns of a version below the new tree\'s highest', async () => {
    fx = await updateFake();
    fx.onStart = () => appendFileSync(log(), startupLines(TOP - 1, fx.dbPath));
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`warning: the gateway is at schema version ${TOP - 1}, below the new tree's ${TOP}`);
  });

  for (const line of ['configuration error: the database at /x is at schema version 9', 'failed to start: Error: boom']) {
    it(`ends the wait at once at ${line.split(':')[0]}:`, async () => {
      fx = await updateFake();
      fx.onStart = () => appendFileSync(log(), `2026-11-12T15:31:00.000Z no config file\n${line}\n`);
      const r = await fx.update(['--yes']);
      expect(r.code).toBe(3);
      expect(r.err).toBe(`mt: the new gateway did not start: ${line}`);
      expect(fx.slept).toBe(0);
      expect(r.out).toContain(stepsBack());
    });
  }
});

describe('the restart call', () => {
  it('that fails is exit 3, with its error and the steps back', async () => {
    fx = await updateFake();
    fx.override = (c) => (c.args[0] === 'kill' ? { code: 3, stderr: 'Boot-out failed: 3: No such process' } : undefined);
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.err).toBe('mt: the restart failed: launchctl kill SIGTERM gui/501/team.manus.gateway failed (exit 3): Boot-out failed: 3: No such process');
    expect(r.out).toContain(`whether one runs, and which, is for ${MT()} service status`);
    expect(r.out).toContain(stepsBack());
  });

  it("is systemctl restart on Linux", async () => {
    fx = await updateFake();
    fx.install({ platform: 'linux' });
    fx.job.pid = 4242;
    const r = await fx.update(['--yes'], { platform: 'linux' });
    expect(r.code).toBe(0);
    expect(fx.words()).toContain('systemctl --user restart manus-team.service');
  });

  it('prints the steps back for a home other than the default with its export', async () => {
    fx = await updateFake();
    const home = fx.mtHome;
    fx.install({ mtHomeSet: home });
    fx.job.pid = 4242;
    fx.onStart = () => {};
    const r = await fx.update(['--yes'], { env: { MT_HOME: home } });
    expect(r.code).toBe(3);
    expect(r.out).toContain(`a restore loses what it wrote since the backup:\n  export MT_HOME='${home}'\n  ${MT()} service stop`);
  });
});
