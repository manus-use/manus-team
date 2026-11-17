import type { Db } from './open.js';
import { txImmediate } from './open.js';
import { redactKnownSecrets } from '../secrets.js';

/**
 * The cron jobs and their fires (the cron spec, §3): the only writer of
 * `cron_jobs` and `cron_fires`, and their reads (src/db/WRITERS.md).
 *
 * Every write is one `txImmediate`, with no `await` inside, re-reading what it
 * decides on. A job's next run is advanced in the transaction that records a
 * fire or a skip, compared to the value the scheduler read, so one slot fires
 * at most once whatever reads it (§4.2). The count of failures is written in
 * exactly two places, `endFire` and `skipFire`, each for the outcomes it
 * records (§5.7). A job keeps its newest 50 fires; a fire pruned past them, or
 * every fire of a purged job, takes its session with it, when that session is
 * bound on the `cron` channel alone (§3.2).
 */

export type CronState = 'active' | 'paused' | 'done' | 'removed';
export type FireTrigger = 'schedule' | 'run';
export type FireOutcome =
  | 'posted'
  | 'nothing'
  | 'script_failed'
  | 'agent_failed'
  | 'timed_out'
  | 'skipped_running'
  | 'skipped_missed'
  | 'skipped_unavailable'
  | 'interrupted';
export type FireDelivery = 'none' | 'pending' | 'sent' | 'failed';

/** Where a job posts (§2.4): a binding key's fields and a root. */
export interface CronDelivery {
  channel: string;
  /** The bot's app id. */
  account: string;
  chat: string;
  /** '' for chat scope. */
  thread: string;
  root: string | null;
}

/** The chat a job counts toward, threads together (§8). */
export interface CronChat {
  channel: string;
  account: string;
  chat: string;
}

export interface JobRow {
  jobId: string;
  name: string;
  schedule: string;
  tz: string;
  role: string;
  workspace: string;
  prompt: string;
  script: string | null;
  delivery: CronDelivery | null;
  state: CronState;
  nextRunAt: number | null;
  failures: number;
  runRequestedAt: number | null;
  createdBy: string;
  createdVia: unknown;
  idempotencyKey: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface FireRow {
  fireId: number;
  jobId: string;
  scheduledAt: number;
  trigger: FireTrigger;
  startedAt: number | null;
  endedAt: number | null;
  outcome: FireOutcome | null;
  sessionId: string | null;
  error: string | null;
  result: string | null;
  delivery: FireDelivery;
}

/** The limits of §8 the writer holds. */
export const CRON_LIMITS = {
  activeJobs: 50,
  chatJobs: 10,
  history: 50,
  failures: 3,
  nameBytes: 100,
  promptBytes: 8 * 1024,
  scriptBytes: 4 * 1024,
  errorBytes: 2 * 1024,
  resultBytes: 8 * 1024,
} as const;

/** The channel a fire's session is bound on (§5.2). */
export const CRON_CHANNEL = 'cron';

export type CronCode =
  | 'not_found'
  | 'invalid'
  | 'too_large'
  | 'too_many'
  | 'state'
  | 'running'
  | 'moved'
  | 'at_limit'
  | 'not_yours'
  | 'needs_operator'
  | 'in_cron_fire'
  | 'unavailable';

export interface CronRefusal {
  ok: false;
  code: CronCode;
  message: string;
}

export type CronResult<T extends object> = ({ ok: true } & T) | CronRefusal;

export function cronRefuse(code: CronCode, message: string): CronRefusal {
  return { ok: false, code, message };
}

interface JobRaw {
  job_id: string;
  name: string;
  schedule: string;
  tz: string;
  role: string;
  workspace: string;
  prompt: string;
  script: string | null;
  delivery_channel: string | null;
  delivery_account: string | null;
  delivery_chat: string | null;
  delivery_thread: string;
  delivery_root: string | null;
  state: string;
  next_run_at: number | null;
  failures: number;
  run_requested_at: number | null;
  created_by: string;
  created_via: string;
  idempotency_key: string | null;
  created_at: number;
  updated_at: number;
}

interface FireRaw {
  fire_id: number;
  job_id: string;
  scheduled_at: number;
  trigger: string;
  started_at: number | null;
  ended_at: number | null;
  outcome: string | null;
  session_id: string | null;
  error: string | null;
  result: string | null;
  delivery: string;
}

function decodeJob(r: JobRaw): JobRow {
  return {
    jobId: r.job_id,
    name: r.name,
    schedule: r.schedule,
    tz: r.tz,
    role: r.role,
    workspace: r.workspace,
    prompt: r.prompt,
    script: r.script,
    delivery:
      r.delivery_channel === null || r.delivery_account === null || r.delivery_chat === null
        ? null
        : { channel: r.delivery_channel, account: r.delivery_account, chat: r.delivery_chat, thread: r.delivery_thread, root: r.delivery_root },
    state: r.state as CronState,
    nextRunAt: r.next_run_at,
    failures: r.failures,
    runRequestedAt: r.run_requested_at,
    createdBy: r.created_by,
    createdVia: JSON.parse(r.created_via) as unknown,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function decodeFire(r: FireRaw): FireRow {
  return {
    fireId: r.fire_id,
    jobId: r.job_id,
    scheduledAt: r.scheduled_at,
    trigger: r.trigger as FireTrigger,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    outcome: r.outcome as FireOutcome | null,
    sessionId: r.session_id,
    error: r.error,
    result: r.result,
    delivery: r.delivery as FireDelivery,
  };
}

const JOB_COLS = `job_id, name, schedule, tz, role, workspace, prompt, script, delivery_channel, delivery_account,
  delivery_chat, delivery_thread, delivery_root, state, next_run_at, failures, run_requested_at, created_by,
  created_via, idempotency_key, created_at, updated_at`;
const FIRE_COLS = 'fire_id, job_id, scheduled_at, trigger, started_at, ended_at, outcome, session_id, error, result, delivery';

/** The first `max` UTF-8 bytes of `text`, cut on a character. */
export function headBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  return Buffer.from(text, 'utf8').subarray(0, max).toString('utf8').replace(/�+$/, '');
}

/** Masked, then cut: a cut through a secret leaves none of it showing. */
function masked(text: string | null | undefined, max: number): string | null {
  return text === null || text === undefined ? null : headBytes(redactKnownSecrets(text), max);
}

/** `created_via`'s string values, masked one by one (§9). */
function maskVia(value: unknown): unknown {
  if (typeof value === 'string') return redactKnownSecrets(value);
  if (Array.isArray(value)) return value.map(maskVia);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskVia(v)]));
  }
  return value;
}

