import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { highestMigration, migrate, openDb } from '../src/db/open.js';
import { MASK, clearSecrets, redactKnownSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { SECRET, serviceConfig, serviceFake, type ServiceFake } from './helpers/service.js';

/**
 * `mt service check` (spec §20.5): the database's version line first, whatever
 * follows; with a unit, install's check of the configuration, with the PATH the
 * unit records; last, the gateway's modules and the native module, loaded. No
 * launchctl or systemctl call, and nothing under the real home.
 */

let fx: ServiceFake;
afterEach(() => {
  clearSecrets();
  fx.cleanup();
});

const TOP = highestMigration(SCHEMA_DIR);

async function check(env: Record<string, string | undefined> = {}): Promise<{ code: number; out: string[]; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMt(['service', 'check'], {
    env: { PATH: '/opt/my tools/bin:/usr/bin:/bin', HOME: fx.home, ...env },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    service: fx.deps(),
  });
  return { code, out, err: err.join('\n') };
}

/** The gateway's database, migrated to `version`. */
function database(version = TOP): string {
  const path = join(fx.mtHome, 'team.db');
  const db = openDb(path);
  migrate(db, SCHEMA_DIR);
  db.pragma(`user_version = ${version}`);
  db.close();
  return path;
}

describe('mt service check with a unit', () => {
  it('prints the version line first, checks as the unit starts the gateway, loads the modules, and calls no manager', async () => {
    fx = await serviceFake();
    fx.install({ path: '/unit/bin:/usr/bin' });
    const db = database();
    const r = await check();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      `database: ${db} at version ${TOP}; this build: up to ${TOP}`,
      `checking as team.manus.gateway starts it: with PATH /unit/bin:/usr/bin, MT_HOME ${fx.mtHome} and ${join(fx.mtHome, '.env')}`,
      'ok: this build would start as team.manus.gateway',
    ]);
    expect(fx.imports).toEqual([join(fx.checkout, 'dist', 'index.js'), join(fx.checkout, 'dist', 'db', 'open.js')]);
    expect(fx.calls).toEqual([]);
  });

  it('says there is no database when there is none', async () => {
    fx = await serviceFake();
    fx.install();
    const r = await check();
    expect(r.out[0]).toBe(`database: ${join(fx.mtHome, 'team.db')}: no database; this build: up to ${TOP}`);
  });

  it("refuses without the gateway's .env, after the version line", async () => {
    fx = await serviceFake({ env: false });
    fx.install();
    const r = await check({ LARK_APP_SECRET: SECRET });
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(/^database: .*: no database; this build: up to \d+$/);
    expect(r.err).toMatch(/\.env does not exist\. The service starts with no shell environment/);
    expect(fx.imports).toEqual([]);
  });

  it('refuses a .env that does not set LARK_APP_SECRET, even when this shell does', async () => {
    fx = await serviceFake({ env: 'LARK_APP_ID=cli_test\n' });
    fx.install();
    const r = await check({ LARK_APP_SECRET: SECRET });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/does not set LARK_APP_SECRET/);
    expect(r.out.join('\n') + r.err).not.toContain(SECRET);
  });

  it('refuses a configuration the gateway would not start on as the service, naming the problem', async () => {
    fx = await serviceFake({ config: `workspace: /tmp\nagent:\n  driver: acp\n  command: claude-agent-acp\n` });
    fx.install();
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mt: the gateway would not start as the service, which has only PATH, MT_HOME and .*\.env: an owner is required/);
  });

  it('warns of every passEnv name, which the service will not have', async () => {
    fx = await serviceFake();
    writeFileSync(join(fx.mtHome, 'config.yaml'), serviceConfig(join(fx.root, 'repo'), '  passEnv: [GH_TOKEN]\n'));
    fx.install();
    const r = await check({ GH_TOKEN: 'ghp_never_printed' });
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toMatch(/warning: role default names GH_TOKEN in agent\.passEnv/);
    expect(r.out.join('\n') + r.err).not.toContain('ghp_never_printed');
  });

  it('refuses a unit mt service install did not write, saying to write it again', async () => {
    fx = await serviceFake();
    const file = fx.install();
    writeFileSync(file, '<plist>edited by hand</plist>\n');
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(/^database: /);
    expect(r.err).toBe(`mt: ${file} was not written by mt service install; run mt service install to write it again`);
  });
});

