import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composePrompt, type RunBrief } from '../src/kanban/prompt.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import type { RunRow, TaskRow } from '../src/kanban/types.js';
import { AGENT, NOW, VIA } from './helpers/kanban.js';

beforeEach(() => clearSecrets());
afterEach(() => clearSecrets());

function task(extra: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: 'k_task',
    title: 'Write the parser',
    body: 'Parse the config file.',
    contract: {},
    assignee: { kind: 'role', name: 'implementer' },
    reviewer: null,
    workspace: 'default',
    phase: 'open',
    blockedFrom: null,
    blockKind: null,
    blockReason: null,
    priority: 0,
    idempotencyKey: null,
    failureLimit: null,
    retryOnCrash: 'always',
    maxRuntimeS: null,
    consecutiveFailures: 0,
    consecutiveTransient: 0,
    cooldownUntil: null,
    blockRecurrences: 0,
    strandedNotifiedAt: null,
    createdBy: 'lark:on_alice',
    createdVia: VIA,
    createdAt: NOW,
    closedAt: null,
    createdFromTask: null,
    ...extra,
  };
}

function run(extra: Partial<RunRow> = {}): RunRow {
  return {
    runId: 'r_1',
    taskId: 'k_task',
    attempt: 1,
    kind: 'work',
    assignee: { kind: 'role', name: 'implementer' },
    agentConfig: AGENT,
    workspace: 'default',
    roleMdHash: null,
    sessionId: 's_1',
    seededFromRun: null,
    tokenHash: null,
    outcome: 'crashed',
    summary: null,
    metadata: null,
    reportedCommit: null,
    reportedDirty: null,
    error: 'the agent exited without finishing its turn',
    lastOutput: 'Running the tests now.',
    submissions: 1,
    startedAt: NOW,
    endedAt: NOW + 1,
    ...extra,
  };
}

function brief(extra: Partial<RunBrief> = {}): RunBrief {
  return { kind: 'work', roleMd: undefined, skills: [], task: task(), parents: [], attempts: [], comments: [], children: [], ...extra };
}

/** Where each heading first appears, to check the order. */
function at(prompt: string, heading: string): number {
  const i = prompt.indexOf(heading);
  if (i === -1) throw new Error(`no ${heading} in the prompt`);
  return i;
}

