import { redactKnownSecrets } from '../secrets.js';
import { DAG_LIMITS, shown, titleRefused, visible } from './dag.js';
import { CONTRACT_FIELDS, type Contract, type RetryOnCrash } from './types.js';

/**
 * Workflow routing (workflow routing spec): the plan an instance keeps, frozen
 * at its start (§7.3), and what decides, from it and the board's facts, which
 * of its pending steps are made, skipped, fanned out or routed (§10). Pure: it
 * imports no `db/` module, no service and no `workflow.ts`, so the writer,
 * `db/kanban.ts`, imports it as it imports `dag.ts`, and nothing here points
 * back (§9.3).
 */

/** The one plan format this build reads. */
export const PLAN_FORMAT = 1;

/** An output's type written as a bare word, or an enum (§2.1). */
export type ScalarType = 'boolean' | 'number' | 'string' | { enum: string[] };

/** An output's type: a scalar, or a list of one with its bound (§2.1). */
export type OutputType = ScalarType | { list: ScalarType; max: number };

/** A step's outputs, by name, in the order the file declares them. */
export type Outputs = Record<string, OutputType>;

/** A reported output's value, as JSON gives it. */
export type OutputValue = boolean | number | string | ReadonlyArray<boolean | number | string>;

/** What a clause compares an output with (§3). */
export type ClauseValue = string | number | boolean;

/** A step's state, as a clause reads it (§3.1). */
export type StepState = 'done' | 'skipped' | 'gave_up' | 'blocked';

/** One clause (§3): an ancestor's output and one test, or its state. */
export type Clause =
  | { step: string; output: string; equals: ClauseValue }
  | { step: string; output: string; in: ClauseValue[] }
  | { step: string; output: string; is: boolean }
  | { step: string; output: string; at_least: number }
  | { step: string; output: string; at_most: number }
  | { step: string; state: StepState };

/** An item of `when`: a clause, or the one `any` group (§3). */
export type WhenItem = Clause | { any: Clause[] };

/** `on_blocked` and `on_gave_up` (§5.1). */
export type RouteSpec = 'wait' | { route: string };

/** A late member's wake as the start resolved it (§7.3), the writer's `NewWake`; null for none. */
export interface PlanWake {
  by: string | null;
  depth: number;
  tooDeep?: true;
  role?: string;
}

/**
 * A task's fields as a DAG task has them (workflows spec §5), the params filled
 * in, `{{step.output}}` and a result fan-out's `{{item}}` left in place (§7.3).
 */
export interface Template {
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
  gates: Array<{ command: string; timeout_s: number }>;
  wake: PlanWake | null;
}

/** One step of the plan, every step of the file, in its order (§7.3). */
export interface PlanStep {
  step: string;
  /** `start` for a plain step, `decide` for a pending one, `route` for a handler (§7.1). */
  made: 'start' | 'decide' | 'route';
  parents: string[];
  /** Its declared outputs; empty for none. */
  outputs: Outputs;
  when?: WhenItem[];
  /** A result fan-out's source, or a list param's name. */
  for_each?: { step: string; output: string } | { param: string };
  on_blocked: RouteSpec;
  on_gave_up: RouteSpec;
  handler?: true;
  stands_in_for?: string;
  /** Its one task's template; for a step over a list param, `templates`, one an item. */
  template?: Template;
  templates?: Array<Template & { item: string }>;
}

/** An instance's plan, stored in `kanban_workflow_instances.plan` and never changed (§7.3). */
export interface Plan {
  format: typeof PLAN_FORMAT;
  steps: PlanStep[];
}

/** A pending row's state (§8): `skipped` is a pending row's only, never a task's phase. */
export type PendingState = 'waiting' | 'made' | 'skipped';

/** Why a step was skipped (§3.2, §4.1, §9.4, §13.1). */
export type SkippedBy = 'when' | 'source' | 'cap' | 'archive' | 'board' | 'instance';

/** How a member settled (§8). */
export type SettledHow = 'done' | 'stood_in' | 'skipped' | 'archived';

/** What a route row records (§5.3). */
export type RouteOutcome = 'made' | 'over_limit' | 'over_cap';

// ---------------------------------------------------------------------------
// The outputs sentence (§2.1)
// ---------------------------------------------------------------------------

/** A scalar type as the outputs sentence says it. */
function scalarWords(t: ScalarType): string {
  if (t === 'boolean') return 'true or false';
  if (t === 'number') return 'a number';
  if (t === 'string') return 'text';
  return `one of ${t.enum.join(', ')}`;
}

