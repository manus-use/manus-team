-- manus-team migration 015: workflow routing
-- See docs/specs/2026-11-26-workflow-routing-design.md §8.
--
-- A started instance keeps its plan, frozen: each step's conditions, fan-out,
-- outputs, routes and template (§7.3). A pending step has one row, `waiting`
-- until it is made or skipped, once; a member's settling, plain steps included,
-- one row whose winner is read for good (§2.3); a route, one row keyed on the
-- event it routed (§5.3). Nothing in the kernel reads any of them: the writer,
-- db/kanban.ts, writes them in the transitions that settle, block or give up a
-- task (§9), and is their only writer (src/db/WRITERS.md). An instance made
-- before 015 has a null plan and no row, and is read, shown and archived as
-- before (§8).
ALTER TABLE kanban_workflow_instances ADD COLUMN plan TEXT CHECK (plan IS NULL OR json_valid(plan));
ALTER TABLE kanban_workflow_instances ADD COLUMN routing_failed_at INTEGER;  -- a fault not yet reconciled (§9.4)

CREATE TABLE kanban_workflow_pending (
  instance_id  TEXT NOT NULL REFERENCES kanban_workflow_instances(instance_id),
  step         TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('waiting', 'made', 'skipped')),
  reason       TEXT CHECK (reason IS NULL OR json_valid(reason)),  -- why it was made or skipped, masked
  items        TEXT CHECK (items IS NULL OR json_valid(items)),    -- a fan-out's join marker: [{item, taskId, ref}]
  cause_event  INTEGER,                                            -- the event whose transaction decided it
  decided_at   INTEGER,
  PRIMARY KEY (instance_id, step),
  CHECK ((state = 'waiting') = (decided_at IS NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_kanban_workflow_pending_waiting ON kanban_workflow_pending(instance_id) WHERE state = 'waiting';

-- A member's settling, plain steps included: whose result is the member's, for good (§2.3).
-- ref: the step's name for a step that is no fan-out, and for a fan-out's own row; an item's ref for an item.
CREATE TABLE kanban_workflow_settled (
  instance_id  TEXT NOT NULL REFERENCES kanban_workflow_instances(instance_id),
  step         TEXT NOT NULL,
  ref          TEXT NOT NULL,
  how          TEXT NOT NULL CHECK (how IN ('done', 'stood_in', 'skipped', 'archived')),
  task_id      TEXT REFERENCES kanban_tasks(task_id),               -- the winner; null for skipped, archived, a fan-out's own row
  event_id     INTEGER NOT NULL,                                   -- see §8: the fact that settled it, not the transaction
  settled_at   INTEGER NOT NULL,
  PRIMARY KEY (instance_id, step, ref)
) STRICT, WITHOUT ROWID;

CREATE TABLE kanban_workflow_routes (
  instance_id  TEXT NOT NULL REFERENCES kanban_workflow_instances(instance_id),
  handler      TEXT NOT NULL,
  event_id     INTEGER NOT NULL,                                   -- the blocked or run_ended event routed
  from_task    TEXT NOT NULL REFERENCES kanban_tasks(task_id),
  outcome      TEXT NOT NULL CHECK (outcome IN ('made', 'over_limit', 'over_cap')),
  task_id      TEXT REFERENCES kanban_tasks(task_id),               -- the handler's task; null unless made
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (instance_id, handler, event_id),
  CHECK ((outcome = 'made') = (task_id IS NOT NULL))
) STRICT;

CREATE INDEX idx_kanban_workflow_routes_from ON kanban_workflow_routes(from_task);
CREATE INDEX idx_kanban_workflow_routes_task ON kanban_workflow_routes(task_id) WHERE task_id IS NOT NULL;

UPDATE schema_version SET version = 15;
