import type { Contract, RetryOnCrash } from './types.js';

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
