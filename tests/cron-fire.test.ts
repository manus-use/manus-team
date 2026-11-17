import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { endFire, firesOf, getFire, getJob, removeJob, runningFire } from '../src/db/cron.js';
import { SCRIPT_TIMEOUT_MS, scriptFailure, scriptOutput } from '../src/cron/scheduler.js';
import type { GateExit, GateRunOptions } from '../src/kanban/gates.js';
import { PackagesInUse } from '../src/render/native.js';
import type { Role } from '../src/roles.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { answers, cronHarness, holdsTurn, type CronHarness } from './helpers/cron.js';
import { role } from './helpers/dispatch.js';

/**
 * A fire (the cron spec, §5): its script, its session and prompt, its role's
 * role.md and skills, the idle limit, and what is posted.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const open: CronHarness[] = [];
let base: string;

beforeEach(() => {
  clearSecrets();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mt-cron-fire-')));
});
afterEach(() => {
  clearSecrets();
  while (open.length > 0) open.pop()?.close();
  rmSync(base, { recursive: true, force: true });
});

function harness(...args: Parameters<typeof cronHarness>): CronHarness {
  const h = cronHarness(...args);
  open.push(h);
  return h;
}

/** A script runner that records what it was given, and answers each run in turn. */
function runner(...exits: Array<GateExit | ((opts: GateRunOptions) => Promise<GateExit>)>) {
  const calls: Array<{ command: string; opts: GateRunOptions }> = [];
  return {
    calls,
    run: async (command: string, opts: GateRunOptions): Promise<GateExit> => {
      calls.push({ command, opts });
      const next = exits.shift() ?? { exitCode: 0, signal: null, timedOut: false, output: '' };
      return typeof next === 'function' ? next(opts) : next;
    },
  };
}

const ok = (output: string): GateExit => ({ exitCode: 0, signal: null, timedOut: false, output });
const promptOf = (h: CronHarness, i = 0): string => h.driver.runtimes[i]?.prompts[0]?.text ?? '';

async function fireOnce(h: CronHarness, after = HOUR): Promise<void> {
  h.clock.advance(after);
  await h.tick();
  await h.scheduler.idle();
}

