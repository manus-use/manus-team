import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  AGENT_ENV_PREFIX,
  BUNDLED_SCHEMA_DIR,
  ConfigError,
  GATEWAY_ENV_NAMES,
  loadConfig,
  loadTeamSettings,
  schemaDirOf,
  type Env,
} from '../config.js';
import { highestMigration, openDbReadOnly } from '../db/open.js';
import { gatewayEnvPath, loadGatewayEnv, readGatewayEnv, type GatewayEnvFile } from '../gateway-env.js';
import { lockHolder, privateDir } from '../kanban/socket.js';
import { addSecrets, redactKnownSecrets } from '../secrets.js';
import { loadTeam } from '../team.js';
import { serviceLogPath } from '../service/log.js';
import { launchdPlist, readPlist, readUnit, serviceNames, systemdUnit, type Recorded, type ServiceSpec } from '../service/unit.js';
import { parse, refuse, UsageError } from './args.js';
import type { MtIo } from './mt.js';
import { findNpm, npmCommand, shQuote } from './shell.js';

/**
 * `mt service`: the gateway as a persistent service, a LaunchAgent on macOS and
 * a systemd user unit on Linux, behind the same commands. It runs the built
 * gateway, `node dist/main.js`, so a merge no longer restarts it: a deploy is
 * `mt update` (`cli/update.ts`), which ends with `mt service restart`'s code.
 *
 * Every launchctl, systemctl and tail call goes through `ServiceDeps.run` or
 * `follow`, and every file is under `ServiceDeps.home` or the gateway's home,
 * so a test gives a temporary home and a runner that records calls and runs none.
 */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ServiceDeps {
  platform: NodeJS.Platform;
  /** The user's home: where ~/Library/LaunchAgents and ~/.config/systemd/user are. */
  home: string;
  uid: number;
  /** The node the service runs: the absolute path of the one running this. */
  node: string;
  /** The checkout whose dist/main.js the service runs. */
  checkout: string;
  /** Runs a command to completion, capturing its output. */
  run: (cmd: string, args: readonly string[]) => RunResult;
  /** Runs a command with this terminal, until it exits: `tail -F`. */
  follow: (cmd: string, args: readonly string[]) => Promise<number>;
  /** Whether a process has this pid. */
  alive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  /**
   * Imports a module of the build by its path: `mt service check` loads the
   * gateway's graph this way (spec §20.5). Injectable so a test gives modules
   * of its own; the real one is `import()`.
   */
  importModule?: (file: string) => Promise<Record<string, unknown>>;
}

/** `import()` of a file by its path. */
export async function importFile(file: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
}

