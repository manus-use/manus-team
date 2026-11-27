import { lstatSync, readdirSync, readFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigError, reject, section } from '../config.js';
import { NAME_PATTERN, nameProblem, visible } from '../names.js';
import type { Role } from '../roles.js';
import { redactKnownSecrets } from '../secrets.js';
import { DAG_FORMAT, DAG_LIMITS, titleRefused, type Dag, type DagTask, type ParamValue } from './dag.js';
import { WORKER_LIMITS } from './limits.js';
import { gateProblem, gatesProblem } from './gate-command.js';
import { outcomeWithOutputs, PLAN_FORMAT, standInContract, type Plan, type PlanStep, type StepShape, type Template, type Clause, type ClauseValue, type OutputType, type Outputs, type RouteSpec, type ScalarType, type StepState, type WhenItem } from './routing.js';
import { assignable, isRecord, NO_MENTIONS, type TaskFacts } from './task-checks.js';
import { CONTRACT_FIELDS, GATE_LIMITS, type Contract, type CreatedVia, type Phase, type Refusal, type Result, type RetryOnCrash } from './types.js';

export { checkDagShape, readDag } from './dag.js';

/**
 * Workflows (workflows spec): a graph of tasks written once, in a YAML file under
 * `$MT_HOME/workflows`, and started many times. This module reads a file and
 * checks it (workflows spec §1 to §4), expands it with its params into a DAG (workflows spec
 * §5), and derives an instance's status (workflows spec §10). Pure but for reading
 * the directory: the service, `mt workflow check` and the startup check all
 * call it, so a file is judged the same way everywhere. Nothing in the kernel
 * knows about workflows (spec §1).
 */

export const WORKFLOW_LIMITS = {
  /** A workflow file's size, in bytes. */
  fileBytes: 64 * 1024,
} as const;

/** A param (workflows spec §2): text, or a list with `list: true`; required, or with a default. */
export interface WorkflowParam {
  name: string;
  list: boolean;
  required: boolean;
  default: string | string[] | undefined;
  description: string | undefined;
}

/** A name field as written: a name, or one whole reference, `{{name}}`; with `{ role }` or `{ person }`, which it must be. */
export interface NameSpec {
  value: string;
  must: 'role' | 'person' | undefined;
}

export interface WorkflowGate {
  command: string;
  /** As written, or the default, 300 s, as `addGate` stores one with none. */
  timeoutS: number;
}

/** A step (workflows spec §1): `KanbanService.create`'s fields, `addGate`'s gates, `parents` and `for_each`. */
export interface WorkflowStep {
  name: string;
  title: string;
  body: string | undefined;
  assignee: NameSpec | undefined;
  reviewer: NameSpec | undefined;
  workspace: string | undefined;
  priority: number | undefined;
  /** As written, before substitution: `verify` is `verification`. */
  contract: Contract;
  failureLimit: number | undefined;
  retryOnCrash: RetryOnCrash | undefined;
  maxRuntimeS: number | undefined;
  gates: WorkflowGate[];
  parents: string[];
  /** A list param's name, or an ancestor's list output (workflow routing spec §4): told apart by their YAML type. */
  forEach: string | { step: string; output: string } | undefined;
  /** Its declared outputs (workflow routing spec §2), in the file's order; empty for none. */
  outputs: Outputs;
  /** Its conditions (workflow routing spec §3), or undefined for none. */
  when: WhenItem[] | undefined;
  /** `wait`, the default, or a route to a handler (workflow routing spec §5.1). */
  onBlocked: RouteSpec;
  onGaveUp: RouteSpec;
  /** Made only when routed to (workflow routing spec §5.2). */
  handler: boolean;
  /** On a handler: the step whose dependents its accepted completion settles. */
  standsInFor: string | undefined;
  /**
   * `wake: true` (wake spec §3.1): its task's outcomes wake whoever starts it;
   * `wake: { role: <name> }` (§19.1), a reaction task for that role; default false.
   */
  wake: boolean | { role: string };
}

export interface Workflow {
  name: string;
  description: string | undefined;
  /** The board its tasks go on (workflows spec §19.1), or undefined for the path's own. */
  board: string | undefined;
  params: WorkflowParam[];
  /** In the file's order, which is the order their tasks are made in, and `show` lists them in. */
  steps: WorkflowStep[];
}

/** What a file is checked against: the team. A person is checked at a start, where talk tier is known. */
export type WorkflowFacts = Pick<TaskFacts, 'roles' | 'workspaces' | 'supervisedRoles'>;

/** A workflow file that is not usable, and why. */
export interface BrokenWorkflow {
  name: string;
  problem: string;
}

/** The directory, as read now: the usable workflows, the broken ones, and the entries that are no workflow. */
export interface WorkflowList {
  usable: Workflow[];
  broken: BrokenWorkflow[];
  ignored: string[];
}

/** The fields of a step's text, where `{{name}}` is substituted, and the contract field each fills. */
const TEXT_FIELDS = {
  title: undefined,
  body: undefined,
  outcome: 'outcome',
  verify: 'verification',
  constraints: 'constraints',
  boundaries: 'boundaries',
  stop_when: 'stop_when',
} as const;

const STEP_KEYS = [
  'title',
  'body',
  'assignee',
  'reviewer',
  'workspace',
  'priority',
  'outcome',
  'verify',
  'constraints',
  'boundaries',
  'stop_when',
  'failure_limit',
  'retry_on_crash',
  'max_runtime_s',
  'gates',
  'parents',
  'for_each',
  'wake',
  'outputs',
  'when',
  'on_blocked',
  'on_gave_up',
  'handler',
  'stands_in_for',
] as const;

/** The for_each item's name, which no param may take (workflows spec §1). */
export const ITEM = 'item';

/** `reject`'s hints, for a key that looks like a credential, or `env`. */
const HINTS = {
  secret: "A workflow holds no credential: a gate names one as $NAME, from the role's environment.",
  env: "A gate takes a value from the role's environment, as $NAME, and a workflow sets none.",
};