// ---------------------------------------------------------------------------
// Reads

export function getJob(db: Db, jobId: string): JobRow | undefined {
  const r = db.prepare<[string], JobRaw>(`SELECT ${JOB_COLS} FROM cron_jobs WHERE job_id = ?`).get(jobId);
  return r === undefined ? undefined : decodeJob(r);
}

export function jobByKey(db: Db, key: string): JobRow | undefined {
  const r = db.prepare<[string], JobRaw>(`SELECT ${JOB_COLS} FROM cron_jobs WHERE idempotency_key = ?`).get(key);
  return r === undefined ? undefined : decodeJob(r);
}

/** Every job but the removed, oldest first; or one chat's, any thread of it (§6.1). */
export function listJobs(db: Db, chat?: CronChat): JobRow[] {
  const rows =
    chat === undefined
      ? db.prepare<[], JobRaw>(`SELECT ${JOB_COLS} FROM cron_jobs WHERE state != 'removed' ORDER BY created_at, job_id`).all()
      : db
          .prepare<[string, string, string], JobRaw>(
            `SELECT ${JOB_COLS} FROM cron_jobs WHERE state != 'removed' AND delivery_channel = ? AND delivery_account = ? AND delivery_chat = ?
             ORDER BY created_at, job_id`,
          )
          .all(chat.channel, chat.account, chat.chat);
  return rows.map(decodeJob);
}

/** Active jobs due by `now`, oldest next run first (§4.2 step 4). */
export function dueJobs(db: Db, now: number): JobRow[] {
  return db
    .prepare<[number], JobRaw>(`SELECT ${JOB_COLS} FROM cron_jobs WHERE state = 'active' AND next_run_at <= ? ORDER BY next_run_at, job_id`)
    .all(now)
    .map(decodeJob);
}