/** The real ones: this node, this checkout, this user. */
export function realServiceDeps(): ServiceDeps {
  // dist/cli/service.js or src/cli/service.ts: the checkout is two up.
  const checkout = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  return {
    platform: process.platform,
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    node: process.execPath,
    checkout,
    run: (cmd, args) => {
      const r = spawnSync(cmd, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (r.error !== undefined) return { code: 127, stdout: '', stderr: r.error.message };
      return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
    follow: (cmd, args) =>
      new Promise((done) => {
        const child = spawn(cmd, [...args], { stdio: 'inherit' });
        child.once('error', () => done(127));
        child.once('exit', (code) => done(code ?? 0));
      }),
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    importModule: importFile,
  };
}

export const SERVICE_USAGE = [
  '  mt service install',
  '  mt service uninstall',
  '  mt service start|stop|restart',
  '  mt service status',
  '  mt service logs [-f] [-n <lines>]',
  '  mt service check',
].join('\n');

const SUBCOMMANDS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs', 'check'] as const;

/** The default home's own name: `~/.manus-team`. */
const DEFAULT_HOME_DIR = '.manus-team';

/** The .env line the README gives: writes the secret without printing it, and refuses when it is not set. */
function envLine(path: string): string {
  const q = `'${path.replaceAll("'", `'\\''`)}'`;
  return `(umask 077; printf 'LARK_APP_SECRET=%s\\n' "\${LARK_APP_SECRET:?is not set}" > ${q}) && chmod 600 ${q}`;
}

/** Where everything is for this home, on this platform. */
interface Target {
  kind: 'launchd' | 'systemd';
  /** The launchd label, or the systemd unit's name. */
  name: string;
  /** The plist or the unit file. */
  file: string;
  /** `gui/<uid>` on macOS. */
  domain: string;
  /** The home as set in the shell, or undefined for the default. */
  mtHomeSet: string | undefined;
  mtHome: string;
  log: string;
  main: string;
}

function target(io: MtIo, deps: ServiceDeps): Target {
  const set = io.env['MT_HOME'];
  const mtHomeSet = set === undefined || set.trim() === '' ? undefined : resolve(set);
  const mtHome = mtHomeSet ?? join(deps.home, DEFAULT_HOME_DIR);
  const names = serviceNames(deps.home, mtHome);
  const common = {
    mtHomeSet,
    mtHome,
    log: serviceLogPath(mtHome),
    main: join(deps.checkout, 'dist', 'main.js'),
    domain: `gui/${deps.uid}`,
  };
  if (deps.platform === 'darwin') {
    return { kind: 'launchd', name: names.label, file: join(deps.home, 'Library', 'LaunchAgents', `${names.label}.plist`), ...common };
  }
  return { kind: 'systemd', name: names.unit, file: join(deps.home, '.config', 'systemd', 'user', names.unit), ...common };
}

/** What `mt update` needs of the service (spec §20.13): its unit, its state, the home's lock, its environment, its log, and its restart. */
export interface ServiceView {
  readonly kind: 'launchd' | 'systemd';
  readonly name: string;
  /** The plist or the unit file. */
  readonly file: string;
  readonly mtHome: string;
  /** MT_HOME as this shell sets it, or undefined for the default home. */
  readonly mtHomeSet: string | undefined;
  readonly log: string;
  installed(): boolean;
  /** What the unit records, or undefined for a unit `mt service install` did not write, or none. */
  recorded(): Recorded | undefined;
  state(): State;
  /** The pid the gateway lock names, when that process is alive. */
  lockPid(): number | undefined;
  /**
   * The service's environment, as its settings are loaded: HOME, the PATH the
   * unit records, MT_HOME and the gateway's .env. A .env the gateway would
   * refuse is a ConfigError.
   */
  env(recorded: Recorded): Env;
  /** `mt service restart`'s own code: undefined when it restarted, else why not. */
  restart(): Promise<string | undefined>;
}

export function serviceView(io: MtIo, deps: ServiceDeps): ServiceView {
  const t = target(io, deps);
  const svc = new Service(t, deps, io);
  return {
    kind: t.kind,
    name: t.name,
    file: t.file,
    mtHome: t.mtHome,
    mtHomeSet: t.mtHomeSet,
    log: t.log,
    installed: () => svc.installed(),
    recorded: () => svc.recorded(),
    state: () => svc.state(),
    lockPid: () => svc.lockPid(),
    env: (recorded) => ({ HOME: deps.home, PATH: recorded.path, MT_HOME: t.mtHome, ...readGatewayEnv({ MT_HOME: t.mtHome }).values }),
    restart: async () => {
      try {
        return (await svc.start(true)) === 0 ? undefined : 'mt service restart refused, as said above';
      } catch (err) {
        if (err instanceof CommandFailed) return err.message;
        throw err;
      }
    },
  };
}

/** `mt service <command>`. */
export async function serviceCommand(argv: readonly string[], io: MtIo): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new UsageError(`mt service <${SUBCOMMANDS.join('|')}>${sub === undefined ? '' : `: unknown command ${sub}`}`);
  }
  const deps = io.service ?? realServiceDeps();
  if (deps.platform !== 'darwin' && deps.platform !== 'linux') {
    return refuse(io, `mt service supports macOS and Linux only, not ${deps.platform}`);
  }
  const t = target(io, deps);
  const svc = new Service(t, deps, io);
  if (sub === 'logs') {
    const { values, positionals } = parse(rest, { follow: { type: 'boolean', short: 'f' }, lines: { type: 'string', short: 'n' } });
    if (positionals.length > 0) throw new UsageError('service logs takes no arguments');
    const lines = values.lines ?? '50';
    if (!/^[0-9]{1,7}$/.test(lines)) throw new UsageError('-n is a whole number of lines');
    return await svc.logs(Number(lines), values.follow === true);
  }
  if (parse(rest, {}).positionals.length > 0) throw new UsageError(`service ${sub} takes no arguments`);
  try {
    switch (sub) {
      case 'install':
        return await svc.install();
      case 'uninstall':
        return await svc.uninstall();
      case 'start':
        return await svc.start(false);
      case 'restart':
        return await svc.start(true);
      case 'stop':
        return await svc.stop();
      case 'check':
        return await svc.check();
      default:
        return svc.status();
    }
  } catch (err) {
    if (err instanceof CommandFailed) return refuse(io, err.message);
    throw err;
  }
}

class CommandFailed extends Error {}

/**
 * What a name left unset is given for `loadStartup`, when a gateway started by
 * hand is checked. Registered as a secret, so it is masked like one; at least
 * MIN_SECRET_LENGTH long, as a shorter value is never masked.
 */
const STAND_IN = '(unset here)';

/** An error's message, or the value as text. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `database: <path> at version 8; this build: up to 9` (spec §20.5): the
 * database the gateway would open, found from `env` by the settings alone, its
 * `user_version` read read-only, and the highest migration of the directory the
 * gateway reads them from, named when it is not this build's own, or unknown
 * when that directory cannot be read. Never throws: settings that are refused,
 * or an environment that could not be read, given as the error, give
 * `database: unknown (<error>)`. With it, when the database is above the
 * build's highest, the refusal `migrate` would give: the check fails on it,
 * after the line, as the gateway would not start (spec §20.6).
 */
function versionCheck(env: Env | Error): { line: string; tooNew: string | undefined } {
  try {
    if (env instanceof Error) throw env;
    const settings = loadTeamSettings(env, undefined, { unsetPassEnv: [] });
    const dir = schemaDirOf(env);
    const from = dir === BUNDLED_SCHEMA_DIR ? '' : `migrations from ${dir}, MT_SCHEMA_DIR`;
    let build: string;
    let highest: number | undefined;
    try {
      highest = highestMigration(dir);
      build = `this build: up to ${highest}${from === '' ? '' : ` (${from})`}`;
    } catch (err) {
      // A directory that cannot be read leaves the database's own version worth saying.
      build = `this build's highest is unknown (${from === '' ? '' : `${from}: `}${errorText(err)})`;
    }
    const db = openDbReadOnly(settings.dbPath);
    if (db === undefined) return { line: `database: ${settings.dbPath}: no database; ${build}`, tooNew: undefined };
    try {
      const version = Number(db.pragma('user_version', { simple: true }));
      const tooNew =
        highest !== undefined && version > highest
          ? `the database is at schema version ${version}, and this build knows only up to ${highest}: it was migrated by a newer build. ` +
            `Run that build, or restore a backup of version ${highest}`
          : undefined;
      return { line: `database: ${settings.dbPath} at version ${version}; ${build}`, tooNew };
    } finally {
      db.close();
    }
  } catch (err) {
    return { line: `database: unknown (${errorText(err)})`, tooNew: undefined };
  }
}

