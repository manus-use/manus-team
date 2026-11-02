# prime-gateway — Architecture Design

**Version:** 0.2 — design, reconciled against the code
**Primary constraint:** long-lived durable sessions
**Primary protocol:** ACP by design; **structured CLI is the only one that currently works**

---

## Status, and the order things actually got built

§15 prescribes a build order that begins with the broker and reaches channels at step 8. That
order was **inverted in practice**, and the doc reads as though it wasn't. What exists:

| Built | Designed, not built |
|---|---|
| Event log, sessions, bindings, turns, approvals, workspaces, snapshots *tables* (`schema/001`) | Broker sidecar and spool (§4) — nothing |
| Per-session actor, single writer, generations (§11) | `ExecutionBackend` (§7) — no interface; only the `execution_backend` column |
| Lark channel end to end (§12, and `docs/specs/2026-08-21-lark-channel-design.md`) | Two-phase start, boot reconciliation (§8) |
| Structured-CLI driver (§6.3) | Worktrees, checkpoints (§9) |
| Approvals schema + card surface | Snapshot *writer* (§3.6) — table only |
| Policy/auth tiers (§13) | PTY driver (§6.4) |
| ACP driver, written but unusable against the available agent | Cold/rehydrate tiering (§5) as a real tier |
| | Kanban task board (§17, `docs/specs/2026-11-02-kanban-design.md`) |

Two reasons for the inversion, both worth keeping in view because they are still true:

1. **Nothing could be used without a channel.** A durable log with no way to send it a prompt
   cannot be exercised by real work, so the failure modes it exists to survive never occur.
2. **ACP was not available.** The one agent to hand speaks ACP only in a beta build that
   authenticates separately and never streams its answer, which forced §6.3 — listed at
   milestone 11 — to become the first driver.

What the inversion costs, stated plainly: **there is no reattachment.** The gateway owns agent
stdio directly, which Appendix B lists as a rejected alternative. A gateway restart kills the
running turn. We are running the bare `process` backend that §7 calls "never the default". The
log survives; the turn does not. That is the gap between this document and this build, and it is
the whole of milestones 2–4.

---

## 0. The one-line thesis

> A gateway session is a **durable event log** with an optional, reattachable **agent runtime** bound to it. Everything else — channels, drivers, backends — is a projection or a resource.

Every design decision below follows from taking that literally.

### Three tiers of durability

They fail independently, and naming them separately is what makes the failure semantics
tractable:

| Tier | Owns | Fails when |
|---|---|---|
| **Logical** | event store · workspace · provider session ID · checkpoints · channel bindings | disk loss (only) |
| **Execution** | broker · spool · runtime backend | host reboot without a restart policy |
| **Agent** | provider-native resume, *or* transcript reconstruction | vendor expires the session; context is lost |

The tiers degrade downward, not sideways. Agent durability can fail while logical and
execution durability hold — that is a **degraded but correct** session (the conversation
restarts cold, the history survives), not a lost one. Design so that this is the worst
routine outcome.

---

## 1. Goals and non-goals

### Goals

| # | Goal |
|---|---|
| G1 | A session survives gateway restart, agent crash, machine reboot, and weeks of idleness |
| G2 | One session is observable and drivable from multiple channels simultaneously (Telegram + web) |
| G3 | Adding a new agent is a registry entry, not a code change, when the agent speaks ACP |
| G4 | Adding a new channel does not touch the agent layer |
| G5 | Every action an agent took is auditable and attributable after the fact |
| G6 | No turn is ever silently executed twice |
| G7 | Approvals survive restart and can be answered from a different channel than they were asked on |

### Non-goals (v1)

- Multi-node horizontal scaling. Single gateway node; design so migration is mechanical.
- Reimplementing agent loops. We drive vendor runtimes; we never model tools ourselves.
- A2A / remote agent federation. Leave a seam; do not build it.
- Sub-agent orchestration policy. Agents fan out *internally*; we record that, and do not schedule
  it. Work assigned on the Kanban board (§17) is a different thing and *is* scheduled: a task is a
  card a person or a role was given, not an agent's private decomposition of its own turn.

### The forcing constraint

ACP agents run as **local subprocesses over stdio**. The session's liveness is therefore bound to whoever owns the pipe. If the gateway owns it, gateway restart kills every session — which violates G1 outright.

This single fact dictates the **broker sidecar** in §6. It is the most important structural decision in the design.

---

## 2. Layer model

```
                            CHANNELS
        Telegram      Web        Slack       REST       CLI
            │          │           │          │          │
            └──────────┴─────┬─────┴──────────┴──────────┘
                             │  ChannelAdapter
                             │  (auth · rate-limit · render · backpressure)
                             ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                      SESSION EVENT LOG                       │
  │        SQLite WAL · per-session seq · append-only            │
  │        system of record for everything below                 │
  └───┬──────────┬───────────┬────────────┬──────────┬───────────┘
      │          │           │            │          │
   Router   PolicyEngine  Approvals   Registry   Projections
      │                                (caps)    (transcript,
      │                                           cost, state)
      ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                          DRIVER                              │
  │   transport × protocol.  ACP (default) │ structured-cli │ pty │
  └──────────────────────────────┬───────────────────────────────┘
                                 │  broker control socket
                                 ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                      BROKER SIDECAR                          │
  │   detached · owns stdio · spools to disk · reattachable      │
  └──────────────────────────────┬───────────────────────────────┘
                                 ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                    EXECUTION BACKEND                         │
  │        process │ tmux │ container │ remote(ssh)              │
  └──────────────────────────────┬───────────────────────────────┘
                                 ▼
                    Agent process + Workspace
              (claude-agent-acp │ gemini --acp │ codex-acp │ …)
```

### Three orthogonal axes

Do not collapse these. They vary independently and the registry declares each separately.

| Axis | Question | Values |
|---|---|---|
| **Driver** | How do I talk to it? | `acp`, `structured-cli`, `pty` |
| **Executable** | What binary/args start it? | `["gemini","--acp"]`, `["npx","-y","@agentclientprotocol/claude-agent-acp"]` |
| **Backend** | Where does the broker live? | `process`, `tmux`, `container`, `remote` |

Most combinations are legal. The illegal ones are declared as compatibility constraints, not hardcoded:

- `pty` driver requires a PTY-capable backend (`tmux`, `container` with tty, not bare `process`)
- `remote` backend requires the workspace be resolvable on the remote host

---

## 3. Core data model

SQLite, WAL mode, single file at `$PGW_HOME/gateway.db` (`PGW_DB` or `db:` overrides it).

`schema/001_initial.sql` and `schema/002_lark_channel.sql` are the authority for everything in
this section; where the DDL below differs, the migrations win.

### 3.1 The event log

