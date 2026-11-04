import type { Db } from '../db/open.js';
import { getTask, runByTokenHash, taskView, type ReviewRequest } from '../db/kanban-read.js';
import { redactKnownSecrets } from '../secrets.js';
import { briefFor } from './brief.js';
import type { KanbanService } from './service.js';
import { hashToken, sameHash, TOKEN_PATTERN } from './token.js';
import {
  REPORTED_OUTCOMES,
  type Assignee,
  type FailedGate,
  type RefusalCode,
  type Reporter,
  type Result,
  type RunRow,
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

export const WORKER_COMMANDS = ['show', 'complete', 'review', 'changes', 'block', 'comment', 'create', 'link'] as const;
export type WorkerCommand = (typeof WORKER_COMMANDS)[number];

/** What a refusal can say: the board's codes, and the worker API's own. */
export type WorkerCode =
  | RefusalCode
  /** No run has this token, or it is not the run the request names. */
  | 'unauthorized'
  /** The request itself is not one: not JSON, not an object, a missing field. */
  | 'bad_request'
  | 'unknown_command'
  /** A request, or a field of one, over its size. */
  | 'too_large'
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
}

/** Sizes, in UTF-8 bytes, of what a worker may send (C1 left them to C3). */
export const WORKER_LIMITS = {
  title: 512,
  body: 64 * 1024,
  contractField: 8 * 1024,
  summary: 16 * 1024,
  /** Serialized. */
  metadata: 16 * 1024,
  reason: 8 * 1024,
  comment: 16 * 1024,
  /** Ids, names, kinds and keys. */
  name: 256,
  /** Parents named in one create or block. */
  parents: 50,
  /** Objects and lists inside one another in metadata, the outermost counted. */
  metadataDepth: 64,
} as const;

type Field =
  | { kind: 'text'; max: number; required: boolean }
  | { kind: 'json' }
  | { kind: 'ids' }
  | { kind: 'contract' };

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
};

const ENVELOPE = ['run', 'token', 'command', 'input'];

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

  constructor(deps: WorkerApiDeps) {
    this.#db = deps.db;
    this.#service = deps.service;
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
    const bad = badInput(command, input);
    if (bad !== undefined) return bad;
    const r = await this.#act(command, run, input, opts);
    if (r.ok && command !== 'show') this.#changed();
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
      case 'complete':
        return reported(
          await this.#service.complete(run.taskId, by, { summary: str('summary') ?? '', ...metadata }, signal),
        );
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
        if (task !== undefined && task.createdFromTask !== run.taskId) {
          return refused('wrong_task', `run ${run.runId} may link only the tasks its task created, and ${child} is not one`);
        }
        const r = this.#service.link(parent, child, actor);
        return r.ok ? { ok: true, added: r.added } : refusal(r);
      }
    }
  }

  /** The run's task and its context, in full (spec §7.3): what the prompt cut or left out is here. */
  #show(run: RunRow): WorkerResponse {
    const task = getTask(this.#db, run.taskId);
    const view = taskView(this.#db, run.taskId);
    if (task === undefined || view === undefined) return refused('not_found', `no task ${run.taskId}`);
    const brief = briefFor(this.#db, { run, task, roleMd: undefined, role: undefined });
    return {
      ok: true,
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

/** A report's answer: where the task is now, and the run's outcome. */
function reported(r: Result<{ task: { taskId: string; phase: string }; run: RunRow | undefined }>): WorkerResponse {
  if (!r.ok) return refusal(r);
  return { ok: true, task_id: r.task.taskId, phase: r.task.phase, outcome: r.run?.outcome ?? null };
}
