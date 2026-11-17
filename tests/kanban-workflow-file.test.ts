import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkWorkflow,
  listWorkflows,
  paramsLine,
  readWorkflow,
  workflowLines,
  type WorkflowFacts,
} from '../src/kanban/workflow.js';
import type { Role } from '../src/roles.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { role } from './helpers/dispatch.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * A workflow file and its checks (workflows spec §1 to §4): the keys at every level,
 * the names, the params, the parents, for_each, the references, the roles and
 * workspaces written out, the gates, and the workspaces a step's parents
 * certainly work in. And the directory: what is ignored, and the startup lines.
 */

const ROLES: ReadonlyMap<string, Role> = new Map([
  ['worker', role('worker')],
  ['reviewer', role('reviewer')],
  ['web-dev', role('web-dev', { workspace: 'web' })],
  ['api-dev', role('api-dev', { workspace: 'api' })],
  ['watched', role('watched', { agent: { ...role('watched').agent, unsupervised: false } })],
]);
const FACTS: WorkflowFacts = { roles: ROLES, workspaces: new Set(['default', 'web', 'api']), supervisedRoles: false };

const SECRET = 'sk-live-1234567890';
let dir: string;
beforeEach(() => {
  clearSecrets();
  addSecrets([SECRET]);
  dir = mkdtempSync(join(tmpdir(), 'mt-wf-file-'));
});
afterEach(() => {
  clearSecrets();
  rmSync(dir, { recursive: true, force: true });
});

/** The problem a file's check finds, or undefined. */
function problem(text: string, facts: WorkflowFacts = FACTS): string | undefined {
  const r = checkWorkflow('test', text, facts);
  return r.ok ? undefined : r.problem;
}

/** A file of one step, `a`, with these lines under it, and these params. */
const oneStep = (lines: string, params = ''): string =>
  `${params === '' ? '' : `params:\n${params}\n`}steps:\n  a:\n    title: A task\n${lines}`;

describe('the example of the spec', () => {
  it('is usable, its steps and params in the order written', () => {
    const r = checkWorkflow('vendor-eval', VENDOR_EVAL, FACTS);
    if (!r.ok) throw new Error(r.problem);
    const w = r.workflow;
    expect(w.description).toBe('Shortlist vendors, evaluate each in parallel, then recommend one');
    expect(w.steps.map((s) => s.name)).toEqual(['shortlist', 'evaluate', 'recommend']);
    expect(w.params.map((p) => p.name)).toEqual(['topic', 'vendors', 'reviewer']);
    expect(paramsLine(w)).toBe('topic (required), vendors (list, required), reviewer (default reviewer)');
    expect(w.steps[1]).toMatchObject({ forEach: 'vendors', parents: ['shortlist'], gates: [{ command: 'test -s evaluation.md', timeoutS: 30 }] });
    expect(w.steps[2]).toMatchObject({ reviewer: { value: '{{reviewer}}', must: 'role' }, contract: { verification: "every score comes from a parent's summary" } });
  });

  it('keeps the steps in the order written, whatever their names', () => {
    const r = checkWorkflow('order', 'steps:\n  zeta: { title: Z }\n  alpha: { title: A }\n  mid: { title: M, parents: [zeta, alpha] }\n', FACTS);
    expect(r.ok && r.workflow.steps.map((s) => s.name)).toEqual(['zeta', 'alpha', 'mid']);
  });
});

