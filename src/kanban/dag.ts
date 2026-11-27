import { createHash } from 'node:crypto';
import { NAME_PATTERN, visible } from '../names.js';
import type { Role } from '../roles.js';
import { MASK, redactKnownSecrets } from '../secrets.js';
import { BIDI } from '../text.js';
import { gateProblem, gatesProblem } from './gate-command.js';
import { WORKER_LIMITS } from './limits.js';
import { checkTask, isRecord, NO_MENTIONS, type TaskFacts } from './task-checks.js';
import { CONTRACT_FIELDS, GATE_LIMITS, type Contract, type CreatedVia, type Refusal, type Result, type RetryOnCrash } from './types.js';

/**
 * The DAG (workflows spec §5): the tasks a start or an apply makes, and their links, as
 * one JSON document. Whatever path made it -- a workflow's expansion, a file at
 * the terminal, an agent's `apply-dag` -- an instance is made from a DAG, and
 * stores the DAG it was made from. Pure: what needs the database, the board and
 * the key, is the service's.
 *
 * A DAG is read, checked for its shape, made canonical and measured before
 * anything else; then each task is checked as `create` checks it, and each gate
 * as `addGate`, just before the transaction.
 */

/** The one format this build reads. */
export const DAG_FORMAT = 1;

export const DAG_LIMITS = {
  /** Tasks in one DAG, and so made at one start; an instance with a plan may make up to 500 in all. */
  tasks: 100,
  /** A ref's, and a step's, size in bytes. */
  refBytes: 64,
  /** A param's text, and each item of a list, in bytes. */
  valueBytes: 8 * 1024,
  /** Items in one list param. */
  listItems: 100,
  /** All the params together, serialized as JSON, in bytes. */
  paramsBytes: 64 * 1024,
  /** The canonical form from a run's `apply-dag`, which crosses the worker socket. */
  runBytes: 192 * 1024,
  /** The canonical form of a start's DAG, and of the terminal's apply. */
  bytes: 1024 * 1024,
  /** What the terminal's apply reads of a file or of stdin, before it is decoded. */
  rawBytes: 4 * 1024 * 1024,
} as const;

/** Where a DAG came from, which decides where its gates may come from (workflows spec §5). */
export type DagSource = 'terminal' | 'expansion' | 'run';

export type ParamValue = string | string[];

export interface DagGate {
  command: string;
  timeout_s: number;
}

/** A task of a DAG, every key with its value or its default, as the canonical form writes it. */
export interface DagTask {
  ref: string;
  step: string;
  item: string | null;
  title: string;
  body: string | null;
  assignee: string | null;
  reviewer: string | null;
  workspace: string | null;
  priority: number;
  contract: Contract;
  failure_limit: number | null;
  retry_on_crash: RetryOnCrash;
  max_runtime_s: number | null;
  parents: string[];
  gates: DagGate[];
  /**
   * `"wake": true` (wake spec §3.1): the task's outcomes wake whoever makes it.
   * Present only when true, so a DAG without wakes keeps its canonical form, and its hash.
   * `"wake": {"role": "<name>"}` (wake spec §19.1): a reaction task for that role.
   */
  wake?: true | { role: string };
}

export interface Dag {
  format: typeof DAG_FORMAT;
  workflow: string | null;
  params: Record<string, ParamValue>;
  board: string | null;
  tasks: DagTask[];
}

/** A DAG that passed its shape check: its canonical form, and that form's SHA-256, unmasked. */
export interface ShapedDag {
  dag: Dag;
  canonical: string;
  sha256: string;
}

const TOP_KEYS = ['format', 'workflow', 'params', 'board', 'tasks'] as const;
const TASK_KEYS = [
  'ref',
  'step',
  'item',
  'title',
  'body',
  'assignee',
  'reviewer',
  'workspace',
  'priority',
  'contract',
  'failure_limit',
  'retry_on_crash',
  'max_runtime_s',
  'parents',
  'gates',
  'wake',
] as const;
const GATE_KEYS = ['command', 'timeout_s'] as const;