describe("mt service check's version line", () => {
  it('names a schema directory MT_SCHEMA_DIR sets, as the gateway reads it', async () => {
    fx = await serviceFake();
    const dir = join(fx.root, 'other schema');
    mkdirSync(dir);
    writeFileSync(join(dir, '001_only.sql'), 'SELECT 1;');
    writeFileSync(join(fx.mtHome, '.env'), `LARK_APP_SECRET=${SECRET}\nLARK_APP_ID=cli_test\nMT_SCHEMA_DIR=${dir}\n`);
    chmodSync(join(fx.mtHome, '.env'), 0o600);
    fx.install();
    const r = await check();
    expect(r.out[0]).toBe(`database: ${join(fx.mtHome, 'team.db')}: no database; this build: up to 1 (migrations from ${dir}, MT_SCHEMA_DIR)`);
  });

  it('is database: unknown when the settings are refused, and the check then fails at the same error', async () => {
    fx = await serviceFake({ config: 'workspace: [not, a, path\n' });
    fx.install();
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(/^database: unknown \(.*config\.yaml/);
    expect(r.err).toMatch(/config\.yaml/);
  });

  it('is printed when the import of the gateway fails, which fails the check', async () => {
    fx = await serviceFake();
    fx.install();
    database(3);
    fx.modules[join(fx.checkout, 'dist', 'index.js')] = new SyntaxError("Unexpected token '?'");
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.out[0]).toBe(`database: ${join(fx.mtHome, 'team.db')} at version 3; this build: up to ${TOP}`);
    expect(r.err).toBe(`mt: the gateway's modules do not load from ${join(fx.checkout, 'dist', 'index.js')}: Unexpected token '?'`);
  });

  it('is printed when the native module fails to load, and the refusal names the npm ci to run, by its paths', async () => {
    fx = await serviceFake();
    fx.install();
    writeFileSync(join(fx.root, 'node bin', 'npm'), '#!/bin/sh\n', { mode: 0o755 });
    fx.modules[join(fx.checkout, 'dist', 'db', 'open.js')] = {
      openDb: () => {
        throw new Error('was compiled against a different Node.js version using NODE_MODULE_VERSION 131');
      },
    };
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(/^database: /);
    expect(r.err).toBe(
      `mt: better-sqlite3's native module does not load under ${fx.node}: was compiled against a different Node.js version using NODE_MODULE_VERSION 131. ` +
        `Build it for this node by hand: cd '${fx.checkout}' && PATH='${join(fx.root, 'node bin')}':"$PATH" '${join(fx.root, 'node bin', 'npm')}' ci`,
    );
  });
});

describe("mt service check's version line and native load, further", () => {
  it('names the npm on the unit\'s PATH when the native module fails to load, not the shell\'s', async () => {
    fx = await serviceFake();
    const unitBin = join(fx.root, 'unit bin');
    mkdirSync(unitBin);
    writeFileSync(join(unitBin, 'npm'), '#!/bin/sh\n', { mode: 0o755 });
    const shellBin = join(fx.root, 'shell bin');
    mkdirSync(shellBin);
    writeFileSync(join(shellBin, 'npm'), '#!/bin/sh\n', { mode: 0o755 });
    fx.install({ path: `${unitBin}:/usr/bin` });
    fx.modules[join(fx.checkout, 'dist', 'db', 'open.js')] = {
      openDb: () => {
        throw new Error('was compiled against a different Node.js version');
      },
    };
    const r = await check({ PATH: `${shellBin}:/usr/bin:/bin` });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`'${join(unitBin, 'npm')}' ci`);
  });

  it("still names the database and its version when MT_SCHEMA_DIR's directory is missing, the build's highest unknown", async () => {
    fx = await serviceFake();
    const db = database(3);
    const dir = join(fx.root, 'no such schema');
    writeFileSync(join(fx.mtHome, '.env'), `LARK_APP_SECRET=${SECRET}\nLARK_APP_ID=cli_test\nMT_SCHEMA_DIR=${dir}\n`);
    chmodSync(join(fx.mtHome, '.env'), 0o600);
    fx.install();
    const r = await check();
    expect(r.out[0]).toMatch(new RegExp(`^database: ${db.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} at version 3; this build's highest is unknown \\(.*ENOENT.*\\)$`));
    expect(r.out[0]).toContain(`migrations from ${dir}, MT_SCHEMA_DIR`);
  });
});

