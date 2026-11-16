import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalDag, checkDagShape, type Dag } from '../src/kanban/dag.js';
import type { Result } from '../src/kanban/types.js';
import { checkWorkflow, expand, paramValues, type GivenParams, type Workflow, type WorkflowFacts } from '../src/kanban/workflow.js';
import type { Role } from '../src/roles.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { role } from './helpers/dispatch.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * A workflow's params and its expansion into a DAG (spec §21.2, §21.3, §21.5):
 * each path's params, the defaults, the sizes, substitution once in every text
 * field, names checked as names, @ resolved only for a person field, for_each,
 * all to all, and the hundred tasks.
 */

const ROLES: ReadonlyMap<string, Role> = new Map([
  ['worker', role('worker')],
  ['reviewer', role('reviewer')],
]);
const FACTS: WorkflowFacts = { roles: ROLES, workspaces: new Set(['default', 'web']), supervisedRoles: false };
const SECRET = 'sk-live-1234567890';

beforeEach(() => {
  clearSecrets();
  addSecrets([SECRET]);
});
afterEach(() => clearSecrets());

function workflow(text: string, name = 'test'): Workflow {
  const r = checkWorkflow(name, text, FACTS);
  if (!r.ok) throw new Error(r.problem);
  return r.workflow;
}

const vendorEval = (): Workflow => workflow(VENDOR_EVAL, 'vendor-eval');
const json = (params: unknown): GivenParams => ({ from: 'json', params });
const chat = (...pairs: Array<[string, string, boolean?]>): GivenParams => ({
  from: 'chat',
  pairs: pairs.map(([key, value, quoted]) => ({ key, value, quoted: quoted === true })),
});
const terminal = (...pairs: Array<[string, string]>): GivenParams => ({ from: 'terminal', pairs: pairs.map(([key, value]) => ({ key, value })) });

function dagOf(r: Result<{ dag: Dag }>): Dag {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.dag;
}

const refusal = (r: Result<object>): { code: string; message: string } | undefined => (r.ok ? undefined : { code: r.code, message: r.message });

describe('the expansion of the example', () => {
  it('makes the DAG of the spec, every key written, its params with their default', () => {
    const dag = dagOf(expand(vendorEval(), json({ topic: 'log storage', vendors: ['acme', 'globex'] }), 'research'));
    expect(dag).toEqual({
      format: 1,
      workflow: 'vendor-eval',
      params: { topic: 'log storage', vendors: ['acme', 'globex'], reviewer: 'reviewer' },
      board: 'research',
      tasks: [
        {
          ref: 'shortlist',
          step: 'shortlist',
          item: null,
          title: 'Shortlist vendors for log storage',
          body: null,
          assignee: 'worker',
          reviewer: null,
          workspace: null,
          priority: 0,
          contract: { outcome: 'a shortlist with one line per vendor' },
          failure_limit: null,
          retry_on_crash: 'always',
          max_runtime_s: null,
          parents: [],
          gates: [],
        },
        expect.objectContaining({ ref: 'evaluate:1', step: 'evaluate', item: 'acme', title: 'Evaluate acme for log storage', parents: ['shortlist'], gates: [{ command: 'test -s evaluation.md', timeout_s: 30 }] }),
        expect.objectContaining({ ref: 'evaluate:2', step: 'evaluate', item: 'globex', title: 'Evaluate globex for log storage', parents: ['shortlist'] }),
        expect.objectContaining({
          ref: 'recommend',
          item: null,
          reviewer: 'reviewer',
          parents: ['evaluate:1', 'evaluate:2'],
          contract: { verification: "every score comes from a parent's summary" },
        }),
      ],
    });
    expect(checkDagShape(dag, 'expansion').ok).toBe(true);
  });

  it('writes a DAG whose canonical form is the same twice', () => {
    const once = dagOf(expand(vendorEval(), json({ topic: 'x', vendors: ['a'] }), 'default'));
    const twice = dagOf(expand(vendorEval(), json({ vendors: ['a'], topic: 'x' }), 'default'));
    expect(canonicalDag(twice)).toBe(canonicalDag(once));
  });
});