describe('the script', () => {
  it("runs in the job's workspace with its role's environment, no token and nothing of the gateway's, and its output goes in the prompt", async () => {
    const r = runner(ok('#12 fix the parser\n#14 docs\n'));
    const worker = role('worker', { agent: { ...role('worker').agent, env: { GH_HOST: 'git.example', MT_KANBAN_SOCKET: '/x' } } });
    const h = harness({
      roles: [worker],
      workspaces: new Map([['default', '/srv/repo']]),
      deps: { runner: r.run, env: { PATH: '/usr/bin', HOME: '/home/mt', LARK_APP_SECRET: 'lark-secret', MT_CRON_TOKEN: 't', MT_KANBAN_TOKEN: 'k' } },
    });
    h.add({ script: 'gh pr list' });
    answers(h.driver, 'Two open.');
    await fireOnce(h);
    expect(r.calls).toHaveLength(1);
    const [{ command, opts }] = r.calls as [{ command: string; opts: GateRunOptions }];
    expect(command).toBe('gh pr list');
    expect(opts.cwd).toBe('/srv/repo');
    expect(opts.timeoutMs).toBe(SCRIPT_TIMEOUT_MS);
    expect(opts.env).toEqual({ PATH: '/usr/bin', HOME: '/home/mt', GH_HOST: 'git.example' });
    expect(promptOf(h)).toContain("The output of the job's script, run just now:\n    #12 fix the parser\n    #14 docs");
  });

  it('masks its output, then keeps its last 16 KiB behind the cut marker', () => {
    addSecrets(['sk-live-1234567890']);
    expect(scriptOutput('key sk-live-1234567890')).toBe(`key ${MASK}`);
    const cut = scriptOutput(`${'a'.repeat(20_000)}END`);
    expect(cut.startsWith('[earlier output cut]\n')).toBe(true);
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(cut.endsWith('aEND')).toBe(true);
  });

  it('fails with one line and runs no agent: an exit, a signal, its time limit, or no start', async () => {
    expect(scriptFailure({ exitCode: 1, signal: null, timedOut: false, output: `${'x'.repeat(400)}\nno gh\n` })).toBe(`the script failed (exit 1): ${'x'.repeat(294)}\nno gh`);
    expect(scriptFailure({ exitCode: null, signal: 'SIGKILL', timedOut: true, output: '' })).toBe('the script failed (timed out after 120 s)');
    expect(scriptFailure({ exitCode: null, signal: 'SIGTERM', timedOut: false, output: '' })).toBe('the script failed (killed by SIGTERM)');
    expect(scriptFailure({ exitCode: null, signal: null, timedOut: false, output: 'spawn ENOENT' })).toBe('the script failed (it could not start): spawn ENOENT');
    const r = runner({ exitCode: 2, signal: null, timedOut: false, output: 'gh: not logged in' });
    const h = harness({ deps: { runner: r.run } });
    const j = h.add({ script: 'gh pr list' });
    await fireOnce(h);
    expect(h.driver.runtimes).toEqual([]);
    expect(firesOf(h.t.db, j.jobId)[0]).toMatchObject({ outcome: 'script_failed', sessionId: null, delivery: 'sent' });
    expect(h.lark.texts.map((t) => t.text)).toEqual(['**Daily PRs** · 2026-11-17 10:00 Asia/Shanghai: the script failed \\(exit 2\\): gh: not logged in']);
    expect(getJob(h.t.db, j.jobId)?.failures).toBe(1);
  });

  it('is aborted by a removal, with no script_failed recorded or posted, the fire ended at once and no session made', async () => {
    let aborted = false;
    const r = runner(
      (opts) =>
        new Promise<GateExit>((resolve) => {
          opts.signal?.addEventListener('abort', () => {
            aborted = true;
            resolve({ exitCode: null, signal: 'SIGTERM', timedOut: false, output: '' });
          });
        }),
    );
    const h = harness({ deps: { runner: r.run } });
    const j = h.add({ script: 'sleep 100' });
    h.clock.advance(HOUR);
    await h.tick();
    const fireId = runningFire(h.t.db, j.jobId)?.fireId ?? 0;
    removeJob(h.t.db, j.jobId, h.clock.now());
    await h.tick();
    await h.scheduler.idle();
    expect(aborted).toBe(true);
    expect(getFire(h.t.db, fireId)).toMatchObject({ outcome: 'interrupted', sessionId: null, delivery: 'none' });
    expect(h.lark.texts).toEqual([]);
    expect(h.driver.starts).toEqual([]);
  });

  it('makes no session for a fire removed between its script and the session, whose script then succeeds', async () => {
    let finish = (): void => undefined;
    const r = runner(() => new Promise<GateExit>((resolve) => (finish = () => resolve(ok('done')))));
    const h = harness({ deps: { runner: r.run } });
    const j = h.add({ script: 'true' });
    h.clock.advance(HOUR);
    await h.tick();
    // Marked, as the tick's removal marks it; the script ends well regardless.
    removeJob(h.t.db, j.jobId, h.clock.now());
    h.scheduler.tick();
    finish();
    await h.scheduler.idle();
    expect(h.driver.starts).toEqual([]);
    expect(firesOf(h.t.db, j.jobId)[0]).toMatchObject({ outcome: 'interrupted', sessionId: null });
  });

  it('is killed by a stop, its fire left open for the next boot', async () => {
    let aborted = false;
    const r = runner(
      (opts) =>
        new Promise<GateExit>((resolve) => {
          opts.signal?.addEventListener('abort', () => {
            aborted = true;
            resolve({ exitCode: null, signal: 'SIGTERM', timedOut: false, output: '' });
          });
        }),
    );
    const h = harness({ deps: { runner: r.run } });
    const j = h.add({ script: 'sleep 100' });
    h.clock.advance(HOUR);
    await h.tick();
    h.scheduler.stop();
    await h.scheduler.idle();
    expect(aborted).toBe(true);
    expect(firesOf(h.t.db, j.jobId)[0]).toMatchObject({ endedAt: null, outcome: null });
  });
});

