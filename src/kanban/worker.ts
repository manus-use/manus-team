import type { Db } from '../db/open.js';
import { getTask, memberOf, routeOfHandler, runByTokenHash, taskView, wakeOfReaction, type ReviewRequest } from '../db/kanban-read.js';
import { redactKnownSecrets } from '../secrets.js';
import { briefFor } from './brief.js';
import { DAG_LIMITS } from './dag.js';
import { WAKES_OFF, type KanbanService, type WorkflowMade } from './service.js';
import { hashToken, sameHash, TOKEN_PATTERN } from './token.js';
import { WORKER_LIMITS } from './limits.js';
import {
  REPORTED_OUTCOMES,
  type Assignee,
  type FailedGate,
  type RefusalCode,
  type Reporter,
  type Result,
  type RunRow,
  type WakeRow,
} from './types.js';

/**
 * The worker API (spec §7.3): what `mt kanban` asks of the board, as JSON in and
 * JSON out. One module, whatever the front end: the socket is the first, and an
 * MCP server for agents that take one would be a second front end to this, not a
 * second implementation.
 *
 * **Authority is the run's token** (spec §7.2). Every request carries it; it is
 * checked by its hash, which is how the run is found, and never echoed. Its scope
 * is the run:
 * - before the run is decided, every command works;
 * - after the worker's own report, `show`, `comment`, `create` and `link` still
 *   work, so follow-ups written just after a report are not lost, and a second
 *   terminal report is `already_reported` (the board refuses it);
 * - once the dispatcher has decided the run, or once it is closed, nothing works:
 *   `run_superseded`.
 *
 * It can report on its own task, comment on any task, create tasks, and link
 * the tasks its own task created. It cannot move any other task.
 *
 * **Input is strict.** Each command has its own fields, each with a type and a
 * size; an unknown field is refused, not ignored, since an agent that misspells
 * `summary` should hear so rather than have its report land without one.
 *
 * Text lands on the board through KanbanService, which masks it on write (spec
 * §10.1 layer 3). Nothing here writes. What a response carries is masked by the
 * socket as it is sent.
 */

export const WORKER_COMMANDS = [
  'show',
  'complete',
  'review',
  'changes',
  'block',
  'comment',
  'create',
  'link',
  'start-workflow',
  'apply-dag',
  'wake-show',
  'wake-unblock',
] as const;
export type WorkerCommand = (typeof WORKER_COMMANDS)[number];

/** What a refusal can say: the board's codes, and the worker API's own. */
export type WorkerCode =
  | RefusalCode
  /** No run has this token, or it is not the run the request names. */
  | 'unauthorized'
  /** The request itself is not one: not JSON, not an object, a missing field. */
  | 'bad_request'
  | 'unknown_command'
  /** Something failed that the request did not cause. */
  | 'internal';

export type WorkerResponse =
  | ({ ok: true } & Record<string, unknown>)
  | {
      ok: false;
      code: WorkerCode;
      message: string;
      /** For `gate_failed` (spec §7.7): the failing command, its exit, and the end of its output. */
      gate?: { command: string; exit_code: number | null; signal: string | null; timed_out: boolean; output: string };
    };

/** A request's options: aborted when the gateway stops, as the socket closes. */
export interface HandleOptions {
  signal?: AbortSignal;
}

export interface WorkerApiDeps {
  db: Db;
  service: KanbanService;
  /**
   * Told after every change a worker made, so the dispatcher can look for work
   * a new task, a link or a report made claimable. Never throws into a request.
   */
  changed?: () => void;
  /** A person's name as the gateway last saw it, to name a person reviewer by; absent, people are named by id. */
  nameOf?: (principal: string) => string | undefined;
  /**
   * The woken show and unblock (wake spec §9.2), for a reaction task's run's
   * `wake-show` and `wake-unblock` (§19.8): asked when a command comes, as it is
   * built after the worker API; absent, or answering none, wakes are off.
   */
  wakes?: () => WakeScope | undefined;
}

/** What a reaction run's two commands go through: the woken show and unblock, given the wake (wake spec §19.8). */
export interface WakeScope {
  show(wake: WakeRow, taskId: string): Record<string, unknown>;
  unblock(wake: WakeRow, taskId: string, comment: string | undefined): Record<string, unknown>;
}

export { WORKER_LIMITS };

