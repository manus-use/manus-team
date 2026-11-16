import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DAG_LIMITS,
  canonicalDag,
  checkDagShape,
  checkDagTasks,
  dagFile,
  maskDag,
  readDag,
  type Dag,
  type DagCheck,
  type DagSource,
} from '../src/kanban/dag.js';
import { gateProblem, gatesProblem } from '../src/kanban/gate-command.js';
import type { Role } from '../src/roles.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { role } from './helpers/dispatch.js';
import { ALICE, VIA } from './helpers/kanban.js';

/**
 * The DAG (spec §21.5): its shape, every default, the canonical form and its
 * hash, the sizes, where gates may come from, what a run's DAG may not set, and
 * each task checked as create checks it.
 */

const SECRET = 'sk-live-1234567890';

beforeEach(() => {
  clearSecrets();
  addSecrets([SECRET]);
});
afterEach(() => clearSecrets());

/** The example of §21.5, written out in full, as an expansion writes it. */
function example(): Record<string, unknown> {
  const task = (ref: string, step: string, item: string | null, title: string, parents: string[], extra: Record<string, unknown> = {}) => ({
    ref,
    step,
    item,
    title,
    body: null,
    assignee: 'worker',
    reviewer: null,
    workspace: null,
    priority: 0,
    contract: {},
    failure_limit: null,
    retry_on_crash: 'always',
    max_runtime_s: null,
    parents,
    gates: [],
    ...extra,
  });
  return {
    format: 1,
    workflow: 'vendor-eval',
    params: { topic: 'log storage', vendors: ['acme', 'globex'], reviewer: 'reviewer' },
    board: 'research',
    tasks: [
      task('shortlist', 'shortlist', null, 'Shortlist vendors for log storage', [], { contract: { outcome: 'a shortlist with one line per vendor' } }),
      task('evaluate:1', 'evaluate', 'acme', 'Evaluate acme for log storage', ['shortlist'], {
        gates: [{ command: 'test -s evaluation.md', timeout_s: 30 }],
      }),
      task('evaluate:2', 'evaluate', 'globex', 'Evaluate globex for log storage', ['shortlist'], {
        gates: [{ command: 'test -s evaluation.md', timeout_s: 30 }],
      }),
      task('recommend', 'recommend', null, 'Recommend a vendor for log storage', ['evaluate:1', 'evaluate:2'], {
        reviewer: 'reviewer',
        contract: { verification: "every score comes from a parent's summary" },
      }),
    ],
  };
}

/** The smallest DAG: one task with a ref and a title. */
const tiny = (task: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: 1,
  tasks: [{ ref: 'a', title: 'A task', ...task }],
  ...top,
});

function shaped(raw: unknown, from: DagSource = 'terminal'): Dag {
  const r = checkDagShape(raw, from);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.dag;
}

function refused(raw: unknown, from: DagSource = 'terminal'): { code: string; message: string } {
  const r = checkDagShape(raw, from);
  if (r.ok) throw new Error('the DAG was taken');
  return { code: r.code, message: r.message };
}

const sha = (raw: unknown): string => {
  const r = checkDagShape(raw, 'terminal');
  if (!r.ok) throw new Error(r.message);
  return r.sha256;
};

