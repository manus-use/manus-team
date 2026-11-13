import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import type { RunResult, ServiceDeps } from '../src/cli/service.js';
import { readPlist, readUnit } from '../src/service/unit.js';

const SECRET = 'lark-secret-never-printed-0000';

/** A config the gateway starts on, given the fixture's .env: an owner, a workspace and an agent. */
function config(workspace: string, agentExtra = ''): string {
  return `workspace: ${workspace}\nauth:\n  owner: ou_owner\nagent:\n  driver: acp\n  command: claude-agent-acp\n${agentExtra}`;
}
const UID = 501;

interface Call {
  cmd: string;
  args: string[];
}

/**
 * A temporary user home, a checkout with a built dist/main.js, and a runner
 * that records every launchctl, systemctl and tail call and runs none. Nothing
 * here reads or writes the real home.
 */
interface Fx {
  root: string;
  home: string;
  mtHome: string;
  checkout: string;
  calls: Call[];
  /** What each command answers: the first rule matching its words wins; else code 0 and no output. */
  answers: { match: (c: Call) => boolean; result: Partial<RunResult> | ((c: Call) => Partial<RunResult>) }[];
  alive: Set<number>;
  booted: boolean;
  run(argv: string[], opts?: { env?: Record<string, string | undefined>; platform?: NodeJS.Platform }): Promise<{ code: number; out: string; err: string }>;
}

let fx: Fx;
afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

function fixture(opts: { dirName?: string; built?: boolean; env?: string | false } = {}): Fx {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-service-')));
  const home = join(root, opts.dirName ?? 'My Home');
  const mtHome = join(home, '.manus-team');
  const checkout = join(root, 'the checkout');
  mkdirSync(mtHome, { recursive: true, mode: 0o700 });
  mkdirSync(join(checkout, 'dist'), { recursive: true });
  if (opts.built !== false) writeFileSync(join(checkout, 'dist', 'main.js'), '');
  mkdirSync(join(root, 'node bin'));
  writeFileSync(join(root, 'node bin', 'node'), '');
  writeFileSync(join(mtHome, 'config.yaml'), config(checkout));
  if (opts.env !== false) {
    writeFileSync(join(mtHome, '.env'), opts.env ?? `LARK_APP_SECRET=${SECRET}\nLARK_APP_ID=cli_test\n`, { mode: 0o600 });
  }
  const f: Fx = {
    root,
    home,
    mtHome,
    checkout,
    calls: [],
    answers: [],
    alive: new Set(),
    booted: false,
    async run(argv, o = {}) {
      const out: string[] = [];
      const err: string[] = [];
      const deps: ServiceDeps = {
        platform: o.platform ?? 'darwin',
        home,
        uid: UID,
        node: join(root, 'node bin', 'node'),
        checkout,
        run: (cmd, args) => {
          const call = { cmd, args: [...args] };
          f.calls.push(call);
          // Once booted out, launchd no longer knows the job.
          if (cmd === 'launchctl' && args[0] === 'bootout') f.booted = true;
          if (cmd === 'launchctl' && args[0] === 'bootstrap') f.booted = false;
          if (cmd === 'launchctl' && args[0] === 'print' && f.booted) return { code: 113, stdout: '', stderr: 'Could not find service' };
          const rule = f.answers.find((a) => a.match(call));
          const r = rule === undefined ? {} : typeof rule.result === 'function' ? rule.result(call) : rule.result;
          return { code: 0, stdout: '', stderr: '', ...r };
        },
        follow: async (cmd, args) => {
          f.calls.push({ cmd, args: [...args] });
          return 0;
        },
        alive: (pid) => f.alive.has(pid),
        sleep: async () => {},
      };
      const code = await runMt(argv, {
        env: { PATH: '/opt/my tools/bin:/usr/bin:/bin', HOME: home, ...o.env },
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        service: deps,
      });
      return { code, out: out.join('\n'), err: err.join('\n') };
    },
  };
  return f;
}