describe('the params', () => {
  it('refuses a missing required one, an unknown one, and fills in a default', () => {
    expect(refusal(expand(vendorEval(), json({ vendors: ['a'] }), 'default'))).toEqual({
      code: 'invalid',
      message: 'workflow vendor-eval needs param topic: what is being bought',
    });
    expect(refusal(expand(vendorEval(), json({ topic: 'x', vendors: ['a'], topik: 'y' }), 'default'))).toEqual({
      code: 'invalid',
      message: 'workflow vendor-eval takes no param "topik" (it takes topic, vendors, reviewer)',
    });
    expect(dagOf(expand(vendorEval(), json({ topic: 'x', vendors: ['a'], reviewer: 'worker' }), 'default')).tasks.at(-1)?.reviewer).toBe('worker');
  });

  it("refuses a run's JSON of the wrong type", () => {
    expect(refusal(expand(vendorEval(), json({ topic: ['x'], vendors: ['a'] }), 'default'))?.message).toBe('param topic is text: give it as text');
    expect(refusal(expand(vendorEval(), json({ topic: 'x', vendors: 'a, b' }), 'default'))?.message).toBe('param vendors is a list: give a list of text');
    expect(refusal(expand(vendorEval(), json(['x']), 'default'))?.message).toBe('params is an object of text and lists of text');
  });

  it('reads chat\'s pairs: a list by commas and by repeating, a quoted value as one item, a text param once', () => {
    const w = vendorEval();
    expect(dagOf(expand(w, chat(['topic', 'x'], ['vendors', 'acme, globex'], ['vendors', 'initech']), 'default')).params['vendors']).toEqual([
      'acme',
      'globex',
      'initech',
    ]);
    expect(dagOf(expand(w, chat(['topic', 'x'], ['vendors', 'Acme, Inc', true], ['vendors', 'globex']), 'default')).params['vendors']).toEqual([
      'Acme, Inc',
      'globex',
    ]);
    expect(refusal(expand(w, chat(['topic', 'x'], ['topic', 'y'], ['vendors', 'a']), 'default'))?.message).toBe('param topic is given twice; it takes one value');
  });

  it("splits the terminal's list at every comma, and adds a repeated key's items", () => {
    const dag = dagOf(expand(vendorEval(), terminal(['topic', 'a, b'], ['vendors', 'acme,globex'], ['vendors', 'initech']), 'default'));
    expect(dag.params).toMatchObject({ topic: 'a, b', vendors: ['acme', 'globex', 'initech'] });
  });

  it('refuses an empty list, an empty item, an item twice, and an item holding a known secret', () => {
    const w = vendorEval();
    expect(refusal(expand(w, json({ topic: 'x', vendors: [] }), 'default'))?.message).toBe(
      'param vendors is an empty list, and a step over it would make no tasks',
    );
    expect(refusal(expand(w, chat(['topic', 'x'], ['vendors', 'acme,,globex']), 'default'))?.message).toBe('param vendors has an empty item');
    expect(refusal(expand(w, chat(['topic', 'x'], ['vendors', 'acme, acme ']), 'default'))?.message).toBe(
      'param vendors names "acme" twice; each item labels its task',
    );
    expect(refusal(expand(w, json({ topic: 'x', vendors: [`acme ${SECRET}`] }), 'default'))?.message).toBe('an item of param vendors holds a known secret');
  });

  it('holds a value to 8 KiB, a list to 100 items, and the params to 64 KiB together', () => {
    const w = vendorEval();
    expect(refusal(expand(w, json({ topic: 'x'.repeat(8193), vendors: ['a'] }), 'default'))).toEqual({
      code: 'too_large',
      message: 'param topic is 8193 bytes; at most 8192',
    });
    expect(refusal(expand(w, json({ topic: 'x', vendors: Array.from({ length: 101 }, (_, i) => `v${i}`) }), 'default'))).toEqual({
      code: 'too_large',
      message: 'param vendors has 101 items; a list has at most 100',
    });
    expect(refusal(expand(w, json({ topic: 'x', vendors: ['y'.repeat(8193)] }), 'default'))).toEqual({
      code: 'too_large',
      message: 'an item of param vendors is 8193 bytes; at most 8192',
    });
    const wide = workflow(
      `params:\n${Array.from({ length: 9 }, (_, i) => `  p${i}: { required: true }`).join('\n')}\nsteps:\n  a: { title: A }\n`,
    );
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`p${i}`, 'z'.repeat(8000)]));
    expect(refusal(expand(wide, json(nine), 'default'))).toEqual({
      code: 'too_large',
      message: `the params are ${JSON.stringify(nine).length} bytes as JSON; at most 65536 together`,
    });
    for (const via of [chat(...Object.entries(nine).map(([k, v]): [string, string] => [k, v])), terminal(...Object.entries(nine))]) {
      expect(refusal(expand(wide, via, 'default'))?.code).toBe('too_large');
    }
  });

  it('refuses a line break, a control character or a bidi control in a value that lands in a title, and takes one in a body', () => {
    const w = vendorEval();
    for (const bad of ['two\nlines', 'tab\there', 'bell\u0007', 'flip\u202Eit']) {
      expect(refusal(expand(w, json({ topic: bad, vendors: ['a'] }), 'default'))).toEqual({
        code: 'invalid',
        message: 'param topic lands in a title, which is one line: it may hold no line break, control character or bidi control',
      });
    }
    expect(refusal(expand(w, json({ topic: 'x', vendors: ['two\nlines'] }), 'default'))?.message).toMatch(/^param vendors lands in a title/);
    const bodied = workflow('params:\n  notes: { required: true }\nsteps:\n  a: { title: A, body: "{{notes}}" }\n');
    expect(dagOf(expand(bodied, json({ notes: 'two\nlines' }), 'default')).tasks[0]?.body).toBe('two\nlines');
  });

  it('refuses a lone surrogate in a value', () => {
    expect(refusal(expand(vendorEval(), json(JSON.parse('{"topic": "x\\ud800", "vendors": ["a"]}')), 'default'))?.message).toBe(
      'param topic is not well formed text: a lone surrogate is no text',
    );
  });
});