describe('a DAG, at the top level', () => {
  it('takes the example of the spec, and fills in every default of a task left out', () => {
    expect(shaped(example()).tasks.map((t) => [t.ref, t.parents])).toEqual([
      ['shortlist', []],
      ['evaluate:1', ['shortlist']],
      ['evaluate:2', ['shortlist']],
      ['recommend', ['evaluate:1', 'evaluate:2']],
    ]);
    expect(shaped(tiny())).toEqual({
      format: 1,
      workflow: null,
      params: {},
      board: null,
      tasks: [
        {
          ref: 'a',
          step: 'a',
          item: null,
          title: 'A task',
          body: null,
          assignee: null,
          reviewer: null,
          workspace: null,
          priority: 0,
          contract: {},
          failure_limit: null,
          retry_on_crash: 'always',
          max_runtime_s: null,
          parents: [],
          gates: [],
        },
      ],
    });
  });

  it('reads format 1 alone, and refuses an unknown key naming its place, at each level', () => {
    expect(refused({ tasks: [{ ref: 'a', title: 'A' }] })).toEqual({ code: 'invalid', message: 'a DAG needs its format, 1' });
    expect(refused(tiny({}, { format: 2 }))).toEqual({ code: 'invalid', message: 'the DAG is of format 2; this build reads format 1' });
    expect(refused(tiny({}, { format: '1' }))).toEqual({ code: 'invalid', message: 'the DAG is of format "1"; this build reads format 1' });
    expect(refused(tiny({}, { name: 'x' }))).toEqual({
      code: 'invalid',
      message: 'a DAG takes no key "name" (it takes format, workflow, params, board, tasks)',
    });
    expect(refused(tiny({ colour: 'red' })).message).toBe(
      'tasks[0] takes no key "colour" (it takes ref, step, item, title, body, assignee, reviewer, workspace, priority, contract, failure_limit, retry_on_crash, max_runtime_s, parents, gates)',
    );
    expect(refused(tiny({ contract: { outcome: 'x', colour: 'red' } })).message).toBe(
      'tasks[0] (a).contract takes no key "colour" (it takes outcome, verification, constraints, boundaries, stop_when)',
    );
    expect(refused(tiny({ gates: [{ command: 'true', timeout: 3 }] })).message).toBe(
      'tasks[0] (a).gates[0] takes no key "timeout" (it takes command, timeout_s)',
    );
    expect(refused('[]')).toEqual({ code: 'invalid', message: 'a DAG is a JSON object' });
  });

  it('takes 1 to 100 tasks', () => {
    expect(refused(tiny({}, { tasks: [] })).message).toBe('a DAG has 1 to 100 tasks; this one has 0');
    const many = Array.from({ length: 101 }, (_, i) => ({ ref: `t${i}`, title: `Task ${i}` }));
    expect(refused({ format: 1, tasks: many }).message).toBe('a DAG has 1 to 100 tasks; this one has 101');
    expect(shaped({ format: 1, tasks: many.slice(0, 100) }).tasks).toHaveLength(100);
  });

  it('takes a workflow name or null, a board or null, and params in the param grammar, text or lists of text', () => {
    expect(refused(tiny({}, { workflow: 'Vendor Eval' })).message).toBe("workflow is a workflow's name, or null for a DAG with none");
    expect(refused(tiny({}, { board: 7 })).message).toBe("board is a board's name, or null for the path's own");
    expect(refused(tiny({}, { params: { Topic: 'x' } })).message).toMatch(/^params\."Topic" is not a param name: /);
    expect(refused(tiny({}, { params: { topic: 7 } })).message).toBe('params.topic is text, or a list of text');
    expect(refused(tiny({}, { params: { topic: ['a', 1] } })).message).toBe('params.topic is text, or a list of text');
    expect(shaped(tiny({}, { params: { topic: 'x', vendors: ['a', 'b'] } })).params).toEqual({ topic: 'x', vendors: ['a', 'b'] });
  });

  it('refuses params past 64 KiB together', () => {
    const big = { a: 'x'.repeat(40_000), b: 'y'.repeat(30_000) };
    expect(refused(tiny({}, { params: big }))).toEqual({
      code: 'too_large',
      message: `the params are ${JSON.stringify(big).length} bytes as JSON; at most 65536 together`,
    });
  });

  it('refuses null where a key\'s default is not null, and takes it where it is', () => {
    for (const key of ['step', 'priority', 'contract', 'retry_on_crash', 'parents', 'gates']) {
      expect(refused(tiny({ [key]: null })).message).toBe(`tasks[0] (a).${key} is null; leave it out for its default`);
    }
    expect(refused(tiny({}, { params: null })).message).toBe('params is null; leave it out for its default');
    expect(shaped(tiny({ item: null, body: null, assignee: null, reviewer: null, workspace: null, failure_limit: null, max_runtime_s: null }, { workflow: null, board: null })).tasks[0]?.ref).toBe('a');
  });

  it('refuses a lone surrogate anywhere', () => {
    expect(refused(JSON.parse('{"format": 1, "tasks": [{"ref": "a", "title": "x\\ud800y"}]}'))).toEqual({
      code: 'invalid',
      message: 'tasks[0].title is not well formed text: a lone surrogate, as \\ud800 gives, is no text',
    });
    expect(refused(JSON.parse('{"format": 1, "params": {"topic": ["\\udc00"]}, "tasks": [{"ref": "a", "title": "x"}]}')).message).toMatch(
      /^params\.topic\[0\] is not well formed text/,
    );
  });
});

