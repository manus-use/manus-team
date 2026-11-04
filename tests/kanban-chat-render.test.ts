import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addComment, addGate, block, complete, createTask, endRun, DEFAULT_LIMITS } from '../src/db/kanban.js';
import { boardList, eventsOf, getTask, taskView } from '../src/db/kanban-read.js';
import { renderGates, renderHelp, renderList, renderNotice, renderShow } from '../src/kanban/chat-render.js';
import type { KanbanEvent, TaskRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed, newTask } from './helpers/kanban.js';

/**
 * What /kanban says, and what a subscription hears (spec §9.3, §9.4): task text
 * is untrusted, so it is escaped -- a tag can never become a mention -- and
 * masked before it is cut.
 */

let h: TestDb;

beforeEach(() => {
  clearSecrets();
  h = testDb();
});
afterEach(() => {
  clearSecrets();
  h.close();
});

const SPOOF = 'hi <at id=all></at> team';

function last(taskId: string): KanbanEvent {
  const e = eventsOf(h.db, taskId).at(-1);
  if (e === undefined) throw new Error('no event');
  return e;
}

function task(taskId: string): TaskRow {
  const t = getTask(h.db, taskId);
  if (t === undefined) throw new Error('no task');
  return t;
}

const LIMIT = { blockRecurrenceLimit: 2 };

describe('/kanban help', () => {
  it('lists every command with the tier it needs, and says people arrive in a later update', () => {
    const help = renderHelp();
    for (const verb of ['new', 'list', 'show', 'assign', 'link', 'workspace', 'comment', 'unblock', 'stop', 'archive']) {
      expect(help).toContain(`/kanban ${verb}`);
    }
    expect(help).toContain('`/kanban gate add <task> [--timeout <seconds>] <command>` (operator)');
    expect(help).toContain('`/kanban list');
    expect(help).toContain('(anyone allowed)');
    expect(help).toContain('arrives in a later update');
    expect(help).not.toContain('D2');
  });
});

describe('/kanban list', () => {
  it('shows the open tasks by status, escaped, and a filter or all', () => {
    const ready = newTask(h.db, { title: `ready ${SPOOF}` });
    const running = newTask(h.db, { title: 'running_one' });
    claimed(h.db, running.taskId);
    const done = newTask(h.db, { title: 'finished', workspace: 'web' });
    const run = claimed(h.db, done.taskId);
    expect(complete(h.db, done.taskId, { kind: 'run', runId: run.runId }, { summary: 'ok' }, NOW).ok).toBe(true);

    const board = boardList(h.db);
    const open = renderList(board, undefined);
    expect(open.split('\n')).toEqual([
      `\`${running.taskId}\` **running** — running\\_one · role implementer`,
      `\`${ready.taskId}\` **ready** — ready hi \\<at id=all\\>\\</at\\> team · role implementer`,
    ]);
    expect(renderList(board, 'done')).toContain(done.taskId);
    expect(renderList(board, 'done')).not.toContain(ready.taskId);
    expect(renderList(board, 'all').split('\n')).toHaveLength(3);
    expect(renderList(board, 'archived')).toBe('No archived tasks.');
    expect(renderList([], undefined)).toBe('No open tasks. `/kanban list all` shows done and archived ones too.');
  });

  it('keeps a long title to one line, cut with a one-line marker', () => {
    const k = newTask(h.db, { title: `${'word '.repeat(60)}end` });
    const line = renderList(boardList(h.db), undefined);
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain(`\`${k.taskId}\` **ready** — ${'word '.repeat(60).slice(0, 119)}… · role implementer`);
    expect(line).not.toContain('(truncated)');
  });

  it('shows at most 30, and says how many more there are', () => {
    for (let i = 0; i < 32; i += 1) newTask(h.db, { title: `task ${i}` });
    const lines = renderList(boardList(h.db), undefined).split('\n');
    expect(lines).toHaveLength(31);
    expect(lines[30]).toMatch(/^… and 2 more\. /);
  });
});

