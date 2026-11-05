-- manus-team migration 005: the people the gateway has seen in Lark
-- See docs/specs/2026-11-02-kanban-design.md §4.2, §9.1.
--
-- The board knows a person by union_id (lark:<union_id>); the allowlists that
-- decide tiers hold open_ids. A person named by principal alone -- typed out in
-- chat, or by an agent's mt kanban create or review -- can be checked for talk
-- tier (spec §4.2) only through an open_id Lark gave for the same person. So
-- each /kanban sender, each person a /kanban command mentions, and each person
-- who presses a board card's button is noted here, with the ids and the name
-- Lark gave. db/people.ts is the only writer (src/db/WRITERS.md).
CREATE TABLE people (
  app_id   TEXT NOT NULL,
  union_id TEXT NOT NULL,
  open_id  TEXT NOT NULL,
  name     TEXT,
  seen_at  INTEGER NOT NULL,
  PRIMARY KEY (app_id, union_id)
) STRICT, WITHOUT ROWID;

UPDATE schema_version SET version = 5;
