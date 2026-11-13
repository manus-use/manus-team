import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ConfigError, loadTeamSettings, type Env, type TeamSettings } from '../config.js';
import { backupDatabase } from '../db/backup.js';
import { hasBoard, openAgentRunCount } from '../db/kanban-read.js';
import { openDbReadOnly, type Db } from '../db/open.js';
import { loadGatewayEnv } from '../gateway-env.js';
import { privateDir } from '../kanban/socket.js';
import { redactKnownSecrets } from '../secrets.js';
import { parse, UsageError } from './args.js';
import type { MtIo } from './mt.js';
import { realServiceDeps, serviceView, type RunResult, type ServiceDeps, type ServiceView } from './service.js';
import { findNpm, mtCommand, shQuote } from './shell.js';
import { finishByHand, stepsBack, stepsForward, type AdvicePaths } from './update-advice.js';
import { UNCHANGED_STEPS, UpdateLock, readUpdateLock, type UpdateLockState, type UpdateStep } from './update-lock.js';

/**
 * `mt update` (spec §20): a deploy in one command. It checks before it
 * changes anything, goes back by itself while going back is safe, keeps the
 * way back once it is not, and says where it stopped.
 *
 * 1. Refused in a board run's shell, by `runMt`.
 * 2. Check: the two locks; the checkout this mt runs from, which the service
 *    must run; the service's state; a branch with an upstream; clean; then
 *    `git fetch`, and the branch an ancestor of its upstream.
 * 3. Show what's coming, record the service's pid and the database's version,
 *    and ask. `--check` stops here.
 * 4. `git merge --ff-only`, `npm ci` when the dependencies changed, the build.
 * 5. The new build's `mt service check`.
 * 6. The backup, once the pid and the version are found unchanged.
 * 7. `mt service restart`'s own code, and up to 60 seconds for `connected as`.
 *
 * Every git, npm and child node call goes through `UpdateDeps.run`, in a
 * process group of its own, so a test gives a fake git and a fake npm, and a
 * fake service through `ServiceDeps`, and nothing reaches the network, the
 * real service or the real home.
 *
 * Exit codes: 0 updated and confirmed, up to date, `--check` done, or stopped
 * after the backup with no service to restart; 1 refused, declined, or failed
 * and gone back; 2 a wrong command line; 3 a person is needed.
 */

export interface UpdateRunOptions {
  cwd: string;
  env: Env;
  /** Past it, the call's process group is killed, SIGTERM then SIGKILL after 5 seconds, and `timedOut` is true. */
  timeoutMs: number;
  /** Aborted to stop the call: its process group is killed as at a timeout. */
  signal?: AbortSignal | undefined;
}

export interface UpdateRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface UpdateDeps {
  /** Runs a command to completion, capturing its output, in a session of its own with no terminal and no stdin. */
  run: (cmd: string, args: readonly string[], opts: UpdateRunOptions) => Promise<UpdateRunResult>;
  /** Asks at the terminal; rejects when `signal` is aborted. */
  ask: (question: string, signal: AbortSignal) => Promise<string>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Calls `handler` at each SIGINT, SIGHUP and SIGTERM until the returned function is called. */
  onSignal: (handler: (signal: NodeJS.Signals) => void) => () => void;
  /** From now on, EPIPE and EIO on stdout and stderr are not a failure (spec §20.11). */
  guardOutput: () => void;
  /** This process's pid, which its locks hold. */
  pid: number;
  /** Whether a process has this pid. */
  alive: (pid: number) => boolean;
  /** The service, the checkout this mt runs from, and its node. */
  service: ServiceDeps;
}

/** How long each call may take (spec §20.11). The calls that run no hook and reach no network get LOCAL_MS. */
export const LIMITS = {
  local: 30_000,
  fetch: 120_000,
  hook: 120_000,
  npmCi: 20 * 60_000,
  build: 10 * 60_000,
  check: 120_000,
} as const;

/** How long the restarted gateway has to say it connected, and how often its log is read. */
export const CONFIRM_MS = 60_000;
const POLL_MS = 250;
/** How long a killed group has between SIGTERM and SIGKILL, and after it, before its output is let go. */
const KILL_AFTER_MS = 5_000;
const GONE_AFTER_MS = 1_000;

const COMMITS_SHOWN = 50;
const FAILED_TAIL = 20;
const LOG_TAIL = 30;

/** The operations under way that `git status` may not show (spec §20.2). */
const OPERATIONS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'] as const;

/** A migration file, as the runner reads one. */
const MIGRATION = /^schema\/([0-9]+)_[^/]*\.sql$/;

/**
 * The real ones: git and npm spawned detached, this terminal, this process's
 * signals. With no `service` given, the service's own: `mt service`'s, but for
 * its launchctl and systemctl calls, each in a session of its own, so a
 * terminal's Ctrl-C cannot stop the restart half way (spec §20.11).
 */
export function realUpdateDeps(given?: ServiceDeps): UpdateDeps {
  const service = given ?? { ...realServiceDeps(), run: runSyncDetached };
  return {
    run: runDetached,
    ask: async (question, signal) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      // A Ctrl-C at the prompt reaches readline, not the process: send it on, as any other would arrive.
      rl.on('SIGINT', () => process.kill(process.pid, 'SIGINT'));
      try {
        return await rl.question(question, { signal });
      } finally {
        rl.close();
      }
    },
    now: () => new Date(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    onSignal: (handler) => {
      const names: NodeJS.Signals[] = ['SIGINT', 'SIGHUP', 'SIGTERM'];
      const listeners = names.map((name) => [name, () => handler(name)] as const);
      for (const [name, listener] of listeners) process.on(name, listener);
      return () => {
        for (const [name, listener] of listeners) process.off(name, listener);
      };
    },
    guardOutput: () => {
      for (const stream of [process.stdout, process.stderr]) {
        stream.on('error', (err: NodeJS.ErrnoException) => {
          if (!isClosedOutput(err)) throw err;
        });
      }
    },
    pid: process.pid,
    alive: service.alive,
    service,
  };
}

