import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRun, runByTokenHash, runsOf } from '../src/db/kanban-read.js';
import { hashToken, sameHash, TOKEN_PATTERN } from '../src/kanban/token.js';
import { MASK, clearSecrets, redactKnownSecrets } from '../src/secrets.js';
import { dispatchHarness, reportComplete, type DispatchHarness } from './helpers/dispatch.js';

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
    implementer.scripts.push((ctl) => {
      tokens.push(ctl.env?.['MT_KANBAN_TOKEN'] ?? '');
      reportComplete(h, ctl.env?.['MT_KANBAN_RUN'] ?? '');
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