describe('mt service check with no unit installed: a gateway started by hand', () => {
  it('needs no .env, and runs neither of install\'s checks of it', async () => {
    fx = await serviceFake({ env: false });
    const r = await check({ LARK_APP_SECRET: SECRET, LARK_APP_ID: 'cli_shell', MT_ALLOW_TALK: 'ou_a' });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      `database: ${join(fx.mtHome, 'team.db')}: no database; this build: up to ${TOP}`,
      `checking as a gateway started by hand from this shell, over ${join(fx.mtHome, '.env')}: no service is installed`,
      'ok: this build would start as a gateway started by hand from this shell',
    ]);
    expect(fx.imports).toEqual([join(fx.checkout, 'dist', 'index.js'), join(fx.checkout, 'dist', 'db', 'open.js')]);
  });

  it('fails at a ConfigError from the settings or the team, before loadStartup and before any import', async () => {
    fx = await serviceFake();
    const role = join(fx.mtHome, 'roles', 'broken');
    mkdirSync(role, { recursive: true });
    writeFileSync(join(role, 'config.yaml'), 'agent:\n  driver: nonsense\n');
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(/^database: /);
    expect(r.err).toMatch(/^mt: the gateway would not start: .*agent\.driver must be one of/);
    expect(fx.imports).toEqual([]);
  });

  it("fails at loadStartup's ConfigError, from the build's own dist/index.js", async () => {
    fx = await serviceFake({ config: `workspace: /tmp\nagent:\n  driver: acp\n  command: claude-agent-acp\n` });
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mt: the gateway would not start: an owner is required/);
    expect(fx.imports).toEqual([join(fx.checkout, 'dist', 'index.js'), join(fx.checkout, 'dist', 'db', 'open.js')]);
  });

  it('fills a stand-in, with its note, for each unset passEnv name and an unset or empty secret, masked', async () => {
    fx = await serviceFake({ env: 'LARK_APP_ID=cli_test\n' });
    writeFileSync(join(fx.mtHome, 'config.yaml'), serviceConfig(join(fx.root, 'repo'), '  passEnv: [GH_TOKEN, SET_HERE]\n'));
    let seen: Record<string, string | undefined> | undefined;
    const real = await import('../src/index.js');
    fx.modules[join(fx.checkout, 'dist', 'index.js')] = {
      loadStartup: (env: Record<string, string | undefined>) => {
        seen = env;
        return real.loadStartup(env);
      },
    };
    const r = await check({ SET_HERE: 'from the shell', LARK_APP_SECRET: '   ' });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out.filter((l) => l.startsWith('note: '))).toEqual([
      'note: GH_TOKEN is not set here: the gateway will need it from the shell that starts it',
      'note: LARK_APP_SECRET is not set here: the gateway will need it from the shell that starts it',
    ]);
    expect(seen?.['GH_TOKEN']).toBe('(unset here)');
    expect(seen?.['LARK_APP_SECRET']).toBe('(unset here)');
    expect(seen?.['SET_HERE']).toBe('from the shell');
    expect(redactKnownSecrets('a (unset here) b')).toBe(`a ${MASK} b`);
  });

  it('never fills a value the .env sets', async () => {
    fx = await serviceFake();
    let seen: Record<string, string | undefined> | undefined;
    const real = await import('../src/index.js');
    fx.modules[join(fx.checkout, 'dist', 'index.js')] = {
      loadStartup: (env: Record<string, string | undefined>) => {
        seen = env;
        return real.loadStartup(env);
      },
    };
    const r = await check();
    expect(r.code).toBe(0);
    expect(r.out.filter((l) => l.startsWith('note: '))).toEqual([]);
    // The copy is this shell's; loadStartup reads the .env itself.
    expect(seen?.['LARK_APP_SECRET']).toBeUndefined();
  });

  it('prints the version line from this shell over the .env, with a database', async () => {
    fx = await serviceFake();
    const db = database(4);
    const r = await check();
    expect(r.out[0]).toBe(`database: ${db} at version 4; this build: up to ${TOP}`);
  });
});

describe('mt service check on a database newer than the build', () => {
  it('with a unit: fails after the version line, before the configuration and the import', async () => {
    fx = await serviceFake();
    fx.install();
    const db = database(TOP + 1);
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.out).toEqual([`database: ${db} at version ${TOP + 1}; this build: up to ${TOP}`]);
    expect(r.err).toBe(
      `mt: the database is at schema version ${TOP + 1}, and this build knows only up to ${TOP}: it was migrated by a newer build. ` +
        `Run that build, or restore a backup of version ${TOP}`,
    );
    expect(fx.imports).toEqual([]);
  });

  it('with no unit: fails after the version line too', async () => {
    fx = await serviceFake();
    const db = database(TOP + 1);
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.out).toEqual([`database: ${db} at version ${TOP + 1}; this build: up to ${TOP}`]);
    expect(r.err).toMatch(/^mt: the database is at schema version \d+, and this build knows only up to \d+/);
    expect(fx.imports).toEqual([]);
  });

  it('passes at the build\'s own highest', async () => {
    fx = await serviceFake();
    fx.install();
    database(TOP);
    expect((await check()).code).toBe(0);
  });
});
