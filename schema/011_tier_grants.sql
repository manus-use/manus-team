-- manus-team migration 011: tier grants
-- See docs/specs/2026-11-18-tier-grants-design.md §3.
--
-- A grant gives a person talk or operate tier beside the configuration's
-- lists, made in chat by @-mention or at the terminal, keyed by the bot and
-- the person's union_id. A row is one grant and its one end, never deleted and
-- never re-opened, so the table is the audit trail. At most one active grant a
-- person. db/grants.ts is the only writer (src/db/WRITERS.md).
CREATE TABLE tier_grants (
  grant_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id        TEXT NOT NULL,                      -- this bot's, as people's
  union_id      TEXT NOT NULL,                      -- the person: lark:<union_id>
  open_id       TEXT NOT NULL,                      -- as Lark gave it with the grant; a record, never matched
  tier          TEXT NOT NULL CHECK (tier IN ('talk', 'operate')),
  granted_by    TEXT NOT NULL,                      -- lark:<union_id> or operator:<login>
  granted_via   TEXT NOT NULL CHECK (granted_via IN ('chat', 'terminal')),
  granted_chat  TEXT,                               -- the chat it was made in; null at the terminal
  granted_at    INTEGER NOT NULL,                   -- unix ms
  revoked_at    INTEGER,
  revoked_by    TEXT,
  revoked_via   TEXT CHECK (revoked_via IN ('chat', 'terminal')),
  revoked_chat  TEXT,
  ended         TEXT CHECK (ended IN ('revoked', 'replaced')),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK ((revoked_at IS NULL) = (revoked_via IS NULL)),
  CHECK ((revoked_at IS NULL) = (ended IS NULL)),
  CHECK ((granted_via = 'chat') = (granted_chat IS NOT NULL)),
  CHECK ((revoked_via IS 'chat') = (revoked_chat IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX idx_tier_grants_active ON tier_grants(app_id, union_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_tier_grants_person ON tier_grants(app_id, union_id, grant_id);

UPDATE schema_version SET version = 11;
