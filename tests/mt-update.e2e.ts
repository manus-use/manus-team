import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { realUpdateDeps, type UpdateDeps } from '../src/cli/update.js';
import { backupDatabase } from '../src/db/backup.js';
import { highestMigration, migrate, openDb, openDbReadOnly, type Db } from '../src/db/open.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { serviceFake, type ServiceFake } from './helpers/service.js';
import { startupLines } from './helpers/update.js';

/**
 * `mt update` with real git, against a temporary bare origin (spec §20.14): a
 * clone tracking it, a fake npm beside a real node whose ci and build write
 * marker files, and a fake service whose gateway appends its two startup lines
 * at each start. Nothing reaches the network, the real service or the real home.
 */

const TOP = highestMigration(SCHEMA_DIR);

interface Fx {
  svc: ServiceFake;
  origin: string;
  seed: string;
  marks: string;
  git(cwd: string, ...args: string[]): string;
  commit(message: string, files: Record<string, string>): string;
  update(argv: string[]): Promise<{ code: number; out: string; err: string }>;
  head(): string;
}

let fx: Fx | undefined;
afterEach(() => {
  clearSecrets();
  fx?.svc.cleanup();
  fx = undefined;
});

/** git's environment, never the real home's config: no global or system file, and the made-up home. */
const GIT_ENV = {
  PATH: process.env['PATH'],
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

/** The fake npm: `ci` writes the installed tree's marker, `run build` a dist/ whose mt.js answers service check, failing when FAIL_BUILD is in the tree. */
const NPM = `#!/bin/sh
case "$1" in
  ci) mkdir -p node_modules && echo '{}' > node_modules/.package-lock.json && echo ci >> "$MARKS" ;;
  run)
    if [ -f FAIL_BUILD ]; then echo 'src/x.ts(1,1): error TS1005' >&2; exit 2; fi
    mkdir -p dist
    printf '%s\\n' "console.log('database: e2e at version 1; this build: up to 1'); console.log('ok: this build would start');" > dist/mt.js
    : > dist/main.js
    echo "build $(git rev-parse --short HEAD)" >> "$MARKS"
    ;;
esac
`;

async function fixture(): Promise<Fx> {
  const svc = await serviceFake();
  const { root, checkout } = svc;
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const marks = join(root, 'marks');
  const git = (cwd: string, ...args: string[]): string => {
    const r = spawnSync('git', args, { cwd, env: { ...GIT_ENV, HOME: svc.home }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(root, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(root, 'clone', '--quiet', origin, seed);
  const commit = (message: string, files: Record<string, string>): string => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(seed, path, '..'), { recursive: true });
      if (text === '') rmSync(join(seed, path), { force: true });
      else writeFileSync(join(seed, path), text);
    }
    git(seed, 'add', '-A');
    git(seed, 'commit', '--quiet', '-m', message);
    git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
    return git(seed, 'rev-parse', 'HEAD');
  };
  commit('The first commit', {
    'package.json': '{"name":"e2e"}\n',
    'package-lock.json': '{"lockfileVersion":3}\n',
    '.gitignore': 'dist/\nnode_modules/\n',
    // The migrations the database is at: an incoming tree with fewer would be refused.
    ...Object.fromEntries(readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.sql')).map((f) => [`schema/${f}`, readFileSync(join(SCHEMA_DIR, f), 'utf8')])),
  });
  rmSync(checkout, { recursive: true, force: true });
  git(root, 'clone', '--quiet', origin, checkout);
  mkdirSync(join(checkout, 'node_modules'));
  writeFileSync(join(checkout, 'node_modules', '.package-lock.json'), '{}');
  mkdirSync(join(checkout, 'dist'));
  writeFileSync(join(checkout, 'dist', 'main.js'), '');

  // A real node, with the fake npm beside it.
  rmSync(svc.node);
  symlinkSync(process.execPath, svc.node);
  writeFileSync(join(root, 'node bin', 'npm'), NPM);
  chmodSync(join(root, 'node bin', 'npm'), 0o755);

  const db = openDb(join(svc.mtHome, 'team.db'));
  migrate(db, SCHEMA_DIR);
  db.close();
  svc.install();
  svc.job.pid = 4242;
  mkdirSync(join(svc.mtHome, 'logs'), { recursive: true, mode: 0o700 });
  writeFileSync(join(svc.mtHome, 'logs', 'gateway.log'), '', { mode: 0o600 });
  svc.onStart = () => appendFileSync(join(svc.mtHome, 'logs', 'gateway.log'), startupLines(TOP, join(svc.mtHome, 'team.db')));

  const f: Fx = {
    svc,
    origin,
    seed,
    marks,
    git,
    commit,
    head: () => git(checkout, 'rev-parse', 'HEAD'),
    async update(argv) {
      const out: string[] = [];
      const err: string[] = [];
      const service = svc.deps();
      const deps: UpdateDeps = { ...realUpdateDeps(service), guardOutput: () => {}, ask: async () => 'n' };
      const code = await runMt(['update', ...argv], {
        env: { ...GIT_ENV, HOME: svc.home, MARKS: marks },
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        service,
        update: deps,
      });
      return { code, out: out.join('\n'), err: err.join('\n') };
    },
  };
  return f;
}

const marks = (f: Fx): string[] => (existsSync(f.marks) ? readFileSync(f.marks, 'utf8').trim().split('\n') : []);

describe('mt update against a real origin', () => {
  it('--check shows the commit pushed, and changes nothing', async () => {
    fx = await fixture();
    const old = fx.head();
    fx.commit('Add a feature', { 'src/feature.ts': 'export {};\n' });
    const r = await fx.update(['--check']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^1 new commit, [0-9a-f]{7}\.\.[0-9a-f]{7}:\n {2}[0-9a-f]{7} Add a feature$/m);
    expect(fx.head()).toBe(old);
    expect(marks(fx)).toEqual([]);
    expect(fx.svc.words().filter((w) => / (kill|kickstart) /.test(` ${w} `))).toEqual([]);
  });

  it('--yes fast-forwards, builds, checks, backs up and restarts the service, confirmed by its log', async () => {
    fx = await fixture();
    const newer = fx.commit('Add a feature', { 'src/feature.ts': 'export {};\n' });
    const r = await fx.update(['--yes']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(fx.head()).toBe(newer);
    // Neither package file changed and the tree was there: no npm ci.
    expect(marks(fx)).toEqual([`build ${newer.slice(0, 7)}`]);
    expect(fx.svc.words()).toContain('launchctl kickstart gui/501/team.manus.gateway');
    expect(readdirSync(join(fx.svc.mtHome, 'backups'))).toHaveLength(1);
    expect(r.out).toContain(`the gateway is connected, at schema version ${TOP}`);
    expect(fx.git(fx.svc.checkout, 'status', '--porcelain')).toBe('');
  });

  it('runs npm ci when the lockfile changed', async () => {
    fx = await fixture();
    fx.commit('Bump a dependency', { 'package-lock.json': '{"lockfileVersion":3,"x":1}\n' });
    expect((await fx.update(['--yes'])).code).toBe(0);
    expect(marks(fx)[0]).toBe('ci');
  });

  it('a failing build leaves the branch at the old commit, the push still ahead, the service untouched', async () => {
    fx = await fixture();
    const old = fx.head();
    fx.commit('Break the build', { FAIL_BUILD: 'yes\n' });
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('mt: npm run build failed (exit 2)\n  src/x.ts(1,1): error TS1005');
    expect(fx.head()).toBe(old);
    expect(fx.git(fx.svc.checkout, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(fx.git(fx.svc.checkout, 'rev-list', '--count', 'HEAD..origin/main')).toBe('1');
    expect(existsSync(join(fx.svc.checkout, 'FAIL_BUILD'))).toBe(false);
    expect(fx.git(fx.svc.checkout, 'status', '--porcelain')).toBe('');
    expect(fx.svc.words().filter((w) => / (kill|kickstart) /.test(` ${w} `))).toEqual([]);
    expect(existsSync(join(fx.svc.mtHome, 'backups'))).toBe(false);
  });

  it('refuses a commit made in the checkout', async () => {
    fx = await fixture();
    fx.commit('Upstream moves', { 'a.txt': 'a\n' });
    writeFileSync(join(fx.svc.checkout, 'local.txt'), 'mine\n');
    fx.git(fx.svc.checkout, 'add', 'local.txt');
    fx.git(fx.svc.checkout, 'commit', '--quiet', '-m', 'A local commit');
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('main has commits origin/main does not: made here, or origin/main was rewritten (force-pushed)');
  });

  it('refuses an origin that was force-pushed', async () => {
    fx = await fixture();
    fx.commit('A commit the clone fetches', { 'a.txt': 'a\n' });
    expect((await fx.update(['--yes'])).code).toBe(0);
    fx.git(fx.seed, 'reset', '--quiet', '--hard', 'HEAD~1');
    writeFileSync(join(fx.seed, 'b.txt'), 'b\n');
    fx.git(fx.seed, 'add', 'b.txt');
    fx.git(fx.seed, 'commit', '--quiet', '-m', 'History rewritten');
    fx.git(fx.seed, 'push', '--quiet', '--force', 'origin', 'HEAD:main');
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('main has commits origin/main does not');
  });
});

describe('the backup of a real WAL database, written to meanwhile', () => {
  it('is a consistent copy, restored as the steps back say, and opened at the version it had', async () => {
    fx = await fixture();
    const dbPath = join(fx.svc.mtHome, 'team.db');
    const setup = openDb(dbPath);
    setup.exec('CREATE TABLE probe (n INTEGER)');
    setup.close();
    // A second connection, in another process, writing all the while.
    const sqlite = createRequire(import.meta.url).resolve('better-sqlite3');
    const writer = spawn(
      process.execPath,
      ['-e', `const D = require(${JSON.stringify(sqlite)}); const db = new D(${JSON.stringify(dbPath)}); db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 1000'); let n = 0; console.log('ready'); setInterval(() => db.prepare('INSERT INTO probe VALUES (?)').run(++n), 1);`],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      // Its first line, or its exit: a writer that dies at its start fails the test rather than hang it.
      await new Promise<void>((ready, failed) => {
        writer.stdout.once('data', () => ready());
        writer.once('exit', (code, signal) => failed(new Error(`the writer exited (${code ?? signal}) before it was ready`)));
      });
      await new Promise((wait) => setTimeout(wait, 200));
      const reader = openDbReadOnly(dbPath) as Db;
      const dir = join(fx.svc.mtHome, 'backups');
      mkdirSync(dir, { mode: 0o700 });
      let path: string;
      try {
        ({ path } = await backupDatabase(reader, { dir, dbPath, version: TOP, sha: fx.head(), at: new Date() }));
      } finally {
        reader.close();
      }
      await new Promise((wait) => setTimeout(wait, 100));
      const gone = new Promise((exited) => (writer.exitCode !== null || writer.signalCode !== null ? exited(undefined) : writer.once('exit', exited)));
      writer.kill('SIGKILL');
      await gone;
      const copied = new Database(path, { readonly: true });
      const rows = (copied.prepare('SELECT count(*) AS n FROM probe').get() as { n: number }).n;
      copied.close();
      expect(rows).toBeGreaterThan(0);

      // The newer database, then the restore of §20.9: its -wal and -shm removed, the backup copied over it.
      const newer = openDb(dbPath);
      newer.pragma(`user_version = ${TOP + 1}`);
      newer.close();
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      copyFileSync(path, dbPath);
      const restored = openDb(dbPath);
      try {
        expect(Number(restored.pragma('user_version', { simple: true }))).toBe(TOP);
        expect(restored.pragma('quick_check', { simple: true })).toBe('ok');
        expect((restored.prepare('SELECT count(*) AS n FROM probe').get() as { n: number }).n).toBe(rows);
      } finally {
        restored.close();
      }
    } finally {
      writer.kill('SIGKILL');
    }
  });
});
