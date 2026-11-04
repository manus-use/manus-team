-- manus-team migration 004: which comments may steer an agent, and an index for
-- the notifier's read of a bot's subscriptions
-- See docs/specs/2026-11-02-kanban-design.md §7.5, §9.1.
--
-- Anyone at talk tier may comment on a task from chat, and everyone sees the
-- comments in /kanban show. Only a comment that may steer -- a run's, or an
-- operator's -- is forwarded to an undecided agent run or put in a run's
-- prompt. Every comment written before this migration came from a run or
-- through the service's tests, so they keep steering. db/kanban.ts stays the
-- only writer (src/db/WRITERS.md).
ALTER TABLE kanban_comments ADD COLUMN steers INTEGER NOT NULL DEFAULT 1 CHECK (steers IN (0, 1));

-- The notifier's round reads this bot's subscriptions every 2 s (spec §9.4):
-- by account, through an index rather than a scan of every subscription ever made.
CREATE INDEX idx_kanban_subscriptions_account ON kanban_subscriptions(account_id);

UPDATE schema_version SET version = 4;