describe('substitution', () => {
  const every = `params:
  topic: { required: true }
  vendors: { list: true, required: true }
steps:
  a:
    title: "T {{topic}}"
    body: "B {{topic}} among {{vendors}}"
    outcome: "O {{topic}}"
    verify: "V {{topic}}"
    constraints: "C {{topic}}"
    boundaries: "Bd {{topic}}"
    stop_when: "S {{topic}}"
`;

  it('fills every text field, a list joined by commas, once: a value holding {{ is left as written', () => {
    const dag = dagOf(expand(workflow(every), json({ topic: '{{vendors}}', vendors: ['acme', 'globex'] }), 'default'));
    expect(dag.tasks[0]).toMatchObject({
      title: 'T {{vendors}}',
      body: 'B {{vendors}} among acme, globex',
      contract: {
        outcome: 'O {{vendors}}',
        verification: 'V {{vendors}}',
        constraints: 'C {{vendors}}',
        boundaries: 'Bd {{vendors}}',
        stop_when: 'S {{vendors}}',
      },
    });
  });

  it('puts a name in a name field, checked as a name, and never a part of one', () => {
    const named = workflow(`params:
  who: { default: worker }
  where: { default: web }
steps:
  a: { title: A, assignee: "{{who}}", workspace: "{{where}}", reviewer: { role: "{{who}}" } }
`);
    expect(dagOf(expand(named, json({}), 'default')).tasks[0]).toMatchObject({ assignee: 'worker', reviewer: 'worker', workspace: 'web' });
    expect(refusal(expand(named, json({ who: 'Not A Role' }), 'default'))?.message).toMatch(
      /^param who fills steps\.a\.assignee, a role name, and "Not A Role" is none: role name/,
    );
    expect(refusal(expand(named, json({ where: '../etc' }), 'default'))?.message).toMatch(
      /^param where fills steps\.a\.workspace, a workspace name, and "\.\.\/etc" is none: workspace name/,
    );
    expect(refusal(expand(named, json({ who: 'lark:on_bob' }), 'default'))?.message).toBe(
      'param who fills steps.a.reviewer, a role\'s place, and "lark:on_bob" is a person',
    );
    expect(refusal(expand(named, json({ who: SECRET }), 'default'))?.message).toBe(
      'param who fills steps.a.assignee, and its value holds a known secret: a name is stored as written',
    );
    const person = workflow('params:\n  owner: { required: true }\nsteps:\n  a: { title: A, assignee: { person: "{{owner}}" } }\n');
    expect(refusal(expand(person, json({ owner: 'worker' }), 'default'))?.message).toBe(
      'param owner fills steps.a.assignee, a person\'s place, and "worker" is a role\'s name',
    );
  });

  it('resolves @ only for a param that lands in a person field, the principal in its text too, and keeps it elsewhere', () => {
    const w = workflow(`params:
  owner: { required: true }
  note: { required: true }
steps:
  a: { title: "For {{owner}}: {{note}}", assignee: "{{owner}}" }
`);
    const asked: string[] = [];
    const personOf = (value: string) => {
      asked.push(value);
      return value === '@Alice Smith' ? { ok: true as const, principal: 'lark:on_alice' } : { ok: false as const, code: 'invalid' as const, message: `${value} is not mentioned` };
    };
    const dag = dagOf(expand(w, chat(['owner', '@Alice Smith'], ['note', '@Alice Smith said so']), 'default', personOf));
    expect(asked).toEqual(['@Alice Smith']);
    expect(dag.tasks[0]).toMatchObject({ assignee: 'lark:on_alice', title: 'For lark:on_alice: @Alice Smith said so' });
    expect(refusal(expand(w, chat(['owner', '@Bob'], ['note', 'x']), 'default', personOf))).toEqual({ code: 'invalid', message: '@Bob is not mentioned' });
  });

  it('refuses an @Name in a person field with no mentions to resolve it by, at the terminal or from a run, and keeps one in text', () => {
    const w = workflow('params:\n  owner: { required: true }\n  note: { default: x }\nsteps:\n  a: { title: "Ask {{note}}", assignee: "{{owner}}" }\n');
    for (const given of [terminal(['owner', '@Alice Smith']), json({ owner: '@Alice Smith' })]) {
      expect(refusal(expand(w, given, 'default'))).toEqual({
        code: 'person_not_assignable',
        message: '"@Alice Smith" is a person: give a person work from chat, by @-mention, where the gateway can check they have talk tier',
      });
    }
    expect(dagOf(expand(w, json({ owner: 'worker', note: '@Bob' }), 'default')).tasks[0]?.title).toBe('Ask @Bob');
  });

  it('resolves @ in the items of a list a person field takes as {{item}}', () => {
    const w = workflow('params:\n  owners: { list: true, required: true }\nsteps:\n  a: { title: "Ask {{item}}", for_each: owners, assignee: "{{item}}" }\n');
    const personOf = (value: string) => ({ ok: true as const, principal: `lark:on_${value.slice(1).toLowerCase()}` });
    expect(dagOf(expand(w, chat(['owners', '@Ann,@Bo']), 'default', personOf)).tasks.map((t) => [t.item, t.assignee])).toEqual([
      ['lark:on_ann', 'lark:on_ann'],
      ['lark:on_bo', 'lark:on_bo'],
    ]);
  });
});

