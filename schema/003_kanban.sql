-- manus-team migration 003: the kanban board
-- See docs/specs/2026-11-02-kanban-design.md §3.
--
-- Every kanban table is created here, including the ones later plans write
-- (gates, subscriptions), so that the board never migrates again for v1.
-- db/kanban.ts is the only writer of every table below (src/db/WRITERS.md).

-- ---------------------------------------------------------------------------
-- Tasks. `phase` is the only lifecycle column (§4.1); todo / ready / running
-- are derived from the parents and the runs, never stored.
-- ---------------------------------------------------------------------------
CREATE TABLE kanban_tasks (
  task_id               TEXT PRIMARY KEY,          -- k_..., opaque
  title                 TEXT NOT NULL,
  body                  TEXT NOT NULL DEFAULT '',
  contract              BLOB NOT NULL,             -- JSON: outcome, verification, constraints,
                                                   -- boundaries, stop_when; all optional (§4.3)
  assignee_kind         TEXT CHECK (assignee_kind IN ('role', 'human')),
  assignee              TEXT,                      -- role name, or lark:<union_id>
  reviewer_kind         TEXT CHECK (reviewer_kind IN ('role', 'human')),
  reviewer              TEXT,
  workspace             TEXT,                      -- a name; "fixed" means non-null (§2.3)
  phase                 TEXT NOT NULL CHECK (phase IN ('open', 'review', 'blocked', 'done', 'archived')),
  blocked_from          TEXT CHECK (blocked_from IN ('open', 'review')),
  block_kind            TEXT CHECK (block_kind IN ('needs_input', 'capability', 'transient', 'gave_up')),
  block_reason          TEXT,                      -- the kind and reason survive unblock (§5.4)
  priority              INTEGER NOT NULL DEFAULT 0,
  idempotency_key       TEXT UNIQUE,
  failure_limit         INTEGER,
  retry_on_crash        TEXT NOT NULL DEFAULT 'always'
                          CHECK (retry_on_crash IN ('always', 'if-no-side-effects')),
  max_runtime_s         INTEGER,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  consecutive_transient INTEGER NOT NULL DEFAULT 0,
  cooldown_until        INTEGER,
  block_recurrences     INTEGER NOT NULL DEFAULT 0,
  stranded_notified_at  INTEGER,
  created_by            TEXT NOT NULL,
  created_via           BLOB NOT NULL,             -- JSON: the chat, or the creating run
  created_at            INTEGER NOT NULL,
  closed_at             INTEGER,
  created_from_task     TEXT REFERENCES kanban_tasks(task_id),  -- not a link (§2.3)

  CHECK ((assignee_kind IS NULL) = (assignee IS NULL)),
  CHECK ((reviewer_kind IS NULL) = (reviewer IS NULL)),
  -- blocked_from is set with blocked and only then; a blocked task always has a kind.
  CHECK ((phase = 'blocked') = (blocked_from IS NOT NULL)),
  CHECK (phase <> 'blocked' OR block_kind IS NOT NULL)
) STRICT;

CREATE INDEX idx_kanban_tasks_phase ON kanban_tasks(phase, priority DESC, created_at);