describe("a DAG's tasks", () => {
  it('needs a ref, unique, of 1 to 64 bytes of its characters, and a title', () => {
    expect(refused(tiny({ ref: undefined })).message).toBe('tasks[0] needs a ref');
    expect(refused(tiny({ ref: 'a b' })).message).toBe("tasks[0].ref is 1 to 64 bytes of letters, digits, '.', '_', ':' and '-'");
    expect(refused(tiny({ ref: 'x'.repeat(65) })).message).toBe("tasks[0].ref is 1 to 64 bytes of letters, digits, '.', '_', ':' and '-'");
    expect(refused(tiny({ ref: '' })).message).toBe("tasks[0].ref is 1 to 64 bytes of letters, digits, '.', '_', ':' and '-'");
    expect(shaped(tiny({ ref: 'A.b_c:1-x'.padEnd(64, 'z') })).tasks[0]?.ref).toHaveLength(64);
    expect(refused({ format: 1, tasks: [{ ref: 'a', title: 'A' }, { ref: 'a', title: 'B' }] }).message).toBe(
      'tasks[1].ref a is the ref of an earlier task too; a ref is unique in a DAG',
    );
    expect(refused(tiny({ title: undefined })).message).toBe('tasks[0] (a) needs a title, as text');
  });

  it('takes its step from its ref when absent, and refuses one of other characters', () => {
    expect(shaped(tiny({ ref: 'evaluate:1' })).tasks[0]?.step).toBe('evaluate:1');
    expect(refused(tiny({ step: 'not a step' })).message).toBe("tasks[0] (a).step is 1 to 64 bytes of letters, digits, '.', '_', ':' and '-'");
  });

  it('names only refs earlier in the array as parents, each once', () => {
    const two = (parents: unknown) => ({ format: 1, tasks: [{ ref: 'a', title: 'A' }, { ref: 'b', title: 'B', parents }] });
    expect(shaped(two(['a'])).tasks[1]?.parents).toEqual(['a']);
    expect(refused(two(['a', 'a'])).message).toBe('tasks[1] (b).parents names "a" twice');
    expect(refused(two(['c'])).message).toBe(
      'tasks[1] (b).parents names "c", which is no ref earlier in the DAG: a parent comes before its child, and is one of the DAG\'s own tasks',
    );
    expect(refused({ format: 1, tasks: [{ ref: 'a', title: 'A', parents: ['b'] }, { ref: 'b', title: 'B' }] }).message).toMatch(
      /^tasks\[0\] \(a\)\.parents names "b", which is no ref earlier/,
    );
    expect(refused(two(['b'])).message).toMatch(/^tasks\[1\] \(b\)\.parents names "b", which is no ref earlier/);
    expect(refused(two('a')).message).toBe('tasks[1] (b).parents is a list of refs');
  });

  it('checks every type', () => {
    expect(refused(tiny({ item: 3 })).message).toBe('tasks[0] (a).item is text, or null');
    expect(refused(tiny({ body: 3 })).message).toBe('tasks[0] (a).body is text, or null');
    expect(refused(tiny({ assignee: ['worker'] })).message).toBe('tasks[0] (a).assignee is text, or null');
    expect(refused(tiny({ priority: 1.5 })).message).toBe('tasks[0] (a).priority is a whole number');
    expect(refused(tiny({ contract: 'x' })).message).toBe('tasks[0] (a).contract is an object of text fields');
    expect(refused(tiny({ contract: { outcome: 3 } })).message).toBe('tasks[0] (a).contract.outcome is text');
    expect(refused(tiny({ failure_limit: '2' })).message).toBe('tasks[0] (a).failure_limit is a whole number, or null');
    expect(refused(tiny({ retry_on_crash: 'never' })).message).toBe('tasks[0] (a).retry_on_crash is always or if-no-side-effects');
    expect(refused(tiny({ gates: [{ command: 3 }] })).message).toBe('tasks[0] (a).gates[0].command is text');
    expect(refused(tiny({ gates: [{ command: 'true', timeout_s: 'x' }] })).message).toBe('tasks[0] (a).gates[0].timeout_s is a whole number of seconds');
    expect(refused(tiny({ item: 'x'.repeat(8 * 1024 + 1) }))).toEqual({ code: 'too_large', message: 'tasks[0] (a).item is 8193 bytes; an item is at most 8192' });
  });

  it('keeps a {{ as text, in a title and a gate', () => {
    const d = shaped(tiny({ title: 'Read {{topic}}', gates: [{ command: 'echo {{x}}' }] }));
    expect(d.tasks[0]).toMatchObject({ title: 'Read {{topic}}', gates: [{ command: 'echo {{x}}', timeout_s: 300 }] });
  });
});

