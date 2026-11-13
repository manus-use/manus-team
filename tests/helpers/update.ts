import { appendFileSync, chmodSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runMt } from '../../src/cli/mt.js';
import type { UpdateDeps, UpdateRunOptions, UpdateRunResult } from '../../src/cli/update.js';
import { migrate, openDb } from '../../src/db/open.js';
import { SCHEMA_DIR } from './db.js';
import { serviceFake, type ServiceFake } from './service.js';

/**
 * `mt update` over a fake git, a fake npm and a fake service: every git, npm
 * and child node call is recorded and answered from `repo`, a model of the
 * checkout and its upstream, and none is run. The service is `serviceFake`'s,
 * whose gateway writes its two startup lines to the log at each start. Nothing
 * reaches the network, the real service or the real home.
 */

export const OLD = '8b64aa1c0ffee00000000000000000000000000a';
export const NEW = '4f0c2de0000000000000000000000000000000b';
export const SCHEMA_FILES = readdirSync(SCHEMA_DIR).filter((f) => /^[0-9]+_.*\.sql$/.test(f)).sort();
export const TOP = SCHEMA_FILES.length;

/** The checkout and its upstream, as git would answer for them. */
export interface Repo {
  /** What `git rev-parse --show-toplevel` answers; undefined for a directory that is no git checkout. */
  top: string | undefined;
  gitDir: string;
  /** Undefined: a detached HEAD. */
  branch: string | undefined;
  /** Undefined: no upstream. */
  upstream: string | undefined;
  remote: string;
  status: string[];
  head: string;
  upstreamSha: string;
  /** Whether HEAD is an ancestor of the upstream. */
  ancestor: boolean;
  /** `git log --oneline HEAD..<upstream>`. */
  commits: string[];
  /** The paths the incoming commits add, and those under schema/ they change. */
  added: string[];
  modified: string[];
  /** The paths the incoming commits rename, which git's rename detection takes out of `--diff-filter=A`. */
  renamed: { from: string; to: string }[];
  /** `git ls-tree --name-only <upstream> schema/`. */
  tree: string[];
  depsChanged: boolean;
  sshCommand: boolean;
}

export interface Run {
  cmd: string;
  args: string[];
  opts: UpdateRunOptions;
}

export interface UpdateFake extends ServiceFake {
  repo: Repo;
  /** Every git, npm and node call, in order. */
  runs: Run[];
  /** An answer for a call, ahead of the fake's own; undefined to let the fake answer. */
  answer: (run: Run) => Partial<UpdateRunResult> | undefined;
  npm: string;
  dbPath: string;
  /** The questions asked, and the answers to give, in order. */
  asked: string[];
  replies: string[];
  /** Called while the question is asked, and at each sleep of the wait for the gateway. */
  whileAsking: () => void;
  whileSleeping: () => void;
  /** Called as the backup begins: its time is asked for its name. */
  whileBackingUp: () => void;
  /** The handler mt update gave onSignal, while it is set. */
  signal: ((signal: NodeJS.Signals) => void) | undefined;
  slept: number;
  /** The words of each git, npm and node call: `git fetch origin`, `npm ci`, `node check`. */
  ran(): string[];
  update(argv: string[], opts?: { env?: Record<string, string | undefined>; tty?: boolean; platform?: NodeJS.Platform; out?: (line: string) => void }): Promise<{ code: number; out: string; err: string }>;
}

/** The gateway's two startup lines, as src/index.ts writes them. */
export function startupLines(version: number, dbPath: string): string {
  return `2026-11-12T15:31:00.000Z schema at version ${version} (${dbPath})\n2026-11-12T15:31:02.000Z connected as ou_bot\n`;
}

/**
 * A service installed and running (pid 4242) on a home whose database is at
 * this build's version, a checkout on main tracking origin/main, clean, three
 * commits behind, none adding a migration, the dependencies unchanged.
 */