/** A reference: `{{name}}`, a name in the grammar, with no spaces. */
const REFERENCE = /^\{\{([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)\}\}/;

/** A reference to a result (workflow routing spec §1): `{{<step>.<output>}}`, both in the name grammar, with no spaces. */
const RESULT_REFERENCE = /^\{\{([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)\.([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)\}\}/;

/** Every result reference in a text, `{{<step>.<output>}}`, in order. */
export const RESULT_REFERENCES = /\{\{([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)\.([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)\}\}/g;

/** A file's problem, thrown inside the check and caught as its result. */
class Problem extends Error {}

function fail(message: string): never {
  throw new Problem(message);
}

/** A name a problem quotes: as JSON, its invisible characters shown. */
function q(text: string): string {
  return visible(JSON.stringify(text.length <= 80 ? text : `${text.slice(0, 80)}…`));
}

/** Text, or a problem saying so; a mapping where text belongs says to quote a `{{`. */
function text(value: unknown, place: string): string {
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    fail(`${place} is a mapping, where text belongs: a value that starts with {{ must be quoted, as "{{name}}"`);
  }
  return fail(`${place} is text`);
}

function optionalText(value: unknown, place: string): string | undefined {
  return value === undefined || value === null ? undefined : text(value, place);
}

function whole(value: unknown, place: string, min: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    return fail(min === Number.MIN_SAFE_INTEGER ? `${place} is a whole number` : `${place} is a whole number, at least ${min}`);
  }
  return value as number;
}

/** A name field: text, or `{ role: … }` or `{ person: … }`. */
function nameSpec(value: unknown, place: string, path: string): NameSpec | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return { value, must: undefined };
  // An unquoted `{{owner}}` is read as a mapping whose key is another: say to quote it.
  if (isRecord(value) && Object.keys(value).some((key) => key.startsWith('{'))) text(value, place);
  const map = section(path, place, value);
  reject(path, place, map, ['role', 'person'], HINTS);
  const keys = Object.keys(map);
  if (keys.length !== 1) fail(`${place} is a name, or one of { role: … } and { person: … }`);
  const must = keys[0] as 'role' | 'person';
  return { value: text(map[must], `${place}.${must}`), must };
}

/**
 * Each `{{` in a text field opens a reference to a declared param, to `item` in
 * a for_each step (workflows spec §2), or to a result, `{{<step>.<output>}}`,
 * which `result` judges (workflow routing spec §1).
 */
function references(
  value: string,
  place: string,
  params: ReadonlyMap<string, WorkflowParam>,
  forEach: boolean,
  result: (step: string, output: string) => void,
  lateItem = false,
): void {
  for (let at = value.indexOf('{{'); at !== -1; at = value.indexOf('{{', at + 2)) {
    const r = RESULT_REFERENCE.exec(value.slice(at));
    if (r !== null) {
      result(r[1] ?? '', r[2] ?? '');
      continue;
    }
    const m = REFERENCE.exec(value.slice(at));
    if (m === null) {
      fail(`${place} has a {{ that opens no reference: write {{name}}, a param's name with no spaces; a literal {{ cannot be written`);
    }
    const name = m[1] ?? '';
    if (name === ITEM) {
      if (!forEach) fail(`${place} uses {{item}}, which only a for_each step has`);
      // A result fan-out's item, and a handler's, is a result's (workflow routing spec §14).
      if (lateItem) fail(`${place} uses {{item}}, a result's: a result fills only a title and a body`);
    } else if (!params.has(name)) {
      fail(`${place} names {{${name}}}, which is no param this file declares`);
    }
  }
}

/** The param a name field refers to, whole, or undefined for a name written out; a problem for anything between. */
function referenceOf(value: string, place: string): string | undefined {
  if (!value.includes('{{')) return undefined;
  const r = RESULT_REFERENCE.exec(value);
  if (r !== null) fail(`${place} names ${r[0]}: a result fills only a title and a body`);
  const m = REFERENCE.exec(value);
  if (m === null || m[0] !== value) {
    fail(`${place} is a name, or one whole reference such as "{{name}}": a name is never put together from parts`);
  }
  return m[1];
}

/** A param from the file (workflows spec §2). */
function paramOf(name: string, value: unknown, path: string): WorkflowParam {
  const place = `params.${name}`;
  const problem = nameProblem('param', name);
  if (problem !== undefined) fail(`${place}: ${problem}`);
  if (name === ITEM) fail(`${place}: item is the for_each item's name, and no param's`);
  const map = section(path, place, value ?? {});
  reject(path, place, map, ['list', 'required', 'default', 'description'], HINTS);
  for (const key of ['list', 'required'] as const) {
    if (map[key] !== undefined && typeof map[key] !== 'boolean') fail(`${place}.${key} is true or false`);
  }
  const list = map['list'] === true;
  const required = map['required'] === true;
  const raw = map['default'];
  let fallback: string | string[] | undefined;
  if (raw !== undefined && raw !== null) {
    if (list) {
      if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string')) fail(`${place}.default is a list of text, as the param is a list`);
      fallback = [...(raw as string[])];
    } else {
      fallback = text(raw, `${place}.default`);
    }
  }
  if (required && fallback !== undefined) fail(`${place} is required and has a default: say one or the other`);
  if (!required && fallback === undefined) {
    fail(`${place} is neither required nor given a default: a {{${name}}} left out would have no value`);
  }
  return { name, list, required, default: fallback, description: optionalText(map['description'], `${place}.description`) };
}

/** A step from the file (workflows spec §1), its fields checked as `create` checks them. */
function stepOf(name: string, value: unknown, path: string): WorkflowStep {
  const place = `steps.${name}`;
  const problem = nameProblem('step', name);
  if (problem !== undefined) fail(`${place}: ${problem}`);
  const map = section(path, place, value ?? {});
  reject(path, place, map, STEP_KEYS, HINTS);
  if (map['title'] === undefined || map['title'] === null) fail(`${place} needs a title`);
  const contract: Contract = {};
  for (const [key, field] of Object.entries(TEXT_FIELDS)) {
    if (field === undefined) continue;
    const v = optionalText(map[key], `${place}.${key}`);
    if (v !== undefined) contract[field] = v;
  }
  const retry = map['retry_on_crash'];
  if (retry !== undefined && retry !== null && retry !== 'always' && retry !== 'if-no-side-effects') {
    fail(`${place}.retry_on_crash is always or if-no-side-effects`);
  }
  const gatesRaw = map['gates'] ?? [];
  if (!Array.isArray(gatesRaw)) fail(`${place}.gates is a list of { command, timeout_s }`);
  const gates = (gatesRaw as unknown[]).map((g, i): WorkflowGate => {
    const at = `${place}.gates[${i}]`;
    const gate = section(path, at, g);
    reject(path, at, gate, ['command', 'timeout_s'], HINTS);
    if (gate['command'] === undefined || gate['command'] === null) fail(`${at} needs a command`);
    const command = text(gate['command'], `${at}.command`);
    const timeoutS = gate['timeout_s'] === undefined || gate['timeout_s'] === null ? GATE_LIMITS.defaultTimeoutS : gate['timeout_s'];
    if (!Number.isSafeInteger(timeoutS)) fail(`${at}.timeout_s is a whole number of seconds`);
    return { command, timeoutS: timeoutS as number };
  });
  const parentsRaw = map['parents'] ?? [];
  if (!Array.isArray(parentsRaw) || !parentsRaw.every((p) => typeof p === 'string')) {
    fail(`${place}.parents is a list of step names`);
  }
  const wake = stepWake(path, place, map['wake'] ?? false);
  return {
    name,
    title: text(map['title'], `${place}.title`),
    body: optionalText(map['body'], `${place}.body`),
    assignee: nameSpec(map['assignee'], `${place}.assignee`, path),
    reviewer: nameSpec(map['reviewer'], `${place}.reviewer`, path),
    workspace: optionalText(map['workspace'], `${place}.workspace`),
    priority: whole(map['priority'], `${place}.priority`, Number.MIN_SAFE_INTEGER),
    contract,
    failureLimit: whole(map['failure_limit'], `${place}.failure_limit`, 1),
    retryOnCrash: retry === undefined || retry === null ? undefined : (retry as RetryOnCrash),
    maxRuntimeS: whole(map['max_runtime_s'], `${place}.max_runtime_s`, 1),
    gates,
    parents: [...(parentsRaw as string[])],
    forEach: forEachOf(map['for_each'], place),
    wake,
    outputs: outputsOf(map['outputs'], place, path),
    when: whenOf(map['when'], place, path),
    onBlocked: routeOf(map['on_blocked'], `${place}.on_blocked`, path),
    onGaveUp: routeOf(map['on_gave_up'], `${place}.on_gave_up`, path),
    handler: flag(map['handler'], `${place}.handler`),
    standsInFor: map['stands_in_for'] === undefined || map['stands_in_for'] === null ? undefined : stepName(map['stands_in_for'], `${place}.stands_in_for`),
  };
}

// ---------------------------------------------------------------------------
// The routing keys (workflow routing spec §1 to §5)
// ---------------------------------------------------------------------------

/** The most values an enum takes, and the size of each (workflow routing spec §2.1). */
const ENUM_LIMITS = { values: 50, valueBytes: 256 } as const;

/** The most items a list output may be declared to hold (workflow routing spec §2.1). */
export const LIST_MAX = 100;

/** Whether a text holds a known secret: an enum's or a clause's value is stored as written (workflow routing spec §7.3). */
function secretIn(value: string): boolean {
  return redactKnownSecrets(value) !== value;
}

/** True or false, absent false. */
function flag(value: unknown, place: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') fail(`${place} is true or false`);
  return value as boolean;
}

/** A step's name as a key names one: text, checked against the steps once they are all read. */
function stepName(value: unknown, place: string): string {
  if (typeof value !== 'string' || value === '') fail(`${place} is a step's name`);
  return value as string;
}

/** `for_each`: a list param's name, as text, or `{ step, output }` (workflow routing spec §1). */
function forEachOf(value: unknown, place: string): WorkflowStep['forEach'] {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  const bad = `${place}.for_each is a list param's name, or { step, output } naming an ancestor's list output`;
  if (!isRecord(value)) fail(bad);
  const map = value as Record<string, unknown>;
  const keys = Object.keys(map).sort();
  if (keys.length !== 2 || keys[0] !== 'output' || keys[1] !== 'step' || typeof map['step'] !== 'string' || typeof map['output'] !== 'string') fail(bad);
  return { step: map['step'] as string, output: map['output'] as string };
}

/** A scalar type: a bare word, or `{ enum: [values] }` (workflow routing spec §2.1). */
function scalarOf(value: unknown, place: string, path: string): ScalarType | undefined {
  if (value === 'boolean' || value === 'number' || value === 'string') return value;
  if (!isRecord(value) || !('enum' in value)) return undefined;
  reject(path, place, value, ['enum'], HINTS);
  const values = value['enum'];
  if (!Array.isArray(values) || values.length === 0 || values.length > ENUM_LIMITS.values) fail(`${place}: an enum has 1 to ${ENUM_LIMITS.values} values`);
  for (const [n, v] of (values as unknown[]).entries()) {
    if (typeof v !== 'string' || v === '' || bytesOf(v) > ENUM_LIMITS.valueBytes || titleRefused(v)) {
      fail(`${place}: an enum's values are text of 1 to ${ENUM_LIMITS.valueBytes} bytes, on one line`);
    }
    if (secretIn(v)) fail(`${place}: an enum value holds a known secret, and an enum value is stored as written`);
    if ((values as unknown[]).indexOf(v) !== n) fail(`${place}: an enum names ${q(v)} twice`);
  }
  return { enum: [...(values as string[])] };
}

/** An output's type (workflow routing spec §2.1): a scalar, or `{ list: <scalar>, max: <n> }`. */
function outputTypeOf(value: unknown, place: string, path: string): OutputType {
  const scalar = scalarOf(value, place, path);
  if (scalar !== undefined) return scalar;
  if (isRecord(value) && 'list' in value) {
    reject(path, place, value, ['list', 'max'], HINTS);
    const item = scalarOf(value['list'], `${place}.list`, path);
    if (item === undefined) fail(`${place}: a list's items are boolean, number, string or { enum: [values] }`);
    const max = value['max'];
    if (!Number.isSafeInteger(max) || (max as number) < 1 || (max as number) > LIST_MAX) fail(`${place}: a list needs its max, from 1 to ${LIST_MAX}`);
    return { list: item as ScalarType, max: max as number };
  }
  return fail(`${place} is boolean, number, string, { enum: [values] } or { list: <type>, max: <n> }`);
}

/** A step's `outputs` (workflow routing spec §2.1): names in the param grammar, each with its type, in the file's order. */
function outputsOf(value: unknown, place: string, path: string): Outputs {
  if (value === undefined || value === null) return {};
  const map = section(path, `${place}.outputs`, value);
  const out: Outputs = {};
  for (const [name, type] of Object.entries(map)) {
    if (!NAME_PATTERN.test(name)) {
      fail(`${place}.outputs: output name ${visible(JSON.stringify(name))} must be lowercase letters, digits and '-', start with a letter, not end with '-', and be at most 40 characters`);
    }
    out[name] = outputTypeOf(type, `${place}.outputs.${name}`, path);
  }
  return out;
}

/** The tests a clause on an output takes, one of them (workflow routing spec §3). */
const TESTS = ['equals', 'in', 'is', 'at_least', 'at_most'] as const;

/** The states a clause reads (workflow routing spec §3.1). */
const STATES: readonly StepState[] = ['done', 'skipped', 'gave_up', 'blocked'];

/** A value a clause compares with: text, a number or true or false, holding no known secret. */
function clauseValue(value: unknown, place: string): ClauseValue {
  if (typeof value === 'string') {
    if (secretIn(value)) fail(`${place} holds a known secret, and a clause's value is stored as written`);
    return value;
  }
  if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') return value;
  return fail(`${place} is text, a number, true or false`);
}

/** One clause (workflow routing spec §3): `step` and either `output` with one test, or `state`. */
function clauseOf(value: unknown, place: string, path: string): Clause {
  if (!isRecord(value)) fail(`${place} is a clause: { step, output, <test> } or { step, state }`);
  const map = value as Record<string, unknown>;
  reject(path, place, map, ['step', 'output', 'state', ...TESTS], HINTS);
  const step = stepName(map['step'], `${place}.step`);
  const tests = TESTS.filter((t) => map[t] !== undefined);
  if (map['state'] !== undefined) {
    if (map['output'] !== undefined || tests.length > 0) fail(`${place} reads a state or an output, not both`);
    const state = map['state'];
    if (!STATES.includes(state as StepState)) fail(`${place}.state is ${STATES.slice(0, -1).join(', ')} or ${STATES.at(-1) ?? ''}`);
    return { step, state: state as StepState };
  }
  if (typeof map['output'] !== 'string' || map['output'] === '') fail(`${place} names an output and one test, or a state`);
  const output = map['output'] as string;
  if (tests.length === 0) fail(`${place} names an output and one test, or a state`);
  if (tests.length > 1) fail(`${place} has two tests, ${tests[0] ?? ''} and ${tests[1] ?? ''}; a clause takes one`);
  const test = tests[0] as (typeof TESTS)[number];
  const raw = map[test];
  const at = `${place}.${test}`;
  switch (test) {
    case 'equals':
      return { step, output, equals: clauseValue(raw, at) };
    case 'in':
      if (!Array.isArray(raw) || raw.length === 0) fail(`${at} is a list of text, numbers, true or false`);
      return { step, output, in: (raw as unknown[]).map((v, i) => clauseValue(v, `${at}[${i}]`)) };
    case 'is':
      if (typeof raw !== 'boolean') fail(`${at} is true or false`);
      return { step, output, is: raw as boolean };
    case 'at_least':
    case 'at_most':
      if (typeof raw !== 'number' || !Number.isFinite(raw)) fail(`${at} is a number`);
      return test === 'at_least' ? { step, output, at_least: raw as number } : { step, output, at_most: raw as number };
  }
}

/** A step's `when` (workflow routing spec §3): clauses, every one of which must hold, and at most one `any` group. */
function whenOf(value: unknown, place: string, path: string): WhenItem[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) fail(`${place}.when is a list of clauses, at least one`);
  let anys = 0;
  return (value as unknown[]).map((item, i): WhenItem => {
    const at = `${place}.when[${i}]`;
    if (isRecord(item) && 'any' in item) {
      anys += 1;
      if (anys > 1) fail(`${place}.when has two any groups; it takes one`);
      reject(path, at, item, ['any'], HINTS);
      const group = item['any'];
      if (!Array.isArray(group) || group.length === 0) fail(`${at}.any is a list of clauses, at least one`);
      return {
        any: (group as unknown[]).map((c, n) => {
          if (isRecord(c) && 'any' in c) fail(`${at}.any[${n}] is a clause: an any group holds no other group`);
          return clauseOf(c, `${at}.any[${n}]`, path);
        }),
      };
    }
    return clauseOf(item, at, path);
  });
}

/** `on_blocked` and `on_gave_up` (workflow routing spec §5.1): `wait`, the default, or `{ route: <handler step> }`. */
function routeOf(value: unknown, place: string, path: string): RouteSpec {
  if (value === undefined || value === null || value === 'wait') return 'wait';
  if (!isRecord(value)) fail(`${place} is wait or { route: <handler step> }`);
  reject(path, place, value as Record<string, unknown>, ['route'], HINTS);
  return { route: stepName((value as Record<string, unknown>)['route'], `${place}.route`) };
}

/** A step's `wake`: true or false, or `{ role: <name> }` (wake spec §3.1, §19.1), checked as the other fields are. */
function stepWake(path: string, place: string, raw: unknown): boolean | { role: string } {
  if (typeof raw === 'boolean') return raw;
  if (!isRecord(raw)) fail(`${place}.wake is true, false or { role: <name> }`);
  const map = raw as Record<string, unknown>;
  reject(path, `${place}.wake`, map, ['role'], HINTS);
  const role = map['role'];
  if (typeof role !== 'string' || role.trim() === '') fail(`${place}.wake.role is a role's name`);
  return { role: role as string };
}

/** The list param a step fans out over, or undefined for none and for a result's fan-out (workflow routing spec §1). */
export function paramFanOut(step: Pick<WorkflowStep, 'forEach'>): string | undefined {
  return typeof step.forEach === 'string' ? step.forEach : undefined;
}

/** A cycle among the steps, as `a -> b -> a`, or undefined: a walk of the parents (workflows spec §4). */
function cycleOf(steps: readonly WorkflowStep[]): string | undefined {
  const parents = new Map(steps.map((s) => [s.name, s.parents]));
  const done = new Set<string>();
  const walk = (name: string, path: string[]): string | undefined => {
    const at = path.indexOf(name);
    if (at !== -1) return [...path.slice(at), name].join(' -> ');
    if (done.has(name)) return undefined;
    for (const parent of parents.get(name) ?? []) {
      const found = walk(parent, [...path, name]);
      if (found !== undefined) return found;
    }
    done.add(name);
    return undefined;
  };
  for (const s of steps) {
    const found = walk(s.name, []);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The workspace a step's tasks certainly work in, before any claim: its own, written out, or its role's (spec §2.3). */
function certainOf(step: WorkflowStep, roles: ReadonlyMap<string, Role>): string | undefined {
  if (step.workspace !== undefined) return step.workspace.includes('{{') ? undefined : step.workspace;
  const who = step.assignee;
  if (who === undefined || who.value.includes('{{') || who.value.includes(':')) return undefined;
  return roles.get(who.value)?.workspace;
}

/** Whether a step's own workspace is decided only at its claim: none of its own, written or a reference, and none from its role. */
function judgeable(step: WorkflowStep, roles: ReadonlyMap<string, Role>): boolean {
  if (step.workspace !== undefined) return false;
  const who = step.assignee;
  if (who !== undefined && who.value.includes('{{')) return false;
  if (who === undefined || who.value.includes(':')) return true;
  return roles.get(who.value)?.workspace === undefined;
}

/** A name field's checks: a reference to a text param or the item, or a name written out that `create` would take. */
function checkName(
  spec: NameSpec | undefined,
  place: string,
  params: ReadonlyMap<string, WorkflowParam>,
  forEach: boolean,
  facts: WorkflowFacts,
  kind: 'person' | 'workspace',
): void {
  if (spec === undefined) return;
  const where = spec.must === undefined ? place : `${place}.${spec.must}`;
  const ref = referenceOf(spec.value, where);
  if (ref !== undefined) {
    if (ref === ITEM) {
      if (!forEach) fail(`${where} uses {{item}}, which only a for_each step has`);
      return;
    }
    const param = params.get(ref);
    if (param === undefined) fail(`${where} names {{${ref}}}, which is no param this file declares`);
    if (param.list) fail(`${where} names {{${ref}}}, a list param: a name field takes one name, so a text param or {{item}}`);
    return;
  }
  const value = spec.value;
  if (kind === 'workspace') {
    if (!facts.workspaces.has(value)) fail(`${where}: workspace ${q(value)} is not configured`);
    return;
  }
  if (value.includes(':')) {
    if (spec.must === 'role') fail(`${where} is a role's place, and ${q(value)} is a person`);
    // A person written out is checked at a start, where talk tier is known.
    const r = assignable(value, { ...facts, canTalk: () => true });
    if (!r.ok) fail(`${where}: ${r.message}`);
    return;
  }
  if (spec.must === 'person') fail(`${where} is a person's place, and ${q(value)} is a role's name`);
  const r = assignable(value, facts);
  if (!r.ok) fail(`${where}: ${r.message}`);
}

/** The checks of the file alone and the team (workflows spec §4), on what `stepOf` and `paramOf` read. */
function checkWhole(steps: readonly WorkflowStep[], params: ReadonlyMap<string, WorkflowParam>, facts: WorkflowFacts): void {
  const names = new Set(steps.map((s) => s.name));
  for (const s of steps) {
    const place = `steps.${s.name}`;
    for (const parent of s.parents) {
      if (parent === s.name) fail(`${place}.parents names the step itself`);
      if (!names.has(parent)) fail(`${place}.parents names ${q(parent)}, which is no step of this file`);
      if (s.parents.indexOf(parent) !== s.parents.lastIndexOf(parent)) fail(`${place}.parents names ${parent} twice`);
    }
  }
  const cycle = cycleOf(steps);
  if (cycle !== undefined) fail(`the steps' parents make a cycle: ${cycle}`);
  const scope = routingScope(steps);
  const seen = new Set<string>();
  for (const s of steps) {
    const place = `steps.${s.name}`;
    // The tasks are made in the file's order, so a parent is written above its child (workflows spec §5).
    const later = s.parents.find((p) => !seen.has(p));
    if (later !== undefined) fail(`${place}.parents names ${later}, which is written after it: write a step below its parents`);
    seen.add(s.name);
    const over = paramFanOut(s);
    if (over !== undefined) {
      const param = params.get(over);
      if (param === undefined) fail(`${place}.for_each names ${q(over)}, which is no param this file declares`);
      if (!param.list) fail(`${place}.for_each names ${over}, a text param: for_each takes a list param`);
    }
    // A handler has an item when every step routing to it is a fan-out (workflow routing spec §5.2).
    const forEach = s.forEach !== undefined || (s.handler && scope.routedFrom(s.name).length > 0 && scope.routedFrom(s.name).every(isFanOut));
    const lateItem = typeof s.forEach === 'object' || s.handler;
    references(s.title, `${place}.title`, params, forEach, (step, output) => scope.result(s, step, output, `${place}.title`));
    if (s.body !== undefined) references(s.body, `${place}.body`, params, forEach, (step, output) => scope.result(s, step, output, `${place}.body`));
    for (const [key, field] of Object.entries(TEXT_FIELDS)) {
      const v = field === undefined ? undefined : s.contract[field];
      const at = `${place}.${key}`;
      // Values from results fill titles and bodies only (workflow routing spec §14).
      if (v !== undefined) references(v, at, params, forEach, (step, output) => fail(`${at} names {{${step}.${output}}}: a result fills only a title and a body`), lateItem);
    }
    for (const [key, spec] of [['assignee', s.assignee], ['reviewer', s.reviewer], ['workspace', s.workspace === undefined ? undefined : { value: s.workspace, must: undefined }]] as const) {
      const at = `${place}.${key}${spec?.must === undefined ? '' : `.${spec.must}`}`;
      if (lateItem && spec?.value === `{{${ITEM}}}`) fail(`${at} uses {{item}}, a result's: a result fills only a title and a body`);
    }
    checkName(s.assignee, `${place}.assignee`, params, forEach, facts, 'person');
    checkName(s.reviewer, `${place}.reviewer`, params, forEach, facts, 'person');
    checkName(s.workspace === undefined ? undefined : { value: s.workspace, must: undefined }, `${place}.workspace`, params, forEach, facts, 'workspace');
    for (const [i, gate] of s.gates.entries()) {
      const at = `${place}.gates[${i}].command`;
      // Never a param in a gate (workflows spec §2): it would let whoever starts a workflow write shell.
      if (gate.command.includes('{{')) fail(`${at} holds {{, and a gate is a shell command: name the value as an environment variable instead`);
      const problem = gateProblem(gate);
      if (problem !== undefined) fail(`${at} ${problem}`);
    }
    const together = gatesProblem(s.gates);
    if (together !== undefined) fail(`${place} ${together}`);
    if (judgeable(s, facts.roles)) {
      const theirs = [...new Set(s.parents.map((p) => steps.find((x) => x.name === p)).flatMap((p) => (p === undefined ? [] : [certainOf(p, facts.roles)])))].filter(
        (w): w is string => w !== undefined,
      );
      if (theirs.length > 1) {
        fail(
          `${place} has parents in different workspaces, ${theirs.join(' and ')}, and names no workspace, nor does its role: ` +
            `its tasks could not be given one at their claim; set ${place}.workspace`,
        );
      }
    }
    checkRouting(s, scope, facts.roles);
  }
}

// ---------------------------------------------------------------------------
// The routing checks (workflow routing spec §6)
// ---------------------------------------------------------------------------

/** What the routing checks read of the file's steps: each by name, its ancestors, and which are pending (§7.1). */
interface RoutingScope {
  byName: ReadonlyMap<string, WorkflowStep>;
  ancestors(name: string): ReadonlySet<string>;
  pending: ReadonlySet<string>;
  /** The steps whose `on_blocked` or `on_gave_up` routes to a handler, in the file's order. */
  routedFrom(handler: string): WorkflowStep[];
  /** A `{{<step>.<output>}}` in step `s`'s title or body, at `place`, judged (§1, §6). */
  result(s: WorkflowStep, step: string, output: string, place: string): void;
}

/**
 * The steps that are pending (workflow routing spec §7.1): a step with `when`, a
 * result `for_each`, or `handler: true`; a step any of whose parents is pending;
 * and a child of a step a handler may stand in for. The others are plain.
 */
export function pendingSteps(steps: readonly Pick<WorkflowStep, 'name' | 'parents' | 'when' | 'forEach' | 'handler' | 'standsInFor'>[]): Set<string> {
  const stoodIn = new Set(steps.flatMap((s) => (s.handler && s.standsInFor !== undefined ? [s.standsInFor] : [])));
  const pending = new Set<string>();
  const byName = new Map(steps.map((s) => [s.name, s]));
  const memo = new Map<string, boolean>();
  const isPending = (name: string): boolean => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    const s = byName.get(name);
    memo.set(name, false);
    const out =
      s !== undefined &&
      (s.when !== undefined || (s.forEach !== undefined && typeof s.forEach !== 'string') || s.handler || s.parents.some((p) => isPending(p) || stoodIn.has(p)));
    memo.set(name, out);
    return out;
  };
  for (const s of steps) if (isPending(s.name)) pending.add(s.name);
  return pending;
}

/**
 * Whether a file uses any routing key (workflow routing spec §7.1): outputs, a
 * `when`, a result fan-out, a route or a handler. A file using none expands
 * exactly as before, with no plan, and its check says what it said.
 */
export function usesRouting(w: Workflow): boolean {
  return w.steps.some(
    (s) => Object.keys(s.outputs).length > 0 || s.when !== undefined || typeof s.forEach === 'object' || s.onBlocked !== 'wait' || s.onGaveUp !== 'wait' || s.handler,
  );
}

/** A file's steps as the words of a check read them (§6): each with what makes it, plain, pending or a handler. */
export function stepShapes(w: Workflow): StepShape[] {
  const pending = pendingSteps(w.steps);
  return w.steps.map((s) => ({
    step: s.name,
    made: s.handler ? 'route' : pending.has(s.name) ? 'decide' : 'start',
    ...(s.when === undefined ? {} : { when: s.when }),
    ...(s.forEach === undefined ? {} : { for_each: typeof s.forEach === 'string' ? { param: s.forEach } : s.forEach }),
    on_blocked: s.onBlocked,
    on_gave_up: s.onGaveUp,
    ...(s.handler ? { handler: true as const } : {}),
    ...(s.standsInFor === undefined ? {} : { stands_in_for: s.standsInFor }),
  }));
}

/** A step's ancestors, transitively through its parents, memoized; the cycle check has run, so the walk ends. */
function ancestorsOf(byName: ReadonlyMap<string, WorkflowStep>): (name: string) => ReadonlySet<string> {
  const memo = new Map<string, Set<string>>();
  const walk = (name: string): Set<string> => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    const out = new Set<string>();
    memo.set(name, out);
    for (const p of byName.get(name)?.parents ?? []) {
      out.add(p);
      for (const a of walk(p)) out.add(a);
    }
    return out;
  };
  return walk;
}

/** A type as a check names it: `a boolean`, `a number`, `text`, `an enum`, `a list`. */
function typeWord(t: OutputType): string {
  if (t === 'boolean') return 'a boolean';
  if (t === 'number') return 'a number';
  if (t === 'string') return 'text';
  return 'enum' in t ? 'an enum' : 'a list';
}

/** A clause's value as a check names what it compares. */
function valueWord(v: ClauseValue): string {
  return typeof v === 'string' ? 'text' : typeof v === 'number' ? 'a number' : 'true or false';
}

/** A step's outputs as a check lists them: `reachable, score`, or `none`. */
function declared(outputs: Outputs): string {
  const names = Object.keys(outputs);
  return names.length === 0 ? 'none' : names.join(', ');
}

/** Whether a step is a fan-out, of either form. */
function isFanOut(s: WorkflowStep): boolean {
  return s.forEach !== undefined;
}

/** The handlers a step routes to, by `on_blocked` then `on_gave_up`. */
function routesOf(s: WorkflowStep): string[] {
  return [s.onBlocked, s.onGaveUp].flatMap((r) => (r === 'wait' ? [] : [r.route]));
}

/**
 * A handler's ancestors, for its references (workflow routing spec §5.2): those of
 * every step routing to it, the routed step itself excluded, as it has no result.
 */
function handlerAncestors(routed: readonly WorkflowStep[], ancestors: (name: string) => ReadonlySet<string>): Set<string> {
  const [first, ...rest] = routed;
  if (first === undefined) return new Set();
  return new Set([...ancestors(first.name)].filter((a) => rest.every((r) => ancestors(r.name).has(a))));
}

function routingScope(steps: readonly WorkflowStep[]): RoutingScope {
  const byName = new Map(steps.map((s) => [s.name, s]));
  const plain = ancestorsOf(byName);
  const routedFrom = (handler: string): WorkflowStep[] => steps.filter((s) => routesOf(s).includes(handler));
  // A handler has no parents: its ancestors are its routed steps' (§5.2).
  const ancestors = (name: string): ReadonlySet<string> => (byName.get(name)?.handler === true ? handlerAncestors(routedFrom(name), plain) : plain(name));
  const pending = pendingSteps(steps);
  const scope: RoutingScope = {
    byName,
    ancestors,
    pending,
    routedFrom,
    result(s, step, output, place) {
      const ref = `{{${step}.${output}}}`;
      if (!pending.has(s.name)) fail(`${place} names ${ref}, and ${s.name} is made at the start, before any result`);
      readable(scope, s, step, place, 'a reference reads only steps its parents come after');
      const target = byName.get(step) as WorkflowStep;
      if (isFanOut(target)) fail(`${place} names ${step}, a fan-out step, whose items each have their own result`);
      if (target.outputs[output] === undefined) fail(`${place} names ${step}.${output}, which ${step} does not declare (it declares ${declared(target.outputs)})`);
    },
  };
  return scope;
}

/** A step a clause, a fan-out or a reference of `s` reads, at `place`: one of the file's, and an ancestor of `s`. */
function readable(scope: RoutingScope, s: WorkflowStep, step: string, place: string, why: string): void {
  if (!scope.byName.has(step)) fail(`${place} names ${q(step)}, which is no step of this file`);
  if (scope.byName.get(step)?.handler === true) fail(`${place} names ${step}, a handler, which is made only when routed to and is no step's ancestor`);
  if (!scope.ancestors(s.name).has(step)) fail(`${place} names ${step}, which is not an ancestor of ${s.name}: ${why}`);
}

/** A clause's test against the output's declared type (§6), or why it cannot compare. */
function testProblem(c: Clause, type: OutputType, ref: string, at: string): string | undefined {
  if (typeof type === 'object' && 'list' in type) return `${at} names ${ref}, a list: a list is read by a fan-out only`;
  if ('is' in c) return type === 'boolean' ? undefined : `${at}: is compares true or false, and ${ref} is ${typeWord(type)}`;
  if ('at_least' in c || 'at_most' in c) {
    return type === 'number' ? undefined : `${at}: ${'at_least' in c ? 'at_least' : 'at_most'} compares a number, and ${ref} is ${typeWord(type)}`;
  }
  const test = 'equals' in c ? 'equals' : 'in';
  const values: ClauseValue[] = 'equals' in c ? [c.equals] : 'in' in c ? c.in : [];
  for (const v of values) {
    if (typeof type === 'object' && 'enum' in type) {
      if (typeof v !== 'string') return `${at}: ${test} compares ${valueWord(v)}, and ${ref} is an enum`;
      if (!type.enum.includes(v)) return `${at}: ${test} ${v} is not one of ${ref}'s values (${type.enum.join(', ')})`;
      continue;
    }
    const fits = (type === 'string' && typeof v === 'string') || (type === 'number' && typeof v === 'number') || (type === 'boolean' && typeof v === 'boolean');
    if (!fits) return `${at}: ${test} compares ${valueWord(v)}, and ${ref} is ${typeWord(type)}`;
  }
  return undefined;
}

/** One clause of `s`'s `when`, at `at` (§6). */
function checkClause(scope: RoutingScope, s: WorkflowStep, c: Clause, at: string): void {
  readable(scope, s, c.step, at, 'a condition reads only steps its parents come after');
  const target = scope.byName.get(c.step) as WorkflowStep;
  if (isFanOut(target)) fail(`${at} names ${c.step}, a fan-out step, whose items each have their own result`);
  if ('state' in c) return;
  const type = target.outputs[c.output];
  if (type === undefined) fail(`${at} names ${c.step}.${c.output}, which ${c.step} does not declare (it declares ${declared(target.outputs)})`);
  const problem = testProblem(c, type as OutputType, `${c.step}.${c.output}`, at);
  if (problem !== undefined) fail(problem);
}

/** Whether a name field is written as a person: `lark:…`, or `{ person: … }`. */
function writtenAsPerson(spec: NameSpec | undefined): boolean {
  return spec !== undefined && (spec.must === 'person' || (!spec.value.includes('{{') && spec.value.includes(':')));
}

/** An output's type, as a check says it: `boolean`, `enum cve, supplychain`, `list of string, max 100`. */
function typeShown(t: OutputType): string {
  if (typeof t === 'string') return t;
  if ('enum' in t) return `enum ${t.enum.join(', ')}`;
  return `list of ${typeShown(t.list)}, max ${t.max}`;
}

/** A step's outputs as a check lists them with their types: `reachable (boolean)`, or `none`. */
function typedOutputs(outputs: Outputs): string {
  const all = Object.entries(outputs);
  return all.length === 0 ? 'none' : all.map(([n, t]) => `${n} (${typeShown(t)})`).join(', ');
}

/** Whether two steps declare the same outputs, name for name and type for type. */
function sameOutputs(a: Outputs, b: Outputs): boolean {
  const names = Object.keys(a);
  return names.length === Object.keys(b).length && names.every((n) => b[n] !== undefined && typeShown(a[n] as OutputType) === typeShown(b[n] as OutputType));
}

/** A reviewer as a stand-in's check names it: `role assessment-reviewer`, a person or a reference as written, or `none`. */
function reviewerShown(spec: NameSpec | undefined): string {
  if (spec === undefined) return 'none';
  if (spec.must === 'person' || spec.value.includes('{{') || spec.value.includes(':')) return spec.value;
  return `role ${spec.value}`;
}

/** A handler's checks (workflow routing spec §5, §6): made only when routed to, never chaining, and a stand-in that takes its step's review, outputs, gates, contract and checkout. */
function checkHandler(s: WorkflowStep, scope: RoutingScope, roles: ReadonlyMap<string, Role>): void {
  const place = `steps.${s.name}`;
  if (s.parents.length > 0) fail(`${place} is a handler, made with no parents when routed to: it takes no parents`);
  if (s.when !== undefined) fail(`${place} is a handler, made only when routed to: it takes no when`);
  if (s.forEach !== undefined) fail(`${place} is a handler, made only when routed to: it takes no for_each`);
  for (const [key, r] of [['on_blocked', s.onBlocked], ['on_gave_up', s.onGaveUp]] as const) {
    if (r !== 'wait') fail(`${place} is a handler, and a handler's blocks wait for a person: it takes no ${key}, so routes never chain`);
  }
  const routed = scope.routedFrom(s.name);
  if (routed.length === 0) fail(`${place} is a handler, and no step routes to it: add on_blocked or on_gave_up: { route: ${s.name} } to the step it handles`);
  if (s.standsInFor === undefined) return;
  const name = s.standsInFor;
  const step = scope.byName.get(name);
  if (step === undefined) fail(`${place}.stands_in_for names ${q(name)}, which is no step of this file`);
  const theirs = step as WorkflowStep;
  if (!routed.includes(theirs)) fail(`${place} stands in for ${name}, which does not route to it`);
  if (!sameOutputs(theirs.outputs, s.outputs)) {
    fail(`${place} stands in for ${name}, and its outputs differ: ${name} declares ${typedOutputs(theirs.outputs)}, ${s.name} ${typedOutputs(s.outputs)}`);
  }
  if (s.reviewer !== undefined) fail(`${place} stands in for ${name}, and takes ${name}'s reviewer (${reviewerShown(theirs.reviewer)}): it names none of its own`);
  // The step's gates first, then its own, as addGate would take them (§5.2).
  const gates = [...theirs.gates, ...s.gates];
  if (gates.length > GATE_LIMITS.perTask) {
    fail(`${place} stands in for ${name}, and ${name}'s ${theirs.gates.length} gates with its own ${s.gates.length} are ${gates.length}: a task has at most ${GATE_LIMITS.perTask}`);
  }
  const total = gates.reduce((sum, g) => sum + g.timeoutS, 0);
  if (total > GATE_LIMITS.totalTimeoutS) {
    fail(`${place} stands in for ${name}, and ${name}'s gates with its own would take up to ${total} s together; at most ${GATE_LIMITS.totalTimeoutS} s`);
  }
  const merged = standInContract(name, { ...theirs.contract, ...(Object.keys(theirs.outputs).length > 0 ? { outcome: outcomeWithOutputs(theirs.contract.outcome, theirs.outputs) } : {}) }, s.contract);
  for (const field of CONTRACT_FIELDS) {
    const size = bytesOf(merged[field] ?? '');
    if (size > WORKER_LIMITS.contractField) fail(`${place} stands in for ${name}: its contract's ${field} with ${name}'s is ${size} bytes; at most ${WORKER_LIMITS.contractField}`);
  }
  const where = certainOf(theirs, roles);
  const own = certainOf(s, roles);
  if (where !== undefined && own !== undefined && where !== own) fail(`${place} stands in for ${name}, whose gates run in workspace ${where}, and ${s.name} works in ${own}`);
}

/** A step's routing checks (workflow routing spec §2.1, §3, §4, §6), after its own. */
function checkRouting(s: WorkflowStep, scope: RoutingScope, roles: ReadonlyMap<string, Role>): void {
  const place = `steps.${s.name}`;
  for (const p of s.parents) {
    if (scope.byName.get(p)?.handler === true) fail(`${place}.parents names ${p}, a handler, which is made only when routed to and is no step's parent`);
  }
  if (s.handler) checkHandler(s, scope, roles);
  else if (s.standsInFor !== undefined) fail(`${place} takes stands_in_for only as a handler (handler: true)`);
  for (const [key, r] of [['on_blocked', s.onBlocked], ['on_gave_up', s.onGaveUp]] as const) {
    if (r === 'wait' || s.handler) continue;
    const target = scope.byName.get(r.route);
    if (target === undefined) fail(`${place}.${key} routes to ${q(r.route)}, which is no step of this file`);
    if (!(target as WorkflowStep).handler) fail(`${place}.${key} routes to ${r.route}, which is not a handler (handler: true)`);
  }
  if (Object.keys(s.outputs).length > 0 && writtenAsPerson(s.assignee)) {
    fail(`${place} declares outputs, which a role's run reports in its metadata, and its assignee is a person: a person's done gives none`);
  }
  for (const [i, item] of (s.when ?? []).entries()) {
    if ('any' in item) for (const [n, c] of item.any.entries()) checkClause(scope, s, c, `${place}.when[${i}].any[${n}]`);
    else checkClause(scope, s, item, `${place}.when[${i}]`);
  }
  if (typeof s.forEach === 'object') {
    const { step, output } = s.forEach;
    const at = `${place}.for_each`;
    readable(scope, s, step, at, 'a fan-out reads only steps its parents come after');
    const source = scope.byName.get(step) as WorkflowStep;
    if (isFanOut(source)) fail(`${at} names ${step}, itself a fan-out: a fan-out over another fan-out's items is not supported`);
    const type = source.outputs[output];
    if (type === undefined) fail(`${at} names ${step}.${output}, which ${step} does not declare (it declares ${declared(source.outputs)})`);
    if (typeof type !== 'object' || !('list' in type)) fail(`${at} names ${step}.${output}, which is no list`);
  }
  if (Object.keys(s.outputs).length > 0) {
    const outcome = outcomeWithOutputs(s.contract.outcome, s.outputs);
    const size = bytesOf(outcome);
    if (size > WORKER_LIMITS.contractField) fail(`${place}.outcome with its outputs sentence is ${size} bytes; at most ${WORKER_LIMITS.contractField}`);
  }
}

/**
 * A workflow file's checks (workflows spec §4), from its text and the team: the YAML,
 * the keys and their types at every level, the names, the parents, for_each,
 * every reference, the roles and workspaces written out, the gates, and a step
 * whose parents certainly disagree on a workspace. The first problem, by its
 * place, or the workflow.
 */
export function checkWorkflow(name: string, source: string, facts: WorkflowFacts): { ok: true; workflow: Workflow } | { ok: false; problem: string } {
  // section and reject name the file; a problem names its place in it instead.
  const path = `${name}.yaml`;
  try {
    let parsed: unknown;
    try {
      parsed = parseYaml(source, { logLevel: 'error' });
    } catch (err) {
      // Its first line: the parser's message goes on to quote the file.
      fail(`the YAML does not parse: ${(err as Error).message.split('\n')[0] ?? ''}`);
    }
    const root = section(path, '', parsed ?? {});
    reject(path, '', root, ['description', 'board', 'params', 'steps'], HINTS);
    const description = optionalText(root['description'], 'description');
    // A board in the board grammar (workflows spec §19.1); null is absent, and "" no name.
    let board: string | undefined;
    if (root['board'] !== undefined && root['board'] !== null) {
      const b = text(root['board'], 'board');
      const bad = nameProblem('board', b);
      if (bad !== undefined) fail(`board: ${bad}`);
      board = b;
    }
    const paramsMap = root['params'] === undefined || root['params'] === null ? {} : section(path, 'params', root['params']);
    const params = Object.entries(paramsMap).map(([n, v]) => paramOf(n, v, path));
    if (root['steps'] === undefined || root['steps'] === null) fail('the file needs steps, at least one');
    const stepsMap = section(path, 'steps', root['steps']);
    // Every step makes at least one task, so a file past the bound could never start (workflows spec §4).
    const count = Object.keys(stepsMap).length;
    if (count > DAG_LIMITS.tasks) {
      fail(`the file has ${count} steps; a workflow has at most ${DAG_LIMITS.tasks}, as a start makes at least one task a step and an instance has at most ${DAG_LIMITS.tasks}`);
    }
    const steps = Object.entries(stepsMap).map(([n, v]) => stepOf(n, v, path));
    if (steps.length === 0) fail('the file needs steps, at least one');
    checkWhole(steps, new Map(params.map((p) => [p.name, p])), facts);
    return { ok: true, workflow: { name, description, board, params, steps } };
  } catch (err) {
    if (err instanceof Problem) return { ok: false, problem: err.message };
    if (err instanceof ConfigError) {
      const prefix = `${path}: `;
      return { ok: false, problem: err.message.startsWith(prefix) ? err.message.slice(prefix.length) : err.message };
    }
    throw err;
  }
}

/** Why an entry of the directory is no workflow, or undefined for one that is: a regular `<name>.yaml`, the name in the grammar. */
function notAWorkflow(dir: string, entry: string): string | undefined {
  if (!entry.endsWith('.yaml')) return 'not a .yaml file, so not a workflow';
  // An entry whose lstat fails is judged by its name only; its read then says why it is broken.
  const stat = statOf(join(dir, entry));
  if (stat === 'unreadable') return nameProblem('workflow', entry.slice(0, -'.yaml'.length));
  if (stat?.isSymbolicLink() === true) return 'a symlink, which is not followed: a workflow is a file of its own in the home';
  if (stat?.isFile() !== true) return 'not a regular file, so not a workflow';
  return nameProblem('workflow', entry.slice(0, -'.yaml'.length));
}

/** An entry's lstat, undefined for none, or `unreadable` when the lstat itself fails. */
function statOf(path: string): Stats | undefined | 'unreadable' {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch {
    return 'unreadable';
  }
}

/** Why a read failed, by its code: one file that cannot be read is one broken workflow, never a broken directory. */
function unreadable(err: unknown): { ok: false; problem: string } {
  const code = (err as NodeJS.ErrnoException).code;
  return { ok: false, problem: `the file cannot be read: ${typeof code === 'string' ? code : 'unknown error'}` };
}

/** A file's text, or why it cannot be a workflow: past 64 KiB, or not readable. */
function readFile(path: string): { ok: true; text: string } | { ok: false; problem: string } {
  try {
    const size = lstatSync(path).size;
    if (size > WORKFLOW_LIMITS.fileBytes) return { ok: false, problem: `the file is ${size} bytes; a workflow is at most ${WORKFLOW_LIMITS.fileBytes}` };
    return { ok: true, text: readFileSync(path, 'utf8') };
  } catch (err) {
    return unreadable(err);
  }
}

/**
 * The directory, read now (workflows spec §4): every usable workflow, by name, each
 * broken one with why, and every other entry that is no workflow, said once. A
 * dot-entry is skipped silently, as `discoverRoles` skips one, so the directory
 * can be under version control. A missing directory has none.
 */
export function listWorkflows(dir: string, facts: WorkflowFacts): WorkflowList {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { usable: [], broken: [], ignored: [] };
    throw new ConfigError(`cannot read ${dir}: ${(err as Error).message}`);
  }
  const out: WorkflowList = { usable: [], broken: [], ignored: [] };
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const why = notAWorkflow(dir, entry);
    if (why !== undefined) {
      out.ignored.push(`ignoring ${join(dir, entry)}: ${why}`);
      continue;
    }
    const name = entry.slice(0, -'.yaml'.length);
    const read = readFile(join(dir, entry));
    const checked = read.ok ? checkWorkflow(name, read.text, facts) : read;
    if (checked.ok) out.usable.push(checked.workflow);
    else out.broken.push({ name, problem: checked.problem });
  }
  return out;
}