describe("the role's role.md and skills", () => {
  function worker(): Role {
    const dir = join(base, 'roles', 'worker');
    const skillDir = join(dir, 'skills', 'testing');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(dir, 'role.md'), 'You review PRs.\n');
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: testing\ndescription: How to test\n---\nRun npm test.\n');
    return role('worker', {
      dir,
      roleMdPath: join(dir, 'role.md'),
      skills: [{ name: 'testing', description: 'How to test', dir: skillDir, path: join(skillDir, 'SKILL.md') }],
    });
  }

  it('go at the head of the prompt when the role is not rendered', async () => {
    const h = harness({ roles: [{ ...worker(), agent: { ...worker().agent, native: false } }], deps: { renderRoot: join(base, 'rendered') } });
    h.add();
    await fireOnce(h);
    expect(promptOf(h).startsWith('# Your role\n\nYou review PRs.\n\n# Skills\n')).toBe(true);
    expect(promptOf(h)).toContain(`- testing: How to test (${join(base, 'roles', 'worker', 'skills', 'testing', 'SKILL.md')})`);
  });

  it("are left out for a native render, whose package reaches the agent and is held in the shared set while the fire runs", async () => {
    const packages = new PackagesInUse();
    const h = harness({ roles: [worker()], deps: { renderRoot: join(base, 'rendered'), packages } });
    h.add();
    const held = holdsTurn(h.driver);
    h.clock.advance(HOUR);
    await h.tick();
    const start = h.driver.starts[0];
    const dir = start?.env?.['BYTESEC_LOCAL_APM_PATH'] ?? '';
    expect(dir.startsWith(join(base, 'rendered', 'worker'))).toBe(true);
    expect(start?.args).toContain('--agent');
    expect(start?.env?.['MT_CRON_FIRE']).toBe('1');
    expect(promptOf(h)).not.toContain('# Your role');
    expect(packages.keeping('other').has(dir)).toBe(true);
    held.end('completed');
    await h.scheduler.idle();
    expect(packages.keeping('other').has(dir)).toBe(false);
  });

  it('go back in the prompt when the render fails, which is noted', async () => {
    const h = harness({ roles: [worker()], deps: { renderRoot: '/dev/null/rendered' } });
    h.add();
    await fireOnce(h);
    expect(promptOf(h).startsWith('# Your role')).toBe(true);
    expect(h.notes.some((n) => /^cron: fire 1: rendering role worker for .* failed, so its role\.md and skills go in the prompt/.test(n))).toBe(true);
  });

  it('skip the fire when role.md cannot be read', async () => {
    const r = worker();
    rmSync(r.roleMdPath ?? '');
    const h = harness({ roles: [r] });
    const j = h.add();
    await fireOnce(h);
    expect(firesOf(h.t.db, j.jobId)[0]).toMatchObject({ outcome: 'skipped_unavailable', error: "role worker's role.md cannot be read" });
    expect(h.driver.starts).toEqual([]);
  });
});

