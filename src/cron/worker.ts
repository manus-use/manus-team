import { roleOfSession } from '../core/registry.js';
import type { CronChat, CronDelivery, CronRefusal, JobRow } from '../db/cron.js';
import { getTask, runByTokenHash, subscriptionsOf } from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import { getSession } from '../db/sessions.js';
import { getJob } from '../db/cron.js';
import { hashToken, sameHash, TOKEN_PATTERN } from '../kanban/token.js';
import { REPORTED_OUTCOMES, type RunRow } from '../kanban/types.js';
import { isoWithOffset } from './schedule.js';
import type { CronService } from './service.js';
import type { CronTokens, Held } from './tokens.js';

/**
 * The agents' `mt cron` (the cron spec, §6.3, §7): `add`, `list`, `pause` and
 * `remove`, as JSON in and JSON out, with the worker CLI's conventions: every
 * field strict, an unknown one refused, `{"ok": false, "code", "message"}` on a
 * refusal. Its authority is the shell's token, and its chat is the token's: a
 * chat turn's, a fire's, or a board run's first subscription of this bot.
 * Nothing here writes: it calls `CronService`.
 */

export const CRON_COMMANDS = ['add', 'list', 'pause', 'remove'] as const;
export type CronCommand = (typeof CRON_COMMANDS)[number];

export type CronApiResponse = ({ ok: true } & Record<string, unknown>) | { ok: false; code: string; message: string };

export interface CronApiDeps {
  db: Db;
  service: CronService;
  tokens: CronTokens;
  appId: string;
  /** After a change: a tick, so the change is acted on at once. */
  changed?: () => void;
}

/** Each command's fields. */
const FIELDS: Readonly<Record<CronCommand, readonly string[]>> = {
  add: ['schedule', 'prompt', 'name', 'tz', 'idempotency_key'],
  list: [],
  pause: ['job_id'],
  remove: ['job_id'],
};
const REQUIRED: Readonly<Record<CronCommand, readonly string[]>> = { add: ['schedule', 'prompt'], list: [], pause: ['job_id'], remove: ['job_id'] };

/** The most of a field's text, in UTF-8 bytes, but the prompt's, which the service bounds. */
const FIELD_BYTES = 1024;