const plistPath = (f: Fx, label = 'team.manus.gateway'): string => join(f.home, 'Library', 'LaunchAgents', `${label}.plist`);
const unitPath = (f: Fx, unit = 'manus-team.service'): string => join(f.home, '.config', 'systemd', 'user', unit);
const words = (f: Fx): string[] => f.calls.map((c) => [c.cmd, ...c.args].join(' '));

/** launchctl print answers for a loaded job, running as `pid`. */
function loaded(f: Fx, pid?: number): void {
  f.answers.push({
    match: (c) => c.cmd === 'launchctl' && c.args[0] === 'print',
    result: { stdout: `gui/${UID}/team.manus.gateway = {\n\tstate = ${pid === undefined ? 'not running' : 'running'}\n${pid === undefined ? '\tlast exit code = 78\n' : `\tpid = ${pid}\n`}}\n` },
  });
}
/** launchctl print answers that the job is not loaded; its domain, `gui/<uid>`, answers by default. */
function notLoaded(f: Fx): void {
  f.answers.push({
    match: (c) => c.cmd === 'launchctl' && c.args[0] === 'print' && c.args[1] !== `gui/${UID}`,
    result: { code: 113, stderr: 'Could not find service "team.manus.gateway" in domain for user gui: 501\n' },
  });
}