/** A ref, and a step: letters, digits, `.`, `_`, `:` and `-`. */
const REF = /^[A-Za-z0-9._:-]+$/;

function refuse(code: Refusal['code'], message: string): Refusal {
  return { ok: false, code, message };
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** A value a refusal quotes: masked, cut, and its invisible characters shown; the routing's output check quotes a value by it too (workflow routing spec §2.2). */
export function shown(text: string, max = 80): string {
  const masked = redactKnownSecrets(text);
  return visible(JSON.stringify(masked.length <= max ? masked : `${masked.slice(0, max)}…`));
}

/** The first string anywhere in `value` that is not well formed, by its place; undefined when every one is. */
function illFormed(value: unknown, place: string): string | undefined {
  const stack: Array<[unknown, string]> = [[value, place]];
  while (stack.length > 0) {
    const [v, at] = stack.pop() as [unknown, string];
    if (typeof v === 'string') {
      if (!v.isWellFormed()) return at;
    } else if (Array.isArray(v)) {
      v.forEach((inner, i) => stack.push([inner, `${at}[${i}]`]));
    } else if (v !== null && typeof v === 'object') {
      for (const [key, inner] of Object.entries(v)) {
        if (!key.isWellFormed()) return at;
        stack.push([inner, at === '' ? key : `${at}.${key}`]);
      }
    }
  }
  return undefined;
}

/** A refusal unless `obj` has only `known` keys, naming the first other one and its place. */
function unknownKey(obj: Record<string, unknown>, known: readonly string[], place: string): Refusal | undefined {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      const where = place === '' ? 'a DAG' : place;
      return refuse('invalid', `${where} takes no key ${shown(key, 64)} (it takes ${known.join(', ')})`);
    }
  }
  return undefined;
}

/** Absent, the default; null, refused, as the key's default is not null. */
function notNull(value: unknown, place: string): Refusal | undefined {
  return value === null ? refuse('invalid', `${place} is null; leave it out for its default`) : undefined;
}

/** Text, or null; absent, null. */
function textOrNull(value: unknown, place: string): Result<{ value: string | null }> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return refuse('invalid', `${place} is text, or null`);
  return { ok: true, value };
}

/** A whole number, or null; absent, null. */
function wholeOrNull(value: unknown, place: string): Result<{ value: number | null }> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!Number.isSafeInteger(value)) return refuse('invalid', `${place} is a whole number, or null`);
  return { ok: true, value: value as number };
}

/** The params a DAG records (workflows spec §5): each named in the param grammar, text or a list of text, 64 KiB together. */
export function paramsShape(raw: unknown, place = 'params'): Result<{ params: Record<string, ParamValue> }> {
  if (raw === undefined) return { ok: true, params: {} };
  if (!isRecord(raw)) return refuse('invalid', `${place} is an object of text and lists of text`);
  const params: Record<string, ParamValue> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!NAME_PATTERN.test(name)) {
      return refuse(
        'invalid',
        `${place}.${shown(name, 64)} is not a param name: lowercase letters, digits and '-', starting with a letter, not ending with '-', at most 40 characters`,
      );
    }
    if (typeof value === 'string') params[name] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) params[name] = [...(value as string[])];
    else return refuse('invalid', `${place}.${name} is text, or a list of text`);
  }
  const size = bytes(JSON.stringify(params));
  if (size > DAG_LIMITS.paramsBytes) {
    return refuse('too_large', `the params are ${size} bytes as JSON; at most ${DAG_LIMITS.paramsBytes} together`);
  }
  return { ok: true, params };
}

/** The settings a run's DAG may not set but at their defaults, as its `create` takes none of them (workflows spec §5). */
const RUN_DEFAULTS = { priority: 0, failure_limit: null, retry_on_crash: 'always', max_runtime_s: null } as const;

