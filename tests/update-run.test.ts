import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RESTART_CALL_MS, askAt, realUpdateDeps, runDetached, runSyncDetached } from '../src/cli/update.js';

/**
 * How mt update runs git and npm (spec §20.11), for real, with sh: in a
 * session of its own with no stdin, its output kept, and its whole process
 * group killed at its time limit or when aborted, SIGTERM then SIGKILL.
 */

const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
const sh = (script: string, timeoutMs = 10_000, signal?: AbortSignal) => runDetached('sh', ['-c', script], { cwd: process.cwd(), env, timeoutMs, signal });

describe('runDetached', () => {
  it('runs in a process group and a session of its own, with no stdin', async () => {
    const r = await sh('echo "$$ $(ps -o pgid= -p $$) $(ps -o sess= -p $$ 2>/dev/null || ps -o sid= -p $$)"; read line; echo "read: $?"');
    expect(r.code).toBe(0);
    const [pid, pgid] = r.stdout.trim().split(/\s+/);
    expect(pgid).toBe(pid);
    expect(r.stdout).toContain('read: 1');
    expect(r.timedOut).toBe(false);
  });

  it('keeps stdout and stderr, and the exit code', async () => {
    expect(await sh('echo out; echo err >&2; exit 3')).toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
  });

  it('kills the whole group at its time limit, a child of the command included', async () => {
    const started = Date.now();
    const r = await sh('sleep 30 & wait', 1_500);
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(143);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('sends SIGKILL 5 seconds after a SIGTERM that is ignored', async () => {
    const started = Date.now();
    const r = await sh('trap "" TERM; sleep 30', 1_500);
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(137);
    expect(Date.now() - started).toBeGreaterThanOrEqual(6_400);
  }, 20_000);

  it('answers a second after the SIGKILL when a process that left the group holds its output', async () => {
    // A grandchild in a session of its own keeps stdout open; it prints its pid first, so the test can end it.
    const leave = `node -e "const c = require('node:child_process').spawn('sleep', ['30'], { detached: true, stdio: 'inherit' }); console.log(c.pid); c.unref();"`;
    const started = Date.now();
    const r = await sh(`${leave}; trap "" TERM; sleep 30`, 1_500);
    try {
      expect(r).toMatchObject({ code: 137, timedOut: true });
      expect(Date.now() - started).toBeGreaterThanOrEqual(7_400);
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      process.kill(Number(r.stdout.trim()), 'SIGKILL');
    }
  }, 20_000);

  it('answers with the real exit code 2 seconds after the command exits, when a process that left the group holds its output', async () => {
    const leave = `node -e "const c = require('node:child_process').spawn('sleep', ['30'], { detached: true, stdio: 'inherit' }); console.log(c.pid); c.unref();"`;
    const started = Date.now();
    const r = await sh(`${leave}; exit 4`, 15_000);
    try {
      expect(r).toMatchObject({ code: 4, timedOut: false });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
      expect(Date.now() - started).toBeLessThan(6_000);
    } finally {
      process.kill(Number(r.stdout.trim()), 'SIGKILL');
    }
  }, 20_000);

  it('kills the group when aborted', async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 1_000);
    const r = await sh('sleep 30', 10_000, abort.signal);
    expect(r).toMatchObject({ code: 143, timedOut: false });
  });

  it('answers 127 for a command that is not there', async () => {
    const r = await runDetached('/nonexistent/git', [], { cwd: process.cwd(), env, timeoutMs: 1000 });
    expect(r.code).toBe(127);
  });
});

