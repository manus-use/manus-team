-- manus-team migration 010: cron jobs and their fires
-- See docs/specs/2026-11-16-cron-design.md §3.
--
-- A job is a schedule, a role, a prompt and an optional operator's script,
-- fired by the gateway into a fresh session of the role, its answer posted to
-- one chat or thread, or to none. A fire is one firing, or one skip, of a job.
-- Both tables are new, so foreign keys are allowed, as in 009. db/cron.ts is
-- the only writer of both (src/db/WRITERS.md). Nothing of the board reads them.
CREATE TABLE cron_jobs (
  job_id            TEXT PRIMARY KEY,                -- c_..., opaque
  name              TEXT NOT NULL,                   -- one line, masked on write
  schedule          TEXT NOT NULL,                   -- as written (§2.1)
  tz                TEXT NOT NULL,                   -- an IANA zone, as Intl names it (§2.2)
  role              TEXT NOT NULL,
  workspace         TEXT NOT NULL,
  prompt            TEXT NOT NULL,                   -- masked on write
  script            TEXT,                            -- as written, never masked; null for none
  delivery_channel  TEXT,                            -- null: no delivery, history only (§2.4)
  delivery_account  TEXT,
  delivery_chat     TEXT,
  delivery_thread   TEXT NOT NULL DEFAULT '',
  delivery_root     TEXT,                            -- a thread's root, as kanban_subscriptions'
  state             TEXT NOT NULL CHECK (state IN ('active', 'paused', 'done', 'removed')),
  next_run_at       INTEGER,                         -- unix ms; set exactly while active
  failures          INTEGER NOT NULL DEFAULT 0,      -- failed fires in a row (§5.7)
  run_requested_at  INTEGER,                         -- the pending stamp of a run (§4.5)
  created_by        TEXT NOT NULL,                   -- lark:<union_id>, operator:<login>, run:<id>, session:<id>
  created_via       TEXT NOT NULL CHECK (json_valid(created_via)),
  idempotency_key   TEXT UNIQUE,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  CHECK ((state = 'active') = (next_run_at IS NOT NULL)),
  CHECK ((delivery_channel IS NULL) = (delivery_chat IS NULL)),
  CHECK ((delivery_channel IS NULL) = (delivery_account IS NULL))
) STRICT;

CREATE INDEX idx_cron_jobs_due ON cron_jobs(state, next_run_at);
CREATE INDEX idx_cron_jobs_chat ON cron_jobs(delivery_channel, delivery_account, delivery_chat);

CREATE TABLE cron_fires (
  fire_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        TEXT NOT NULL REFERENCES cron_jobs(job_id),
  scheduled_at  INTEGER NOT NULL,                    -- the slot, or the run's request time
  trigger       TEXT NOT NULL CHECK (trigger IN ('schedule', 'run')),
  started_at    INTEGER,                             -- null for a skip
  ended_at      INTEGER,                             -- null while running
  outcome       TEXT CHECK (outcome IN ('posted', 'nothing', 'script_failed', 'agent_failed',
                  'timed_out', 'skipped_running', 'skipped_missed', 'skipped_unavailable',
                  'interrupted')),
  session_id    TEXT,                                -- the fire's session, once made
  error         TEXT,                                -- masked, at most 2 KiB
  result        TEXT,                                -- the answer, masked, at most 8 KiB
  delivery      TEXT NOT NULL DEFAULT 'none'
                  CHECK (delivery IN ('none', 'pending', 'sent', 'failed')),
  CHECK ((ended_at IS NULL) = (outcome IS NULL)),
  CHECK (started_at IS NOT NULL OR ended_at IS NOT NULL)
) STRICT;

CREATE INDEX idx_cron_fires_job ON cron_fires(job_id, fire_id);
-- At most one running fire a job, whatever writes: the backstop of §4.2.
CREATE UNIQUE INDEX idx_cron_fires_running ON cron_fires(job_id)
  WHERE started_at IS NOT NULL AND ended_at IS NULL;
CREATE INDEX idx_cron_fires_pending ON cron_fires(delivery) WHERE delivery = 'pending';
