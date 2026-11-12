import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addComment, addGate, block, closeRun, complete, createTask, endRun, DEFAULT_LIMITS, requestChanges, requestReview } from '../src/db/kanban.js';
import { boardList, eventsOf, getTask, taskView } from '../src/db/kanban-read.js';
import { boardCardNonce } from '../src/core/ids.js';
import {
  blocksTask,
  renderCardOutcome,
  renderGates,
  renderHelp,
  renderList,
  renderNotice,
  renderReviewCard,
  renderShow,
  renderTaskCard,
  unblockButton,
} from '../src/kanban/chat-render.js';
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
  it('lists every command with who may run it, people as assignees and reviewers among them', () => {
    const help = renderHelp();
    const verbs = ['new', 'list', 'show', 'assign', 'link', 'workspace', 'comment', 'unblock', 'stop', 'archive', 'done', 'block', 'review', 'approve', 'changes'];
    for (const verb of verbs) {
      expect(help).toContain(`\`/kanban task ${verb}`);
      // Never in the old form, without task.
      expect(help).not.toContain(`/kanban ${verb}`);
    }
    for (const sub of ['board list', 'board create', 'board use', 'board set', 'board archive', 'gate add', 'gate list', 'gate remove']) {
      expect(help).toContain(`\`/kanban ${sub}`);
    }
    expect(help).toContain('`/kanban help`');
    expect(help).toContain('`/kanban gate add <task> [--timeout <seconds>] <command>` (operator)');
    expect(help).toContain('`/kanban task list');
    expect(help).toContain('(anyone allowed)');
    expect(help).toContain("`/kanban task done <task> [summary]` (the task's assignee)");
    expect(help).toContain('`/kanban task changes <task> <reason>` (its reviewer, or an operator)');
    expect(help).toContain('Name a person with an @-mention');
    expect(help).not.toContain('later update');
    expect(help).not.toContain('D2');
  });
});

describe('/kanban task list', () => {
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
      `\`${running.taskId}\` **running**: running\\_one · role implementer`,
      `\`${ready.taskId}\` **ready**: ready hi \\<at id=all\\>\\</at\\> team · role implementer`,
    ]);
    expect(renderList(board, 'done')).toContain(done.taskId);
    expect(renderList(board, 'done')).not.toContain(ready.taskId);
    expect(renderList(board, 'all').split('\n')).toHaveLength(3);
    expect(renderList(board, 'archived')).toBe('No archived tasks.');
    expect(renderList([], undefined)).toBe('No open tasks. `/kanban task list all` shows done and archived ones too.');
  });

  it('keeps a long title to one line, cut with a one-line marker', () => {
    const k = newTask(h.db, { title: `${'word '.repeat(60)}end` });
    const line = renderList(boardList(h.db), undefined);
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain(`\`${k.taskId}\` **ready**: ${'word '.repeat(60).slice(0, 119)}… · role implementer`);
    expect(line).not.toContain('(truncated)');
  });

  it('shows at most 30, and says how many more there are', () => {
    for (let i = 0; i < 32; i += 1) newTask(h.db, { title: `task ${i}` });
    const lines = renderList(boardList(h.db), undefined).split('\n');
    expect(lines).toHaveLength(31);
    expect(lines[30]).toMatch(/^… and 2 more\. /);
  });
});