describe('composePrompt', () => {
  it('puts the role, the skills, the protocol, the task and the context in that order', () => {
    const prompt = composePrompt(
      brief({
        roleMd: 'You change code in this repository. Run the tests before you report.\n',
        skills: [{ name: 'testing', description: 'How to test here', dir: '/r/skills/testing', path: '/r/skills/testing/SKILL.md' }],
      }),
    );
    const order = ['# Your role', '# Skills', '# How to work', '# The task', '# Context'].map((h) => at(prompt, h));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(prompt).toContain('You change code in this repository. Run the tests before you report.');
    expect(prompt).toContain('- testing: How to test here (/r/skills/testing/SKILL.md)');
    expect(prompt).toContain('take precedence over them');
  });

  it('leaves out the role and skills a role does not have', () => {
    const prompt = composePrompt(brief());
    expect(prompt).not.toContain('# Your role');
    expect(prompt).not.toContain('# Skills');
    expect(prompt.startsWith('# How to work')).toBe(true);
  });

  it('gives a work run the work protocol, and a review run the review protocol', () => {
    const work = composePrompt(brief());
    expect(work).toContain('mt kanban complete < handoff.json');
    expect(work).toContain('mt kanban review < handoff.json');
    expect(work).toContain('report complete rather than review');
    expect(work).not.toContain('mt kanban changes');
    const review = composePrompt(brief({ kind: 'review', task: task({ phase: 'review' }) }));
    expect(review).toContain('mt kanban changes < reason.json');
    expect(review).toContain('Do not change the workspace.');
  });

  it('gives the task its title, body and contract', () => {
    const prompt = composePrompt(
      brief({ task: task({ contract: { outcome: 'it parses', stop_when: 'the format is unclear' } }) }),
    );
    expect(prompt).toContain('k_task: Write the parser\n\nParse the config file.');
    expect(prompt).toContain('Contract:\n- Outcome: it parses\n- Stop when: the format is unclear');
  });

  it("gives each parent's handoff verbatim, and says when a parent has none", () => {
    const prompt = composePrompt(
      brief({
        parents: [
          { task: task({ taskId: 'k_p1', title: 'Design', phase: 'done' }), summary: 'Use YAML.', metadata: { doc: 'a.md' } },
          { task: task({ taskId: 'k_p2', title: 'Dropped', phase: 'archived' }), summary: null, metadata: null },
        ],
      }),
    );
    expect(prompt).toContain('## Parent k_p1: Design (done)\nSummary: Use YAML.\nMetadata: {"doc":"a.md"}');
    expect(prompt).toContain('## Parent k_p2: Dropped (archived)\nNo handoff: it was never completed.');
  });

  it('tells a retry what the earlier attempt did, its tool calls included', () => {
    const prompt = composePrompt(
      brief({
        attempts: [
          {
            run: run(),
            toolCalls: [
              { toolCallId: 'c1', title: 'edit', status: 'completed' },
              { toolCallId: 'c2', title: 'bash', status: 'failed' },
            ],
          },
          { run: run({ runId: 'r_2', attempt: 2, outcome: 'interrupted', error: null, lastOutput: null }), toolCalls: [] },
        ],
      }),
    );
    expect(prompt).toContain(
      '## Attempt 1 (work, implementer): crashed\nError: the agent exited without finishing its turn\n' +
        'Last output:\nRunning the tests now.\nTool calls:\n- edit (completed)\n- bash (failed)',
    );
    expect(prompt).toContain('## Attempt 2 (work, implementer): interrupted\nTool calls: none');
  });

  it('gives the comment thread and the children', () => {
    const prompt = composePrompt(
      brief({
        comments: [{ id: 1, taskId: 'k_task', author: 'lark:on_alice', body: 'Mind the BOM.', createdAt: NOW }],
        children: [task({ taskId: 'k_review', title: 'Review the parser', assignee: { kind: 'role', name: 'reviewer' } })],
      }),
    );
    expect(prompt).toContain('## Comments\n- lark:on_alice: Mind the BOM.');
    expect(prompt).toContain('## Children\nTasks that wait on this one:\n- k_review: Review the parser (reviewer, open)');
  });

  it('says so when there is no context yet', () => {
    expect(composePrompt(brief())).toContain('# Context\n\nNothing yet');
  });

  it('masks a known secret wherever it is in the task and the context', () => {
    addSecrets(['sk-live-1234567890']);
    const prompt = composePrompt(
      brief({
        task: task({ body: 'use sk-live-1234567890' }),
        comments: [{ id: 1, taskId: 'k_task', author: 'lark:on_alice', body: 'the key is sk-live-1234567890', createdAt: NOW }],
        attempts: [{ run: run({ error: 'auth with sk-live-1234567890 failed' }), toolCalls: undefined }],
      }),
    );
    expect(prompt).not.toContain('sk-live-1234567890');
    expect(prompt).toContain(`use ${MASK}`);
    expect(prompt).toContain(`the key is ${MASK}`);
    expect(prompt).toContain(`Error: auth with ${MASK} failed`);
  });

  it('masks a secret holding a quote inside metadata, before the metadata is serialized', () => {
    addSecrets(['pa"ss-word-1234']);
    const prompt = composePrompt(brief({ attempts: [{ run: run({ metadata: { key: 'pa"ss-word-1234' } }), toolCalls: undefined }] }));
    expect(prompt).not.toContain('ss-word-1234');
    expect(prompt).toContain(`Metadata: {"key":"${MASK}"}`);
  });
});
