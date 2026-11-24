import { lstatSync, readdirSync, readFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigError, reject, section } from '../config.js';
import { NAME_PATTERN, nameProblem, visible } from '../names.js';
import type { Role } from '../roles.js';
import { redactKnownSecrets } from '../secrets.js';
import { DAG_FORMAT, DAG_LIMITS, titleRefused, type Dag, type DagTask, type ParamValue } from './dag.js';
import { gateProblem, gatesProblem } from './gate-command.js';
import { assignable, isRecord, NO_MENTIONS, type TaskFacts } from './task-checks.js';
import { GATE_LIMITS, type Contract, type CreatedVia, type Phase, type Refusal, type Result, type RetryOnCrash } from './types.js';

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
  forEach: string | undefined;
  /**
   * `wake: true` (wake spec §3.1): its task's outcomes wake whoever starts it;
   * `wake: { role: <name> }` (§19.1), a reaction task for that role; default false.
   */
  wake: boolean | { role: string };
}

export interface Workflow {
  name: string;
  description: string | undefined;
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

/** Each `{{` in a text field opens a reference to a declared param, or to `item` in a for_each step (workflows spec §2). */
function references(value: string, place: string, params: ReadonlyMap<string, WorkflowParam>, forEach: boolean): void {
  for (let at = value.indexOf('{{'); at !== -1; at = value.indexOf('{{', at + 2)) {
    const m = REFERENCE.exec(value.slice(at));
    if (m === null) {
      fail(`${place} has a {{ that opens no reference: write {{name}}, a param's name with no spaces; a literal {{ cannot be written`);
    }
    const name = m[1] ?? '';
    if (name === ITEM) {
      if (!forEach) fail(`${place} uses {{item}}, which only a for_each step has`);
    } else if (!params.has(name)) {
      fail(`${place} names {{${name}}}, which is no param this file declares`);
    }
  }
}

/** The param a name field refers to, whole, or undefined for a name written out; a problem for anything between. */
function referenceOf(value: string, place: string): string | undefined {
  if (!value.includes('{{')) return undefined;
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
    forEach: optionalText(map['for_each'], `${place}.for_each`),
    wake,
  };
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
  const seen = new Set<string>();
  for (const s of steps) {
    const place = `steps.${s.name}`;
    // The tasks are made in the file's order, so a parent is written above its child (workflows spec §5).
    const later = s.parents.find((p) => !seen.has(p));
    if (later !== undefined) fail(`${place}.parents names ${later}, which is written after it: write a step below its parents`);
    seen.add(s.name);
    if (s.forEach !== undefined) {
      const param = params.get(s.forEach);
      if (param === undefined) fail(`${place}.for_each names ${q(s.forEach)}, which is no param this file declares`);
      if (!param.list) fail(`${place}.for_each names ${s.forEach}, a text param: for_each takes a list param`);
    }
    const forEach = s.forEach !== undefined;
    references(s.title, `${place}.title`, params, forEach);
    if (s.body !== undefined) references(s.body, `${place}.body`, params, forEach);
    for (const [key, field] of Object.entries(TEXT_FIELDS)) {
      const v = field === undefined ? undefined : s.contract[field];
      if (v !== undefined) references(v, `${place}.${key}`, params, forEach);
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
    reject(path, '', root, ['description', 'params', 'steps'], HINTS);
    const description = optionalText(root['description'], 'description');
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
    return { ok: true, workflow: { name, description, params, steps } };
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
      if (ref === ITEM && s.forEach !== undefined) out.add(s.forEach);
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
      if (name === ITEM && s.forEach !== undefined) out.add(s.forEach);
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
export function expand(w: Workflow, given: GivenParams, board: string, personOf?: PersonOf, via?: CreatedVia['kind']): Result<{ dag: Dag }> {
  const params = paramValues(w, given, personOf, via);
  if (!params.ok) return params;
  const values = params.values;
  const textOf = (name: string): string => {
    const v = values.get(name);
    return Array.isArray(v) ? v.join(', ') : (v ?? '');
  };
  const refsOf = new Map<string, string[]>();
  const tasks: DagTask[] = [];
  for (const s of w.steps) {
    const items: Array<string | null> = s.forEach === undefined ? [null] : [...((values.get(s.forEach) as string[] | undefined) ?? [])];
    const refs: string[] = [];
    for (const [n, item] of items.entries()) {
      const sub = (t: string): string => t.replace(/\{\{([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)\}\}/g, (_m, name: string) => (name === ITEM ? (item ?? '') : textOf(name)));
      const name = (spec: NameSpec | undefined, place: string, kind: 'person' | 'workspace'): Result<{ value: string | null }> => {
        if (spec === undefined) return { ok: true, value: null };
        const ref = REFERENCE.exec(spec.value)?.[1];
        if (ref === undefined || REFERENCE.exec(spec.value)?.[0] !== spec.value) return { ok: true, value: spec.value };
        const value = ref === ITEM ? (item ?? '') : textOf(ref);
        const bad = nameGiven(value, place, spec, kind, ref === ITEM ? (s.forEach ?? ITEM) : ref);
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
      const ref = s.forEach === undefined ? s.name : `${s.name}:${n + 1}`;
      refs.push(ref);
      const body = s.body === undefined ? null : sub(s.body);
      tasks.push({
        ref,
        step: s.name,
        item,
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
        parents: s.parents.flatMap((p) => refsOf.get(p) ?? []),
        gates: s.gates.map((g) => ({ command: g.command, timeout_s: g.timeoutS })),
        ...(s.wake === true ? { wake: true as const } : s.wake === false ? {} : { wake: { role: s.wake.role } }),
      });
    }
    refsOf.set(s.name, refs);
    if (tasks.length > DAG_LIMITS.tasks) {
      const total = w.steps.reduce((sum, x) => sum + (x.forEach === undefined ? 1 : ((values.get(x.forEach) as string[] | undefined)?.length ?? 0)), 0);
      return refuse('invalid', `workflow ${w.name} would make ${total} tasks with these params; an instance has at most ${DAG_LIMITS.tasks}`);
    }
  }
  return { ok: true, dag: { format: DAG_FORMAT, workflow: w.name, params: Object.fromEntries(values), board, tasks } };
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

/**
 * An instance's status, derived from its members' phases, never stored (workflows spec
 * §10): archived when every member is, done when every member is done or
 * archived, blocked when any is, and running otherwise. Blocked is checked before
 * running, as a blocked task is what a person must act on.
 */
export function instanceStatus(phases: readonly Phase[]): InstanceState {
  const total = phases.length;
  const done = phases.filter((p) => p === 'done' || p === 'archived').length;
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