```sql
CREATE TABLE events (
  session_id    TEXT    NOT NULL,
  seq           INTEGER NOT NULL,          -- monotonic per session, gateway-assigned
  ts            INTEGER NOT NULL,          -- unix millis
  generation    INTEGER NOT NULL,          -- runtime incarnation that produced this
  broker_seq    INTEGER,                   -- broker-assigned, NULL for gateway-origin events
  turn_id       TEXT,                      -- NULL for session-level events
  type          TEXT    NOT NULL,
  actor         TEXT    NOT NULL,          -- 'user' | 'agent' | 'gateway' | 'policy'
  payload       BLOB    NOT NULL,          -- JSON
  PRIMARY KEY (session_id, seq)
) STRICT;

-- idempotent ingest of broker spool: same (gen, broker_seq) never lands twice
CREATE UNIQUE INDEX idx_events_broker_dedup
  ON events(session_id, generation, broker_seq)
  WHERE broker_seq IS NOT NULL;

CREATE INDEX idx_events_turn ON events(session_id, turn_id, seq);
CREATE INDEX idx_events_type ON events(session_id, type, seq);
```

**Rules:**

- `seq` is allocated inside the same transaction as the insert. Single-writer-per-session (§11) makes this trivially correct.
- Nothing is ever updated or deleted. State changes are new events.
- High-volume raw agent stdout does **not** live here. It goes to the broker spool and is referenced by `(spool_file, offset, length)`.
- `payload` is the *raw* driver event, normalized but not lossy. Vendor `_meta` is preserved verbatim.

### 3.2 Event taxonomy

`EventType` in `src/types.ts` is the authority. Names are `snake_case`, not dotted — an earlier
revision of this section used dotted names that were never implemented.

```
inbound_message            a message arrived and was accepted
policy_rejected            it was refused, and why
binding_resolved           which session a conversation resolved to
command_invoked            a control command was recognised

turn_submitted             a prompt became a turn
turn_delivery_ambiguous    delivery could not be established; carries the fence
turn_ended                 { terminal }  -- see below

agent_message_chunk        streamed answer text
agent_thought_chunk        streamed reasoning
tool_call                  a tool started
tool_call_update           its status changed
plan                       the agent's own plan, raw
usage                      token/cost report, raw

approval_requested
approval_resolved

session_created
session_state_changed
generation_bumped          a new runtime incarnation
agent_error
```

**One `turn_ended`, not four event types.** An earlier revision had
`turn.completed | failed | cancelled | indeterminate` as separate types. They are one event with
a graded terminal — `completed | failed | cancelled | ambiguous` — mirrored in `turns.terminal`
(migration 002). The reason is that the *evidence* differs, not the shape: non-empty final text
is not a completion contract, empty output is still a terminal, and cancellation is a terminal
rather than a deletion. Four types invite four code paths where one decision belongs.

**Tool events mirror ACP, and do not split output.** `tool_call` / `tool_call_update` carry the
vendor payload raw. The earlier `tool.output { chunk_ref }` presumed the broker spool, which does
not exist yet — until it does, tool output rides inside the update payload.

**Not implemented, and their absence is load-bearing.** There are no `runtime.*` events
(start_requested, started, attached, detached, exited, lost, start_failed): those are the
two-phase start of §8, and without them a crash between spawn and record is exactly the invisible
orphan §8.1 describes. `generation_bumped` is the only runtime-lifecycle event that exists. There
is likewise no `provider.session_observed` — §6.3 still says the provider session id is observed
continuously, and nothing writes `sessions.provider_session_id`. No `workspace.checkpoint`
(milestone 9), no `file.changed`, no `terminal.output`, no `approval.parked` or
`approval.auto_resolved` (parking and the policy engine of §10 are schema-only).

### 3.3 Sessions

The `sessions` table is a **projection with a durability guarantee**, not the source of truth. It can be rebuilt from `events` at any time. It exists because you need to query it.

```sql
CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,
  agent_id             TEXT NOT NULL,
  workspace_id         TEXT NOT NULL,
  owner_principal      TEXT NOT NULL,
  state                TEXT NOT NULL,      -- see §5; the migration also allows
                                           -- 'unknown' and 'terminated'
  title                TEXT,

  generation           INTEGER NOT NULL DEFAULT 0,
  provider_session_id  TEXT,               -- OBSERVED, updated continuously
  execution_handle     TEXT,               -- durable string, never a PID
  execution_backend    TEXT,

  parent_session_id    TEXT REFERENCES sessions(id),   -- lineage on compaction split
  fork_of_session_id   TEXT REFERENCES sessions(id),

  last_seq             INTEGER NOT NULL DEFAULT 0,
  last_ingested_offset INTEGER NOT NULL DEFAULT 0,   -- byte offset into the spool; §4.6.3
  snapshot_seq         INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  last_activity_at     INTEGER NOT NULL,
  cold_at              INTEGER,

  cost_usd             REAL NOT NULL DEFAULT 0,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX idx_sessions_state    ON sessions(state, last_activity_at);
CREATE INDEX idx_sessions_owner    ON sessions(owner_principal, last_activity_at DESC);
CREATE INDEX idx_sessions_ws       ON sessions(workspace_id);
CREATE INDEX idx_sessions_parent   ON sessions(parent_session_id);
```

**Title is scoped, not globally unique** — `UNIQUE(owner_principal, title)` if you want uniqueness at all.

### 3.4 Channel bindings — separate table, always

```sql
CREATE TABLE channel_bindings (
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  channel          TEXT NOT NULL,          -- 'telegram' | 'web' | 'slack' | 'rest'
  account_id       TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  thread_id        TEXT,
  is_primary       INTEGER NOT NULL DEFAULT 0,
  cursor_seq       INTEGER NOT NULL DEFAULT 0,   -- how far this channel has rendered
  bound_at         INTEGER NOT NULL,
  PRIMARY KEY (session_id, channel, conversation_id, COALESCE(thread_id,''))
) STRICT;

CREATE INDEX idx_bindings_lookup ON channel_bindings(channel, conversation_id, thread_id);
```

This is the table that makes G2 work. **The session ID must never encode the channel.** Inbound resolution is `(channel, conversation_id, thread_id) → session_id`, a lookup — not a string construction.

### 3.5 Turns, approvals, workspaces

```sql
CREATE TABLE turns (
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  turn_id          TEXT NOT NULL,
  generation       INTEGER NOT NULL,
  idempotency_key  TEXT NOT NULL,
  state            TEXT NOT NULL,   -- pending|delivering|running|awaiting_approval
                                    -- |completed|failed|cancelled|indeterminate
  submitted_at     INTEGER NOT NULL,
  ended_at         INTEGER,
  PRIMARY KEY (session_id, turn_id)
) STRICT;

CREATE UNIQUE INDEX idx_turns_idem ON turns(session_id, idempotency_key);

CREATE TABLE approvals (
  approval_id   TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  turn_id       TEXT NOT NULL,
  generation    INTEGER NOT NULL,
  action        TEXT NOT NULL,
  payload       BLOB NOT NULL,
  state         TEXT NOT NULL,   -- pending|parked|resolved
  outcome       TEXT,            -- allow|allow_always|deny|cancelled
  resolved_by   TEXT,
  resolved_via  TEXT,            -- channel it was answered on
  created_at    INTEGER NOT NULL,
  parks_at      INTEGER NOT NULL,
  resolved_at   INTEGER
) STRICT;

CREATE INDEX idx_approvals_pending ON approvals(state, parks_at)
  WHERE state IN ('pending','parked');

CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,    -- 'git-worktree' | 'plain-dir' | 'volume'
  root_path     TEXT NOT NULL,    -- STABLE for the workspace's lifetime
  repo_root     TEXT,
  branch        TEXT,
  lock_holder   TEXT REFERENCES sessions(id),
  created_at    INTEGER NOT NULL
) STRICT;
```