/** One task's shape, with every default filled in; `refs` holds the refs of the tasks before it. */
function taskShape(raw: unknown, i: number, refs: ReadonlySet<string>, from: DagSource): Result<{ task: DagTask }> {
  let place = `tasks[${i}]`;
  if (!isRecord(raw)) return refuse('invalid', `${place} is an object`);
  const unknown = unknownKey(raw, TASK_KEYS, place);
  if (unknown !== undefined) return unknown;
  const { ref } = raw;
  if (ref === undefined || ref === null) return refuse('invalid', `${place} needs a ref`);
  if (typeof ref !== 'string' || ref === '' || bytes(ref) > DAG_LIMITS.refBytes || !REF.test(ref)) {
    return refuse('invalid', `${place}.ref is 1 to ${DAG_LIMITS.refBytes} bytes of letters, digits, '.', '_', ':' and '-'`);
  }
  // A ref names its task in every refusal after this one: one holding a known secret is refused here, unquoted.
  if (redactKnownSecrets(ref) !== ref) return refuse('invalid', `${place}.ref holds a known secret, and a ref is stored and shown as written`);
  if (refs.has(ref)) return refuse('invalid', `${place}.ref ${ref} is the ref of an earlier task too; a ref is unique in a DAG`);
  place = `tasks[${i}] (${ref})`;
  const nulls: Refusal | undefined = ['step', 'priority', 'contract', 'retry_on_crash', 'parents', 'gates']
    .map((key) => notNull(raw[key], `${place}.${key}`))
    .find((r) => r !== undefined);
  if (nulls !== undefined) return nulls;
  const step = raw.step ?? ref;
  if (typeof step !== 'string' || step === '' || bytes(step) > DAG_LIMITS.refBytes || !REF.test(step)) {
    return refuse('invalid', `${place}.step is 1 to ${DAG_LIMITS.refBytes} bytes of letters, digits, '.', '_', ':' and '-'`);
  }
  const item = textOrNull(raw.item, `${place}.item`);
  if (!item.ok) return item;
  if (item.value !== null && bytes(item.value) > DAG_LIMITS.valueBytes) {
    return refuse('too_large', `${place}.item is ${bytes(item.value)} bytes; an item is at most ${DAG_LIMITS.valueBytes}`);
  }
  if (typeof raw.title !== 'string') return refuse('invalid', `${place} needs a title, as text`);
  const body = textOrNull(raw.body, `${place}.body`);
  if (!body.ok) return body;
  const names: Record<'assignee' | 'reviewer' | 'workspace', string | null> = { assignee: null, reviewer: null, workspace: null };
  for (const key of ['assignee', 'reviewer', 'workspace'] as const) {
    const v = textOrNull(raw[key], `${place}.${key}`);
    if (!v.ok) return v;
    names[key] = v.value;
  }
  const priority = raw.priority ?? 0;
  if (!Number.isSafeInteger(priority)) return refuse('invalid', `${place}.priority is a whole number`);
  const contract: Contract = {};
  if (raw.contract !== undefined) {
    if (!isRecord(raw.contract)) return refuse('invalid', `${place}.contract is an object of text fields`);
    const bad = unknownKey(raw.contract, CONTRACT_FIELDS, `${place}.contract`);
    if (bad !== undefined) return bad;
    for (const field of CONTRACT_FIELDS) {
      const v = raw.contract[field];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string') return refuse('invalid', `${place}.contract.${field} is text`);
      contract[field] = v;
    }
  }
  const failureLimit = wholeOrNull(raw.failure_limit, `${place}.failure_limit`);
  if (!failureLimit.ok) return failureLimit;
  const maxRuntime = wholeOrNull(raw.max_runtime_s, `${place}.max_runtime_s`);
  if (!maxRuntime.ok) return maxRuntime;
  const retry = raw.retry_on_crash ?? 'always';
  if (retry !== 'always' && retry !== 'if-no-side-effects') {
    return refuse('invalid', `${place}.retry_on_crash is always or if-no-side-effects`);
  }
  const parentsRaw = raw.parents ?? [];
  if (!Array.isArray(parentsRaw) || !parentsRaw.every((p) => typeof p === 'string')) {
    return refuse('invalid', `${place}.parents is a list of refs`);
  }
  const parents = parentsRaw as string[];
  for (const [n, parent] of parents.entries()) {
    if (parents.indexOf(parent) !== n) return refuse('invalid', `${place}.parents names ${shown(parent, 64)} twice`);
    if (!refs.has(parent)) {
      return refuse(
        'invalid',
        `${place}.parents names ${shown(parent, 64)}, which is no ref earlier in the DAG: a parent comes before its child, and is one of the DAG's own tasks`,
      );
    }
  }
  const gatesRaw = raw.gates ?? [];
  if (!Array.isArray(gatesRaw)) return refuse('invalid', `${place}.gates is a list of { command, timeout_s }`);
  if (from === 'run' && gatesRaw.length > 0) {
    return refuse(
      'invalid',
      `${place} has gates, and apply-dag takes none: a gate is a shell command, and defining one is the operator's; ` +
        "a workflow file's gates come with start-workflow",
    );
  }
  const gates: DagGate[] = [];
  for (const [g, gate] of gatesRaw.entries()) {
    const at = `${place}.gates[${g}]`;
    if (!isRecord(gate)) return refuse('invalid', `${at} is an object, { command, timeout_s }`);
    const bad = unknownKey(gate, GATE_KEYS, at);
    if (bad !== undefined) return bad;
    if (typeof gate.command !== 'string') return refuse('invalid', `${at}.command is text`);
    const timeout = notNull(gate.timeout_s, `${at}.timeout_s`);
    if (timeout !== undefined) return timeout;
    const timeoutS = gate.timeout_s ?? GATE_LIMITS.defaultTimeoutS;
    if (!Number.isSafeInteger(timeoutS)) return refuse('invalid', `${at}.timeout_s is a whole number of seconds`);
    if (gate.command.includes(MASK)) {
      return refuse(
        'invalid',
        `${at}.command holds the mask ${MASK}: the DAG was printed masked, and a masked command would run broken; write the command out again`,
      );
    }
    gates.push({ command: gate.command, timeout_s: timeoutS as number });
  }
  const wake = raw.wake ?? false;
  const wakeRole =
    isRecord(wake) && Object.keys(wake).length === 1 && typeof wake['role'] === 'string' && wake['role'].trim() !== '' ? wake['role'] : undefined;
  if (typeof wake !== 'boolean' && wakeRole === undefined) {
    return refuse('invalid', `${place}.wake is true, false or {"role": "<name>"}`);
  }
  const task: DagTask = {
    ref,
    step,
    item: item.value,
    title: raw.title,
    // "" is no body, as create stores either.
    body: body.value === '' ? null : body.value,
    ...names,
    priority: priority as number,
    contract,
    failure_limit: failureLimit.value,
    retry_on_crash: retry,
    max_runtime_s: maxRuntime.value,
    parents: [...parents],
    gates,
    ...(wakeRole !== undefined ? { wake: { role: wakeRole } } : wake === true ? { wake: true as const } : {}),
  };
  if (from === 'run') {
    const set = (Object.keys(RUN_DEFAULTS) as (keyof typeof RUN_DEFAULTS)[]).filter((key) => task[key] !== RUN_DEFAULTS[key]);
    if (set.length > 0) {
      return refuse(
        'invalid',
        `${place} sets ${set.join(', ')}, and apply-dag takes no priority, failure_limit, retry_on_crash or max_runtime_s ` +
          "but at their defaults: they are the operator's, as mt kanban create takes none of them",
      );
    }
  }
  return { ok: true, task };
}

