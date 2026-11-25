-- manus-team migration 014: the progress card of a board run
-- See docs/specs/2026-11-24-progress-cards-design.md §4.
--
-- A row is one agent run's progress card: written when the progress loop finds
-- the run due a card, before its first send, then its message once the send
-- landed, how far the last landed draw read the run's session and when, Lark's
-- refusals in a row, and its state: `open` until it is drawn final (`final`)
-- or let go of (`let_go`), once. `try_number` and `try_limit` are "run N of M",
-- read by the insert from the task. db/kanban.ts is the only writer
-- (src/db/WRITERS.md).
CREATE TABLE kanban_progress_cards (
  run_id      TEXT PRIMARY KEY REFERENCES kanban_runs(run_id),  -- one card per run
  task_id     TEXT NOT NULL,
  app_id      TEXT NOT NULL,                       -- this bot's, as a subscription's
  channel     TEXT NOT NULL,                       -- the channel it goes by: lark
  message_id  TEXT,                                -- the card, as the channel answered its send; null until then
  read_seq    INTEGER NOT NULL DEFAULT 0,          -- the session event the last landed draw showed through
  drawn_at    INTEGER,                             -- unix ms the last draw landed; null until the send
  failures    INTEGER NOT NULL DEFAULT 0,          -- Lark's refusals in a row, of the send or of updates
  state       TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'final', 'let_go')),
  try_number  INTEGER NOT NULL,                    -- "run N of M": N
  try_limit   INTEGER NOT NULL,                    -- and M
  opened_at   INTEGER NOT NULL                     -- unix ms the run was found due: the insert
) STRICT;

CREATE INDEX idx_kanban_progress_cards_open ON kanban_progress_cards(app_id) WHERE state = 'open';

UPDATE schema_version SET version = 14;