describe('/kanban show', () => {
  it('shows the task, its contract, gates, runs, latest output and comments, escaped and masked', () => {
    const k = newTask(h.db, {
      title: 'Write *the* notes',
      body: `Line one ${SPOOF}\n# not a heading`,
      contract: { outcome: 'notes_merged', stop_when: 'no changelog' },
      workspace: 'docs',
    });
    expect(addGate(h.db, k.taskId, { command: 'test -f notes.md --key sk-late-12345678', timeoutS: 30 }, ALICE, NOW).ok).toBe(
      true,
    );
    const run = claimed(h.db, k.taskId);
    expect(
      endRun(h.db, run.runId, { outcome: 'failed', error: 'exit 1', lastOutput: 'wrote <b>notes</b>' }, DEFAULT_LIMITS, NOW).ok,
    ).toBe(true);
    expect(addComment(h.db, k.taskId, ALICE, 'use the 2024 numbers', NOW, true).ok).toBe(true);
    // Known only now: a gate defined before the secret was is still shown masked.
    addSecrets(['sk-late-12345678']);

    const view = taskView(h.db, k.taskId);
    if (view === undefined) throw new Error('no view');
    const text = renderShow(view, [
      { id: 1, taskId: k.taskId, command: 'test -f notes.md --key sk-late-12345678', timeoutS: 30, createdBy: ALICE, createdAt: NOW },
    ]);
    expect(text.split('\n')).toEqual([
      `**Write \\*the\\* notes** \`${k.taskId}\` — ready`,
      'assignee: role implementer · reviewer: nobody · workspace: docs',
      '> Line one hi \\<at id=all\\>\\</at\\> team',
      '> # not a heading',
      '**Contract**',
      'outcome: notes\\_merged',
      'stop\\_when: no changelog',
      '**Gates**',
      `1. test -f notes.md --key ${MASK} (30 s)`,
      '**Runs**',
      '#1 work · role implementer · failed — exit 1',
      'Latest output:',
      '> wrote \\<b\\>notes\\</b\\>',
      '**Comments** (1 of 1)',
      'lark:on\\_alice:',
      '> use the 2024 numbers',
    ]);
  });

  it("shows the end of the latest output, masked whole before it is cut, and marks the cut", () => {
    addSecrets(['sk-tail-1234567890']);
    const k = newTask(h.db);
    const run = claimed(h.db, k.taskId);
    // The secret straddles where an 800-character tail would begin.
    const output = `${'a'.repeat(400)}sk-tail-1234567890${'b'.repeat(790)}END-OF-OUTPUT`;
    expect(endRun(h.db, run.runId, { outcome: 'failed', lastOutput: output }, DEFAULT_LIMITS, NOW).ok).toBe(true);
    const view = taskView(h.db, k.taskId);
    if (view === undefined) throw new Error('no view');
    const text = renderShow(view, []);
    expect(text).toContain('> … (earlier output cut)\n> ');
    expect(text).toContain('END-OF-OUTPUT');
    expect(text).not.toContain('aaaa');
    for (const piece of ['sk-tail', 'tail-123', '1234567890']) expect(text).not.toContain(piece);
  });

  it('masks a secret holding a line break in a title, before the title is made one line', () => {
    addSecrets(['sk-multi\nline-123456']);
    const k = newTask(h.db, { title: 'Rotate sk-multi\nline-123456 today' });
    const view = taskView(h.db, k.taskId);
    if (view === undefined) throw new Error('no view');
    expect(renderShow(view, []).split('\n')[0]).toBe(`**Rotate ${MASK} today** \`${k.taskId}\` — ready`);
    expect(renderList(boardList(h.db), undefined)).toContain(`— Rotate ${MASK} today ·`);
  });

  it('escapes a line that would open or close a code fence inside a quoted body', () => {
    const k = newTask(h.db, { body: 'before\n```\n~~~~ tilde\n  ```js\nafter' });
    const view = taskView(h.db, k.taskId);
    if (view === undefined) throw new Error('no view');
    expect(renderShow(view, []).split('\n').slice(2, 7)).toEqual([
      '> before',
      '> \\```',
      '> \\~~~~ tilde',
      '>   \\```js',
      '> after',
    ]);
  });

  it('masks a secret before it cuts a long piece, so no start of it shows', () => {
    addSecrets(['sk-split-1234567890']);
    const k = newTask(h.db, { body: `${'x'.repeat(1490)}sk-split-1234567890 and more` });
    const view = taskView(h.db, k.taskId);
    if (view === undefined) throw new Error('no view');
    const text = renderShow(view, []);
    expect(text).not.toContain('sk-split');
    expect(text).toContain('(truncated)');
  });
});

describe('/kanban gate list', () => {
  it('shows each gate masked, in order, with its timeout and who defined it', () => {
    addSecrets(['sk-gate-12345678']);
    expect(
      renderGates('k_1', [
        { id: 4, taskId: 'k_1', command: 'curl -H "k: sk-gate-12345678" https://ci', timeoutS: 60, createdBy: ALICE, createdAt: NOW },
        { id: 7, taskId: 'k_1', command: 'test -s report_final.md', timeoutS: 300, createdBy: 'operator:alice', createdAt: NOW },
      ]).split('\n'),
    ).toEqual([
      'Gates of `k_1`, run in this order before it may complete or go to review:',
      `4. curl -H "k: ${MASK}" https://ci (60 s, by lark:on\\_alice)`,
      '7. test -s report\\_final.md (300 s, by operator:alice)',
    ]);
    expect(renderGates('k_1', [])).toBe('Task `k_1` has no gates.');
  });
});

