import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { createBoard } from '../src/db/kanban.js';
import { getTask, parentsOf } from '../src/db/kanban-read.js';
import { DAG_LIMITS, canonicalDag, checkDagShape } from '../src/kanban/dag.js';
import { briefFor } from '../src/kanban/brief.js';
import { composePrompt } from '../src/kanban/prompt.js';
import { KanbanService } from '../src/kanban/service.js';
import { hashToken, mintToken } from '../src/kanban/token.js';
import type { RunRow } from '../src/kanban/types.js';
import { WorkerApi, type WorkerResponse } from '../src/kanban/worker.js';
import { clearSecrets } from '../src/secrets.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, NOW, VIA } from './helpers/kanban.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * The worker's workflow commands (workflows spec §6): `start-workflow`, its schema, its
 * answer and `unknown_workflow`; `apply-dag`, its own two keys taken off before
 * the DAG is checked, its dry run, and what a run's DAG may not hold; `mt kanban
 * apply-dag`'s own 192 KiB check; and `mt kanban workflow` refused in a run's
 * shell, naming them.
 */

let t: TestDb;
let service: KanbanService;
let api: WorkerApi;
let changes: number;
let ask: (command: string, input?: unknown) => Promise<WorkerResponse>;
let planner: string;
let runId: string;
let plannerRun: RunRow;

beforeEach(() => {
  clearSecrets();
  t = testDb();
  const dir = join(t.dir, 'workflows');
  mkdirSync(dir);
  writeFileSync(join(dir, 'vendor-eval.yaml'), VENDOR_EVAL);
  service = new KanbanService({
    db: t.db,
    roles: new Map([['worker', role('worker')], ['reviewer', role('reviewer')], ['planner', role('planner')]]),
    workspaces: new Set(['default']),
    clock: new ManualClock(),
    supervisedRoles: true,
    workflowsDir: dir,
  });
  changes = 0;
  api = new WorkerApi({ db: t.db, service, changed: () => (changes += 1) });
  const task = service.create({ title: 'Plan the work', assignee: 'planner', createdBy: ALICE, createdVia: VIA });
  if (!task.ok) throw new Error(task.message);
  planner = task.task.taskId;
  const token = mintToken();
  const claimed = service.claim(planner, { tokenHash: hashToken(token) });
  if (!claimed.ok) throw new Error(claimed.message);
  runId = claimed.run.runId;
  plannerRun = claimed.run;
  ask = (command, input = {}) => api.handle({ run: runId, token, command, input });
});
afterEach(() => {
  clearSecrets();
  t.close();
});

describe('start-workflow', () => {
  it("starts a workflow on its task's board, created from its task, answering each task with its ref, and tells the dispatcher once", async () => {
    const r = await ask('start-workflow', { workflow: 'vendor-eval', params: { topic: 'logs', vendors: ['acme'] }, idempotency_key: 'ls-1' });
    expect(r).toEqual({
      ok: true,
      instance_id: expect.stringMatching(/^w_/),
      existing: false,
      board: 'default',
      tasks: [
        { task_id: expect.stringMatching(/^k_/), ref: 'shortlist', step: 'shortlist', item: null },
        { task_id: expect.stringMatching(/^k_/), ref: 'evaluate:1', step: 'evaluate', item: 'acme' },
        { task_id: expect.stringMatching(/^k_/), ref: 'recommend', step: 'recommend', item: null },
      ],
    });
    expect(changes).toBe(1);
    const tasks = (r as unknown as { tasks: Array<{ task_id: string }> }).tasks;
    for (const x of tasks) expect(getTask(t.db, x.task_id)?.createdFromTask).toBe(planner);
    expect(await ask('start-workflow', { workflow: 'vendor-eval', params: { topic: 'logs', vendors: ['acme'] }, idempotency_key: 'ls-1' })).toMatchObject({
      ok: true,
      existing: true,
      instance_id: (r as unknown as { instance_id: string }).instance_id,
    });
    const follow = await ask('create', { title: 'After the plan', body: '', assignee: 'worker' });
    expect(follow.ok).toBe(true);
    expect(await ask('link', { parent_id: tasks[2]?.task_id, child_id: (follow as unknown as { task_id: string }).task_id })).toEqual({ ok: true, added: true });
  });

  it('takes workflow, params and idempotency_key alone, each of its type, params absent as {}', async () => {
    expect(await ask('start-workflow', { workflow: 'vendor-eval', board: 'x' })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'start-workflow takes no field "board" (it takes workflow, params, idempotency_key)',
    });
    expect(await ask('start-workflow', {})).toEqual({ ok: false, code: 'invalid', message: 'start-workflow needs workflow, as text' });
    expect(await ask('start-workflow', { workflow: 'vendor-eval', params: { topic: 3 } })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'params is an object of text and lists of text',
    });
    expect(await ask('start-workflow', { workflow: 'vendor-eval', params: { topic: 'x'.repeat(70_000) } })).toMatchObject({ ok: false, code: 'too_large' });
    expect(await ask('start-workflow', { workflow: 'vendor-eval' })).toEqual({ ok: false, code: 'invalid', message: 'workflow vendor-eval needs param topic: what is being bought' });
    expect(await ask('start-workflow', { workflow: 'vendor-eval', params: { topic: ['x'], vendors: ['a'] } })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'param topic is text: give it as text',
    });
  });

  it('refuses an unknown workflow as unknown_workflow, naming the usable ones and their params', async () => {
    expect(await ask('start-workflow', { workflow: 'vendor' })).toEqual({
      ok: false,
      code: 'unknown_workflow',
      message: 'there is no workflow vendor; the usable ones are vendor-eval; their params: vendor-eval takes topic (required), vendors (list, required), reviewer (default reviewer)',
    });
  });
});

/** Every instance's DAG hash, read from the table: what no answer may hold. */
const hashes = (): string[] => (t.db.prepare('SELECT dag_sha256 AS h FROM kanban_workflow_instances').all() as Array<{ h: string }>).map((r) => r.h);

describe("the answers' DAG hash", () => {
  it('is in no answer of start-workflow or apply-dag, a repeat and a dry run included', async () => {
    const answers = [
      await ask('start-workflow', { workflow: 'vendor-eval', params: { topic: 'logs', vendors: ['acme'] }, idempotency_key: 's' }),
      await ask('start-workflow', { workflow: 'vendor-eval', params: { topic: 'logs', vendors: ['acme'] }, idempotency_key: 's' }),
      await ask('apply-dag', { format: 1, tasks: [{ ref: 'a', title: 'A', assignee: 'worker' }], idempotency_key: 'd' }),
      await ask('apply-dag', { format: 1, tasks: [{ ref: 'a', title: 'A', assignee: 'worker' }], idempotency_key: 'd' }),
      await ask('apply-dag', { format: 1, tasks: [{ ref: 'a', title: 'A', assignee: 'worker' }], idempotency_key: 'd', dry_run: true }),
    ];
    expect(hashes()).toHaveLength(2);
    for (const a of answers) {
      expect(a.ok).toBe(true);
      const text = JSON.stringify(a);
      expect(text).not.toMatch(/sha256/i);
      for (const h of hashes()) expect(text).not.toContain(h);
    }
  });
});

describe('apply-dag', () => {
  const graph = {
    format: 1,
    tasks: [
      { ref: 'research', title: 'Research the options', assignee: 'worker' },
      { ref: 'a', title: 'Try A', assignee: 'worker', parents: ['research'] },
      { ref: 'b', title: 'Try B', assignee: 'worker', parents: ['research'] },
      { ref: 'compare', title: 'Compare A and B', assignee: 'worker', parents: ['a', 'b'] },
      { ref: 'write', title: 'Write it up', assignee: 'worker', parents: ['compare'] },
    ],
  };

  it('makes the graph all at once, answering each task with its ref, its key taken off before the DAG is checked', async () => {
    const r = await ask('apply-dag', { ...graph, idempotency_key: 'g-1' });
    expect(r).toMatchObject({ ok: true, existing: false, board: 'default' });
    const tasks = (r as unknown as { tasks: Array<{ task_id: string; ref: string }> }).tasks;
    expect(tasks.map((x) => x.ref)).toEqual(['research', 'a', 'b', 'compare', 'write']);
    expect(parentsOf(t.db, tasks[3]?.task_id ?? '').map((p) => p.taskId).sort()).toEqual([tasks[1]?.task_id, tasks[2]?.task_id].sort());
    expect(changes).toBe(1);
    expect(await ask('apply-dag', { ...graph, idempotency_key: 'g-1' })).toMatchObject({ ok: true, existing: true, instance_id: (r as unknown as { instance_id: string }).instance_id });
  });

  it('with dry_run checks it and makes nothing, answering dry_run with no instance id, or the instance its key made', async () => {
    const dry = await ask('apply-dag', { ...graph, dry_run: true });
    expect(dry).toEqual({
      ok: true,
      dry_run: true,
      existing: false,
      board: 'default',
      tasks: graph.tasks.map((x) => ({ ref: x.ref, step: x.ref, item: null, gates: [] })),
    });
    expect(changes).toBe(0);
    expect(t.db.prepare('SELECT count(*) AS n FROM kanban_workflow_instances').get()).toEqual({ n: 0 });
    expect(await ask('apply-dag', { ...graph, dry_run: true, tasks: [{ ref: 'x', title: 'X', assignee: 'ghost' }] })).toEqual({
      ok: false,
      code: 'unknown_role',
      message: 'x: role "ghost" is not configured',
    });
    const made = await ask('apply-dag', { ...graph, idempotency_key: 'g' });
    expect(await ask('apply-dag', { ...graph, idempotency_key: 'g', dry_run: true })).toMatchObject({
      ok: true,
      dry_run: true,
      existing: true,
      instance_id: (made as unknown as { instance_id: string }).instance_id,
    });
    expect(await ask('apply-dag', { ...graph, dry_run: 'yes' })).toEqual({ ok: false, code: 'invalid', message: 'dry_run is true or false' });
  });

  it("refuses gates, a setting create does not take, a workflow name, params, and another board", async () => {
    const one = (task: Record<string, unknown>, top: Record<string, unknown> = {}) => ask('apply-dag', { format: 1, tasks: [{ ref: 'a', title: 'A', assignee: 'worker', ...task }], ...top });
    expect(await one({ gates: [{ command: 'npm test' }] })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/apply-dag takes none/) });
    expect(await one({ max_runtime_s: 60 })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/^tasks\[0\] \(a\) sets max_runtime_s/) });
    expect(await one({}, { workflow: 'vendor-eval' })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/^apply-dag takes no workflow name/) });
    expect(await one({}, { params: { topic: 'x' } })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/^apply-dag takes no params/) });
    createBoard(t.db, 'research', ALICE, NOW);
    expect(await one({}, { board: 'research' })).toEqual({ ok: false, code: 'other_board', message: "the DAG is for board research, and a run's work stays on its task's board, default" });
    expect(await one({}, { colour: 'red' })).toEqual({ ok: false, code: 'invalid', message: 'a DAG takes no key "colour" (it takes format, workflow, params, board, tasks)' });
    expect(await one({}, { idempotency_key: 7 })).toEqual({ ok: false, code: 'invalid', message: 'idempotency_key is text, of at most 256 bytes' });
    expect(changes).toBe(0);
  });
});

describe('the work protocol', () => {
  it('names start-workflow and apply-dag, saying apply-dag takes no gates', () => {
    const task = getTask(t.db, planner);
    if (task === undefined) throw new Error('no task');
    const prompt = composePrompt(briefFor(t.db, { run: plannerRun, task, roleMd: undefined, role: undefined }));
    expect(prompt).toContain('`mt kanban start-workflow < start.json`, with {"workflow": "...", "params": {...}}');
    expect(prompt).toContain('`mt kanban apply-dag < dag.json`');
    expect(prompt).toContain('makes a graph of tasks at once, all or none; it takes no gates.');
    expect(prompt).toContain('or start a workflow for it with `mt kanban start-workflow`, or make a graph of tasks at once with `mt kanban apply-dag`.');
  });
});

describe('mt kanban apply-dag and mt kanban workflow in a run\'s shell', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mt-wf-worker-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function mt(argv: string[], stdin = '') {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMt(argv, {
      env: { MT_KANBAN_RUN: 'r_1', MT_KANBAN_TOKEN: 'tok', MT_KANBAN_SOCKET: join(root, 'none.sock'), HOME: root },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      stdinIsTTY: false,
      stdin: async (max) => (Buffer.byteLength(stdin) > max ? undefined : Buffer.from(stdin)),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('refuses a DAG over 192 KiB in its canonical form before sending it, and sends one within it', async () => {
    const base = { format: 1, tasks: [{ ref: 'a', title: 'A', body: 'x' }] };
    const shaped = checkDagShape(base, 'terminal');
    if (!shaped.ok) throw new Error(shaped.message);
    const pad = DAG_LIMITS.runBytes - canonicalDag(shaped.dag).length + 1;
    const over = { ...base, tasks: [{ ref: 'a', title: 'A', body: 'x'.repeat(pad + 1) }], dry_run: true };
    const r = await mt(['kanban', 'apply-dag'], JSON.stringify(over));
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({
      ok: false,
      code: 'too_large',
      message: `the DAG is ${DAG_LIMITS.runBytes + 1} bytes in its canonical form; it may be at most ${DAG_LIMITS.runBytes} from a run`,
    });
    const within = await mt(['kanban', 'apply-dag'], JSON.stringify({ ...over, tasks: [{ ref: 'a', title: 'A', body: 'x'.repeat(pad) }] }));
    expect(JSON.parse(within.out)).toMatchObject({ ok: false, code: 'unreachable' });
  });

  it('refuses mt kanban workflow, naming start-workflow and apply-dag', async () => {
    const r = await mt(['kanban', 'workflow', 'start', 'vendor-eval', '--param', 'topic=x']);
    expect(r).toEqual({
      code: 1,
      out: '',
      err:
        "mt: mt kanban workflow start is an operator's command, not an agent's; this shell has MT_KANBAN_RUN set. " +
        'Run it from your own shell; a board run starts a workflow with mt kanban start-workflow, and makes a DAG of its own with mt kanban apply-dag',
    });
    const json = await mt(['kanban', 'workflow', 'apply', 'dag.json', '--json']);
    expect(JSON.parse(json.out)).toMatchObject({ ok: false, code: 'operator_command' });
    // A preview's stdout is a DAG file: its refusal goes to stderr, with --json too.
    const preview = await mt(['kanban', 'workflow', 'preview', 'vendor-eval', '--param', 'topic=x', '--json']);
    expect(preview).toMatchObject({ code: 1, out: '', err: expect.stringMatching(/^mt: mt kanban workflow preview is an operator's command, not an agent's/) });
  });
});
