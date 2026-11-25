import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toolGroups, renderCard } from '../src/channel/render.js';
import { boardCardNonce, boardCardUuid, progressCardUuid } from '../src/core/ids.js';
import { PROGRESS_TITLE_CHARS, outcomeWord, progressState, progressTail, renderProgressCard, type ProgressFacts } from '../src/kanban/chat-render.js';
import { TEXT_KEEP, foldProgress, newProgress } from '../src/kanban/progress.js';
import type { KanbanEvent, RunOutcome, RunRow, TaskRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import type { Event } from '../src/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { NOW, claimed, newTask } from './helpers/kanban.js';

/**
 * A board run's progress card (progress cards spec §6): its header, its tool
 * line, the tail of what the agent says, its status lines and Stop button, and
 * its final form; every piece masked and escaped.
 */

let h: TestDb;
let task: TaskRow;
let run: RunRow;

beforeEach(() => {
  clearSecrets();
  h = testDb();
  task = newTask(h.db, { title: 'Fix the flaky login test' });
  run = claimed(h.db, task.taskId);
});
afterEach(() => {
  clearSecrets();
  h.close();
});

function facts(over: Partial<ProgressFacts> = {}): ProgressFacts {
  return { task, run, tryNumber: 1, tryLimit: 2, tools: [], text: '', approvalWaiting: false, started: true, now: NOW, ...over };
}

function md(over: Partial<ProgressFacts> = {}): string {
  return renderProgressCard(facts(over), 'cli_app').markdown;
}

function decided(outcome: RunOutcome, ended = false): RunRow {
  return { ...run, outcome, endedAt: ended ? run.startedAt + 1 : null };
}

const ENDED_GAVE_UP = { payload: { outcome: 'failed', next: 'blocked', blockKind: 'gave_up' } } as unknown as KanbanEvent;
const ENDED_RETRY = { payload: { outcome: 'failed', next: 'retry' } } as unknown as KanbanEvent;

describe('toolGroups', () => {
  it("groups calls of one tool and state in first-heard order, and is what a reply card's tool line joins", () => {
    const tools = [
      { title: 'Read', status: 'completed' },
      { title: 'Bash', status: 'failed' },
      { title: 'Read', status: 'completed' },
      { title: 'Edit', status: 'in_progress' },
      { title: 'Glob', status: 'pending' },
    ];
    expect(toolGroups(tools)).toEqual(['✅ Read ×2', '❌ Bash', '⏳ Edit', '• Glob']);
    const events: Event[] = tools.map((t, i) => ({
      sessionId: 's',
      seq: i + 1,
      ts: NOW,
      generation: 0,
      brokerSeq: null,
      turnId: 't',
      type: 'tool_call',
      actor: 'agent',
      payload: { toolCallId: `c${i}`, ...t },
    }));
    expect(renderCard(events).parts.tools).toBe('✅ Read ×2 · ❌ Bash · ⏳ Edit · • Glob');
  });
});

describe('the header', () => {
  it('names the task by title and whole id, the role, the try and the time running in whole minutes', () => {
    expect(md().split('\n').slice(0, 2)).toEqual([`⚙️ **Fix the flaky login test** \`${task.taskId}\``, 'implementer · run 1 of 2 · running under a minute']);
    expect(md({ now: NOW + 4 * 60_000 + 59_000 })).toContain('implementer · run 1 of 2 · running 4 min');
    expect(md({ now: NOW + 72 * 60_000 })).toContain('· running 1 h 12 min');
  });

  it('says the attempt when it is not N, drops "of M" when N is past M, and says a review', () => {
    expect(md({ run: { ...run, attempt: 3 } })).toContain('implementer · run 1 of 2 (attempt #3) · ');
    expect(md({ tryNumber: 3, tryLimit: 2, run: { ...run, attempt: 3 } })).toContain('implementer · run 3 · ');
    expect(md({ run: { ...run, kind: 'review', assignee: { kind: 'role', name: 'reviewer' } } })).toContain('reviewer, reviewing · run 1 of 2');
  });
});

describe('the tool line', () => {
  it('says Starting before the session has anything, and Working before any tool', () => {
    expect(md({ started: false }).split('\n')[2]).toBe('_Starting…_');
    expect(md().split('\n')[2]).toBe('_Working…_');
  });

  it('cuts each title at 80 characters before grouping', () => {
    const long = 'x'.repeat(100);
    const line = md({ tools: [{ title: `${long}a`, status: 'completed' }, { title: `${long}b`, status: 'completed' }] }).split('\n')[2];
    expect(line).toBe(`✅ ${'x'.repeat(79)}… ×2`);
  });

  it('cuts from the front past 1,500 characters, counting the calls it dropped', () => {
    const tools = Array.from({ length: 40 }, (_, i) => ({ title: `step-${String(i).padStart(2, '0')}-${'y'.repeat(40)}`, status: 'completed' }));
    // The first group twice, so dropping it drops two calls.
    const line = md({ tools: [tools[0]!, ...tools] }).split('\n')[2] ?? '';
    expect(line.length).toBeLessThanOrEqual(1_500);
    const dropped = /^… (\d+) earlier · /.exec(line);
    expect(dropped).not.toBeNull();
    const shown = line.split(' · ').length - 1;
    expect(Number(dropped?.[1])).toBe(41 - shown);
    expect(line.endsWith(`✅ step-39-${'y'.repeat(40)}`)).toBe(true);
  });
});

describe('the tail', () => {
  it('quotes a short text whole', () => {
    expect(md({ text: 'Looking at the login test.\nIt waits on a timer.' })).toContain('> Looking at the login test.\n> It waits on a timer.');
  });

  it('cuts a long text to its last 600 characters at a line break in their first 200', () => {
    const text = `${'a'.repeat(1_000)}\n${'b'.repeat(150)}\n${'c'.repeat(440)}`;
    const out = md({ text });
    // The first line break in the first 200 of the last 600 is the one before the b's.
    expect(out).toContain(`> … (earlier output cut)\n> ${'b'.repeat(150)}\n> ${'c'.repeat(440)}`);
    expect(out).not.toContain('aaaa');
  });

  it('cuts at a space when no line break is near, and at a character when neither is', () => {
    const spaced = `${'a'.repeat(1_000)} ${'w '.repeat(300)}`.trim();
    const tail = md({ text: spaced }).split('\n').slice(3).join('\n');
    expect(tail.startsWith('> … (earlier output cut)\n> w')).toBe(true);
    const solid = 'z'.repeat(2_000);
    const lines = md({ text: solid }).split('\n');
    expect(lines.at(-1)).toBe(`> ${'z'.repeat(600)}`);
  });

  it('is between 400 and 600 characters for a long text', () => {
    for (const at of [10, 150, 199, 250]) {
      const text = `${'q'.repeat(2_000)}${'r'.repeat(at)}\n${'s'.repeat(600 - at - 1)}`;
      const body = md({ text }).split('\n').slice(4).map((l) => l.slice(2)).join('\n');
      expect(body.length).toBeGreaterThanOrEqual(400);
      expect(body.length).toBeLessThanOrEqual(600);
    }
  });

  it('masks the text whole before it is cut, a secret split across chunks among it', () => {
    addSecrets(['sk-tail-secret-0001']);
    const out = md({ text: `the key is sk-tail-${''}secret-0001 and more` });
    expect(out).toContain(`the key is ${MASK} and more`);
    expect(out).not.toContain('sk-tail');
  });
});

describe('the status lines and the button', () => {
  it('has a Stop button while undecided, bound to the task and the run, with no try until one is given', () => {
    const view = renderProgressCard(facts(), 'cli_app');
    expect(view.buttons).toEqual([
      { label: 'Stop', style: 'danger', value: { kind: 'kanban', act: 'stop', task: task.taskId, run: run.runId, nonce: boardCardNonce('cli_app', task.taskId, run.runId) } },
    ]);
    expect(view.attempt).toBeUndefined();
    const tried = renderProgressCard(facts({ attempt: 2 }), 'cli_app');
    expect(Object.keys(tried.buttons[0]?.value ?? {})[0]).toBe('try');
    expect(tried.buttons[0]?.value['try']).toBe('2');
    expect(tried.attempt).toBe(2);
  });

  it('says an approval is waiting', () => {
    expect(md({ approvalWaiting: true })).toContain('_Waiting for an approval: see the card in this chat._');
  });

  it('draws each decided state with its line and word, never the raw outcome, and no button', () => {
    const reported = renderProgressCard(facts({ run: decided('review_requested') }), 'cli_app');
    expect(reported.markdown).toContain('_Reported sent for review; finishing._');
    expect(reported.buttons).toEqual([]);
    const stopping = renderProgressCard(facts({ run: decided('cancelled'), stoppedBy: 'lark:on_alice', nameOf: () => 'Alice' }), 'cli_app');
    expect(stopping.markdown).toContain('⏸ stopping, asked by Alice');
    expect(stopping.buttons).toEqual([]);
    const ending = renderProgressCard(facts({ run: decided('timed_out'), runEnded: ENDED_RETRY }), 'cli_app');
    expect(ending.markdown).toContain('_Ending: failed._');
    expect(ending.markdown).not.toContain('timed_out');
    expect(md({ run: decided('superseded') })).toContain('_Ending: superseded._');
    expect(progressState(decided('blocked'))).toBe('reported');
    expect(progressState(decided('interrupted'))).toBe('ending');
  });
});

describe('the final card', () => {
  it('says each outcome with its mark and word', () => {
    const cases: Array<[RunOutcome, KanbanEvent | undefined, string]> = [
      ['completed', undefined, '✓ completed'],
      ['review_requested', undefined, '✓ sent for review'],
      ['changes_requested', undefined, '✓ changes requested'],
      ['blocked', undefined, '⏸ blocked'],
      ['terminal_provider', undefined, '⏸ blocked'],
      ['failed', ENDED_RETRY, '✗ failed'],
      ['crashed', ENDED_GAVE_UP, '✗ gave up'],
      ['protocol_violation', undefined, '✗ failed'],
      ['rate_limited', undefined, '✗ throttled'],
      ['cancelled', undefined, '⏸ stopped'],
      ['superseded', undefined, '⏸ superseded'],
      ['interrupted', undefined, '⏸ interrupted by a restart'],
    ];
    for (const [outcome, ended, line] of cases) {
      const w = outcomeWord(outcome, ended);
      expect(`${w.mark} ${w.word}`).toBe(line);
    }
  });

  it('draws the header, the final line with the total time, and the tool line, with no tail and no button', () => {
    const view = renderProgressCard(
      facts({ run: decided('completed', true), ranMs: 14 * 60_000 + 3_000, text: 'my summary', tools: [{ title: 'Read', status: 'completed' }] }),
      'cli_app',
    );
    expect(view.markdown).toBe(
      [`⚙️ **Fix the flaky login test** \`${task.taskId}\``, 'implementer · run 1 of 2', '✓ completed after 14 min 3 s', '✅ Read'].join('\n'),
    );
    expect(view.buttons).toEqual([]);
    expect(md({ run: decided('completed', true), ranMs: 47_000 })).toContain('✓ completed after 47 s');
    expect(md({ run: decided('completed', true), ranMs: 72 * 60_000 + 30_000 })).toContain('✓ completed after 1 h 12 min');
  });

  it('draws no time when none is known, and the stale press line under the final line', () => {
    expect(md({ run: decided('interrupted', true), ranMs: null }).split('\n')[2]).toBe('⏸ interrupted by a restart');
    expect(md({ run: decided('cancelled', true), ranMs: 1_000, pressedEnded: true }).split('\n').slice(2, 4)).toEqual(['⏸ stopped after 1 s', 'This run has ended.']);
  });
});

describe('masking and escaping', () => {
  it('masks a known secret in a tool title, in an updated title, and in the task title', () => {
    addSecrets(['sk-title-secret-0002']);
    const out = md({
      task: { ...task, title: 'Rotate sk-title-secret-0002' },
      tools: [{ title: 'curl -H "auth: sk-title-secret-0002"', status: 'completed' }],
    });
    expect(out).not.toContain('sk-title-secret-0002');
    expect(out.split(MASK).length - 1).toBe(2);
  });

  it('masks a tool title before it is cut, so no run of a secret crossing character 80 shows', () => {
    const secret = 'sk-cross-SECRET-abcdefghijklmnop-0004';
    addSecrets([secret]);
    for (const at of [60, 70, 75, 79]) {
      const out = md({ tools: [{ title: `${'x'.repeat(at)}${secret} tail`, status: 'completed' }] });
      for (let i = 0; i + 8 <= secret.length; i += 1) expect(out).not.toContain(secret.slice(i, i + 8));
      if (at < 76) expect(out).toContain(MASK);
    }
    expect(PROGRESS_TITLE_CHARS).toBe(80);
  });

  it("masks the agent's text before the fold cuts it, so a secret the cut splits shows no run of it", () => {
    // 96 does not divide the keep: an unmasked cut would leave part of a secret at the front.
    const secret = `sk-fold-${'Q'.repeat(84)}0005`;
    addSecrets([secret]);
    const p = newProgress();
    const events: Event[] = Array.from({ length: 334 }, (_, i) => ({
      sessionId: 's',
      seq: i + 1,
      ts: NOW,
      generation: 0,
      brokerSeq: null,
      turnId: 't',
      type: 'agent_message_chunk',
      actor: 'agent',
      payload: { text: secret },
    }));
    foldProgress(p, events);
    expect(secret.length * 334).toBeGreaterThan(TEXT_KEEP * 4);
    const out = progressTail(p.text);
    for (let i = 0; i + 8 <= secret.length; i += 1) expect(out).not.toContain(secret.slice(i, i + 8));
    expect(out).toContain(MASK);
  });

  it('masks a secret registered after the event was stored, at render', () => {
    const tools = [{ title: 'echo late-secret-0003', status: 'completed' }];
    expect(md({ tools })).toContain('late-secret-0003');
    addSecrets(['late-secret-0003']);
    expect(md({ tools })).not.toContain('late-secret-0003');
  });

  it('mentions nobody: a tag in a title or in the tail is escaped', () => {
    const out = md({ tools: [{ title: '<at id=all></at>', status: 'completed' }], text: 'hello <at id=all></at>' });
    expect(out).not.toMatch(/(^|[^\\])<at id=all>/);
    expect(out).toContain('\\<at id=all\\>');
  });
});

describe('the uuid', () => {
  it("is the run's, stable, and not a person's card's", () => {
    expect(progressCardUuid('cli_app', run.runId)).toBe(progressCardUuid('cli_app', run.runId));
    expect(progressCardUuid('cli_app', run.runId)).not.toBe(boardCardUuid('cli_app', run.runId));
    expect(progressCardUuid('cli_app', run.runId)).not.toBe(progressCardUuid('cli_other', run.runId));
  });
});