/** Jobs with a pending stamp, oldest stamp first (§4.5). */
export function stampedJobs(db: Db): JobRow[] {
  return db
    .prepare<[], JobRaw>(`SELECT ${JOB_COLS} FROM cron_jobs WHERE run_requested_at IS NOT NULL AND state != 'removed' ORDER BY run_requested_at, job_id`)
    .all()
    .map(decodeJob);
}

export function removedJobs(db: Db): JobRow[] {
  return db.prepare<[], JobRaw>(`SELECT ${JOB_COLS} FROM cron_jobs WHERE state = 'removed' ORDER BY job_id`).all().map(decodeJob);
}

/** The jobs by state, for the startup line (§10). */
export function jobCounts(db: Db): { active: number; paused: number } {
  const rows = db.prepare<[], { state: string; n: number }>('SELECT state, count(*) AS n FROM cron_jobs GROUP BY state').all();
  const of = (s: string): number => rows.find((r) => r.state === s)?.n ?? 0;
  return { active: of('active'), paused: of('paused') };
}

export function getFire(db: Db, fireId: number): FireRow | undefined {
  const r = db.prepare<[number], FireRaw>(`SELECT ${FIRE_COLS} FROM cron_fires WHERE fire_id = ?`).get(fireId);
  return r === undefined ? undefined : decodeFire(r);
}

/** A job's newest fires, newest first. */
export function firesOf(db: Db, jobId: string, limit: number = CRON_LIMITS.history): FireRow[] {
  return db
    .prepare<[string, number], FireRaw>(`SELECT ${FIRE_COLS} FROM cron_fires WHERE job_id = ? ORDER BY fire_id DESC LIMIT ?`)
    .all(jobId, limit)
    .map(decodeFire);
}

/** A job's fire under way, if one is. */
export function runningFire(db: Db, jobId: string): FireRow | undefined {
  const r = db
    .prepare<[string], FireRaw>(`SELECT ${FIRE_COLS} FROM cron_fires WHERE job_id = ? AND started_at IS NOT NULL AND ended_at IS NULL`)
    .get(jobId);
  return r === undefined ? undefined : decodeFire(r);
}

export function runningFires(db: Db): FireRow[] {
  return db
    .prepare<[], FireRaw>(`SELECT ${FIRE_COLS} FROM cron_fires WHERE started_at IS NOT NULL AND ended_at IS NULL ORDER BY fire_id`)
    .all()
    .map(decodeFire);
}

/** A job's previous result (§5.3): its newest fire that ended posted or nothing. */
export function lastResult(db: Db, jobId: string): FireRow | undefined {
  const r = db
    .prepare<[string], FireRaw>(
      `SELECT ${FIRE_COLS} FROM cron_fires WHERE job_id = ? AND outcome IN ('posted', 'nothing') ORDER BY fire_id DESC LIMIT 1`,
    )
    .get(jobId);
  return r === undefined ? undefined : decodeFire(r);
}

/** Fires whose message is yet to be known to have landed (§5.6). */
export function pendingDeliveries(db: Db): FireRow[] {
  return db.prepare<[], FireRaw>(`SELECT ${FIRE_COLS} FROM cron_fires WHERE delivery = 'pending' ORDER BY fire_id`).all().map(decodeFire);
}

/** The fire a session was made for, by its recorded session id (§3.2). */
export function fireBySession(db: Db, sessionId: string): FireRow | undefined {
  const r = db.prepare<[string], FireRaw>(`SELECT ${FIRE_COLS} FROM cron_fires WHERE session_id = ?`).get(sessionId);
  return r === undefined ? undefined : decodeFire(r);
}

/**
 * Every channel a session has been bound on, revoked bindings included: a fire's
 * own binding is revoked by its archive, so `bindingsForSession`, which reads
 * live ones only, would not see it (§3.2).
 */
export function bindingChannelsEver(db: Db, sessionId: string): string[] {
  return db
    .prepare<[string], { channel: string }>('SELECT DISTINCT channel FROM channel_bindings WHERE session_id = ? ORDER BY channel')
    .all(sessionId)
    .map((r) => r.channel);
}

// ---------------------------------------------------------------------------
// Writes

