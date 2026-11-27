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
