import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventsOf, gatesOf } from '../src/db/kanban-read.js';
import { GATE_OUTPUT_BYTES, RAW_OUTPUT_BYTES, gateEnv, rawTail, runGates, type GateExit, type GateRunOptions } from '../src/kanban/gates.js';
import { KanbanService } from '../src/kanban/service.js';
import { GATE_LIMITS, type GateRow, type TaskRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES, role } from './helpers/dispatch.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * Defining a task's gates (spec §7.7, §10, §10.1): an operator action, through
 * the service, stored as written with who defined it.
 */

let t: TestDb;
let s: KanbanService;

beforeEach(() => {
  clearSecrets();
  t = testDb();
  s = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
  });
});
afterEach(() => {
  clearSecrets();
  t.close();
});

function task(): TaskRow {
  const r = s.create({ title: 'a task', assignee: 'implementer', workspace: 'web', createdBy: ALICE, createdVia: VIA });
  if (!r.ok) throw new Error(r.message);
  return r.task;
}

function count(): number {
  return t.db.prepare<[], { n: number }>('SELECT count(*) AS n FROM kanban_gates').get()?.n ?? 0;
}

describe('defining gates', () => {
  it('stores a gate as written, with who defined it, in order, and records it', () => {
    const k = task();
    const first = s.addGate(k.taskId, { command: "npm test -- --grep 'parser'" }, ALICE);
    const second = s.addGate(k.taskId, { command: 'npm run lint', timeoutS: 60 }, 'lark:on_bob');
    expect(first).toMatchObject({ ok: true, gate: { command: "npm test -- --grep 'parser'", timeoutS: 300 } });
    expect(second).toMatchObject({ ok: true });
    expect(gatesOf(t.db, k.taskId)).toEqual([
      expect.objectContaining({ taskId: k.taskId, command: "npm test -- --grep 'parser'", timeoutS: 300, createdBy: ALICE }),
      expect.objectContaining({ command: 'npm run lint', timeoutS: 60, createdBy: 'lark:on_bob' }),
    ]);
    const added = eventsOf(t.db, k.taskId).filter((e) => e.kind === 'gate_added');
    expect(added.map((e) => [e.actor, e.payload])).toEqual([
      [ALICE, { gateId: first.ok ? first.gate.id : 0, command: "npm test -- --grep 'parser'", timeoutS: 300 }],
      ['lark:on_bob', { gateId: second.ok ? second.gate.id : 0, command: 'npm run lint', timeoutS: 60 }],
    ]);
  });

  it('refuses a command holding a known secret, saying where the value belongs, and stores nothing', () => {
    addSecrets(['sk-live-1234567890']);
    const k = task();
    const r = s.addGate(k.taskId, { command: 'curl -H "Authorization: sk-live-1234567890" https://ci' }, ALICE);
    expect(r).toEqual({
      ok: false,
      code: 'invalid',
      message:
        "the gate's command holds a known secret, and a gate is stored and run as written; " +
        "pass the value through the agent's environment instead -- the role's .env, or agent.passEnv -- " +
        'and name it in the command, as $NAME',
    });
    expect(count()).toBe(0);
    expect(eventsOf(t.db, k.taskId).map((e) => e.kind)).toEqual(['created']);
  });

  it('refuses a known secret the shell would run, written escaped, quoted apart or with a control character', () => {
    addSecrets(['sk-live-1234$567890']);
    const k = task();
    for (const command of [
      'curl -H "k: sk-live-1234\\$567890" https://ci',
      "curl -H 'k: sk-live-1234''$567890' https://ci",
      'curl -H "k: sk-live-1234\u0007$567890" https://ci',
      'curl -H "k: sk-live-1234\\\n$567890" https://ci',
      "curl -H 'k: sk-live-1234'\\\n'$567890' https://ci",
      'curl -H "k: sk-live-1234\\\r\n\u0007$567890" https://ci',
    ]) {
      expect(s.addGate(k.taskId, { command }, ALICE)).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(count()).toBe(0);
  });

  it('lists and removes a gate, recording who removed it', () => {
    const k = task();
    const first = s.addGate(k.taskId, { command: 'npm test' }, ALICE);
    const second = s.addGate(k.taskId, { command: 'npm run lint' }, ALICE);
    if (!first.ok || !second.ok) throw new Error('not added');
    expect(s.listGates(k.taskId)).toMatchObject({ ok: true, gates: [{ command: 'npm test' }, { command: 'npm run lint' }] });
    expect(s.removeGate(k.taskId, first.gate.id, 'operator:alice')).toMatchObject({ ok: true, gate: { command: 'npm test' } });
    expect(s.listGates(k.taskId)).toMatchObject({ ok: true, gates: [{ command: 'npm run lint' }] });
    expect(eventsOf(t.db, k.taskId).at(-1)).toMatchObject({
      kind: 'gate_removed',
      actor: 'operator:alice',
      payload: { gateId: first.gate.id, command: 'npm test' },
    });
    expect(s.removeGate(k.taskId, first.gate.id, ALICE)).toEqual({
      ok: false,
      code: 'not_found',
      message: `task ${k.taskId} has no gate ${first.gate.id}`,
    });
    expect(s.removeGate(k.taskId, 0, ALICE)).toMatchObject({ ok: false, code: 'invalid' });
    expect(s.removeGate(k.taskId, second.gate.id, ' ')).toMatchObject({ ok: false, code: 'invalid' });
    expect(s.listGates(k.taskId)).toMatchObject({ ok: true, gates: [{ command: 'npm run lint' }] });
    expect(s.listGates('k_missing')).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('refuses what is not a gate, and writes nothing', () => {
    const k = task();
    const bad = (v: unknown): never => v as never;
    const cases: Array<[string, () => unknown]> = [
      ['a number', () => s.addGate(k.taskId, { command: bad(3) }, ALICE)],
      ['blank', () => s.addGate(k.taskId, { command: '  ' }, ALICE)],
      ['no gate', () => s.addGate(k.taskId, bad(null), ALICE)],
      ['a NUL', () => s.addGate(k.taskId, { command: 'true\0false' }, ALICE)],
      ['too large', () => s.addGate(k.taskId, { command: 'x'.repeat(GATE_LIMITS.commandBytes + 1) }, ALICE)],
      ['timeout 0', () => s.addGate(k.taskId, { command: 'true', timeoutS: 0 }, ALICE)],
      ['timeout over the most', () => s.addGate(k.taskId, { command: 'true', timeoutS: GATE_LIMITS.maxTimeoutS + 1 }, ALICE)],
      ['timeout a fraction', () => s.addGate(k.taskId, { command: 'true', timeoutS: 1.5 }, ALICE)],
      ['timeout text', () => s.addGate(k.taskId, { command: 'true', timeoutS: bad('300') }, ALICE)],
      ['by a number', () => s.addGate(k.taskId, { command: 'true' }, bad(3))],
      ['by blank', () => s.addGate(k.taskId, { command: 'true' }, '  ')],
      ['task id an object', () => s.addGate(bad({}), { command: 'true' }, ALICE)],
    ];
    for (const [what, call] of cases) {
      expect([what, call()]).toEqual([what, expect.objectContaining({ ok: false, code: 'invalid' })]);
    }
    expect(count()).toBe(0);
  });

  it('refuses a gate on a task that is archived, or missing', () => {
    const gone = task();
    expect(s.archive(gone.taskId, ALICE).ok).toBe(true);
    expect(s.addGate(gone.taskId, { command: 'true' }, ALICE)).toEqual({
      ok: false,
      code: 'illegal_transition',
      message: `task ${gone.taskId} is archived; a gate on it would never run`,
    });
    expect(s.addGate('k_missing', { command: 'true' }, ALICE)).toMatchObject({ ok: false, code: 'not_found' });
    expect(count()).toBe(0);
  });

  it('refuses gates past the most a task may have, and past their time together', () => {
    const k = task();
    expect(s.addGate(k.taskId, { command: 'npm test' }, ALICE).ok).toBe(true);
    expect(s.addGate(k.taskId, { command: 'npm run e2e' }, ALICE).ok).toBe(true);
    expect(s.addGate(k.taskId, { command: 'true', timeoutS: 1 }, ALICE)).toEqual({
      ok: false,
      code: 'invalid',
      message: `task ${k.taskId}'s gates would take up to 601 s together; at most 600 s, since a report waits for them`,
    });
    const many = task();
    for (let i = 0; i < GATE_LIMITS.perTask; i += 1) {
      expect(s.addGate(many.taskId, { command: `check ${i}`, timeoutS: 30 }, ALICE).ok).toBe(true);
    }
    expect(s.addGate(many.taskId, { command: 'one more', timeoutS: 1 }, ALICE)).toMatchObject({
      ok: false,
      message: `task ${many.taskId} has 20 gates, the most a task may have`,
    });
  });
});

/** Gates as rows, for runGates. */
function rows(...commands: string[]): GateRow[] {
  return commands.map((command, i) => ({ id: i + 1, taskId: 'k_1', command, timeoutS: 30 + i, createdBy: ALICE, createdAt: 0 }));
}

/** A runner that starts nothing: each command's exit, as scripted, and every call it was given. */
function scripted(exits: Record<string, Partial<GateExit>>) {
  const calls: Array<{ command: string } & GateRunOptions> = [];
  const runner = async (command: string, opts: GateRunOptions): Promise<GateExit> => {
    calls.push({ command, ...opts });
    return { exitCode: 0, signal: null, timedOut: false, output: '', ...exits[command] };
  };
  return { runner, calls };
}

describe('running gates', () => {
  it('runs each gate in order, in the workspace, with its timeout, and passes when each exits 0', async () => {
    const { runner, calls } = scripted({ 'npm test': { output: 'all green' } });
    const env = { PATH: '/usr/bin', API_KEY: 'k' };
    const run = await runGates(rows('npm run lint', 'npm test'), { cwd: '/ws/web', env, runner, clock: new ManualClock() });
    expect(calls.map((c) => [c.command, c.cwd, c.timeoutMs, c.env])).toEqual([
      ['npm run lint', '/ws/web', 30_000, env],
      ['npm test', '/ws/web', 31_000, env],
    ]);
    expect(run).toEqual({
      passed: true,
      aborted: false,
      notRun: 0,
      results: [
        { gateId: 1, command: 'npm run lint', exitCode: 0, signal: null, timedOut: false, durationMs: 0, output: '' },
        { gateId: 2, command: 'npm test', exitCode: 0, signal: null, timedOut: false, durationMs: 0, output: 'all green' },
      ],
    });
  });

  it('stops at the first gate that exits non-zero or times out, and says how many did not run', async () => {
    const failing = scripted({ b: { exitCode: 2, output: 'FAIL parser.test.ts' } });
    const failed = await runGates(rows('a', 'b', 'c', 'd'), { cwd: '/ws', env: {}, runner: failing.runner });
    expect(failing.calls.map((c) => c.command)).toEqual(['a', 'b']);
    expect(failed).toMatchObject({
      passed: false,
      aborted: false,
      notRun: 2,
      results: [{ exitCode: 0 }, { exitCode: 2, output: 'FAIL parser.test.ts' }],
    });

    const slow = scripted({ a: { exitCode: null, signal: 'SIGTERM', timedOut: true } });
    expect(await runGates(rows('a', 'b'), { cwd: '/ws', env: {}, runner: slow.runner })).toMatchObject({
      passed: false,
      notRun: 1,
      results: [{ exitCode: null, signal: 'SIGTERM', timedOut: true }],
    });
  });

  it('masks what a gate wrote before keeping its end', async () => {
    addSecrets(['sk-live-1234567890']);
    const long = `${'x'.repeat(GATE_OUTPUT_BYTES)}\nthe key is sk-live-1234567890`;
    const { runner } = scripted({ a: { exitCode: 1, output: long } });
    const [result] = (await runGates(rows('a'), { cwd: '/ws', env: {}, runner })).results;
    expect(result?.output.endsWith(`the key is ${MASK}`)).toBe(true);
    expect(result?.output).not.toContain('sk-live');
    expect(Buffer.byteLength(result?.output ?? '', 'utf8')).toBe(GATE_OUTPUT_BYTES);
  });

  it('leaves no fragment of a secret the raw window split, and says the start was cut', async () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const secret = Array.from({ length: 1000 }, (_, i) => alphabet[(i * 31 + i * i * 7) % alphabet.length]).join('');
    addSecrets([secret]);
    // 1001 bytes a line: the window's edge falls inside a secret.
    const raw = Buffer.from(`${secret}\n`.repeat(70), 'utf8');
    expect((raw.length - RAW_OUTPUT_BYTES) % 1001).not.toBe(0);
    const kept = rawTail(raw);
    expect(kept.startsWith('[earlier output cut]\n')).toBe(true);
    const { runner } = scripted({ a: { exitCode: 1, output: kept } });
    const [result] = (await runGates(rows('a'), { cwd: '/ws', env: {}, runner })).results;
    const output = result?.output ?? '';
    expect(output).toContain(MASK);
    for (let i = 0; i + 8 <= secret.length; i += 1) {
      if (output.includes(secret.slice(i, i + 8))) throw new Error(`a fragment at ${i} shows`);
    }
    // A window that was not cut is kept whole, with no marker.
    expect(rawTail(Buffer.from('all green\n'))).toBe('all green\n');
  });

  it('runs nothing more once the gateway is stopping, and says the run was stopped', async () => {
    const stopping = new AbortController();
    const { runner, calls } = scripted({});
    const first = await runGates(rows('a', 'b'), {
      cwd: '/ws',
      env: {},
      runner: async (command, opts) => {
        stopping.abort();
        return runner(command, opts);
      },
      signal: stopping.signal,
    });
    expect(calls.map((c) => [c.command, c.signal?.aborted])).toEqual([['a', true]]);
    expect(first).toMatchObject({ passed: false, aborted: true, notRun: 1 });
    expect(await runGates(rows('a'), { cwd: '/ws', env: {}, runner, signal: stopping.signal })).toEqual({
      passed: false,
      aborted: true,
      results: [],
      notRun: 1,
    });
  });

  it("gives a gate its role's environment and the agent allowlist, never the gateway's secrets or a run's", () => {
    const implementer = role('implementer', {
      agent: { ...role('implementer').agent, env: { API_KEY: 'sk-role-1', MT_KANBAN_SOCKET: '/somewhere' } },
    });
    const parent = {
      PATH: '/usr/bin',
      HOME: '/home/mt',
      LARK_APP_SECRET: 'lark-secret',
      MT_KANBAN_TOKEN: 'a-token',
      SOMETHING_ELSE: 'x',
    };
    expect(gateEnv(implementer, parent)).toEqual({ PATH: '/usr/bin', HOME: '/home/mt', API_KEY: 'sk-role-1' });
  });
});