/**
 * A DAG's shape (workflows spec §5): its format, every key known, every type, every
 * string well formed, the refs and parents, where its gates came from, and from
 * a run the settings it may not set; then its canonical form, measured. Every
 * default filled in, so the DAG it answers is what the canonical form writes.
 */
export function checkDagShape(raw: unknown, from: DagSource): Result<ShapedDag> {
  if (!isRecord(raw)) return refuse('invalid', 'a DAG is a JSON object');
  const bad = illFormed(raw, '');
  if (bad !== undefined) {
    return refuse('invalid', `${bad === '' ? 'a key' : bad} is not well formed text: a lone surrogate, as \\ud800 gives, is no text`);
  }
  const unknown = unknownKey(raw, TOP_KEYS, '');
  if (unknown !== undefined) return unknown;
  if (raw.format === undefined || raw.format === null) return refuse('invalid', `a DAG needs its format, ${DAG_FORMAT}`);
  if (raw.format !== DAG_FORMAT) {
    return refuse('invalid', `the DAG is of format ${visible(String(JSON.stringify(raw.format))).slice(0, 32)}; this build reads format ${DAG_FORMAT}`);
  }
  const workflow = raw.workflow ?? null;
  if (workflow !== null && (typeof workflow !== 'string' || !NAME_PATTERN.test(workflow))) {
    return refuse('invalid', "workflow is a workflow's name, or null for a DAG with none");
  }
  // Checked in the shape, so before an apply's key lookup: the name is stored and shown, and a refusal never quotes it.
  if (workflow !== null && redactKnownSecrets(workflow) !== workflow) {
    return refuse('invalid', 'workflow holds a known secret, and a workflow name is stored and shown as written');
  }
  if (from === 'run' && workflow !== null) {
    return refuse(
      'invalid',
      "apply-dag takes no workflow name: a name would say the operator's file made the instance; start-workflow starts a workflow",
    );
  }
  const nulled = notNull(raw.params, 'params');
  if (nulled !== undefined) return nulled;
  const params = paramsShape(raw.params);
  if (!params.ok) return params;
  if (from === 'run' && Object.keys(params.params).length > 0) {
    return refuse('invalid', 'apply-dag takes no params: they would say a workflow was filled in, where an agent made its tasks');
  }
  const board = raw.board ?? null;
  if (board !== null && typeof board !== 'string') return refuse('invalid', "board is a board's name, or null for the path's own");
  if (!Array.isArray(raw.tasks)) return refuse('invalid', 'a DAG needs its tasks, a list');
  if (raw.tasks.length === 0 || raw.tasks.length > DAG_LIMITS.tasks) {
    return refuse('invalid', `a DAG has 1 to ${DAG_LIMITS.tasks} tasks; this one has ${raw.tasks.length}`);
  }
  const refs = new Set<string>();
  const tasks: DagTask[] = [];
  for (const [i, t] of raw.tasks.entries()) {
    const shaped = taskShape(t, i, refs, from);
    if (!shaped.ok) return shaped;
    refs.add(shaped.task.ref);
    tasks.push(shaped.task);
  }
  const dag: Dag = { format: DAG_FORMAT, workflow, params: params.params, board, tasks };
  const canonical = canonicalDag(dag);
  const size = bytes(canonical);
  const most = from === 'run' ? DAG_LIMITS.runBytes : DAG_LIMITS.bytes;
  if (size > most) {
    return refuse('too_large', `the DAG is ${size} bytes in its canonical form; it may be at most ${most}${from === 'run' ? ' from a run' : ''}`);
  }
  return { ok: true, dag, canonical, sha256: createHash('sha256').update(canonical, 'utf8').digest('hex') };
}