describe('runSyncDetached', () => {
  it("runs the service's command in a session of its own, waiting for it, with its output and exit code", () => {
    const r = runSyncDetached('sh', ['-c', 'echo "$$ $(ps -o pgid= -p $$)"; echo err >&2; exit 4']);
    expect(r.code).toBe(4);
    const [pid, pgid] = r.stdout.trim().split(/\s+/);
    expect(pgid).toBe(pid);
    expect(r.stderr).toBe('err\n');
  });

  it("runs its wrapper in a session of its own too, so a terminal's signal reaches neither", () => {
    // The command's parent is the wrapper: its group is its own, not this process's.
    const r = runSyncDetached('sh', ['-c', 'echo "$PPID $(ps -o pgid= -p $PPID)"']);
    const [wrapper, group] = r.stdout.trim().split(/\s+/);
    expect(group).toBe(wrapper);
    expect(Number(group)).not.toBe(process.pid);
  });

  it('gives up at its time limit, 180 seconds unless told, killing the wrapper, as a call that failed and says so', () => {
    expect(RESTART_CALL_MS).toBe(180_000);
    const started = Date.now();
    const r = runSyncDetached('sh', ['-c', 'echo started; sleep 5'], 300);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.code).toBe(124);
    expect(r.stdout).toBe('started\n');
    expect(r.stderr).toBe('did not finish in 0.3 seconds');
  });

  it('answers 127 for a command that is not there', () => {
    expect(runSyncDetached('/nonexistent/launchctl', []).code).toBe(127);
  });
});

describe('the question', () => {
  it('answers what is typed', async () => {
    const input = new PassThrough();
    const asked = askAt(input, new PassThrough())('go on? ', new AbortController().signal);
    input.write('y\n');
    expect(await asked).toBe('y');
  });

  it("answers '' at the end of its input, a Ctrl-D, which reads as no", async () => {
    const input = new PassThrough();
    input.end();
    expect(await askAt(input, new PassThrough())('go on? ', new AbortController().signal)).toBe('');
  });

  it('rejects when aborted', async () => {
    const abort = new AbortController();
    const asked = askAt(new PassThrough(), new PassThrough())('go on? ', abort.signal);
    abort.abort();
    await expect(asked).rejects.toThrow();
  });
});

describe('the real deps', () => {
  it('listen for SIGINT, SIGHUP and SIGTERM until told to stop', () => {
    const deps = realUpdateDeps();
    const before = ['SIGINT', 'SIGHUP', 'SIGTERM'].map((s) => process.listenerCount(s));
    const seen: string[] = [];
    const off = deps.onSignal((s) => seen.push(s));
    expect(['SIGINT', 'SIGHUP', 'SIGTERM'].map((s) => process.listenerCount(s))).toEqual(before.map((n) => n + 1));
    process.emit('SIGHUP', 'SIGHUP');
    expect(seen).toEqual(['SIGHUP']);
    off();
    expect(['SIGINT', 'SIGHUP', 'SIGTERM'].map((s) => process.listenerCount(s))).toEqual(before);
  });

  it('take a real EPIPE, from a stdout whose reader has gone, as no failure, where without them the process dies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-guard-output-'));
    try {
      const script = join(dir, 'writer.mjs');
      writeFileSync(
        script,
        [
          `import { realUpdateDeps } from ${JSON.stringify(pathToFileURL(resolve('src/cli/update.ts')).href)};`,
          "if (process.argv[2] === 'guarded') realUpdateDeps().guardOutput();",
          "for (let i = 0; i < 64; i += 1) process.stdout.write('x'.repeat(65536));",
          "setTimeout(() => { process.stderr.write('still here\\n'); process.exit(0); }, 500);",
        ].join('\n'),
      );
      const run = (how: string): Promise<{ code: number | null; stderr: string }> =>
        new Promise((done) => {
          const child = spawn(process.execPath, ['--import', 'tsx', script, how], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
          child.stdout.destroy();
          let stderr = '';
          child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
          child.on('close', (code) => done({ code, stderr }));
        });
      expect(await run('guarded')).toEqual({ code: 0, stderr: 'still here\n' });
      const bare = await run('bare');
      expect(bare.code).not.toBe(0);
      expect(bare.stderr).toContain('EPIPE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('take EPIPE and EIO on stdout as no failure', () => {
    const deps = realUpdateDeps();
    const streams = [process.stdout, process.stderr];
    const before = streams.map((s) => s.listeners('error'));
    deps.guardOutput();
    try {
      expect(() => process.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
      expect(() => process.stderr.emit('error', Object.assign(new Error('read EIO'), { code: 'EIO' }))).not.toThrow();
    } finally {
      streams.forEach((s, i) => {
        for (const l of s.listeners('error')) if (!before[i]?.includes(l)) s.off('error', l as (err: Error) => void);
      });
    }
  });
});