describe('notices', () => {
  it('tells of a completion, with its summary kept as markdown and its tags neutralized', () => {
    const k = newTask(h.db, { title: 'Release notes' });
    const run = claimed(h.db, k.taskId);
    expect(complete(h.db, k.taskId, { kind: 'run', runId: run.runId }, { summary: `**merged** ${SPOOF}` }, NOW).ok).toBe(true);
    expect(renderNotice(last(k.taskId), task(k.taskId), LIMIT)).toBe(
      `Done — **Release notes** \`${k.taskId}\`:\n> **merged** hi \\<at id=all\\>\\</at\\> team`,
    );
  });

  it('tells of a block with its kind and reason, and asks for a rewrite once it keeps recurring', () => {
    const k = newTask(h.db, { title: 'Fetch the report' });
    const run = claimed(h.db, k.taskId);
    const by = { kind: 'run' as const, runId: run.runId };
    expect(block(h.db, k.taskId, by, { kind: 'capability', reason: 'no access to the_drive' }, NOW).ok).toBe(true);
    expect(renderNotice(last(k.taskId), task(k.taskId), LIMIT)).toBe(
      `Blocked (capability) — **Fetch the report** \`${k.taskId}\`: no access to the\\_drive\n` +
        `\`/kanban unblock ${k.taskId} [comment]\` once it can go on.`,
    );
    const again = { ...last(k.taskId), payload: { kind: 'capability', reason: 'still no access', blockRecurrences: 2 } };
    expect(renderNotice(again, task(k.taskId), LIMIT)).toContain('It keeps blocking for the same reason (2 times after an unblock)');
  });

  it('says nothing of a dependency block, a throttled cooldown, or an event that is no notice', () => {
    const k = newTask(h.db);
    const t = task(k.taskId);
    const event = (kind: string, payload: unknown): KanbanEvent => ({ ...last(k.taskId), kind, payload });
    expect(renderNotice(event('blocked', { kind: 'dependency', reason: 'waits', parents: [] }), t, LIMIT)).toBeUndefined();
    expect(renderNotice(event('run_ended', { outcome: 'rate_limited', next: 'cooldown' }), t, LIMIT)).toBeUndefined();
    // A restart's interruption is retried quietly: the task did nothing wrong.
    expect(renderNotice(event('run_ended', { outcome: 'interrupted', next: 'retry' }), t, LIMIT)).toBeUndefined();
    for (const kind of ['created', 'claimed', 'commented', 'linked', 'gates_ran', 'archived', 'changes_requested']) {
      expect(renderNotice(event(kind, {}), t, LIMIT)).toBeUndefined();
    }
  });

  it('tells of a retry after a failure, of giving up, of a stop, of a review requested and of a stranded task', () => {
    const k = newTask(h.db, { title: 'Survey' });
    const t = task(k.taskId);
    const event = (kind: string, payload: unknown, actor = 'gateway'): KanbanEvent => ({ ...last(k.taskId), kind, actor, payload });
    const name = `**Survey** \`${k.taskId}\``;
    expect(renderNotice(event('run_ended', { outcome: 'crashed', error: 'exit_1', next: 'retry' }), t, LIMIT)).toBe(
      `Retrying — ${name}: the last attempt ended crashed: exit\\_1.`,
    );
    expect(
      renderNotice(
        event('run_ended', { outcome: 'failed', next: 'blocked', blockKind: 'gave_up', blockReason: 'failed 2 times; last failed' }),
        t,
        LIMIT,
      ),
    ).toBe(`Gave up — ${name}: failed 2 times; last failed\n\`/kanban unblock ${k.taskId} [comment]\` gives it a fresh set of attempts.`);
    expect(
      renderNotice(event('run_ended', { outcome: 'terminal_provider', next: 'blocked', blockKind: 'capability', blockReason: '401' }), t, LIMIT),
    ).toMatch(/^Blocked \(capability\) — .*: 401\n`\/kanban unblock/);
    // The recurrences the event recorded, not the task's count now.
    expect(
      renderNotice(
        event('run_ended', { outcome: 'failed', next: 'blocked', blockKind: 'needs_input', blockReason: 'look first', blockRecurrences: 2 }),
        { ...t, blockRecurrences: 0 },
        LIMIT,
      ),
    ).toContain('It keeps blocking for the same reason (2 times after an unblock)');
    expect(
      renderNotice(
        event('run_ended', { outcome: 'failed', next: 'blocked', blockKind: 'needs_input', blockReason: 'look first', blockRecurrences: 0 }),
        { ...t, blockRecurrences: 5 },
        LIMIT,
      ),
    ).toContain('once it can go on');
    expect(renderNotice(event('stopped', { blockRecurrences: 0 }, ALICE), t, LIMIT)).toMatch(
      /^Blocked \(needs\\_input\) — .*: stopped by lark:on\\_alice\n/,
    );
    expect(renderNotice(event('review_requested', { summary: 'v1', reviewer: 'reviewer', reviewerKind: 'role' }), t, LIMIT)).toBe(
      `Review requested — ${name}, from role reviewer.`,
    );
    expect(renderNotice(event('stranded', { reason: 'role "gone" is not configured' }), t, LIMIT)).toBe(
      `Stranded — ${name}: nobody can be given it: role "gone" is not configured`,
    );
  });

  it('masks a secret in what it tells', () => {
    addSecrets(['sk-said-12345678']);
    const created = createTask(h.db, { title: 'a task', createdBy: ALICE, createdVia: VIA }, NOW);
    if (!created.ok) throw new Error(created.message);
    const event: KanbanEvent = { ...last(created.task.taskId), kind: 'stranded', payload: { reason: 'key sk-said-12345678 refused' } };
    expect(renderNotice(event, created.task, LIMIT)).toContain(`key ${MASK} refused`);
  });
});