function refuse(code: Refusal['code'], message: string): Refusal {
  return { ok: false, code, message };
}

/**
 * One workflow, read and checked now (workflows spec §4): `unknown_workflow` for a name
 * with no usable file of its own, `invalid` for a file that is broken.
 */
export function readWorkflow(dir: string, name: string, facts: WorkflowFacts): Result<{ workflow: Workflow }> {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) return refuse('unknown_workflow', `there is no workflow ${q(String(name))}`);
  const entry = `${name}.yaml`;
  const stat = statOf(join(dir, entry));
  if (stat === undefined) return refuse('unknown_workflow', `there is no workflow ${name}`);
  const why = notAWorkflow(dir, entry);
  if (why !== undefined) return refuse('unknown_workflow', `there is no workflow ${name}: ${join(dir, entry)} is ${why}`);
  const read = readFile(join(dir, entry));
  const checked = read.ok ? checkWorkflow(name, read.text, facts) : read;
  if (!checked.ok) return refuse('invalid', `workflow ${name} is not usable: ${checked.problem}`);
  return { ok: true, workflow: checked.workflow };
}

// ---------------------------------------------------------------------------
// A workflow's own board (workflows spec §19)
// ---------------------------------------------------------------------------

/** Where a start comes from, as the routing of workflows spec §19.2 reads it: the chat's board, the terminal's `--board` if given, a run's task's. */
export type BoardPath = { kind: 'chat'; board: string } | { kind: 'terminal'; board: string | undefined } | { kind: 'run'; board: string };

