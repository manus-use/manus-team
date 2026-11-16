-- manus-team migration 009: workflows, their instances and their members
-- See docs/specs/2026-11-02-kanban-design.md §21.7.
--
-- An instance is one start of a workflow, or one apply of a DAG: the DAG it was
-- made from, and the tasks it made, its members. Nothing in the kernel reads
-- either table: kanban_tasks is unchanged, and the dispatcher, the claim, the
-- prompt and the notices know nothing of workflows (§1). Foreign keys are
-- allowed here, as both tables are new. db/kanban.ts is the only writer of both
-- (src/db/WRITERS.md): every row is written in the apply's transaction, with its
-- tasks, and never changed or removed. `dag` and `created_via` are stored as
-- text, checked to be JSON, unlike a task's JSONB columns: `dag` holds the
-- masked DAG's canonical form, byte for byte, read back whole by `show --dag`.
CREATE TABLE kanban_workflow_instances (
  instance_id      TEXT PRIMARY KEY,                -- w_..., opaque
  name             TEXT,                            -- the workflow's, or null for a DAG with none
  dag              TEXT NOT NULL CHECK (json_valid(dag)),  -- the DAG it was made from (§21.5), masked
                                                    -- on write but its gates' commands
  dag_sha256       TEXT NOT NULL,                   -- of the DAG's canonical form, unmasked; never printed
  source           TEXT NOT NULL CHECK (source IN ('start', 'apply')),
  board            TEXT NOT NULL REFERENCES kanban_boards(name),
  created_by       TEXT NOT NULL,
  created_via      TEXT NOT NULL CHECK (json_valid(created_via)),  -- the chat, the run, or the operator
  idempotency_key  TEXT UNIQUE,
  created_at       INTEGER NOT NULL
) STRICT;

-- `instances` reads at most a board's 200 newest (§21.10).
CREATE INDEX idx_kanban_workflow_instances_board ON kanban_workflow_instances(board, created_at);

-- A task is a member of at most one instance; its ref is unique in its DAG, and
-- its position is its place in the DAG's array, from 0.
CREATE TABLE kanban_workflow_tasks (
  task_id      TEXT PRIMARY KEY REFERENCES kanban_tasks(task_id),
  instance_id  TEXT NOT NULL REFERENCES kanban_workflow_instances(instance_id),
  ref          TEXT NOT NULL,
  step         TEXT NOT NULL,
  item         TEXT,                                -- the for_each item, masked; null for none
  position     INTEGER NOT NULL CHECK (position >= 0),
  UNIQUE (instance_id, position),
  UNIQUE (instance_id, ref)
) STRICT, WITHOUT ROWID;

-- An instance's related tasks are found by it (§21.10), and nothing indexed it
-- before. A new index writes no row of the table, and is built in this
-- migration's transaction.
CREATE INDEX idx_kanban_tasks_created_from ON kanban_tasks(created_from_task);

UPDATE schema_version SET version = 9;