### 3.6 Snapshots

A six-month session has an unbounded log. Materialize every `N=500` events or `M=30min`, whichever first:

```sql
CREATE TABLE snapshots (
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  seq         INTEGER NOT NULL,
  state       BLOB NOT NULL,   -- JSON: session fields, pending approvals,
                               -- compacted transcript, cost, bindings
  PRIMARY KEY (session_id, seq)
) STRICT;
```

`current_state = snapshot(max_seq ≤ K) + replay(events > K)`. Bounds reconnect cost and cold-rehydrate cost.

### 3.7 Write contention

Multiple writers (gateway, per-session actors, spool ingesters) share one DB. Copy the tuning that Hermes learned the hard way:

```
busy_timeout          = 1000 ms      (not the 30s default)
retry                 = up to 15, jittered 20–150 ms
transactions          = BEGIN IMMEDIATE
wal_checkpoint(PASSIVE) every 50 writes
```

The short timeout plus jitter avoids the convoy effect where SQLite's deterministic internal backoff makes all writers retry in lockstep.

### 3.8 What migration 002 added, and why some of it is core

`schema/002_lark_channel.sql` arrived with the Lark channel, but three of its additions are not
channel-specific and belong to this section rather than to a channel spec. Details and reasoning
are in [`specs/2026-08-21-lark-channel-design.md`](specs/2026-08-21-lark-channel-design.md).

- **`seen_messages` — durable inbound dedup.** §3 had no dedup table at all. Any at-least-once
  inbound transport needs one, and it must be durable rather than in-memory: an SDK that ACKs on
  receipt never redelivers what we drop, so a restart that forgets what it saw is a lost message
  rather than a duplicated one. Keyed on the platform's stable message id, never on a re-minted
  event id and never on a payload hash — the same delivery is deduped, the same *intent* is not,
  because two identical button clicks are two decisions.
- **Outbound idempotency, which G6 has no twin for.** G6 says no turn is silently executed twice;
  the outbound equivalent — no answer is silently *sent* twice — was missing. Every send carries
  `uuid = truncate(sha256(canonical), 50)` over `(app_id, session_id, event_seq)`, so a
  crash-replay reuses the message instead of posting the answer again. `app_id` is in there because
  two bots writing the same text to the same chat are distinct effects, not a duplicate.
- **`channel_bindings.revoked_at` — revoke, never delete.** Rotating a session leaves the old
  binding in place, revoked. A late redelivery then resolves to a revoked binding and is discarded,
  instead of resurrecting the session that was rotated away. The lookup index is partial on
  `revoked_at IS NULL`.

Also added, and genuinely channel-specific: `active_card_id` / `active_message_id` /
`card_created_at` on bindings, and `option_id` / `options` / `card_message_id` on approvals. The
`options` column matters beyond Lark, though — it stores the option set **as the agent offered
it**, which is what §6.1's permission callback requires.

---

## 4. Broker sidecar — the core of durability

### 4.1 Why it exists

```
WITHOUT broker:                      WITH broker:

gateway ──stdio──> agent             gateway ──unix socket──> broker ──stdio──> agent
   │                                    │  (reconnectable)      │  (detached)
   └─ restart ⇒ SIGHUP ⇒ dead           └─ restart ⇒ reattach    └─ survives
```

The broker is a small, boring, rarely-changed binary. Its liveness is owned by the **backend** (tmux session / systemd transient scope / container), never by the gateway process tree.

### 4.2 Responsibilities

| Does | Does not |
|---|---|
| Own agent stdio, speak ACP | Make policy decisions |
| Assign `broker_seq`, spool every event to disk | Write to the gateway DB |
| Serve `ATTACH from_offset` | Render for channels |
| Forward prompts, return delivery state | Decide approvals (relays only) |
| Buffer while gateway is absent | Manage workspaces |

Keep it dumb. Every ounce of intelligence in the broker is intelligence you can't hot-fix without killing sessions.

### 4.3 The spool

```
$PGW_HOME/sessions/<session_id>/<generation>/
  ├── spool.ndjson       # one event per line, append-only, fsync-batched
  ├── raw/               # tool output, terminal output — referenced by chunk_ref
  └── broker.sock        # control socket
```

`spool.ndjson` is the **buffer**; the gateway's `events` table is the **system of record**. Ingest is idempotent on `(session_id, generation, broker_seq)`. If the gateway is down for ten minutes, the agent's work still lands on disk and is ingested on reattach.

For the `tmux` backend, additionally run `tmux pipe-pane -o` to a raw log. Costs one line, saves you every time the broker itself dies unexpectedly.

### 4.4 Control protocol (gateway ↔ broker)

Newline-delimited JSON over unix socket. Deliberately not ACP — this is a different concern.

```
→ HELLO      { session_id, generation }
← HELLO_OK   { spool_offset, broker_seq, agent_state, caps }

→ ATTACH     { from_offset }
← (stream of spooled events, then live events)

→ PROMPT     { turn_id, idempotency_key, content }
← DELIVERY   { turn_id, state: confirmed | rejected | ambiguous }

→ CANCEL     { turn_id }
→ RESOLVE    { approval_id, outcome }
→ PROBE
← STATUS     { running | exited(code) | starting, pid, uptime }
→ SHUTDOWN   { graceful: bool, deadline_ms }
```

`ATTACH` is a first-class operation, distinct from start. This is the whole point.

### 4.5 One broker per session

Tempting alternative: pool brokers, multiplex ACP sessions (`multiplexed` agents support it). Rejected for v1 — one broker crash would take down N sessions, and blast radius is exactly what we're optimizing. Revisit only after measuring per-broker RSS.

### 4.6 The durability contract

Every strong guarantee in this document reduces to the invariants below. They are stated
precisely because they are the part that must be right before anything else is built, and
because they are testable in isolation (§4.7).

#### 4.6.1 What the broker holds

> The broker holds turn **identity**, not turn **history**.

It needs exactly one durable fact beyond the spool: which `(turn_id, idempotency_key)` is
currently in flight. That is what lets a reconnecting gateway ask *"did my prompt land?"*
without resubmitting.

It does **not** hold turn state transitions, completion records, or a queryable log. Those
are projections and they live in the gateway, where they can be changed without restarting
sessions.

#### 4.6.2 Spool format invariants

| # | Invariant |
|---|---|
| S1 | `broker_seq` starts at 1 per `(session_id, generation)`, increments strictly by 1, never skips, never reused |
| S2 | One JSON object per line, newline-terminated |
| S3 | A line without its terminating newline is **not committed** and must be ignored by readers |
| S4 | On restart the broker truncates the file to the last newline before appending |
| S5 | An offset is the byte position *after* the last complete newline consumed |
| S6 | Spool directories are per `(session_id, generation)`; generations never share a file |

S3 and S4 exist because `kill -9` mid-write leaves a truncated final line. Half-written JSON
at EOF is the most common bug in append-only spool designs.