function refused(code: string, message: string): CronApiResponse {
  return { ok: false, code, message };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function refusal(r: CronRefusal): CronApiResponse {
  return { ok: false, code: r.code, message: r.message };
}

/** Who asks: a chat session's agent, a fire's, or a board run's. */
type Asker =
  | { kind: 'chat'; held: Extract<Held, { kind: 'chat' }> }
  | { kind: 'fire'; held: Extract<Held, { kind: 'fire' }> }
  | { kind: 'run'; run: RunRow };

function jobShown(job: JobRow): Record<string, unknown> {
  return {
    job_id: job.jobId,
    name: job.name,
    schedule: job.schedule,
    tz: job.tz,
    state: job.state,
    next_run_at: job.nextRunAt === null ? null : isoWithOffset(job.tz, job.nextRunAt),
    created_by: job.createdBy,
  };
}

/** Why an add asked without operate tier is refused: a chat turn's, a woken turn's, and a run of work a wake made (wake spec §19.8). */
const NEEDS_OPERATOR = 'this turn was asked by someone without operate tier, who cannot add cron jobs; an operator can, here or with /cron add';

export class CronApi {
  readonly #deps: CronApiDeps;

  constructor(deps: CronApiDeps) {
    this.#deps = deps;
  }

  /** One request, `{cron, token, input}` or `{cron, run, token, input}`. Never rejects. */
  async handle(raw: Record<string, unknown>): Promise<CronApiResponse> {
    try {
      return this.#handle(raw);
    } catch {
      return refused('internal', 'the gateway failed to handle the request; it was not applied unless mt cron list says so');
    }
  }

  #handle(raw: Record<string, unknown>): CronApiResponse {
    for (const key of Object.keys(raw)) {
      if (!['cron', 'run', 'token', 'input'].includes(key)) return refused('bad_request', 'a cron request has only cron, run, token and input');
    }
    const { cron: command, token, run } = raw;
    if (typeof command !== 'string' || typeof token !== 'string' || (run !== undefined && typeof run !== 'string')) {
      return refused('bad_request', 'a cron request names its command and its token, as text');
    }
    if (!(CRON_COMMANDS as readonly string[]).includes(command)) {
      return refused('unknown_command', `no command ${JSON.stringify(command.slice(0, 64))} (one of ${CRON_COMMANDS.join(', ')})`);
    }
    const asker = this.#asker(token, run);
    if ('ok' in asker) return asker;
    const input = raw['input'] ?? {};
    if (!isRecord(input)) return refused('invalid', `mt cron ${command} reads a JSON object on stdin`);
    const bad = this.#badInput(command as CronCommand, input);
    if (bad !== undefined) return bad;
    const r = this.#act(command as CronCommand, asker, input);
    if (r.ok && command !== 'list') this.#changed();
    return r;
  }

  #changed(): void {
    try {
      this.#deps.changed?.();
    } catch {
      // The change is made; the scheduler's tick acts on it anyway.
    }
  }

  /** The token's holder (§7.4): a board run's when the request names one, else a chat turn's or a fire's. */
  #asker(token: string, run: unknown): Asker | CronApiResponse {
    if (!TOKEN_PATTERN.test(token)) return refused('unauthorized', 'MT_CRON_TOKEN is not a token');
    if (typeof run === 'string') {
      const hash = hashToken(token);
      const found = runByTokenHash(this.#deps.db, hash);
      if (found === undefined || found.tokenHash === null || !sameHash(found.tokenHash, hash) || found.runId !== run) {
        return refused('unauthorized', 'no run has this token, or it is not the run named');
      }
      if (found.assignee.kind !== 'role') return refused('unauthorized', `run ${found.runId} is a person's`);
      // A run's scope (kanban §7.2): closed, or decided by anyone but itself, and nothing works.
      if (found.endedAt !== null || (found.outcome !== null && !(REPORTED_OUTCOMES as readonly string[]).includes(found.outcome))) {
        return refused('run_superseded', `run ${found.runId} is over; its task has moved on without it`);
      }
      return { kind: 'run', run: found };
    }
    const held = this.#deps.tokens.lookup(token);
    if (held === undefined) return refused('unauthorized', 'no turn or fire has this MT_CRON_TOKEN open: it works only while its turn runs');
    return held.kind === 'chat' ? { kind: 'chat', held } : { kind: 'fire', held };
  }

  #badInput(command: CronCommand, input: Record<string, unknown>): CronApiResponse | undefined {
    for (const key of Object.keys(input)) {
      if (key === 'script') return refused('invalid', "a script is the operator's; ask one to add it with mt cron edit");
      if (key === 'role') return refused('invalid', "mt cron takes no field \"role\": a job runs as the agent's own role");
      if (!FIELDS[command].includes(key)) {
        const known = FIELDS[command];
        return refused('invalid', `${command} takes no field ${JSON.stringify(key.slice(0, 64))}${known.length === 0 ? '' : ` (it takes ${known.join(', ')})`}`);
      }
    }
    for (const key of FIELDS[command]) {
      const value = input[key];
      if (value === undefined || value === null) {
        if (REQUIRED[command].includes(key)) return refused('invalid', `${command} needs ${key}, as text`);
        continue;
      }
      if (typeof value !== 'string') return refused('invalid', `${key} is text`);
      if (key !== 'prompt' && Buffer.byteLength(value, 'utf8') > FIELD_BYTES) return refused('too_large', `${key} is at most ${FIELD_BYTES} bytes`);
    }
    return undefined;
  }

  /** The chat the asker's jobs deliver to, or null for none. */
  #delivery(asker: Asker): CronDelivery | null {
    if (asker.kind === 'chat') {
      const k = asker.held.key;
      return { channel: k.channel, account: k.appId, chat: k.conversationId, thread: k.threadId, root: null };
    }
    if (asker.kind === 'fire') return getJob(this.#deps.db, asker.held.jobId)?.delivery ?? null;
    const sub = subscriptionsOf(this.#deps.db, asker.run.taskId).find((s) => s.appId === this.#deps.appId);
    if (sub === undefined) return null;
    return {
      channel: sub.channel,
      account: sub.appId,
      chat: sub.conversationId,
      thread: sub.threadId,
      root: sub.threadId === '' ? null : sub.rootMessageId,
    };
  }

  #act(command: CronCommand, asker: Asker, input: Record<string, unknown>): CronApiResponse {
    const str = (key: string): string | undefined => (typeof input[key] === 'string' ? (input[key] as string) : undefined);
    const delivery = this.#delivery(asker);
    const chat: CronChat | undefined = delivery === null ? undefined : { channel: delivery.channel, account: delivery.account, chat: delivery.chat };
    const by = asker.kind === 'chat' ? `session:${asker.held.sessionId}` : asker.kind === 'run' ? `run:${asker.run.runId}` : `fire:${asker.held.fireId}`;
    switch (command) {
      case 'list':
        return { ok: true, jobs: chat === undefined ? [] : this.#deps.service.list(chat).map(jobShown) };
      case 'pause':
      case 'remove': {
        const jobId = str('job_id') ?? '';
        // A fire's agent made no job (§6.3).
        if (asker.kind === 'fire') {
          return refused('not_yours', `cron job ${jobId} was not made by this agent: a fire's agent made no job, and pauses or removes none`);
        }
        const r = command === 'pause' ? this.#deps.service.pause(jobId, { own: by }) : this.#deps.service.remove(jobId, { own: by });
        return r.ok ? { ok: true, job_id: r.job.jobId, state: r.job.state } : refusal(r);
      }
      case 'add': {
        if (asker.kind === 'fire') return refused('in_cron_fire', 'a cron fire adds no job: a job that makes jobs would grow without anyone asking');
        let role: string;
        if (asker.kind === 'chat') {
          if (!this.#deps.tokens.runningTurnOperate(asker.held.sessionId)) return refused('needs_operator', NEEDS_OPERATOR);
          role = roleOfSession(getSession(this.#deps.db, asker.held.sessionId)?.agentId ?? '');
        } else {
          // Work a wake put on the board, a reaction task's and every task made from one, adds no job (wake spec §19.8):
          // no operator put it there, so a board run's usual leave does not hold for it.
          if ((getTask(this.#deps.db, asker.run.taskId)?.wakeRoot ?? null) !== null) return refused('needs_operator', NEEDS_OPERATOR);
          role = asker.run.assignee.name;
        }
        const key = str('idempotency_key');
        const name = str('name');
        const tz = str('tz');
        const r = this.#deps.service.add({
          schedule: str('schedule') ?? '',
          prompt: str('prompt') ?? '',
          role,
          ...(name === undefined ? {} : { name }),
          ...(tz === undefined ? {} : { tz }),
          delivery,
          createdBy: by,
          createdVia: asker.kind === 'chat' ? { kind: 'session', sessionId: asker.held.sessionId } : { kind: 'run', runId: asker.run.runId },
          ...(key === undefined ? {} : { idempotencyKey: `${by}:${key}` }),
        });
        if (!r.ok) return refusal(r);
        return {
          ok: true,
          ...jobShown(r.job),
          existing: r.existing,
          ...(delivery === null ? { delivery: 'none', message: "the task has no chat following it, so the job's results are kept in its history only" } : {}),
        };
      }
    }
  }
}
