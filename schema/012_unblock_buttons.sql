-- manus-team migration 012: the messages that carry Unblock buttons
-- See docs/specs/2026-11-02-kanban-design.md §9.2, "Amended by the unblock redraw".
--
-- A row is one Unblock button under one message of notices: the message as
-- Lark named it, the task, and the event that blocked it, which the button's
-- `event` value names. Once that block is lifted, by any path, the message is
-- redrawn with a line in place of the button, and `redrawn_for` is set to the
-- `unblocked` event it was redrawn for, whether the redraw succeeded or not, so
-- a redraw is tried once and never again. `markdown` is the message's text as
-- it was sent, masked, the same on each of its rows: the redraw is rebuilt from
-- it. db/kanban.ts is the only writer (src/db/WRITERS.md).
CREATE TABLE kanban_unblock_buttons (
  message_id   TEXT NOT NULL,                       -- the message, as the channel answered the send
  channel      TEXT NOT NULL,                       -- the channel it went by: lark
  app_id       TEXT NOT NULL,                       -- this bot's, as a subscription's
  task_id      TEXT NOT NULL,
  block_event  INTEGER NOT NULL,                    -- the kanban_events id the button is for
  markdown     TEXT NOT NULL,                       -- the message's text as sent, masked
  sent_at      INTEGER NOT NULL,                    -- unix ms
  redrawn_for  INTEGER,                             -- the unblocked event it was redrawn for; null until then
  PRIMARY KEY (message_id, task_id)
) STRICT;

CREATE INDEX idx_kanban_unblock_buttons_due ON kanban_unblock_buttons(app_id, task_id, block_event) WHERE redrawn_for IS NULL;

UPDATE schema_version SET version = 12;