/**
 * A DAG read from text (workflows spec §5): parsed as JSON, then shaped. Text with a
 * byte order mark, which a strict decoding keeps, is not JSON.
 */
export function readDag(text: string, from: DagSource): Result<ShapedDag> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Not quoted: the text is the caller's, and may hold anything.
    return refuse('invalid', 'the DAG is not JSON');
  }
  return checkDagShape(raw, from);
}

/** The canonical object: every key in the tables' order, every default written, a contract's fields in order, the params by name. */
function canonicalObject(dag: Dag): Record<string, unknown> {
  const params: Record<string, ParamValue> = {};
  for (const name of Object.keys(dag.params).sort()) params[name] = dag.params[name] as ParamValue;
  return {
    format: dag.format,
    workflow: dag.workflow,
    params,
    board: dag.board,
    tasks: dag.tasks.map((t) => {
      const contract: Contract = {};
      for (const field of CONTRACT_FIELDS) if (t.contract[field] !== undefined) contract[field] = t.contract[field];
      return {
        ref: t.ref,
        step: t.step,
        item: t.item,
        title: t.title,
        body: t.body,
        assignee: t.assignee,
        reviewer: t.reviewer,
        workspace: t.workspace,
        priority: t.priority,
        contract,
        failure_limit: t.failure_limit,
        retry_on_crash: t.retry_on_crash,
        max_runtime_s: t.max_runtime_s,
        parents: t.parents,
        gates: t.gates.map((g) => ({ command: g.command, timeout_s: g.timeout_s })),
        ...(t.wake === true ? { wake: true } : t.wake === undefined ? {} : { wake: { role: t.wake.role } }),
      };
    }),
  };
}