#### 4.6.3 Exactly-once ingest

The offset advance and the event insert are **one transaction**:

```sql
BEGIN IMMEDIATE;
  INSERT INTO events (session_id, seq, ts, generation, broker_seq, ...)
    VALUES (...)
    ON CONFLICT(session_id, generation, broker_seq) DO NOTHING;   -- repeated per event
  UPDATE sessions SET last_ingested_offset = :new_offset WHERE id = :session_id;
COMMIT;
```

Crash mid-ingest → the offset did not move → re-ingest → the dedup index absorbs the
overlap.

This single property gives exactly-once ingest over an at-least-once channel. No other
idempotency machinery is required, and none should be added.

#### 4.6.4 Prompt submission ordering

```
gateway → PROMPT { turn_id, idempotency_key, content }

broker:   1. write turn.accepted to spool
          2. FSYNC                              ← must precede the confirm
          3. forward to agent

broker  → DELIVERY { turn_id, state: confirmed }
```

If the confirm precedes the fsync, a crash leaves the gateway believing delivery succeeded
while the broker has no record of it. That is exactly how a turn gets executed twice.

**On reconnect**, `HELLO_OK` returns the broker's current in-flight turn. The gateway
compares it against its own open turns:

| Broker | Gateway | Resolution |
|---|---|---|
| has turn T | T is `delivering`/`running` | already landed — **do not resubmit** |
| no in-flight turn | T is `delivering` | **indeterminate** — human adjudication, never auto-retry |
| has turn T | gateway has no T | ingest from spool; T is real |
| no in-flight turn | no open turns | clean; proceed |

#### 4.6.5 Generation semantics

Ingest and projection follow **different** rules. Collapsing them is a bug.

- **Ingest is generation-agnostic.** Events from generation N arriving after N+1 has started
  are still written to the event log. They are history; discarding them puts holes in the
  audit trail.
- **Projection is generation-scoped.** The state projector applies only events where
  `event.generation == sessions.generation`. A `turn.completed` from generation 41 does not
  complete a turn in generation 42.

#### 4.6.6 Broker admission

A broker accepts at most one attached gateway. A second `HELLO` on an already-attached
broker is **refused**, not queued — two gateway instances reconciling simultaneously would
otherwise both attach and both advance offsets.

The gateway holds a corresponding lock file at `$PGW_HOME/gateway.lock` to make double
starts fail fast rather than fail subtly.

### 4.7 Testing the contract in isolation

The contract above is testable without ACP and without any vendor agent. Build this harness
**before** the real driver:

```
  test driver  ──►  broker  ──►  fake agent
                                 (scripted event stream, deterministic timing)
       │
       └─ kill -9 on a timer, at controlled points
```

A fake agent that emits a scripted stream turns *"we think it's durable"* into a thing that
runs in CI. See `docs/testing/durability.md` for the crash matrix.

---

## 5. Session lifecycle

```
                    ┌──────────────┐
                    │ initializing │
                    └──────┬───────┘
                           ▼
   ┌────────────┐    ┌──────────┐    ┌────────────┐
   │  blocked   │◄──►│   live   │◄──►│    idle    │
   └────────────┘    └────┬─────┘    └─────┬──────┘
    approval /             │                │ idle_timeout
    auth required          │                ▼
                           │          ┌──────────┐
                           └─────────►│   cold   │
                            crash /   └────┬─────┘
                            explicit       │ archive_after
                                           ▼
                                     ┌──────────┐
                                     │ archived │
                                     └──────────┘
```

| State | Broker | Agent | Cost | Reachable |
|---|---|---|---|---|
| `live` | up, attached | running | full | yes |
| `idle` | up | running, quiescent | memory only | yes |
| `blocked` | up | waiting on approval/auth | memory only | yes, needs input |
| `cold` | down | not running | disk only | rehydrate on message |
| `archived` | down | not running | tarball | rehydrate slowly |

### The key move: make rehydration routine

Idle timeout should be aggressive (30–60 min). Rehydration from `cold` on the next inbound message is then **the normal path, exercised constantly**. Crash recovery becomes the same code running unplanned rather than a special path that only executes during incidents.

This is the single highest-leverage decision in the design. Do not make `cold` an exceptional state.

---

## 6. Driver layer

### 6.1 Interface

As built (`src/driver/types.ts`). It differs from the sketch an earlier revision carried in three
ways that are worth stating, because each was a decision rather than a shortcut.

```ts
interface Driver {
  readonly id: string;
  start(opts: StartOptions): Promise<{ runtime: AgentRuntime; result: StartResult }>;
}

interface StartResult {
  providerSessionId: string;
  mode: 'fresh' | 'resumed' | 'replayed';
}

interface AgentRuntime {
  readonly providerSessionId: string;
  prompt(input: PromptInput): AsyncIterable<DriverEvent>;
  cancel(): Promise<void>;
  close(): Promise<void>;      // idempotent, must not throw, never a durability boundary
}
```

1. **It runs in the gateway, not the broker.** The sketch said "broker-side"; there is no broker.
   This is the durability gap, recorded at the top of this document, not a change of mind.
2. **`fresh | resumed | replayed` is a *result*, not three methods.** `openSession`,
   `loadSession` and `resumeSession?` collapse into one `start` that reports which of the three
   happened. The caller almost never wants to choose — it wants the session usable and wants to
   know what it got, because "resumed" and "replayed" differ in what the agent remembers. The
   automatic `native → replay` degrade of §6.5 lives inside `start`.
3. **Streaming is per-turn, not a session-wide `events()`.** `prompt` returns an
   `AsyncIterable<DriverEvent>` that ends at `turn-ended` or a terminal `error`. A single global
   stream makes "which turn is this chunk for" a correlation problem; an iterator per turn makes
   it structural. The cost is that abandoning the iterator mid-turn leaks the underlying RPC, so
   consuming it fully is the caller's contract.

**Permission resolution is a callback on the event, not a method on the driver.** There is no
`resolvePermission(reqId, outcome)`. The `permission-request` event carries its own
`resolve: (outcome) => void`, which must be called exactly once:

```ts
| { kind: 'permission-request'; requestId: string; action: string;
    options: PermissionOption[]; raw: unknown;
    resolve: (outcome: { kind: 'selected'; optionId: string }
                     | { kind: 'cancelled' }) => void }
```

The reason is the failure mode. A request id resolved through a separate method can be dropped by
any code path that throws in between, and dropping it does not fail the turn — it blocks the
agent forever, which is both worse and far harder to notice. Carrying `resolve` on the event puts
the obligation where the compiler and the reader can both see it. `options` come from the agent,
never from us: hardcoding allow/deny invents outcomes the agent did not offer and discards ones it
did.

`DeliveryResult` as a driver return type does not exist. Delivery grading survives as the
`turn_delivery_ambiguous` event and `turns.fence`; over a JSON-RPC transport delivery is confirmed
by the protocol, so the fence is a PTY concern (§6.4) that never needed to reach this interface.

### 6.2 ACP driver — the default, covers ~everything

ACP is not just one option among three. It already specifies most of what the gateway would otherwise hand-roll:

| prime concept | ACP mechanism |
|---|---|
| capability negotiation | `initialize` |
| session create | `session/new` |
| session restore (with replay) | `session/load` |
| session restore (no replay) | `sessionCapabilities.resume` |
| session fork | `session/fork` (experimental) |
| discovery | `listSessions` (if advertised) |
| prompt | `session/prompt` |
| streaming | `session/update` notifications |
| approvals | `session/request_permission` |
| cancel | `session/cancel` |
| workspace | `cwd` + `additionalDirectories` |

**Three implementation traps, all confirmed in the wild:**

1. **Replay ordering.** Agents stream `session/load` history as notifications *during* the request and respond only after the last one. Register your update routing **before** you await the RPC. Clients that listen only after the response resolves receive zero notifications. Zed does this correctly; Hermes shipped it wrong and patched it twice.

2. **`session/resume` and `session/close` exist, but do not remove the need for replay.** Both were added in ACP SDK 1.3.0; an earlier revision of this document claimed they did not exist. Two things follow. First, resume is capability-gated per agent, so `session/load` replay remains the fallback and `resume: native → replay` is the **only** sanctioned automatic degrade in the driver layer. Second, `session/close` is a protocol courtesy, not a durability boundary — the process can die without it, so teardown must stay idempotent and the log must remain authoritative. Never treat a successful `session/close` as evidence that a turn completed.

3. **Vendor `_meta`.** `claude-agent-acp` carries subagent structure through `_meta.claudeCode.parentToolUseId` and `_meta.claudeCode.subagent`, opted into via `clientCapabilities._meta["subagent-transcript"]`. Policy: **store raw in the event log, project selectively.** Otherwise you either lose subagent structure or leak vendor shapes into channel adapters.

### 6.3 Structured-CLI driver

**This is the driver in production, not a fallback.** Listed at milestone 11 and reached first,
because the available agent's ACP build does not stream. The reference case is now `bytesec run
--format json`, and what follows is measured against it rather than inferred.

**It streams, and the channel is therefore genuinely interactive.** Over a 114-second turn:
`text_delta`, `tool_running` and `tool_completed` arrived continuously from +6.7 s, 384 message
chunks and 15 tool calls, spanning 107.5 s of the turn. The card writer's ~1/s coalescing is the
rate limit, not the agent.

**One process per turn, and — as built — no resume.** The driver spawns per turn and re-sends the
prior conversation as a fenced transcript in the prompt, so the agent recovers what was *said*, not
the tool state behind it, and after a gateway restart only the prompts are replayed.

**Correction (2026-11-02): resume now works.** On bytesec 0.7.2, `--session <id>` was measured and
did **not** continue a conversation (identical input-token count, `turn: 1` again, a new session id
in `bytesec session list`). On **0.7.4** it does: a run started with `--session <id>` from
`--session-id-file` recalled a fact given only to the earlier run, and the help text now describes
it as "existing local session ID to continue". Measured once, against one model; re-measure on the
next version change. The driver should capture the id with `--session-id-file`, store it as the
observed `provider_session_id`, and pass `--session` on the next turn, keeping transcript replay as
the fallback when the id is rejected (`resume: native → replay`). Kanban uses it to make stop nudges
cheaper and to let review rework continue the implementer's conversation (spec §7.5, §5.3); both
still work without it.

**A misconfiguration can be silent, because the failure text goes to stdout.** A bad argv makes
the CLI print its usage banner to *stdout* and exit 1, leaving stderr empty. The driver's error
message quotes stderr, so the user sees "agent process exited (code 1) without finishing the turn"
with no reason attached. Anything that diagnoses a failed spawn must consider stdout, not just the
exit code and stderr.

**Provider session ID is observed, never assumed.** Two independent confirmations that it can diverge from what you passed in: the CLI's interactive mode generates its own internal UUID for persistence separate from `--session-id`, and existing bridges report the native ID rotating mid-process, forcing them to watch transcripts and update the mapping continuously. Therefore:

```
provider.session_observed fires on EVERY sighting.
sessions.provider_session_id = last observed value.
Never persist the value you sent.
```

Also handle: the interactive resume dialog (`Would you like to resume? 1. Yes / 2. No`) which blocks unattended runs with no error and no exit code — needs a **startup-stall detector**, not just a turn timeout. And project-scoped session lookup means the workspace path is part of session identity: **record it, never relocate it.**

### 6.4 PTY driver — fallback only, actively being deleted

Everything about this path is a liability: ANSI redraws, spinner frames, bracketed paste, UTF-8 chunk boundaries, Enter vs Meta+Enter, readiness detection, typing throttle. Production PTY adapters for Claude Code run well past a thousand lines and need every one of those pieces just to accomplish "send this prompt."

If you must ship it, the **delivery fence** is non-negotiable:

```
write(prompt) → submit → watch agent's own transcript for a fingerprint of the message
    ├─ found          → confirmed
    ├─ definitively absent after settle window → rejected, safe to retry
    └─ unknown        → AMBIGUOUS. Do not retry. Surface to the human.
```

Duplicate turns mean duplicate commits, deploys, migrations, API calls. `ambiguous` is a terminal state requiring human adjudication.

**Note this problem is an artifact of PTY.** Over ACP, `session/prompt` is a JSON-RPC request with an ID and a response — delivery is confirmed by the protocol. Build the fence in the PTY driver only; keep it out of the core.

### 6.5 Registry

> **Superseded for configuration** by role directories (kanban spec §2): each role's `config.yaml`
> carries its own `agent` block, and there is no top-level `agents:` map. The capability fields
> below remain the driver's declaration of what it can do.

```yaml
agents:
  claude:
    driver: acp
    command: ["npx","-y","@agentclientprotocol/claude-agent-acp"]
    backend: tmux
    caps:
      resume: native          # native | replay | none
      session_mode: resumable # stateless | resumable | pinned | multiplexed
      permissions: true
      cost_reporting: true

  gemini:
    driver: acp
    command: ["gemini","--acp"]
    backend: tmux
    caps: { resume: replay, session_mode: multiplexed }

  codex:
    driver: acp
    command: ["npx","-y","@zed-industries/codex-acp"]
    backend: tmux

  internal-claude:            # same driver, different executable + backend
    driver: acp
    command: ["/opt/corp/claude-wrapper","--acp"]
    backend: container
    container: { image: "corp/agent-base:2026.7", network: "restricted" }
