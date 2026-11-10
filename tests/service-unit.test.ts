import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  launchdPlist,
  readPlist,
  readUnit,
  serviceNames,
  systemdQuote,
  systemdUnit,
  xmlEscape,
  type ServiceSpec,
} from '../src/service/unit.js';
import { LOG_MAX_BYTES, rotateLog, rotateOwnLog, serviceLogPath } from '../src/service/log.js';

const SPEC: ServiceSpec = {
  label: 'team.manus.gateway',
  node: '/Users/me/My Tools/node & co/bin/node',
  main: '/Users/me/Dev/the "gateway"/dist/main.js',
  checkout: '/Users/me/Dev/the "gateway"',
  path: '/Users/me/My Tools/bin:/usr/bin:/bin',
  mtHome: "/Users/me/team <home>'s",
  log: "/Users/me/team <home>'s/logs/gateway.log",
};

describe('serviceNames', () => {
  it('names the default home plainly', () => {
    expect(serviceNames('/Users/me', '/Users/me/.manus-team')).toEqual({
      label: 'team.manus.gateway',
      unit: 'manus-team.service',
    });
    // A trailing slash is still the default home.
    expect(serviceNames('/Users/me', '/Users/me/.manus-team/').label).toBe('team.manus.gateway');
  });

  it('names any other home by a hash of its path, the same each time', () => {
    const a = serviceNames('/Users/me', '/srv/team a');
    const b = serviceNames('/Users/me', '/srv/team b');
    expect(a.label).toMatch(/^team\.manus\.gateway\.[0-9a-f]{10}$/);
    expect(a.unit).toMatch(/^manus-team-[0-9a-f]{10}\.service$/);
    expect(a.label.slice(-10)).toBe(a.unit.slice('manus-team-'.length, -'.service'.length));
    expect(a).toEqual(serviceNames('/Users/me', '/srv/team a'));
    expect(a.label).not.toBe(b.label);
  });
});

describe('the launchd plist', () => {
  it('escapes every value as XML', () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
    const plist = launchdPlist(SPEC);
    expect(plist).toContain('<string>/Users/me/My Tools/node &amp; co/bin/node</string>');
    expect(plist).toContain('<string>/Users/me/Dev/the &quot;gateway&quot;/dist/main.js</string>');
    expect(plist).toContain('<string>/Users/me/team &lt;home&gt;&apos;s</string>');
    expect(plist).not.toMatch(/node & co|<home>/);
  });

  it('runs node on dist/main.js from the checkout, kept alive, throttled, logging under the home', () => {
    const plist = launchdPlist(SPEC);
    expect(plist).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
    expect(plist).toMatch(/<key>Label<\/key>\s*<string>team\.manus\.gateway<\/string>/);
    expect(plist).toMatch(
      /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/Users\/me\/My Tools\/node &amp; co\/bin\/node<\/string>\s*<string>--enable-source-maps<\/string>\s*<string>\/Users\/me\/Dev\/the &quot;gateway&quot;\/dist\/main\.js<\/string>\s*<\/array>/,
    );
    expect(plist).toMatch(/<key>WorkingDirectory<\/key>\s*<string>\/Users\/me\/Dev\/the &quot;gateway&quot;<\/string>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
    // Standard, not Background: launchd gives a Background job low CPU and I/O priority, and its agents inherit it.
    expect(plist).toMatch(/<key>ProcessType<\/key>\s*<string>Standard<\/string>/);
    expect(plist).not.toContain('Background');
    expect(plist).toMatch(/<key>StandardOutPath<\/key>\s*<string>\/Users\/me\/team &lt;home&gt;&apos;s\/logs\/gateway\.log<\/string>/);
    expect(plist).toMatch(/<key>StandardErrorPath<\/key>\s*<string>\/Users\/me\/team &lt;home&gt;&apos;s\/logs\/gateway\.log<\/string>/);
  });

  it('holds PATH, and MT_HOME only when it is set, and no other variable', () => {
    const plist = launchdPlist(SPEC);
    const env = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist)?.[1] ?? '';
    expect([...env.matchAll(/<key>([^<]*)<\/key>/g)].map((m) => m[1])).toEqual(['PATH', 'MT_HOME']);
    const without = launchdPlist({ ...SPEC, mtHome: undefined });
    const env2 = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(without)?.[1] ?? '';
    expect([...env2.matchAll(/<key>([^<]*)<\/key>/g)].map((m) => m[1])).toEqual(['PATH']);
  });

  it('reads back what it wrote, spaces, quotes and ampersands included', () => {
    expect(readPlist(launchdPlist(SPEC))).toEqual({
      node: SPEC.node,
      main: SPEC.main,
      checkout: SPEC.checkout,
      path: SPEC.path,
      mtHome: SPEC.mtHome,
      log: SPEC.log,
    });
    expect(readPlist(launchdPlist({ ...SPEC, mtHome: undefined }))?.mtHome).toBeUndefined();
    expect(readPlist('not a plist')).toBeUndefined();
  });

  it('refuses a value XML cannot hold, or a newline in one', () => {
    expect(() => launchdPlist({ ...SPEC, checkout: '/a\nb' })).toThrow(/control character/);
    expect(() => launchdPlist({ ...SPEC, path: '/a\u0001b' })).toThrow(/control character/);
  });
});