/** The canonical form (workflows spec §5): compact JSON, unmasked, what a DAG is measured and hashed by on every path. */
export function canonicalDag(dag: Dag): string {
  return JSON.stringify(canonicalObject(dag));
}

/** The canonical form indented by two spaces: `preview --json`'s file, and `show --dag`'s, before they are masked. */
export function dagFile(dag: Dag): string {
  return JSON.stringify(canonicalObject(dag), null, 2);
}

/**
 * The DAG as an instance stores it (workflows spec §7): every text masked, value by
 * value, as an event payload is, but its gates' commands, stored as written, as
 * `kanban_gates` stores them. Names, refs and steps identify, and are kept.
 */
export function maskDag(dag: Dag): Dag {
  const mask = redactKnownSecrets;
  const params: Record<string, ParamValue> = {};
  for (const [name, value] of Object.entries(dag.params)) params[name] = typeof value === 'string' ? mask(value) : value.map(mask);
  return {
    ...dag,
    params,
    tasks: dag.tasks.map((t) => {
      const contract: Contract = {};
      for (const field of CONTRACT_FIELDS) {
        const v = t.contract[field];
        if (v !== undefined) contract[field] = mask(v);
      }
      return {
        ...t,
        item: t.item === null ? null : mask(t.item),
        title: mask(t.title),
        body: t.body === null ? null : mask(t.body),
        contract,
      };
    }),
  };
}

/** A task as a refusal names it (workflows spec §6): its ref, its step when that is not its ref, and its item. */
export function taskPlace(t: Pick<DagTask, 'ref' | 'step' | 'item'>): string {
  return `${t.ref}${t.step === t.ref ? '' : `, step ${t.step}`}${t.item === null ? '' : `, item ${shown(t.item)}`}`;
}

/** What a title may not hold: a line break or any other control character, and a bidi control (workflows spec §2). */
export function titleRefused(text: string): boolean {
  return /[\p{Cc}\u2028\u2029]/u.test(text) || new RegExp(BIDI.source).test(text);
}

/** How the tasks of a DAG are checked (workflows spec §6 step 2): who makes them, and whether a person may be named. */
export interface DagCheck {
  facts: TaskFacts;
  createdBy: string;
  createdVia: CreatedVia;
}

/** The workspace a task certainly works in, before any claim: its own, or its role's (spec §2.3 rules 1 and 2). */
function certainWorkspace(t: DagTask, roles: ReadonlyMap<string, Role>): string | undefined {
  if (t.workspace !== null) return t.workspace;
  if (t.assignee === null || t.assignee.includes(':')) return undefined;
  return roles.get(t.assignee)?.workspace;
}

/**
 * Each task of a shaped DAG checked as `create` checks it (workflows spec §6 step 2),
 * each gate as `addGate`, plus every name and item holding no known secret, a
 * title of one line, `task new`'s sizes, and a task whose parents certainly work
 * in different workspaces refused. The first failure refuses the whole DAG,
 * naming the task. A person is checked by `facts.canTalk`, at the terminal as
 * elsewhere; an @-mention there is refused, as no message carries it.
 */