/**
 * The board a start goes on (workflows spec §19.2): the file's, from chat on any
 * board and from the terminal with no `--board` or the same one; a different
 * `--board`, and a run on another board, refused `other_board`. A file naming
 * none leaves the path's own, `default` at the terminal with no `--board`.
 */
export function startBoard(w: Workflow, path: BoardPath): Result<{ board: string; fromFile: boolean }> {
  const own = w.board;
  if (own === undefined) return { ok: true, board: path.board ?? 'default', fromFile: false };
  if (path.kind === 'terminal' && path.board !== undefined && path.board !== own) {
    return refuse('other_board', `workflow ${w.name} puts its tasks on board ${own}, not ${visible(path.board)}`);
  }
  if (path.kind === 'run' && path.board !== own) {
    return refuse('other_board', `workflow ${w.name} puts its tasks on board ${own}, and a run's work stays on its task's board, ${path.board}`);
  }
  return { ok: true, board: own, fromFile: true };
}

/** What the light read of a workflow file finds (workflows spec §19.3). */
export type WorkflowBoardRead = { file: 'unreadable' } | { file: 'read'; board: string | undefined };

/**
 * A workflow file's board alone (workflows spec §19.3): the entry as
 * `readWorkflow` takes it, the YAML parsed, and no team check. Unreadable for no
 * file, a name outside the grammar, an entry that is no regular file, one past
 * 64 KiB or YAML that does not parse; read with no board for a root that is no
 * mapping, or a board outside the grammar.
 */
