import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventsOf, gatesOf } from '../src/db/kanban-read.js';
import { KanbanService } from '../src/kanban/service.js';
import { GATE_LIMITS, type TaskRow } from '../src/kanban/types.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
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
      ['task id an object', () => s.addGate(bad({}), { command: 'true' }, ALICE)],
    ];
    for (const [what, call] of cases) expect([what, call()]).toEqual([what, expect.objectContaining({ ok: false, code: 'invalid' })]);
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