```

`driver`, `command`, and `backend` are **separate axes**. `internal-claude` reuses the ACP driver entirely.

Declared caps are a **hint**; negotiated caps from `initialize` win. Store both — divergence is a useful alert that a vendor changed something.

`resume: native` must **fall back to `replay`** automatically when a provider session ID is rejected as expired.

---

## 7. Execution backend

```ts
interface ExecutionBackend {
  start(spec: RuntimeSpec): Promise<Handle>;   // Handle is DERIVED, not returned-by-luck
  attach(h: Handle): Promise<BrokerConn>;
  probe(h: Handle): Promise<'running' | { exited: number } | 'gone' | 'unknown'>;
  discover(): Promise<Handle[]>;               // enumerate orphans at boot
  stop(h: Handle, graceful: boolean): Promise<void>;
}
```

### Handle is deterministic and reconstructible from persisted state alone

```
handle = "prime/" + session_id + "/" + generation
```

- **tmux** → session name `prime/ses_8f72/42`
- **container** → container name `prime-ses_8f72-42`
- **systemd scope** → `prime-ses_8f72-42.scope`

**Never a PID.** PIDs get reused; a stale PID probe can return `running` for an unrelated process.

### `probe` returns four values, not a boolean

`unknown` is the load-bearing one. If a `tmux has-session` call times out, interpreting that as `missing` and recreating the runtime gives you two agents in one workspace. Tri-state (plus `unknown`) discipline applies everywhere runtime state is distributed: process, container, workspace, provider session, remote task.

### Backend selection

| Backend | Survives gateway restart | Survives reboot | Isolation | Use |
|---|---|---|---|---|
| `process` | ✗ | ✗ | none | short REST calls only — **never the default** |
| `tmux` | ✓ | ✗ | none | default for local dev |
| `systemd scope` | ✓ | ✓ (with restart policy) | cgroup | default for servers |
| `container` | ✓ | ✓ | full | multi-tenant, untrusted work |
| `remote` | ✓ | ✓ | host | heavy compute |

The bare `process` backend is the **degraded** option. If it's your default, you will accidentally design against reattachment and not notice until the first restart.

---

## 8. Two-phase start and boot reconciliation

### 8.1 Two-phase start

The nastiest failure is crashing between "spawned" and "recorded that I spawned" — you get an invisible orphan agent burning tokens with nobody listening.

```
1. generation = sessions.generation + 1
   handle     = derive(session_id, generation)
   APPEND runtime.start_requested { generation, handle, spec }     ← durable FIRST

2. backend.start(spec)                                              ← side effect

3. APPEND runtime.started { generation, handle, pid, backend }
```

Because the handle is *derived*, step 1 knows it before step 2 happens. That's what makes recovery possible.

### 8.2 Reconciliation, run at every boot

```python
def reconcile():
    known = set()

    for s in db.sessions_where(state not in TERMINAL):
        h = s.execution_handle
        known.add(h)

        match backend.probe(h):
            case 'running':
                conn = backend.attach(h)
                ingest_spool(s.id, s.generation, from_offset=s.last_ingested_offset)
                append(s.id, 'runtime.attached', {generation: s.generation})
                resolve_indeterminate_turns(s)
                set_state(s, 'live' if s.pending_turns else 'idle')

            case {'exited': code}:
                append(s.id, 'runtime.exited', {generation: s.generation, code})
                ingest_spool(s.id, s.generation)          # drain what it wrote
                set_state(s, 'cold')                      # restart on demand, not now

            case 'gone':
                append(s.id, 'runtime.lost', {generation: s.generation})
                ingest_spool(s.id, s.generation)
                set_state(s, 'cold')

            case 'unknown':
                set_state(s, 'unknown')                   # DO NOT recreate
                alert(s.id, 'probe indeterminate')

    for h in backend.discover():                          # orphans
        if h not in known:
            if parseable(h) and session_exists(session_of(h)):
                adopt(h)                                  # crashed after start_requested
            else:
                reap(h)                                   # genuinely stray
```

### 8.3 Indeterminate turns

The gnarly case: a tool call was in flight at crash time. You don't know whether the write landed.

```
for turn in session.turns_where(state in ('delivering','running')):
    if turn.generation < session.generation:
        mark(turn, 'indeterminate')
```

Do **not** guess. For filesystem effects, the workspace checkpoint (§9) lets you actually check — diff `HEAD` against the last `workspace.checkpoint` commit and report the delta to the human. That converts "I don't know what happened" into "here is exactly what changed."

---

## 9. Workspaces

### Model: git worktree per session

```
repo/                              # bare or primary clone
$PGW_HOME/workspaces/ws_42/      # worktree, branch prime/ses_8f72
```

- **`root_path` is immutable for the workspace's lifetime.** Claude Code's session lookup is project-directory-scoped, so relocating a worktree orphans the provider session. Record it once, never move it.
- **Exclusive by default.** `lock_holder` on the workspace row. Two sessions sharing a workspace requires an explicit opt-in and a lease.
- **Backend binding:** `process`/`tmux` → cwd; `container` → mount; `remote` → rsync'd path or shared FS. The workspace abstraction must be expressible in all backends or the matrix gets holes.

### Checkpoints

Auto-commit at turn boundaries and before/after approved destructive ops. Record `commit_sha` in the event log.

**Use a separate ref namespace** — `refs/prime/checkpoints/<session_id>` — so you don't fight agents that run `git` themselves. This is the safer default and costs nothing.

Buys you: diffing what the agent did while you were away, rollback, and a concrete answer to indeterminate tool calls.

---

## 10. Approvals and policy

### Split the two concerns

```
  agent requests permission
            │
            ▼
    ┌───────────────┐   auto-allow / auto-deny
    │ POLICY ENGINE │──────────────────────────► resolve immediately
    │ (rules, tests)│                            (approval.auto_resolved)
    └───────┬───────┘
            │ needs a human
            ▼
    ┌───────────────┐
    │   APPROVALS   │  durable record, stable ID, idempotent resolution
    └───────┬───────┘
            │ fan out to ALL bound channels
            ▼
     Telegram  ·  Web  ·  Slack
```

The policy engine changes often and needs tests; the approval transport changes rarely. Different modules.

### Park, don't deny

With long-lived sessions an approval may sit for days. Default-deny-on-timeout silently kills long work.

```
pending ──parks_at reached──► parked   (session → blocked, notify all channels)
        ──human answers────► resolved
```

**Denial is an explicit act.** Parking is what timeouts do.

### Requirements

- Stable `approval_id`, survives restart
- **Idempotent resolution** — two channels answering simultaneously, or a retry, must not double-resolve. `UPDATE ... WHERE state != 'resolved'` and check rowcount.
- Record `resolved_by` **and** `resolved_via` (which channel) — this is audit-relevant
- Generation-stamped: an approval from generation 41 arriving after a restart into generation 42 is stale, drop it
- Cross-channel: asked on Telegram, answerable from web

### Control-plane bypass

When an agent is running, inbound messages queue. But `/stop`, `/cancel`, `/approve`, `/deny`, `/status` must reach the runner **inline**, bypassing the queue. Otherwise `/approve` sits behind the very turn it would unblock. Two-level guard:

```
L1  ChannelAdapter:  session busy? → queue message, set interrupt flag
L2  Router:          is it a control command? → dispatch inline
                     otherwise → interrupt or enqueue per policy