export function checkDagTasks(dag: Dag, check: DagCheck): Refusal | undefined {
  const byRef = new Map(dag.tasks.map((t) => [t.ref, t]));
  const terminal = check.createdVia.kind === 'operator';
  for (const [i, t] of dag.tasks.entries()) {
    // A ref and a step are stored as written, and name the task in every refusal: one holding a secret is refused, unquoted.
    if (redactKnownSecrets(t.ref) !== t.ref || redactKnownSecrets(t.step) !== t.step) {
      return refuse('invalid', `tasks[${i}]: its ref or its step holds a known secret, and a ref is stored and shown as written`);
    }
    const at = taskPlace(t);
    const no = (code: Refusal['code'], why: string): Refusal => refuse(code, `${at}: ${why}`);
    if (t.title.trim() === '') return no('invalid', 'a task needs a title');
    if (titleRefused(t.title)) return no('invalid', 'its title is one line, with no control characters and no bidi controls');
    if (bytes(t.title) > WORKER_LIMITS.title) return no('too_large', `its title is ${bytes(t.title)} bytes; at most ${WORKER_LIMITS.title}`);
    if (t.body !== null && bytes(t.body) > WORKER_LIMITS.body) {
      return no('too_large', `its body is ${bytes(t.body)} bytes; at most ${WORKER_LIMITS.body}`);
    }
    for (const field of CONTRACT_FIELDS) {
      const v = t.contract[field];
      if (v !== undefined && bytes(v) > WORKER_LIMITS.contractField) {
        return no('too_large', `its contract's ${field} is ${bytes(v)} bytes; at most ${WORKER_LIMITS.contractField}`);
      }
    }
    for (const key of ['assignee', 'reviewer', 'workspace'] as const) {
      const v = t[key];
      // Names are stored unmasked, as they identify: one holding a secret is refused (workflows spec §2).
      if (v !== null && redactKnownSecrets(v) !== v) return no('invalid', `its ${key} holds a known secret, and a name is stored as written`);
    }
    if (t.item !== null && redactKnownSecrets(t.item) !== t.item) {
      return no('invalid', 'its item holds a known secret: an item labels its task, and two differing only in a secret would be one label');
    }
    // A person is checked as chat checks one, by `facts.canTalk`, wherever the DAG comes from (kanban spec §22.2);
    // at the terminal, an @-mention has no message to be resolved from.
    if (terminal && [t.assignee, t.reviewer].some((v) => v?.startsWith('@') === true)) return no('invalid', NO_MENTIONS);
    const checked = checkTask(
      {
        title: t.title,
        ...(t.body === null ? {} : { body: t.body }),
        contract: t.contract,
        ...(t.assignee === null ? {} : { assignee: t.assignee }),
        ...(t.reviewer === null ? {} : { reviewer: t.reviewer }),
        ...(t.workspace === null ? {} : { workspace: t.workspace }),
        priority: t.priority,
        ...(t.failure_limit === null ? {} : { failureLimit: t.failure_limit }),
        retryOnCrash: t.retry_on_crash,
        ...(t.max_runtime_s === null ? {} : { maxRuntimeS: t.max_runtime_s }),
        createdBy: check.createdBy,
        createdVia: check.createdVia,
      },
      check.facts,
    );
    if (!checked.ok) return no(checked.code, checked.message);
    for (const [g, gate] of t.gates.entries()) {
      const problem = gateProblem({ command: gate.command, timeoutS: gate.timeout_s });
      if (problem !== undefined) return no('invalid', `its gates[${g}].command ${problem}`);
    }
    const together = gatesProblem(t.gates.map((g) => ({ timeoutS: g.timeout_s })));
    if (together !== undefined) return no('invalid', `it ${together}`);
    if (certainWorkspace(t, check.facts.roles) === undefined && t.parents.length > 1) {
      const theirs = [
        ...new Set(
          t.parents.map((p) => byRef.get(p)).flatMap((p) => (p === undefined ? [] : [certainWorkspace(p, check.facts.roles)])),
        ),
      ].filter((w): w is string => w !== undefined);
      if (theirs.length > 1) {
        return no(
          'invalid',
          `its parents work in different workspaces, ${theirs.join(' and ')}, and it names none, nor does its role: ` +
            'it could not be given one at its claim; set its workspace',
        );
      }
    }
  }
  return undefined;
}
