import { newCronJobId } from '../core/ids.js';
import {
  CRON_LIMITS,
  KEY_REMOVED,
  addJob,
  cronRefuse,
  editJob,
  firesOf,
  getJob,
  jobByKey,
  listJobs,
  pauseJob,
  removeJob,
  requestRun,
  resumeJob,
  type CronChat,
  type CronDelivery,
  type CronRefusal,
  type CronResult,
  type FireRow,
  type JobPatch,
  type JobRow,
} from '../db/cron.js';
import type { Db } from '../db/open.js';
import { holdsSecret } from '../kanban/gate-command.js';
import type { Role } from '../roles.js';
import { MASK } from '../secrets.js';
import { systemClock, type Clock } from '../time.js';
import { checkZone, firstRun, formatWall, parseSchedule, type Schedule } from './schedule.js';

/**
 * `CronService` (the cron spec, §13): every change to a job, and every read of
 * one, from chat, the terminal and the worker API alike. Each checks its input,
 * the role and the workspace against the team, the limits and the script, as
 * `KanbanService` checks a task, and writes through db/cron.ts alone.
 *
 * **Scope** is the caller's: chat sees only the jobs delivering to its chat, any
 * thread of it, and another chat's id is answered as unknown (§6.1); an agent
 * pauses and removes only the jobs it made (§6.3). The terminal has none.
 */

export interface CronServiceDeps {
  db: Db;
  /** The team as loaded: whose agent a job runs. */
  roles: ReadonlyMap<string, Role>;
  workspaces: ReadonlySet<string>;
  /** The zone a job gets when none is given (§2.2): `cron.tz`, else the zone the adding process resolves. */
  zone: string;
  clock?: Clock;
}

/** Who may see or act on a job: one chat's, one creator's; neither, every job. */
export interface Scope {
  chat?: CronChat;
  /** Only a job whose `created_by` is this (§6.3). */
  own?: string;
}

export interface AddRequest {
  schedule: string;
  role: string;
  prompt: string;
  name?: string;
  tz?: string;
  script?: string;
  /** A configured workspace; the role's own, else `default`, when not given (§2.3). */
  workspace?: string;
  delivery: CronDelivery | null;
  createdBy: string;
  createdVia: unknown;
  idempotencyKey?: string;
}

export interface EditRequest {
  schedule?: string;
  role?: string;
  prompt?: string;
  name?: string;
  tz?: string;
  /** null takes the script away. */
  script?: string | null;
  workspace?: string;
  /** null delivers nowhere. */
  delivery?: CronDelivery | null;
}

/** A name's default: the prompt's first line, cut to 48 characters (§2). */
export const DEFAULT_NAME_CHARS = 48;

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** The prompt's first line that says anything, cut to DEFAULT_NAME_CHARS on a code point. */
export function defaultName(prompt: string): string {
  const line = prompt.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? 'cron job';
  const chars = Array.from(line);
  return chars.length <= DEFAULT_NAME_CHARS ? line : `${chars.slice(0, DEFAULT_NAME_CHARS - 1).join('')}…`;
}

/** The time a fire started, as a refusal of a run says it (§4.5): its wall-clock minute in the job's zone. */
function startedAt(job: JobRow, fire: FireRow): string {
  return formatWall(job.tz, fire.startedAt ?? fire.scheduledAt).slice(11);
}

export class CronService {
  readonly #db: Db;
  readonly #roles: ReadonlyMap<string, Role>;
  readonly #workspaces: ReadonlySet<string>;
  readonly #zone: string;
  readonly #clock: Clock;

  constructor(deps: CronServiceDeps) {
    this.#db = deps.db;
    this.#roles = deps.roles;
    this.#workspaces = deps.workspaces;
    this.#zone = deps.zone;
    this.#clock = deps.clock ?? systemClock;
  }

  /** The zone a job gets when none is given. */
  get zone(): string {
    return this.#zone;
  }

  /**
   * Why a job's role or workspace cannot run a fire, or undefined (§2.3): checked
   * at add, edit and resume, and again at each fire, which is then skipped.
   */
  unavailable(role: string, workspace: string): string | undefined {
    const r = this.#roles.get(role);
    if (r === undefined) return `role ${role} is not configured`;
    if (!r.agent.unsupervised) return `role ${role} is not unsupervised: a fire is a turn nobody watches, and its approval cards would reach nobody`;
    if (!this.#workspaces.has(workspace)) return `workspace ${workspace} is not configured`;
    return undefined;
  }

  /** A role's own workspace, else `default` (§2.3). */
  workspaceOf(role: string): string {
    return this.#roles.get(role)?.workspace ?? 'default';
  }

  #schedule(text: string, tz: string, now: number): CronResult<{ schedule: Schedule; next: number }> {
    const parsed = parseSchedule(text);
    if (!parsed.ok) return cronRefuse('invalid', parsed.message);
    const planned = firstRun(parsed.schedule, tz, now);
    if (!planned.ok) return cronRefuse('invalid', planned.message);
    return { ok: true, schedule: parsed.schedule, next: planned.at };
  }