describe('/kanban task show', () => {
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
      `**Write \\*the\\* notes** \`${k.taskId}\`: ready`,
      'assignee: role implementer · reviewer: nobody · workspace: docs',
      '> Line one hi \\<at id=all\\>\\</at\\> team',
      '> # not a heading',
      '**Contract**',
      'outcome: notes\\_merged',
      'stop\\_when: no changelog',
      '**Gates**',
      `1. test -f notes.md --key ${MASK} (30 s)`,
      '**Runs**',
      '#1 work · role implementer · failed: exit 1',
      'Latest output:',
      '> wrote \\<b\\>notes\\</b\\>',
      '**Comments** (1 of 1)',
      'lark:on\\_alice:',
      '> use the 2024 numbers',
    ]);
  });

  it("gives a parent's and a child's derived status, not the phase open", () => {
    const parent = newTask(h.db, { title: 'parent' });
    const child = newTask(h.db, { title: 'child', parents: [parent.taskId] });
    const grandchild = newTask(h.db, { title: 'grandchild', parents: [child.taskId] });
    const show = (taskId: string) => {
      const view = taskView(h.db, taskId);
      if (view === undefined) throw new Error('no view');
      return renderShow(view, []).split('\n');
    };
    expect(show(child.taskId)).toEqual(expect.arrayContaining([`parents: \`${parent.taskId}\` (ready)`, `children: \`${grandchild.taskId}\` (todo)`]));
    claimed(h.db, parent.taskId);
    expect(show(child.taskId)).toContain(`parents: \`${parent.taskId}\` (running)`);
    expect(show(parent.taskId)).toContain(`children: \`${child.taskId}\` (todo)`);
    expect(taskView(h.db, child.taskId)?.statuses.get(parent.taskId)).toBe('running');
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
    expect(renderShow(view, []).split('\n')[0]).toBe(`**Rotate ${MASK} today** \`${k.taskId}\`: ready`);
    expect(renderList(boardList(h.db), undefined)).toContain(`: Rotate ${MASK} today ·`);
  });

  it('masks a secret split by a character that shows nothing, and keeps such characters elsewhere', () => {
    // Written before the secret is known, as a task written before a role's .env changed.
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const k = newTask(h.db, {
      title: `Rotate sk-live-12\u200B34567890 ${family}`,
      body: `key sk-live-\u202E1234567890 and שלום\u200F ok`,
    });
    addSecrets(['sk-live-1234567890']);
    const view = taskView(h.db, k.taskId);
    if (view === undefined) throw new Error('no view');
    const text = renderShow(view, []);
    expect(text.split('\n')[0]).toBe(`**Rotate ${MASK} ${family}** \`${k.taskId}\`: ready`);
    expect(text).toContain(`key ${MASK} and שלום\u200F ok`);
    expect(text).not.toContain('sk-live');
    expect(renderList(boardList(h.db), undefined)).toContain(`: Rotate ${MASK} ${family} ·`);
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

  it('reads a lone CR in a body as a line break, so every line is quoted and a fence after one is escaped', () => {
    const k = newTask(h.db, { body: 'intro\r```\r# Heading\r- item' });
    const view = taskView(h.db, k.taskId);
    if (view === undefined) throw new Error('no view');
    const text = renderShow(view, []);
    expect(text).not.toContain('\r');
    expect(text.split('\n').slice(2, 6)).toEqual(['> intro', '> \\```', expect.stringMatching(/^> .*Heading$/), expect.stringMatching(/^> .*item$/)]);
  });

  it('cuts a piece on a character boundary, never leaving half of an emoji', () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    // Each emoji straddles where its piece is cut: a title at 200, a body at 1500, an output's tail at 800.
    const k = newTask(h.db, { title: `${'a'.repeat(198)}😀 rest`, body: `${'x'.repeat(1485)}😀${' and more'.repeat(10)}` });
    const run = claimed(h.db, k.taskId);
    expect(endRun(h.db, run.runId, { outcome: 'failed', lastOutput: `start 😀${'y'.repeat(799)}` }, DEFAULT_LIMITS, NOW).ok).toBe(true);
    const view = taskView(h.db, k.taskId);
    if (view === undefined) throw new Error('no view');
    const text = renderShow(view, []);
    expect(text).toContain('(truncated)');
    expect(text).toContain('(earlier output cut)');
    expect(text).not.toMatch(lone);
    expect(renderList(boardList(h.db), undefined)).not.toMatch(lone);
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
      `Done: **Release notes** \`${k.taskId}\`\n> **merged** hi \\<at id=all\\>\\</at\\> team`,
    );
  });

  it('tells of a block with its kind and reason, and asks for a rewrite once it keeps recurring', () => {
    const k = newTask(h.db, { title: 'Fetch the report' });
    const run = claimed(h.db, k.taskId);
    const by = { kind: 'run' as const, runId: run.runId };
    expect(block(h.db, k.taskId, by, { kind: 'capability', reason: 'no access to the_drive' }, NOW).ok).toBe(true);
    expect(renderNotice(last(k.taskId), task(k.taskId), LIMIT)).toBe(
      `**Fetch the report** \`${k.taskId}\` is blocked (capability): no access to the\\_drive\n` +
        `\`/kanban task unblock ${k.taskId} [comment]\` once it can go on.`,
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
    for (const kind of ['created', 'claimed', 'commented', 'linked', 'gates_ran', 'archived', 'card_sent']) {
      expect(renderNotice(event(kind, {}), t, LIMIT)).toBeUndefined();
    }
  });

  it('tells of a retry after a failure, of giving up, of a stop, of a review requested and of a stranded task', () => {
    const k = newTask(h.db, { title: 'Survey' });
    const t = task(k.taskId);
    const event = (kind: string, payload: unknown, actor = 'gateway'): KanbanEvent => ({ ...last(k.taskId), kind, actor, payload });
    const name = `**Survey** \`${k.taskId}\``;
    expect(renderNotice(event('run_ended', { outcome: 'crashed', error: 'exit_1', next: 'retry' }), t, LIMIT)).toBe(
      `Retrying ${name}. The last attempt ended crashed: exit\\_1.`,
    );
    expect(
      renderNotice(
        event('run_ended', { outcome: 'failed', next: 'blocked', blockKind: 'gave_up', blockReason: 'failed 2 times; last failed' }),
        t,
        LIMIT,
      ),
    ).toBe(`Gave up on ${name}: failed 2 times; last failed\n\`/kanban task unblock ${k.taskId} [comment]\` gives it a fresh set of attempts.`);
    expect(
      renderNotice(event('run_ended', { outcome: 'terminal_provider', next: 'blocked', blockKind: 'capability', blockReason: '401' }), t, LIMIT),
    ).toMatch(/^.* is blocked \(capability\): 401\n`\/kanban task unblock/);
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
      /^.* is blocked \(needs\\_input\): stopped by lark:on\\_alice\n/,
    );
    // A stop is a person's choice, not the task blocking again for the same reason: no rewrite suggested.
    const stopped = renderNotice(event('stopped', { blockRecurrences: 5 }, ALICE), t, LIMIT);
    expect(stopped).toBe(
      `${name} is blocked (needs\\_input): stopped by lark:on\\_alice\n\`/kanban task unblock ${k.taskId} [comment]\` once it can go on.`,
    );
    // A person who stopped it is named as Lark last gave their name, escaped; anyone else by their actor.
    const nameOf = (p: string) => (p === ALICE ? 'Alice <at id=all></at>' : undefined);
    expect(renderNotice(event('stopped', { blockRecurrences: 0 }, ALICE), t, { ...LIMIT, nameOf })).toMatch(
      /: stopped by Alice \\<at id=all\\>\\<\/at\\>\n/,
    );
    expect(renderNotice(event('stopped', { blockRecurrences: 0 }, 'lark:on_nobody'), t, { ...LIMIT, nameOf })).toMatch(
      /: stopped by lark:on\\_nobody\n/,
    );
    expect(renderNotice(event('review_requested', { summary: 'v1', reviewer: 'reviewer', reviewerKind: 'role' }), t, LIMIT)).toBe(
      `Review requested for ${name}, from role reviewer.`,
    );
    expect(renderNotice(event('stranded', { reason: 'role "gone" is not configured' }), t, LIMIT)).toBe(
      `Stranded: ${name}. Nobody can be given it: role "gone" is not configured`,
    );
  });

  it('tells of changes requested, by whom, with the reason on one line, masked and escaped', () => {
    addSecrets(['sk-review-12345678']);
    const k = newTask(h.db, { title: 'Release notes', reviewer: { kind: 'role', name: 'reviewer' } });
    const work = claimed(h.db, k.taskId);
    expect(requestReview(h.db, k.taskId, { kind: 'run', runId: work.runId }, { summary: 'v1' }, NOW).ok).toBe(true);
    expect(closeRun(h.db, work.runId, NOW).ok).toBe(true);
    const review = claimed(h.db, k.taskId);
    const reason = 'cite the_sources\n<at id=all></at> and drop sk-review-12345678';
    expect(requestChanges(h.db, k.taskId, { kind: 'run', runId: review.runId }, reason, NOW).ok).toBe(true);
    const name = `**Release notes** \`${k.taskId}\``;
    const said = `cite the\\_sources \\<at id=all\\>\\</at\\> and drop ${MASK}`;
    expect(renderNotice(last(k.taskId), task(k.taskId), LIMIT)).toBe(`Changes requested on ${name} by role reviewer: ${said}`);
    // A person, by the name Lark last gave, else their principal; an operator as recorded.
    const event = (actor: string): KanbanEvent => ({ ...last(k.taskId), actor, payload: { reason: 'tighten it' } });
    const nameOf = (p: string) => (p === ALICE ? 'Alice <at id=all></at>' : undefined);
    expect(renderNotice(event(ALICE), task(k.taskId), { ...LIMIT, nameOf })).toBe(
      `Changes requested on ${name} by Alice \\<at id=all\\>\\</at\\>: tighten it`,
    );
    expect(renderNotice(event(ALICE), task(k.taskId), LIMIT)).toBe(`Changes requested on ${name} by lark:on\\_alice: tighten it`);
    expect(renderNotice(event('operator:alice'), task(k.taskId), LIMIT)).toBe(`Changes requested on ${name} by operator:alice: tighten it`);
    // An event from before the reviewer was recorded: the run's role, while the run is on the board.
    const old = { ...last(k.taskId), actor: `run:${review.runId}`, payload: { reason: 'tighten it' } };
    const runAssignee = (runId: string) => (runId === review.runId ? review.assignee : undefined);
    expect(renderNotice(old, task(k.taskId), { ...LIMIT, runAssignee })).toBe(`Changes requested on ${name} by role reviewer: tighten it`);
    expect(renderNotice({ ...old, actor: 'run:r_gone' }, task(k.taskId), { ...LIMIT, runAssignee })).toBe(
      `Changes requested on ${name} by run:r\\_gone: tighten it`,
    );
    // A long reason is cut, still on one line.
    const long = renderNotice({ ...event(ALICE), payload: { reason: 'x'.repeat(2000) } }, task(k.taskId), LIMIT) ?? '';
    expect(long.split('\n')).toHaveLength(1);
    expect(long.length).toBeLessThan(1000);
  });

  it("tells who a person's claim gave the task to, by name, in plain text, and nothing of a role's", () => {
    const k = newTask(h.db, { title: `Check the links ${SPOOF}`, assignee: { kind: 'human', name: ALICE } });
    claimed(h.db, k.taskId);
    const nameOf = (p: string) => (p === ALICE ? 'Alice <at id=all></at>' : undefined);
    expect(renderNotice(last(k.taskId), task(k.taskId), { ...LIMIT, nameOf })).toBe(
      `📋 **Check the links hi \\<at id=all\\>\\</at\\> team** \`${k.taskId}\`, assigned to Alice \\<at id=all\\>\\</at\\>`,
    );
    // Without a name known, the principal.
    expect(renderNotice(last(k.taskId), task(k.taskId), LIMIT)).toMatch(/, assigned to lark:on\\_alice$/);
    const review = { ...last(k.taskId), payload: { kind: 'review', assignee: ALICE, assigneeKind: 'human' } };
    expect(renderNotice(review, task(k.taskId), { ...LIMIT, nameOf })).toMatch(/, review assigned to Alice /);
    const role = newTask(h.db);
    claimed(h.db, role.taskId);
    expect(renderNotice(last(role.taskId), task(role.taskId), { ...LIMIT, nameOf })).toBeUndefined();
    const asked = { ...last(k.taskId), kind: 'review_requested', payload: { summary: 'v1', reviewer: ALICE, reviewerKind: 'human' } };
    expect(renderNotice(asked, task(k.taskId), { ...LIMIT, nameOf: () => 'Alice' })).toMatch(/, from Alice\.$/);
  });

  it("tells of a card that could not be sent, and how its person can answer without it", () => {
    const k = newTask(h.db, { title: 'Survey' });
    const event = (payload: unknown): KanbanEvent => ({ ...last(k.taskId), kind: 'card_failed', payload });
    expect(renderNotice(event({ kind: 'work', to: ALICE, error: 'the user is not in the app' }), task(k.taskId), { ...LIMIT, nameOf: () => 'Alice' })).toBe(
      `Could not send Alice the card for **Survey** \`${k.taskId}\`: the user is not in the app\n` +
        `They can answer from any chat with the bot: \`/kanban task done ${k.taskId} [summary]\` or \`/kanban task block ${k.taskId} <reason>\`.`,
    );
    expect(renderNotice(event({ kind: 'review', to: ALICE, error: 'x' }), task(k.taskId), LIMIT)).toContain(`\`/kanban task approve ${k.taskId}\``);
  });

  it('knows which events left the task blocked, for the Unblock under their notice', () => {
    const k = newTask(h.db);
    const event = (kind: string, payload: unknown): KanbanEvent => ({ ...last(k.taskId), kind, payload });
    expect(blocksTask(event('blocked', { kind: 'needs_input', reason: 'x' }))).toBe(true);
    expect(blocksTask(event('blocked', { kind: 'dependency', reason: 'x' }))).toBe(false);
    expect(blocksTask(event('stopped', {}))).toBe(true);
    expect(blocksTask(event('run_ended', { next: 'blocked' }))).toBe(true);
    expect(blocksTask(event('run_ended', { next: 'retry' }))).toBe(false);
    expect(blocksTask(event('completed', {}))).toBe(false);
    const b = event('blocked', { kind: 'needs_input', reason: 'x' });
    expect(unblockButton('cli_app', b)).toEqual({
      label: `Unblock ${k.taskId}`,
      style: 'primary',
      value: { kind: 'kanban', act: 'unblock', task: k.taskId, event: String(b.id), nonce: boardCardNonce('cli_app', k.taskId, `event:${b.id}`) },
    });
  });

  it('masks a secret in what it tells', () => {
    addSecrets(['sk-said-12345678']);
    const created = createTask(h.db, { title: 'a task', createdBy: ALICE, createdVia: VIA }, NOW);
    if (!created.ok) throw new Error(created.message);
    const event: KanbanEvent = { ...last(created.task.taskId), kind: 'stranded', payload: { reason: 'key sk-said-12345678 refused' } };
    expect(renderNotice(event, created.task, LIMIT)).toContain(`key ${MASK} refused`);
  });
});