describe('the idle limit', () => {
  it('cancels a turn quiet for idle_timeout_s, at the tick, and the fire ends timed_out after one archive', async () => {
    const h = harness();
    const j = h.add();
    const held = holdsTurn(h.driver);
    h.clock.advance(HOUR);
    await h.tick();
    h.clock.advance(9 * MIN);
    await h.tick();
    expect(h.driver.runtimes[0]?.cancels).toBe(0);
    h.clock.advance(MIN);
    await h.tick();
    expect(h.driver.runtimes[0]?.cancels).toBe(1);
    held.end('cancelled');
    await h.scheduler.idle();
    expect(firesOf(h.t.db, j.jobId)[0]).toMatchObject({ outcome: 'timed_out', delivery: 'sent' });
    expect(h.archives).toHaveLength(1);
    expect(h.lark.texts.map((t) => t.text)).toEqual(['**Daily PRs** · 2026-11-17 10:00 Asia/Shanghai: stopped after 600 s with no activity']);
  });

  it('spares a turn that keeps writing past ten minutes', async () => {
    const h = harness();
    const j = h.add();
    const held = holdsTurn(h.driver);
    h.clock.advance(HOUR);
    await h.tick();
    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(5 * MIN);
      held.ctl?.emit({ kind: 'message-chunk', text: `step ${i} ` });
      await h.tick();
    }
    expect(h.driver.runtimes[0]?.cancels).toBe(0);
    held.end('completed');
    await h.scheduler.idle();
    expect(firesOf(h.t.db, j.jobId)[0]?.outcome).toBe('posted');
  });

  it('releases a turn that ignores its cancel a tick later, ending the fire timed_out though its submit never settles', async () => {
    const h = harness();
    const j = h.add();
    holdsTurn(h.driver);
    h.clock.advance(HOUR);
    await h.tick();
    h.clock.advance(10 * MIN);
    await h.tick();
    expect(firesOf(h.t.db, j.jobId)[0]?.outcome).toBeNull();
    await h.tick();
    await h.scheduler.idle();
    expect(firesOf(h.t.db, j.jobId)[0]).toMatchObject({ outcome: 'timed_out', delivery: 'sent' });
    expect(h.archives).toHaveLength(1);
    expect(h.scheduler.inFlight(j.jobId)).toBe(false);
  });

  it('keeps the mark of a fire marked timed out and then removed, with no delivery', async () => {
    const h = harness();
    const j = h.add();
    holdsTurn(h.driver);
    h.clock.advance(HOUR);
    await h.tick();
    h.clock.advance(10 * MIN);
    await h.tick();
    removeJob(h.t.db, j.jobId, h.clock.now());
    await h.tick();
    await h.tick();
    await h.scheduler.idle();
    expect(h.archives).toHaveLength(1);
    expect(h.lark.texts).toEqual([]);
    expect(h.notes.some((n) => /fire 1 of job .* ended timed_out/.test(n))).toBe(true);
  });

  it('records nothing for an archive that settles after a stop, which idle() waits for, and the boot ends the fire interrupted', async () => {
    const h = harness();
    const j = h.add();
    holdsTurn(h.driver);
    h.clock.advance(HOUR);
    await h.tick();
    h.clock.advance(10 * MIN);
    await h.tick();
    let releaseArchive = (): void => undefined;
    const archive = h.registry.archive.bind(h.registry);
    h.registry.archive = async (key, reason) => {
      await new Promise<void>((resolve) => (releaseArchive = resolve));
      return archive(key, reason);
    };
    h.scheduler.tick();
    h.scheduler.stop();
    const drained = h.scheduler.idle();
    releaseArchive();
    expect(await drained).toBe(true);
    const fire = firesOf(h.t.db, j.jobId)[0];
    expect(fire).toMatchObject({ endedAt: null });
    const next = cronHarness({ t: h.t, clock: h.clock });
    await next.scheduler.boot();
    next.scheduler.stop();
    expect(getFire(h.t.db, fire?.fireId ?? 0)?.outcome).toBe('interrupted');
    expect(endFire(h.t.db, { fireId: fire?.fireId ?? 0, outcome: 'timed_out', message: false }, 0).ok).toBe(false);
  });
});

describe('the answer', () => {
  it('is joined across chunks, a secret split between two masked whole', async () => {
    addSecrets(['sk-live-1234567890']);
    const h = harness();
    const j = h.add();
    answers(h.driver, 'key sk-live-', '1234567890 found');
    await fireOnce(h);
    expect(firesOf(h.t.db, j.jobId)[0]?.result).toBe(`key ${MASK} found`);
    expect(h.lark.texts[0]?.text.endsWith(`key ${MASK} found`)).toBe(true);
  });

  it('carries the newest posted or nothing result into the next prompt', async () => {
    const h = harness();
    h.add();
    answers(h.driver, 'Two open.');
    await fireOnce(h);
    h.driver.scripts.push((ctl) => ctl.end('failed'));
    await fireOnce(h);
    answers(h.driver, 'Three open.');
    await fireOnce(h);
    expect(promptOf(h, 2)).toContain('Your previous result, from 2026-11-17 10:00 Asia/Shanghai: Two open.');
  });
});