export function workflowBoard(dir: string, name: string): WorkflowBoardRead {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) return { file: 'unreadable' };
  const entry = `${name}.yaml`;
  if (statOf(join(dir, entry)) === undefined || notAWorkflow(dir, entry) !== undefined) return { file: 'unreadable' };
  const read = readFile(join(dir, entry));
  if (!read.ok) return { file: 'unreadable' };
  let parsed: unknown;
  try {
    parsed = parseYaml(read.text, { logLevel: 'error' });
  } catch {
    return { file: 'unreadable' };
  }
  const b = isRecord(parsed) ? parsed['board'] : undefined;
  return { file: 'read', board: typeof b === 'string' && nameProblem('board', b) === undefined ? b : undefined };
}

/** The routing keys, as a refusal of a DAG path names them, in this order (workflow routing spec §13.5). */
const ROUTING_KEYS = ['outputs', 'when', 'for_each over an output', 'on_blocked', 'on_gave_up', 'handler'] as const;

/** Which routing keys a step uses, read from its YAML mapping as written: the same rules as `usesRouting`. */
function keysUsed(step: Record<string, unknown>): Set<string> {
  const used = new Set<string>();
  const set = (v: unknown): boolean => v !== undefined && v !== null;
  if (isRecord(step['outputs']) && Object.keys(step['outputs']).length > 0) used.add('outputs');
  if (set(step['when'])) used.add('when');
  if (isRecord(step['for_each'])) used.add('for_each over an output');
  if (set(step['on_blocked']) && step['on_blocked'] !== 'wait') used.add('on_blocked');
  if (set(step['on_gave_up']) && step['on_gave_up'] !== 'wait') used.add('on_gave_up');
  if (step['handler'] === true) used.add('handler');
  return used;
}