/** How long restart waits for the gateway to drain and exit after SIGTERM, and how often it looks. */
const RESTART_WAIT_MS = 60_000;
const POLL_MS = 250;

export interface State {
  loaded: boolean;
  running: boolean;
  pid: number | undefined;
  /** Why it is not running, when the manager says. */
  lastExit: string | undefined;
  /**
   * Why the manager could not be asked, when it could not: no gui domain on
   * macOS, no user bus on Linux. Then `loaded` and `running` are false and mean
   * nothing; `mt update` refuses rather than take it as stopped (spec §20.2).
   */
  unreadable: string | undefined;
}

/** What to do when the service's state cannot be read: where launchd or the user's systemd answers. */
export function unreadableHint(kind: 'launchd' | 'systemd'): string {
  return kind === 'launchd'
    ? "a LaunchAgent needs someone logged in at the Mac's console: log in there, then run this again"
    : "run it where the user's systemd answers: a login session, or with loginctl enable-linger";
}

/** A failed command's first lines, for a message: `cmd args failed (exit N): what it said`. */
function failure(cmd: string, args: readonly string[], r: RunResult): string {
  const said = (r.stderr.trim() || r.stdout.trim()).split('\n').slice(0, 3).join(' ');
  return `${[cmd, ...args].join(' ')} failed (exit ${r.code})${said === '' ? '' : `: ${said}`}`;
}

class Service {
  constructor(
    private readonly t: Target,
    private readonly deps: ServiceDeps,
    private readonly io: MtIo,
  ) {}

  private run(cmd: string, args: readonly string[]): RunResult {
    return this.deps.run(cmd, args);
  }

  /** Run it, and throw CommandFailed with its stderr when it fails. */
  private must(cmd: string, args: readonly string[]): RunResult {
    const r = this.run(cmd, args);
    if (r.code !== 0) throw new CommandFailed(failure(cmd, args, r));
    return r;
  }

  private systemctl(...args: string[]): RunResult {
    return this.must('systemctl', ['--user', ...args]);
  }