/**
 * The wrapper `runSyncDetached` runs: the command in a session of its own, its
 * output and exit code passed on, and the terminal's signals ignored, so the
 * wrapper stays to the end too.
 */
const DETACHED_WRAPPER = [
  "const { spawn } = require('node:child_process');",
  "for (const s of ['SIGINT', 'SIGHUP', 'SIGTERM']) process.on(s, () => {});",
  "const child = spawn(process.argv[1], process.argv.slice(2), { detached: true, stdio: 'inherit' });",
  "child.on('error', (err) => { process.stderr.write(err.message); process.exit(127); });",
  'child.on(\'exit\', (code) => process.exit(code ?? 1));',
].join('\n');

/** `ServiceDeps.run`, synchronous as `mt service`'s, with the command detached from this terminal. */
export function runSyncDetached(cmd: string, args: readonly string[]): RunResult {
  const r = spawnSync(process.execPath, ['-e', DETACHED_WRAPPER, cmd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error !== undefined) return { code: 127, stdout: '', stderr: r.error.message };
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

/** EPIPE or EIO: a closed terminal or pipe, which never stops an update half way. */
function isClosedOutput(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EPIPE' || code === 'EIO';
}

/** Output kept of a call: its last bytes, which is where a failure says why. */
const OUTPUT_KEPT = 256 * 1024;

/**
 * Run `cmd` detached, a session of its own with no controlling terminal and no
 * stdin, so a terminal's Ctrl-C reaches mt alone and nothing it starts can
 * prompt on /dev/tty. At its time limit, or when aborted, its whole process
 * group is sent SIGTERM, and SIGKILL 5 seconds later.
 */
export function runDetached(cmd: string, args: readonly string[], opts: UpdateRunOptions): Promise<UpdateRunResult> {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killer: NodeJS.Timeout | undefined;
    const child = spawn(cmd, [...args], { cwd: opts.cwd, env: { ...opts.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (kept: string, more: string): string => (kept + more).slice(-OUTPUT_KEPT);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout = keep(stdout, d)));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr = keep(stderr, d)));
    const group = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // Gone already.
      }
    };
    const kill = (): void => {
      if (killer !== undefined) return;
      group('SIGTERM');
      killer = setTimeout(() => {
        group('SIGKILL');
        // A process that left the group may hold the pipes open: let them go, and answer with what was said.
        setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish({ code: 137, stdout, stderr, timedOut });
        }, GONE_AFTER_MS).unref();
      }, KILL_AFTER_MS);
      killer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    timer.unref();
    if (opts.signal?.aborted === true) kill();
    opts.signal?.addEventListener('abort', kill, { once: true });
    const finish = (r: UpdateRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', kill);
      done(r);
    };
    child.once('error', (err) => finish({ code: 127, stdout, stderr: `${stderr}${err.message}`, timedOut }));
    child.once('close', (code, signal) => {
      const number = signal === null ? 1 : 128 + (osConstants.signals[signal] ?? 0);
      finish({ code: code ?? number, stdout, stderr, timedOut });
    });
  });
}

/** An end to the update: its exit code, and the refusal to print, if any. */
class Stop extends Error {
  constructor(
    readonly code: number,
    readonly refusal: string | undefined,
  ) {
    super(refusal ?? `exit ${code}`);
  }
}

/** What failed in steps 4 to 6, to say when the update has gone back. */
interface Failure {
  what: string;
  output: string;
}

const short = (sha: string | undefined): string => (sha ?? '').slice(0, 7);
const lines = (text: string): string[] => text.split('\n').filter((l) => l.trim() !== '');
const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const versionText = (v: number | null): string => (v === null ? 'no database' : `version ${v}`);

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The `user_version` of the database at `path`, read-only; null when there is none. */
function versionOf(path: string): number | null {
  const db = openDbReadOnly(path);
  if (db === undefined) return null;
  try {
    return Number(db.pragma('user_version', { simple: true }));
  } finally {
    db.close();
  }
}

/** A file's last `n` lines, or none when it is missing. */
function tailOf(path: string, n: number): string[] {
  const text = readFrom(path, 0);
  const all = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  return text === '' ? [] : all.slice(-n);
}