type Field =
  | { kind: 'text'; max: number; required: boolean }
  | { kind: 'json' }
  | { kind: 'ids' }
  | { kind: 'contract' }
  /** A workflow's params (workflows spec §6): an object of text and lists of text, within their sizes. */
  | { kind: 'params' };

const text = (max: number, required = true): Field => ({ kind: 'text', max, required });
const name = (required = true): Field => text(WORKER_LIMITS.name, required);

/** Each command's fields (spec §7.3), as the protocol in the prompt gives them. */
const SCHEMAS: Record<WorkerCommand, Readonly<Record<string, Field>>> = {
  show: {},
  complete: { summary: text(WORKER_LIMITS.summary), metadata: { kind: 'json' } },
  review: { summary: text(WORKER_LIMITS.summary), metadata: { kind: 'json' }, reviewer: name(false) },
  changes: { reason: text(WORKER_LIMITS.reason) },
  block: { kind: name(), reason: text(WORKER_LIMITS.reason), parents: { kind: 'ids' } },
  comment: { body: text(WORKER_LIMITS.comment), task_id: name(false) },
  create: {
    title: text(WORKER_LIMITS.title),
    body: text(WORKER_LIMITS.body),
    contract: { kind: 'contract' },
    assignee: name(),
    reviewer: name(false),
    workspace: name(false),
    parents: { kind: 'ids' },
    idempotency_key: name(false),
  },
  link: { parent_id: name(), child_id: name() },
  'start-workflow': { workflow: name(), params: { kind: 'params' }, idempotency_key: name(false) },
  // A DAG, read by the DAG's own checks (workflows spec §5) rather than this flat schema; its two keys of its own are taken off first.
  'apply-dag': {},
  // A reaction task's run's scope (wake spec §19.8): the tasks its wake carried.
  'wake-show': { task_id: name() },
  'wake-unblock': { task_id: name(), comment: text(WORKER_LIMITS.comment, false) },
};

const ENVELOPE = ['run', 'token', 'command', 'input'];

/** The one request that needs no token: its throttle is the socket handler's (the cron spec, §7.4). */
export { NUDGE, NUDGE_INTERVAL_MS } from './socket.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Agent text a refusal quotes: masked first, then cut, so a known secret that
 * straddles the cut is masked whole rather than leaving a prefix the socket's
 * masking would not recognise.
 */
function quoted(value: string, max = WORKER_LIMITS.name): string {
  return redactKnownSecrets(value).slice(0, max);
}

/** Whether a JSON value nests deeper than `max`, the outermost object or list counted 1. Iterative: the input may nest deep. */
function deeperThan(value: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop() as [unknown, number];
    if (typeof v !== 'object' || v === null) continue;
    if (depth > max) return true;
    for (const child of Object.values(v)) stack.push([child, depth + 1]);
  }
  return false;
}

function refused(code: WorkerCode, message: string): WorkerResponse {
  return { ok: false, code, message };
}

function isCommand(c: string): c is WorkerCommand {
  return (WORKER_COMMANDS as readonly string[]).includes(c);
}