describe('mt service install on macOS', () => {
  it('writes the plist and bootstraps it in the gui domain', async () => {
    fx = fixture();
    notLoaded(fx);
    const r = await fx.run(['service', 'install']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const plist = readFileSync(plistPath(fx), 'utf8');
    expect(readPlist(plist)).toEqual({
      node: join(fx.root, 'node bin', 'node'),
      main: join(fx.checkout, 'dist', 'main.js'),
      checkout: fx.checkout,
      path: '/opt/my tools/bin:/usr/bin:/bin',
      mtHome: undefined,
      log: join(fx.mtHome, 'logs', 'gateway.log'),
    });
    expect(words(fx)).toEqual([
      `launchctl print gui/${UID}/team.manus.gateway`,
      `launchctl print gui/${UID}`,
      `launchctl enable gui/${UID}/team.manus.gateway`,
      `launchctl bootstrap gui/${UID} ${plistPath(fx)}`,
    ]);
    expect(r.out).toContain(`wrote ${plistPath(fx)}`);
    expect(r.out).toContain('mt service status');
    expect(r.out.split('\n').slice(-1)).toEqual(['to deploy a change: mt update']);
    expect(r.out).not.toMatch(/warning/);
    expect(statSync(plistPath(fx)).mode & 0o777).toBe(0o644);
  });

  it('never writes a secret into the plist, nor prints one', async () => {
    fx = fixture({ env: `LARK_APP_SECRET=${SECRET}\nLARK_APP_ID=cli_test\nMT_AGENT_ENV_API_KEY=sk-agent-0000\n` });
    notLoaded(fx);
    const r = await fx.run(['service', 'install'], { env: { OTHER_SECRET: 'shell-secret-1111' } });
    expect(r.code).toBe(0);
    const plist = readFileSync(plistPath(fx), 'utf8');
    for (const value of [SECRET, 'sk-agent-0000', 'shell-secret-1111']) {
      expect(plist).not.toContain(value);
      expect(r.out + r.err).not.toContain(value);
    }
  });

  it('creates the log directory owner-only', async () => {
    fx = fixture();
    notLoaded(fx);
    expect((await fx.run(['service', 'install'])).code).toBe(0);
    expect(statSync(join(fx.mtHome, 'logs')).mode & 0o777).toBe(0o700);
    // Created owner-only before launchd first opens it, which would give it the umask's mode.
    expect(statSync(join(fx.mtHome, 'logs', 'gateway.log')).mode & 0o777).toBe(0o600);
  });

  it('records MT_HOME when it is set, and names a home other than the default by a hash', async () => {
    fx = fixture();
    const other = join(fx.root, 'other home');
    mkdirSync(other, { mode: 0o700 });
    writeFileSync(join(other, '.env'), `LARK_APP_SECRET=${SECRET}\nLARK_APP_ID=cli_test\n`, { mode: 0o600 });
    writeFileSync(join(other, 'config.yaml'), config(fx.checkout));
    notLoaded(fx);
    const r = await fx.run(['service', 'install'], { env: { MT_HOME: other } });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const label = /wrote .*\/(team\.manus\.gateway\.[0-9a-f]{10})\.plist/.exec(r.out)?.[1];
    expect(label).toBeDefined();
    const recorded = readPlist(readFileSync(plistPath(fx, label), 'utf8'));
    expect(recorded?.mtHome).toBe(other);
    expect(recorded?.log).toBe(join(other, 'logs', 'gateway.log'));
    expect(existsSync(plistPath(fx))).toBe(false);
    expect(words(fx)).toContain(`launchctl bootstrap gui/${UID} ${plistPath(fx, label)}`);
  });

  it('rewrites the plist and reloads it when run again', async () => {
    fx = fixture();
    notLoaded(fx);
    expect((await fx.run(['service', 'install'])).code).toBe(0);
    writeFileSync(plistPath(fx), 'stale');
    fx.calls = [];
    fx.answers = [];
    loaded(fx, 4242);
    // The lock is the service's own: no warning about another gateway.
    mkdirSync(join(fx.mtHome, 'run'), { mode: 0o700 });
    writeFileSync(join(fx.mtHome, 'run', 'gateway.pid'), '4242\n');
    fx.alive.add(4242);
    let printed = 0;
    fx.answers.unshift({
      match: (c) => c.args[0] === 'print',
      // Loaded until it is booted out.
      result: () => (printed++ === 0 ? { stdout: '\tstate = running\n\tpid = 4242\n' } : { code: 113 }),
    });
    const r = await fx.run(['service', 'install']);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(readPlist(readFileSync(plistPath(fx), 'utf8'))).toBeDefined();
    expect(words(fx)).toEqual([
      `launchctl print gui/${UID}/team.manus.gateway`,
      `launchctl bootout gui/${UID}/team.manus.gateway`,
      `launchctl print gui/${UID}/team.manus.gateway`,
      `launchctl enable gui/${UID}/team.manus.gateway`,
      `launchctl bootstrap gui/${UID} ${plistPath(fx)}`,
    ]);
  });

  it('refuses without dist/main.js, and says to build', async () => {
    fx = fixture({ built: false });
    const r = await fx.run(['service', 'install']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(join(fx.checkout, 'dist', 'main.js'));
    expect(r.err).toContain('npm run build');
    expect(fx.calls).toEqual([]);
    expect(existsSync(plistPath(fx))).toBe(false);
  });

  it("refuses without the gateway's .env, and says how to make one", async () => {
    fx = fixture({ env: false });
    const r = await fx.run(['service', 'install']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(join(fx.mtHome, '.env'));
    expect(r.err).toMatch(/no shell environment/);
    expect(r.err).toContain('"${LARK_APP_SECRET:?is not set}"');
    expect(fx.calls).toEqual([]);
  });

  it("refuses a .env that does not set LARK_APP_SECRET, even when this shell does", async () => {
    fx = fixture({ env: 'LARK_APP_ID=cli_test\n' });
    const r = await fx.run(['service', 'install'], { env: { LARK_APP_SECRET: SECRET } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/does not set LARK_APP_SECRET/);
    expect(r.err).not.toContain(SECRET);
    expect(fx.calls).toEqual([]);
  });

  it('refuses a .env the gateway would refuse, naming no value', async () => {
    fx = fixture({ env: `LARK_APP_SECRET=${SECRET}\n` });
    const { chmodSync } = await import('node:fs');
    chmodSync(join(fx.mtHome, '.env'), 0o644);
    const r = await fx.run(['service', 'install']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(join(fx.mtHome, '.env'));
    expect(r.err).not.toContain(SECRET);
  });

  it('warns of every passEnv name, which the service will not have, and says where to put it', async () => {
    fx = fixture();
    writeFileSync(
      join(fx.mtHome, 'config.yaml'),
      config(fx.checkout, '  passEnv: [GH_TOKEN]\n'),
    );
    const role = join(fx.mtHome, 'roles', 'reviewer');
    mkdirSync(role, { recursive: true });
    writeFileSync(join(role, 'config.yaml'), 'agent:\n  driver: acp\n  command: claude-agent-acp\n  passEnv: [REVIEW_TOKEN]\n');
    notLoaded(fx);
    // Set in this shell or not, the service has neither.
    const r = await fx.run(['service', 'install'], { env: { GH_TOKEN: 'ghp_never_printed' } });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/warning: role default names GH_TOKEN in agent\.passEnv.*MT_AGENT_ENV_GH_TOKEN.*\.env/);
    expect(r.out).toMatch(new RegExp(`warning: role reviewer names REVIEW_TOKEN in agent\\.passEnv.*${role.replaceAll('/', '\\/')}\\/\\.env`));
    expect(r.out + r.err).not.toContain('ghp_never_printed');
  });

  it("warns of a gateway setting set in this shell and not in the .env", async () => {
    fx = fixture();
    notLoaded(fx);
    const r = await fx.run(['service', 'install'], { env: { MT_ALLOW_TALK: 'ou_a', LARK_APP_ID: 'cli_shell' } });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/warning: MT_ALLOW_TALK is set in this shell.*service will not have it/);
    // In the .env too: the service has it.
    expect(r.out).not.toMatch(/warning: LARK_APP_ID/);
  });

  it('refuses a configuration the gateway would not start on, as the service would load it, and loads nothing', async () => {
    fx = fixture();
    writeFileSync(join(fx.mtHome, 'config.yaml'), `workspace: ${fx.checkout}\nagent:\n  driver: acp\n  command: claude-agent-acp\n`);
    const r = await fx.run(['service', 'install']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/the gateway would not start as the service.*an owner is required/);
    expect(r.err).toMatch(/mt role check/);
    expect(fx.calls).toEqual([]);
    expect(existsSync(plistPath(fx))).toBe(false);
  });

  it('refuses when a setting the gateway needs is only in this shell, and says to put it in the .env', async () => {
    fx = fixture({ env: `LARK_APP_SECRET=${SECRET}\n` });
    const r = await fx.run(['service', 'install'], { env: { LARK_APP_ID: 'cli_shell' } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/warning: LARK_APP_ID is set in this shell.*put it in/);
    expect(r.err).toMatch(/an app id is required/);
    expect(fx.calls).toEqual([]);
  });

  it('refuses roles that would not load, a passEnv name aside', async () => {
    fx = fixture();
    const role = join(fx.mtHome, 'roles', 'broken');
    mkdirSync(role, { recursive: true });
    writeFileSync(join(role, 'config.yaml'), 'agent:\n  driver: nonsense\n');
    const r = await fx.run(['service', 'install']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/the gateway would not start as the service.*agent\.driver must be one of/);
    expect(fx.calls).toEqual([]);
  });

  it('says a console login is needed when there is no gui domain, as over ssh', async () => {
    fx = fixture();
    notLoaded(fx);
    fx.answers.unshift({
      match: (c) => c.args[0] === 'bootstrap' || c.args[0] === 'enable',
      result: { code: 125, stderr: 'Bootstrap failed: 125: Domain does not support specified action' },
    });
    const r = await fx.run(['service', 'install']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(new RegExp(`gui/${UID} does not exist.*log in at the Mac's console`));
  });

  it("points at Login Items when bootstrap fails otherwise", async () => {
    fx = fixture();
    notLoaded(fx);
    fx.answers.unshift({ match: (c) => c.args[0] === 'bootstrap', result: { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' } });
    const r = await fx.run(['service', 'install']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/System Settings > General > Login Items/);
  });

  it('warns when another gateway holds the home, as npm run dev does', async () => {
    fx = fixture();
    notLoaded(fx);
    mkdirSync(join(fx.mtHome, 'run'), { mode: 0o700 });
    writeFileSync(join(fx.mtHome, 'run', 'gateway.pid'), '777\n');
    fx.alive.add(777);
    const r = await fx.run(['service', 'install']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/warning: a gateway \(pid 777\) is running on .*npm run dev.*stop it first/);
  });

  it('says nothing of a stale pid lock', async () => {
    fx = fixture();
    notLoaded(fx);
    mkdirSync(join(fx.mtHome, 'run'), { mode: 0o700 });
    writeFileSync(join(fx.mtHome, 'run', 'gateway.pid'), '778\n');
    const r = await fx.run(['service', 'install']);
    expect(r.out).not.toMatch(/pid 778/);
  });

  it('reports a failed bootstrap and exits 1', async () => {
    fx = fixture();
    notLoaded(fx);
    fx.answers.push({ match: (c) => c.args[0] === 'bootstrap', result: { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' } });
    const r = await fx.run(['service', 'install']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/launchctl bootstrap .* failed.*Input\/output error/);
  });
});

describe('mt service on Linux', () => {
  it('install writes the user unit, reloads, enables and restarts it', async () => {
    fx = fixture();
    const r = await fx.run(['service', 'install'], { platform: 'linux' });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(readUnit(readFileSync(unitPath(fx), 'utf8'))).toEqual({
      node: join(fx.root, 'node bin', 'node'),
      main: join(fx.checkout, 'dist', 'main.js'),
      checkout: fx.checkout,
      path: '/opt/my tools/bin:/usr/bin:/bin',
      mtHome: undefined,
      log: join(fx.mtHome, 'logs', 'gateway.log'),
    });
    expect(words(fx)).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable manus-team.service',
      'systemctl --user restart manus-team.service',
    ]);
    expect(r.out).toMatch(/loginctl enable-linger/);
  });

  it('the other commands use systemctl --user', async () => {
    fx = fixture();
    expect((await fx.run(['service', 'install'], { platform: 'linux' })).code).toBe(0);
    for (const verb of ['start', 'stop', 'restart']) {
      fx.calls = [];
      const r = await fx.run(['service', verb], { platform: 'linux' });
      expect(r.code).toBe(0);
      expect(words(fx)).toEqual([`systemctl --user ${verb} manus-team.service`]);
    }
  });

  it('status reads systemctl show, and the unit it wrote', async () => {
    fx = fixture();
    expect((await fx.run(['service', 'install'], { platform: 'linux' })).code).toBe(0);
    fx.calls = [];
    fx.answers.push({
      match: (c) => c.args.includes('show'),
      result: { stdout: 'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=900\nExecMainStatus=0\n' },
    });
    mkdirSync(join(fx.mtHome, 'run'), { mode: 0o700 });
    writeFileSync(join(fx.mtHome, 'run', 'gateway.pid'), '900\n');
    fx.alive.add(900);
    const r = await fx.run(['service', 'status'], { platform: 'linux' });
    expect(r.code).toBe(0);
    expect(words(fx)).toEqual([
      'systemctl --user show manus-team.service --property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus',
    ]);
    expect(r.out).toMatch(/^loaded: yes$/m);
    expect(r.out).toMatch(/^running: yes, pid 900$/m);
    expect(r.out).toMatch(/^pid lock: .*names pid 900, the service's$/m);
  });

  it('uninstall disables, removes the unit and reloads, and leaves the home alone', async () => {
    fx = fixture();
    expect((await fx.run(['service', 'install'], { platform: 'linux' })).code).toBe(0);
    fx.calls = [];
    const r = await fx.run(['service', 'uninstall'], { platform: 'linux' });
    expect(r.code).toBe(0);
    expect(existsSync(unitPath(fx))).toBe(false);
    expect(words(fx)).toEqual(['systemctl --user disable --now manus-team.service', 'systemctl --user daemon-reload']);
    expect(existsSync(join(fx.mtHome, '.env'))).toBe(true);
    expect(existsSync(join(fx.mtHome, 'config.yaml'))).toBe(true);
    expect(existsSync(join(fx.mtHome, 'logs'))).toBe(true);
  });
});

describe('mt service start, stop and restart on macOS', () => {
  async function installed(): Promise<void> {
    fx = fixture();
    notLoaded(fx);
    expect((await fx.run(['service', 'install'])).code).toBe(0);
    fx.calls = [];
    fx.answers = [];
  }

  it('restart sends SIGTERM, waits for the gateway to exit, then kickstarts it', async () => {
    await installed();
    let killed = false;
    let polls = 0;
    fx.answers.push({
      match: (c) => c.args[0] === 'print',
      // Running until the SIGTERM, then two more polls before it has drained and exited.
      result: () => (killed && ++polls > 2 ? { stdout: '\tstate = not running\n' } : { stdout: '\tstate = running\n\tpid = 10\n' }),
    });
    fx.answers.push({ match: (c) => c.args[0] === 'kill', result: () => ((killed = true), {}) });
    const r = await fx.run(['service', 'restart']);
    expect(r.code).toBe(0);
    const job = `gui/${UID}/team.manus.gateway`;
    expect(words(fx)).toEqual([
      `launchctl print ${job}`,
      `launchctl kill SIGTERM ${job}`,
      `launchctl print ${job}`,
      `launchctl print ${job}`,
      `launchctl print ${job}`,
      `launchctl kickstart ${job}`,
    ]);
  });

  it('restart counts a new pid as the old gateway gone, as when KeepAlive started it again', async () => {
    await installed();
    let killed = false;
    fx.answers.push({
      match: (c) => c.args[0] === 'print',
      result: () => ({ stdout: `\tstate = running\n\tpid = ${killed ? 11 : 10}\n` }),
    });
    fx.answers.push({ match: (c) => c.args[0] === 'kill', result: () => ((killed = true), {}) });
    expect((await fx.run(['service', 'restart'])).code).toBe(0);
    expect(words(fx).slice(-1)).toEqual([`launchctl kickstart gui/${UID}/team.manus.gateway`]);
  });

  it('restart falls back to kickstart -k when the gateway does not exit in time', async () => {
    await installed();
    loaded(fx, 10);
    const r = await fx.run(['service', 'restart']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/warning: .* did not exit within 60 seconds of SIGTERM/);
    expect(words(fx).slice(-1)).toEqual([`launchctl kickstart -k gui/${UID}/team.manus.gateway`]);
    expect(words(fx).filter((w) => w.includes(' print '))).toHaveLength(1 + 240);
  });

  it('restart of a loaded job that is not running kickstarts it', async () => {
    await installed();
    loaded(fx);
    expect((await fx.run(['service', 'restart'])).code).toBe(0);
    expect(words(fx)).toEqual([`launchctl print gui/${UID}/team.manus.gateway`, `launchctl kickstart gui/${UID}/team.manus.gateway`]);
  });

  it('restart and start bootstrap a job that is not loaded', async () => {
    await installed();
    notLoaded(fx);
    for (const verb of ['restart', 'start']) {
      fx.calls = [];
      expect((await fx.run(['service', verb])).code).toBe(0);
      expect(words(fx)).toEqual([
        `launchctl print gui/${UID}/team.manus.gateway`,
        `launchctl print gui/${UID}`,
        `launchctl enable gui/${UID}/team.manus.gateway`,
        `launchctl bootstrap gui/${UID} ${plistPath(fx)}`,
      ]);
    }
  });

  it('start kickstarts a loaded job without -k', async () => {
    await installed();
    loaded(fx);
    expect((await fx.run(['service', 'start'])).code).toBe(0);
    expect(words(fx)).toEqual([`launchctl print gui/${UID}/team.manus.gateway`, `launchctl kickstart gui/${UID}/team.manus.gateway`]);
  });

  it('stop boots the job out, which KeepAlive would otherwise restart', async () => {
    await installed();
    loaded(fx, 10);
    expect((await fx.run(['service', 'stop'])).code).toBe(0);
    expect(words(fx)).toEqual([
      `launchctl print gui/${UID}/team.manus.gateway`,
      `launchctl bootout gui/${UID}/team.manus.gateway`,
      `launchctl print gui/${UID}/team.manus.gateway`,
    ]);
  });

  it('stop of a job not loaded says so and succeeds', async () => {
    await installed();
    notLoaded(fx);
    const r = await fx.run(['service', 'stop']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/not running/);
  });

  it('refuses start and restart when not installed', async () => {
    fx = fixture();
    for (const verb of ['start', 'restart']) {
      const r = await fx.run(['service', verb]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/not installed.*mt service install/);
    }
    expect(fx.calls).toEqual([]);
  });

  it('restart refuses when dist/main.js is gone, and says to build', async () => {
    await installed();
    rmSync(join(fx.checkout, 'dist', 'main.js'));
    loaded(fx, 10);
    const r = await fx.run(['service', 'restart']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('npm run build');
  });

  it('uninstall boots out and removes the plist, and never touches the home', async () => {
    await installed();
    loaded(fx, 10);
    const r = await fx.run(['service', 'uninstall']);
    expect(r.code).toBe(0);
    expect(existsSync(plistPath(fx))).toBe(false);
    expect(words(fx)).toEqual([
      `launchctl print gui/${UID}/team.manus.gateway`,
      `launchctl bootout gui/${UID}/team.manus.gateway`,
      `launchctl print gui/${UID}/team.manus.gateway`,
    ]);
    expect(existsSync(join(fx.mtHome, '.env'))).toBe(true);
    expect(existsSync(join(fx.mtHome, 'logs'))).toBe(true);
  });

  it('uninstall when nothing is installed says so', async () => {
    fx = fixture();
    notLoaded(fx);
    const r = await fx.run(['service', 'uninstall']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/not installed/);
  });
});

describe('mt service status on macOS', () => {
  it('shows the job, its pid, what it records, the log and the pid lock', async () => {
    fx = fixture();
    notLoaded(fx);
    expect((await fx.run(['service', 'install'])).code).toBe(0);
    fx.calls = [];
    fx.answers = [];
    loaded(fx, 31337);
    mkdirSync(join(fx.mtHome, 'run'), { mode: 0o700 });
    writeFileSync(join(fx.mtHome, 'run', 'gateway.pid'), '31337\n');
    fx.alive.add(31337);
    const r = await fx.run(['service', 'status']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(new RegExp(`^service: team\\.manus\\.gateway \\(launchd, gui/${UID}\\)$`, 'm'));
    expect(r.out).toContain(`unit: ${plistPath(fx)}`);
    expect(r.out).toMatch(/^loaded: yes$/m);
    expect(r.out).toMatch(/^running: yes, pid 31337$/m);
    expect(r.out).toContain(`node: ${join(fx.root, 'node bin', 'node')}`);
    expect(r.out).toContain(`checkout: ${fx.checkout}`);
    expect(r.out).toContain('PATH: /opt/my tools/bin:/usr/bin:/bin');
    expect(r.out).toContain(`log: ${join(fx.mtHome, 'logs', 'gateway.log')}`);
    expect(r.out).toMatch(/^pid lock: .*names pid 31337, the service's$/m);
    expect(words(fx)).toEqual([`launchctl print gui/${UID}/team.manus.gateway`]);
  });

  it('says when the pid lock names another gateway than the service', async () => {
    fx = fixture();
    notLoaded(fx);
    expect((await fx.run(['service', 'install'])).code).toBe(0);
    fx.answers = [];
    loaded(fx);
    mkdirSync(join(fx.mtHome, 'run'), { mode: 0o700 });
    writeFileSync(join(fx.mtHome, 'run', 'gateway.pid'), '555\n');
    fx.alive.add(555);
    const r = await fx.run(['service', 'status']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^running: no \(last exit code 78\)$/m);
    expect(r.out).toMatch(/^pid lock: .*names pid 555, not the service's: another gateway holds the home/m);
  });

  it('says when it is not installed', async () => {
    fx = fixture();
    notLoaded(fx);
    const r = await fx.run(['service', 'status']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^installed: no/m);
  });
});

describe('a state the manager cannot give', () => {
  it('is unknown on macOS when the gui domain cannot be printed, never "not loaded"', async () => {
    fx = fixture();
    fx.answers.push({
      match: (c) => c.cmd === 'launchctl' && c.args[0] === 'print' && c.args[1] === `gui/${UID}`,
      result: { code: 125, stderr: 'Bad request.\nCould not find domain for user gui: 501\n' },
    });
    notLoaded(fx);
    const r = await fx.run(['service', 'status']);
    expect(r.out).toMatch(/^loaded: unknown \(launchctl print gui\/501 failed \(exit 125\): Bad request\. Could not find domain for user gui: 501\)$/m);
    expect(words(fx)).toEqual([`launchctl print gui/${UID}/team.manus.gateway`, `launchctl print gui/${UID}`]);
  });

  it('is "not loaded" on macOS when the domain answers and the job does not', async () => {
    fx = fixture();
    notLoaded(fx);
    const r = await fx.run(['service', 'status']);
    expect(r.out).toMatch(/^loaded: no$/m);
    expect(words(fx)).toEqual([`launchctl print gui/${UID}/team.manus.gateway`, `launchctl print gui/${UID}`]);
  });

  it('is unknown on Linux when systemctl --user show fails, as with no user bus', async () => {
    fx = fixture();
    fx.answers.push({
      match: (c) => c.cmd === 'systemctl' && c.args[1] === 'show',
      result: { code: 1, stderr: 'Failed to connect to bus: No medium found\n' },
    });
    const r = await fx.run(['service', 'status'], { platform: 'linux' });
    expect(r.out).toMatch(/^loaded: unknown \(systemctl --user show manus-team\.service --property=\S+ failed \(exit 1\): Failed to connect to bus: No medium found\)$/m);
    expect(r.out).toMatch(/^running: no$/m);
  });
});

describe('mt service logs', () => {
  it('prints the last lines of the log, 50 by default or -n of them', async () => {
    fx = fixture();
    mkdirSync(join(fx.mtHome, 'logs'), { mode: 0o700 });
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(fx.mtHome, 'logs', 'gateway.log'), `${lines.join('\n')}\n`);
    const r = await fx.run(['service', 'logs']);
    expect(r.code).toBe(0);
    expect(r.out.split('\n')).toEqual(lines.slice(30));
    const r2 = await fx.run(['service', 'logs', '-n', '3']);
    expect(r2.out.split('\n')).toEqual(['line 78', 'line 79', 'line 80']);
    expect(fx.calls).toEqual([]);
  });

  it('follows with tail -F under -f', async () => {
    fx = fixture();
    mkdirSync(join(fx.mtHome, 'logs'), { mode: 0o700 });
    writeFileSync(join(fx.mtHome, 'logs', 'gateway.log'), 'x\n');
    const r = await fx.run(['service', 'logs', '-f', '-n', '5']);
    expect(r.code).toBe(0);
    expect(words(fx)).toEqual([`tail -n 5 -F ${join(fx.mtHome, 'logs', 'gateway.log')}`]);
  });

  it('says when there is no log yet', async () => {
    fx = fixture();
    const r = await fx.run(['service', 'logs']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no log yet/);
  });

  it('refuses a bad -n', async () => {
    fx = fixture();
    const r = await fx.run(['service', 'logs', '-n', 'lots']);
    expect(r.code).toBe(2);
  });
});

describe('mt service', () => {
  it('refuses another platform', async () => {
    fx = fixture();
    const r = await fx.run(['service', 'install'], { platform: 'win32' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/macOS and Linux/);
  });

  it('refuses an unknown subcommand with the usage', async () => {
    fx = fixture();
    const r = await fx.run(['service', 'frobnicate']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/mt service <install\|uninstall\|start\|stop\|restart\|status\|logs\|check>/);
  });
});
