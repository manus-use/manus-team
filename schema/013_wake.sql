-- manus-team migration 013: wakes, a task's outcomes starting a turn
-- See docs/specs/2026-11-19-wake-design.md §4, §5.9 and §19.
--
-- A task with wake on (`wake_by` set) has its outcomes read by the waker from
-- a cursor of its own, `wake_cursor`, beside the notifier's `cursor`, and
-- handed to the chat session of the conversation that follows it, or, with
-- `wake_role` set, made into a reaction task that role runs; a role's wake on a
-- task no chat follows is read from the task's own `wake_cursor` instead. `kanban_wakes`
-- holds one row a woken turn, or a reaction task, with its events in
-- `kanban_wake_events`; `kanban_deferred_buttons` the Unblock buttons that wait
-- for the agent's try. db/kanban.ts is the only writer (src/db/WRITERS.md).
ALTER TABLE kanban_subscriptions ADD COLUMN wake_cursor INTEGER NOT NULL DEFAULT 0;
  -- last kanban_events.id the waker has covered: woken, skipped or passed over
ALTER TABLE kanban_tasks ADD COLUMN wake_by TEXT;
  -- lark:<union_id> the woken turns run as; null: wake off
ALTER TABLE kanban_tasks ADD COLUMN wake_depth INTEGER NOT NULL DEFAULT 0;
  -- woken turns in the task's making: 0 for a person's or the terminal's task
ALTER TABLE kanban_subscriptions ADD COLUMN chat_type TEXT CHECK (chat_type IN ('p2p', 'group'));
  -- the chat's kind, from the command that made the task; null: not known
ALTER TABLE kanban_tasks ADD COLUMN wake_role TEXT;
  -- the role a wake targets; null: the conversation's chat session. Only with wake_by set
ALTER TABLE kanban_tasks ADD COLUMN reaction_of INTEGER;
  -- for a reaction task: the kanban_wakes row that made it; null for every other task
ALTER TABLE kanban_tasks ADD COLUMN wake_root TEXT;
  -- made under a wake: the root reaction task's id, its own for a reaction task; null otherwise
ALTER TABLE kanban_tasks ADD COLUMN wake_cursor INTEGER NOT NULL DEFAULT 0;
  -- a role's wake with no chat: the last kanban_events id the waker has covered for the task; unused while it has a subscription

CREATE TABLE kanban_wakes (
  wake_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid             TEXT NOT NULL UNIQUE,            -- wakeBatchUuid of its (subscription, event) pairs
  channel          TEXT NOT NULL,                   -- the conversation it woke: lark
  app_id           TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  thread_id        TEXT NOT NULL DEFAULT '',
  principal        TEXT NOT NULL,                   -- lark:<union_id>: the turn runs as them
  depth            INTEGER NOT NULL,                -- the highest wake_depth of its tasks
  state            TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'dropped', 'lifted')),
  attempt          INTEGER NOT NULL DEFAULT 1,      -- the submit it is on; a refusal adds one
  session_id       TEXT,                            -- the session the current attempt went to; null until it is submitted
  turn_key         TEXT,                            -- the current attempt's turn idempotency key; null with session_id
  submit_boot      TEXT,                            -- BOOT_ID of the process that submitted the current attempt; null with session_id
  marker_at        INTEGER,                         -- when its marker was sent, or tried: once a batch
  created_at       INTEGER NOT NULL,
  delivered_at     INTEGER,                         -- set once, with state delivered
  closed_at        INTEGER,                         -- set once, with state dropped or lifted
  error            TEXT,                            -- the last refusal, masked, cut at 500
  target_role      TEXT,                            -- a role's wake: the role; null for a chat turn
  reaction_task    TEXT,                            -- a role's wake: the reaction task it made; null for a chat turn
  CHECK ((target_role IS NULL) = (reaction_task IS NULL)),
  CHECK (target_role IS NULL OR (state = 'delivered' AND session_id IS NULL)),
  CHECK ((state = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK ((state IN ('dropped', 'lifted')) = (closed_at IS NOT NULL)),
  CHECK ((session_id IS NULL) = (turn_key IS NULL)),
  CHECK ((session_id IS NULL) = (submit_boot IS NULL))
) STRICT;

CREATE INDEX idx_kanban_wakes_hour ON kanban_wakes(app_id, channel, conversation_id, thread_id, delivered_at)
  WHERE state = 'delivered';
CREATE INDEX idx_kanban_wakes_turn ON kanban_wakes(session_id, turn_key);
CREATE UNIQUE INDEX idx_kanban_wakes_reaction ON kanban_wakes(reaction_task) WHERE reaction_task IS NOT NULL;
CREATE INDEX idx_kanban_wakes_pending ON kanban_wakes(app_id) WHERE state = 'pending';

CREATE TABLE kanban_wake_events (
  wake_id          INTEGER NOT NULL REFERENCES kanban_wakes(wake_id),
  subscription_id  INTEGER NOT NULL,
  event_id         INTEGER NOT NULL,                -- an outcome the turn was told of
  task_id          TEXT NOT NULL,
  PRIMARY KEY (wake_id, subscription_id, event_id)
) STRICT;

CREATE INDEX idx_kanban_wake_events_task ON kanban_wake_events(task_id, wake_id);

CREATE TABLE kanban_deferred_buttons (
  subscription_id  INTEGER NOT NULL,
  event_id         INTEGER NOT NULL,                -- the block whose Unblock button waits for the agent
  task_id          TEXT NOT NULL,
  app_id           TEXT NOT NULL,
  held_at          INTEGER NOT NULL,                -- when its notice, without the button, was sent
  state            TEXT NOT NULL CHECK (state IN ('held', 'due', 'sent', 'lifted', 'failed')),
  why              TEXT,                            -- why it is due: tried, not_woken, turn_failed, running, restart
  attempts         INTEGER NOT NULL DEFAULT 0,      -- sends of the button card tried
  message_id       TEXT,                            -- the button card, once sent
  ended_at         INTEGER,                         -- set once, with state sent, lifted or failed
  PRIMARY KEY (subscription_id, event_id),
  CHECK ((state IN ('sent', 'lifted', 'failed')) = (ended_at IS NOT NULL)),
  CHECK ((state = 'sent') = (message_id IS NOT NULL))
) STRICT;

CREATE INDEX idx_kanban_deferred_buttons_open ON kanban_deferred_buttons(app_id, state) WHERE state IN ('held', 'due');

ALTER TABLE kanban_unblock_buttons ADD COLUMN has_button INTEGER NOT NULL DEFAULT 1;
  -- 0: a notice whose block's button was deferred; recorded only so the redraw can add its lifted line

UPDATE schema_version SET version = 13;