/** A refusal unless the input has exactly its command's fields, each of its type and size. */
function badInput(command: WorkerCommand, input: Record<string, unknown>): WorkerResponse | undefined {
  const schema = SCHEMAS[command];
  for (const key of Object.keys(input)) {
    // Own keys only: `in` would let constructor, toString or __proto__ through.
    if (!Object.hasOwn(schema, key)) {
      const known = Object.keys(schema);
      return refused(
        'invalid',
        `${command} takes no field ${JSON.stringify(quoted(key))}` +
          (known.length === 0 ? '' : ` (it takes ${known.join(', ')})`),
      );
    }
  }
  for (const [key, field] of Object.entries(schema)) {
    const value = input[key];
    if (value === undefined || value === null) {
      if (field.kind === 'text' && field.required) return refused('invalid', `${command} needs ${key}, as text`);
      continue;
    }
    switch (field.kind) {
      case 'text':
        if (typeof value !== 'string') return refused('invalid', `${key} is text`);
        if (bytes(value) > field.max) {
          return refused('too_large', `${key} is ${bytes(value)} bytes; it may be at most ${field.max}`);
        }
        break;
      case 'json': {
        // An object, as a report's metadata is shown; and checked for depth before
        // it is serialized, or a deep one would throw rather than be refused.
        if (!isRecord(value)) return refused('invalid', `${key} is a JSON object`);
        if (deeperThan(value, WORKER_LIMITS.metadataDepth)) {
          return refused('invalid', `${key} nests more than ${WORKER_LIMITS.metadataDepth} deep`);
        }
        const size = bytes(JSON.stringify(value));
        if (size > WORKER_LIMITS.metadata) {
          return refused('too_large', `${key} is ${size} bytes as JSON; it may be at most ${WORKER_LIMITS.metadata}`);
        }
        break;
      }
      case 'ids':
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && bytes(v) <= WORKER_LIMITS.name)) {
          return refused('invalid', `${key} is a list of task ids`);
        }
        if (value.length > WORKER_LIMITS.parents) {
          return refused('too_large', `${key} names ${value.length} tasks; at most ${WORKER_LIMITS.parents}`);
        }
        break;
      case 'params': {
        if (!isRecord(value) || !Object.values(value).every((v) => typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string')))) {
          return refused('invalid', `${key} is an object of text and lists of text`);
        }
        const size = bytes(JSON.stringify(value));
        if (size > DAG_LIMITS.paramsBytes) {
          return refused('too_large', `${key} is ${size} bytes as JSON; at most ${DAG_LIMITS.paramsBytes} together`);
        }
        break;
      }
      case 'contract':
        if (!isRecord(value)) return refused('invalid', `${key} is an object of text fields`);
        for (const [f, v] of Object.entries(value)) {
          if (typeof v === 'string' && bytes(v) > WORKER_LIMITS.contractField) {
            return refused('too_large', `contract field ${quoted(f)} is ${bytes(v)} bytes; at most ${WORKER_LIMITS.contractField}`);
          }
        }
        break;
    }
  }
  return undefined;
}

function who(a: Assignee | null): string | null {
  return a === null ? null : a.name;
}

/** A handoff for review, as show gives it, in snake_case like the input. */
function handoffShown(h: ReviewRequest): Record<string, unknown> {
  return {
    by: h.actor,
    run_id: h.runId,
    summary: h.summary,
    metadata: h.metadata,
    reported_commit: h.reportedCommit,
    reported_dirty: h.reportedDirty,
  };
}

export class WorkerApi {
  readonly #db: Db;
  readonly #service: KanbanService;
  readonly #changed: () => void;
  readonly #nameOf: ((principal: string) => string | undefined) | undefined;
  readonly #wakes: () => WakeScope | undefined;