-- ---------------------------------------------------------------------------
-- Dependency links. Cycles and links onto a task with an open run are refused
-- by the writer (§3.2); a self-link is refused here too.
-- ---------------------------------------------------------------------------
CREATE TABLE kanban_links (
  parent_id   TEXT NOT NULL REFERENCES kanban_tasks(task_id),
  child_id    TEXT NOT NULL REFERENCES kanban_tasks(task_id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (parent_id, child_id),
  CHECK (parent_id <> child_id)
) STRICT;

CREATE INDEX idx_kanban_links_child ON kanban_links(child_id);

-- ---------------------------------------------------------------------------
-- Runs: one attempt each (§3.3). Decided when `outcome` is set, closed when
-- `ended_at` is. A closed run is always decided.
-- ---------------------------------------------------------------------------
CREATE TABLE kanban_runs (
  run_id           TEXT PRIMARY KEY,               -- r_...
  task_id          TEXT NOT NULL REFERENCES kanban_tasks(task_id),
  attempt          INTEGER NOT NULL,               -- from 1 per task, across kinds
  kind             TEXT NOT NULL CHECK (kind IN ('work', 'review')),
  assignee_kind    TEXT NOT NULL CHECK (assignee_kind IN ('role', 'human')),
  assignee         TEXT NOT NULL,                  -- a snapshot: reassigning does not rewrite it
  agent_config     BLOB,                           -- JSON; an agent run's agent, env NAMES only
  workspace        TEXT,
  role_md_hash     TEXT,
  session_id       TEXT REFERENCES sessions(id),
  seeded_from_run  TEXT REFERENCES kanban_runs(run_id),
  token_hash       TEXT,                           -- the token itself is never stored
  outcome          TEXT CHECK (outcome IN (
                     'completed', 'review_requested', 'changes_requested', 'blocked',
                     'failed', 'crashed', 'timed_out', 'protocol_violation', 'rate_limited',
                     'terminal_provider', 'interrupted', 'cancelled', 'superseded')),
  summary          TEXT,
  metadata         BLOB,                           -- JSON
  reported_commit  TEXT,
  reported_dirty   INTEGER CHECK (reported_dirty IN (0, 1)),
  error            TEXT,
  last_output      TEXT,
  submissions      INTEGER NOT NULL DEFAULT 0,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  UNIQUE (task_id, attempt),
  CHECK (ended_at IS NULL OR outcome IS NOT NULL),
  CHECK ((assignee_kind = 'role') = (agent_config IS NOT NULL)),
  -- A person's run has no process, so no session (§3.3).
  CHECK (assignee_kind = 'role' OR session_id IS NULL)
) STRICT;

-- At most one open run per task: two claims racing fail here, not as two agents.
CREATE UNIQUE INDEX idx_kanban_runs_one_open ON kanban_runs(task_id) WHERE ended_at IS NULL;
-- One gateway session belongs to at most one run.
CREATE UNIQUE INDEX idx_kanban_runs_session ON kanban_runs(session_id) WHERE session_id IS NOT NULL;
-- The worker CLI finds a run by its token's hash (plan C3); no two runs share one.
CREATE UNIQUE INDEX idx_kanban_runs_token ON kanban_runs(token_hash) WHERE token_hash IS NOT NULL;
-- The per-workspace limit counts open agent runs (§6.3).
CREATE INDEX idx_kanban_runs_open_ws ON kanban_runs(workspace)
  WHERE ended_at IS NULL AND assignee_kind = 'role';

-- ---------------------------------------------------------------------------
-- Comments, gates, subscriptions (§3.4).
-- ---------------------------------------------------------------------------
CREATE TABLE kanban_comments (
  id          INTEGER PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES kanban_tasks(task_id),
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_kanban_comments_task ON kanban_comments(task_id, id);

-- Written from plan C4. A command is never masked: a gate containing a known
-- secret is refused at creation instead (§10.1).
CREATE TABLE kanban_gates (
  id          INTEGER PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES kanban_tasks(task_id),
  command     TEXT NOT NULL,
  timeout_s   INTEGER NOT NULL DEFAULT 300,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_kanban_gates_task ON kanban_gates(task_id, id);

-- Written from plan D. The same cursor discipline as a binding's cursor_seq.
CREATE TABLE kanban_subscriptions (
  id               INTEGER PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES kanban_tasks(task_id),
  channel          TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  thread_id        TEXT NOT NULL DEFAULT '',
  cursor           INTEGER NOT NULL DEFAULT 0,      -- last kanban_events.id delivered
  created_at       INTEGER NOT NULL,
  UNIQUE (task_id, channel, account_id, conversation_id, thread_id)
) STRICT;

-- ---------------------------------------------------------------------------
-- The board's log. Append-only; every change to a task writes one row, in the
-- same transaction. AUTOINCREMENT so an id is never reused: subscription
-- cursors point into it.
-- ---------------------------------------------------------------------------
CREATE TABLE kanban_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES kanban_tasks(task_id),
  run_id      TEXT REFERENCES kanban_runs(run_id),
  kind        TEXT NOT NULL,
  actor       TEXT NOT NULL,
  payload     BLOB NOT NULL,                     -- JSON, string values masked on write
  created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_kanban_events_task ON kanban_events(task_id, id);

UPDATE schema_version SET version = 3;