describe('the keys', () => {
  it('refuses an unknown one at each level, naming it and its place', () => {
    expect(problem('steps:\n  a: { title: A }\nname: x\n')).toBe('unknown setting name (known: description, params, steps)');
    expect(problem(oneStep('    timeout: 3\n'))).toMatch(/^unknown setting steps\.a\.timeout \(known: title, body, assignee, /);
    expect(problem(oneStep('', '  topic: { required: true, kind: text }'))).toBe(
      'unknown setting params.topic.kind (known: list, required, default, description)',
    );
    expect(problem(oneStep('    gates:\n      - { command: "true", timeout: 3 }\n'))).toBe(
      'unknown setting steps.a.gates[0].timeout (known: command, timeout_s)',
    );
    expect(problem(oneStep('    reviewer: { team: x }\n'))).toBe('unknown setting steps.a.reviewer.team (known: role, person)');
    expect(problem(oneStep('    token: x\n'))).toMatch(/^steps\.a\.token looks like a credential/);
  });

  it('refuses a duplicated key, as the parser does, and YAML that does not parse', () => {
    expect(problem('steps:\n  a: { title: A }\n  a: { title: B }\n')).toMatch(/^the YAML does not parse: Map keys must be unique/);
    expect(problem('steps: [\n')).toMatch(/^the YAML does not parse: /);
  });

  it('says to quote a value that starts with {{', () => {
    expect(problem(oneStep('    assignee: {{owner}}\n', '  owner: { required: true }'))).toBe(
      'steps.a.assignee is a mapping, where text belongs: a value that starts with {{ must be quoted, as "{{name}}"',
    );
    const unquoted = 'params:\n  topic: { required: true }\nsteps:\n  a:\n    title: {{topic}}\n';
    expect(problem(unquoted)).toBe('steps.a.title is a mapping, where text belongs: a value that starts with {{ must be quoted, as "{{name}}"');
    expect(problem(oneStep('    reviewer: { role: {{owner}} }\n', '  owner: { required: true }'))).toBe(
      'steps.a.reviewer.role is a mapping, where text belongs: a value that starts with {{ must be quoted, as "{{name}}"',
    );
  });

  it('reads yes as text, and checks the types', () => {
    expect(problem(oneStep('    body: yes\n'))).toBeUndefined();
    expect(problem(oneStep('    body: 3\n'))).toBe('steps.a.body is text');
    expect(problem(oneStep('    priority: high\n'))).toBe('steps.a.priority is a whole number');
    expect(problem(oneStep('    failure_limit: 0\n'))).toBe('steps.a.failure_limit is a whole number, at least 1');
    expect(problem(oneStep('    max_runtime_s: 1.5\n'))).toBe('steps.a.max_runtime_s is a whole number, at least 1');
    expect(problem(oneStep('    retry_on_crash: never\n'))).toBe('steps.a.retry_on_crash is always or if-no-side-effects');
    expect(problem(oneStep('    parents: a\n'))).toBe('steps.a.parents is a list of step names');
    expect(problem(oneStep('    gates: true\n'))).toBe('steps.a.gates is a list of { command, timeout_s }');
    expect(problem(oneStep('    gates:\n      - { timeout_s: 3 }\n'))).toBe('steps.a.gates[0] needs a command');
    expect(problem('steps:\n  a: { body: B }\n')).toBe('steps.a needs a title');
    expect(problem('description: x\n')).toBe('the file needs steps, at least one');
    expect(problem('steps: {}\n')).toBe('the file needs steps, at least one');
    expect(problem('- a\n')).toBe('the file must be a mapping');
  });

  it('takes 100 steps and refuses 101, as a start makes at least a task a step', () => {
    const steps = (n: number): string => `steps:\n${Array.from({ length: n }, (_, i) => `  s${i}: { title: T }\n`).join('')}`;
    expect(problem(steps(100))).toBeUndefined();
    expect(problem(steps(101))).toBe('the file has 101 steps; a workflow has at most 100, as a start makes at least one task a step and an instance has at most 100');
  });
});

describe('the names', () => {
  it('holds steps and params to the grammar, and keeps item for the for_each item', () => {
    expect(problem('steps:\n  Shortlist: { title: A }\n')).toMatch(/^steps\.Shortlist: step name "Shortlist" must be lowercase letters/);
    expect(problem(oneStep('', '  Topic: { required: true }'))).toMatch(/^params\.Topic: param name "Topic" must be lowercase letters/);
    expect(problem(oneStep('', '  item: { required: true }'))).toBe("params.item: item is the for_each item's name, and no param's");
  });
});

describe('the params', () => {
  it('is required or has a default, never both and never neither', () => {
    expect(problem(oneStep('', '  topic: { required: true, default: x }'))).toBe('params.topic is required and has a default: say one or the other');
    expect(problem(oneStep('', '  topic: { description: what }'))).toBe(
      'params.topic is neither required nor given a default: a {{topic}} left out would have no value',
    );
    expect(problem(oneStep('', '  topic: { required: false }'))).toMatch(/^params\.topic is neither required nor given a default/);
    expect(problem(oneStep('', '  vendors: { list: true, default: acme }'))).toBe('params.vendors.default is a list of text, as the param is a list');
    expect(problem(oneStep('', '  topic: { default: [a] }'))).toBe('params.topic.default is text');
    expect(problem(oneStep('', '  topic: { list: yes, required: true }'))).toBe('params.topic.list is true or false');
  });
});

describe('the parents and for_each', () => {
  it('names a step of the file, never itself, with no cycle, each written above its children', () => {
    expect(problem(oneStep('    parents: [b]\n'))).toBe('steps.a.parents names "b", which is no step of this file');
    expect(problem(oneStep('    parents: [a]\n'))).toBe('steps.a.parents names the step itself');
    expect(problem('steps:\n  a: { title: A, parents: [b] }\n  b: { title: B, parents: [c] }\n  c: { title: C, parents: [a] }\n')).toBe(
      "the steps' parents make a cycle: a -> b -> c -> a",
    );
    expect(problem('steps:\n  a: { title: A, parents: [b] }\n  b: { title: B }\n')).toBe(
      'steps.a.parents names b, which is written after it: write a step below its parents',
    );
    expect(problem('steps:\n  a: { title: A }\n  b: { title: B, parents: [a, a] }\n')).toBe('steps.b.parents names a twice');
  });

  it('takes for_each over a declared list param, and {{item}} only in a for_each step', () => {
    expect(problem(oneStep('    for_each: topic\n', '  topic: { required: true }'))).toBe(
      'steps.a.for_each names topic, a text param: for_each takes a list param',
    );
    expect(problem(oneStep('    for_each: vendors\n'))).toBe('steps.a.for_each names "vendors", which is no param this file declares');
    expect(problem('steps:\n  a:\n    title: Evaluate {{item}}\n')).toBe('steps.a.title uses {{item}}, which only a for_each step has');
    expect(problem(oneStep('    for_each: vendors\n    body: About {{item}}\n', '  vendors: { list: true, required: true }'))).toBeUndefined();
  });
});

describe('the references', () => {
  it('opens every {{ to a declared param, in every text field', () => {
    for (const key of ['body', 'outcome', 'verify', 'constraints', 'boundaries', 'stop_when']) {
      expect(problem(oneStep(`    ${key}: "about {{topik}}"\n`, '  topic: { required: true }'))).toBe(
        `steps.a.${key} names {{topik}}, which is no param this file declares`,
      );
    }
    expect(problem(oneStep('    body: "about {{ topic }}"\n', '  topic: { required: true }'))).toBe(
      "steps.a.body has a {{ that opens no reference: write {{name}}, a param's name with no spaces; a literal {{ cannot be written",
    );
    expect(problem(oneStep('    body: "a {{topic}} and {{topic}}, {{vendors}}"\n', '  topic: { required: true }\n  vendors: { list: true, required: true }'))).toBeUndefined();
  });

  it('takes one whole reference in a name field, never a list param, and never parts', () => {
    const params = '  owner: { required: true }\n  vendors: { list: true, required: true }';
    expect(problem(oneStep('    assignee: "{{owner}}"\n', params))).toBeUndefined();
    expect(problem(oneStep('    reviewer: { person: "{{owner}}" }\n', params))).toBeUndefined();
    expect(problem(oneStep('    assignee: "{{vendors}}"\n', params))).toBe(
      'steps.a.assignee names {{vendors}}, a list param: a name field takes one name, so a text param or {{item}}',
    );
    expect(problem(oneStep('    assignee: "team-{{owner}}"\n', params))).toBe(
      'steps.a.assignee is a name, or one whole reference such as "{{name}}": a name is never put together from parts',
    );
    expect(problem(oneStep('    workspace: "{{ghost}}"\n', params))).toBe('steps.a.workspace names {{ghost}}, which is no param this file declares');
    expect(problem(oneStep('    for_each: vendors\n    assignee: "{{item}}"\n', params))).toBeUndefined();
    expect(problem(oneStep('    assignee: "{{item}}"\n', params))).toBe('steps.a.assignee uses {{item}}, which only a for_each step has');
  });
});

describe('roles and workspaces written out', () => {
  it('are configured and usable, as create asks of them; a person is checked at a start', () => {
    expect(problem(oneStep('    assignee: evaluator\n'))).toBe('steps.a.assignee: role "evaluator" is not configured');
    expect(problem(oneStep('    reviewer: watched\n'))).toBe(
      'steps.a.reviewer: role "watched" has a supervised agent; its approval requests would reach nobody until the board is in Lark',
    );
    expect(problem(oneStep('    reviewer: watched\n'), { ...FACTS, supervisedRoles: true })).toBeUndefined();
    expect(problem(oneStep('    workspace: nowhere\n'))).toBe('steps.a.workspace: workspace "nowhere" is not configured');
    expect(problem(oneStep('    assignee: lark:on_alice\n'))).toBeUndefined();
    expect(problem(oneStep('    assignee: "lark:not one"\n'))).toBe('steps.a.assignee: "lark:not one" is neither a role name nor a person (lark:<union_id>)');
    expect(problem(oneStep('    assignee: { role: lark:on_alice }\n'))).toBe('steps.a.assignee.role is a role\'s place, and "lark:on_alice" is a person');
    expect(problem(oneStep('    assignee: { person: worker }\n'))).toBe('steps.a.assignee.person is a person\'s place, and "worker" is a role\'s name');
  });
});

describe('the gates', () => {
  const gate = (command: string, timeout = '') => oneStep(`    gates:\n      - command: ${JSON.stringify(command)}${timeout === '' ? '' : `\n        timeout_s: ${timeout}`}\n`);

  it('refuses a {{ and the mask, and takes $NAME', () => {
    expect(problem(gate('test -s {{file}}'))).toBe(
      'steps.a.gates[0].command holds {{, and a gate is a shell command: name the value as an environment variable instead',
    );
    expect(problem(gate('curl -H "x: $TOKEN" https://example.com'))).toBeUndefined();
    expect(problem(gate(`curl ${MASK}`))).toBe(
      `steps.a.gates[0].command holds the mask ${MASK}: it was copied from masked output, and a masked command would run broken; write the command out again`,
    );
  });

  it('refuses one holding a known secret, too long, too slow, twenty-one, and 601 s together, a gate with no timeout counted as 300 s', () => {
    expect(problem(gate(`curl ${SECRET}`))).toMatch(/^steps\.a\.gates\[0\]\.command holds a known secret, and a gate is stored and run as written/);
    expect(problem(gate('x'.repeat(4097)))).toBe('steps.a.gates[0].command is 4097 bytes; a gate command may be at most 4096');
    expect(problem(gate('true', '601'))).toBe("steps.a.gates[0].command has a timeout of 601 s; a gate's timeout is a whole number of seconds, from 1 to 600");
    const many = Array.from({ length: 21 }, () => '      - { command: "true", timeout_s: 1 }').join('\n');
    expect(problem(oneStep(`    gates:\n${many}\n`))).toBe('steps.a has 21 gates; a task may have at most 20');
    expect(problem(oneStep('    gates:\n      - { command: one, timeout_s: 301 }\n      - { command: two, timeout_s: 300 }\n'))).toBe(
      'steps.a has gates that would take up to 601 s together; at most 600 s, since a report waits for them',
    );
    expect(problem(oneStep('    gates:\n      - { command: one }\n      - { command: two }\n      - { command: three }\n'))).toBe(
      'steps.a has gates that would take up to 900 s together; at most 600 s, since a report waits for them',
    );
  });
});

describe('the workspaces a step\'s parents work in', () => {
  const fan = (child: string, second = 'assignee: api-dev') =>
    `steps:\n  web: { title: Web, assignee: web-dev }\n  api: { title: API, ${second} }\n  join: { title: Join, parents: [web, api]${child} }\n`;

  it('refuses a step whose parents certainly disagree and which names none, nor does its role', () => {
    expect(problem(fan(', assignee: worker'))).toBe(
      'steps.join has parents in different workspaces, web and api, and names no workspace, nor does its role: ' +
        'its tasks could not be given one at their claim; set steps.join.workspace',
    );
    expect(problem(fan(''))).toMatch(/^steps\.join has parents in different workspaces/);
    expect(problem(fan(', assignee: worker, workspace: web'))).toBeUndefined();
    expect(problem(fan(', assignee: web-dev'))).toBeUndefined();
  });

  it('does not judge a parent whose workspace is decided later, or a step whose role comes from a param', () => {
    expect(problem(fan(', assignee: worker', 'assignee: worker'))).toBeUndefined();
    expect(problem(fan(', assignee: worker', 'assignee: worker, workspace: "{{where}}"').replace('steps:', 'params:\n  where: { default: api }\nsteps:'))).toBeUndefined();
    expect(problem(fan(', assignee: "{{who}}"').replace('steps:', 'params:\n  who: { default: worker }\nsteps:'))).toBeUndefined();
  });
});

describe('the directory', () => {
  it('lists the usable workflows and the broken ones, ignoring a badly named file and a symlink with one note each, and a dot-entry silently', () => {
    const wf = join(dir, 'workflows');
    mkdirSync(wf);
    writeFileSync(join(wf, 'vendor-eval.yaml'), VENDOR_EVAL);
    writeFileSync(join(wf, 'onboarding.yaml'), 'steps:\n  welcome:\n    title: Welcome\n    gates:\n      - command: "echo {{name}}"\n');
    writeFileSync(join(wf, 'Bad_Name.yaml'), VENDOR_EVAL);
    writeFileSync(join(wf, 'notes.txt'), 'x');
    writeFileSync(join(wf, '.hidden.yaml'), VENDOR_EVAL);
    mkdirSync(join(wf, '.git'));
    mkdirSync(join(wf, 'dir.yaml'));
    symlinkSync(join(wf, 'vendor-eval.yaml'), join(wf, 'linked.yaml'));
    const list = listWorkflows(wf, FACTS);
    expect(list.usable.map((w) => w.name)).toEqual(['vendor-eval']);
    expect(list.broken).toEqual([
      { name: 'onboarding', problem: 'steps.welcome.gates[0].command holds {{, and a gate is a shell command: name the value as an environment variable instead' },
    ]);
    expect(list.ignored).toEqual([
      expect.stringMatching(new RegExp(`^ignoring ${join(wf, 'Bad_Name.yaml')}: workflow name "Bad_Name" must be lowercase letters`)),
      `ignoring ${join(wf, 'dir.yaml')}: not a regular file, so not a workflow`,
      `ignoring ${join(wf, 'linked.yaml')}: a symlink, which is not followed: a workflow is a file of its own in the home`,
      `ignoring ${join(wf, 'notes.txt')}: not a .yaml file, so not a workflow`,
    ]);
    expect(workflowLines(list)).toEqual([
      'workflow onboarding is not usable: steps.welcome.gates[0].command holds {{, and a gate is a shell command: name the value as an environment variable instead',
      ...list.ignored,
      'workflows: vendor-eval; not usable: onboarding',
    ]);
  });

  it('says workflows: none for a directory that is missing or empty', () => {
    expect(workflowLines(listWorkflows(join(dir, 'missing'), FACTS))).toEqual(['workflows: none']);
    mkdirSync(join(dir, 'empty'));
    expect(workflowLines(listWorkflows(join(dir, 'empty'), FACTS))).toEqual(['workflows: none']);
  });

  it('refuses a file past 64 KiB', () => {
    writeFileSync(join(dir, 'big.yaml'), `${VENDOR_EVAL}# ${'x'.repeat(64 * 1024)}\n`);
    expect(listWorkflows(dir, FACTS).broken).toEqual([{ name: 'big', problem: expect.stringMatching(/^the file is \d+ bytes; a workflow is at most 65536$/) }]);
  });

  it('takes a file that cannot be read for one broken workflow, the others still usable', () => {
    writeFileSync(join(dir, 'vendor-eval.yaml'), VENDOR_EVAL);
    writeFileSync(join(dir, 'locked.yaml'), VENDOR_EVAL, { mode: 0o000 });
    chmodSync(join(dir, 'locked.yaml'), 0o000);
    const list = listWorkflows(dir, FACTS);
    expect(list.usable.map((w) => w.name)).toEqual(['vendor-eval']);
    expect(list.broken).toEqual([{ name: 'locked', problem: 'the file cannot be read: EACCES' }]);
    expect(workflowLines(list)).toEqual(['workflow locked is not usable: the file cannot be read: EACCES', 'workflows: vendor-eval; not usable: locked']);
    expect(readWorkflow(dir, 'vendor-eval', FACTS)).toMatchObject({ ok: true, workflow: { name: 'vendor-eval' } });
    expect(readWorkflow(dir, 'locked', FACTS)).toEqual({ ok: false, code: 'invalid', message: 'workflow locked is not usable: the file cannot be read: EACCES' });
  });

  it('reads one workflow by name: unknown_workflow for no usable file, invalid for a broken one', () => {
    writeFileSync(join(dir, 'vendor-eval.yaml'), VENDOR_EVAL);
    writeFileSync(join(dir, 'broken.yaml'), 'steps: {}\n');
    symlinkSync(join(dir, 'vendor-eval.yaml'), join(dir, 'linked.yaml'));
    expect(readWorkflow(dir, 'vendor-eval', FACTS)).toMatchObject({ ok: true, workflow: { name: 'vendor-eval' } });
    expect(readWorkflow(dir, 'missing', FACTS)).toEqual({ ok: false, code: 'unknown_workflow', message: 'there is no workflow missing' });
    expect(readWorkflow(dir, '../roles', FACTS)).toEqual({ ok: false, code: 'unknown_workflow', message: 'there is no workflow "../roles"' });
    expect(readWorkflow(dir, 'linked', FACTS)).toMatchObject({ ok: false, code: 'unknown_workflow', message: expect.stringMatching(/is a symlink/) });
    expect(readWorkflow(dir, 'broken', FACTS)).toEqual({ ok: false, code: 'invalid', message: 'workflow broken is not usable: the file needs steps, at least one' });
  });
});