describe('where gates may come from', () => {
  const gated = tiny({ gates: [{ command: 'test -s notes.md', timeout_s: 30 }] });

  it('takes them at the terminal and from an expansion, and refuses them from a run, where an empty list is no gate', () => {
    expect(shaped(gated, 'terminal').tasks[0]?.gates).toEqual([{ command: 'test -s notes.md', timeout_s: 30 }]);
    expect(shaped(gated, 'expansion').tasks[0]?.gates).toHaveLength(1);
    expect(refused(gated, 'run')).toEqual({
      code: 'invalid',
      message:
        "tasks[0] (a) has gates, and apply-dag takes none: a gate is a shell command, and defining one is the operator's; " +
        "a workflow file's gates come with start-workflow",
    });
    expect(shaped(tiny({ gates: [] }), 'run').tasks[0]?.gates).toEqual([]);
  });

  it('refuses a gate command holding the mask, from every path', () => {
    for (const from of ['terminal', 'expansion'] as const) {
      expect(refused(tiny({ gates: [{ command: `curl -H "x: ${MASK}" y` }] }), from)).toEqual({
        code: 'invalid',
        message: `tasks[0] (a).gates[0].command holds the mask ${MASK}: the DAG was printed masked, and a masked command would run broken; write the command out again`,
      });
    }
  });
});

describe("what a run's DAG may not set", () => {
  it('refuses priority, failure_limit, retry_on_crash and max_runtime_s unless at their defaults', () => {
    expect(shaped(tiny({ priority: 0, failure_limit: null, retry_on_crash: 'always', max_runtime_s: null }), 'run').tasks).toHaveLength(1);
    expect(refused(tiny({ priority: 5, retry_on_crash: 'if-no-side-effects' }), 'run').message).toBe(
      'tasks[0] (a) sets priority, retry_on_crash, and apply-dag takes no priority, failure_limit, retry_on_crash or max_runtime_s ' +
        "but at their defaults: they are the operator's, as mt kanban create takes none of them",
    );
    expect(refused(tiny({ failure_limit: 2 }), 'run').message).toMatch(/^tasks\[0\] \(a\) sets failure_limit, and apply-dag/);
    expect(refused(tiny({ max_runtime_s: 60 }), 'run').message).toMatch(/^tasks\[0\] \(a\) sets max_runtime_s, and apply-dag/);
    expect(shaped(tiny({ priority: 5 }), 'terminal').tasks[0]?.priority).toBe(5);
  });

  it('refuses a workflow name, and params unless absent or {}', () => {
    expect(refused(tiny({}, { workflow: 'vendor-eval' }), 'run').message).toBe(
      "apply-dag takes no workflow name: a name would say the operator's file made the instance; start-workflow starts a workflow",
    );
    expect(refused(tiny({}, { params: { topic: 'x' } }), 'run').message).toBe(
      'apply-dag takes no params: they would say a workflow was filled in, where an agent made its tasks',
    );
    expect(shaped(tiny({}, { workflow: null, params: {} }), 'run').workflow).toBeNull();
  });
});

