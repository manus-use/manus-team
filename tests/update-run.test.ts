import { describe, expect, it } from 'vitest';
import { realUpdateDeps, runDetached, runSyncDetached } from '../src/cli/update.js';

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

  it('answers 127 for a command that is not there', () => {
    expect(runSyncDetached('/nonexistent/launchctl', []).code).toBe(127);
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