export async function updateFake(opts: { env?: string | false; config?: string; service?: 'running' | 'stopped' | 'none'; db?: boolean } = {}): Promise<UpdateFake> {
  const svc = await serviceFake(opts);
  const gitDir = join(svc.root, 'git dir');
  mkdirSync(gitDir);
  mkdirSync(join(svc.checkout, 'node_modules'));
  writeFileSync(join(svc.checkout, 'node_modules', '.package-lock.json'), '{}');
  const npm = join(svc.root, 'node bin', 'npm');
  writeFileSync(npm, '#!/bin/sh\n');
  chmodSync(npm, 0o755);
  const dbPath = join(svc.mtHome, 'team.db');
  if (opts.db !== false) {
    const db = openDb(dbPath);
    migrate(db, SCHEMA_DIR);
    db.close();
  }
  const service = opts.service ?? 'running';
  if (service !== 'none') svc.install();
  if (service === 'running') svc.job.pid = 4242;
  mkdirSync(join(svc.mtHome, 'logs'), { recursive: true, mode: 0o700 });
  writeFileSync(join(svc.mtHome, 'logs', 'gateway.log'), '2026-11-12T09:00:00.000Z connected as ou_bot\n', { mode: 0o600 });

  const f = svc as UpdateFake;
  f.repo = {
    top: svc.checkout,
    gitDir,
    branch: 'main',
    upstream: 'origin/main',
    remote: 'origin',
    status: [],
    head: OLD,
    upstreamSha: NEW,
    ancestor: true,
    commits: ['4f0c2de Add the third thing', '91aa310 Say the second thing', '2c7d001 Take the first thing'],
    added: [],
    modified: [],
    renamed: [],
    tree: SCHEMA_FILES.map((name) => `schema/${name}`),
    depsChanged: false,
    sshCommand: false,
  };
  f.runs = [];
  f.answer = () => undefined;
  f.npm = npm;
  f.dbPath = dbPath;
  f.asked = [];
  f.replies = [];
  f.signal = undefined;
  f.whileAsking = () => {};
  f.whileSleeping = () => {};
  f.whileBackingUp = () => {};
  f.slept = 0;
  f.onStart = () => appendFileSync(join(svc.mtHome, 'logs', 'gateway.log'), startupLines(TOP, dbPath));
  f.ran = () =>
    f.runs.map((r) => {
      if (r.cmd === npm) return ['npm', ...r.args].join(' ');
      if (r.cmd === svc.node) return `node ${r.args.slice(1).join(' ')}`;
      return [r.cmd, ...r.args].join(' ');
    });

  const ok = (stdout = ''): UpdateRunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
  /** Paths as git prints them: NUL-ended with -z, else a line each, a name with a byte past ASCII quoted in octal. */
  const names = (paths: string[], z: boolean): string =>
    z
      ? paths.map((p) => `${p}\0`).join('')
      : paths
          .map((p) => (/[^\x20-\x7e]/.test(p) ? `"${[...Buffer.from(p)].map((b) => (b < 0x80 ? String.fromCharCode(b) : `\\${b.toString(8)}`)).join('')}"` : p))
          .map((p) => `${p}\n`)
          .join('');
  const fail = (code: number, stderr: string): UpdateRunResult => ({ code, stdout: '', stderr, timedOut: false });
  const git = (args: string[]): UpdateRunResult => {
    const { repo } = f;
    const words = args.join(' ');
    if (words === 'rev-parse --show-toplevel') return repo.top === undefined ? fail(128, 'fatal: not a git repository') : ok(`${repo.top}\n`);
    if (words === 'rev-parse --absolute-git-dir') return ok(`${repo.gitDir}\n`);
    if (words === 'symbolic-ref --quiet --short HEAD') return repo.branch === undefined ? fail(1, '') : ok(`${repo.branch}\n`);
    if (words === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') {
      return repo.upstream === undefined ? fail(128, `fatal: no upstream configured for branch '${repo.branch}'`) : ok(`${repo.upstream}\n`);
    }
    if (words.startsWith('config --get branch.')) return ok(`${repo.remote}\n`);
    if (words === 'config --get core.sshCommand') return repo.sshCommand ? ok('ssh -i key\n') : fail(1, '');
    if (words === 'status --porcelain --untracked-files=normal') return ok(repo.status.map((l) => `${l}\n`).join(''));
    if (args[0] === 'rev-parse' && args[1] === '--git-path') {
      return ok(args.filter((_, i) => i % 2 === 0 && i > 0).map((name) => `${join(repo.gitDir, name)}\n`).join(''));
    }
    if (args[0] === 'fetch') return ok();
    if (words === `rev-parse HEAD ${repo.upstream}`) return ok(`${repo.head}\n${repo.upstreamSha}\n`);
    if (words === 'rev-parse HEAD') return ok(`${repo.head}\n`);
    if (args[0] === 'merge-base') return repo.ancestor ? ok() : fail(1, '');
    if (args[0] === 'diff' && args.includes('--name-only')) {
      // As git answers: renames detected unless --no-renames, and names quoted as core.quotePath does unless -z.
      const flags = args.slice(0, args.indexOf('HEAD'));
      const filter = flags.find((a) => a.startsWith('--diff-filter='))?.slice('--diff-filter='.length);
      const under = args.includes('--') ? args.slice(args.indexOf('--') + 1) : [];
      const noRenames = flags.includes('--no-renames');
      const named =
        filter === 'A' ? [...repo.added, ...(noRenames ? repo.renamed.map((r) => r.to) : [])] : filter === 'M' ? repo.modified : [];
      return ok(names(named.filter((p) => under.length === 0 || under.some((u) => p.startsWith(u))), flags.includes('-z')));
    }
    if (args[0] === 'log') return ok(repo.commits.map((c) => `${c}\n`).join(''));
    if (args[0] === 'ls-tree') return ok(names(repo.tree, args.includes('-z')));
    if (args[0] === 'diff' && args[1] === '--quiet') return repo.depsChanged ? fail(1, '') : ok();
    if (args[0] === 'merge') {
      repo.head = repo.upstreamSha;
      return ok('Fast-forward\n');
    }
    if (args[0] === 'reset') {
      repo.head = args[2] ?? repo.head;
      return ok();
    }
    if (words === 'status') return ok('On branch main\nnothing to commit, working tree clean\n');
    return fail(1, `the fake git does not know: git ${words}`);
  };

  const deps = (platform: NodeJS.Platform): UpdateDeps => ({
    run: async (cmd, args, runOpts) => {
      const run = { cmd, args: [...args], opts: runOpts };
      f.runs.push(run);
      const over = f.answer(run);
      if (over !== undefined) return { ...ok(), ...over };
      if (cmd === 'git') return git([...args]);
      if (cmd === npm && args[0] === 'ci') {
        writeFileSync(join(svc.checkout, 'node_modules', '.package-lock.json'), '{}');
        return ok('added 120 packages\n');
      }
      if (cmd === npm) return ok('> tsc -p tsconfig.build.json\n');
      if (cmd === svc.node) return ok(`database: ${dbPath} at version ${TOP}; this build: up to ${TOP}\nok: this build would start\n`);
      return fail(127, `the fake does not know: ${cmd}`);
    },
    ask: async (question, signal) => {
      f.asked.push(question);
      f.whileAsking();
      if (signal.aborted) throw new Error('The operation was aborted');
      return f.replies.shift() ?? '';
    },
    now: () => {
      f.whileBackingUp();
      return new Date('2026-11-12T15:30:00.000Z');
    },
    sleep: async (ms) => {
      f.slept += ms;
      f.whileSleeping();
    },
    onSignal: (handler) => {
      f.signal = handler;
      return () => {
        f.signal = undefined;
      };
    },
    guardOutput: () => {},
    pid: 999_999_001,
    alive: (pid) => f.alive.has(pid),
    service: svc.deps(platform),
  });

  f.update = async (argv, o = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const updateDeps = deps(o.platform ?? 'darwin');
    const code = await runMt(['update', ...argv], {
      env: { PATH: '/usr/bin:/bin', HOME: svc.home, ...o.env },
      out: o.out ?? ((line) => out.push(line)),
      err: (line) => err.push(line),
      stdinIsTTY: o.tty ?? false,
      service: updateDeps.service,
      update: updateDeps,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return f;
}