/** The bytes of `path` from `offset`, or from its start when it is shorter, as after a rotation. */
function readFrom(path: string, offset: number): string {
  const st = statSync(path, { throwIfNoEntry: false });
  if (st === undefined) return '';
  const start = st.size < offset ? 0 : offset;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    const read = readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** `mt update [--check | --yes]`. */
export async function updateCommand(argv: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(argv, { check: { type: 'boolean' }, yes: { type: 'boolean' } });
  if (positionals.length > 0) throw new UsageError('update takes no arguments');
  if (values.check === true && values.yes === true) throw new UsageError('update takes --check or --yes, not both');
  const deps = io.update ?? realUpdateDeps(io.service);
  return await new Update(io, deps, { check: values.check === true, yes: values.yes === true }).run();
}

/** Where the update is, for what a signal does (spec §20.11). */
type Phase = 'before' | 'changing' | 'going back' | 'restart' | 'waiting';

class Update {
  private readonly view: ServiceView;
  private readonly checkout: string;
  private readonly shellEnv: Env;
  private gitEnv: Env;
  private node: string;
  private npm = 'npm';
  private branch = '';
  private upstream = '';
  private remote = '';
  private old = '';
  private new = '';
  private upToDate = false;
  private installed = false;
  private willRestart = false;
  private servicePid: number | null = null;
  private dbPath = '';
  private db: Db | undefined;
  private version: number | null = null;
  private newest = 0;
  private needCi = false;
  private ranCi = false;
  private backup: string | undefined;
  private added: string[] = [];
  private readonly locks: UpdateLock[] = [];
  /** The checkout's lock and the home's, once known. */
  private lockPaths: string[] = [];
  /** Set when an unexpected error after step 3 leaves the locks for a person. */
  private keepLocks = false;
  private lock: UpdateLockState;
  private phase: Phase = 'before';
  private signalled: NodeJS.Signals | undefined;
  private readonly abort = new AbortController();

  private readonly io: MtIo;

  constructor(
    io: MtIo,
    private readonly deps: UpdateDeps,
    private readonly opts: { check: boolean; yes: boolean },
  ) {
    // Output that cannot be written is no failure, the service's own lines included.
    const safe =
      (write: (line: string) => void) =>
      (line: string): void => {
        try {
          write(line);
        } catch (err) {
          if (!isClosedOutput(err)) throw err;
        }
      };
    this.io = { ...io, out: safe(io.out), err: safe(io.err) };
    this.view = serviceView(this.io, deps.service);
    this.checkout = realpathOr(deps.service.checkout);
    this.node = deps.service.node;
    // This shell's, never a board run's, and nothing git or npm starts may prompt.
    const env: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(io.env)) if (!name.startsWith('MT_KANBAN_')) env[name] = value;
    this.shellEnv = { ...env, GIT_TERMINAL_PROMPT: '0' };
    this.gitEnv = this.shellEnv;
    this.lock = { pid: deps.pid, home: this.view.mtHome, checkout: this.checkout, step: 'check' };
  }

  // -------------------------------------------------------------------------
  // Output, masked.

  private say(line: string): void {
    this.io.out(redactKnownSecrets(line));
  }

  private sayErr(line: string): void {
    this.io.err(redactKnownSecrets(line));
  }

  private warn(line: string): void {
    this.say(`warning: ${line}`);
  }

  private block(title: string, commands: readonly string[]): void {
    this.say(title);
    for (const command of commands) this.say(`  ${command}`);
  }

  private get paths(): AdvicePaths {
    return {
      node: this.node,
      npm: this.npm,
      checkout: this.checkout,
      home: this.view.mtHome,
      homeSet: this.view.mtHomeSet !== undefined,
      db: this.dbPath,
      service: this.installed,
    };
  }

  private get npmEnv(): Env {
    return { ...this.gitEnv, PATH: [dirname(this.node), this.shellEnv['PATH'] ?? ''].filter((p) => p !== '').join(delimiter) };
  }

  // -------------------------------------------------------------------------
  // The calls.

  private async call(cmd: string, args: readonly string[], timeoutMs: number, env: Env): Promise<{ r: UpdateRunResult; said: string }> {
    const before = this.phase === 'before';
    const r = await this.deps.run(cmd, args, { cwd: this.checkout, env, timeoutMs, signal: before ? this.abort.signal : undefined });
    if (before && this.signalled !== undefined) throw new Stop(1, `interrupted by ${this.signalled}: nothing changed`);
    return { r, said: (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join(' ').replace(/\.$/, '') };
  }

  private async git(args: readonly string[], timeoutMs: number = LIMITS.local): Promise<UpdateRunResult> {
    return (await this.call('git', args, timeoutMs, this.gitEnv)).r;
  }

  /** git's output, or a refusal: nothing has changed when one of these fails. */
  private async mustGit(args: readonly string[]): Promise<string> {
    const { r, said } = await this.call('git', args, LIMITS.local, this.gitEnv);
    if (r.code !== 0) throw new Stop(1, `git ${args.join(' ')} failed (exit ${r.code})${said === '' ? '' : `: ${said}`}`);
    return r.stdout;
  }

  private writeLock(step: UpdateStep): void {
    this.lock = { ...this.lock, step };
    for (const lock of this.locks) lock.write(this.lock);
  }

  /** Take a lock, after `prepare` makes its directory; a directory or a file not of its own is a refusal. */
  private takeLock(path: string, prepare: () => void = () => {}): void {
    let taken: ReturnType<typeof UpdateLock.take>;
    try {
      prepare();
      taken = UpdateLock.take(path, this.lock);
    } catch (err) {
      throw new Stop(1, err instanceof Error ? err.message : String(err));
    }
    if (taken instanceof UpdateLock) {
      this.locks.push(taken);
      return;
    }
    throw this.heldLock(path, taken.held);
  }

  /** A lock found held: an update under way, or one that died, with what to do. */
  private heldLock(path: string, held: UpdateLockState | undefined): Stop {
    if (held === undefined) {
      return new Stop(1, `${path} holds no update's state; if no mt update runs, remove it: rm ${shQuote(path)}`);
    }
    if (this.deps.alive(held.pid)) {
      return new Stop(1, `an update (pid ${held.pid}) is under way on ${held.home}, from ${held.checkout}, at its step ${held.step} (${path})`);
    }
    // Died: a kill -9, a power cut, or an error it did not foresee. Never cleared here; what to do depends on how far it got.
    if (held.home !== this.view.mtHome) {
      // The checkout's lock, left by an update of another home: that home's database and service are the ones to look at.
      return new Stop(1, `an update of ${held.home} died at its step ${held.step}; run MT_HOME=${shQuote(held.home)} mt update for what to do`);
    }
    const commits = held.old === undefined ? '' : `, updating ${short(held.old)}..${short(held.new)}`;
    // Both locks it left, named together, so the advice is followed once.
    const left = this.lockPaths.filter((p) => {
      try {
        return readUpdateLock(p)?.pid === held.pid;
      } catch {
        return false;
      }
    });
    if (!left.includes(path)) left.push(path);
    const locks = left.length === 1 ? 'its lock' : 'its locks';
    this.sayErr(`mt: an update (pid ${held.pid}) died at its step ${held.step}${commits}; ${locks} ${left.length === 1 ? 'is' : 'are'} never cleared by itself: ${left.join(', ')}`);
    const rm = `then remove ${locks}: rm ${left.map(shQuote).join(' ')}`;
    if (UNCHANGED_STEPS.includes(held.step)) {
      this.say(`it changed nothing; remove ${locks}: rm ${left.map(shQuote).join(' ')}`);
      return new Stop(1, undefined);
    }
    const paths = { ...this.paths, db: held.db ?? this.dbPath };
    const was = held.userVersion ?? null;
    const back = { old: held.old ?? 'HEAD', backup: held.backup };
    let now: number | null;
    try {
      now = held.db === undefined ? null : versionOf(held.db);
    } catch (err) {
      this.say(`the database's version cannot be read here (${err instanceof Error ? err.message : String(err)}): read it with ${mtCommand(this.node, this.checkout)} service check`);
      this.block(`at ${versionText(was)}, the steps back:`, stepsBack(paths, back));
      this.block('at another, the steps forward:', stepsForward(paths));
      this.say(rm);
      return new Stop(1, undefined);
    }
    if (now === was) {
      this.say(`the database is still at ${versionText(was)}`);
      this.block('the steps back:', stepsBack(paths, back));
    } else {
      this.say(`the database moved from ${versionText(was)} to ${versionText(now)}: the old build can no longer run on it`);
      this.block('the steps forward:', stepsForward(paths));
      if ((held.step === 'restart' || held.step === 'confirm') && held.backup !== undefined) {
        this.block('or the steps back, with its backup, which remain possible:', stepsBack(paths, back));
      }
    }
    this.say(rm);
    return new Stop(1, undefined);
  }

  // -------------------------------------------------------------------------
  // Step 2: check.

  private async inspect(): Promise<void> {
    const { view, io } = this;
    const platform = this.deps.service.platform;
    if (platform !== 'darwin' && platform !== 'linux') throw new Stop(1, `mt update supports macOS and Linux only, not ${platform}`);
    const top = await this.git(['rev-parse', '--show-toplevel']);
    if (top.code !== 0) {
      throw new Stop(1, `${this.checkout} is not a git checkout, so there is nothing to update it from: ${top.stderr.trim()}`);
    }
    if (realpathOr(top.stdout.trim()) !== this.checkout) {
      throw new Stop(1, `${this.checkout} is not the top of a git worktree (${top.stdout.trim()} is): mt update updates the checkout this mt runs from`);
    }
    const gitDir = (await this.mustGit(['rev-parse', '--absolute-git-dir'])).trim();

    // The unit, and the node and npm the update and its printed steps use.
    this.installed = view.installed();
    const recorded = view.recorded();
    if (recorded !== undefined) this.node = recorded.node;
    this.npm = findNpm(this.node, this.shellEnv['PATH']) ?? 'npm';

    this.lockPaths = [join(gitDir, 'mt-update.lock'), join(view.mtHome, 'run', 'update.pid')];
    this.takeLock(join(gitDir, 'mt-update.lock'));
    this.takeLock(join(view.mtHome, 'run', 'update.pid'), () => privateDir(join(view.mtHome, 'run'), 'the update lock'));

    if (this.installed) {
      if (recorded === undefined) {
        throw new Stop(1, `${view.file} was not written by mt service install, so what the service runs cannot be read; run mt service install to write it again`);
      }
      if (realpathOr(recorded.checkout) !== this.checkout) {
        throw new Stop(
          1,
          `the service runs ${recorded.checkout}, and this mt is ${this.checkout}'s: updating it would build one tree and restart the service on another. ` +
            `Run mt service install from the checkout to update, or mt update from ${recorded.checkout}`,
        );
      }
      if (!existsSync(recorded.node)) {
        throw new Stop(1, `the node the service runs, ${recorded.node}, is gone; run mt service install again with the node to use`);
      }
      const state = view.state();
      if (state.unreadable !== undefined) {
        const hint =
          view.kind === 'launchd'
            ? 'a LaunchAgent needs someone logged in at the Mac\'s console: log in there, then run this again'
            : "run it where the user's systemd answers: a login session, or with loginctl enable-linger";
        throw new Stop(1, `the service's state cannot be read, and is not taken as stopped: ${state.unreadable}. ${hint}`);
      }
      const holder = view.lockPid();
      if (holder !== undefined && holder !== state.pid) {
        throw new Stop(
          1,
          `a gateway (pid ${holder}) is running on ${view.mtHome}, not as the service; perhaps npm run dev. ` +
            'Stop it first: the restarted service could not take the home',
        );
      }
      this.willRestart = state.running;
      this.servicePid = state.running ? (state.pid ?? null) : null;
    } else {
      const holder = view.lockPid();
      if (holder !== undefined) {
        throw new Stop(
          1,
          `a gateway (pid ${holder}) is running on ${view.mtHome} with no service installed; perhaps npm run dev, whose tsx watch ` +
            'would restart it on the new code at the merge, before the build, the check and the backup. Stop it first',
        );
      }
    }
    if (findNpm(this.node, this.shellEnv['PATH']) === undefined) {
      throw new Stop(1, `there is no npm beside ${this.node}, nor on PATH`);
    }

    const branch = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch.code !== 0) {
      throw new Stop(1, `${this.checkout} has a detached HEAD: check out the branch to update, then run this again`);
    }
    this.branch = branch.stdout.trim();
    const upstream = await this.git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    if (upstream.code !== 0) {
      throw new Stop(
        1,
        `${this.branch} has no upstream to update from. Name the one it tracks, once: git branch --set-upstream-to=origin/${this.branch}`,
      );
    }
    this.upstream = upstream.stdout.trim();
    const remote = await this.git(['config', '--get', `branch.${this.branch}.remote`]);
    this.remote = remote.stdout.trim() || (this.upstream.split('/')[0] ?? 'origin');

    const status = lines(await this.mustGit(['status', '--porcelain', '--untracked-files=normal']));
    if (status.length > 0) {
      const shown = status.slice(0, 10).map((l) => `  ${l}`);
      if (status.length > 10) shown.push(`  and ${status.length - 10} more`);
      throw new Stop(1, `${this.checkout} is not clean; commit, stash or remove these first:\n${shown.join('\n')}`);
    }
    const where = lines(await this.mustGit(['rev-parse', ...OPERATIONS.flatMap((name) => ['--git-path', name])]));
    const pending = OPERATIONS.filter((_, i) => existsSync(resolve(this.checkout, where[i] ?? '')));
    if (pending.length > 0) {
      throw new Stop(1, `an operation is under way in ${this.checkout} (${pending.join(', ')}): finish it, or abort it, first`);
    }

    // Batch mode for ssh, unless the user chose their own.
    const sshCommand = await this.git(['config', '--get', 'core.sshCommand']);
    if (io.env['GIT_SSH_COMMAND'] === undefined && sshCommand.code !== 0) {
      this.gitEnv = { ...this.shellEnv, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
    }
    this.say(`fetching ${this.remote}`);
    const fetch = await this.call('git', ['fetch', this.remote], LIMITS.fetch, this.gitEnv);
    if (fetch.r.code !== 0) {
      throw new Stop(
        1,
        `git fetch ${this.remote} ${fetch.r.timedOut ? `did not finish in ${LIMITS.fetch / 1000} seconds` : `failed (exit ${fetch.r.code})`}` +
          `${fetch.said === '' ? '' : `: ${fetch.said}`}. Nothing changed. A remote that needs a password or a host key needs a credential helper or an ssh agent`,
      );
    }
    [this.old = '', this.new = ''] = lines(await this.mustGit(['rev-parse', 'HEAD', this.upstream]));
    const ancestor = await this.git(['merge-base', '--is-ancestor', 'HEAD', this.upstream]);
    if (ancestor.code === 1) {
      throw new Stop(
        1,
        `${this.branch} has commits ${this.upstream} does not: made here, or ${this.upstream} was rewritten (force-pushed). ` +
          `Joining them is for a person: see git log ${this.upstream}..${this.branch} and git log ${this.branch}..${this.upstream}`,
      );
    }
    if (ancestor.code !== 0) throw new Stop(1, `git merge-base --is-ancestor HEAD ${this.upstream} failed (exit ${ancestor.code})`);
    this.lock = { ...this.lock, old: this.old, new: this.new };
    if (this.old === this.new) {
      this.upToDate = true;
      return;
    }
    this.added = lines(await this.mustGit(['diff', '--name-only', '--diff-filter=A', 'HEAD', this.upstream]));
    const inTheWay = this.added.filter((path) => lstatSync(join(this.checkout, path), { throwIfNoEntry: false }) !== undefined);
    if (inTheWay.length > 0) {
      throw new Stop(
        1,
        `the incoming commits add ${inTheWay.join(', ')}, already in ${this.checkout} and ignored by git, which would overwrite ` +
          `${inTheWay.length === 1 ? 'it' : 'them'} in the fast-forward without a word. Move ${inTheWay.length === 1 ? 'it' : 'them'} aside, or tell the commit's author`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: show what's coming, record, ask.

  /** Answers false when there is nothing new. */
  private async show(): Promise<boolean> {
    const { view } = this;
    if (this.upToDate) {
      this.say(`manus-team at ${this.checkout}, on ${this.branch}, tracking ${this.upstream}: up to date at ${short(this.old)}`);
      return false;
    }
    this.writeLock('show');
    this.say(`manus-team at ${this.checkout}, on ${this.branch}, tracking ${this.upstream}`);

    const commits = lines(await this.mustGit(['log', '--oneline', '--no-decorate', `HEAD..${this.upstream}`]));
    this.say(`${plural(commits.length, 'new commit')}, ${short(this.old)}..${short(this.new)}:`);
    for (const commit of commits.slice(0, COMMITS_SHOWN)) this.say(`  ${commit}`);
    if (commits.length > COMMITS_SHOWN) this.say(`  and ${commits.length - COMMITS_SHOWN} more`);

    // The database, found as the gateway would find it.
    const recorded = view.recorded();
    let settings: TeamSettings;
    let env: Env;
    try {
      env = recorded !== undefined ? view.env(recorded) : loadGatewayEnv({ ...this.shellEnv, MT_HOME: view.mtHome }).env;
      settings = loadTeamSettings(env, undefined, { unsetPassEnv: [] });
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      throw new Stop(
        1,
        `the running build rejects the configuration, so the database cannot be found: ${err.message}. ` +
          'A config edited ahead of an update, for a key only the new build knows, is the usual cause: undo the edit, update, then make it',
      );
    }
    this.dbPath = settings.dbPath;
    this.db = openDbReadOnly(settings.dbPath);
    this.version = this.db === undefined ? null : Number(this.db.pragma('user_version', { simple: true }));

    const tree = lines(await this.mustGit(['ls-tree', '--name-only', this.upstream, 'schema/']));
    this.newest = tree.reduce((top, path) => Math.max(top, Number(MIGRATION.exec(path)?.[1] ?? 0)), 0);
    const fresh = this.added.filter((path) => MIGRATION.test(path)).map((path) => basename(path)).sort();
    if (fresh.length > 0) {
      const which = `${fresh.length === 1 ? 'migration' : 'migrations'} ${fresh.join(', ')} ${fresh.length === 1 ? 'is' : 'are'} new`;
      this.say(
        this.version === null
          ? `${which}; there is no database yet, so nothing to back up`
          : `${which}: the restart moves the database from version ${this.version} to ${this.newest}, and a backup is taken first; going back after it needs the backup`,
      );
    }
    const changed = lines(await this.mustGit(['diff', '--name-only', '--diff-filter=M', 'HEAD', this.upstream, '--', 'schema/']));
    for (const path of changed.filter((p) => MIGRATION.test(p))) {
      this.warn(`migration ${basename(path)} was changed: the runner never runs again one the database has applied`);
    }
    const schemaDir = env['MT_SCHEMA_DIR']?.trim();
    if (schemaDir !== undefined && schemaDir !== '') {
      this.warn(
        `MT_SCHEMA_DIR is set, to ${schemaDir}: this report and the restart's confirmation assume the bundled schema/, and the gateway reads ${schemaDir}. ` +
          'The new build refuses a database newer than that directory, and its mt service check reads it',
      );
    }

    const dependencies = await this.git(['diff', '--quiet', 'HEAD', this.upstream, '--', 'package.json', 'package-lock.json']);
    const installedTree = existsSync(join(this.checkout, 'node_modules', '.package-lock.json'));
    this.needCi = dependencies.code !== 0 || !installedTree;
    if (dependencies.code !== 0) this.say('the dependencies changed: npm ci runs');
    else if (!installedTree) this.say('node_modules/.package-lock.json is missing: npm ci runs');

    const runs = this.db === undefined || !hasBoard(this.db) ? undefined : openAgentRunCount(this.db);
    if (this.willRestart && runs !== undefined && runs > 0) {
      this.say(`${plural(runs, 'agent run')} ${runs === 1 ? 'is' : 'are'} open: the restart interrupts them, and they are retried as retry_on_crash allows`);
    }
    if (this.willRestart) {
      this.say(`the service is running (pid ${this.servicePid ?? 'unknown'}) and is restarted`);
    } else if (this.installed) {
      this.say('the service is stopped, and is not started: the update stops after the backup');
    } else {
      this.say('no service is installed: the update stops after the backup, and the gateway is yours to restart');
      if (settings.kanbanEnabled !== true) {
        this.say('kanban is off, so a gateway started by hand holds no lock to find: stop one that runs before going on');
      }
    }

    this.lock = { ...this.lock, servicePid: this.servicePid, userVersion: this.version, db: this.dbPath };
    this.writeLock('show');
    return true;
  }

  /** The question, at a terminal, unless `--yes`. */
  private async confirm(): Promise<void> {
    if (this.opts.yes) return;
    if (this.io.stdinIsTTY !== true) throw new Stop(1, 'no terminal to ask at; run mt update --yes, or --check');
    let answer: string;
    try {
      answer = await this.deps.ask(this.willRestart ? 'update and restart the service? [y/N] ' : 'update, and back up the database? [y/N] ', this.abort.signal);
    } catch (err) {
      if (this.signalled !== undefined) throw new Stop(1, `interrupted by ${this.signalled}: nothing changed`);
      throw err;
    }
    if (this.signalled !== undefined) throw new Stop(1, `interrupted by ${this.signalled}: nothing changed`);
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
      this.say('nothing changed');
      throw new Stop(1, undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Steps 4 to 6: update, preflight, backup. A failure goes back.

  private async apply(): Promise<void> {
    if (this.signalled !== undefined) throw new Stop(1, `interrupted by ${this.signalled}: nothing changed`);
    this.phase = 'changing';
    const merge = await this.step('merge', `merging ${this.upstream}, fast-forward only`, 'git', ['merge', '--ff-only', this.upstream], LIMITS.hook, this.gitEnv);
    if (merge !== undefined) {
      // Timed out or not, it goes back; HEAD at the new commit is a merge that landed and a hook that hung.
      const head = await this.deps.run('git', ['rev-parse', 'HEAD'], { cwd: this.checkout, env: this.gitEnv, timeoutMs: LIMITS.local });
      if (head.stdout.trim() === this.new) merge.what += ` (HEAD is at ${short(this.new)}: the merge landed, and its post-merge hook did not end)`;
    }
    await this.goBackIf(merge);
    if (this.needCi) {
      this.ranCi = true;
      await this.goBackIf(await this.step('npm ci', 'running npm ci', this.npm, ['ci'], LIMITS.npmCi, this.npmEnv));
    }
    await this.goBackIf(await this.step('build', 'running npm run build', this.npm, ['run', 'build'], LIMITS.build, this.npmEnv));
    const check = [join(this.checkout, 'dist', 'mt.js'), 'service', 'check'];
    await this.goBackIf(await this.step('preflight', 'checking the new build: mt service check', this.node, check, LIMITS.check, this.npmEnv));

    this.unmoved();
    this.writeLock('backup');
    let failed: Failure | undefined;
    if (this.db === undefined) {
      this.say('there is no database, so no backup: the gateway has not started on this home');
    } else {
      const dir = join(this.view.mtHome, 'backups');
      try {
        privateDir(dir, 'the backups');
        const at = this.deps.now();
        const { path, removed } = await backupDatabase(this.db, { dir, dbPath: this.dbPath, version: this.version ?? 0, sha: this.old, at });
        this.backup = path;
        this.lock = { ...this.lock, backup: path };
        this.writeLock('backup');
        this.say(`backed up the database to ${path}${removed.length === 0 ? '' : `; removed ${plural(removed.length, 'older backup')}`}`);
      } catch (err) {
        failed = { what: `the backup failed: ${err instanceof Error ? err.message : String(err)}`, output: '' };
      }
    }
    await this.goBackIf(failed);
  }

  /** Run one of steps 4 to 6 to its end; its failure, or undefined. */
  private async step(step: UpdateStep, line: string, cmd: string, args: readonly string[], timeoutMs: number, env: Env): Promise<Failure | undefined> {
    this.writeLock(step);
    this.say(line);
    const r = await this.deps.run(cmd, args, { cwd: this.checkout, env, timeoutMs });
    const output = `${r.stdout}${r.stdout.endsWith('\n') || r.stdout === '' ? '' : '\n'}${r.stderr}`;
    if (r.code === 0 && !r.timedOut) {
      if (step === 'preflight') for (const said of lines(r.stdout)) this.say(`  ${said}`);
      return undefined;
    }
    const name = step === 'merge' ? `git merge --ff-only ${this.upstream}` : step === 'preflight' ? 'mt service check' : step === 'npm ci' ? 'npm ci' : 'npm run build';
    const limit = timeoutMs >= 600_000 ? `${timeoutMs / 60_000} minutes` : `${timeoutMs / 1000} seconds`;
    return { what: r.timedOut ? `${name} did not finish in ${limit}` : `${name} failed (exit ${r.code})`, output };
  }

  /** Go back after a failure, or after a signal once the command running at it has ended (spec §20.11). */
  private async goBackIf(failure: Failure | undefined): Promise<void> {
    if (failure !== undefined) await this.goBack(failure);
    if (this.signalled !== undefined) await this.goBack({ what: `interrupted by ${this.signalled}`, output: '' });
  }

  /** The service's pid now: null when it is not running. */
  private pidNow(): number | null | 'unreadable' {
    if (!this.installed) return null;
    const state = this.view.state();
    if (state.unreadable !== undefined) return 'unreadable';
    return state.running ? (state.pid ?? null) : null;
  }

  /** The database's `user_version` now, on the read-only connection; null with no database. */
  private versionNow(): number | null {
    return this.db === undefined ? versionOf(this.dbPath) : Number(this.db.pragma('user_version', { simple: true }));
  }

  /**
   * Before the backup and before any going back (spec §20.6): did a gateway
   * start again meanwhile, a crash restart on the new tree, or migrate the
   * database? Either stops the update, exit 3, with what to do.
   */
  private unmoved(): void {
    const version = this.versionNow();
    if (version !== this.version) {
      this.sayErr(
        `mt: the database moved from ${versionText(this.version)} to ${versionText(version)} before a backup was taken: ` +
          'the old build can no longer run on it, and there is no way back',
      );
      this.block('the steps forward, which make the new tree whole and start it:', stepsForward(this.paths));
      throw new Stop(3, undefined);
    }
    const pid = this.pidNow();
    if (pid === this.servicePid) return;
    const was = this.servicePid === null ? 'the service was not running' : `the service's pid was ${this.servicePid}`;
    const is = pid === 'unreadable' ? 'its state cannot be read now' : pid === null ? 'it is not running now' : `is ${pid}`;
    this.sayErr(`mt: ${was} and ${is}; the database is still at ${versionText(this.version)}`);
    this.block(
      'the steps back, which hold while the version is unchanged after the stop:',
      stepsBack(this.paths, { old: this.old, backup: undefined, checkVersion: this.version }),
    );
    this.block('the steps forward, if the check prints another version:', stepsForward(this.paths));
    throw new Stop(3, undefined);
  }

  /** Spec §20.7: back to the old commit, its tree and its build; the running gateway untouched. */
  private async goBack(failure: Failure): Promise<never> {
    this.unmoved();
    this.phase = 'going back';
    this.writeLock('going back');
    this.say(`${failure.what}: going back to ${short(this.old)}`);
    const run = (cmd: string, args: readonly string[], timeoutMs: number, env: Env): Promise<UpdateRunResult> =>
      this.deps.run(cmd, args, { cwd: this.checkout, env, timeoutMs });
    const reset = await run('git', ['reset', '--keep', this.old], LIMITS.hook, this.gitEnv);
    const failed = (what: string, r: UpdateRunResult): string => `${what} ${r.timedOut ? 'did not finish' : `failed (exit ${r.code})`}`;
    const output = (r: UpdateRunResult): string => `${r.stdout}\n${r.stderr}`;
    if (reset.code !== 0 || reset.timedOut) return await this.stuck(failure, failed(`git reset --keep ${short(this.old)}`, reset), output(reset), this.old);
    if (this.ranCi) {
      const ci = await run(this.npm, ['ci'], LIMITS.npmCi, this.npmEnv);
      if (ci.code !== 0 || ci.timedOut) return await this.stuck(failure, failed('npm ci', ci), output(ci), undefined);
    }
    const build = await run(this.npm, ['run', 'build'], LIMITS.build, this.npmEnv);
    if (build.code !== 0 || build.timedOut) return await this.stuck(failure, failed('npm run build', build), output(build), undefined);
    // Back at the old commit is said only of a clean tree: a hook or a build that wrote into it leaves it for a person.
    const status = await run('git', ['status', '--porcelain', '--untracked-files=normal'], LIMITS.local, this.gitEnv);
    if (status.code !== 0 || status.stdout.trim() !== '') {
      return await this.stuck(failure, status.code !== 0 ? failed('git status', status) : 'the checkout is not clean', output(status), undefined);
    }
    this.sayErr(`mt: ${failure.what}`);
    for (const line of lines(failure.output).slice(-FAILED_TAIL)) this.sayErr(`  ${line}`);
    this.say(`the checkout is back at ${short(this.old)}, and the gateway as it was`);
    throw new Stop(1, undefined);
  }

  /** Going back failed too: what is left, and how to finish by hand. Exit 3. */
  private async stuck(failure: Failure, what: string, output: string, reset: string | undefined): Promise<never> {
    this.sayErr(`mt: ${failure.what}; and going back, ${what}:`);
    for (const line of lines(output).slice(-FAILED_TAIL)) this.sayErr(`  ${line}`);
    const status = await this.deps.run('git', ['status'], { cwd: this.checkout, env: this.gitEnv, timeoutMs: LIMITS.local });
    this.block('git status says:', lines(status.stdout));
    this.block('to finish going back by hand:', finishByHand(this.paths, { reset }));
    this.say('the gateway still runs from memory, but a crash restart would run whatever dist/ and node_modules now hold');
    throw new Stop(3, undefined);
  }

  // -------------------------------------------------------------------------
  // Step 7: restart and confirm.

  private async restart(): Promise<number> {
    const { view } = this;
    const mt = mtCommand(this.node, this.checkout);
    if (!this.willRestart) {
      this.say(
        this.installed
          ? `the service is stopped, so it is not started: start it with ${mt} service start`
          : 'no service is installed: restart the gateway (stop it if it runs, then start it)',
      );
      return 0;
    }
    this.writeLock('restart');
    this.phase = 'restart';
    const from = statSync(view.log, { throwIfNoEntry: false })?.size ?? 0;
    this.say(`restarting ${view.name}`);
    const failed = await view.restart();
    if (failed !== undefined) {
      this.sayErr(`mt: the restart failed: ${failed}`);
      this.say(`the old gateway may have been sent SIGTERM already; whether one runs, and which, is for ${mt} service status`);
      this.stepsBackAfterRestart();
      return 3;
    }
    this.phase = 'waiting';
    this.writeLock('confirm');
    for (let waited = 0; this.signalled === undefined; waited += POLL_MS) {
      const seen = lines(readFrom(view.log, from));
      const failure = seen.find((l) => l.startsWith('configuration error:') || l.startsWith('failed to start:'));
      if (failure !== undefined) {
        this.sayErr(`mt: the new gateway did not start: ${failure}`);
        return this.notConfirmed();
      }
      const schema = seen.findIndex((l) => / schema at version [0-9]+ \(/.test(l));
      const connected = schema === -1 ? -1 : seen.findIndex((l, i) => i > schema && / connected as /.test(l));
      if (connected !== -1) {
        const version = Number(/ schema at version ([0-9]+) \(/.exec(seen[schema] ?? '')?.[1]);
        if (version < this.newest) {
          this.warn(`the gateway is at schema version ${version}, below the new tree's ${this.newest}: it reads its migrations from elsewhere (MT_SCHEMA_DIR)`);
        }
        this.say(`updated ${this.branch} from ${short(this.old)} to ${short(this.new)}; the gateway is connected, at schema version ${version}`);
        return 0;
      }
      if (waited >= CONFIRM_MS) break;
      await this.deps.sleep(POLL_MS);
    }
    this.sayErr(
      this.signalled !== undefined
        ? `mt: interrupted by ${this.signalled} while waiting for the new gateway to connect`
        : `mt: the new gateway did not say it connected within ${CONFIRM_MS / 1000} seconds`,
    );
    return this.notConfirmed();
  }

  private notConfirmed(): number {
    this.block(`the service log's last ${LOG_TAIL} lines:`, tailOf(this.view.log, LOG_TAIL));
    this.stepsBackAfterRestart();
    return 3;
  }

  private stepsBackAfterRestart(): void {
    if (this.backup === undefined) this.say('no backup was taken, as there was no database: the steps back leave out the restore');
    this.block(
      'the steps back, never taken by themselves: the new gateway may have migrated and written, and a restore loses what it wrote since the backup:',
      stepsBack(this.paths, { old: this.old, backup: this.backup }),
    );
  }

  // -------------------------------------------------------------------------

  private onSignal(signal: NodeJS.Signals): void {
    if (this.phase === 'going back') {
      this.say(`${signal}: ignored, as stopping now would leave the state being undone`);
      return;
    }
    if (this.signalled !== undefined) return;
    this.signalled = signal;
    if (this.phase === 'before') this.abort.abort();
    else if (this.phase === 'changing') this.say(`${signal}: going back once the running command ends`);
    else if (this.phase === 'restart') this.say(`${signal}: the restart call is let finish`);
  }

  /**
   * An error nothing foresaw. Up to step 3 nothing changed: the locks go, exit 1.
   * After it the update may be half way, so the locks stay, saying where it
   * stopped, for the next run's advice: exit 3.
   */
  private unexpected(err: unknown): number {
    const message = err instanceof Error ? err.message : String(err);
    if (UNCHANGED_STEPS.includes(this.lock.step)) {
      this.sayErr(`mt: unexpected error: ${message}`);
      return 1;
    }
    this.keepLocks = true;
    this.sayErr(`mt: unexpected error at its step ${this.lock.step}: ${message}`);
    this.say(`its locks are kept, saying where it stopped: ${this.locks.map((l) => l.path).join(', ')}; run mt update again for what to do`);
    return 3;
  }

  async run(): Promise<number> {
    this.deps.guardOutput();
    const off = this.deps.onSignal((signal) => this.onSignal(signal));
    try {
      await this.inspect();
      if (!(await this.show())) return 0;
      if (this.opts.check) {
        if (this.signalled !== undefined) throw new Stop(1, `interrupted by ${this.signalled}: nothing changed`);
        return 0;
      }
      await this.confirm();
      await this.apply();
      return await this.restart();
    } catch (err) {
      if (!(err instanceof Stop)) return this.unexpected(err);
      if (err.refusal !== undefined) this.sayErr(`mt: ${err.refusal}`);
      return err.code;
    } finally {
      off();
      this.db?.close();
      if (!this.keepLocks) for (const lock of [...this.locks].reverse()) lock.release();
    }
  }
}
