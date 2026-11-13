import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readUpdateLock } from '../src/cli/update-lock.js';
import { openDb } from '../src/db/open.js';
import { clearSecrets } from '../src/secrets.js';
import { ALICE, claimed, newTask } from './helpers/kanban.js';
import { SECRET } from './helpers/service.js';
import { NEW, OLD, TOP, updateFake, type UpdateFake } from './helpers/update.js';

/**
 * `mt update`'s second step (spec §20.3): what it shows before the question,
 * found as the gateway would find it; `--check` stopping there; and the
 * question, asked only at a terminal.
 */

let fx: UpdateFake;
afterEach(() => {
  clearSecrets();
  fx.cleanup();
});

const merged = (): boolean => fx.ran().some((w) => w.startsWith('git merge --ff-only'));

describe('mt update --check', () => {
  it('shows the branch, the commits and the service, records them, and changes nothing', async () => {
    fx = await updateFake();
    let lock: unknown;
    fx.answer = (run) => {
      if (run.args[0] === 'ls-tree') lock = readUpdateLock(join(fx.mtHome, 'run', 'update.pid'));
      return undefined;
    };
    const r = await fx.update(['--check']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out.split('\n')).toEqual([
      'fetching origin',
      `manus-team at ${fx.checkout}, on main, tracking origin/main`,
      '3 new commits, 8b64aa1..4f0c2de:',
      '  4f0c2de Add the third thing',
      '  91aa310 Say the second thing',
      '  2c7d001 Take the first thing',
      'the service is running (pid 4242) and is restarted',
    ]);
    expect(merged()).toBe(false);
    expect(lock).toMatchObject({ step: 'show', old: OLD, new: NEW });
    expect(fx.asked).toEqual([]);
  });

  it('shows at most 50 commits, then how many more', async () => {
    fx = await updateFake();
    fx.repo.commits = Array.from({ length: 53 }, (_, i) => `${String(i).padStart(7, '0')} Commit ${i}`);
    const out = (await fx.update(['--check'])).out.split('\n');
    expect(out).toContain('53 new commits, 8b64aa1..4f0c2de:');
    expect(out.filter((l) => /^ {2}\d{7} Commit/.test(l))).toHaveLength(50);
    expect(out).toContain('  and 3 more');
  });

  it('says a new migration moves the database, from its version to the new tree\'s highest, with a backup first', async () => {
    fx = await updateFake();
    fx.repo.added = [`schema/${String(TOP + 1).padStart(3, '0')}_example.sql`, 'docs/x.md'];
    fx.repo.tree.push(`schema/${String(TOP + 1).padStart(3, '0')}_example.sql`);
    const r = await fx.update(['--check']);
    expect(r.out).toContain(
      `migration ${String(TOP + 1).padStart(3, '0')}_example.sql is new: the restart moves the database from version ${TOP} to ${TOP + 1}, ` +
        'and a backup is taken first; going back after it needs the backup',
    );
  });

  it('warns of a changed migration, which the runner never runs again', async () => {
    fx = await updateFake();
    fx.repo.modified = ['schema/003_kanban.sql'];
    expect((await fx.update(['--check'])).out).toContain(
      'warning: migration 003_kanban.sql was changed: the runner never runs again one the database has applied',
    );
  });

  it('says npm ci runs when package.json or package-lock.json changed, and when the installed tree is missing', async () => {
    fx = await updateFake();
    expect((await fx.update(['--check'])).out).not.toContain('npm ci');
    fx.repo.depsChanged = true;
    expect((await fx.update(['--check'])).out).toContain('the dependencies changed: npm ci runs');
    expect(fx.ran()).toContain('git diff --quiet HEAD origin/main -- package.json package-lock.json');
    fx.repo.depsChanged = false;
    rmSync(join(fx.checkout, 'node_modules', '.package-lock.json'));
    expect((await fx.update(['--check'])).out).toContain('node_modules/.package-lock.json is missing: npm ci runs');
  });

  it("counts the open agent runs on the service's database, never a person's", async () => {
    fx = await updateFake();
    const db = openDb(fx.dbPath);
    try {
      claimed(db, newTask(db, { workspace: 'web' }).taskId);
      claimed(db, newTask(db, { workspace: 'api' }).taskId);
      claimed(db, newTask(db, { assignee: { kind: 'human', name: ALICE } }).taskId);
    } finally {
      db.close();
    }
    const r = await fx.update(['--check']);
    expect(r.out).toContain('2 agent runs are open: the restart interrupts them, and they are retried as retry_on_crash allows');
  });

  it('says a stopped service is not started, and that the update stops after the backup', async () => {
    fx = await updateFake({ service: 'stopped' });
    const r = await fx.update(['--check']);
    expect(r.out).toContain('the service is stopped, and is not started: the update stops after the backup');
    expect(r.out).not.toContain('is restarted');
  });

  it('says with no service that the gateway is the person\'s to restart, and that with kanban off no lock shows one', async () => {
    fx = await updateFake({ service: 'none' });
    const r = await fx.update(['--check']);
    expect(r.out).toContain('no service is installed: the update stops after the backup, and the gateway is yours to restart');
    expect(r.out).toContain('kanban is off, so a gateway started by hand holds no lock to find: stop one that runs before going on');
  });

  it("finds the database as the service would, never from this shell's MT_DB", async () => {
    fx = await updateFake();
    const elsewhere = join(fx.root, 'elsewhere.db');
    const db = openDb(elsewhere);
    db.pragma('user_version = 3');
    db.close();
    fx.repo.added = ['schema/099_x.sql'];
    fx.repo.tree.push('schema/099_x.sql');
    const r = await fx.update(['--check'], { env: { MT_DB: elsewhere, MT_CONFIG: join(fx.root, 'nowhere.yaml') } });
    expect(r.err).toBe('');
    expect(r.out).toContain(`from version ${TOP} to 99`);
    expect(readUpdateLock(join(fx.mtHome, 'run', 'update.pid'))).toBeUndefined();
  });

  it("finds the database from this shell over the .env with no service, as a gateway started by hand would", async () => {
    fx = await updateFake({ service: 'none' });
    const elsewhere = join(fx.root, 'elsewhere.db');
    const db = openDb(elsewhere);
    db.pragma('user_version = 3');
    db.close();
    fx.repo.added = ['schema/099_x.sql'];
    fx.repo.tree.push('schema/099_x.sql');
    const r = await fx.update(['--check'], { env: { MT_DB: elsewhere } });
    expect(r.out).toContain('from version 3 to 99');
  });

  it('stops at a configuration the running build rejects, with the error', async () => {
    fx = await updateFake();
    writeFileSync(join(fx.mtHome, 'config.yaml'), 'workspace: /tmp\nkanban:\n  a_key_only_the_new_build_knows: 1\n');
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mt: the running build rejects the configuration, so the database cannot be found: .*a_key_only_the_new_build_knows.*undo the edit, update, then make it$/);
  });

  it('warns that MT_SCHEMA_DIR, in the service\'s .env, is not what this report reads', async () => {
    fx = await updateFake({ env: `LARK_APP_SECRET=${SECRET}\nLARK_APP_ID=cli_test\nMT_SCHEMA_DIR=/opt/schema\n` });
    chmodSync(join(fx.mtHome, '.env'), 0o600);
    const r = await fx.update(['--check']);
    expect(r.out).toMatch(/^warning: MT_SCHEMA_DIR is set, to \/opt\/schema: this report and the restart's confirmation assume the bundled schema\//m);
  });

  it('says there is no database for a home whose gateway never started', async () => {
    fx = await updateFake({ db: false });
    fx.repo.added = ['schema/099_x.sql'];
    const r = await fx.update(['--check']);
    expect(r.out).toContain('migration 099_x.sql is new; there is no database yet, so nothing to back up');
  });
});

