-- manus-team migration 006: boards, the board's isolated task queues
-- See docs/specs/2026-11-02-kanban-design.md §16.
--
-- A board is a queue of tasks: its own list in chat, its own turn in each
-- dispatcher pass, and optionally its own max_running and default workspace.
-- One database and one dispatcher serve every board, so each task records the
-- board it is on. db/kanban.ts is the only writer of both tables below
-- (src/db/WRITERS.md).
CREATE TABLE kanban_boards (
  name         TEXT PRIMARY KEY,            -- the role grammar (spec §2.1); never renamed
  max_running  INTEGER CHECK (max_running IS NULL OR max_running >= 1),
  workspace    TEXT,                        -- a workspace name: its tasks' default (§2.3 rule 4)
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_by   TEXT,                        -- who last set max_running or the workspace, or archived it
  updated_at   INTEGER,
  archived_at  INTEGER
) STRICT, WITHOUT ROWID;

-- `default` always exists, and every task before this migration is on it.
INSERT INTO kanban_boards (name, created_by, created_at)
VALUES ('default', 'gateway', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));

-- A constant default: SQLite records it in the schema and rewrites no row, so the
-- migration is as quick on a board holding years of tasks as on an empty one. No
-- REFERENCES clause: SQLite refuses one on a column added with a non-null default
-- while foreign keys are on, as the gateway opens its database. db/kanban.ts checks
-- the board exists, in the transaction that creates the task.
ALTER TABLE kanban_tasks ADD COLUMN board TEXT NOT NULL DEFAULT 'default';

CREATE INDEX idx_kanban_tasks_board ON kanban_tasks(board, phase);

-- The board each chat is on (spec §16): a conversation, for one bot, with all its
-- threads. A chat with no row is on `default`.
CREATE TABLE kanban_chat_boards (
  channel          TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  board            TEXT NOT NULL REFERENCES kanban_boards(name),
  set_by           TEXT NOT NULL,
  set_at           INTEGER NOT NULL,
  PRIMARY KEY (channel, account_id, conversation_id)
) STRICT, WITHOUT ROWID;

UPDATE schema_version SET version = 6;