/** What the light read of a file's routing keys finds (workflow routing spec §13.5). */
export type WorkflowRoutingRead = { file: 'unreadable' } | { file: 'read'; keys: string[] };

/**
 * A workflow file's routing keys alone (workflow routing spec §13.5), by the light
 * read `workflowBoard` makes (workflows spec §19.3): the entry, the YAML parsed,
 * no team check; the keys its steps use, in the order a refusal names them.
 * Unreadable as `workflowBoard` finds one.
 */
export function workflowRouting(dir: string, name: string): WorkflowRoutingRead {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) return { file: 'unreadable' };
  const entry = `${name}.yaml`;
  if (statOf(join(dir, entry)) === undefined || notAWorkflow(dir, entry) !== undefined) return { file: 'unreadable' };
  const read = readFile(join(dir, entry));
  if (!read.ok) return { file: 'unreadable' };
  let parsed: unknown;
  try {
    parsed = parseYaml(read.text, { logLevel: 'error' });
  } catch {
    return { file: 'unreadable' };
  }
  const steps = isRecord(parsed) && isRecord(parsed['steps']) ? Object.values(parsed['steps']) : [];
  const used = new Set(steps.flatMap((st) => (isRecord(st) ? [...keysUsed(st)] : [])));
  return { file: 'read', keys: ROUTING_KEYS.filter((k) => used.has(k)) };
}

/** Why a DAG path refuses a file that uses routing keys (workflow routing spec §13.5): a DAG is a fixed graph. */
export function routedDagProblem(name: string, keys: readonly string[]): string {
  return `workflow ${name} uses ${keys.join(', ')}, which a DAG cannot carry: start it with workflow start`;
}

/** The routing keys a parsed file uses, in the order a refusal names them (workflow routing spec §13.5). */
export function routingKeys(w: Workflow): string[] {
  const used = new Set<string>();
  for (const s of w.steps) {
    if (Object.keys(s.outputs).length > 0) used.add('outputs');
    if (s.when !== undefined) used.add('when');
    if (typeof s.forEach === 'object') used.add('for_each over an output');
    if (s.onBlocked !== 'wait') used.add('on_blocked');
    if (s.onGaveUp !== 'wait') used.add('on_gave_up');
    if (s.handler) used.add('handler');
  }
  return ROUTING_KEYS.filter((k) => used.has(k));
}

/** Why a workflow is not usable when its board does not exist (workflows spec §19.4). */
export function missingBoardProblem(board: string): string {
  return `its board ${board} does not exist (create it with /kanban board create ${board}, or mt kanban board create ${board})`;
}

/** Why a workflow is not usable when its board is archived (workflows spec §19.4). */
export function archivedBoardProblem(board: string): string {
  return `its board ${board} is archived, and nothing is added to it (name another board in its file)`;
}

/**
 * A list judged against the boards (workflows spec §19.4): each usable workflow
 * whose board is missing or archived moved to `broken`, with its problem.
 * `boards` maps a board's name to whether it is archived.
 */
export function withBoards(list: WorkflowList, boards: ReadonlyMap<string, boolean>): WorkflowList {
  const usable: Workflow[] = [];
  const broken = [...list.broken];
  for (const w of list.usable) {
    const archived = w.board === undefined ? false : boards.get(w.board);
    if (w.board === undefined || archived === false) usable.push(w);
    else broken.push({ name: w.name, problem: archived === undefined ? missingBoardProblem(w.board) : archivedBoardProblem(w.board) });
  }
  broken.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { usable, broken, ignored: list.ignored };
}