describe("mt update's question", () => {
  it('is refused with no terminal and no --yes', async () => {
    fx = await updateFake();
    const r = await fx.update([]);
    expect(r.code).toBe(1);
    expect(r.err).toBe('mt: no terminal to ask at; run mt update --yes, or --check');
    expect(merged()).toBe(false);
  });

  it('is asked at a terminal, and anything but y or yes changes nothing, exit 1', async () => {
    fx = await updateFake();
    for (const reply of ['', 'n', 'no', 'yes please']) {
      fx.replies = [reply];
      const r = await fx.update([], { tty: true });
      expect(r.code).toBe(1);
      expect(r.out.split('\n').slice(-1)).toEqual(['nothing changed']);
    }
    expect(fx.asked).toEqual(Array(4).fill('update and restart the service? [y/N] '));
    expect(merged()).toBe(false);
  });

  it('goes on at y or yes', async () => {
    fx = await updateFake();
    fx.replies = [' YES '];
    expect((await fx.update([], { tty: true })).code).toBe(0);
    expect(merged()).toBe(true);
  });

  it("is asked with no restart in its words when there is none to make", async () => {
    fx = await updateFake({ service: 'stopped' });
    fx.replies = ['n'];
    await fx.update([], { tty: true });
    expect(fx.asked).toEqual(['update, and back up the database? [y/N] ']);
  });
});
