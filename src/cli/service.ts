import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AGENT_ENV_PREFIX, ConfigError, GATEWAY_ENV_NAMES, loadConfig, loadTeamSettings, type Env } from '../config.js';
import { readGatewayEnv, type GatewayEnvFile } from '../gateway-env.js';
import { lockHolder, privateDir } from '../kanban/socket.js';
import { loadTeam } from '../team.js';
import { serviceLogPath } from '../service/log.js';
import { launchdPlist, readPlist, readUnit, serviceNames, systemdUnit, type Recorded, type ServiceSpec } from '../service/unit.js';
import { parse, refuse, UsageError } from './args.js';
import type { MtIo } from './mt.js';

/**
 * `mt service`: the gateway as a persistent service, a LaunchAgent on macOS and
 * a systemd user unit on Linux, behind the same commands. It runs the built
 * gateway, `node dist/main.js`, so a merge no longer restarts it: a deploy is
 * `npm run build && mt service restart`.
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
  };
}

export const SERVICE_USAGE = [
  '  mt service install',
  '  mt service uninstall',
  '  mt service start|stop|restart',
  '  mt service status',
  '  mt service logs [-f] [-n <lines>]',
].join('\n');

const SUBCOMMANDS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs'] as const;

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
      default:
        return svc.status();
    }
  } catch (err) {
    if (err instanceof CommandFailed) return refuse(io, err.message);
    throw err;
  }
}

class CommandFailed extends Error {}

interface State {
  loaded: boolean;
  running: boolean;
  pid: number | undefined;
  /** Why it is not running, when the manager says. */
  lastExit: string | undefined;
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
    if (r.code !== 0) {
      const said = (r.stderr.trim() || r.stdout.trim()).split('\n').slice(0, 3).join(' ');
      throw new CommandFailed(`${[cmd, ...args].join(' ')} failed (exit ${r.code})${said === '' ? '' : `: ${said}`}`);
    }
    return r;
  }

  private systemctl(...args: string[]): RunResult {
    return this.must('systemctl', ['--user', ...args]);
  }

  private get job(): string {
    return `${this.t.domain}/${this.t.name}`;
  }

  private state(): State {
    if (this.t.kind === 'launchd') {
      const r = this.run('launchctl', ['print', this.job]);
      if (r.code !== 0) return { loaded: false, running: false, pid: undefined, lastExit: undefined };
      const pid = /^\s*pid = ([0-9]+)$/m.exec(r.stdout)?.[1];
      const running = /^\s*state = running$/m.test(r.stdout);
      const exit = /^\s*last exit code = (.+)$/m.exec(r.stdout)?.[1];
      return { loaded: true, running, pid: pid === undefined ? undefined : Number(pid), lastExit: exit };
    }
    const r = this.run('systemctl', [
      '--user',
      'show',
      this.t.name,
      '--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus',
    ]);
    const prop = (name: string): string | undefined => new RegExp(`^${name}=(.*)$`, 'm').exec(r.stdout)?.[1];
    const pid = Number(prop('MainPID') ?? '0');
    const active = prop('ActiveState');
    return {
      loaded: r.code === 0 && prop('LoadState') === 'loaded',
      running: active === 'active' || active === 'reloading',
      pid: pid > 0 ? pid : undefined,
      lastExit: active === 'failed' ? (prop('ExecMainStatus') ?? undefined) : undefined,
    };
  }

  private installed(): boolean {
    return existsSync(this.t.file);
  }

  private recorded(): Recorded | undefined {
    if (!this.installed()) return undefined;
    const text = readFileSync(this.t.file, 'utf8');
    return this.t.kind === 'launchd' ? readPlist(text) : readUnit(text);
  }

  /** dist/main.js, or a refusal that says to build. */
  private checkBuilt(main = this.t.main): void {
    if (!existsSync(main)) throw new CommandFailed(`${main} does not exist: run npm run build in ${dirname(dirname(main))} first`);
  }

  /** The pid the gateway lock names, when that process is alive. */
  private lockPid(): number | undefined {
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
    this.must('launchctl', ['enable', this.job]);
    this.must('launchctl', ['bootstrap', this.t.domain, this.t.file]);
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
    for (const warning of this.environmentWarnings(file, path)) io.out(`warning: ${warning}`);

    privateDir(join(t.mtHome, 'logs'), 'the service log');
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
    io.out('to deploy a change: npm run build && mt service restart');
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

  /** What the service's environment lacks that this shell's has, and every passEnv name. Names only, never a value. */
  private environmentWarnings(file: GatewayEnvFile, path: string): string[] {
    const { t, io } = this;
    const out: string[] = [];
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
      out.push(`the roles do not load as the service would load them: ${err.message}; run mt role check`);
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
      out.push(`the gateway would not start as the service: ${err.message}`);
    }
    return out;
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
      else this.must('launchctl', ['kickstart', ...(restart ? ['-k'] : []), this.job]);
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
      if (!this.state().loaded) {
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
    io.out(`loaded: ${state.loaded ? 'yes' : 'no'}`);
    io.out(
      state.running
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
