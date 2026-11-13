import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findNpm, shQuote } from '../src/cli/shell.js';
import { finishByHand, stepsBack, stepsForward, type AdvicePaths } from '../src/cli/update-advice.js';

/**
 * The blocks mt update prints for a person (spec §20.6, §20.7, §20.9): mt and
 * npm named by their paths, quoted, the node's directory first on PATH, and the
 * home exported when it is not the default.
 */

const P: AdvicePaths = {
  node: "/opt/node 22/bin/node",
  npm: "/opt/node 22/bin/npm",
  checkout: "/src/it's here",
  home: '/srv/team home',
  homeSet: true,
  db: '/srv/team home/team.db',
  service: true,
};
const MT = `PATH='/opt/node 22/bin':"$PATH" '/opt/node 22/bin/node' '/src/it'\\''s here/dist/mt.js'`;
const NPM = `PATH='/opt/node 22/bin':"$PATH" '/opt/node 22/bin/npm'`;

describe('shQuote', () => {
  it("quotes as install.sh does, a single quote as '\\''", () => {
    expect(shQuote("a b'c")).toBe(`'a b'\\''c'`);
  });
});

describe('findNpm', () => {
  it('takes the npm beside the node, else the first on PATH, else none', () => {
    const root = mkdtempSync(join(tmpdir(), 'mt-npm-'));
    try {
      for (const d of ['node', 'path1', 'path2']) mkdirSync(join(root, d));
      const write = (path: string): void => {
        writeFileSync(path, '#!/bin/sh\n');
        chmodSync(path, 0o755);
      };
      write(join(root, 'path2', 'npm'));
      const path = `${join(root, 'path1')}:relative:${join(root, 'path2')}`;
      expect(findNpm(join(root, 'node', 'node'), path)).toBe(join(root, 'path2', 'npm'));
      write(join(root, 'node', 'npm'));
      expect(findNpm(join(root, 'node', 'node'), path)).toBe(join(root, 'node', 'npm'));
      expect(findNpm(join(root, 'path1', 'node'), join(root, 'path1'))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the steps back', () => {
  it('stop the service, go back, build, restore the backup over the database, and start it', () => {
    expect(stepsBack(P, { old: '8b64aa1', backup: '/srv/team home/backups/team-v8-8b64aa1-20261112T153000Z.db' })).toEqual([
      "export MT_HOME='/srv/team home'",
      `${MT} service stop`,
      `cd '/src/it'\\''s here'`,
      'git reset --keep 8b64aa1',
      `${NPM} ci && ${NPM} run build`,
      "rm -f '/srv/team home/team.db-wal' '/srv/team home/team.db-shm'",
      "cp '/srv/team home/backups/team-v8-8b64aa1-20261112T153000Z.db' '/srv/team home/team.db'",
      `${MT} service start`,
    ]);
  });

  it('leave the restore out with no backup, and the export with the default home', () => {
    expect(stepsBack({ ...P, homeSet: false }, { old: '8b64aa1', backup: undefined })).toEqual([
      `${MT} service stop`,
      `cd '/src/it'\\''s here'`,
      'git reset --keep 8b64aa1',
      `${NPM} ci && ${NPM} run build`,
      `${MT} service start`,
    ]);
  });

  it('read the version again after the stop, when the service started again on its own', () => {
    const lines = stepsBack(P, { old: '8b64aa1', backup: undefined, checkVersion: 8 });
    expect(lines[3]).toBe(
      `${MT} service check  # it should print "at version 8": if it does, or prints "database: unknown (...)", or nothing, go on; ` +
        'if it prints another version, follow the steps forward instead',
    );
    expect(lines[2]).toBe(`cd '/src/it'\\''s here'`);
  });

  it('split the restart of a gateway run by hand around the restore', () => {
    expect(stepsBack({ ...P, service: false }, { old: '8b64aa1', backup: '/b.db' })).toEqual([
      "export MT_HOME='/srv/team home'",
      '# stop the gateway, if it runs',
      `cd '/src/it'\\''s here'`,
      'git reset --keep 8b64aa1',
      `${NPM} ci && ${NPM} run build`,
      "rm -f '/srv/team home/team.db-wal' '/srv/team home/team.db-shm'",
      "cp '/b.db' '/srv/team home/team.db'",
      '# then start it',
    ]);
  });
});

describe('the steps forward', () => {
  it('make the new tree whole, check it and restart the service', () => {
    expect(stepsForward(P)).toEqual([
      "export MT_HOME='/srv/team home'",
      `cd '/src/it'\\''s here'`,
      `${NPM} ci && ${NPM} run build`,
      `${MT} service check`,
      `${MT} service restart`,
    ]);
  });

  it('say to restart a gateway run by hand', () => {
    expect(stepsForward({ ...P, service: false, homeSet: false }).slice(-1)).toEqual(['# restart the gateway (stop it if it runs, then start it)']);
  });
});

describe('the commands to finish by hand', () => {
  it('build in the checkout, with the reset when it is what failed', () => {
    expect(finishByHand(P, { reset: undefined })).toEqual(["export MT_HOME='/srv/team home'", `cd '/src/it'\\''s here' && ${NPM} ci && ${NPM} run build`]);
    expect(finishByHand({ ...P, homeSet: false }, { reset: '8b64aa1' })).toEqual([
      `cd '/src/it'\\''s here' && git reset --keep 8b64aa1 && ${NPM} ci && ${NPM} run build`,
    ]);
  });
});