/** A list's items as the outputs sentence says them. */
function itemsWords(t: ScalarType): string {
  if (t === 'boolean') return 'true or false values';
  if (t === 'number') return 'numbers';
  if (t === 'string') return 'texts';
  return `values of ${t.enum.join(', ')}`;
}

/** An output's type as the outputs sentence says it: `true or false`, `a list of at most 50 texts`. */
export function typeWords(t: OutputType): string {
  if (typeof t === 'object' && 'list' in t) return `a list of at most ${t.max} ${itemsWords(t.list)}`;
  return scalarWords(t);
}

/**
 * The one sentence the expansion adds to a step's `outcome` when it declares
 * outputs (§2.1), so its agent knows what to report: `Report in the metadata of
 * your completion: reachable (true or false); packages (a list of at most 50 texts).`
 */
export function outputsSentence(outputs: Outputs): string {
  return `Report in the metadata of your completion: ${Object.entries(outputs)
    .map(([name, t]) => `${name} (${typeWords(t)})`)
    .join('; ')}.`;
}

/** A step's `outcome` with its outputs sentence after it, a blank line between; the outcome alone for a step with none. */
export function outcomeWithOutputs(outcome: string | undefined, outputs: Outputs): string {
  if (Object.keys(outputs).length === 0) return outcome ?? '';
  const sentence = outputsSentence(outputs);
  return outcome === undefined || outcome === '' ? sentence : `${outcome}\n\n${sentence}`;
}

// ---------------------------------------------------------------------------
// A stand-in's contract (§5.2)
// ---------------------------------------------------------------------------

/**
 * A stand-in's contract, merged per field (§5.2): for each field the step sets,
 * `the step's (<step>): <its text>`, then, when the handler sets it too, a blank
 * line and `this handler's: <its text>`; a field only the handler sets is its
 * text alone. The step's `outcome` carries its outputs sentence already.
 */