describe('the systemd unit', () => {
  it('quotes a value for systemd: backslashes, quotes, % and $ escaped', () => {
    expect(systemdQuote('/a b/c')).toBe('"/a b/c"');
    expect(systemdQuote('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(systemdQuote('100%$HOME')).toBe('"100%%$$HOME"');
  });

  it('runs node on dist/main.js from the checkout, restarted on failure, logging under the home', () => {
    const unit = systemdUnit(SPEC);
    expect(unit).toMatch(/^\[Unit\]\n/m);
    expect(unit).toContain('ExecStart="/Users/me/My Tools/node & co/bin/node" "--enable-source-maps" "/Users/me/Dev/the \\"gateway\\"/dist/main.js"\n');
    expect(unit).toContain('WorkingDirectory=/Users/me/Dev/the "gateway"\n');
    expect(unit).toContain('Environment="PATH=/Users/me/My Tools/bin:/usr/bin:/bin"\n');
    expect(unit).toContain(`Environment="MT_HOME=/Users/me/team <home>'s"\n`);
    expect(unit).toContain(`StandardOutput=append:/Users/me/team <home>'s/logs/gateway.log\n`);
    expect(unit).toContain(`StandardError=append:/Users/me/team <home>'s/logs/gateway.log\n`);
    expect(unit).toContain('Restart=on-failure\n');
    expect(unit).toMatch(/^RestartSec=30$/m);
    // A configuration error (EX_CONFIG) is not retried: it stays failed until it is fixed.
    expect(unit).toMatch(/^RestartPreventExitStatus=78$/m);
    // SIGTERM to the gateway alone first, so it drains before its agents are killed.
    expect(unit).toMatch(/^KillMode=mixed$/m);
    expect(unit).toMatch(/^\[Install\]\nWantedBy=default\.target$/m);
  });

  it('holds PATH, and MT_HOME only when it is set', () => {
    const unit = systemdUnit({ ...SPEC, mtHome: undefined });
    expect(unit.match(/^Environment=.*$/gm)).toEqual(['Environment="PATH=/Users/me/My Tools/bin:/usr/bin:/bin"']);
  });

  it('escapes % in a bare path, which systemd would read as a specifier', () => {
    const unit = systemdUnit({ ...SPEC, checkout: '/srv/100%', log: '/srv/h%/logs/gateway.log' });
    expect(unit).toContain('WorkingDirectory=/srv/100%%\n');
    expect(unit).toContain('StandardOutput=append:/srv/h%%/logs/gateway.log\n');
  });

  it('reads back what it wrote', () => {
    for (const spec of [SPEC, { ...SPEC, mtHome: undefined }, { ...SPEC, checkout: '/srv/100% $x', node: '/n\\o"de' }]) {
      expect(readUnit(systemdUnit(spec))).toEqual({
        node: spec.node,
        main: spec.main,
        checkout: spec.checkout,
        path: spec.path,
        mtHome: spec.mtHome,
        log: spec.log,
      });
    }
    expect(readUnit('[Unit]\n')).toBeUndefined();
  });

  it('refuses a newline or a control character in a value', () => {
    expect(() => systemdUnit({ ...SPEC, path: '/a\nb' })).toThrow(/control character/);
    expect(() => systemdUnit({ ...SPEC, checkout: ' /lead' })).toThrow(/space/);
  });
});

describe('log rotation', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps a log under the limit as it is', () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-log-')));
    const log = join(dir, 'gateway.log');
    writeFileSync(log, 'small\n');
    expect(rotateLog(log, 100)).toBe(false);
    expect(readFileSync(log, 'utf8')).toBe('small\n');
  });

  it('copies a log over the limit to .1, replacing the last, and empties it in place', () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-log-')));
    const log = join(dir, 'gateway.log');
    writeFileSync(`${log}.1`, 'older\n');
    writeFileSync(log, 'x'.repeat(200));
    const inode = statSync(log).ino;
    expect(rotateLog(log, 100)).toBe(true);
    expect(readFileSync(`${log}.1`, 'utf8')).toBe('x'.repeat(200));
    expect(statSync(`${log}.1`).mode & 0o777).toBe(0o600);
    expect(statSync(log).mode & 0o777).toBe(0o600);
    expect(readFileSync(log, 'utf8')).toBe('');
    // The same file, so the fd launchd or systemd opened stays the one written to.
    expect(statSync(log).ino).toBe(inode);
  });

  it('does nothing for a missing log', () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-log-')));
    expect(rotateLog(join(dir, 'none.log'), 1)).toBe(false);
  });

  it('rotates at start only the log this process writes to', () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-log-')));
    const home = join(dir, 'home');
    const log = serviceLogPath(home);
    expect(log).toBe(join(home, 'logs', 'gateway.log'));
    expect(LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
    // No log: nothing to do, and no error.
    expect(rotateOwnLog(home, () => ({ dev: 1, ino: 1 }), 10)).toBe(false);
    mkdirSync(join(home, 'logs'), { recursive: true });
    writeFileSync(log, 'y'.repeat(50));
    const st = statSync(log);
    // Another file on stdout, as in npm run dev: the service's log is not this process's.
    expect(rotateOwnLog(home, () => ({ dev: st.dev, ino: st.ino + 1 }), 10)).toBe(false);
    expect(readFileSync(log, 'utf8')).toHaveLength(50);
    expect(rotateOwnLog(home, () => ({ dev: st.dev, ino: st.ino }), 10)).toBe(true);
    expect(readFileSync(log, 'utf8')).toBe('');
    // Owner-only, however launchd or systemd created it.
    chmodSync(log, 0o644);
    writeFileSync(log, 'z');
    expect(rotateOwnLog(home, () => ({ dev: st.dev, ino: st.ino }), 10)).toBe(false);
    expect(statSync(log).mode & 0o777).toBe(0o600);
  });
});