function mustJob(d: Db, jobId: string): JobRow {
  const job = getJob(d, jobId);
  if (job === undefined) throw new Error(`cron job ${jobId} vanished inside its own transaction`);
  return job;
}

function mustFire(d: Db, fireId: number): FireRow {
  const fire = getFire(d, fireId);
  if (fire === undefined) throw new Error(`cron fire ${fireId} vanished inside its own transaction`);
  return fire;
}

/** The limits of §8 for a job about to be active: 50 a gateway, 10 a chat. */
function limitRefused(d: Db, chat: CronChat | null, without: string | undefined): CronRefusal | undefined {
  const all = d
    .prepare<[string], { n: number }>("SELECT count(*) AS n FROM cron_jobs WHERE state = 'active' AND job_id != ?")
    .get(without ?? '')?.n ?? 0;
  if (all >= CRON_LIMITS.activeJobs) {
    return cronRefuse('too_many', `this gateway has ${all} active cron jobs, and the limit is ${CRON_LIMITS.activeJobs}: pause or remove one first`);
  }
  if (chat === null) return undefined;
  const here = d
    .prepare<[string, string, string, string], { n: number }>(
      `SELECT count(*) AS n FROM cron_jobs WHERE state = 'active' AND delivery_channel = ? AND delivery_account = ? AND delivery_chat = ? AND job_id != ?`,
    )
    .get(chat.channel, chat.account, chat.chat, without ?? '')?.n ?? 0;
  if (here >= CRON_LIMITS.chatJobs) {
    return cronRefuse('too_many', `this chat has ${here} active cron jobs, and the limit is ${CRON_LIMITS.chatJobs}: pause or remove one first`);
  }
  return undefined;
}

function chatOf(delivery: CronDelivery | null): CronChat | null {
  return delivery === null ? null : { channel: delivery.channel, account: delivery.account, chat: delivery.chat };
}

export interface NewJob {
  jobId: string;
  name: string;
  schedule: string;
  tz: string;
  role: string;
  workspace: string;
  prompt: string;
  script: string | null;
  delivery: CronDelivery | null;
  nextRunAt: number;
  createdBy: string;
  createdVia: unknown;
  idempotencyKey: string | null;
}

