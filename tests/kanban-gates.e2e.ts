import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGates, spawnGate } from '../src/kanban/gates.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';

/**
 * The real gate runner (spec §7.7): `/bin/sh -c`, in its own process group, in
 * the workspace, with only the environment it is given. Real processes, so not a
 * unit test.
 */

let dir: string;
const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' };

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-gate-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('spawnGate', () => {
  it('passes a command that exits 0, in the workspace, with the environment given and nothing else', async () => {
    const r = await spawnGate('pwd; echo "key=$API_KEY token=${MT_KANBAN_TOKEN:-none}"', {
      cwd: dir,
      env: { ...env, API_KEY: 'from-the-role' },
      timeoutMs: 10_000,
    });
    expect(r).toEqual({ exitCode: 0, signal: null, timedOut: false, output: `${dir}\nkey=from-the-role token=none\n` });
  });

  it('fails a command that exits non-zero, with what it wrote to stdout and stderr', async () => {
    const r = await spawnGate('echo one; echo two >&2; exit 3', { cwd: dir, env, timeoutMs: 10_000 });
    expect(r).toMatchObject({ exitCode: 3, signal: null, timedOut: false });
    expect(r.output.split('\n').sort()).toEqual(['', 'one', 'two']);
  });

  it('kills a gate past its timeout, and what it started, promptly', async () => {
    const started = Date.now();
    const r = await spawnGate('echo begun; sleep 30 & sleep 30', { cwd: dir, env, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    // The shell is killed by the signal, or exits on it once its child is: either way, not 0.
    expect(r.signal === 'SIGTERM' || r.exitCode === 143).toBe(true);
    expect(r.output.startsWith('begun\n')).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('does not wait for a background process the gate left holding its output', async () => {
    const started = Date.now();
    const r = await spawnGate('sleep 30 & echo done', { cwd: dir, env, timeoutMs: 20_000 });
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, output: 'done\n' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("does not wait for a process that left the gate's group holding its output, nor count that against the gate", async () => {
    const started = Date.now();
    // A child that makes itself a session of its own, then says so, keeping the gate's output open.
    const escape = `perl -MPOSIX -e 'POSIX::setsid(); open(my $f, ">", "escaped.pid"); print $f $$; close($f); sleep 30' &`;
    // The timeout falls in the second the output is let go of: the gate itself ended in time.
    const r = await spawnGate(`${escape} while [ ! -s escaped.pid ]; do sleep 0.05; done; echo done`, {
      cwd: dir,
      env,
      timeoutMs: 700,
    });
    try {
      expect(r).toMatchObject({ exitCode: 0, timedOut: false, output: 'done\n' });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      process.kill(Number(readFileSync(join(dir, 'escaped.pid'), 'utf8')), 'SIGKILL');
    }
  });

  it('kills a running gate when the gateway exits', async () => {
    // The "gateway" exits once the gate has written its pid, or gives up after 10 s.
    const code = [
      "import { readFileSync } from 'node:fs';",
      `import { spawnGate } from ${JSON.stringify(new URL('../src/kanban/gates.ts', import.meta.url).href)};`,
      `const pidFile = ${JSON.stringify(join(dir, 'gate.pid'))};`,
      `const opts = { cwd: ${JSON.stringify(dir)}, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 60_000 };`,
      "void spawnGate('echo $$ > gate.pid.tmp && mv gate.pid.tmp gate.pid; exec sleep 30', opts);",
      'const deadline = Date.now() + 10_000;',
      'setInterval(() => {',
      "  let written = '';",
      '  try {',
      "    written = readFileSync(pidFile, 'utf8');",
      '  } catch {}',
      "  if (written.endsWith('\\n')) process.exit(1);",
      '  if (Date.now() > deadline) process.exit(2);',
      '}, 20);',
    ].join('\n');
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', loader, '--input-type=module', '-e', code], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('close', (c) => resolve(c));
    });
    expect(exitCode).toBe(1);
    const pid = Number(readFileSync(join(dir, 'gate.pid'), 'utf8'));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    // The gate's group is killed as the process exits; wait, up to 5 s, for it to be gone.
    const gone = Date.now() + 5_000;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ESRCH');
        break;
      }
      if (Date.now() > gone) throw new Error(`gate ${pid} is still running`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  it('stops a gate when the gateway stops', async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const started = Date.now();
    const r = await spawnGate('sleep 30', { cwd: dir, env, timeoutMs: 20_000, signal: stop.signal });
    expect(r.timedOut).toBe(false);
    expect(r.signal === 'SIGTERM' || r.exitCode === 143).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('leaves no fragment of a secret its 64 KiB window split', async () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const secret = Array.from({ length: 1000 }, (_, i) => alphabet[(i * 31 + i * i * 7) % alphabet.length]).join('');
    clearSecrets();
    addSecrets([secret]);
    try {
      // 70 lines of 1001 bytes: the window's edge falls inside one.
      const run = await runGates([{ id: 1, taskId: 'k_1', command: `for i in $(seq 70); do echo ${secret}; done; exit 1`, timeoutS: 30, createdBy: 'operator:test', createdAt: 0 }], {
        cwd: dir,
        env,
        runner: spawnGate,
      });
      const output = run.results[0]?.output ?? '';
      expect(output.startsWith('[earlier output cut]\n')).toBe(true);
      expect(output).toContain(MASK);
      for (let i = 0; i + 8 <= secret.length; i += 1) {
        if (output.includes(secret.slice(i, i + 8))) throw new Error(`a fragment at ${i} shows`);
      }
    } finally {
      clearSecrets();
    }
  });

  it('stops a gate at once when the gateway had stopped before it started', async () => {
    const stop = new AbortController();
    stop.abort();
    const started = Date.now();
    const r = await spawnGate('sleep 30', { cwd: dir, env, timeoutMs: 20_000, signal: stop.signal });
    expect(r.timedOut).toBe(false);
    expect(r.signal === 'SIGTERM' || r.exitCode === 143).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('fails a gate that cannot start, saying why', async () => {
    const r = await spawnGate('true', { cwd: join(dir, 'missing'), env, timeoutMs: 10_000 });
    expect(r).toMatchObject({ exitCode: null, timedOut: false });
    expect(r.output).toMatch(/^the gate could not start: spawn \/bin\/sh ENOENT/);
  });
});
