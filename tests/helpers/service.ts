import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunResult, ServiceDeps } from '../../src/cli/service.js';
import { launchdPlist, serviceNames, systemdUnit } from '../../src/service/unit.js';

/**
 * A user home, a gateway home and a checkout in a temporary directory, and a
 * fake launchd and systemd behind `ServiceDeps`: every launchctl and systemctl
 * call is recorded and answered from `job`, none is run. Nothing here reads or
 * writes the real home, or reaches the real service.
 */

export const UID = 501;
export const SECRET = 'lark-secret-never-printed-0000';

export interface Call {
  cmd: string;
  args: string[];
}

export interface ServiceFake {
  root: string;
  /** The user's home. */
  home: string;
  /** The gateway's home, `<home>/.manus-team`. */
  mtHome: string;
  checkout: string;
  /** The node the unit records, in a directory of its own. */
  node: string;
  calls: Call[];
  /** What the manager knows of the job: loaded or not, and the pid of the gateway it runs. */
  job: { loaded: boolean; pid: number | undefined };
  /** False: `launchctl print gui/<uid>` fails, as without a console login. */
  domain: boolean;
  /** The pid the next start gives. */
  nextPid: number;
  /** Called at each start of the gateway, a kickstart or a systemctl start or restart. */
  onStart: (pid: number) => void;
  /** An answer for a call, ahead of the fake's own; undefined to let the fake answer. */
  override: (call: Call) => Partial<RunResult> | undefined;
  /** Pids alive, for the gateway lock. */
  alive: Set<number>;
  /** The files `importModule` was asked for. */
  imports: string[];
  /** What `importModule` answers for a file, or throws; a file not named here is not found. */
  modules: Record<string, Record<string, unknown> | Error>;
  deps(platform?: NodeJS.Platform): ServiceDeps;
  /** Write the unit as `mt service install` writes it, recording `path`. */
  install(opts?: { platform?: NodeJS.Platform; path?: string; checkout?: string; mtHomeSet?: string }): string;
  /** The words of each call, `cmd args...`. */
  words(): string[];
  cleanup(): void;
}

/** A config the gateway starts on, given the .env: an owner, a workspace and an agent. */
export function serviceConfig(workspace: string, extra = ''): string {
  return `workspace: ${workspace}\nauth:\n  owner: ou_owner\nagent:\n  driver: acp\n  command: claude-agent-acp\n${extra}`;
}

export async function serviceFake(opts: { env?: string | false; config?: string } = {}): Promise<ServiceFake> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-svc-')));
  const home = join(root, 'My Home');
  const mtHome = join(home, '.manus-team');
  const checkout = join(root, 'the checkout');
  const workspace = join(root, 'repo');
  mkdirSync(mtHome, { recursive: true, mode: 0o700 });
  mkdirSync(join(checkout, 'dist'), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(join(checkout, 'dist', 'main.js'), '');
  mkdirSync(join(root, 'node bin'));
  const node = join(root, 'node bin', 'node');
  writeFileSync(node, '');
  writeFileSync(join(mtHome, 'config.yaml'), opts.config ?? serviceConfig(workspace));
  if (opts.env !== false) {
    writeFileSync(join(mtHome, '.env'), opts.env ?? `LARK_APP_SECRET=${SECRET}\nLARK_APP_ID=cli_test\n`, { mode: 0o600 });
  }
  const f: ServiceFake = {
    root,
    home,
    mtHome,
    checkout,
    node,
    calls: [],
    job: { loaded: false, pid: undefined },
    domain: true,
    nextPid: 5000,
    onStart: () => {},
    override: () => undefined,
    alive: new Set(),
    imports: [],
    modules: {
      [join(checkout, 'dist', 'index.js')]: await import('../../src/index.js'),
      [join(checkout, 'dist', 'db', 'open.js')]: await import('../../src/db/open.js'),
    },
    deps(platform = 'darwin') {
      const start = (): void => {
        f.job.pid = f.nextPid++;
        f.onStart(f.job.pid);
      };
      return {
        platform,
        home,
        uid: UID,
        node,
        checkout,
        run: (cmd, args) => {
          const call = { cmd, args: [...args] };
          f.calls.push(call);
          const over = f.override(call);
          if (over !== undefined) return { code: 0, stdout: '', stderr: '', ...over };
          const ok = { code: 0, stdout: '', stderr: '' };
          if (cmd === 'launchctl') {
            const [verb, a1] = args;
            if (verb === 'print' && a1 === `gui/${UID}`) return f.domain ? ok : { code: 125, stdout: '', stderr: 'Bad request.\n' };
            if (verb === 'print') {
              if (!f.job.loaded) return { code: 113, stdout: '', stderr: 'Could not find service\n' };
              const running = f.job.pid !== undefined;
              return { ...ok, stdout: `${a1} = {\n\tstate = ${running ? 'running' : 'not running'}\n${running ? `\tpid = ${f.job.pid}\n` : ''}}\n` };
            }
            if (verb === 'kill' && a1 === 'SIGTERM') f.job.pid = undefined;
            if (verb === 'kickstart') start();
            if (verb === 'bootout') f.job = { loaded: false, pid: undefined };
            if (verb === 'bootstrap') {
              f.job.loaded = true;
              start();
            }
            return ok;
          }
          if (cmd === 'systemctl') {
            const verb = args[1];
            if (verb === 'show') {
              const running = f.job.pid !== undefined;
              return {
                ...ok,
                stdout: `LoadState=${f.job.loaded ? 'loaded' : 'not-found'}\nActiveState=${running ? 'active' : 'inactive'}\nMainPID=${f.job.pid ?? 0}\n`,
              };
            }
            if (verb === 'restart' || verb === 'start') start();
            if (verb === 'stop') f.job.pid = undefined;
            return ok;
          }
          return ok;
        },
        follow: async (cmd, args) => {
          f.calls.push({ cmd, args: [...args] });
          return 0;
        },
        alive: (pid) => f.alive.has(pid),
        sleep: async () => {},
        importModule: async (file) => {
          f.imports.push(file);
          const m = f.modules[file];
          if (m instanceof Error) throw m;
          if (m === undefined) throw new Error(`Cannot find module '${file}'`);
          return m;
        },
      };
    },
    install(o = {}) {
      const platform = o.platform ?? 'darwin';
      const mtHomeAt = o.mtHomeSet ?? mtHome;
      const names = serviceNames(home, mtHomeAt);
      const spec = {
        label: platform === 'darwin' ? names.label : names.unit,
        node,
        main: join(o.checkout ?? checkout, 'dist', 'main.js'),
        checkout: o.checkout ?? checkout,
        path: o.path ?? '/unit/bin:/usr/bin:/bin',
        mtHome: o.mtHomeSet,
        log: join(mtHomeAt, 'logs', 'gateway.log'),
      };
      const file =
        platform === 'darwin'
          ? join(home, 'Library', 'LaunchAgents', `${names.label}.plist`)
          : join(home, '.config', 'systemd', 'user', names.unit);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, platform === 'darwin' ? launchdPlist(spec) : systemdUnit(spec));
      f.job.loaded = true;
      return file;
    },
    words: () => f.calls.map((c) => [c.cmd, ...c.args].join(' ')),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return f;
}