describe('the canonical form', () => {
  it('is the same for a reindented file, reordered keys, and defaults written or left out', () => {
    const full = example();
    const reindented = JSON.parse(JSON.stringify(full, null, 7)) as Record<string, unknown>;
    const reordered = JSON.parse(
      JSON.stringify({ tasks: full['tasks'], board: full['board'], params: { vendors: ['acme', 'globex'], reviewer: 'reviewer', topic: 'log storage' }, workflow: full['workflow'], format: 1 }),
    ) as Record<string, unknown>;
    const sparse = {
      format: 1,
      workflow: 'vendor-eval',
      params: { topic: 'log storage', vendors: ['acme', 'globex'], reviewer: 'reviewer' },
      board: 'research',
      tasks: [
        { ref: 'shortlist', title: 'Shortlist vendors for log storage', assignee: 'worker', contract: { outcome: 'a shortlist with one line per vendor', boundaries: null } },
        { ref: 'evaluate:1', step: 'evaluate', item: 'acme', title: 'Evaluate acme for log storage', assignee: 'worker', body: '', parents: ['shortlist'], gates: [{ command: 'test -s evaluation.md', timeout_s: 30 }] },
        { ref: 'evaluate:2', step: 'evaluate', item: 'globex', title: 'Evaluate globex for log storage', assignee: 'worker', parents: ['shortlist'], gates: [{ timeout_s: 30, command: 'test -s evaluation.md' }] },
        { ref: 'recommend', title: 'Recommend a vendor for log storage', assignee: 'worker', reviewer: 'reviewer', contract: { verification: "every score comes from a parent's summary" }, parents: ['evaluate:1', 'evaluate:2'] },
      ],
    };
    const hash = sha(full);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect([sha(reindented), sha(reordered), sha(sparse)]).toEqual([hash, hash, hash]);
    expect(canonicalDag(shaped(sparse))).toBe(canonicalDag(shaped(full)));
  });

  it('is another for one changed value, and writes the params by name, a contract in its order, compact', () => {
    const changed = example();
    (changed['tasks'] as Array<Record<string, unknown>>)[1]!['title'] = 'Evaluate acme for logs';
    expect(sha(changed)).not.toBe(sha(example()));
    const text = canonicalDag(shaped(tiny({ contract: { stop_when: 's', outcome: 'o' } }, { params: { zeta: 'z', alpha: 'a' } })));
    expect(text).toBe(
      '{"format":1,"workflow":null,"params":{"alpha":"a","zeta":"z"},"board":null,"tasks":[{"ref":"a","step":"a","item":null,"title":"A task",' +
        '"body":null,"assignee":null,"reviewer":null,"workspace":null,"priority":0,"contract":{"outcome":"o","stop_when":"s"},' +
        '"failure_limit":null,"retry_on_crash":"always","max_runtime_s":null,"parents":[],"gates":[]}]}',
    );
  });

  it('is unmasked, and its file form is the same indented by two spaces, a deleted default changing no hash', () => {
    const d = shaped(tiny({ title: `Use ${SECRET}` }));
    expect(canonicalDag(d)).toContain(SECRET);
    const file = dagFile(d);
    expect(file).toBe(JSON.stringify(JSON.parse(canonicalDag(d)), null, 2));
    const edited = JSON.parse(file) as { tasks: Array<Record<string, unknown>> };
    delete edited.tasks[0]!['priority'];
    delete edited.tasks[0]!['gates'];
    delete (edited as Record<string, unknown>)['params'];
    expect(sha(edited)).toBe(sha(JSON.parse(file)));
  });

  it('is measured: 192 KiB from a run, and 1 MiB elsewhere', () => {
    // One task whose body brings the canonical form to exactly `size` bytes.
    const sized = (size: number): Record<string, unknown> => {
      const base = canonicalDag(shaped(tiny({ body: 'x' })));
      return tiny({ body: 'x'.repeat(size - base.length + 1) });
    };
    expect(canonicalDag(shaped(sized(DAG_LIMITS.runBytes)))).toHaveLength(DAG_LIMITS.runBytes);
    expect(checkDagShape(sized(DAG_LIMITS.runBytes), 'run').ok).toBe(true);
    expect(refused(sized(DAG_LIMITS.runBytes + 1), 'run')).toEqual({
      code: 'too_large',
      message: `the DAG is ${DAG_LIMITS.runBytes + 1} bytes in its canonical form; it may be at most ${DAG_LIMITS.runBytes} from a run`,
    });
    expect(checkDagShape(sized(DAG_LIMITS.runBytes + 1), 'terminal').ok).toBe(true);
    expect(checkDagShape(sized(DAG_LIMITS.bytes), 'expansion').ok).toBe(true);
    expect(refused(sized(DAG_LIMITS.bytes + 1), 'terminal')).toEqual({
      code: 'too_large',
      message: `the DAG is ${DAG_LIMITS.bytes + 1} bytes in its canonical form; it may be at most ${DAG_LIMITS.bytes}`,
    });
  });
});