  #zoneOf(tz: string | undefined): CronResult<{ zone: string }> {
    if (tz === undefined) return { ok: true, zone: this.#zone };
    const z = checkZone(tz);
    return z.ok ? { ok: true, zone: z.zone } : cronRefuse('invalid', z.message);
  }

  /** The checks of the free text and the script (§8, §9), or a refusal. */
  #textRefused(t: { prompt?: string; name?: string; script?: string | null }): CronRefusal | undefined {
    if (t.prompt !== undefined) {
      if (t.prompt.trim() === '') return cronRefuse('invalid', 'a cron job needs a prompt: what its agent is to do at each fire');
      if (bytes(t.prompt) > CRON_LIMITS.promptBytes) {
        return cronRefuse('too_large', `the prompt is ${bytes(t.prompt)} bytes; a cron job's prompt is at most ${CRON_LIMITS.promptBytes}`);
      }
    }
    if (t.name !== undefined) {
      if (t.name.trim() === '' || t.name.includes('\n')) return cronRefuse('invalid', "a cron job's name is one line, not blank");
      if (bytes(t.name) > CRON_LIMITS.nameBytes) return cronRefuse('too_large', `the name is ${bytes(t.name)} bytes; at most ${CRON_LIMITS.nameBytes}`);
    }
    if (t.script !== undefined && t.script !== null) {
      if (t.script.trim() === '') return cronRefuse('invalid', 'a script is a command, and this one is blank');
      if (t.script.includes('\0')) return cronRefuse('invalid', 'a script holds a NUL, which no command can');
      if (bytes(t.script) > CRON_LIMITS.scriptBytes) {
        return cronRefuse('too_large', `the script is ${bytes(t.script)} bytes; a cron job's script is at most ${CRON_LIMITS.scriptBytes}`);
      }
      if (t.script.includes(MASK)) {
        return cronRefuse('invalid', `the script holds the mask ${MASK}: it was copied from masked output, and a masked command would run broken`);
      }
      if (holdsSecret(t.script)) {
        return cronRefuse(
          'invalid',
          "the script holds a known secret, and a script is stored and run as written: pass the value through the role's environment and name it in the script, as $NAME",
        );
      }
    }
    return undefined;
  }

  /** Add a job (§2): its schedule's next run from now, as an active job, or the job its key made; refused if that one was removed. */
  add(req: AddRequest): CronResult<{ job: JobRow; existing: boolean }> {
    const now = this.#clock.now();
    // A retry is answered before its add is checked again: by now its one-off may be past, or its role gone (§3.1).
    if (req.idempotencyKey !== undefined) {
      const existing = jobByKey(this.#db, req.idempotencyKey);
      if (existing?.state === 'removed') return cronRefuse('state', KEY_REMOVED);
      if (existing !== undefined) return { ok: true, job: existing, existing: true };
    }
    const text = this.#textRefused({ prompt: req.prompt, ...(req.name === undefined ? {} : { name: req.name }), ...(req.script === undefined ? {} : { script: req.script }) });
    if (text !== undefined) return text;
    const zone = this.#zoneOf(req.tz);
    if (!zone.ok) return zone;
    const sched = this.#schedule(req.schedule, zone.zone, now);
    if (!sched.ok) return sched;
    const workspace = req.workspace ?? this.workspaceOf(req.role);
    const unavailable = this.unavailable(req.role, workspace);
    if (unavailable !== undefined) return cronRefuse('unavailable', unavailable);
    return addJob(
      this.#db,
      {
        jobId: newCronJobId(),
        name: req.name ?? defaultName(req.prompt),
        schedule: sched.schedule.text,
        tz: zone.zone,
        role: req.role,
        workspace,
        prompt: req.prompt,
        script: req.script ?? null,
        delivery: req.delivery,
        nextRunAt: sched.next,
        createdBy: req.createdBy,
        createdVia: req.createdVia,
        idempotencyKey: req.idempotencyKey ?? null,
      },
      now,
    );
  }

  /** The job, if this scope may see it; another chat's, or a removed one, is unknown. */
  #find(jobId: string, scope: Scope): CronResult<{ job: JobRow }> {
    const job = getJob(this.#db, jobId);
    const unknown = cronRefuse('not_found', `there is no cron job ${jobId}`);
    if (job === undefined || job.state === 'removed') return unknown;
    if (scope.chat !== undefined) {
      const d = job.delivery;
      if (d === null || d.channel !== scope.chat.channel || d.account !== scope.chat.account || d.chat !== scope.chat.chat) return unknown;
    }
    if (scope.own !== undefined && job.createdBy !== scope.own) {
      return cronRefuse('not_yours', `cron job ${jobId} was made by ${job.createdBy}, not by you: an agent pauses and removes only the jobs it made`);
    }
    return { ok: true, job };
  }

  /** Change a job, at the terminal (§6.2): its next run moves only with its schedule or zone (§2.5). */
  edit(jobId: string, req: EditRequest): CronResult<{ job: JobRow }> {
    const now = this.#clock.now();
    const found = this.#find(jobId, {});
    if (!found.ok) return found;
    const job = found.job;
    const text = this.#textRefused({
      ...(req.prompt === undefined ? {} : { prompt: req.prompt }),
      ...(req.name === undefined ? {} : { name: req.name }),
      ...(req.script === undefined ? {} : { script: req.script }),
    });
    if (text !== undefined) return text;
    const zone = this.#zoneOf(req.tz ?? job.tz);
    if (!zone.ok) return zone;
    const patch: JobPatch = {};
    if (req.schedule !== undefined || req.tz !== undefined) {
      const sched = this.#schedule(req.schedule ?? job.schedule, zone.zone, now);
      if (!sched.ok) return sched;
      if (req.schedule !== undefined) patch.schedule = sched.schedule.text;
      if (req.tz !== undefined) patch.tz = zone.zone;
      patch.nextRunAt = sched.next;
    }
    const role = req.role ?? job.role;
    const workspace = req.workspace ?? job.workspace;
    if (req.role !== undefined || req.workspace !== undefined) {
      const unavailable = this.unavailable(role, workspace);
      if (unavailable !== undefined) return cronRefuse('unavailable', unavailable);
    }
    if (req.role !== undefined) patch.role = role;
    if (req.workspace !== undefined) patch.workspace = workspace;
    if (req.prompt !== undefined) patch.prompt = req.prompt;
    if (req.name !== undefined) patch.name = req.name;
    if (req.script !== undefined) patch.script = req.script;
    if (req.delivery !== undefined) patch.delivery = req.delivery;
    return editJob(this.#db, jobId, patch, now);
  }

  pause(jobId: string, scope: Scope = {}): CronResult<{ job: JobRow }> {
    const found = this.#find(jobId, scope);
    if (!found.ok) return found;
    return pauseJob(this.#db, jobId, this.#clock.now());
  }

  /** Resume a paused job: its next slot from now, as an add's, its role checked as an add's (§2.5). */
  resume(jobId: string, scope: Scope = {}): CronResult<{ job: JobRow }> {
    const now = this.#clock.now();
    const found = this.#find(jobId, scope);
    if (!found.ok) return found;
    const job = found.job;
    if (job.state !== 'paused') return cronRefuse('state', `cron job ${jobId} is ${job.state}, not paused`);
    const unavailable = this.unavailable(job.role, job.workspace);
    if (unavailable !== undefined) return cronRefuse('unavailable', unavailable);
    const sched = this.#schedule(job.schedule, job.tz, now);
    if (!sched.ok) return sched;
    return resumeJob(this.#db, jobId, sched.next, now);
  }

  /** Ask for a fire now (§4.5), whatever the job's state but removed; refused while one runs. */
  run(jobId: string, scope: Scope = {}): CronResult<{ job: JobRow }> {
    const found = this.#find(jobId, scope);
    if (!found.ok) return found;
    const r = requestRun(this.#db, jobId, this.#clock.now());
    if (!r.ok && 'running' in r && r.running !== undefined) {
      return cronRefuse('running', `a fire of ${jobId} is running; it started at ${startedAt(found.job, r.running)}`);
    }
    return r;
  }

  remove(jobId: string, scope: Scope = {}): CronResult<{ job: JobRow }> {
    const found = this.#find(jobId, scope);
    if (!found.ok) return found;
    return removeJob(this.#db, jobId, this.#clock.now());
  }

  /** Every job but the removed, or one chat's (§6.1). */
  list(chat?: CronChat): JobRow[] {
    return listJobs(this.#db, chat);
  }

  /** A job and its newest fires, newest first. */
  show(jobId: string, scope: Scope = {}, fires: number = CRON_LIMITS.history): CronResult<{ job: JobRow; fires: FireRow[] }> {
    const found = this.#find(jobId, scope);
    if (!found.ok) return found;
    return { ok: true, job: found.job, fires: firesOf(this.#db, jobId, fires) };
  }
}
