-- manus-team migration 007: a task's own directory, in an isolated workspace
-- See docs/specs/2026-11-02-kanban-design.md §18.
--
-- A task in a workspace written `{ path, isolated: true }` works in a directory of
-- its own, so tasks in one repository run side by side. Which it does is decided
-- once, at its first agent claim, and kept: `worktree` is the id of its directory,
-- `wt:<task_id>`, a row the workspaces table gains when the directory is made;
-- null, the task works in its workspace's shared directory, as every task did
-- before this migration. Written once, by the claim, while null; db/kanban.ts is
-- its only writer (src/db/WRITERS.md). No default and no rewrite: every existing
-- task reads null.
ALTER TABLE kanban_tasks ADD COLUMN worktree TEXT;

UPDATE schema_version SET version = 7;