  constructor(deps: WorkerApiDeps) {
    this.#db = deps.db;
    this.#service = deps.service;
    this.#nameOf = deps.nameOf;
    this.#wakes = deps.wakes ?? (() => undefined);
    const changed = deps.changed ?? (() => undefined);
    this.#changed = () => {
      try {
        changed();
      } catch {
        // The change is made; looking for work is the dispatcher's, and its sweep looks again.
      }
    };
  }

  /**
   * One request, as the socket parsed it. Never rejects. Asynchronous, since a
   * report waits for its task's gates (spec §7.7).
   */
  async handle(raw: unknown, opts: HandleOptions = {}): Promise<WorkerResponse> {
    try {
      return await this.#handle(raw, opts);
    } catch {
      // Not quoted: an error here can carry anything, the request included.
      return refused('internal', 'the gateway failed to handle the request; it was not applied unless show says so');
    }
  }

  async #handle(raw: unknown, opts: HandleOptions): Promise<WorkerResponse> {
    if (!isRecord(raw)) return refused('bad_request', 'a request is a JSON object');
    for (const key of Object.keys(raw)) {
      if (!ENVELOPE.includes(key)) return refused('bad_request', `a request has only ${ENVELOPE.join(', ')}`);
    }
    const { run: runId, token, command } = raw;
    if (typeof runId !== 'string' || typeof token !== 'string' || typeof command !== 'string') {
      return refused('bad_request', 'a request names its run, its token and its command, as text');
    }
    if (!isCommand(command)) {
      return refused(
        'unknown_command',
        `no command ${JSON.stringify(quoted(command))} (one of ${WORKER_COMMANDS.join(', ')})`,
      );
    }

    // The token is checked, never echoed: not in a refusal, not in a log line.
    if (!TOKEN_PATTERN.test(token)) return refused('unauthorized', 'MT_KANBAN_TOKEN is not a run token');
    const hash = hashToken(token);
    const run = runByTokenHash(this.#db, hash);
    if (run === undefined || run.tokenHash === null || !sameHash(run.tokenHash, hash)) {
      return refused('unauthorized', 'no run has this MT_KANBAN_TOKEN');
    }
    if (run.runId !== runId) return refused('unauthorized', 'MT_KANBAN_RUN is not the run this token belongs to');
    // A person's run reports through chat (plan D); a token on one is not an agent's.
    if (run.assignee.kind !== 'role') {
      return refused('unauthorized', `run ${run.runId} is a person’s; it reports through chat, not mt kanban`);
    }

    // The run's scope (spec §7.2): closed, or decided by anyone but itself, and nothing works.
    if (run.endedAt !== null) {
      return refused('run_superseded', `run ${run.runId} is over; its task has moved on without it`);
    }
    if (run.outcome !== null && !(REPORTED_OUTCOMES as readonly string[]).includes(run.outcome)) {
      return refused('run_superseded', `run ${run.runId} was ended (${run.outcome}); its task has moved on without it`);
    }

    const input = raw.input ?? {};
    if (!isRecord(input)) return refused('invalid', `${command} reads a JSON object on stdin`);
    const bad = command === 'apply-dag' ? undefined : badInput(command, input);
    if (bad !== undefined) return bad;
    const r = await this.#act(command, run, input, opts);
    // A dry run made nothing, and so is no change to look at; a wake's unblock nudges the dispatcher itself, once (§9.2).
    if (r.ok && command !== 'show' && command !== 'wake-show' && command !== 'wake-unblock' && r['dry_run'] !== true) this.#changed();
    return r;
  }

  async #act(
    command: WorkerCommand,
    run: RunRow,
    input: Record<string, unknown>,
    opts: HandleOptions,
  ): Promise<WorkerResponse> {
    const by: Reporter = { kind: 'run', runId: run.runId };
    const actor = `run:${run.runId}`;
    const str = (key: string): string | undefined => (typeof input[key] === 'string' ? (input[key] as string) : undefined);
    const ids = (key: string): readonly string[] | undefined => input[key] as readonly string[] | undefined;
    const metadata = input['metadata'] === undefined || input['metadata'] === null ? {} : { metadata: input['metadata'] };
    const signal = opts.signal === undefined ? {} : { signal: opts.signal };
    switch (command) {
      case 'show':
        return this.#show(run);
      case 'complete': {
        const r = await this.#service.complete(run.taskId, by, { summary: str('summary') ?? '', ...metadata }, signal);
        const out = reported(r);
        // A task that names a reviewer is sent to them, not done (spec §5.3): the answer says so.
        const reviewer = r.ok && r.task.phase === 'review' ? r.task.reviewer : null;
        if (!out.ok || reviewer === null) return out;
        const name = reviewer.kind === 'human' ? this.#nameOf?.(reviewer.name) : undefined;
        const whom =
          reviewer.kind === 'role' ? `role ${reviewer.name}` : name === undefined ? reviewer.name : `${name} (${reviewer.name})`;
        return { ...out, message: `sent for review to ${whom}: the task names a reviewer, so complete asks for review` };
      }
      case 'review': {
        const reviewer = str('reviewer');
        return reported(
          await this.#service.requestReview(
            run.taskId,
            by,
            { summary: str('summary') ?? '', ...metadata, ...(reviewer === undefined ? {} : { reviewer }) },
            signal,
          ),
        );
      }
      case 'changes':
        return reported(this.#service.requestChanges(run.taskId, by, str('reason') ?? ''));
      case 'block': {
        const parents = ids('parents');
        return reported(
          this.#service.block(run.taskId, by, {
            kind: str('kind') ?? '',
            reason: str('reason') ?? '',
            ...(parents === undefined ? {} : { parents }),
          }),
        );
      }
      case 'comment': {
        // A run's comment steers: it is the board's own work talking (spec §7.5).
        const r = this.#service.comment(str('task_id') ?? run.taskId, str('body') ?? '', actor, { steers: true });
        return r.ok ? { ok: true, task_id: r.comment.taskId, comment_id: r.comment.id } : refusal(r);
      }
      case 'create': {
        const opt = (key: string, as: string): Record<string, unknown> =>
          input[key] === undefined || input[key] === null ? {} : { [as]: input[key] };
        const r = this.#service.create({
          title: str('title') ?? '',
          body: str('body') ?? '',
          assignee: str('assignee') ?? '',
          ...opt('contract', 'contract'),
          ...opt('reviewer', 'reviewer'),
          ...opt('workspace', 'workspace'),
          ...opt('parents', 'parents'),
          ...opt('idempotency_key', 'idempotencyKey'),
          createdBy: actor,
          createdVia: { kind: 'run', runId: run.runId },
        });
        return r.ok ? { ok: true, task_id: r.task.taskId, existing: r.existing } : refusal(r);
      }
      case 'link': {
        const parent = str('parent_id') ?? '';
        const child = str('child_id') ?? '';
        // A run moves no task but its own: it may hold back the tasks its task
        // created, as decomposition needs, and no other.
        const task = getTask(this.#db, child);
        // A reaction task's created_from_task is its source's, but a wake made it, not this run (wake spec §19.3).
        if (task !== undefined && task.reactionOf !== null) {
          return refused('wrong_task', `run ${run.runId} may not link \`${child}\`: it is a reaction task, made by a wake, not by this run`);
        }
        if (task !== undefined && task.createdFromTask !== run.taskId) {
          return refused('wrong_task', `run ${run.runId} may link only the tasks its task created, and ${child} is not one`);
        }
        const r = this.#service.link(parent, child, actor);
        return r.ok ? { ok: true, added: r.added } : refusal(r);
      }
      case 'start-workflow': {
        // On the run's task's board, whatever else, created from its task (workflows spec §6).
        const key = str('idempotency_key');
        const r = this.#service.startWorkflow({
          workflow: str('workflow') ?? '',
          params: { from: 'json', params: input['params'] ?? {} },
          ...(key === undefined ? {} : { idempotencyKey: key }),
          createdBy: actor,
          createdVia: { kind: 'run', runId: run.runId },
        });
        return r.ok ? madeAnswer(r) : refusal(r);
      }
      case 'wake-show':
      case 'wake-unblock': {
        const scope = this.#wakes();
        if (scope === undefined) return refused('wake_off', WAKES_OFF);
        const wake = this.#wakeOf(run);
        if (wake === undefined) return refused('not_woken', "this run's task was not made by a wake");
        const taskId = str('task_id') ?? '';
        const r = command === 'wake-show' ? scope.show(wake, taskId) : scope.unblock(wake, taskId, str('comment'));
        if (r['ok'] !== true) return r as WorkerResponse;
        // The worker's JSON form (§19.8): the show as the operator's --json, the unblock as the woken turn's answer.
        if (command === 'wake-show') return { ok: true, ...(r['json'] as Record<string, unknown>) };
        return r as WorkerResponse;
      }
      case 'apply-dag': {
        // Its own two keys, beside the DAG's, are taken off before the DAG is checked (workflows spec §6).
        const { idempotency_key: key, dry_run: dryRun, ...dag } = input;
        if (key !== undefined && key !== null && (typeof key !== 'string' || bytes(key) > WORKER_LIMITS.name)) {
          return refused('invalid', `idempotency_key is text, of at most ${WORKER_LIMITS.name} bytes`);
        }
        if (dryRun !== undefined && dryRun !== null && typeof dryRun !== 'boolean') return refused('invalid', 'dry_run is true or false');
        const r = this.#service.applyDag({
          dag,
          ...(typeof key === 'string' ? { idempotencyKey: key } : {}),
          ...(dryRun === true ? { dryRun: true } : {}),
          createdBy: actor,
          createdVia: { kind: 'run', runId: run.runId },
        });
        if (!r.ok) return refusal(r);
        if (!('dryRun' in r)) return madeAnswer(r);
        return {
          ok: true,
          dry_run: true,
          existing: r.existing,
          ...(r.instanceId === null ? {} : { instance_id: r.instanceId }),
          board: r.board,
          tasks: r.tasks.map((t) => ({ ref: t.ref, step: t.step, item: t.item, gates: t.gates })),
        };
      }
    }
  }

  /** The wake a reaction task's run is scoped by (wake spec §19.8): its task's `reaction_of`. */
  #wakeOf(run: RunRow): WakeRow | undefined {
    return wakeOfReaction(this.#db, run.taskId);
  }

  /** The run's task and its context, in full (spec §7.3): what the prompt cut or left out is here. */
  #show(run: RunRow): WorkerResponse {
    const task = getTask(this.#db, run.taskId);
    const view = taskView(this.#db, run.taskId);
    if (task === undefined || view === undefined) return refused('not_found', `no task ${run.taskId}`);
    const brief = briefFor(this.#db, { run, task, roleMd: undefined, role: undefined });
    // A handler's task reads its source from the records, whatever its body says (workflow routing spec §5.2).
    const route = routeOfHandler(this.#db, task.taskId);
    const source = route === undefined ? undefined : memberOf(this.#db, route.fromTask);
    return {
      ok: true,
      ...(route === undefined
        ? {}
        : { routed_from: { task_id: route.fromTask, step: source?.step ?? null, item: source?.item ?? null, event_id: route.eventId } }),
      run: { run_id: run.runId, kind: run.kind, attempt: run.attempt, outcome: run.outcome },
      task: {
        task_id: task.taskId,
        title: task.title,
        body: task.body,
        contract: task.contract,
        assignee: who(task.assignee),
        reviewer: who(task.reviewer),
        workspace: task.workspace,
        phase: task.phase,
        status: view.status,
        // Read-only: what a run creates goes on this board, whatever it asks (spec §16).
        board: task.board,
      },
      parents: brief.parents.map((p) => ({
        task_id: p.task.taskId,
        title: p.task.title,
        phase: p.task.phase,
        summary: p.summary,
        metadata: p.metadata,
      })),
      attempts: brief.attempts.map((a) => ({
        attempt: a.run.attempt,
        kind: a.run.kind,
        assignee: a.run.assignee.name,
        outcome: a.run.outcome,
        summary: a.run.summary,
        metadata: a.run.metadata,
        error: a.run.error,
        last_output: a.run.lastOutput,
        reported_commit: a.run.reportedCommit,
        reported_dirty: a.run.reportedDirty,
        ...(a.toolCalls === undefined ? {} : { tool_calls: a.toolCalls.map((c) => ({ title: c.title, status: c.status })) }),
      })),
      // Masked: a gate defined before a secret was known may hold it.
      gates: (brief.gates ?? []).map((g) => ({ gate_id: g.id, command: redactKnownSecrets(g.command), timeout_s: g.timeoutS })),
      last_gate_run:
        brief.lastGateRun === undefined
          ? null
          : {
              for: brief.lastGateRun.for,
              by: brief.lastGateRun.actor,
              passed: brief.lastGateRun.passed,
              aborted: brief.lastGateRun.aborted,
              not_run: brief.lastGateRun.notRun,
              results: brief.lastGateRun.results.map((r) => ({
                command: redactKnownSecrets(r.command),
                exit_code: r.exitCode,
                signal: r.signal,
                timed_out: r.timedOut,
                duration_ms: r.durationMs,
                output: r.output,
              })),
            },
      review: brief.review === undefined ? null : handoffShown(brief.review),
      rework:
        brief.rework === undefined
          ? null
          : {
              by: brief.rework.actor,
              reason: brief.rework.reason,
              handoff: brief.rework.handoff === undefined ? null : handoffShown(brief.rework.handoff),
            },
      comments: brief.comments.map((c) => ({ author: c.author, body: c.body, created_at: c.createdAt })),
      children: brief.children.map((c) => ({
        task_id: c.taskId,
        title: c.title,
        assignee: who(c.assignee),
        phase: c.phase,
      })),
    };
  }
}

function refusal(r: { ok: false; code: RefusalCode; message: string; gate?: FailedGate }): WorkerResponse {
  if (r.gate === undefined) return { ok: false, code: r.code, message: r.message };
  const g = r.gate;
  return {
    ok: false,
    code: r.code,
    message: r.message,
    gate: { command: g.command, exit_code: g.exitCode, signal: g.signal, timed_out: g.timedOut, output: g.output },
  };
}

/** A start's or an apply's answer (workflows spec §6): the instance, and each task with its ref, so an agent finds the task it named. */
function madeAnswer(r: WorkflowMade): WorkerResponse {
  return {
    ok: true,
    instance_id: r.instance.instanceId,
    existing: r.existing,
    board: r.instance.board,
    tasks: r.tasks.map((t) => ({ task_id: t.taskId, ref: t.ref, step: t.step, item: t.item })),
  };
}

/** A report's answer: where the task is now, and the run's outcome. */
function reported(r: Result<{ task: { taskId: string; phase: string }; run: RunRow | undefined }>): WorkerResponse {
  if (!r.ok) return refusal(r);
  return { ok: true, task_id: r.task.taskId, phase: r.task.phase, outcome: r.run?.outcome ?? null };
}
