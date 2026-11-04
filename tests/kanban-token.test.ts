import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRun, runByTokenHash, runsOf } from '../src/db/kanban-read.js';
import { hashToken, sameHash, TOKEN_PATTERN } from '../src/kanban/token.js';
import { MASK, clearSecrets, redactKnownSecrets } from '../src/secrets.js';
import { completes, dispatchHarness, reportComplete, role, type DispatchHarness } from './helpers/dispatch.js';

const open: DispatchHarness[] = [];

function harness(...args: Parameters<typeof dispatchHarness>): DispatchHarness {
  const h = dispatchHarness(...args);
  open.push(h);
  return h;
}

beforeEach(() => clearSecrets());
afterEach(() => {
  clearSecrets();
  while (open.length > 0) open.pop()?.close();
});

/** Every text the database holds, joined: where a raw token must never be. */
function everything(h: DispatchHarness): string {
  const tables = ['kanban_runs', 'kanban_events', 'kanban_tasks', 'events', 'sessions'];
  return tables
    .map((t) => JSON.stringify(h.t.db.prepare(`SELECT * FROM ${t}`).raw().all(), (_k, v: unknown) =>
      Buffer.isBuffer(v) ? v.toString('utf8') : v,
    ))
    .join('\n');
}

describe('a run’s token', () => {
  it('is fresh for every run, in its environment only, and stored as its hash', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    const tokens: string[] = [];
    // The first run ends without reporting, so a retry gets a second run.
    implementer.scripts.push((ctl) => {
      tokens.push(ctl.env?.['MT_KANBAN_TOKEN'] ?? '');
      ctl.end('completed');
    });
    implementer.scripts.push(async (ctl) => {
      tokens.push(ctl.env?.['MT_KANBAN_TOKEN'] ?? '');
      await reportComplete(h, ctl.env?.['MT_KANBAN_RUN'] ?? '');
      ctl.end('completed');
    });

    h.dispatcher.pass();
    await h.dispatcher.idle();

    const runs = runsOf(h.t.db, task.taskId);
    expect(runs.map((r) => r.outcome)).toEqual(['protocol_violation', 'completed']);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    tokens.forEach((token, i) => {
      expect(token).toMatch(TOKEN_PATTERN);
      expect(runs[i]?.tokenHash).toBe(hashToken(token));
      expect(runByTokenHash(h.t.db, hashToken(token))?.runId).toBe(runs[i]?.runId);
    });
    const stored = everything(h);
    for (const token of tokens) expect(stored).not.toContain(token);
    expect(h.notes.join('\n')).not.toContain(tokens[0]);
    expect(runByTokenHash(h.t.db, hashToken('not-a-token'))).toBeUndefined();
  });

  it('is masked while its run is open, in what the agent says, and not once the run has closed', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    let token = '';
    let maskedDuring = '';
    implementer.scripts.push((ctl) => {
      token = ctl.env?.['MT_KANBAN_TOKEN'] ?? '';
      maskedDuring = redactKnownSecrets(`token ${token}`);
      ctl.emit({ kind: 'message-chunk', text: `my token is ${token}` });
      ctl.end('completed');
    });
    implementer.scripts.push((ctl) => ctl.end('completed'));

    h.dispatcher.pass();
    await h.dispatcher.idle();

    expect(maskedDuring).toBe(`token ${MASK}`);
    const [first] = runsOf(h.t.db, task.taskId);
    expect(getRun(h.t.db, first?.runId ?? '')?.lastOutput).toBe(`my token is ${MASK}`);
    expect(everything(h)).not.toContain(token);
    // Closed: the token works no more, and later text may show it.
    expect(first?.endedAt).not.toBeNull();
    expect(redactKnownSecrets(`token ${token}`)).toBe(`token ${token}`);
  });

  it('compares hashes in constant time, and refuses one that is not a hash', () => {
    const a = hashToken('a'.repeat(43));
    expect(sameHash(a, a)).toBe(true);
    expect(sameHash(a, hashToken('b'.repeat(43)))).toBe(false);
    expect(sameHash(a, 'zz')).toBe(false);
  });
});

describe('a run’s environment', () => {
  const worker = { socket: '/home/mt/run/kanban.sock', mtDir: '/home/mt/bin', path: '/usr/bin:/bin' };

  it('has the socket, and the mt directory first on PATH, ahead of the gateway’s', async () => {
    const h = harness({ worker });
    const task = h.create({ workspace: 'web' });
    completes(h, h.driver('implementer'));
    h.dispatcher.pass();
    await h.dispatcher.idle();
    const [run] = runsOf(h.t.db, task.taskId);
    expect(h.driver('implementer').starts[0]?.env).toEqual({
      MT_KANBAN_RUN: run?.runId,
      MT_KANBAN_TOKEN: expect.stringMatching(TOKEN_PATTERN),
      MT_KANBAN_SOCKET: '/home/mt/run/kanban.sock',
      PATH: '/home/mt/bin:/usr/bin:/bin',
    });
  });

  it('keeps a role’s own PATH after the mt directory, and gives only the mt directory when there is none', async () => {
    const tools = role('implementer');
    const own = { ...tools, agent: { ...tools.agent, env: { PATH: '/opt/tools/bin' } } };
    const h = harness({ roles: [own, role('reviewer')], worker: { ...worker, path: undefined } });
    h.create({ workspace: 'web' });
    h.create({ workspace: 'api', assignee: 'reviewer' });
    completes(h, h.driver('implementer'));
    completes(h, h.driver('reviewer'));
    h.dispatcher.pass();
    await h.dispatcher.idle();
    expect(h.driver('implementer').starts[0]?.env?.['PATH']).toBe('/home/mt/bin:/opt/tools/bin');
    expect(h.driver('reviewer').starts[0]?.env?.['PATH']).toBe('/home/mt/bin');
  });
});