describe('readDag', () => {
  it('parses JSON, refusing what is not, a byte order mark included', () => {
    expect(readDag(JSON.stringify(tiny()), 'terminal').ok).toBe(true);
    expect(readDag('{"format": 1,', 'terminal')).toEqual({ ok: false, code: 'invalid', message: 'the DAG is not JSON' });
    expect(readDag(`\uFEFF${JSON.stringify(tiny())}`, 'terminal')).toEqual({ ok: false, code: 'invalid', message: 'the DAG is not JSON' });
  });
});

describe('maskDag', () => {
  it('masks every text but the gates, and keeps the names', () => {
    const d = shaped(
      tiny(
        { title: `T ${SECRET}`, body: SECRET, item: SECRET, contract: { outcome: SECRET }, assignee: 'worker', gates: [{ command: 'echo $TOKEN' }] },
        { params: { topic: SECRET, vendors: [SECRET, 'acme'] } },
      ),
    );
    expect(maskDag(d)).toEqual({
      ...d,
      params: { topic: MASK, vendors: [MASK, 'acme'] },
      tasks: [{ ...d.tasks[0], title: `T ${MASK}`, body: MASK, item: MASK, contract: { outcome: MASK } }],
    });
  });
});

describe('checkDagTasks', () => {
  const ROLES: ReadonlyMap<string, Role> = new Map([
    ['worker', role('worker')],
    ['reviewer', role('reviewer')],
    ['web-dev', role('web-dev', { workspace: 'web' })],
    ['api-dev', role('api-dev', { workspace: 'api' })],
    ['watched', role('watched', { agent: { ...role('watched').agent, unsupervised: false } })],
  ]);
  const check = (extra: Partial<DagCheck> = {}): DagCheck => ({
    facts: { roles: ROLES, workspaces: new Set(['default', 'web', 'api']), supervisedRoles: false, canTalk: (p) => p === 'lark:on_bob' },
    createdBy: ALICE,
    createdVia: VIA,
    ...extra,
  });
  const problem = (raw: unknown, extra: Partial<DagCheck> = {}) => checkDagTasks(shaped(raw), check(extra));

  it('takes the example, and refuses the whole DAG at its first failing task, naming its ref, step and item', () => {
    expect(problem(example())).toBeUndefined();
    const bad = example();
    (bad['tasks'] as Array<Record<string, unknown>>)[2]!['assignee'] = 'evaluator';
    expect(problem(bad)).toEqual({ ok: false, code: 'unknown_role', message: 'evaluate:2, step evaluate, item "globex": role "evaluator" is not configured' });
  });

  it('checks every field as create checks it', () => {
    expect(problem(tiny({ assignee: 'watched' }))).toMatchObject({ code: 'supervised_role' });
    expect(problem(tiny({ workspace: 'nowhere' }))).toEqual({ ok: false, code: 'unknown_workspace', message: 'a: workspace "nowhere" is not configured' });
    expect(problem(tiny({ reviewer: 'lark:on_eve' }))).toMatchObject({ code: 'person_not_assignable' });
    expect(problem(tiny({ reviewer: 'lark:on_bob' }))).toBeUndefined();
    expect(problem(tiny({ title: '  ' }))).toEqual({ ok: false, code: 'invalid', message: 'a: a task needs a title' });
    expect(problem(tiny({ failure_limit: 0 }))).toEqual({
      ok: false,
      code: 'invalid',
      message: 'a: priority must be a whole number, and failure_limit and max_runtime_s at least 1',
    });
  });

  it('refuses any person at the terminal', () => {
    expect(problem(tiny({ assignee: 'lark:on_bob' }), { createdVia: { kind: 'operator' }, createdBy: 'operator:me' })).toEqual({
      ok: false,
      code: 'person_not_assignable',
      message: 'a: "lark:on_bob" is a person: give a person work from chat, by @-mention, where the gateway can check they have talk tier',
    });
  });

  it("holds a title to one line and task new's sizes", () => {
    expect(problem(tiny({ title: 'Two\nlines' }))).toEqual({ ok: false, code: 'invalid', message: 'a: its title is one line, with no control characters and no bidi controls' });
    expect(problem(tiny({ title: 'Mixed \u202Eup' }))).toMatchObject({ code: 'invalid' });
    expect(problem(tiny({ title: 'x'.repeat(513) }))).toEqual({ ok: false, code: 'too_large', message: 'a: its title is 513 bytes; at most 512' });
    expect(problem(tiny({ body: 'x'.repeat(64 * 1024 + 1) }))).toMatchObject({ code: 'too_large', message: 'a: its body is 65537 bytes; at most 65536' });
    expect(problem(tiny({ contract: { outcome: 'x'.repeat(8193) } }))).toMatchObject({ code: 'too_large', message: "a: its contract's outcome is 8193 bytes; at most 8192" });
  });

  it('refuses a ref or a step holding a known secret, without quoting it', () => {
    addSecrets(['secretref12345']);
    expect(problem(tiny({ ref: 'secretref12345' }))).toEqual({
      ok: false,
      code: 'invalid',
      message: 'tasks[0]: its ref or its step holds a known secret, and a ref is stored and shown as written',
    });
    expect(problem(tiny({ step: 'secretref12345' }))?.message).toBe('tasks[0]: its ref or its step holds a known secret, and a ref is stored and shown as written');
  });

  it('refuses a name or an item holding a known secret', () => {
    expect(problem(tiny({ workspace: SECRET }))).toEqual({ ok: false, code: 'invalid', message: 'a: its workspace holds a known secret, and a name is stored as written' });
    expect(problem(tiny({ item: `acme ${SECRET}` }))?.message).toBe(
      `a, item "acme ${MASK}": its item holds a known secret: an item labels its task, and two differing only in a secret would be one label`,
    );
  });

  it('checks each gate as addGate would, a gate with no timeout counted as 300 s', () => {
    expect(problem(tiny({ gates: [{ command: `curl ${SECRET}` }] }))?.message).toBe(
      "a: its gates[0].command holds a known secret, and a gate is stored and run as written: pass the value through the role's environment and name it in the command, as $NAME",
    );
    expect(problem(tiny({ gates: [{ command: 'true', timeout_s: 601 }] }))?.message).toBe(
      "a: its gates[0].command has a timeout of 601 s; a gate's timeout is a whole number of seconds, from 1 to 600",
    );
    expect(problem(tiny({ gates: [{ command: 'a\0b' }] }))?.message).toBe('a: its gates[0].command holds a NUL, which no command can');
    expect(problem(tiny({ gates: [{ command: 'x'.repeat(4097) }] }))?.message).toBe('a: its gates[0].command is 4097 bytes; a gate command may be at most 4096');
    expect(problem(tiny({ gates: [{ command: 'one' }, { command: 'two' }, { command: 'three' }] }))?.message).toBe(
      'a: it has gates that would take up to 900 s together; at most 600 s, since a report waits for them',
    );
    expect(problem(tiny({ gates: Array.from({ length: 21 }, () => ({ command: 'true', timeout_s: 1 })) }))?.message).toBe(
      'a: it has 21 gates; a task may have at most 20',
    );
    expect(problem(tiny({ gates: [{ command: 'one' }, { command: 'two' }] }))).toBeUndefined();
  });

  it("refuses a task whose parents certainly work in different workspaces, and judges no parent whose workspace is decided later", () => {
    const fan = (child: Record<string, unknown>, second: Record<string, unknown> = { assignee: 'api-dev' }) => ({
      format: 1,
      tasks: [
        { ref: 'web', title: 'Web', assignee: 'web-dev' },
        { ref: 'api', title: 'API', ...second },
        { ref: 'join', title: 'Join', assignee: 'worker', parents: ['web', 'api'], ...child },
      ],
    });
    expect(problem(fan({}))).toEqual({
      ok: false,
      code: 'invalid',
      message: 'join: its parents work in different workspaces, web and api, and it names none, nor does its role: it could not be given one at its claim; set its workspace',
    });
    expect(problem(fan({ workspace: 'web' }))).toBeUndefined();
    expect(problem(fan({ assignee: 'web-dev' }))).toBeUndefined();
    expect(problem(fan({}, { assignee: 'worker' }))).toBeUndefined();
    expect(problem(fan({}, { assignee: 'worker', workspace: 'web' }))).toBeUndefined();
  });
});

describe('gateProblem and gatesProblem', () => {
  it('are undefined for a gate addGate would take', () => {
    expect(gateProblem({ command: 'npm test', timeoutS: 300 })).toBeUndefined();
    expect(gatesProblem([{ timeoutS: 300 }, { timeoutS: 300 }])).toBeUndefined();
    expect(gateProblem({ command: '   ', timeoutS: 30 })).toBe('is a command, and this one is blank');
  });
});