describe('for_each', () => {
  it('makes one task an item, in order, with a fan-in on every one of them', () => {
    const dag = dagOf(expand(vendorEval(), json({ topic: 'x', vendors: ['c', 'a', 'b'] }), 'default'));
    expect(dag.tasks.map((t) => [t.ref, t.item, t.parents])).toEqual([
      ['shortlist', null, []],
      ['evaluate:1', 'c', ['shortlist']],
      ['evaluate:2', 'a', ['shortlist']],
      ['evaluate:3', 'b', ['shortlist']],
      ['recommend', null, ['evaluate:1', 'evaluate:2', 'evaluate:3']],
    ]);
  });

  it('links two for_each steps over one list all to all', () => {
    const w = workflow(`params:
  vendors: { list: true, required: true }
steps:
  evaluate: { title: "Evaluate {{item}}", for_each: vendors }
  review: { title: "Review {{item}}", for_each: vendors, parents: [evaluate] }
`);
    const dag = dagOf(expand(w, json({ vendors: ['a', 'b'] }), 'default'));
    expect(dag.tasks.map((t) => [t.ref, t.parents])).toEqual([
      ['evaluate:1', []],
      ['evaluate:2', []],
      ['review:1', ['evaluate:1', 'evaluate:2']],
      ['review:2', ['evaluate:1', 'evaluate:2']],
    ]);
  });

  it('refuses a start that would make 101 tasks', () => {
    const w = workflow(`params:
  a: { list: true, required: true }
steps:
  one: { title: "One {{item}}", for_each: a }
  two: { title: "Two {{item}}", for_each: a }
`);
    const fifty = Array.from({ length: 50 }, (_, i) => `x${i}`);
    expect(dagOf(expand(w, json({ a: fifty }), 'default')).tasks).toHaveLength(100);
    const more = workflow(`params:
  a: { list: true, required: true }
steps:
  one: { title: "One {{item}}", for_each: a }
  two: { title: "Two {{item}}", for_each: a }
  three: { title: Three }
`);
    expect(refusal(expand(more, json({ a: fifty }), 'default'))).toEqual({
      code: 'invalid',
      message: 'workflow test would make 101 tasks with these params; an instance has at most 100',
    });
  });
});

describe('paramValues', () => {
  it('answers each param once, a list as its trimmed items', () => {
    const r = paramValues(vendorEval(), chat(['topic', ' x '], ['vendors', ' a , b ']));
    expect(r.ok && Object.fromEntries(r.values)).toEqual({ topic: ' x ', vendors: ['a', 'b'], reviewer: 'reviewer' });
  });
});