```

---

## 11. Concurrency: single writer per session

One actor (goroutine / task / thread) owns each live session. All mutations funnel through it.

- Makes `seq` allocation trivially correct
- Serializes concurrent input from multiple channels
- Eliminates a whole class of interleaving bugs

Cross-node later means a real lease with fencing tokens. Don't build that now — but keep the `generation` counter, because it *is* your fencing token when the time comes.

### Generation counters, unified

The generation serves three purposes with one number:

1. Component of the derived execution handle
2. Stale-event rejection — an event stamped gen 41 arriving after restart into gen 42 is discarded
3. Future fencing token for multi-node leases

Do not let these become three separate mechanisms.

---

## 12. Channels

An earlier revision had one `ChannelAdapter` interface owning transport, rendering and pacing,
with a `caps` object. It came apart into three pieces in the build, and the split is worth keeping:

```ts
// 1. Transport. Vendor-shaped effects only. Every send is uuid-idempotent.
interface Channel {
  readonly id: string;
  sendText(target: SendTarget, text: string, uuid: string): Promise<SendResult>;
  openCard(target: SendTarget, initialText: string, uuid: string): Promise<CardSession>;
  sendApprovalCard(target: SendTarget, spec: ApprovalCardSpec, uuid: string): Promise<SendResult>;
}

// 2. Projection. Pure: events in, text out. No I/O, no clock. Pure *given the secret set*: the
//    escapers mask known secrets from a process-wide registry (kanban spec §10.1).
renderCard(events: readonly Event[]): RenderedCard