export function standInContract(step: string, theirs: Contract, own: Contract): Contract {
  const out: Contract = {};
  for (const field of CONTRACT_FIELDS) {
    const a = theirs[field];
    const b = own[field];
    if (a === undefined && b === undefined) continue;
    if (a === undefined) out[field] = b as string;
    else out[field] = b === undefined ? `the step's (${step}): ${a}` : `the step's (${step}): ${a}\n\nthis handler's: ${b}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// What a check, a preview and `show` say of a step (§6, §12)
// ---------------------------------------------------------------------------

/** What the words of a step read: a plan's step, or a file's as the check sees it. */
export type StepShape = Pick<PlanStep, 'step' | 'made' | 'when' | 'for_each' | 'on_blocked' | 'on_gave_up' | 'handler' | 'stands_in_for'>;

/** A clause's value as words say it: text as written, numbers and booleans as JSON writes them. */
function valueText(v: ClauseValue): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** A clause in words (§6): `va.reachable is true`, `intake.kind is one of cve, ghsa`, `va gave up`. */
export function clauseText(c: Clause): string {
  if ('state' in c) {
    if (c.state === 'gave_up') return `${c.step} gave up`;
    if (c.state === 'blocked') return `${c.step} blocked`;
    return `${c.step} is ${c.state}`;
  }
  const ref = `${c.step}.${c.output}`;
  if ('equals' in c) return `${ref} is ${valueText(c.equals)}`;
  if ('in' in c) return `${ref} is one of ${c.in.map(valueText).join(', ')}`;
  if ('is' in c) return `${ref} is ${c.is}`;
  if ('at_least' in c) return `${ref} is at least ${c.at_least}`;
  return `${ref} is at most ${c.at_most}`;
}

/** A `when` in words: its clauses joined by `and`, the `any` group in parentheses joined by `or`. */
export function whenText(when: readonly WhenItem[]): string {
  return when.map((item) => ('any' in item ? `(${item.any.map(clauseText).join(' or ')})` : clauseText(item))).join(' and ');
}

/** The steps that route to a handler, in the plan's order. */
export function routedFrom(steps: readonly StepShape[], handler: string): string[] {
  return steps.filter((s) => [s.on_blocked, s.on_gave_up].some((r) => r !== 'wait' && r.route === handler)).map((s) => s.step);
}

/**
 * What a check and a preview say of a step (§6): `always` for a plain step;
 * `per item of <step>.<output>` or `per item of <param>`, and `when <clauses>`,
 * for a pending one, or `when its parents are settled` with neither; `handler
 * for <steps>`, with `, standing in`; then its routes. With `max`, a result
 * fan-out says its list's bound, as a preview does (§12.3).
 */
export function stepWords(steps: readonly StepShape[], s: StepShape, max?: (fanOut: StepShape) => number | undefined): string {
  if (s.handler === true) return `handler for ${routedFrom(steps, s.step).join(', ')}${s.stands_in_for === undefined ? '' : ', standing in'}`;
  const parts: string[] = [];
  if (s.made === 'start') parts.push('always');
  else {
    const f = s.for_each;
    if (f !== undefined) {
      const bound = 'step' in f ? max?.(s) : undefined;
      parts.push(`per item of ${'step' in f ? `${f.step}.${f.output}` : f.param}${bound === undefined ? '' : `, at most ${bound}`}`);
    }
    if (s.when !== undefined) parts.push(`when ${whenText(s.when)}`);
    if (parts.length === 0) parts.push('when its parents are settled');
  }
  const routes = [
    ...(s.on_blocked === 'wait' ? [] : [`on blocked, routed to ${s.on_blocked.route}`]),
    ...(s.on_gave_up === 'wait' ? [] : [`on gave up, routed to ${s.on_gave_up.route}`]),
  ];
  return [parts.join(', '), ...routes].join('; ');
}

/** How many steps are plain, pending and handlers, as a check's line counts them (§6). */
export function stepCounts(steps: readonly StepShape[]): { always: number; onResults: number; handlers: number } {
  return {
    always: steps.filter((s) => s.made === 'start').length,
    onResults: steps.filter((s) => s.made === 'decide').length,
    handlers: steps.filter((s) => s.made === 'route').length,
  };
}

// ---------------------------------------------------------------------------
// Templates: masking, and the references filled (§7.3, §7.4)
// ---------------------------------------------------------------------------

/** Every `{{<step>.<output>}}` and `{{item}}` in a template's text. */
const LATE_REFERENCE = /\{\{([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)(?:\.([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?))?\}\}/g;

/**
 * A template's text with its references to results filled, once, as params are
 * (§7.4): each `{{<step>.<output>}}` by `result`, and `{{item}}` by `item` when
 * given. A param's reference was filled at the start, so none is left; any
 * other `{{` is left as written.
 */
export function fillText(text: string, result: (step: string, output: string) => string, item?: string): string {
  return text.replace(LATE_REFERENCE, (m, name: string, output: string | undefined) => {
    if (output !== undefined) return result(name, output);
    return name === 'item' && item !== undefined ? item : m;
  });
}

/** The text a skipped step's output fills a title or a body with (§7.4): a display placeholder, which nothing reads as a value. */
export const SKIPPED_TEXT = '(skipped)';

/** The widest JSON number, as `JSON.stringify` writes one: what a start checks a number's reference with. */
const WIDEST_NUMBER = '-1.7976931348623157e+308';

/**
 * What a start fills a reference with to check a template (§6): its type's widest
 * form where that is bounded, a boolean's `false`, a number's widest, an enum's
 * longest value, or `(skipped)` where that is wider; text and lists, whose widest
 * would pass every title's bound, `(skipped)`, as they are cut at the making.
 */
export function placeholderOf(t: OutputType | undefined): string {
  const widest = (s: ScalarType): string => {
    if (s === 'boolean') return 'false';
    if (s === 'number') return WIDEST_NUMBER;
    if (s === 'string') return SKIPPED_TEXT;
    return s.enum.reduce((a, b) => (Buffer.byteLength(b) > Buffer.byteLength(a) ? b : a), '');
  };
  if (t === undefined || (typeof t === 'object' && 'list' in t)) return SKIPPED_TEXT;
  const w = widest(t);
  return Buffer.byteLength(w) > Buffer.byteLength(SKIPPED_TEXT) ? w : SKIPPED_TEXT;
}

/** A list output's item as a start checks a template with it: its item type's widest bounded form. */
export function itemPlaceholderOf(t: OutputType | undefined): string {
  if (t !== undefined && typeof t === 'object' && 'list' in t) return placeholderOf(t.list);
  return SKIPPED_TEXT;
}

/** A template with each text masked, as the stored DAG's are (§7.3); its gates as written. */
function maskTemplate<T extends Template>(t: T, mask: (text: string) => string): T {
  const contract: Contract = {};
  for (const field of CONTRACT_FIELDS) {
    const v = t.contract[field];
    if (v !== undefined) contract[field] = mask(v);
  }
  return { ...t, title: mask(t.title), body: t.body === null ? null : mask(t.body), contract };
}

/**
 * The plan as an instance stores it (§7.3): its templates' text masked, value by
 * value, titles, bodies, contract fields and items, as the stored DAG's are; but
 * not its gates' commands, nor the clause and enum values, which a reported value
 * must still equal.
 */
export function maskPlan(plan: Plan, mask: (text: string) => string): Plan {
  return {
    ...plan,
    steps: plan.steps.map((s) => ({
      ...s,
      ...(s.template === undefined ? {} : { template: maskTemplate(s.template, mask) }),
      ...(s.templates === undefined ? {} : { templates: s.templates.map((t) => ({ ...maskTemplate(t, mask), item: mask(t.item) })) }),
    })),
  };
}

// ---------------------------------------------------------------------------
// The check at completion (§2.2)
// ---------------------------------------------------------------------------

/** What else a step's outputs are held to, by what reads them later in the plan (§2.2, §4.1). */
export interface OutputBounds {
  /** The list outputs a fan-out reads: their items are a list param's (§4.1). */
  fanned: ReadonlySet<string>;
  /** Of those, the ones whose fan-out puts `{{item}}` in a title: each item is one line. */
  titledItems: ReadonlySet<string>;
  /** The outputs a later title reads by `{{step.output}}`: one line, a list's items each. */
  titled: ReadonlySet<string>;
}

/** Every `{{<step>.<output>}}` in a text, as `[step, output]`. */
function resultRefs(text: string): Array<[string, string]> {
  return [...text.matchAll(LATE_REFERENCE)].flatMap((m) => (m[2] === undefined ? [] : [[m[1] ?? '', m[2]] as [string, string]]));
}

/** A step's templates, whichever it has. */
function templatesOf(s: PlanStep): Template[] {
  return s.templates ?? (s.template === undefined ? [] : [s.template]);
}

/** What step `step`'s outputs are held to, from the steps of the plan that read them (§2.2). */
export function outputBounds(plan: Plan, step: string): OutputBounds {
  const fanned = new Set<string>();
  const titledItems = new Set<string>();
  const titled = new Set<string>();
  for (const s of plan.steps) {
    const f = s.for_each;
    if (f !== undefined && 'step' in f && f.step === step) {
      fanned.add(f.output);
      if (templatesOf(s).some((t) => t.title.includes('{{item}}'))) titledItems.add(f.output);
    }
    for (const t of templatesOf(s)) for (const [from, output] of resultRefs(t.title)) if (from === step) titled.add(output);
  }
  return { fanned, titledItems, titled };
}

/** A value a refusal quotes (§2.2): as JSON writes it, masked, cut at 80 characters, and its invisible characters shown. */
function said(value: unknown): string {
  if (typeof value === 'string') return shown(value);
  const text = redactKnownSecrets(JSON.stringify(value) ?? String(value));
  return visible(text.length <= 80 ? text : `${text.slice(0, 80)}…`);
}

/** What a value is, as `got …` says it when it is no list. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'a boolean';
  return Array.isArray(value) ? 'a list' : 'an object';
}

/** A scalar's refusal, `<what> must be …; got …`, or undefined when the value is of its type. */
function scalarRefused(what: string, t: ScalarType, value: unknown): string | undefined {
  if (t === 'boolean') return typeof value === 'boolean' ? undefined : `${what} must be true or false; got ${said(value)}`;
  if (t === 'number') return typeof value === 'number' && Number.isFinite(value) ? undefined : `${what} must be a number; got ${said(value)}`;
  if (t === 'string') {
    if (typeof value !== 'string') return `${what} must be text; got ${said(value)}`;
    const size = Buffer.byteLength(value, 'utf8');
    return size > DAG_LIMITS.valueBytes ? `${what} is ${size} bytes; at most ${DAG_LIMITS.valueBytes}` : undefined;
  }
  return typeof value === 'string' && t.enum.includes(value) ? undefined : `${what} must be one of ${t.enum.join(', ')}; got ${said(value)}`;
}

/** A list's items as its refusal names them: `strings`, `numbers`, `booleans`, or an enum's values. */
function itemsNamed(t: ScalarType): string {
  if (typeof t === 'object') return `values of ${t.enum.join(', ')}`;
  return `${t}s`;
}

/** An item as the fan-out over it reads it (§4.1): text as given, numbers and booleans as JSON writes them, trimmed. */
export function itemText(value: boolean | number | string): string {
  return (typeof value === 'string' ? value : JSON.stringify(value)).trim();
}

/**
 * A report's metadata against the step's declared outputs (§2.2): every output a
 * top-level key, of its type; a list within its `max`, its items of their type;
 * a list a fan-out reads holding items as a list param's, none empty or twice or
 * holding a known secret, one line each when `{{item}}` lands in a title; a
 * value a later title reads one line. The first problem, in the declared
 * order, or undefined.
 */
export function checkOutputs(declared: Outputs, metadata: unknown, bounds: OutputBounds): string | undefined {
  const reported = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
  for (const [name, t] of Object.entries(declared)) {
    const what = `output ${name}`;
    if (!Object.hasOwn(reported, name)) return `${what} is missing`;
    const value = reported[name];
    if (typeof t === 'object' && 'list' in t) {
      if (!Array.isArray(value)) return `${what} must be a list of at most ${t.max} ${itemsNamed(t.list)}; got ${kindOf(value)}`;
      if (value.length > t.max) return `${what} must be a list of at most ${t.max} ${itemsNamed(t.list)}; got ${value.length}`;
      for (const [i, item] of value.entries()) {
        const bad = scalarRefused(`item ${i + 1} of ${what}`, t.list, item);
        if (bad !== undefined) return bad;
      }
      const items = (value as Array<boolean | number | string>).map(itemText);
      if (bounds.fanned.has(name)) {
        for (const [i, item] of items.entries()) {
          if (item === '') return `item ${i + 1} of ${what} is empty`;
          if (items.indexOf(item) !== i) return `${what} names ${shown(item)} twice; each item labels its task`;
          if (redactKnownSecrets(item) !== item) return `an item of ${what} holds a known secret`;
        }
      }
      if (bounds.titledItems.has(name) || bounds.titled.has(name)) {
        const n = items.findIndex((item) => titleRefused(item));
        if (n !== -1) return `item ${n + 1} of ${what} holds a line break, a control character or a bidi control, and an item lands in a title`;
      }
      continue;
    }
    const bad = scalarRefused(what, t, value);
    if (bad !== undefined) return bad;
    if (bounds.titled.has(name) && typeof value === 'string' && titleRefused(value)) {
      return `${what} holds a line break, a control character or a bidi control, and it lands in a title`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// decide(plan, facts) (§10)
// ---------------------------------------------------------------------------

/** The instance's most tasks, handlers included (§9.4, §19). */
export const INSTANCE_CAP = 500;

/** At most this many routes a routed task, counting only those made (§5.3). */
export const ROUTES_PER_TASK = 3;

/** A member's settling, as decide reads it: how, its winner, and the fact that settled it. */
export interface SettledFact {
  how: SettledHow;
  taskId: string | null;
  eventId: number;
}

/** One step, as the writer read it inside its transaction (§9.2 step 3). */
export interface StepFact {
  step: string;
  /** A pending step's row; null for a plain step or a handler. */
  row: PendingState | null;
  /** Why its row was skipped, when it was. */
  skippedBy: SkippedBy | null;
  /** The step's own settled row: its one member's, or a fan-out's own. */
  settled: SettledFact | null;
  /** A fan-out's item rows, by ref. */
  items: ReadonlyMap<string, SettledFact>;
  /** Whether its task entered `blocked` from its work, ever, by `on_blocked`'s or `on_gave_up`'s triggers (§3.2, §5.1). */
  entered: { blocked: boolean; gaveUp: boolean };
  /** Its settled winner's accepted metadata, as stored; null with no accepted result. */
  result: Readonly<Record<string, unknown>> | null;
}

/** A trigger event of a member's task, a route due for it (§5.1, §5.3). */
export interface RouteFact {
  taskId: string;
  step: string;
  ref: string;
  item: string | null;
  eventId: number;
  /** By §5.1's table, from the event: `blocked` routes by `on_blocked`, `gave_up` by `on_gave_up`. */
  kind: 'blocked' | 'gave_up';
  /** The transient limit's block, a `gave_up` the board's throttling stopped (§5.3's wording). */
  throttled: boolean;
  /** The block's kind, as the event recorded it: `capability`, `needs_input`, `transient`, `gave_up`. */
  blockKind: string;
  /** The block's reason, as the event recorded it. */
  reason: string;
  /** The routes made from the task so far (§5.3). */
  routes: number;
}

/** What decide reads (§10). */
export interface Facts {
  steps: ReadonlyMap<string, StepFact>;
  due: readonly RouteFact[];
  /** The instance's members, handlers included. */
  members: number;
  cap: number;
}

/** What decide finds due now (§10); waiting is the absence of a decision. */
export type Decision =
  | { step: string; outcome: 'made'; parents: string[]; why: string }
  | { step: string; outcome: 'skipped'; by: SkippedBy; why: string }
  | { step: string; outcome: 'fanned_out'; items: string[]; parents: string[]; why: string }
  | { step: string; outcome: 'settled'; how: 'skipped' | 'archived'; eventId: number }
  | { step: string; outcome: 'route'; handler: string; from: RouteFact; standsIn: boolean }
  | { step: string; outcome: 'over_limit' | 'over_cap'; handler: string; from: RouteFact };

type Truth = 'true' | 'false' | 'undecided';

/** A value as a reason says it: text as given, numbers and booleans as JSON writes them, a list as its items. */
export function valueSaid(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => valueSaid(v)).join(', ');
  return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
}

/** Whether a stored value is of its declared type (§2.3): anything else reads as missing. */
export function ofType(t: OutputType | undefined, value: unknown): boolean {
  if (t === undefined) return false;
  const scalar = (s: ScalarType, v: unknown): boolean => {
    if (s === 'boolean') return typeof v === 'boolean';
    if (s === 'number') return typeof v === 'number' && Number.isFinite(v);
    if (s === 'string') return typeof v === 'string';
    return typeof v === 'string' && s.enum.includes(v);
  };
  if (typeof t === 'object' && 'list' in t) return Array.isArray(value) && value.length <= t.max && value.every((v) => scalar(t.list, v));
  return scalar(t, value);
}

/** Whether a settled row is an accepted result (§2.3): its own task's or a stand-in's completion. */
function accepted(s: SettledFact | null): boolean {
  return s !== null && (s.how === 'done' || s.how === 'stood_in');
}

/** A step's accepted value of one output, of its declared type; undefined for none (§2.3, §3). */
export function resultOf(plan: Plan, facts: Facts, step: string, output: string): unknown {
  const fact = facts.steps.get(step);
  if (fact === undefined || !accepted(fact.settled) || fact.result === null) return undefined;
  const value = fact.result[output];
  const type = plan.steps.find((s) => s.step === step)?.outputs[output];
  return ofType(type, value) ? value : undefined;
}

/** One clause, as the facts decide it now (§3.1, §3.2), and why it is false when it is. */
function clause(plan: Plan, facts: Facts, c: Clause): { truth: Truth; why: string } {
  const fact = facts.steps.get(c.step);
  // A step decide does not know is unsettled: never an exception (§10).
  if (fact === undefined) return { truth: 'undecided', why: '' };
  const settled = fact.settled;
  if ('state' in c) {
    if (c.state === 'blocked' || c.state === 'gave_up') {
      const entered = c.state === 'blocked' ? fact.entered.blocked : fact.entered.gaveUp;
      if (entered) return { truth: 'true', why: '' };
      return settled === null ? { truth: 'undecided', why: '' } : { truth: 'false', why: c.state === 'blocked' ? `${c.step} did not block` : `${c.step} did not give up` };
    }
    if (settled === null) return { truth: 'undecided', why: '' };
    const done = accepted(settled);
    if (c.state === 'done') return done ? { truth: 'true', why: '' } : { truth: 'false', why: `${c.step} was ${settled.how === 'archived' ? 'archived' : 'skipped'}` };
    return done ? { truth: 'false', why: `${c.step} is done` } : { truth: 'true', why: '' };
  }
  if (settled === null) return { truth: 'undecided', why: '' };
  if (!accepted(settled)) return { truth: 'false', why: `${c.step} was ${settled.how === 'archived' ? 'archived' : 'skipped'}` };
  const ref = `${c.step}.${c.output}`;
  const value = resultOf(plan, facts, c.step, c.output);
  if (value === undefined) return { truth: 'false', why: `${ref} is missing` };
  const why = `${ref} is ${valueSaid(value)}`;
  let holds: boolean;
  if ('equals' in c) holds = value === c.equals;
  else if ('in' in c) holds = c.in.includes(value as ClauseValue);
  else if ('is' in c) holds = value === c.is;
  else if ('at_least' in c) holds = typeof value === 'number' && value >= c.at_least;
  else holds = typeof value === 'number' && value <= c.at_most;
  return holds ? { truth: 'true', why: '' } : { truth: 'false', why };
}

/** A step's `when`, decided now (§3.2): certainly false at its first false clause, true once every clause holds. */
function when(plan: Plan, facts: Facts, items: readonly WhenItem[] | undefined): { truth: Truth; why: string } {
  if (items === undefined) return { truth: 'true', why: '' };
  let undecided = false;
  for (const item of items) {
    if ('any' in item) {
      const each = item.any.map((c) => clause(plan, facts, c));
      if (each.some((r) => r.truth === 'true')) continue;
      if (each.every((r) => r.truth === 'false')) return { truth: 'false', why: each[0]?.why ?? '' };
      undecided = true;
      continue;
    }
    const r = clause(plan, facts, item);
    if (r.truth === 'false') return r;
    if (r.truth === 'undecided') undecided = true;
  }
  return undecided ? { truth: 'undecided', why: '' } : { truth: 'true', why: '' };
}

/** The steps a `when` reads by a `state: blocked` or `state: gave_up` clause that holds now: not waited for, not linked (§3.2). */
function stuckParents(facts: Facts, items: readonly WhenItem[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const item of items ?? []) {
    for (const c of 'any' in item ? item.any : [item]) {
      if (!('state' in c) || (c.state !== 'blocked' && c.state !== 'gave_up')) continue;
      const f = facts.steps.get(c.step);
      if (f !== undefined && (c.state === 'blocked' ? f.entered.blocked : f.entered.gaveUp)) out.add(c.step);
    }
  }
  return out;
}

/**
 * A step's effective parents (§3.2), as task ids: a done step's winning task, a
 * fan-out's items' winners, none archived undone; a step skipped otherwise, its
 * own effective parents, recursively; a step skipped by archive, none.
 */
export function effectiveParents(plan: Plan, facts: Facts, steps: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const fact = facts.steps.get(name);
    const settled = fact?.settled ?? null;
    if (fact === undefined || settled === null || settled.how === 'archived') return;
    if (settled.how === 'skipped') {
      for (const p of plan.steps.find((s) => s.step === name)?.parents ?? []) walk(p);
      return;
    }
    const winners = fact.items.size > 0 ? [...fact.items.values()].filter(accepted).map((i) => i.taskId) : [settled.taskId];
    for (const id of winners) if (id !== null && !out.includes(id)) out.push(id);
  };
  for (const s of steps) walk(s);
  return out;
}

/** The greatest event id of the steps' settled rows: the settling that let a skipped step count (§8). */
function latestOf(facts: Facts, steps: readonly string[]): number {
  return steps.reduce((most, s) => Math.max(most, facts.steps.get(s)?.settled?.eventId ?? 0), 0);
}

/**
 * What is due now (§10), in the plan's order: each waiting step decided once its
 * `when` is certain, made once its parents are settled, or skipped; each skipped
 * step settled once its parents are. Pure and total: a missing result, a value of
 * the wrong type, an unknown step read as false or unsettled, never thrown.
 */
export function decide(plan: Plan, facts: Facts): Decision[] {
  const out: Decision[] = [];
  let members = facts.members;
  for (const s of plan.steps) {
    const fact = facts.steps.get(s.step);
    if (fact === undefined) continue;
    if (fact.row === 'skipped' && fact.settled === null) {
      if (!s.parents.every((p) => facts.steps.get(p)?.settled != null)) continue;
      const archived = fact.skippedBy === 'archive' || (s.parents.length > 0 && s.parents.every((p) => facts.steps.get(p)?.settled?.how === 'archived'));
      out.push({ step: s.step, outcome: 'settled', how: archived ? 'archived' : 'skipped', eventId: latestOf(facts, s.parents) });
      continue;
    }
    if (fact.row !== 'waiting') continue;
    const w = when(plan, facts, s.when);
    if (w.truth === 'undecided') continue;
    if (w.truth === 'false') {
      out.push({ step: s.step, outcome: 'skipped', by: 'when', why: w.why });
      continue;
    }
    const stuck = stuckParents(facts, s.when);
    const waited = s.parents.filter((p) => !stuck.has(p));
    if (!waited.every((p) => facts.steps.get(p)?.settled != null)) continue;
    // A fan-out over a result waits for its source too, which may be an ancestor above its parents (§4.1).
    const source = s.for_each !== undefined && 'step' in s.for_each ? s.for_each : undefined;
    const from = source === undefined ? undefined : facts.steps.get(source.step)?.settled;
    if (source !== undefined && (from === undefined || from === null)) continue;
    if (waited.length > 0 && waited.every((p) => facts.steps.get(p)?.settled?.how === 'archived')) {
      out.push({ step: s.step, outcome: 'skipped', by: 'archive', why: 'its parents were archived' });
      continue;
    }
    let items: string[] | undefined = s.templates?.map((t) => t.item);
    if (source !== undefined && from !== undefined && from !== null) {
      // The logical step's accepted list, its own task's or a stand-in's, never its task's phase (§4.1).
      if (!accepted(from)) {
        out.push({ step: s.step, outcome: 'skipped', by: 'source', why: `${source.step} was ${from.how === 'archived' ? 'archived' : 'skipped'}` });
        continue;
      }
      const list = resultOf(plan, facts, source.step, source.output);
      const ref = `${source.step}.${source.output}`;
      if (!Array.isArray(list)) {
        out.push({ step: s.step, outcome: 'skipped', by: 'source', why: `${ref} is missing` });
        continue;
      }
      if (list.length === 0) {
        out.push({ step: s.step, outcome: 'skipped', by: 'source', why: `${ref} is empty` });
        continue;
      }
      items = (list as Array<boolean | number | string>).map(itemText);
    }
    const why = s.when === undefined ? (source === undefined ? 'its parents are settled' : `per item of ${source.step}.${source.output}`) : whenText(s.when);
    const parents = effectiveParents(plan, facts, waited);
    // A fan-out is made whole or not at all (§9.4).
    const count = items?.length ?? 1;
    if (members + count > facts.cap) {
      out.push({ step: s.step, outcome: 'skipped', by: 'cap', why: `the instance has ${facts.cap} tasks` });
      continue;
    }
    members += count;
    if (items !== undefined) out.push({ step: s.step, outcome: 'fanned_out', items, parents, why });
    else out.push({ step: s.step, outcome: 'made', parents, why });
  }
  for (const r of facts.due) {
    const s = plan.steps.find((x) => x.step === r.step);
    if (s === undefined) continue;
    const spec = r.kind === 'gave_up' ? s.on_gave_up : s.on_blocked;
    if (spec === 'wait') continue;
    const handler = plan.steps.find((x) => x.step === spec.route && x.handler === true);
    if (handler === undefined) continue;
    // No route from a member already settled: the first to complete wins (§5.1).
    const fact = facts.steps.get(r.step);
    const settled = r.ref === r.step ? fact?.settled : fact?.items.get(r.ref);
    if (settled !== undefined && settled !== null) continue;
    if (r.routes >= ROUTES_PER_TASK) {
      out.push({ step: r.step, outcome: 'over_limit', handler: handler.step, from: r });
      continue;
    }
    if (members + 1 > facts.cap) {
      out.push({ step: r.step, outcome: 'over_cap', handler: handler.step, from: r });
      continue;
    }
    members += 1;
    out.push({ step: r.step, outcome: 'route', handler: handler.step, from: r, standsIn: handler.stands_in_for === r.step });
  }
  return out;
}

/** What a routed task's transition was, as a notice and `show` say it (§5.3, §12): `gave up`, `stopped after 10 throttles`, `blocked`. */
export function triggerWords(r: Pick<RouteFact, 'kind' | 'throttled'>, throttles: number): string {
  if (r.kind === 'blocked') return 'blocked';
  return r.throttled ? `stopped after ${throttles} throttles` : 'gave up';
}

// ---------------------------------------------------------------------------
// A handler's paragraph (§5.2)
// ---------------------------------------------------------------------------

/** What a handler's paragraph says of the task it was routed from: read from the route row and the board's rows. */
export interface Routing {
  taskId: string;
  step: string;
  item: string | null;
  from: Pick<RouteFact, 'kind' | 'throttled' | 'blockKind' | 'reason'>;
  /** The transient limit's count, for its words. */
  throttles: number;
  /** The routed task's own directory, when it has one. */
  dir: string | undefined;
  standsIn: boolean;
}

/**
 * The fixed paragraph a handler's body gains at its making, after the file's
 * (§5.2): what it was routed from, and why; the routed task's directory when it
 * has one of its own; whether it stands in or helps; and the unblock it may make.
 * It only describes the records, which alone authorise anything.
 */
export function handlerParagraph(r: Routing): string {
  const why =
    r.from.kind === 'blocked'
      ? `it blocked (${r.from.blockKind}): ${r.from.reason}`
      : r.from.throttled
        ? `it stopped after ${r.throttles} throttles: ${r.from.reason}`
        : `it gave up: ${r.from.reason}`;
  return [
    `Routed from \`${r.taskId}\` (step ${r.step}${r.item === null ? '' : `, item ${r.item}`}): ${why}.`,
    ...(r.dir === undefined ? [] : [`Its directory: ${r.dir}`]),
    r.standsIn
      ? `This task stands in for it: your accepted completion is read in ${r.step}'s place, and archives it.`
      : 'This task helps it: its dependents wait for it, not for you.',
    `\`mt kanban unblock\` with {"task_id": "${r.taskId}", "comment": "…"} returns it to work instead.`,
  ].join('\n');
}
