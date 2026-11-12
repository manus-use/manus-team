-- manus-team migration 008: the root of a task's thread
-- See docs/specs/2026-11-02-kanban-design.md §19.
--
-- A task created by `/kanban task new` in a group at chat scope is answered in a
-- thread on its command message, and its subscription moves to that thread. Lark
-- replies in a thread to a message, by its id, so the subscription records the
-- thread's root: the command message, or for a task created in an existing
-- thread, the root Lark gave the command. null, no root is known: every
-- subscription from before this migration, every one at chat scope, and every
-- direct message. A board send in a thread with a root replies to it, and a
-- person's card goes in a thread only when it has one. db/kanban.ts is its only
-- writer (src/db/WRITERS.md): at the insert, copied to a follow-up, and once by
-- threadSubscription; never changed once written. No default and no rewrite.
ALTER TABLE kanban_subscriptions ADD COLUMN root_message_id TEXT;

UPDATE schema_version SET version = 8;