/**
 * `unknown_workflow`'s message (workflows spec §6): `message`, then the usable
 * workflows and their params, at most `max` bytes, the names first, then the
 * params, saying how many were left out.
 */
export function usableMessage(message: string, usable: readonly Workflow[], max: number): string {
  if (usable.length === 0) return `${message}; there are no usable workflows`;
  // Room kept at each step for what may still be said after it.
  const room = 64;
  const fits = (text: string): boolean => Buffer.byteLength(text, 'utf8') + room <= max;
  let text = `${message}; the usable ones are`;
  let names = 0;
  for (const w of usable) {
    const next = `${text}${names === 0 ? ' ' : ', '}${w.name}`;
    if (!fits(next)) break;
    text = next;
    names += 1;
  }
  if (names < usable.length) text += ` and ${usable.length - names} more`;
  let params = 0;
  for (const w of usable.slice(0, names)) {
    const next = `${text}${params === 0 ? '; their params: ' : '; '}${w.name} takes ${paramsLine(w)}`;
    if (!fits(next)) break;
    text = next;
    params += 1;
  }
  if (params < names) text += `; the params of ${names - params} more left out`;
  return text;
}

/** A workflow's params, as `list` and `mt workflow check` say them: `topic (required), vendors (list, required), reviewer (default reviewer)`. */
export function paramsLine(w: Workflow): string {
  if (w.params.length === 0) return 'none';
  return w.params
    .map((p) => {
      const how = [
        ...(p.list ? ['list'] : []),
        p.required ? 'required' : `default ${Array.isArray(p.default) ? p.default.join(', ') : (p.default ?? '')}`,
      ];
      return `${p.name} (${how.join(', ')})`;
    })
    .join(', ');
}

/**
 * The startup's lines (workflows spec §4): one a broken workflow, one an entry that is
 * no workflow, then `workflows: <usable>; not usable: <broken>`, or
 * `workflows: none` for a missing or empty directory. Notes, which the gateway
 * masks: a broken workflow does not stop it.
 */
export function workflowLines(list: WorkflowList): string[] {
  const usable = list.usable.map((w) => w.name);
  const broken = list.broken.map((b) => b.name);
  return [
    ...list.broken.map((b) => `workflow ${b.name} is not usable: ${b.problem}`),
    ...list.ignored,
    `workflows: ${usable.length === 0 ? 'none' : usable.join(', ')}${broken.length === 0 ? '' : `; not usable: ${broken.join(', ')}`}`,
  ];
}

// ---------------------------------------------------------------------------
// Params and the expansion (workflows spec §2, §3, §5)
// ---------------------------------------------------------------------------

/** A pair as chat's parser reads it (workflows spec §6): a quoted value is one item of a list, never split. */
export interface ParamPair {
  key: string;
  value: string;
  quoted: boolean;
}

/**
 * The params a start was given, as each path gives them (workflows spec §6): chat's
 * pairs, the terminal's `--param key=value`, already unquoted by the shell, or
 * a run's JSON, where nothing is split.
 */
export type GivenParams =
  | { from: 'chat'; pairs: readonly ParamPair[] }
  | { from: 'terminal'; pairs: readonly { key: string; value: string }[] }
  | { from: 'json'; params: unknown };

/** How a value starting with `@`, in a param that lands in a person field, becomes a principal: chat's, by the message's mentions. */
export type PersonOf = (value: string) => Result<{ principal: string }>;