  private get job(): string {
    return `${this.t.domain}/${this.t.name}`;
  }

  /**
   * What the manager says of the job. A failure to ask is `unreadable`, never
   * "not loaded": on macOS a job that cannot be printed is not loaded only when
   * its domain can be, as `gui/<uid>` is missing without a console login; on
   * Linux `systemctl --user show` answers for any unit, so its failure is the
   * user bus's.
   */
  state(): State {
    const none = { loaded: false, running: false, pid: undefined, lastExit: undefined, unreadable: undefined };
    if (this.t.kind === 'launchd') {
      const r = this.run('launchctl', ['print', this.job]);
      if (r.code !== 0) {
        // Only when the job's print fails: a job that prints has a domain.
        const domain = this.run('launchctl', ['print', this.t.domain]);
        return domain.code === 0 ? none : { ...none, unreadable: failure('launchctl', ['print', this.t.domain], domain) };
      }
      const pid = /^\s*pid = ([0-9]+)$/m.exec(r.stdout)?.[1];
      const running = /^\s*state = running$/m.test(r.stdout);
      const exit = /^\s*last exit code = (.+)$/m.exec(r.stdout)?.[1];
      return { loaded: true, running, pid: pid === undefined ? undefined : Number(pid), lastExit: exit, unreadable: undefined };
    }
    const args = ['--user', 'show', this.t.name, '--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus'];
    const r = this.run('systemctl', args);
    if (r.code !== 0) return { ...none, unreadable: failure('systemctl', args, r) };
    const prop = (name: string): string | undefined => new RegExp(`^${name}=(.*)$`, 'm').exec(r.stdout)?.[1];
    const pid = Number(prop('MainPID') ?? '0');
    const active = prop('ActiveState');
    return {
      loaded: prop('LoadState') === 'loaded',
      running: active === 'active' || active === 'reloading',
      pid: pid > 0 ? pid : undefined,
      lastExit: active === 'failed' ? (prop('ExecMainStatus') ?? undefined) : undefined,
      unreadable: undefined,
    };
  }

  installed(): boolean {
    return existsSync(this.t.file);
  }

  recorded(): Recorded | undefined {
    if (!this.installed()) return undefined;
    const text = readFileSync(this.t.file, 'utf8');
    return this.t.kind === 'launchd' ? readPlist(text) : readUnit(text);
  }

  /** dist/main.js, or a refusal that says to build. */
  private checkBuilt(main = this.t.main): void {
    if (!existsSync(main)) throw new CommandFailed(`${main} does not exist: run npm run build in ${dirname(dirname(main))} first`);
  }

