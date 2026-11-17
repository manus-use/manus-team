import { newCronJobId } from '../../src/core/ids.js';
import { addJob, type CronDelivery, type JobRow, type NewJob } from '../../src/db/cron.js';
import type { Db } from '../../src/db/open.js';

/** A cron job's fixtures: a chat's delivery, and an add through the writer. */

export const NOW = Date.UTC(2026, 10, 17, 1, 0);
export const APP = 'cli_app';
export const TEAM: CronDelivery = { channel: 'lark', account: APP, chat: 'oc_team', thread: '', root: null };

export function newJob(db: Db, extra: Partial<NewJob> = {}, now = NOW): JobRow {
  const r = addJob(db, jobInput(extra, now), now);
  if (!r.ok) throw new Error(r.message);
  return r.job;
}

/** A job to add, by default an hourly one delivering to the team's chat. */
export function jobInput(extra: Partial<NewJob> = {}, now = NOW): NewJob {
  return {
    jobId: newCronJobId(),
    name: 'Daily PRs',
    schedule: 'every 1h',
    tz: 'Asia/Shanghai',
    role: 'worker',
    workspace: 'default',
    prompt: 'List the open PRs.',
    script: null,
    delivery: TEAM,
    nextRunAt: now + 3_600_000,
    createdBy: 'operator:alice',
    createdVia: { kind: 'operator' },
    idempotencyKey: null,
    ...extra,
  };
}