/** A name a param's refusal quotes: masked, as it is free text. */
function said(value: string): string {
  return q(redactKnownSecrets(value));
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** The params that land in a person field, as `"{{owner}}"` or `{ person: "{{owner}}" }`, and the list a person field's `{{item}}` comes from. */
function personParams(w: Workflow): Set<string> {
  const out = new Set<string>();
  for (const s of w.steps) {
    for (const spec of [s.assignee, s.reviewer]) {
      if (spec === undefined || spec.must === 'role') continue;
      const ref = REFERENCE.exec(spec.value)?.[1];
      if (ref === ITEM && paramFanOut(s) !== undefined) out.add(paramFanOut(s) ?? '');
      else if (ref !== undefined && ref !== ITEM) out.add(ref);
    }
  }
  return out;
}

/** The params whose values land in a title, by `{{name}}`, or by `{{item}}` in a for_each step. */
function titleParams(w: Workflow): Set<string> {
  const out = new Set<string>();
  for (const s of w.steps) {
    for (const m of s.title.matchAll(/\{\{([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)\}\}/g)) {
      const name = m[1] ?? '';
      if (name === ITEM && paramFanOut(s) !== undefined) out.add(paramFanOut(s) ?? '');
      else if (name !== ITEM) out.add(name);
    }
  }
  return out;
}

/**
 * The params of a start, against the file (workflows spec §2): every one declared,
 * the required ones given, the defaults filled in, a text param given once, a
 * list's items trimmed, none empty or twice or holding a known secret, the
 * sizes, a value landing in a title on one line, and `@` resolved only in a
 * param that lands in a person field. What a refusal says names the param.
 * With no `personOf`, an `@` in a person field is refused as the start's
 * `via` is told: at the terminal, that it has no mentions (kanban spec §22.2);
 * from a run, that a person is given work from chat.
 */
export function paramValues(w: Workflow, given: GivenParams, personOf?: PersonOf, via?: CreatedVia['kind']): Result<{ values: Map<string, ParamValue> }> {
  const declared = new Map(w.params.map((p) => [p.name, p]));
  const takes = w.params.length === 0 ? 'it takes none' : `it takes ${w.params.map((p) => p.name).join(', ')}`;
  const unknown = (key: string): Refusal => refuse('invalid', `workflow ${w.name} takes no param ${said(key)} (${takes})`);
  const raw = new Map<string, ParamValue>();
  if (given.from === 'json') {
    const params = given.params ?? {};
    if (!isRecord(params)) return refuse('invalid', 'params is an object of text and lists of text');
    for (const [key, value] of Object.entries(params)) {
      const p = declared.get(key);
      if (p === undefined) return unknown(key);
      if (p.list) {
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return refuse('invalid', `param ${key} is a list: give a list of text`);
        raw.set(key, [...(value as string[])]);
      } else {
        if (typeof value !== 'string') return refuse('invalid', `param ${key} is text: give it as text`);
        raw.set(key, value);
      }
    }
  } else {
    for (const pair of given.pairs) {
      const p = declared.get(pair.key);
      if (p === undefined) return unknown(pair.key);
      const before = raw.get(pair.key);
      if (!p.list) {
        if (before !== undefined) return refuse('invalid', `param ${pair.key} is given twice; it takes one value`);
        raw.set(pair.key, pair.value);
        continue;
      }
      // A quoted value from chat is one item; anything else is split at its commas (workflows spec §6).
      const items = given.from === 'chat' && (pair as ParamPair).quoted ? [pair.value] : pair.value.split(',');
      raw.set(pair.key, [...((before as string[] | undefined) ?? []), ...items]);
    }
  }
  const values = new Map<string, ParamValue>();
  const persons = personParams(w);
  const titled = titleParams(w);
  for (const p of w.params) {
    let value = raw.get(p.name) ?? p.default;
    if (value === undefined) return refuse('invalid', `workflow ${w.name} needs param ${p.name}${p.description === undefined ? '' : `: ${p.description}`}`);
    if (Array.isArray(value)) {
      if (value.length > DAG_LIMITS.listItems) return refuse('too_large', `param ${p.name} has ${value.length} items; a list has at most ${DAG_LIMITS.listItems}`);
      const items = value.map((v) => v.trim());
      if (items.length === 0) return refuse('invalid', `param ${p.name} is an empty list, and a step over it would make no tasks`);
      for (const [n, item] of items.entries()) {
        if (item === '') return refuse('invalid', `param ${p.name} has an empty item`);
        if (bytesOf(item) > DAG_LIMITS.valueBytes) return refuse('too_large', `an item of param ${p.name} is ${bytesOf(item)} bytes; at most ${DAG_LIMITS.valueBytes}`);
        if (items.indexOf(item) !== n) return refuse('invalid', `param ${p.name} names ${said(item)} twice; each item labels its task`);
        if (redactKnownSecrets(item) !== item) return refuse('invalid', `an item of param ${p.name} holds a known secret`);
      }
      value = items;
    } else if (bytesOf(value) > DAG_LIMITS.valueBytes) {
      return refuse('too_large', `param ${p.name} is ${bytesOf(value)} bytes; at most ${DAG_LIMITS.valueBytes}`);
    }
    const texts = typeof value === 'string' ? [value] : value;
    if (!texts.every((t) => t.isWellFormed())) return refuse('invalid', `param ${p.name} is not well formed text: a lone surrogate is no text`);
    if (titled.has(p.name) && texts.some((t) => titleRefused(t))) {
      return refuse('invalid', `param ${p.name} lands in a title, which is one line: it may hold no line break, control character or bidi control`);
    }
    if (persons.has(p.name) && personOf === undefined) {
      // At the terminal or from a run, no message carries a mention to resolve `@Name` by.
      const at = texts.find((t) => t.startsWith('@'));
      if (at !== undefined && via === 'operator') return refuse('invalid', NO_MENTIONS);
      if (at !== undefined) {
        return refuse(
          'person_not_assignable',
          `${said(at)} is a person: give a person work from chat, by @-mention, where the gateway can check they have talk tier`,
        );
      }
    }
    if (persons.has(p.name) && personOf !== undefined) {
      const resolved: string[] = [];
      for (const t of texts) {
        if (!t.startsWith('@')) {
          resolved.push(t);
          continue;
        }
        const r = personOf(t);
        if (!r.ok) return r;
        resolved.push(r.principal);
      }
      if (Array.isArray(value)) {
        // Two items may name one person, by a mention and a principal, or by two mentions of one person.
        const twice = resolved.find((item, n) => resolved.indexOf(item) !== n);
        if (twice !== undefined) return refuse('invalid', `param ${p.name} names ${said(twice)} twice; each item labels its task`);
      }
      value = typeof value === 'string' ? (resolved[0] ?? '') : resolved;
    }
    values.set(p.name, value);
  }
  const size = bytesOf(JSON.stringify(Object.fromEntries(values)));
  if (size > DAG_LIMITS.paramsBytes) return refuse('too_large', `the params are ${size} bytes as JSON; at most ${DAG_LIMITS.paramsBytes} together`);
  return { ok: true, values };
}

/** A name a field's reference gave, checked as a name (workflows spec §2): in the grammar, or a person's principal where a person may go. */
function nameGiven(value: string, place: string, spec: NameSpec, kind: 'person' | 'workspace', param: string): Refusal | undefined {
  const fills = `param ${param} fills ${place}`;
  if (redactKnownSecrets(value) !== value) return refuse('invalid', `${fills}, and its value holds a known secret: a name is stored as written`);
  if (kind === 'person' && value.includes(':')) {
    if (spec.must === 'role') return refuse('invalid', `${fills}, a role's place, and ${said(value)} is a person`);
    return undefined;
  }
  if (kind === 'person' && spec.must === 'person') return refuse('invalid', `${fills}, a person's place, and ${said(value)} is a role's name`);
  if (!NAME_PATTERN.test(value)) {
    return refuse('invalid', `${fills}, a ${kind === 'workspace' ? 'workspace' : 'role'} name, and ${said(value)} is none: ${nameProblem(kind === 'workspace' ? 'workspace' : 'role', value) ?? ''}`);
  }
  return undefined;
}

/**
 * The expansion (workflows spec §3, §5): the file made, with its params, into a DAG
 * of every task and link, every key written out. Each for_each step makes one
 * task an item, `<step>:<n>`; a step naming a for_each step as a parent waits
 * for all of its tasks, all to all. Substitution is text, once: a value is put
 * in as written, and not read again for braces. The DAG is shaped, measured and
 * its tasks checked by the caller, as any DAG is.
 */
export function expand(
  w: Workflow,
  given: GivenParams,
  board: string,
  personOf?: PersonOf,
  via?: CreatedVia['kind'],
): Result<{ dag: Dag; plan: Plan | null }> {
  const params = paramValues(w, given, personOf, via);
  if (!params.ok) return params;
  const values = params.values;
  const textOf = (name: string): string => {
    const v = values.get(name);
    return Array.isArray(v) ? v.join(', ') : (v ?? '');
  };
  // A file using no routing key expands exactly as before, with no plan (workflow routing spec §7.1).
  const routing = usesRouting(w);
  const pending = routing ? pendingSteps(w.steps) : new Set<string>();
  const plain = (x: WorkflowStep): boolean => !x.handler && !pending.has(x.name);
  const refsOf = new Map<string, string[]>();
  const tasks: DagTask[] = [];
  const planned: PlanStep[] = [];
  for (const s of w.steps) {
    const over = paramFanOut(s);
    // A result fan-out's item, and a handler's, is filled when its task is made (§7.4): left in place.
    const lateItem = typeof s.forEach === 'object' || s.handler;
    const items: Array<string | null> = over === undefined ? [null] : [...((values.get(over) as string[] | undefined) ?? [])];
    // A step made later has its title and body filled again then (workflow routing spec §7.4): a param's "{{" would read as a reference.
    if (!plain(s)) {
      for (const text of [s.title, s.body ?? '']) {
        for (const [, ref] of text.matchAll(/\{\{([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)\}\}/g)) {
          const param = ref === ITEM ? (lateItem ? undefined : over) : ref;
          const v = param === undefined ? undefined : values.get(param);
          if (param !== undefined && (Array.isArray(v) ? v.some((x) => x.includes('{{')) : (v ?? '').includes('{{'))) {
            return refuse('invalid', `param ${param} holds "{{", which a step made later would read as a reference: remove it`);
          }
        }
      }
    }
    const made: Array<{ item: string | null; template: Template }> = [];
    for (const item of items) {
      const sub = (t: string): string =>
        t.replace(/\{\{([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)\}\}/g, (m, name: string) => (name === ITEM ? (lateItem ? m : (item ?? '')) : textOf(name)));
      const name = (spec: NameSpec | undefined, place: string, kind: 'person' | 'workspace'): Result<{ value: string | null }> => {
        if (spec === undefined) return { ok: true, value: null };
        const ref = REFERENCE.exec(spec.value)?.[1];
        if (ref === undefined || REFERENCE.exec(spec.value)?.[0] !== spec.value) return { ok: true, value: spec.value };
        const value = ref === ITEM ? (item ?? '') : textOf(ref);
        const bad = nameGiven(value, place, spec, kind, ref === ITEM ? (over ?? ITEM) : ref);
        return bad ?? { ok: true, value };
      };
      const assignee = name(s.assignee, `steps.${s.name}.assignee`, 'person');
      if (!assignee.ok) return assignee;
      const reviewer = name(s.reviewer, `steps.${s.name}.reviewer`, 'person');
      if (!reviewer.ok) return reviewer;
      const workspace = name(s.workspace === undefined ? undefined : { value: s.workspace, must: undefined }, `steps.${s.name}.workspace`, 'workspace');
      if (!workspace.ok) return workspace;
      const contract: Contract = {};
      for (const [field, value] of Object.entries(s.contract) as [keyof Contract, string][]) contract[field] = sub(value);
      // The agent is told what to report, in its outcome (§2.1).
      if (Object.keys(s.outputs).length > 0) contract.outcome = outcomeWithOutputs(contract.outcome, s.outputs);
      const body = s.body === undefined ? null : sub(s.body);
      made.push({
        item,
        template: {
          title: sub(s.title),
          body: body === '' ? null : body,
          assignee: assignee.value,
          reviewer: reviewer.value,
          workspace: workspace.value,
          priority: s.priority ?? 0,
          contract,
          failure_limit: s.failureLimit ?? null,
          retry_on_crash: s.retryOnCrash ?? 'always',
          max_runtime_s: s.maxRuntimeS ?? null,
          gates: s.gates.map((g) => ({ command: g.command, timeout_s: g.timeoutS })),
          wake: null,
        },
      });
    }
    if (plain(s)) {
      const refs: string[] = [];
      for (const [n, { item, template: t }] of made.entries()) {
        const ref = over === undefined ? s.name : `${s.name}:${n + 1}`;
        refs.push(ref);
        tasks.push({
          ref,
          step: s.name,
          item,
          title: t.title,
          body: t.body,
          assignee: t.assignee,
          reviewer: t.reviewer,
          workspace: t.workspace,
          priority: t.priority,
          contract: t.contract,
          failure_limit: t.failure_limit,
          retry_on_crash: t.retry_on_crash,
          max_runtime_s: t.max_runtime_s,
          parents: s.parents.flatMap((p) => refsOf.get(p) ?? []),
          gates: t.gates,
          ...(s.wake === true ? { wake: true as const } : s.wake === false ? {} : { wake: { role: s.wake.role } }),
        });
      }
      refsOf.set(s.name, refs);
    }
    if (routing) planned.push(planStep(s, s.handler ? 'route' : plain(s) ? 'start' : 'decide', made, over));
    if (tasks.length > DAG_LIMITS.tasks) {
      const total = w.steps
        .filter(plain)
        .reduce((sum, x) => sum + (paramFanOut(x) === undefined ? 1 : ((values.get(paramFanOut(x) ?? '') as string[] | undefined)?.length ?? 0)), 0);
      return refuse('invalid', `workflow ${w.name} would make ${total} tasks with these params; an instance has at most ${DAG_LIMITS.tasks}`);
    }
  }
  const dag: Dag = { format: DAG_FORMAT, workflow: w.name, params: Object.fromEntries(values), board, tasks };
  if (!routing) return { ok: true, dag, plan: null };
  const plan: Plan = { format: PLAN_FORMAT, steps: planned };
  // Measured as a start's DAG is (§7.3).
  const size = bytesOf(JSON.stringify(plan));
  if (size > DAG_LIMITS.bytes) return refuse('too_large', `workflow ${w.name}'s plan is ${size} bytes with these params; it may be at most ${DAG_LIMITS.bytes}`);
  return { ok: true, dag, plan };
}

/** A step of the plan (workflow routing spec §7.3): what decides it, and its one template, or one an item of a list param. */
function planStep(s: WorkflowStep, made: PlanStep['made'], built: ReadonlyArray<{ item: string | null; template: Template }>, over: string | undefined): PlanStep {
  return {
    step: s.name,
    made,
    parents: [...s.parents],
    outputs: s.outputs,
    ...(s.when === undefined ? {} : { when: s.when }),
    ...(s.forEach === undefined ? {} : { for_each: typeof s.forEach === 'string' ? { param: s.forEach } : s.forEach }),
    on_blocked: s.onBlocked,
    on_gave_up: s.onGaveUp,
    ...(s.handler ? { handler: true as const } : {}),
    ...(s.standsInFor === undefined ? {} : { stands_in_for: s.standsInFor }),
    ...(over === undefined
      ? { template: (built[0] as { template: Template }).template }
      : { templates: built.map((b) => ({ ...b.template, item: b.item ?? '' })) }),
  };
}

// ---------------------------------------------------------------------------
// An instance's status (workflows spec §10)
// ---------------------------------------------------------------------------

export type InstanceStatus = 'archived' | 'done' | 'blocked' | 'running';

/** An instance's status, with how many of its members are finished, of how many, and how many are blocked. */
export interface InstanceState {
  status: InstanceStatus;
  /** Done or archived: an archived member counts as finished, as an archived parent does for its children (spec §4.1). */
  done: number;
  total: number;
  blocked: number;
}

/** A routed instance's steps not made (workflow routing spec §12.4): waiting, and skipped, before and after they settled. */
export interface UnmadeSteps {
  waiting: number;
  skippedUnsettled: number;
  skippedSettled: number;
}

const NONE_UNMADE: UnmadeSteps = { waiting: 0, skippedUnsettled: 0, skippedSettled: 0 };

/**
 * An instance's status, derived from its members' phases, never stored (workflows spec
 * §10): archived when every member is, done when every member is done or
 * archived, blocked when any is, and running otherwise. Blocked is checked before
 * running, as a blocked task is what a person must act on. A routed instance's
 * steps not made count too (workflow routing spec §12.4): a waiting step, and a
 * skipped one not yet settled, as one unfinished each, so it is never done while
 * one is; a skipped step settled, as finished; a handler never routed to, as
 * nothing.
 */
export function instanceStatus(phases: readonly Phase[], unmade: UnmadeSteps = NONE_UNMADE): InstanceState {
  const total = phases.length + unmade.waiting + unmade.skippedUnsettled + unmade.skippedSettled;
  const done = phases.filter((p) => p === 'done' || p === 'archived').length + unmade.skippedSettled;
  const blocked = phases.filter((p) => p === 'blocked').length;
  const status: InstanceStatus = phases.every((p) => p === 'archived')
    ? 'archived'
    : done === total
      ? 'done'
      : blocked > 0
        ? 'blocked'
        : 'running';
  return { status, done, total, blocked };
}