  /** The pid the gateway lock names, when that process is alive. */
  lockPid(): number | undefined {
    try {
      const pid = lockHolder(join(this.t.mtHome, 'run', 'gateway.pid'));
      return pid !== undefined && this.deps.alive(pid) ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  /** A warning when a gateway that is not the service holds the home. The service's pid is asked only when a lock is held. */
  private warnOtherGateway(servicePid: () => number | undefined): void {
    const pid = this.lockPid();
    if (pid === undefined || pid === servicePid()) return;
    this.io.out(
      `warning: a gateway (pid ${pid}) is running on ${this.t.mtHome}, not as this service; perhaps npm run dev. ` +
        'stop it first: the service cannot take the home while it runs, and keeps retrying',
    );
  }

  /** Bootstrap the plist, enabled first, since a disabled job refuses to load. */
  private bootstrap(): void {
    try {
      this.must('launchctl', ['enable', this.job]);
      this.must('launchctl', ['bootstrap', this.t.domain, this.t.file]);
    } catch (err) {
      if (!(err instanceof CommandFailed)) throw err;
      const hint = /domain/i.test(err.message)
        ? `${this.t.domain} does not exist until someone logs in: log in at the Mac's console (a LaunchAgent cannot run from an ssh session alone), then run this again`
        : 'if System Settings > General > Login Items has this item switched off under Allow in the Background, switch it on and run this again';
      throw new CommandFailed(`${err.message}. ${hint}`);
    }
  }

  /**
   * Restart a loaded job, letting the gateway drain. `kickstart -k` is not
   * documented to send SIGTERM rather than SIGKILL, so the gateway is sent
   * SIGTERM, waited for, and kickstarted; past RESTART_WAIT_MS, `kickstart -k`.
   */
  private async restartJob(state: State): Promise<void> {
    if (!state.running) {
      this.must('launchctl', ['kickstart', this.job]);
      return;
    }
    this.must('launchctl', ['kill', 'SIGTERM', this.job]);
    for (let waited = 0; waited < RESTART_WAIT_MS; waited += POLL_MS) {
      const now = this.state();
      // Gone, or a new process: KeepAlive starts one again when the old one exits other than cleanly.
      if (!now.running || (now.pid !== undefined && now.pid !== state.pid)) {
        this.must('launchctl', ['kickstart', this.job]);
        return;
      }
      await this.deps.sleep(POLL_MS);
    }
    this.io.out(`warning: ${this.t.name} did not exit within ${RESTART_WAIT_MS / 1000} seconds of SIGTERM; killing it`);
    this.must('launchctl', ['kickstart', '-k', this.job]);
  }

  /** Boot the job out, and wait until launchd has let it go: bootstrap right after can fail while it is still stopping. */
  private async bootout(): Promise<void> {
    this.must('launchctl', ['bootout', this.job]);
    for (let i = 0; i < 40; i += 1) {
      if (this.run('launchctl', ['print', this.job]).code !== 0) return;
      await this.deps.sleep(250);
    }
  }

  async install(): Promise<number> {
    const { t, io, deps } = this;
    this.checkBuilt();
    const file = this.gatewayEnv();
    const path = io.env['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin';
    const spec: ServiceSpec = {
      label: t.name,
      node: deps.node,
      main: t.main,
      checkout: deps.checkout,
      path,
      mtHome: t.mtHomeSet,
      log: t.log,
    };
    let text: string;
    try {
      text = t.kind === 'launchd' ? launchdPlist(spec) : systemdUnit(spec);
    } catch (err) {
      return refuse(io, (err as Error).message);
    }
    const checked = this.checkEnvironment(file, path);
    for (const warning of checked.warnings) io.out(`warning: ${warning}`);
    // Refused, as a missing secret is: a unit sure to fail would be retried every 30 seconds.
    if (checked.problem !== undefined) {
      return refuse(
        io,
        `the gateway would not start as the service, which has only PATH, MT_HOME and ${file.path}: ${checked.problem}. ` +
          'Fix it, check with mt role check, and run mt service install again',
      );
    }

    privateDir(join(t.mtHome, 'logs'), 'the service log');
    // Created owner-only before launchd or systemd first opens it, which would give it the umask's mode.
    writeFileSync(t.log, '', { flag: 'a', mode: 0o600 });
    chmodSync(t.log, 0o600);
    mkdirSync(dirname(t.file), { recursive: true });
    const staging = join(dirname(t.file), `.${t.name}-${randomUUID()}`);
    try {
      writeFileSync(staging, text, { mode: 0o644, flag: 'wx' });
      chmodSync(staging, 0o644);
      renameSync(staging, t.file);
    } finally {
      rmSync(staging, { force: true });
    }
    io.out(`wrote ${t.file}`);

    if (t.kind === 'launchd') {
      const before = this.state();
      this.warnOtherGateway(() => before.pid);
      // Out and in again, so a rewritten plist is the one loaded.
      if (before.loaded) await this.bootout();
      this.bootstrap();
      io.out(`loaded ${this.job}; launchd starts it now and at each login`);
    } else {
      this.warnOtherGateway(() => this.state().pid);
      this.systemctl('daemon-reload');
      this.systemctl('enable', t.name);
      // Restart, not start: a rewritten unit takes effect on a running service too.
      this.systemctl('restart', t.name);
      io.out(`enabled and started ${t.name}`);
      io.out(`on a server, run loginctl enable-linger ${io.env['USER'] ?? '$USER'} so it keeps running after you log out`);
    }
    io.out(`log: ${t.log}`);
    io.out('check it with: mt service status, and mt service logs -f');
    io.out('to deploy a change: mt update');
    return 0;
  }

  /**
   * The gateway's .env, which must set LARK_APP_SECRET: the service starts with
   * no shell environment, only PATH and MT_HOME, so that file is where its secret is.
   */
  private gatewayEnv(): GatewayEnvFile {
    const { t } = this;
    let file: GatewayEnvFile;
    try {
      file = readGatewayEnv({ MT_HOME: t.mtHome });
    } catch (err) {
      if (err instanceof ConfigError) throw new CommandFailed(err.message);
      throw err;
    }
    if (!file.present) {
      throw new CommandFailed(
        `${file.path} does not exist. The service starts with no shell environment, so the gateway's secret must be in that file. ` +
          `Create it, in a shell that holds the secret, with: ${envLine(file.path)}`,
      );
    }
    if ((file.values['LARK_APP_SECRET'] ?? '') === '') {
      throw new CommandFailed(
        `${file.path} does not set LARK_APP_SECRET. The service starts with no shell environment, so the gateway's secret must be in that file. ` +
          `Add the line LARK_APP_SECRET=... to it with an editor`,
      );
    }
    return file;
  }

  /**
   * What the service's environment lacks that this shell's has, and every
   * passEnv name, as warnings; and the first reason the gateway would not start
   * as the service, a passEnv name aside, as a problem. Names only, never a value.
   */
  private checkEnvironment(file: GatewayEnvFile, path: string): { warnings: string[]; problem: string | undefined } {
    const { t, io } = this;
    const out: string[] = [];
    const problems: string[] = [];
    for (const [name, value] of Object.entries(io.env)) {
      if (value === undefined || name === 'MT_HOME' || name in file.values) continue;
      const gateways = (GATEWAY_ENV_NAMES as readonly string[]).includes(name) || name.startsWith(AGENT_ENV_PREFIX);
      if (!gateways) continue;
      const where = name === 'MT_CONFIG' || name === 'MT_DB' ? 'and it cannot be set in that file' : `put it in ${file.path}`;
      out.push(`${name} is set in this shell and not in ${file.path}; the service will not have it: ${where}`);
    }

    // The service's environment, as the gateway will see it.
    const env: Env = { HOME: this.deps.home, PATH: path, MT_HOME: t.mtHome, ...file.values };
    const unset: string[] = [];
    let defaultFromBlock = true;
    try {
      const settings = loadTeamSettings(env, undefined, { unsetPassEnv: unset });
      const team = loadTeam(settings, env, { unsetPassEnv: unset });
      defaultFromBlock = team.roles.get('default')?.source !== 'directory';
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      problems.push(err.message);
    }
    const names = [...new Set(unset)];
    for (const entry of names) {
      const [role = '', name = ''] = entry.split(': ');
      const fix =
        role === 'default' && defaultFromBlock
          ? `set ${AGENT_ENV_PREFIX}${name} in ${file.path} and remove it from agent.passEnv`
          : `put it in ${join(t.mtHome, 'roles', role, '.env')} and remove it from passEnv`;
      out.push(`role ${role} names ${name} in agent.passEnv; the service will not have it, since it starts with only PATH and MT_HOME: ${fix}`);
    }
    // The rest of the gateway's settings, each unset passEnv name given a stand-in.
    const filled: Record<string, string | undefined> = { ...env };
    for (const entry of names) filled[entry.split(': ')[1] ?? ''] = '(unset)';
    try {
      loadConfig(filled);
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      problems.push(err.message);
    }
    return { warnings: out, problem: problems[0] };
  }

  /**
   * `mt service check` (spec §20.5): whether this build would start as the
   * service, without installing; what `mt update` runs, in the new build, as
   * its preflight. First the database's version line, whatever the rest finds;
   * then install's check of the configuration, with the PATH the unit records;
   * last, the gateway's modules and better-sqlite3's native one, loaded.
   */
  async check(): Promise<number> {
    const { t, io, deps } = this;
    if (!this.installed()) return await this.checkByHand();
    const recorded = this.recorded();
    const path = recorded?.path ?? io.env['PATH'] ?? '';
    let env: Env | Error;
    try {
      env = { HOME: deps.home, PATH: path, MT_HOME: t.mtHome, ...readGatewayEnv({ MT_HOME: t.mtHome }).values };
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      env = err;
    }
    const version = versionCheck(env);
    io.out(redactKnownSecrets(version.line));
    if (version.tooNew !== undefined) throw new CommandFailed(version.tooNew);
    if (recorded === undefined) {
      throw new CommandFailed(`${t.file} was not written by mt service install; run mt service install to write it again`);
    }
    io.out(`checking as ${t.name} starts it: with PATH ${recorded.path}, MT_HOME ${t.mtHome} and ${join(t.mtHome, '.env')}`);
    const file = this.gatewayEnv();
    const checked = this.checkEnvironment(file, recorded.path);
    for (const warning of checked.warnings) io.out(`warning: ${warning}`);
    if (checked.problem !== undefined) {
      throw new CommandFailed(
        `the gateway would not start as the service, which has only PATH, MT_HOME and ${file.path}: ${checked.problem}`,
      );
    }
    // The npm the native load's advice names is found as the service's PATH finds it.
    await this.loadModules(recorded.path);
    io.out(`ok: this build would start as ${t.name}`);
    return 0;
  }

  /**
   * With no unit installed, a gateway started by hand from this shell is
   * checked (spec §20.5): no .env is required, as such a gateway may take its
   * secret from the shell. `mt role check`'s loads, over this shell's
   * environment over the .env, collecting the passEnv names left unset; then
   * the startup's own `loadStartup`, from the build's dist/index.js, on a copy
   * of this shell's environment in which a stand-in fills only what is unset
   * or empty in the merged one: each such passEnv name, and the Lark secret.
   */
  private async checkByHand(): Promise<number> {
    const { io, t } = this;
    // The home as this command found it, which is where such a gateway would look.
    const shell: Env = { ...io.env, MT_HOME: t.mtHome };
    let merged: Env | Error;
    try {
      merged = loadGatewayEnv(shell).env;
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      merged = err;
    }
    const version = versionCheck(merged);
    io.out(redactKnownSecrets(version.line));
    if (version.tooNew !== undefined) throw new CommandFailed(version.tooNew);
    if (merged instanceof Error) throw new CommandFailed(merged.message);
    io.out(`checking as a gateway started by hand from this shell, over ${gatewayEnvPath(shell)}: no service is installed`);
    const unset: string[] = [];
    try {
      const settings = loadTeamSettings(merged, undefined, { unsetPassEnv: unset });
      loadTeam(settings, merged, { unsetPassEnv: unset });
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      throw new CommandFailed(`the gateway would not start: ${err.message}`);
    }
    const gateway = await this.loadModules();
    const loadStartup = gateway['loadStartup'];
    if (typeof loadStartup !== 'function') throw new CommandFailed("the build's dist/index.js has no loadStartup");

    const copy: Record<string, string | undefined> = { ...shell };
    const blank = (name: string): boolean => (merged[name] ?? '').trim() === '';
    const filled = [...new Set(unset.map((entry) => entry.split(': ')[1] ?? ''))].filter(blank);
    if (blank('LARK_APP_SECRET')) filled.push('LARK_APP_SECRET');
    addSecrets([STAND_IN]);
    for (const name of filled) {
      copy[name] = STAND_IN;
      io.out(`note: ${name} is not set here: the gateway will need it from the shell that starts it`);
    }
    try {
      loadStartup(copy);
    } catch (err) {
      throw new CommandFailed(`the gateway would not start: ${errorText(err)}`);
    }
    io.out('ok: this build would start as a gateway started by hand from this shell');
    return 0;
  }

  /**
   * The gateway's whole module graph, imported from this build's dist/index.js,
   * which starts nothing; and an in-memory database, which loads better-sqlite3's
   * native module. Dynamic, so a broken graph fails the check, not mt itself.
   * Answers the imported index, for its loadStartup. The npm named when the
   * native module fails is found beside the node, else on `path`.
   */
  private async loadModules(path: string | undefined = this.io.env['PATH']): Promise<Record<string, unknown>> {
    const { deps } = this;
    const importModule = deps.importModule ?? importFile;
    const index = join(deps.checkout, 'dist', 'index.js');
    let gateway: Record<string, unknown>;
    try {
      gateway = await importModule(index);
    } catch (err) {
      throw new CommandFailed(`the gateway's modules do not load from ${index}: ${errorText(err)}`);
    }
    try {
      const open = await importModule(join(deps.checkout, 'dist', 'db', 'open.js'));
      const openDb = open['openDb'];
      if (typeof openDb !== 'function') throw new Error('dist/db/open.js has no openDb');
      (openDb(':memory:') as { close(): void }).close();
    } catch (err) {
      const npm = findNpm(deps.node, path) ?? 'npm';
      throw new CommandFailed(
        `better-sqlite3's native module does not load under ${deps.node}: ${errorText(err)}. ` +
          `Build it for this node by hand: cd ${shQuote(deps.checkout)} && ${npmCommand(deps.node, npm, 'ci')}`,
      );
    }
    return gateway;
  }

  async uninstall(): Promise<number> {
    const { t, io } = this;
    // systemd knows a unit only from its file; launchd may hold a job whose plist is gone.
    const loadedNow = t.kind === 'launchd' && this.state().loaded;
    if (!loadedNow && !this.installed()) {
      io.out(`not installed: ${t.file} does not exist`);
      return 0;
    }
    if (t.kind === 'launchd') {
      if (loadedNow) await this.bootout();
      rmSync(t.file, { force: true });
    } else {
      this.systemctl('disable', '--now', t.name);
      rmSync(t.file, { force: true });
      this.systemctl('daemon-reload');
    }
    io.out(`stopped ${t.name} and removed ${t.file}; ${t.mtHome} is as it was`);
    return 0;
  }

  /** start, or restart when `restart`. */
  async start(restart: boolean): Promise<number> {
    const { t, io } = this;
    const recorded = this.recorded();
    if (!this.installed()) return refuse(io, `not installed: ${t.file} does not exist; run mt service install`);
    this.checkBuilt(recorded?.main);
    if (recorded !== undefined && !existsSync(recorded.node)) {
      return refuse(io, `the node the service runs, ${recorded.node}, is gone; run mt service install again with the node to use`);
    }
    if (t.kind === 'launchd') {
      const state = this.state();
      this.warnOtherGateway(() => state.pid);
      if (!state.loaded) this.bootstrap();
      else if (restart) await this.restartJob(state);
      else this.must('launchctl', ['kickstart', this.job]);
    } else {
      this.warnOtherGateway(() => this.state().pid);
      this.systemctl(restart ? 'restart' : 'start', t.name);
    }
    io.out(`${restart ? 'restarted' : 'started'} ${t.name}; see mt service status`);
    return 0;
  }

  async stop(): Promise<number> {
    const { t, io } = this;
    if (t.kind === 'launchd') {
      // Booted out, not killed: KeepAlive would start a killed one again. It loads again at the next login, or mt service start.
      const state = this.state();
      if (state.unreadable !== undefined) {
        throw new CommandFailed(`the service's state cannot be read, so whether it runs is unknown: ${state.unreadable}. ${unreadableHint(t.kind)}`);
      }
      if (!state.loaded) {
        io.out(`${t.name} is not running`);
        return 0;
      }
      await this.bootout();
    } else {
      this.systemctl('stop', t.name);
    }
    io.out(`stopped ${t.name}`);
    return 0;
  }

  status(): number {
    const { t, io } = this;
    const state = this.state();
    io.out(`service: ${t.name} (${t.kind}${t.kind === 'launchd' ? `, ${t.domain}` : ''})`);
    io.out(`unit: ${t.file}`);
    if (!this.installed()) io.out('installed: no; run mt service install');
    io.out(`loaded: ${state.unreadable !== undefined ? `unknown (${state.unreadable})` : state.loaded ? 'yes' : 'no'}`);
    io.out(
      state.unreadable !== undefined
        ? 'running: unknown'
        : state.running
          ? `running: yes${state.pid === undefined ? '' : `, pid ${state.pid}`}`
          : `running: no${state.lastExit === undefined ? '' : ` (last exit code ${state.lastExit})`}`,
    );
    const recorded = this.recorded();
    if (recorded !== undefined) {
      io.out(`node: ${recorded.node}${existsSync(recorded.node) ? '' : ' (missing: run mt service install again)'}`);
      io.out(`checkout: ${recorded.checkout}`);
      io.out(`entry: ${recorded.main}${existsSync(recorded.main) ? '' : ' (missing: run npm run build)'}`);
      io.out(`PATH: ${recorded.path}`);
      io.out(`MT_HOME: ${recorded.mtHome ?? `not set (${t.mtHome})`}`);
      io.out(`log: ${recorded.log}`);
    } else if (this.installed()) {
      io.out(`note: ${t.file} was not written by mt service install; run it again`);
    }
    const lockPath = join(t.mtHome, 'run', 'gateway.pid');
    const pid = this.lockPid();
    if (pid === undefined) {
      io.out(`pid lock: ${lockPath} names no running gateway (it is taken only with kanban.enabled)`);
    } else if (pid === state.pid) {
      io.out(`pid lock: ${lockPath} names pid ${pid}, the service's`);
    } else {
      io.out(`pid lock: ${lockPath} names pid ${pid}, not the service's: another gateway holds the home; stop it`);
    }
    return state.running ? 0 : 1;
  }

  async logs(lines: number, follow: boolean): Promise<number> {
    const { t, io } = this;
    if (!existsSync(t.log)) return refuse(io, `no log yet at ${t.log}`);
    if (follow) return await this.deps.follow('tail', ['-n', String(lines), '-F', t.log]);
    const text = readFileSync(t.log, 'utf8');
    const all = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
    for (const line of lines === 0 || text === '' ? [] : all.slice(-lines)) io.out(line);
    return 0;
  }
}
