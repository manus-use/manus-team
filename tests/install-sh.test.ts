import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * install.sh, run for real in a temporary HOME, from a copy of the script in a
 * temporary checkout, with a stub npm that records its calls and whose build
 * writes a stub dist/mt.js. It never runs the real npm, nor the real mt, nor
 * touches the real home.
 */

const SCRIPT = new URL('../install.sh', import.meta.url).pathname;
const EXAMPLE = new URL('../config.example.yaml', import.meta.url).pathname;

interface Fx {
  root: string;
  home: string;
  checkout: string;
  bin: string;
  record: string;
  run(args?: string[], env?: Record<string, string>): { code: number; out: string; err: string };
}

let fx: Fx | undefined;
afterEach(() => {
  if (fx !== undefined) rmSync(fx.root, { recursive: true, force: true });
});

function fixture(): Fx {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-install-')));
  const home = join(root, 'My Home');
  const checkout = join(root, 'the checkout');
  const bin = join(root, 'tool bin');
  const record = join(root, 'calls.log');
  mkdirSync(home);
  mkdirSync(checkout);
  mkdirSync(bin);
  copyFileSync(SCRIPT, join(checkout, 'install.sh'));
  copyFileSync(EXAMPLE, join(checkout, 'config.example.yaml'));
  symlinkSync(process.execPath, join(bin, 'node'));
  // The stub npm: records its arguments and directory; its build writes a dist/mt.js that records its own.
  writeFileSync(
    join(bin, 'npm'),
    [
      '#!/bin/sh',
      `printf 'npm %s (in %s)\\n' "$*" "$PWD" >> '${record}'`,
      'if [ "$1" = run ] && [ "$2" = build ]; then',
      '  mkdir -p dist',
      `  printf '%s\\n' "require('node:fs').appendFileSync('${record}', 'mt ' + process.argv.slice(2).join(' ') + ' MT_HOME=' + (process.env.MT_HOME ?? '') + '\\\\n')" > dist/mt.js`,
      '  : > dist/main.js',
      'fi',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'npm'), 0o755);
  const f: Fx = {
    root,
    home,
    checkout,
    bin,
    record,
    run(args = [], env = {}) {
      const r = spawnSync('bash', [join(checkout, 'install.sh'), ...args], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, SHELL: '/bin/zsh', ...env },
      });
      return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
    },
  };
  return f;
}

const calls = (f: Fx): string[] => (existsSync(f.record) ? readFileSync(f.record, 'utf8').trim().split('\n') : []);