// 3. Pacing. Single-flight, latest-wins, coalescing, cursor-advancing.
class CardWriter { want(seq): void; close(): Promise<void> }
```

Why not one interface: `render(sessionId, events, cursor)` returning a cursor makes the *pure*
part — the part with all the escaping, truncation and turn-scoping decisions in it — reachable
only through a network call. Splitting it means the projection is tested exhaustively with no
transport at all, and the pacing logic (single-flight, coalescing, bounded retry, fallback to a
different endpoint) is tested with a fake card that models the platform's freeze semantics. Both
production defects found in this layer lived in the *seam* between them, and neither would have
been reachable in a test if the seam had not existed.

`caps` never got built. With one channel it would have been speculative, and the two capabilities
that actually mattered — that a card is a single stream which freezes on finish, and that
`sendText` is a separate endpoint from card updates — are expressed as types (`CardSession`) and
as the writer's fallback path rather than as booleans. Reintroduce `caps` when the second channel
demands it, and expect it to be a different set than the one guessed above.

### Channels are projections over the event log

Each binding carries `cursor_seq`. Reconnect is `render(events > cursor_seq)`. Web reconnect, multi-device, and catch-up-after-outage all fall out of this for free — you don't write them separately.

### Backpressure is adapter-side policy

Telegram rate-limits message edits; web wants token-level SSE; REST wants a completed response. All three consume the same event stream and decide independently how to pace it. **Never push this into the gateway.**

### Per-channel resilience

- Circuit breaker per channel with a trip event recording failure count and last error
- Indefinite retry with capped exponential backoff
- **But**: expose breaker state explicitly, because a revoked token and a network blip look identical under infinite retry. `/channel status` must show "retrying since T, last error E" — otherwise a permanently dead channel silently retries forever.

---

## 13. Identity, authz, secrets

### Principal resolution happens in the adapter

```
telegram_user_id 12345 → principal:alice → [workspace:ws_42, ws_51]
```

Retrofitting this is painful. Put it in the `ChannelAdapter` contract from commit one, even if v1 has exactly one principal.

### Agent credentials are per-vendor and expire

Each agent runtime owns its own auth and billing — a key configured for one does not configure another. For long-lived sessions this means **credentials expire mid-session**.

```
provider.auth_required → session state = blocked → notify all bound channels
```

Treat it exactly like an approval: a first-class blocked state with a resolution path, not an error that kills the session.

Also verify current billing behaviour for third-party agent paths (ACP, Agent SDK, `claude -p`) before committing — there were changes in this area around mid-2026 that affect whether subscription or API billing applies.

### Secrets must not land in the workspace or the event log

- Inject via broker environment at spawn, never via files in the workspace. The one file the gateway
  reads secrets from is a role's `.env`, kept outside every workspace — a workspace containing the
  gateway's home is a startup error (kanban spec §2.3, §2.5)
- Redact on ingest: the spool ingester runs a redaction pass before events hit the DB. **First part
  designed** (kanban spec §10.1, plan F): exact-value masking of every secret the gateway itself
  holds, applied on log writes and on sends, before escaping. Pattern-based detection is not yet
  designed.
- Container backend: mount as tmpfs, never bake into the image

---

## 14. Failure modes

| Failure | Detection | Response |
|---|---|---|
| Gateway restart | boot | reconcile, reattach, ingest spool from offset |
| Broker crash | probe → `exited`/`gone` | session → `cold`; restart on next message with resume |
| Agent crash | broker sees stdio EOF | broker records `runtime.exited`, stays alive to serve spool |
| Crash between spawn & record | `start_requested` with no `started` | probe derived handle; adopt or mark failed |
| Orphan runtime | `discover()` − known handles | adopt if parseable & session exists, else reap |
| Probe timeout | `unknown` | **do nothing**, alert. Never recreate. |
| In-flight tool at crash | turn.generation < session.generation | mark `indeterminate`, diff workspace vs checkpoint |
| Ambiguous PTY delivery | delivery fence | terminal state, human adjudication, never auto-retry |
| Stale event post-restart | generation mismatch | discard |
| Provider session expired | resume rejected | fall back `native` → `replay` |
| Credentials expired | `provider.auth_required` | session → `blocked`, notify |
| Approval unanswered | `parks_at` reached | park, notify, **do not deny** |
| Channel down | circuit breaker | backoff + retry, expose breaker state |
| Context window full | agent-signalled compaction | lineage split via `parent_session_id` |
| Log growth | seq − snapshot_seq > N | snapshot |
| Kanban run's turn completes without a report | turn terminal `completed`, no report on the run | nudge in the same session, at most twice; then `protocol_violation` |
| Kanban run fails or crashes | turn terminal `failed` / `ambiguous` | classify; counted failures retry in a **fresh** session told what the last attempt did, until `failure_limit`, then `gave_up` and block |
| Provider throttling | 429 / 5xx / reset | requeue after a doubling cooldown, not counted; block as `transient` after `transient_limit` |
| Provider rejects credentials | 401 / 403 / model not found | block at once; every retry would fail the same way |
| Gateway restart mid-run | boot | undecided agent runs end `interrupted`, requeued per `retry_on_crash`; runs that had already reported keep their outcome and are only closed |

---

## 15. Build order

Steps 1–4 are unglamorous and *are* the durability guarantee. Building channels and routing first means retrofitting reattachment later, which means rewriting the session manager.

| # | Milestone | Done when | Status |
|---|---|---|---|
| 1 | Event log + snapshots + write-contention tuning | can replay a session's state from `events` alone | log and tuning done; **snapshots are a table with no writer** |
| 2 | Fake-agent harness + broker + tmux backend: `start`/`attach`/`probe`/`discover` + spool | `docs/testing/durability.md` T-00 through T-06 pass in CI | not started |
| 3 | Two-phase start + boot reconciliation | T-07 through T-15 pass; crash between phases, orphan is adopted not lost | not started |
| 4 | Cold / rehydrate tiering | idle timeout exercises recovery continuously | partial — the registry retires idle actors; there is no cold tier to rehydrate *from* |
| 5 | ACP driver, one agent end-to-end, resume declared in registry | resume works and falls back when the ID expires | driver written, **no working ACP agent to run it against** |
| 6 | Approvals with policy engine + parking + cross-channel resolution | approve from web what Telegram asked | schema and card surface done; **no policy engine, no parking**, and unreachable on the CLI driver |
| 7 | Second ACP agent | **audits your abstractions** — expect to find leaks here | not started |
| 8 | Channel adapters (web SSE first, then Telegram) | cursor-based reconnect works | **done first**, and it is Lark rather than web or Telegram |
| 9 | Workspaces: worktree + checkpoints | can diff what the agent did overnight | not started — `plain-dir` only, one shared directory for every session |
| 10 | Container backend | isolation for untrusted work | not started |
| 11 | Structured-CLI driver | for agents without ACP | **done second, and it is the only driver that runs** |
| 12 | PTY driver + delivery fence | only if genuinely required | not started, and no longer expected to be |
| 13 | Kanban v1 (§17) | a task assigned to a role runs, reports through `pgw kanban`, and releases its children; a human task is completed from a Lark card | designed — `docs/specs/2026-11-02-kanban-design.md` |

Milestone 7 is the real test. If adding the second agent requires touching the gateway core, the driver abstraction is wrong and it's cheap to fix now.

**Where to resume.** The order above is still the right order for the *remaining* work: 2 → 3 → 4
buy reattachment, which is the primary constraint and the one thing this build does not have. The
cheapest thing that increases durability before then is milestone 9's checkpoints, because a turn
killed by a restart at least becomes diffable.

**Milestone 13 goes ahead of 2–4 anyway**, for the same reason channels did: the durability work
needs real long-running work to exercise it, and a board of tasks is that work. The cost is stated
in the spec (§8.4): until the broker exists, a restart interrupts every running task, and they are
requeued rather than reattached. Milestone 9 (worktrees) should follow 13 directly — until then
the board runs one agent per workspace at a time.

---

## 16. Open questions

1. **Broker pooling.** One-per-session is the safe start. Measure RSS after milestone 7 and revisit — multiplexed ACP agents make pooling tempting, but blast radius argues against it.

2. **Compaction and lineage.** When an agent signals context exhaustion, split into a child session via `parent_session_id`. Open: does the child inherit the workspace lock, the channel bindings, or both? (Probably both, but the transition must be atomic.)

3. **Snapshot fidelity for `resume: replay`.** Your compacted transcript has to be semantically faithful, not just truncated, or replay-resumed agents lose context silently. Consider storing a byte-fidelity sidecar of exactly what was sent to the provider — this is what makes prompt-cache-stable replay possible.

4. **Cost attribution across generations.** A session that restarts 40 times accumulates usage from 40 runtimes. Attribute per-generation and aggregate, so a runaway generation is visible rather than smeared.

5. **Multi-node.** The `generation` counter is your fencing token. The migration path is: replace the per-session actor with a leased actor, move `events` to Postgres keeping the `(session_id, seq)` key. Design the seq allocator so this is mechanical.

---

## 17. Kanban: work assigned to people and roles

Full design: [`docs/specs/2026-11-02-kanban-design.md`](specs/2026-11-02-kanban-design.md). The
parts that bear on the rest of this document:

- **A layer above sessions, not inside them.** A task is a card; an attempt at it is a *run*; an
  agent run *is* a gateway session, created for that run and bound to a `kanban` binding. The
  dispatcher submits the run's prompts through the actor like any channel would, one idempotency
  key per submission (`kanban:<run_id>:<n>`). Underneath, it needs five changes (spec §2.4): a
  driver per role, with the role recorded in `sessions.agent_id`; a workspace per session, chosen
  by name; per-session environment in `StartOptions`, which the actor receives through its deps and
  passes to every start; a channel per binding; and seeding a new session from another's provider
  session. The event log's schema
  is unchanged (its text is now masked for known secrets, spec §10.1), and the actor's only change
  is that environment.
- **The board owns lifecycle truth.** A worker moves its card only by reporting — `pgw kanban
  complete | review | block` over a local socket, authorized by a run-scoped token. A turn ending is
  not a report.
- **One stored phase, one writer; display status derived.** The same rule as session status
  (`core/status.ts`, channel spec §7), for the same reason: status assigned from many code paths
  drifts from the rows it describes.
- **Supervision stays with the actor.** The dispatcher does not watch processes: the actor already
  knows when a turn ends and how. The dispatcher acts on time only to cancel a run past its runtime
  limit, end a cooldown, and flag a stranded task.
- **A run is decided when it reports, and closed when its process is gone.** The one-agent-per-
  workspace limit and the one-open-run-per-task rule count open runs, so an agent still writing
  after its report cannot have the next agent start in the same checkout.
- **Retries and G6.** A retry after a failure is a *new run in a new session*, recorded and
  announced, whose prompt lists what the failed attempt did (its tool calls, from its own session
  log). It is not a resend of a turn, so G6 is unaffected; an ambiguous turn in a chat session is
  still held, never resent.
- **Roles and workspaces** are configured separately. A *role* is a self-contained directory —
  `config.yaml` naming its coding agent (§6.5's registry entries), `role.md`, `skills/`, and a `.env`
  for its own secrets — created with `pgw role create`; the single `agent:` block becomes the role
  `default`. A *workspace* is a named directory (`workspace:` becomes `default`). Tool policy is
  enforced by the coding agent or refused at startup, never silently ignored. A role's `.env` is the
  one exception to "secrets only in the environment" (§13): `0600`, never cloned, masked.

---

## Appendix A — Naming discipline

| Term | Means | Never |
|---|---|---|
| `session_id` | prime's opaque durable ID | encodes channel or provider |
| `provider_session_id` | vendor's ID, **observed** | canonical, or persisted-as-sent |
| `handle` | derived durable runtime address | a PID |
| `generation` | runtime incarnation counter | reset, reused |
| `turn_id` | one prompt→completion unit | reused across retries |
| `workspace_id` | durable filesystem identity: a configured workspace's name, registered with its realpath on first sight (kanban spec §2.3) | relocated — repointing a known name at another directory fails startup |
| `task_id` | a Kanban card, across all its attempts | a session, or a turn |
| `run_id` | one attempt at a task; for an agent, exactly one session | reused by a retry |
| `role` | who does a kind of work, and how it is run: a directory with its coding agent, `role.md`, skills, tool policy, `.env` and default workspace | a task, or a person |

## Appendix B — Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Gateway owns agent stdio directly | Gateway restart kills all sessions — violates the primary constraint |
| Session ID encodes channel | Breaks multi-channel observation; a Hermes pattern that doesn't fit here |
| Agent LRU cache with idle eviction | Eviction = kill for external processes; works only for in-process agents |
| PTY-first driving | Enormous machinery for "send a prompt"; brittle against vendor UI changes |
| Messages table as source of truth | No replay-from-offset, no audit, no multi-observer reconnect |
| Default-deny on approval timeout | Silently kills multi-day work |
| Relying on ACP `session/resume` alone | It exists (SDK 1.3.0) but is capability-gated per agent; `session/load` replay stays the fallback |
| Postgres from day one | SQLite WAL handles single-node fine; migrate when multi-node is real |
| Pooled brokers in v1 | One crash takes down N sessions |
