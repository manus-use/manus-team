-- manus-team migration 004: which comments may steer an agent
-- See docs/specs/2026-11-02-kanban-design.md §7.5, §9.1.
--
-- Anyone at talk tier may comment on a task from chat, and everyone sees the
-- comments in /kanban show. Only a comment that may steer -- a run's, or an
-- operator's -- is forwarded to an undecided agent run or put in a run's
-- prompt. Every comment written before this migration came from a run or
-- through the service's tests, so they keep steering. db/kanban.ts stays the
-- only writer (src/db/WRITERS.md).
ALTER TABLE kanban_comments ADD COLUMN steers INTEGER NOT NULL DEFAULT 1 CHECK (steers IN (0, 1));

UPDATE schema_version SET version = 4;