describe('install.sh', () => {
  it('is valid bash, and shellcheck-clean where shellcheck is installed', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
    const which = spawnSync('sh', ['-c', 'command -v shellcheck'], { encoding: 'utf8' });
    if (which.status === 0) {
      const r = spawnSync('shellcheck', [SCRIPT], { encoding: 'utf8' });
      expect(r.stdout).toBe('');
      expect(r.status).toBe(0);
    }
    expect(readFileSync(SCRIPT, 'utf8')).toMatch(/^#!\/usr\/bin\/env bash\n[\s\S]*^set -euo pipefail$/m);
  });

  it('builds with npm ci and npm run build, makes the home owner-only with a config, and the mt launcher', () => {
    fx = fixture();
    const r = fx.run();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(calls(fx)).toEqual([`npm ci (in ${fx.checkout})`, `npm run build (in ${fx.checkout})`]);
    const mtHome = join(fx.home, '.manus-team');
    expect(statSync(mtHome).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(mtHome, 'config.yaml'), 'utf8')).toBe(readFileSync(EXAMPLE, 'utf8'));
    const launcher = join(mtHome, 'bin', 'mt');
    expect(statSync(launcher).mode & 0o777).toBe(0o700);
    expect(statSync(join(mtHome, 'bin')).mode & 0o777).toBe(0o700);
    expect(readFileSync(launcher, 'utf8')).toContain(`exec '${join(fx.bin, 'node')}' '${join(fx.checkout, 'dist', 'mt.js')}' "$@"`);
    // The launcher runs this checkout's mt.
    expect(spawnSync(launcher, ['role', 'list'], { env: { PATH: '/usr/bin:/bin' } }).status).toBe(0);
    expect(calls(fx)).toContain('mt role list MT_HOME=');
  });

  it("tells how to make the .env when there is none, never prompting for the secret", () => {
    fx = fixture();
    const r = fx.run([], { LARK_APP_SECRET: 'secret-never-printed' });
    expect(r.code).toBe(0);
    const env = join(fx.home, '.manus-team', '.env');
    expect(r.out).toContain(
      `(umask 077; printf 'LARK_APP_SECRET=%s\\n' "\${LARK_APP_SECRET:?is not set}" > '${env}') && chmod 600 '${env}'`,
    );
    expect(r.out + r.err).not.toContain('secret-never-printed');
    expect(existsSync(env)).toBe(false);
  });

  it('prints the PATH line and leaves the shell rc alone without --yes, when not at a terminal', () => {
    fx = fixture();
    const r = fx.run();
    expect(r.out).toContain(`export PATH='${join(fx.home, '.manus-team', 'bin')}':"$PATH"`);
    expect(existsSync(join(fx.home, '.zshrc'))).toBe(false);
  });

  it('appends the PATH line to ~/.zshrc with --yes, once however often it runs, and keeps an existing config', () => {
    fx = fixture();
    expect(fx.run(['--yes']).code).toBe(0);
    const config = join(fx.home, '.manus-team', 'config.yaml');
    writeFileSync(config, '# mine\n');
    const r = fx.run(['--yes']);
    expect(r.code).toBe(0);
    const rc = readFileSync(join(fx.home, '.zshrc'), 'utf8');
    expect(rc.split(`export PATH='${join(fx.home, '.manus-team', 'bin')}':"$PATH"`)).toHaveLength(2);
    expect(readFileSync(config, 'utf8')).toBe('# mine\n');
    expect(r.out).toMatch(/kept .*config\.yaml/);
  });

  it('uses ~/.bashrc for bash', () => {
    fx = fixture();
    expect(fx.run(['--yes'], { SHELL: '/bin/bash' }).code).toBe(0);
    expect(readFileSync(join(fx.home, '.bashrc'), 'utf8')).toContain(join(fx.home, '.manus-team', 'bin'));
  });

  it('honours MT_HOME', () => {
    fx = fixture();
    const other = join(fx.root, 'other home');
    const r = fx.run(['--service'], { MT_HOME: other });
    expect(r.code).toBe(0);
    expect(statSync(other).mode & 0o777).toBe(0o700);
    expect(existsSync(join(other, 'bin', 'mt'))).toBe(true);
    expect(calls(fx)).toContain(`mt service install MT_HOME=${other}`);
  });

  it('runs mt service install with --service, and only then', () => {
    fx = fixture();
    expect(fx.run().code).toBe(0);
    expect(calls(fx).filter((c) => c.startsWith('mt service'))).toEqual([]);
    expect(fx.run(['--service']).code).toBe(0);
    expect(calls(fx).filter((c) => c.startsWith('mt service'))).toEqual(['mt service install MT_HOME=']);
  });

  it("prefers nvm's node 22", () => {
    fx = fixture();
    const nvmBin = join(fx.home, '.nvm', 'versions', 'node', 'v22.99.0', 'bin');
    mkdirSync(nvmBin, { recursive: true });
    writeFileSync(join(nvmBin, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
    chmodSync(join(nvmBin, 'node'), 0o755);
    // A newer major is not preferred over 22.
    const v23 = join(fx.home, '.nvm', 'versions', 'node', 'v23.1.0', 'bin');
    mkdirSync(v23, { recursive: true });
    writeFileSync(join(v23, 'node'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(v23, 'node'), 0o755);
    const r = fx.run();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(readFileSync(join(fx.home, '.manus-team', 'bin', 'mt'), 'utf8')).toContain(`exec '${join(nvmBin, 'node')}'`);
  });

  it('refuses a node older than 22.12', () => {
    fx = fixture();
    rmSync(join(fx.bin, 'node'));
    writeFileSync(join(fx.bin, 'node'), "#!/bin/sh\n[ \"$1\" = --version ] && echo v20.11.1\n");
    chmodSync(join(fx.bin, 'node'), 0o755);
    const r = fx.run();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/node 22\.12 or later is needed.*v20\.11\.1/);
    expect(calls(fx)).toEqual([]);
  });

  it('refuses an unknown option', () => {
    fx = fixture();
    const r = fx.run(['--frob']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/usage/);
  });
});