describe("a person's cards", () => {
  it('shows a task card its title, body, contract and parents, escaped and masked, with Done and Block for its run', () => {
    addSecrets(['sk-card-12345678']);
    const parent = newTask(h.db, { title: 'Collect the numbers' });
    const prun = claimed(h.db, parent.taskId);
    expect(complete(h.db, parent.taskId, { kind: 'run', runId: prun.runId }, { summary: 'in sheet Q3' }, NOW).ok).toBe(true);
    const k = newTask(h.db, {
      title: `Write them up ${SPOOF}`,
      body: 'Use the sk-card-12345678 key\n# not a heading',
      contract: { outcome: 'a page' },
      assignee: { kind: 'human', name: ALICE },
      parents: [parent.taskId],
    });
    const run = claimed(h.db, k.taskId);
    const view = renderTaskCard({ task: task(k.taskId), run, parents: [{ task: task(parent.taskId), summary: 'in sheet Q3' }] }, 'cli_app');
    expect(view.markdown).toContain(`📋 For you to do: **Write them up hi \\<at id=all\\>\\</at\\> team** \`${k.taskId}\``);
    expect(view.markdown).toContain(`> Use the ${MASK} key\n> # not a heading`);
    expect(view.markdown).toContain('outcome: a page');
    expect(view.markdown).toContain(`\`${parent.taskId}\` **Collect the numbers**:\n> in sheet Q3`);
    expect(view.markdown).toContain(
      `In any chat with the bot, \`/kanban task done ${k.taskId} [summary]\` and \`/kanban task block ${k.taskId} <reason>\` do the same.`,
    );
    expect(view.input).toEqual({ placeholder: 'A summary, or why it is blocked' });
    const nonce = boardCardNonce('cli_app', k.taskId, run.runId);
    expect(view.buttons).toEqual([
      { label: 'Done', style: 'primary', value: { kind: 'kanban', act: 'done', task: k.taskId, run: run.runId, nonce } },
      { label: 'Block', style: 'danger', value: { kind: 'kanban', act: 'block', task: k.taskId, run: run.runId, nonce } },
    ]);
    const rework = renderTaskCard({ task: task(k.taskId), run, parents: [], changes: { reason: 'cite it', actor: 'lark:on_bob' }, nameOf: () => 'Bob' }, 'cli_app');
    expect(rework.markdown).toContain('**Changes asked** by Bob:\n> cite it');
  });

  it('shows a review card the handoff and the commit to review, when one was recorded, with Approve and Request changes', () => {
    const k = newTask(h.db, { title: 'Fix the footer', reviewer: { kind: 'human', name: ALICE } });
    const run = claimed(h.db, k.taskId);
    const handoff = { runId: 'r_work', actor: 'run:r_work', summary: 'moved it', metadata: null, reportedCommit: 'abc1234', reportedDirty: false };
    const view = renderReviewCard({ task: task(k.taskId), run, parents: [], handoff }, 'cli_app');
    expect(view.markdown).toContain(`🔎 For you to review: **Fix the footer** \`${k.taskId}\``);
    expect(view.markdown).toContain('**The handoff**, from its agent:\n> moved it');
    expect(view.markdown).toContain('To review: review commit abc1234.');
    expect(view.markdown).toContain(
      `In any chat with the bot, \`/kanban task approve ${k.taskId}\` and \`/kanban task changes ${k.taskId} <reason>\` do the same.`,
    );
    expect(view.buttons.map((b) => [b.label, b.value['act']])).toEqual([
      ['Approve', 'approve'],
      ['Request changes', 'changes'],
    ]);
    // Any work, not only code: no commit recorded, no line for one.
    const doc = renderReviewCard(
      { task: task(k.taskId), run, parents: [], handoff: { ...handoff, runId: null, actor: 'lark:on_bob', reportedCommit: null, reportedDirty: null } },
      'cli_app',
    );
    expect(doc.markdown).not.toContain('To review:');
    expect(doc.markdown).toContain('from lark:on\\_bob');
  });

  it('starts a card with a mention of its person by open_id, put in after the escaping, and none for anything that is not one', () => {
    const k = newTask(h.db, { title: `Check the links ${SPOOF}`, assignee: { kind: 'human', name: ALICE }, reviewer: { kind: 'human', name: ALICE } });
    const run = claimed(h.db, k.taskId);
    const facts = { task: task(k.taskId), run, parents: [] };
    const card = renderTaskCard({ ...facts, mention: 'ou_alice' }, 'cli_app');
    expect(card.markdown.startsWith(`<at id=ou_alice></at> 📋 For you to do: **Check the links hi \\<at id=all\\>\\</at\\> team**`)).toBe(true);
    expect(renderReviewCard({ ...facts, mention: 'ou_alice' }, 'cli_app').markdown.startsWith('<at id=ou_alice></at> 🔎 For you to review: ')).toBe(true);
    // Only an open_id: anything else, an `<at` of its own included, mentions nobody.
    for (const mention of ['on_alice', 'ou_x></at><at id=all', '']) {
      expect(renderTaskCard({ ...facts, mention }, 'cli_app').markdown.startsWith('📋 For you to do: ')).toBe(true);
    }
    // No open_id given, as for a direct message and every redraw: no mention.
    expect(renderTaskCard(facts, 'cli_app').markdown).not.toContain('<at id=ou_');
  });

  it('redraws a card acted on with what happened, and no buttons', () => {
    expect(renderCardOutcome({ taskId: 'k_1', title: `x ${SPOOF}` }, 'Done by Alice.')).toEqual({
      markdown: '**x hi \\<at id=all\\>\\</at\\> team** `k_1`\nDone by Alice.',
      buttons: [],
    });
  });
});