/** Add an active job, or answer the one its key already made (§3.1). The limits are counted here. */
export function addJob(db: Db, job: NewJob, now: number): CronResult<{ job: JobRow; existing: boolean }> {
  return txImmediate(db, (d) => {
    if (job.idempotencyKey !== null) {
      const existing = jobByKey(d, job.idempotencyKey);
      if (existing !== undefined) return { ok: true, job: existing, existing: true };
    }
    const over = limitRefused(d, chatOf(job.delivery), undefined);
    if (over !== undefined) return over;
    const del = job.delivery;
    d.prepare(
      `INSERT INTO cron_jobs (job_id, name, schedule, tz, role, workspace, prompt, script, delivery_channel, delivery_account,
         delivery_chat, delivery_thread, delivery_root, state, next_run_at, created_by, created_via, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    ).run(
      job.jobId,
      redactKnownSecrets(job.name),
      job.schedule,
      job.tz,
      job.role,
      job.workspace,
      redactKnownSecrets(job.prompt),
      job.script,
      del?.channel ?? null,
      del?.account ?? null,
      del?.chat ?? null,
      del?.thread ?? '',
      del?.root ?? null,
      job.nextRunAt,
      job.createdBy,
      JSON.stringify(maskVia(job.createdVia)),
      job.idempotencyKey,
      now,
      now,
    );
    return { ok: true, job: mustJob(d, job.jobId), existing: false };
  });
}

export interface JobPatch {
  name?: string;
  schedule?: string;
  tz?: string;
  role?: string;
  workspace?: string;
  prompt?: string;
  script?: string | null;
  delivery?: CronDelivery | null;
  /** The next run from now, for an edit of the schedule or the zone of an active job (§2.5). */
  nextRunAt?: number;
}

/** Change a job that is not removed; an active job moved to another chat is counted there (§8). */
export function editJob(db: Db, jobId: string, patch: JobPatch, now: number): CronResult<{ job: JobRow }> {
  return txImmediate(db, (d) => {
    const job = getJob(d, jobId);
    if (job === undefined || job.state === 'removed') return cronRefuse('not_found', `there is no cron job ${jobId}`);
    if (patch.delivery !== undefined && job.state === 'active') {
      const over = limitRefused(d, chatOf(patch.delivery), jobId);
      if (over !== undefined) return over;
    }
    const sets: string[] = [];
    const args: unknown[] = [];
    const set = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      args.push(value);
    };
    if (patch.name !== undefined) set('name', redactKnownSecrets(patch.name));
    if (patch.schedule !== undefined) set('schedule', patch.schedule);
    if (patch.tz !== undefined) set('tz', patch.tz);
    if (patch.role !== undefined) set('role', patch.role);
    if (patch.workspace !== undefined) set('workspace', patch.workspace);
    if (patch.prompt !== undefined) set('prompt', redactKnownSecrets(patch.prompt));
    if (patch.script !== undefined) set('script', patch.script);
    if (patch.delivery !== undefined) {
      set('delivery_channel', patch.delivery?.channel ?? null);
      set('delivery_account', patch.delivery?.account ?? null);
      set('delivery_chat', patch.delivery?.chat ?? null);
      set('delivery_thread', patch.delivery?.thread ?? '');
      set('delivery_root', patch.delivery?.root ?? null);
    }
    if (patch.nextRunAt !== undefined && job.state === 'active') set('next_run_at', patch.nextRunAt);
    set('updated_at', now);
    d.prepare(`UPDATE cron_jobs SET ${sets.join(', ')} WHERE job_id = ?`).run(...args, jobId);
    return { ok: true, job: mustJob(d, jobId) };
  });
}

function stateRefusal(job: JobRow | undefined, jobId: string): CronRefusal {
  if (job === undefined || job.state === 'removed') return cronRefuse('not_found', `there is no cron job ${jobId}`);
  return cronRefuse('state', `cron job ${jobId} is ${job.state}`);
}

/** Pause an active job: it does not fire, and has no next run (§2.5). */
export function pauseJob(db: Db, jobId: string, now: number): CronResult<{ job: JobRow }> {
  return txImmediate(db, (d) => {
    const job = getJob(d, jobId);
    if (job?.state !== 'active') return stateRefusal(job, jobId);
    d.prepare("UPDATE cron_jobs SET state = 'paused', next_run_at = NULL, updated_at = ? WHERE job_id = ?").run(now, jobId);
    return { ok: true, job: mustJob(d, jobId) };
  });
}

/** Resume a paused job at `nextRunAt`, its failures cleared; it counts toward the limits again (§2.5, §8). */
export function resumeJob(db: Db, jobId: string, nextRunAt: number, now: number): CronResult<{ job: JobRow }> {
  return txImmediate(db, (d) => {
    const job = getJob(d, jobId);
    if (job?.state !== 'paused') return stateRefusal(job, jobId);
    const over = limitRefused(d, chatOf(job.delivery), jobId);
    if (over !== undefined) return over;
    d.prepare("UPDATE cron_jobs SET state = 'active', next_run_at = ?, failures = 0, updated_at = ? WHERE job_id = ?").run(nextRunAt, now, jobId);
    return { ok: true, job: mustJob(d, jobId) };
  });
}

/** Remove a job: soft, until the tick has stopped its fire and purges it (§4.6). */
export function removeJob(db: Db, jobId: string, now: number): CronResult<{ job: JobRow }> {
  return txImmediate(db, (d) => {
    const job = getJob(d, jobId);
    if (job === undefined || job.state === 'removed') return cronRefuse('not_found', `there is no cron job ${jobId}`);
    d.prepare("UPDATE cron_jobs SET state = 'removed', next_run_at = NULL, run_requested_at = NULL, updated_at = ? WHERE job_id = ?").run(now, jobId);
    return { ok: true, job: mustJob(d, jobId) };
  });
}

/** Ask for a run now: the pending stamp, set once however often it is asked (§4.5). Refused while a fire runs. */
export function requestRun(db: Db, jobId: string, now: number): CronResult<{ job: JobRow }> | (CronRefusal & { running?: FireRow }) {
  return txImmediate(db, (d) => {
    const job = getJob(d, jobId);
    if (job === undefined || job.state === 'removed') return cronRefuse('not_found', `there is no cron job ${jobId}`);
    const running = runningFire(d, jobId);
    if (running !== undefined) return { ...cronRefuse('running', `a fire of ${jobId} is running`), running };
    if (job.runRequestedAt === null) {
      d.prepare('UPDATE cron_jobs SET run_requested_at = ?, updated_at = ? WHERE job_id = ?').run(now, now, jobId);
    }
    return { ok: true, job: mustJob(d, jobId) };
  });
}

/** What the scheduler read of a job, for the compare-and-set (§4.2). */
export interface Expected {
  jobId: string;
  trigger: FireTrigger;
  /** For a slot: the next run the tick read. */
  slot?: number;
  /** The schedule and zone the advance was computed from. */
  schedule: string;
  tz: string;
  /** The next run to advance to after this slot; undefined for a one-off, which is then done. */
  next?: number;
}

/** Whether the job is still as the scheduler read it; else a refusal saying it moved. */
function moved(d: Db, e: Expected): CronRefusal | JobRow {
  const job = getJob(d, e.jobId);
  if (job === undefined || job.state === 'removed') return cronRefuse('not_found', `there is no cron job ${e.jobId}`);
  if (e.trigger === 'run') {
    if (job.runRequestedAt === null) return cronRefuse('moved', `cron job ${e.jobId} has no run asked for`);
    return job;
  }
  if (job.state !== 'active' || job.nextRunAt !== e.slot || job.schedule !== e.schedule || job.tz !== e.tz) {
    return cronRefuse('moved', `cron job ${e.jobId} is no longer due at that slot`);
  }
  return job;
}

/** The advance, inside a fire's or a skip's transaction: a slot's next run or done, a stamp cleared. */
function advanceIn(d: Db, e: Expected, now: number): void {
  if (e.trigger === 'run') {
    d.prepare('UPDATE cron_jobs SET run_requested_at = NULL, updated_at = ? WHERE job_id = ?').run(now, e.jobId);
  } else if (e.next === undefined) {
    d.prepare("UPDATE cron_jobs SET state = 'done', next_run_at = NULL, updated_at = ? WHERE job_id = ?").run(now, e.jobId);
  } else {
    d.prepare('UPDATE cron_jobs SET next_run_at = ?, updated_at = ? WHERE job_id = ?').run(e.next, now, e.jobId);
  }
}

/**
 * Advance a job's next run without a fire, compared as a fire's is: the one
 * write for a slot neither fired nor recorded. `startFire` and `skipFire`
 * advance the same way, in their own transactions.
 */
export function scheduleAfter(db: Db, e: Expected, now: number): CronResult<{ job: JobRow }> {
  return txImmediate(db, (d) => {
    const read = moved(d, e);
    if ('ok' in read) return read;
    advanceIn(d, e, now);
    return { ok: true, job: mustJob(d, e.jobId) };
  });
}

/**
 * A job's fires past its newest 50, and their sessions (§3.2); never one whose
 * message is still to be sent, which its send rebuilds from its session's log.
 */
function pruneIn(d: Db, jobId: string): void {
  const old = d
    .prepare<[string, string, number], FireRaw>(
      `SELECT ${FIRE_COLS} FROM cron_fires WHERE job_id = ? AND ended_at IS NOT NULL AND delivery != 'pending'
        AND fire_id NOT IN (SELECT fire_id FROM cron_fires WHERE job_id = ? ORDER BY fire_id DESC LIMIT ?)`,
    )
    .all(jobId, jobId, CRON_LIMITS.history)
    .map(decodeFire);
  for (const fire of old) deleteFireIn(d, fire);
}

/**
 * A fire's row, and its session with everything that hangs on it when every
 * binding that session ever had is on the `cron` channel; else the row alone,
 * so no session a chat can reach is deleted (§3.2).
 */
function deleteFireIn(d: Db, fire: FireRow): void {
  d.prepare('DELETE FROM cron_fires WHERE fire_id = ?').run(fire.fireId);
  const sessionId = fire.sessionId;
  if (sessionId === null) return;
  const channels = bindingChannelsEver(d, sessionId);
  if (channels.some((c) => c !== CRON_CHANNEL)) return;
  // Still bound anywhere, its own archive not yet done: something can still reach it.
  if (d.prepare('SELECT 1 FROM channel_bindings WHERE session_id = ? AND revoked_at IS NULL').get(sessionId) !== undefined) return;
  for (const table of ['events', 'turns', 'channel_bindings', 'approvals', 'snapshots']) {
    d.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
  }
  d.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export interface StartFire extends Expected {
  /** The slot, or the stamp's time. */
  scheduledAt: number;
  /** `cron.max_running`. */
  maxRunning: number;
}

/**
 * Start a fire (§4.2 step 4): the job re-read and compared, no fire of it
 * running, fewer than `maxRunning` running; the fire inserted and the job
 * advanced, together or not at all.
 */
export function startFire(db: Db, s: StartFire, now: number): CronResult<{ fire: FireRow }> {
  return txImmediate(db, (d) => {
    const read = moved(d, s);
    if ('ok' in read) return read;
    if (runningFire(d, s.jobId) !== undefined) return cronRefuse('running', `a fire of ${s.jobId} is running`);
    const running = d.prepare<[], { n: number }>('SELECT count(*) AS n FROM cron_fires WHERE started_at IS NOT NULL AND ended_at IS NULL').get()?.n ?? 0;
    if (running >= s.maxRunning) return cronRefuse('at_limit', `${running} fires are running, at cron.max_running`);
    const id = Number(
      d.prepare('INSERT INTO cron_fires (job_id, scheduled_at, trigger, started_at) VALUES (?, ?, ?, ?)').run(s.jobId, s.scheduledAt, s.trigger, now)
        .lastInsertRowid,
    );
    advanceIn(d, s, now);
    return { ok: true, fire: mustFire(d, id) };
  });
}

export interface SkipFire extends Expected {
  scheduledAt: number;
  outcome: 'skipped_running' | 'skipped_missed' | 'skipped_unavailable';
  error?: string;
}

/**
 * Record a skip, with the advance (§4.2). `skipped_unavailable` counts a
 * failure, pauses the job at three, and is to be said in its chat (§5.7).
 */
export function skipFire(db: Db, s: SkipFire, now: number): CronResult<{ fire: FireRow; paused: boolean }> {
  return txImmediate(db, (d) => {
    const read = moved(d, s);
    if ('ok' in read) return read;
    const failed = s.outcome === 'skipped_unavailable';
    const delivery = failed && read.delivery !== null ? 'pending' : 'none';
    const id = Number(
      d
        .prepare('INSERT INTO cron_fires (job_id, scheduled_at, trigger, ended_at, outcome, error, delivery) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(s.jobId, s.scheduledAt, s.trigger, now, s.outcome, masked(s.error, CRON_LIMITS.errorBytes), delivery).lastInsertRowid,
    );
    advanceIn(d, s, now);
    const paused = failed && countFailureIn(d, s.jobId, now);
    pruneIn(d, s.jobId);
    return { ok: true, fire: mustFire(d, id), paused };
  });
}

/** One more failure in a row; an active job reaching three is paused. True when this paused it. */
function countFailureIn(d: Db, jobId: string, now: number): boolean {
  d.prepare('UPDATE cron_jobs SET failures = failures + 1, updated_at = ? WHERE job_id = ?').run(now, jobId);
  const job = mustJob(d, jobId);
  if (job.failures < CRON_LIMITS.failures || job.state !== 'active') return false;
  d.prepare("UPDATE cron_jobs SET state = 'paused', next_run_at = NULL, updated_at = ? WHERE job_id = ?").run(now, jobId);
  return true;
}

/** Record the session a fire was given, by its id (§5.2). */
export function attachFireSession(db: Db, fireId: number, sessionId: string): void {
  txImmediate(db, (d) => {
    d.prepare('UPDATE cron_fires SET session_id = ? WHERE fire_id = ? AND session_id IS NULL').run(sessionId, fireId);
  });
}

const FAILURES: readonly FireOutcome[] = ['script_failed', 'agent_failed', 'timed_out'];

export interface EndFire {
  fireId: number;
  outcome: 'posted' | 'nothing' | 'script_failed' | 'agent_failed' | 'timed_out' | 'interrupted';
  error?: string;
  result?: string;
  /** There is a message to post, if the job has somewhere to post it. */
  message: boolean;
}

/**
 * End a running fire, once (§5.6, §5.7): its outcome, result and error; the
 * failure count, and a pause at three; `delivery` `pending` for a message with
 * a delivery, of a job not removed. A fire already ended is left as it was.
 */
export function endFire(db: Db, e: EndFire, now: number): CronResult<{ fire: FireRow; job: JobRow; paused: boolean }> {
  return txImmediate(db, (d) => {
    const fire = getFire(d, e.fireId);
    if (fire === undefined) return cronRefuse('not_found', `there is no cron fire ${e.fireId}`);
    if (fire.endedAt !== null) return cronRefuse('state', `cron fire ${e.fireId} has ended`);
    const job = mustJob(d, fire.jobId);
    const delivery = e.message && job.delivery !== null && job.state !== 'removed' ? 'pending' : 'none';
    d.prepare('UPDATE cron_fires SET ended_at = ?, outcome = ?, error = ?, result = ?, delivery = ? WHERE fire_id = ?').run(
      now,
      e.outcome,
      masked(e.error, CRON_LIMITS.errorBytes),
      masked(e.result, CRON_LIMITS.resultBytes),
      delivery,
      e.fireId,
    );
    let paused = false;
    if (FAILURES.includes(e.outcome)) paused = countFailureIn(d, job.jobId, now);
    else if (e.outcome === 'posted' || e.outcome === 'nothing') {
      d.prepare('UPDATE cron_jobs SET failures = 0, updated_at = ? WHERE job_id = ?').run(now, job.jobId);
    }
    pruneIn(d, job.jobId);
    return { ok: true, fire: mustFire(d, e.fireId), job: mustJob(d, job.jobId), paused };
  });
}

/** A pending delivery's end: `sent`, or `failed` for a send that cannot succeed (§5.6). */
export function markDelivered(db: Db, fireId: number, delivery: 'sent' | 'failed'): void {
  txImmediate(db, (d) => {
    d.prepare("UPDATE cron_fires SET delivery = ? WHERE fire_id = ? AND delivery = 'pending'").run(delivery, fireId);
  });
}

/**
 * At a start (§4.4 step 1): every fire started and not ended is ended
 * `interrupted`, to be said in its chat when its job has one and is not
 * removed; no failure is counted. The fires, as ended.
 */
export function interruptOpenFires(db: Db, now: number): FireRow[] {
  return txImmediate(db, (d) => {
    const open = runningFires(d);
    for (const fire of open) {
      const job = mustJob(d, fire.jobId);
      const delivery = job.delivery !== null && job.state !== 'removed' ? 'pending' : 'none';
      d.prepare("UPDATE cron_fires SET ended_at = ?, outcome = 'interrupted', error = ?, delivery = ? WHERE fire_id = ?").run(
        now,
        'the gateway restarted during the fire',
        delivery,
        fire.fireId,
      );
    }
    return open.map((f) => mustFire(d, f.fireId));
  });
}

/** At a start (§4.4 step 3): the stamps older than `before` dropped. The jobs whose stamp went. */
export function dropStaleStamps(db: Db, before: number, now: number): JobRow[] {
  return txImmediate(db, (d) => {
    const stale = stampedJobs(d).filter((j) => (j.runRequestedAt ?? now) < before);
    for (const job of stale) d.prepare('UPDATE cron_jobs SET run_requested_at = NULL, updated_at = ? WHERE job_id = ?').run(now, job.jobId);
    return stale;
  });
}

/**
 * Delete each removed job with no running fire, with its fires and their
 * sessions (§4.6), but those `keep` names: a job with a fire still in the
 * scheduler's in-flight set. The ids purged.
 */
export function purgeRemoved(db: Db, keep: (jobId: string) => boolean = () => false): string[] {
  return txImmediate(db, (d) => {
    const purged: string[] = [];
    for (const job of removedJobs(d)) {
      if (keep(job.jobId) || runningFire(d, job.jobId) !== undefined) continue;
      for (const fire of d.prepare<[string], FireRaw>(`SELECT ${FIRE_COLS} FROM cron_fires WHERE job_id = ?`).all(job.jobId).map(decodeFire)) {
        deleteFireIn(d, fire);
      }
      d.prepare('DELETE FROM cron_jobs WHERE job_id = ?').run(job.jobId);
      purged.push(job.jobId);
    }
    return purged;
  });
}
