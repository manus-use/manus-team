# Wake: a task's outcomes start a turn in the thread that follows it

**Date:** 2026-11-19
**Status:** draft, for review
**Scope:** plan Y. A task with wake on, when it completes, has changes requested, is blocked by its
run, or is stranded, starts a turn of the agent in the chat session of the conversation that
follows it: its thread, or a chat's chat-scope session. The turn is handed a short account of what
happened, runs as the person who turned wake on, and is answered in the thread as any turn is. It
builds kanban §1's deferred row, "Notifications that start an agent turn ('wake')".

This document assumes [`../architecture.md`](../architecture.md), the Lark channel spec,
[`2026-08-21-lark-channel-design.md`](2026-08-21-lark-channel-design.md), cited as "channel §n",
the kanban spec, [`2026-11-02-kanban-design.md`](2026-11-02-kanban-design.md), cited as "kanban
§n", the cron spec, [`2026-11-16-cron-design.md`](2026-11-16-cron-design.md), cited as "cron §n",
the workflows spec, [`2026-11-16-workflows-design.md`](2026-11-16-workflows-design.md), cited as
"workflows §n", and the tier grants spec,
[`2026-11-18-tier-grants-design.md`](2026-11-18-tier-grants-design.md), cited as "grants §n". It
amends six of their rules, each said where it is changed: kanban §3.4's subscription row (§4.1),
kanban §9.2's redraw line (§9.3), kanban §22.1's "a chat agent's `mt` has no board commands"
(§9.2), cron §10 and grants §6.3's environment of a chat session with cron off (§9.1), and the
workflows file and DAG, which gain `wake` (§3.1). Elsewhere, where this document and they
disagree, they win and this document is a bug. As in them, every rule that looks arbitrary states
the mechanism that forces it, so that it is not "simplified" away later.

---

## 0. The thesis

> **A wake is a second reader of the same cursor, whose delivery is a turn instead of a message.**

The notifier (kanban §9.4) already turns a task's events into messages in the conversation that
follows it, from a cursor, at least once, deduplicated, catching up after a restart by the same
code. A wake reads the same events, from a cursor of its own beside the notice cursor, and hands a
batch of them to that conversation's chat session through the session actor's `submit()`, the
path a typed message takes. Nothing about the board, the notices or the session's turns changes
underneath it: the board writes events as it does, the notice goes as it does, and the woken turn
is a turn like any other, streamed, queued behind, cancelled with `/stop`, recorded in the
session's log.

Approach A of the approved design: a `Waker` beside the `Notifier`, not a delivery kind inside it.
Notices and wakes are independent: a notice never waits for a wake, a wake never sends a notice,
and turning wake on or off changes nothing a chat hears from the notifier.

---

## 1. Boundaries

**In:** `wake_cursor` on `kanban_subscriptions`, the task's wake and its depth, the woken turns'
record (§4); the `Waker` (§5); what the session layer gains to run a turn with no inbound message
(§6); the prompt (§7); what the thread shows (§8); a woken turn's shell: its depth, and the one
board command it gains, `mt kanban task unblock` for the tasks that woke it (§9); `task show`'s
line (§10); `kanban.wake` (§11).

**Out, each with the seam that keeps it cheap later:**

| Deferred | Seam |
|---|---|
| Reminders: waking again on a block nobody answered | Each outcome event wakes once (§2.2). A reminder would be an event the sweep writes, `block_reminder`, which §2.2's list could take |
| Waking a session that follows no chat (a terminal's task with no `--chat`) | A wake needs a subscription (§2.1); `--chat` is how a terminal's task gets one (kanban §22.1) |
| Waking on notices other than outcomes (retrying, review requested, a card sent) | One more kind in `WAKE_KINDS` (§2.2) |
| Board commands for a woken turn beyond `task unblock` | The socket's `wake` envelope (§9.2) takes a verb; another verb is one more case, judged as wake_by's chat command would be |
| A wake that runs as a role's session rather than the chat's | `kanban_wakes` records the session it submitted to (§4.2); another target is another way to pick it |
| Waking from a cron fire | A fire's result is posted, not a board event (cron §5.6); it never reaches the waker's cursor (§2.3) |

---

## 2. Who is woken, and by what

### 2.1 The conversation, and its session

- **The chat session bound to the conversation that follows the task**: the binding key of the
  task's subscription for this bot, `{channel, appId: account_id, conversationId, threadId}`. For a
  subscription in a thread, the thread's session, which the router keys on the message's
  `thread_id` (channel §3.3) as the subscription's `thread_id` is; for one at chat scope, the
  chat-scope session of the direct message or the group. A task has at most one subscription per
  bot (kanban §19.1), so it wakes at most one session.
- **A conversation with no session yet gets one**, as a first message would: the registry's
  `bindOrCreate(key, owner)`, with the woken turn's principal (§3.2) as the session's owner, the
  default role and workspace, as the router's `#submit` does. A thread opened by `/kanban task
  new` has no session until someone types in it, so a first wake usually makes one.
- **A task with no subscription of this bot cannot be woken**, so wake on it is refused (§3.4). A
  terminal's task without `--chat` has none (kanban §22.1).
- **A conversation the gateway does not admit is not woken.** A subscription's chat outside a
  non-empty `auth.chats` (a chat removed from the list since its task was made) gets no wake: its
  events are passed over, and one log line names it, once until a restart. *Why:* the gateway
  answers no message there (`Authorizer.admits`), and a turn in a chat it does not answer would be
  a session nobody may talk to.

### 2.2 The outcomes

A task's events are written by `db/kanban.ts`. An **outcome** is one of these, exactly, and only
these wake (`WAKE_KINDS`, in `src/kanban/waker.ts`):

| Event `kind` | When it is an outcome | Payload the prompt reads |
|---|---|---|
| `completed` | always: a run's report, a person's Done, a reviewer's approval | `summary`; the run's assignee, from `run_id` |
| `changes_requested` | always: a reviewer role's run, a person, or an operator's answer | `reason`; `reviewer` and `reviewerKind` for a run's, else the `actor` |
| `blocked` | its `actor` is a run (`run:<run_id>`) and its payload's `kind` is not `dependency` | `kind`, `reason`, `blockRecurrences` |
| `run_ended` | its payload's `next` is `blocked`: gave up (`blockKind` `gave_up`), or a block of any other kind | `outcome`, `blockKind`, `blockReason`, `blockRecurrences` |
| `stranded` | always | `reason` |

- **Each outcome event wakes once.** A wake moves the cursor past the events it covered, and a
  failed or cancelled woken turn counts as delivered (§5.6). **An unanswered block is never
  woken again: there are no reminders.** A block lifted and made again is a new event, and wakes
  once more.
- **A block made by a run**, as the approved design says it: a run's own `mt kanban block`, and a
  run's end that blocks the task (`run_ended` with `next` `blocked`). *Pinned from the code:* a
  `blocked` event's `actor` is `run:<run_id>` for a run's report and the person's principal for a
  person's (`actorOf`, `db/kanban.ts`), so a person's Block, by card or `/kanban task block`, is a
  person's decision and wakes nothing, as a stop does not.
- **"Gates failed" is not an event of its own.** A failing gate refuses the report and leaves the
  run undecided, recording `gates_ran` with `passed: false` (kanban §7.7): the agent may fix it
  and report again. If it ends its turn instead, the run's end is a `run_ended`, which retries
  quietly or blocks: the block wakes, as any run's block does. See §17, D4.

### 2.3 What never wakes

- **A person's stop**: `stopped`, from `/kanban task stop`, a stop card or `mt kanban task stop`,
  which blocks the task as `needs_input` (kanban §5.1). An agent woken by it could only undo a
  person's decision. Nor a person's own `blocked`.
- **Notices that are not outcomes**: `review_requested`, `run_ended` that retries, `card_sent` and
  `card_failed`, `task_created_followed`, `workflow_started`, and `wake_set`. They stay notices.
- **Everything that is no notice**: `created`, `claimed`, `commented`, `linked`, `unblocked`,
  `archived`, a `dependency` block, and the rest.
- **A cron fire.** A fire's result is posted to its chat by the scheduler (cron §5.6), not written
  to `kanban_events`, so no cursor reads it; a fire's session is bound on the `cron` channel, which
  has no subscription. A cron *script* is a terminal (cron §5.1), so a task it makes with
  `--wake --chat` wakes like any terminal's (§3.2).

---

## 3. Turning wake on and off

### 3.1 The paths

Wake is **off by default**, opt-in per task. It is on when `kanban_tasks.wake_by` is set (§4.1).

| Path | Form | Tier |
|---|---|---|
| Chat, a new task | `/kanban task new <title> --wake`: `--wake` as the last word of the title line, which is taken off the title | operate, as `task new` needs |
| Chat, a workflow | `/kanban workflow start <name> key=value … --wake`: every member | operate, as `start` needs |
| Chat, an existing task | `/kanban task wake <task_id> on` or `off` | talk |
| Terminal, a new task | `mt kanban task new <title> … --chat oc_… [--thread omt_…] --wake` | the terminal's |
| Terminal, a workflow | `mt kanban workflow start <name> … --chat oc_… --wake`, and `workflow apply` of a DAG whose tasks say `"wake": true` | the terminal's |
| Terminal, an existing task | `mt kanban task wake <task_id> on` or `off` | the terminal's |
| A workflow step | `wake: true` in the step, carried into the DAG's task as `"wake": true` | as the start's |
| A run's follow-up | inherited: a task a run creates, by `mt kanban create`, `start-workflow` or `apply-dag`, gets its creating task's `wake_by` and `wake_depth`, on or off | none: the run's |

- **A workflow's `--wake`** turns wake on for every member; without it, only the members whose
  step says `wake: true`. The step's field and the DAG's key are booleans, default `false`;
  `wake` joins the step fields of workflows §1 and the task keys of workflows §5, each checked as
  the others are, an unknown value refused naming its place (`steps.recommend.wake`).
- **In a run's start**, a member's wake is the creating task's, inherited, whatever its step or
  the DAG says: there is no person behind a run to run the turns as, and inheriting is how a run's
  work stays woken (as its subscription is inherited, kanban §9.4).
- **`/kanban task wake` is typed in a chat that follows the task**: the task's subscription of this
  bot is in this chat, in any thread of it or at chat scope. *Why:* the wake runs a turn in that
  chat's session as the person who turned it on, and a person in another chat would set turns
  going in a conversation they are not in. A task followed elsewhere is refused (§3.4); the
  terminal sets any task's.
- **`wake on` on a task already on** replaces its setter: `wake_by` becomes the new one's, and the
  cursor starts again at the latest event (§3.3). The same setter again changes nothing and
  writes no event, and is answered "already on". `wake off` on a task off changes nothing.
  Anyone with talk tier in a chat that follows the task may turn it off.
- **Every change is a `wake_set` event** (§4.4), in the transaction that sets it, inherited
  wakes included.

### 3.2 Who a wake runs as

- **`kanban_tasks.wake_by` is the principal who turned wake on**, `lark:<union_id>`: the sender of
  the chat command, or of the start, and for an inherited wake the creating task's `wake_by`.
- **A wake set from the terminal runs as the owner**: `wake_by` is `lark:<union_id>` of the owner,
  found in `people` by the owner's open_id (`auth.owner` or `MT_OWNER_OPEN_ID`, as
  `TeamSettings` reads it) for this bot's app id. The `wake_set` event's actor is the terminal's
  `operator:<login>`, so who set it is recorded as well as whom it runs as. **An owner `people`
  does not hold is refused** (§3.4): the woken turn needs a principal with a union_id, which only
  Lark gives, and the owner is noted once they have used `/kanban` or been mentioned in it. No
  owner, or no app id, is refused as the terminal's talk check is (kanban §22.2).
- **The tier is checked live, at every wake** (§5.3), with grants counting (grants §4.3): the
  setter needed talk tier when they turned it on, and must still have it when it fires.

### 3.3 The cursor starts at the latest event

Turning wake on sets the task's subscription's `wake_cursor` to the task's latest event, the
`wake_set` itself, in the same transaction, so it never replays old outcomes: a task blocked a
week ago, whose wake is turned on today, is not woken for that block. A task made with wake on, or
a follow-up inheriting it, has its subscription written with `wake_cursor` 0, as its every event
is new. Turning wake off leaves the cursor where it is; the waker reads only tasks with wake on,
and a later `on` sets the cursor again.

### 3.4 Refusals, and the depth note

Each refusal leaves the task as it was; for a new task or a start, nothing is made.

- **No chat follows the task.** For `mt kanban task new --wake` or `workflow start --wake`
  without `--chat`, `invalid`: `a wake needs a chat that follows the task: add --chat`. For `wake
  on` of an existing task with no subscription of this bot, `invalid`: `a wake needs a chat that
  follows the task, and no chat follows k_…: a chat is chosen when a task is made`.
- **Wakes are off.** With `kanban.wake.enabled` false, every `--wake`, `wake: true` in a chat's
  or the terminal's start, and `wake on`, `wake_off`: `wakes are off on this gateway: an operator
  turns them on with kanban.wake.enabled: true in config.yaml, and a restart`. `wake off` still
  works. A run's inheritance is not refused: the flag is copied, and stays inert while wakes are
  off.
- **Followed elsewhere.** `/kanban task wake` in a chat that does not follow the task, `invalid`:
  `` `k_…` is followed by another chat, so its wake is set there, or from the terminal``.
- **The owner unknown at the terminal**, `invalid`: `a wake set from the terminal runs as the
  owner, whom this gateway has not seen yet: the owner is known once they have used /kanban in
  Lark`.
- **Too deep.** A task whose `wake_depth` is `kanban.wake.max_depth` or more (§5.4) is made, or
  left, with wake off, and the answer says, as a note, not a refusal: `` `k_…` is 5 tasks deep in
  woken turns, so it stays notice-only``. The same line is a notice in the task's thread, as the
  `wake_set` event that records it is (§4.4).

The answers:

- chat, `wake on`: `` Wake is on for `k_…`: its outcomes now start a turn of the agent where it is followed, run as Zhixi Sun. ``;
  `off`: `` Wake is off for `k_…`: its outcomes are notices only. ``;
- chat, `task new --wake`: the "Created" reply gains one sentence, `Its outcomes wake the agent here.`;
- terminal: `wake on for k_…: its outcomes start a turn in oc_…/omt_…, as lark:on_… (the owner)`,
  `wake off for k_…`, and `--json` `{"ok": true, "task_id", "wake": {"on", "by", "depth"}}`;
  `task new --wake`'s answer gains `; its outcomes wake the agent`, and `--json` gains `wake`.

---

## 4. Schema (migration `013_wake.sql`)

### 4.1 Columns

```sql
ALTER TABLE kanban_subscriptions ADD COLUMN wake_cursor INTEGER NOT NULL DEFAULT 0;
  -- last kanban_events.id the waker has covered: woken, skipped or passed over
ALTER TABLE kanban_tasks ADD COLUMN wake_by TEXT;
  -- lark:<union_id> the woken turns run as; null: wake off
ALTER TABLE kanban_tasks ADD COLUMN wake_depth INTEGER NOT NULL DEFAULT 0;
  -- woken turns in the task's making: 0 for a person's or the terminal's task
```

Kanban §3.4's subscription row is amended: beside `cursor`, the notifier's, a subscription holds
`wake_cursor`, the waker's, by the same discipline: forward only, writing no event. Every
subscription before the migration starts at 0, and every task before it has wake off, so nothing
is replayed: the waker reads only tasks with wake on, and turning wake on sets the cursor (§3.3).

### 4.2 The woken turns

```sql
CREATE TABLE kanban_wakes (
  wake_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid             TEXT NOT NULL UNIQUE,            -- wakeBatchUuid of its (subscription, event) pairs
  channel          TEXT NOT NULL,                   -- the conversation it woke: lark
  app_id           TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  thread_id        TEXT NOT NULL DEFAULT '',
  principal        TEXT NOT NULL,                   -- lark:<union_id>: the turn runs as them
  depth            INTEGER NOT NULL,                -- the highest wake_depth of its tasks
  state            TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'dropped')),
  attempt          INTEGER NOT NULL DEFAULT 1,      -- the submit it is on; a refusal adds one
  session_id       TEXT,                            -- set at each submit: the session it went to
  turn_key         TEXT,                            -- set at each submit: the turn's idempotency key
  created_at       INTEGER NOT NULL,
  delivered_at     INTEGER,                         -- set once, with state delivered
  dropped_at       INTEGER,                         -- set once, with state dropped
  error            TEXT,                            -- the last refusal, masked, cut at 500
  CHECK ((state = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK ((state = 'dropped') = (dropped_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_kanban_wakes_hour ON kanban_wakes(app_id, channel, conversation_id, thread_id, delivered_at)
  WHERE state = 'delivered';
CREATE INDEX idx_kanban_wakes_turn ON kanban_wakes(session_id, turn_key);
CREATE INDEX idx_kanban_wakes_pending ON kanban_wakes(app_id) WHERE state = 'pending';

CREATE TABLE kanban_wake_events (
  wake_id          INTEGER NOT NULL REFERENCES kanban_wakes(wake_id),
  subscription_id  INTEGER NOT NULL,
  event_id         INTEGER NOT NULL,                -- an outcome the turn was told of
  task_id          TEXT NOT NULL,
  PRIMARY KEY (wake_id, subscription_id, event_id)
) STRICT;

CREATE INDEX idx_kanban_wake_events_task ON kanban_wake_events(task_id, wake_id);

UPDATE schema_version SET version = 13;
```

- **One `kanban_wakes` row per woken turn**, written before its first submit, so the batch is
  fixed: a submit after a refusal, or after a restart, carries the same events and the same uuid
  (§5.7). Its events are rows of `kanban_wake_events`, rather than a JSON column, so `task show`
  finds a task's last wake (§10), and the unblock of §9.2 finds a wake's blocks, by index.
- **The turn is named by its session and its idempotency key**, `turn_key`, as the turns table's
  unique index `idx_turns_idem (session_id, idempotency_key)` names it. *A decision, forced by the
  code:* the approved design said "turn id"; the turn id is minted by the actor inside `#runTurn`,
  after `submit` returns, so the waker never holds it; the key is the waker's own
  (`turnIdempotencyKey(appId, messageId)`, §5.5), and the turn id is one join away
  (`turns WHERE session_id = ? AND idempotency_key = ?`). See §17, D6.
- **The rows drive the per-hour cap** (§5.4): delivered rows of the conversation in the last hour,
  by `idx_kanban_wakes_hour`.
- **Kept**, never deleted: a few rows a day a busy thread, against a log that keeps every event.

### 4.3 The writers, and WRITERS.md

All in `db/kanban.ts`, the board's tables' one writer. WRITERS.md gains:

- `kanban_subscriptions`: "`wake_cursor` (migration 013) is moved forward only, by
  `advanceWake`, in the transaction that delivers or drops a wake, and by `passWake` for events the
  waker passes over; and set to the task's latest event by `setWake` when wake is turned on, in
  its transaction. It writes no event: it is the waker's own cursor, as `cursor` is the notifier's.
  `createTask` writes it as 0."
- `kanban_tasks`: "`wake_by` and `wake_depth` (migration 013) are written at the insert, by
  `createTask` and `applyDag`, from the request or, for a run's task, copied from the creating
  task; `wake_by` again only by `setWake`, set or cleared. `wake_depth` is never changed after the
  insert."
- `kanban_wakes`, new: "Added by `recordWake` (migration 013), with its `kanban_wake_events`, in
  one transaction, before the first submit. `attempt`, `session_id`, `turn_key` and `error` are
  written by `wakeSubmitted` and `wakeRefused`; `state` moves from `pending` once, to `delivered`
  by `advanceWake`, or to `dropped` by `dropWake`, each in the transaction that moves the
  subscriptions' `wake_cursor` past its events. Never deleted. Only the gateway writes it, through
  `KanbanService`."
- `kanban_wake_events`, new: "Added with its wake by `recordWake`; never changed or deleted."
- `kanban_events`: "`setWake` writes `wake_set`, and `createTask` and `applyDag` write one for a
  task made with wake on, inherited or asked for, or refused as too deep (wake spec §4.4).
  `unblock` writes `wake` in an `unblocked` event's payload for a woken turn's unblock (wake spec
  §9.3)."

### 4.4 The events

- **`wake_set`**: actor the setter (`lark:<union_id>`, `operator:<login>`, or `run:<run_id>` for
  an inherited wake); payload `{on: true, as: "lark:…", depth}` or `{on: false}`, and for one
  refused as too deep `{on: false, refused: "too_deep", depth}`, and for an inherited one `from`,
  the creating task. A notice only when `refused` is `too_deep`, rendered by `renderNotice` as the
  line of §3.4; every other `wake_set` is no notice: the command's answer says it.
- **`unblocked`**, for a woken turn's unblock (§9.3), gains `wake: <wake_id>`; its actor is the
  wake's principal.

---

## 5. The waker

### 5.1 One owner, a round every 2 s

`Waker` (`src/kanban/waker.ts`) is built by the gateway when `kanban.enabled` is set, with
`kanban.wake.enabled` true; with the board off there is no waker, as there is no notifier. Like
the notifier: `start()` once the channel is connected, a round every `WAKE_POLL_MS` (2,000), one
round at a time (a round asked for while one runs is that round), `stop()` and `idle(boundMs)`
before the channel disconnects at shutdown. It is the only thing that submits a woken turn.

### 5.2 A round

1. **Pending wakes first.** Every `kanban_wakes` row of this bot still `pending` is a batch
   already fixed: recorded, and refused or cut off by a restart before it was delivered. Each is
   tried again (§5.6, §5.7) before anything new for its conversation is read.
2. **What is due.** One query, beside `dueSubscriptions` (`src/db/kanban-read.ts`): this bot's
   subscriptions whose task has `wake_by` set, with an event past `wake_cursor` **and at or before
   `cursor`**, the notice cursor (§5.8), each with its oldest such event's id. A subscription
   reads at most `ROUND_EVENTS` (100) events a round, as the notifier's does.
3. **Let go of, passed over and skipped**, each moving `wake_cursor` past the events by
   `passWake`, with no wake:
   - a subscription whose task is not on the board: let go of by itself, one log line, and passed
     over until a restart, as the notifier does;
   - an archived task's events;
   - events that are not outcomes (§2.2): passed over with the batch that covers the outcomes
     around them, or at once when the subscription has no outcome due;
   - a task whose `wake_by` fails the live check (§5.3);
   - a conversation not admitted (§2.1).
4. **Grouped by conversation**, `(channel, account_id, conversation_id, thread_id)`, as the
   notifier groups, and **then by principal**: the outcomes of the tasks set by one person become
   one batch; a thread whose tasks were set by two people has two batches, the one whose oldest
   event is older first. *Why:* a turn runs as one person (§6.2), and a batch with two setters
   would run one of them's tasks with the other's tier. See §17, D5.
5. **The limits** (§5.4), per batch: busy, the per-hour cap.
6. **At most `ROUND_WAKES` (5) submits a round**, the longest waiting first, by its oldest event.
   Each starts an agent, maybe an actor, and the registry makes room by closing idle ones; a
   restart that finds many threads due spreads them over rounds, as the notifier's `ROUND_SENDS`
   does.
7. **Submit** each batch that passed: record it (§5.5), send the marker (§8), submit.

### 5.3 Authority, checked live

At each wake, before a batch is formed, each task's `wake_by` is checked:

- **talk tier**, as `PeopleDirectory.canTalk(principal)` judges a person named by principal
  (grants §4.3): the open_id `people` holds for them in the talk list, or their active grant. A
  principal `people` does not hold has no open_id, and is judged by their grant alone.
- **If the check fails**, that task's outcomes in the round are skipped (`passWake`), and the
  conversation is told once: `` wake is off for `k_…`: Kevin Tu no longer has talk tier``, by chat
  name, else the principal. Its notice still goes: the notifier never asks. *Once:* the waker
  keeps, in memory, the tasks it has said this for, and forgets one when its check next passes, so
  a person who lost talk tier and got it back is said again if they lose it again; a restart may
  say it once more. Wake stays on: a grant made again resumes the wakes from the next outcome, as
  the skipped ones are passed.
- **The woken turn runs as `wake_by`** (§6.2), with that person's tier and name.

### 5.4 Limits

- **Batching.** A conversation's outcomes for one principal in one round become one wake turn,
  whatever their number: the prompt says the first of them and counts the rest (§7).
- **Busy session.** A wake waits while the session is mid-turn: while the session bound at the
  key has an open turn (`openTurns`), or its live actor has anything queued (`actor.queued > 0`).
  Nothing moves; the next round looks again. See §6.3.
- **Per-hour cap.** At most `kanban.wake.per_hour` (6) wake turns per conversation in any hour:
  the delivered rows of that conversation with `delivered_at` in the last 60 minutes, all
  principals together. Over the cap, the wake waits, nothing moves, and the conversation is told
  once: `wakes are paused here until 15:40: 6 this hour`, the time when the oldest of those rows
  turns an hour old, as HH:MM in the gateway's zone (`cron.tz`, else the process's, as the unblock
  redraw says times), MM-DD HH:MM on another day. *Once:* until a wake is next delivered there,
  kept in memory; the line's uuid is keyed on the conversation and that time, so a restart saying
  it again within Lark's hour shows once.
- **Depth.** A task made in a woken turn's shell gets `wake_depth` = the turn's depth + 1, and a
  run's follow-up its creating task's (§9.1). A woken turn's depth is the highest `wake_depth`
  among its batch's tasks. **A task whose `wake_depth` is at least `kanban.wake.max_depth` (5)
  stays notice-only**: wake is never set on it, and the note of §3.4 says so. *Read so, a
  decision:* the design says "past max_depth" and words its line "5 tasks deep" with a maximum of
  5; so 5 deep is past, and a person's task (0) and four levels of woken making (1 to 4) can wake.
  The depth is checked when wake is set; lowering `max_depth` later leaves wakes already set as
  they are.
- **Off switch.** With `kanban.wake.enabled` false there is no waker, and `--wake` is refused
  (§3.4).

### 5.5 Submitting

For a batch that passed the limits, synchronously after one await:

1. `bindOrCreate(key, principal)` (§2.1); `await registry.actorFor(sessionId, key)`.
2. **Busy again**, with no await between this and the submit: the session's open turns and the
   actor's queue (§5.4). Busy now, the batch waits for the next round, unrecorded.
3. **Record**, for a new batch: `recordWake` writes the `kanban_wakes` row (`pending`, attempt 1)
   and its `kanban_wake_events`, in one transaction. Then `wakeSubmitted(wakeId, sessionId,
   turnKey)` records where it goes.
4. **The marker** in the conversation (§8), not awaited by the submit: a slow send must not hold
   the round.
5. **`cronTurns.turnSubmitted(sessionId, turnKey, operate)`**, with cron on: whether `wake_by`
   has operate tier, as the router tells it for a typed turn (cron §7.1), so the woken turn's `mt
   cron add` is judged by them.
6. **`actor.submit(req)`**, the request of §6.1: `messageId` `wake:<uuid>` for attempt 1 and
   `wake:<uuid>:<attempt>` after, `appId` this bot's, the prompt (§7) as `input.text` with no
   paths, no `replyTo`, `origin`, and `onPrompted`.
7. **Delivered** when `onPrompted` fires, the prompt handed to the agent: `advanceWake` sets the
   row `delivered` and moves each subscription's `wake_cursor` to its last event the batch covered,
   notices or not, in one transaction. A failed, cancelled or ambiguous turn after that counts as
   delivered and is never woken again: the agent was told.
8. **Refused** otherwise (§5.6).

`turnKey` is `turnIdempotencyKey(appId, messageId)`, the key the actor gives the turn.
`wakeBatchUuid(appId, pairs)` (`src/core/ids.ts`) is a hash of the bot, the word `kanban-wake`, and
the sorted set of the batch's `(subscription, event)` pairs, as `noticeBatchUuid` is, so a batch's
uuid is its events', never the time it was made. A message id starting `wake:` can be no Lark
message's (`om_…`), so no typed turn shares a key with a woken one.

### 5.6 The session refuses

A refusal is anything that keeps the prompt from reaching the agent:

- the submit's promise **rejects**: the actor closed (`session … is closed`), its mailbox full
  (`MailboxFull`), the session held (`SessionHeld`); or `actorFor` throws (a role or workspace no
  longer configured);
- the promise **resolves without `onPrompted` having fired**: the agent failed to start (the
  actor ends the turn `failed`), or a newer generation took the session before delivery
  (`cancelled`, "superseded before delivery").

Then: **the cursor does not move**. `wakeRefused(wakeId, error)` adds one to `attempt`, at once,
and records the reason, masked; the conversation is tried again after 2 s, doubling to at most 5
minutes (`WAKE_BACKOFF_MAX_MS`), while the others go on. A refused attempt left a turn record
behind (a failed start ends its turn, `SessionHeld` included) whose key the next attempt must not
reuse, or `createTurn` would answer it as a duplicate: hence a new attempt, a new message id. **After
10 refusals in a row** (`WAKE_REFUSALS`, about 13 minutes of pauses) the batch is dropped:
`dropWake` sets the row `dropped` and moves the cursors past its events, one line goes in the
conversation, `` the agent could not be woken for `k_…`, `k_…`: its session refused 10 times (session s_… is quarantined and will not be resumed automatically), so those updates are dropped``,
and one in the log, `kanban: wake <wake_id> for <chat>/<thread> (tasks …) dropped after 10 refusals: <reason>`.
The pause is in memory, as the notifier's: a restart tries a pending row at once.

### 5.7 Restarts, and dedupe

The cursors and the pending rows are in the database, so the first round after a start, run once
the channel is connected, catches up by the same code.

- **A pending row** is first looked up in the turns table: a turn with its `session_id` and
  `turn_key` exists. **If one exists, the batch was submitted** before the stop and reached the
  actor's `#runTurn`, which wrote the turn before anything else: it is marked delivered, with its
  cursors, and never submitted again, whatever the turn became (the boot reconciles an open turn
  as `ambiguous`, and holds a session whose prompt was `delivering`, in the registry's
  `reconcileBoot`). **If none
  exists**, the submit never reached the actor, and the same batch is submitted again, with the
  same uuid and attempt, when its session is idle.
- **A batch is never submitted twice**: its events are fixed in its row, its message id is its
  uuid and attempt, and the turns table's unique `(session_id, idempotency_key)` makes a repeated
  submit `createTurn`'s duplicate, which the actor answers without prompting (`duplicate submit
  for turn …`). That covers the one window the lookup above cannot see, a submit made and the
  turn being written as the gateway stops.
- **The cost.** A turn whose agent failed to start, in the moment before its refusal was recorded,
  then a stop: the restart finds its turn and takes it as delivered, so that batch is lost. The
  window is one synchronous write; accepted (§16).
- **A `/new` between the submit and the restart**: the row names the old session, whose turn
  exists, so it is delivered; nothing is woken in the new session for it.

### 5.8 Ordering with the notifier

**The notice comes before the woken turn.** The waker reads an event only when every subscription
it reads it for has its notice cursor at or past it (§5.2, step 2): the notifier has sent its
notice, or dropped it (a conversation let go of, a task gone), and moved `cursor` past it. So:

- a thread whose notices are held back, by a Lark outage or a refused send, is not woken until
  they go, or are dropped after the notifier's nineteen minutes (kanban §9.4);
- the Unblock button, where there is one, is in the thread before the agent is told of it, and
  its record (`kanban_unblock_buttons`) is written before the cursor moves, so the prompt can say
  whether the notice carried one (§7);
- the marker (§8) is sent after the notice and before the turn's card.

---

## 6. The session layer

### 6.1 What `submit` takes

`submit(req: SubmitRequest)` takes **no principal**. A turn is keyed by `messageId`, through
`turnIdempotencyKey(appId, messageId)`; its sender is known only to the router, which tells
`cronTurns` its tier (cron §7.1) and binds a new session to it as owner. A turn needs, and a woken
one is given:

| A turn needs | A typed turn | A woken turn |
|---|---|---|
| a bound session | `bindOrCreate(key, message.sender)` | `bindOrCreate(key, principal)`, the principal from `people` (§3.2) |
| its actor | `registry.actorFor(sessionId, key)` | the same |
| a message id, for idempotency | the Lark message's `om_…` | `wake:<uuid>[:<attempt>]` (§5.5) |
| `appId` | the message's | this bot's |
| `input` | the text and the attachments' paths | the prompt, no paths |
| `replyTo` | the message, in a group at chat scope | none: there is no message to quote |
| its tier, for `mt cron add` | `cronTurns.turnSubmitted` | the same, with `wake_by`'s operate tier |

`SubmitRequest` gains two optional fields, and nothing else of the actor changes:

```ts
export interface SubmitRequest {
  messageId: string;
  appId: string;
  input: PromptInput;
  replyTo?: string;
  /** A turn the board woke (wake spec §6.2): recorded in its `turn_submitted`, and shown on its card. */
  origin?: { wake: { id: number; by: string; name: string } };
  /** Called once, when the prompt is handed to the agent, after the runtime started (wake spec §5.5). */
  onPrompted?: () => void;
}
```

- **`onPrompted`** is called in `#runTurn` just after `setTurnState(…, 'running')` and `promptSent
  = true`, before the first event is read: the moment the existing code already marks as "the
  prompt reached the runtime". A throw from it is caught and noted; it never fails the turn. The
  waker needs it because the actor's terminal cannot tell "the agent failed to start", which
  resolves `failed`, from "the agent started and failed", which also resolves `failed`.
- **`origin`** is written into the `turn_submitted` payload as `wake: {id, by, name}`, beside
  `text`, `paths` and `messageId`; `name` is the setter's chat name at the submit, masked, one line,
  cut at 80, as every name (kanban §9.3). The event's `actor` stays `user`, as the turn is on the
  setter's behalf; `Actor` is not widened.

### 6.2 Who a woken turn is, and how it shows

- **It runs as `wake_by`**: the session's owner when the wake makes the session; its `mt cron
  add` judged by `wake_by`'s operate tier (§5.5, step 5); its one board command, `task unblock`,
  judged by `wake_by`'s operate tier, live (§9.2). Its agent is the session's, with the session's
  role and workspace: a wake chooses nothing about the agent.
- **In the transcript**: the session's log, `events`, holds its `turn_submitted` with
  `wake: {id, by, name}`, and the prompt, which itself begins "Board update" (§7), so a replay to an
  agent that cannot resume natively (`#replayInputs`) shows it as a board update, and `kanban_wakes`
  names the turn by `turn_key`.
- **On the card**: `renderCard` (`src/channel/render.ts`), at a `turn_submitted` with `wake`, keeps
  a header for that turn, and the card's first line is `_(woken by the board, as Zhixi Sun)_`,
  escaped as a label, above the answer as it streams. The card quotes nothing, having no message to
  reply to. A typed turn's card is unchanged.
- **No reaction.** The router reacts to the message it accepted (`ACK_EMOJI`); a woken turn has
  none, and the marker (§8) is what the thread sees before the card.

### 6.3 A waiting wake and the mailbox

- **A waiting wake is not in the actor's mailbox.** The waker submits only to an idle session
  (§5.4, §5.5 step 2): until then the batch is the waker's, in the database, and the actor knows
  nothing of it. So a waiting wake never counts toward `MAX_MAILBOX_DEPTH`, never answers a person
  "Queued: 1 ahead", and never runs before a message a person typed while it waited: a person's
  turns go first, and the wake follows once the session is idle. A thread kept busy without pause
  delays its wake for as long as it is busy; nothing else does.
- **No race with a typed message.** The busy check and `submit` run with no await between them,
  after the only await, `actorFor`; the router's `#submit` reads `actor.queued` and submits the
  same way. Whichever submits first is first in the mailbox; the other queues behind it, as two
  messages do.
- **Once submitted, a woken turn is a turn.** A message typed during it queues behind it and is
  answered "Queued: 1 ahead of this one. It starts when that finishes; `/stop` cancels the running
  one.", as for any turn; `/stop` cancels it (`actor.cancel()`), and a cancelled woken turn counts as
  delivered (§5.5). `/new` during it retires the session as for any turn.

---

## 7. The prompt

```
Board update: you are woken because wake is on for these tasks (set by Zhixi Sun). Decide what to do next; you can reply here, or use mt kanban as in any turn.

k_7Gq2…: Book the venue
Outcome: completed, by role worker
Summary: The hall on Elm Street is booked for 12 June; the deposit is paid.

k_9Lm4…: Draft the agenda
Outcome: blocked (needs_input), by its run
Reason: Which of the two keynote speakers is confirmed?
An Unblock button is on its notice in this thread. If you can answer the block yourself, lift it with `mt kanban task unblock k_9Lm4… <comment>`: the comment goes to the task's next run. Otherwise ask a person here.
```

- **The header**, in the approved words, with the setter by chat name, else the principal.
- **One block per event**, in event order: the task's id and title; the outcome; and the summary
  or the reason. Each piece is masked, made one line, and cut at 1,000 characters, as task text is
  (kanban §9.3), titles through `titleText` so a `lark:` token in a title reads as a name.
- **The outcome line**, by kind (§2.2): `completed, by <the run's role, or the person>`;
  `changes requested by <reviewer>` with `Reason:`; `blocked (<kind>), by its run` with `Reason:`;
  `gave up` with `Reason:` the run's `blockReason`; `blocked (<blockKind>) when its run ended` with
  `Reason:`; `stranded` with `Reason:`. People are named by chat name (`PeopleDirectory.chatNames`,
  read once for the prompt).
- **For a block**, its kind and reason, then one note, chosen at the submit:
  - with an Unblock button recorded for that block event (`kanban_unblock_buttons`): `An Unblock
    button is on its notice in this thread.`; without one (the batch had more than five blocks,
    or the card was refused and went as text), `Its notice in this thread has no Unblock button;
    /kanban task unblock lifts it.`;
  - then, **when `wake_by` has operate tier now**: `If you can answer the block yourself, lift it
    with mt kanban task unblock <task> <comment>: the comment goes to the task's next run.
    Otherwise ask a person here.`;
  - **when not**: `You cannot lift this block: Zhixi Sun, who set this wake, does not have operate
    tier. Ask here for someone who can.`;
  - **when the block has recurred `kanban.block_recurrence_limit` times** (its event's
    `blockRecurrences`, kanban §5.4): `It has been blocked 3 times in a row: ask a person here
    whether to unblock it again, or to rewrite the task.`, and no unblock is offered (§9.2).
- **At most 4,000 characters in all**: blocks are dropped from the end until the prompt fits, and
  the last line is `and N more: /kanban task list`. The dropped events are covered by the wake all
  the same: their notices are in the thread.
- **Masked once more as a whole** before the submit, as every reply is. The prompt is stored as
  given in `turn_submitted` (replay sends it again), so it is built only from masked pieces.

---

## 8. In the thread

In order:

1. **The notice**, unchanged, by the notifier (§5.8).
2. **The marker**, sent by the waker just before the submit, one line in the conversation, in a
   thread replying to its root as the notifier's sends do (`threadRootOf`):
   `Waking the agent for 2 board updates.`, or `Waking the agent for 1 board update.`, counting the
   batch's events. Its uuid is `replyUuid(appId, 'wake:<uuid>', 'marker')`, so a marker sent
   again after a restart shows once within Lark's hour. A marker that fails is logged and the
   turn goes all the same: the turn is the point, and its card says what it is.
3. **The reply card**, streamed as a normal turn's, with its first line (§6.2).
4. **What people type** queues behind the woken turn; `/stop` cancels it (§6.3).
5. **If the agent unblocks**, the notice's Unblock button is redrawn by the unblock redraw as
   `` `k_…`: Unblocked by Zhixi Sun (woken by the board) at 14:05`` (§9.3).

The waker's own lines, the marker, the tier line (§5.3), the cap's line (§5.4) and a dropped
batch's line (§5.6), are sent with the notifier's bound (`NOTICE_SEND_MS`), masked, never with
buttons, and are not retried: each says something the next round would say again or that the log
keeps.

---

## 9. A woken turn's shell

### 9.1 Its depth, without a variable

**`MT_WAKE_DEPTH` cannot be an environment variable.** An agent's environment is fixed when its
runtime starts, once per actor build (cron §7.1: the ACP driver spawns one process per session,
and the CLI driver keeps its start's `env` for every turn), so a session cannot be given a
variable for one turn. See §17, D1. Instead, the shell already carries the session marker,
`MT_AGENT_SESSION=<session id>` (grants §6.3), in every agent session, and the turn running in it is
the one open turn past `pending` (`openTurns`), as `CronTokens.runningTurnOperate` finds it. So
**a woken turn's depth is read from the database**: `wakeOfShell(db, sessionId)` in
`src/db/kanban-read.ts` answers the delivered `kanban_wakes` row whose `session_id` is the
marker's and whose `turn_key` is that turn's idempotency key, or none.

- **Where a task is made in such a shell.** With cron on, a chat agent's shell refuses the
  operator's `mt kanban task new` (cron §6.4), so it makes no task. With cron off it can, as the
  operator, by the user's choice (grants §6.3, §12). Then `mt kanban task new`, `workflow start`
  and `workflow apply` (`src/cli/operator.ts`), in a shell with `MT_AGENT_SESSION` set whose
  `wakeOfShell` finds a wake, make their tasks with `wake_depth` = the wake's `depth` + 1, and a
  `--wake` there runs as the wake's `principal`, not the owner: a woken turn's work runs as the
  person whose wake it is. Past the depth, the note of §3.4.
- **Inheritance by follow-ups.** A run's follow-up is made by `createTask` with `createdVia` a
  run: `insertTask` copies the creating task's `wake_by` and `wake_depth`, unchanged, and writes
  the inherited `wake_set` (§3.1). A run is not a woken turn, so it adds no depth: a chain of runs
  is bounded by the board, and only woken turns making tasks are what depth counts.

### 9.2 `mt kanban task unblock` from a woken turn

*Proposed rule, pending the user's agreement (§18, Q1).*

The approved design has the agent lift a block "with `mt kanban task unblock <id>`", but a chat
turn's shell has no board command: with cron on, `MT_CRON_TOKEN` makes it an agent's shell, which
refuses the operator's `mt kanban` (cron §6.4); and the worker's commands need a board run's
`MT_KANBAN_RUN` (kanban §7.3). So, as an exception to that refusal, scoped:

- **A woken turn may run `mt kanban task unblock <task_id> [comment...]`** for the tasks whose
  blocks woke it, and only when `wake_by` has operate tier, checked live at the unblock, as
  Unblock needs operate tier from anyone (`KanbanChat`'s `unblock: 'operate'`, and its card press).
  The command is the operator's form, the comment after the id, with no `--comment` flag
  (`src/cli/mt.ts`'s usage). See §17, D3.
- **How the shell asks.** In a shell with `MT_AGENT_SESSION` set and no board run's variables,
  `mt kanban task unblock` sends, before any refusal, `{"wake": "unblock", "session": <marker>,
  "token": <MT_CRON_TOKEN, when set>, "input": {"task_id", "comment"}}` to the socket,
  `MT_KANBAN_SOCKET`. The gateway answers it, or `not_woken`. On `not_woken`, an agent's shell
  (`inAgentRun`) gets today's refusal, `runShellRefusal`'s, and any other, a chat shell with cron
  off, goes on to the operator's unblock as today. So nothing changes outside a woken turn.
- **Which tasks: kept by the gateway, not in the shell.** The environment cannot hold a list per
  turn (§9.1). The gateway finds the session's running turn and its delivered wake
  (`wakeOfShell`), and the wake's `kanban_wake_events`: the task must be one whose **block event
  is among them** (`blocked` or `run_ended` with `next` `blocked`), and the unblock is bound to that
  event, as an Unblock press is (`unblock(…, {blockedAt})`), so a block lifted and made again since
  is refused as `stale`.
- **Whose shell.** With cron on, the request must carry `MT_CRON_TOKEN`, and the session is the
  token's (`CronTokens.lookup`, which already requires an open turn and the binding it was minted
  for), never the marker alone: an agent's shell is known by its token, and a marker is no secret.
  With cron off there is no chat token, and the marker names the session: such a shell can run the
  operator's own unblock anyway (grants §6.3), so the marker gives it nothing it lacked.
- **Checked by the gateway, in order**, each a refusal with its code:
  1. `kanban_off`, `wake_off`: the board, or wakes, off;
  2. `unauthorized`: with cron on, no token or another session's;
  3. `not_woken`, `this turn was not woken by the board`: no running turn, or one with no
     delivered wake;
  4. `not_this_wake`: `` `k_…` did not wake this turn: a woken turn unblocks only the tasks whose blocks woke it``;
  5. `needs_operator`: `Zhixi Sun, who set this wake, does not have operate tier, which unblocking needs: ask in the thread for someone who can`;
  6. `recurring`: `` `k_…` has been blocked 3 times in a row: a person decides whether it is unblocked again``,
     when the block event's `blockRecurrences` has reached `kanban.block_recurrence_limit`, so
     a woken agent and a run cannot unblock each other in a loop (part of Q1);
  7. the board's own, from `KanbanService.unblock`: `not_found`, `stale`, `illegal_transition`.
- **The answer** is the operator's, `` `k_…` is unblocked, back to open, as Zhixi Sun (woken by the board)``,
  and the dispatcher is nudged, as chat's unblock nudges it.
- **Nothing else.** Every other operator command in a woken turn's shell is as in any chat
  turn's: refused with cron on; the operator's with cron off, as today (§16).

**Kanban §22.1 is amended:** "a chat agent's `mt` has no board commands" becomes "a chat agent's
`mt` has no board commands, but for a woken turn's `task unblock` of the tasks that woke it (wake
spec §9.2)".

**The environment a chat session gets, amended.** The request needs the socket, which a chat
session's shell has only with cron on (`CronTokens`'s `#access`: `MT_KANBAN_SOCKET`, and `PATH`
with `$MT_HOME/bin` first). With `kanban.enabled` and `kanban.wake.enabled` set and cron off, the
registry's `envFor` gives a Lark chat session the same two, from the same `WorkerAccess`, beside
the session marker, and no token. Cron §10's "no chat session gets a token or a `PATH` change"
and grants §6.3's amendment of it become: with cron off, no chat session gets a token; with wakes
on, every Lark chat session gets the socket and the `PATH`. Neither is in `AGENT_VARIABLES`, so no
command's behaviour changes but the one above.

### 9.3 The attribution, and the redraw

- **The `unblocked` event's actor is `wake_by`**, the person the turn runs as, and its payload
  gains `wake: <wake_id>`, so what lifted it is recorded truly: the person's authority, the agent's
  hand.
- **The unblock redraw** (kanban §9.2, amended by the unblock redraw) reads the lift's payload with
  its actor (`unblockMessage`'s lift gains `woken`), and `renderUnblockRedraw` draws
  `` `k_…`: Unblocked by Zhixi Sun (woken by the board) at 14:05``. Kanban §9.2's line is amended
  so. A press on a button whose block a woken turn lifted redraws the same way.
- **The redraw is found by the loop**, as for any unblock from another path: the socket's unblock
  is the gateway's own, but it goes through `KanbanService.unblock` like chat's, and the loop finds
  every `unblocked` past a recorded block.

### 9.4 Its comment reaches the next run

**Yes.** Only steering comments reach a run (`commentsOf(db, taskId, {steering: true})` in
`src/kanban/brief.ts`), and `unblock`'s comment is always written with `steers` true ("An unblock
is an operator's, so its comment steers the next run", `db/kanban.ts`). A woken unblock is made
only with `wake_by`'s operate tier (§9.2), so that holds. The comment's author is `wake_by`, and
its body is stored as `(woken by the board) <comment>`, so the next run, and `task show`'s
comments, read that an agent wrote it on that person's authority. The body is cut and masked as
any comment's.

---

## 10. Seeing it: `task show`

- **`/kanban task show`** gains one line, after the board's: `Wake: on, set by Zhixi Sun, depth 1;
  last woke 14:02`, or `Wake: on, set by Zhixi Sun, depth 0` before its first wake, or `Wake:
  off`. The name by chat name; the time of the task's latest delivered wake
  (`idx_kanban_wake_events_task`, joined to `kanban_wakes`), in the gateway's zone, MM-DD HH:MM on
  another day. With `kanban.wake.enabled` false, `Wake: on, set by …, but wakes are off on this
  gateway`.
- **`mt kanban task show`** prints the same line with the principal, and `--json` gains
  `"wake": {"on", "by", "depth", "last_woke"}`, `last_woke` in milliseconds, or `null`.
- **`/kanban task list`** is unchanged.

---

## 11. Configuration, and the startup line

```yaml
kanban:
  wake:
    enabled: true        # default true; false: no waker, and --wake is refused
    per_hour: 6          # wake turns per conversation per hour; default 6, 1 to 60
    max_depth: 5         # a task this many woken turns deep stays notice-only; default 5, 1 to 20
```

- **A subsection of `kanban:`**, snake case and file only, as the section's keys are: `wake`
  joins `kanban`'s keys in `parseFile`'s `reject`, and its own keys are checked the same way, an
  unknown one refused. `KanbanSettings` gains `wake: { enabled: boolean; perHour: number;
  maxDepth: number }`, and `TeamSettings` the same, so the terminal's `--wake` reads the switch
  and the depth as the gateway does (the terminal's reading, as for every setting, kanban §22.7).
- **On by default**, unlike the board itself: a wake is opt-in per task already, so the switch is
  for an operator who wants none at all. It does nothing while `kanban.enabled` is off.
- **The startup line**, after the board's: `kanban: wakes on; at most 6 woken turns a
  conversation an hour, tasks up to 4 woken turns deep`; or, with it false and tasks with wake on,
  `kanban: wakes off (kanban.wake.enabled is false); 3 task(s) with wake on stay notice-only`; and
  nothing when off with none.

---

## 12. The cases

- **A task completes in its thread with wake on**: the notice; the marker, "1 board update"; the
  card, streaming; the agent may reply, or not.
- **Three tasks of one thread complete within one round, set by one person**: one notice message,
  one marker, "3 board updates", one turn.
- **Two people set wake on two tasks in one thread**: two turns, one after the other, each as its
  setter (§5.2).
- **A person typing in the thread while outcomes arrive**: the person's turns run; the wake waits
  until the session is idle, then goes.
- **A person typing during the woken turn**: queued behind it, "Queued: 1 ahead"; `/stop` cancels
  the woken turn, which is not woken again.
- **The setter's talk tier revoked**: their tasks' next outcomes are skipped, the thread told once,
  the notices sent; a grant made again resumes from the next outcome.
- **A block, `wake_by` an operator**: the agent may unblock it with a comment; the notice's button
  is redrawn "Unblocked by … (woken by the board)"; the next run reads the comment.
- **A block, `wake_by` at talk tier only**: the prompt says the agent cannot lift it; its unblock
  is refused `needs_operator` if it tries.
- **A woken agent unblocking a task that did not wake it**: refused `not_this_wake`.
- **A block lifted by a person while the woken turn runs, then the agent's unblock**: refused
  `stale`, as a press on a lifted block is.
- **The same block recurring at `block_recurrence_limit`**: the agent is told to ask a person;
  its unblock is refused `recurring`.
- **Seven outcomes in an hour, one a turn**: the sixth wakes; the seventh waits, and the thread is
  told "wakes are paused here until 15:40: 6 this hour"; at 15:40 it wakes, with everything that
  came meanwhile in one batch.
- **A person's stop**: the notice says who stopped it; no wake.
- **A task stranded**: woken, with the reason, as any outcome.
- **A task archived while its wake waits**: skipped.
- **A task deleted from the board**: let go of, one log line.
- **A thread whose notices are held back by a Lark outage**: no wake until the notices go.
- **A conversation with no session**: the first wake makes one, owned by the setter.
- **A session held (quarantined)**: each submit is refused `SessionHeld`, with the pause doubling;
  after 10 the batch is dropped with its line, and the next outcome tries again, refused again until
  someone `/attach`es or `/new`s.
- **The gateway stops after the turn began**: the restart finds the turn, and does not wake again.
- **The gateway stops after the row was recorded, before the submit reached the actor**: the
  restart submits it, once.
- **A follow-up of a woken task**: wake on, the same setter and depth, its outcomes in the same
  thread.
- **A terminal's `--wake` without `--chat`**: refused, nothing made.
- **A cron script's `mt kanban task new --chat … --wake`**: a terminal's, as the owner.
- **`kanban.wake.enabled` turned off, then on**: nothing woken while off, the wake cursors not
  moved; on again, the backlog wakes as a restart catches up, one turn a conversation and principal,
  under the cap.
- **With cron off, a woken turn's shell running `mt kanban task archive`**: the operator's, as in
  any chat turn's shell with cron off (§16).

---

## 13. Wiring

- **`schema/013_wake.sql`**: §4.
- **`src/db/kanban.ts`**: `setWake`; `createTask`, `insertTask` and `applyDag` take `wake?: {by,
  depth}`, copy a creating task's, write `wake_set`, and `subscribe()` writes `wake_cursor` 0;
  `recordWake`, `wakeSubmitted`, `wakeRefused`, `advanceWake`, `dropWake`, `passWake`; `unblock`
  takes `wake?: number` for its event's payload.
- **`src/db/kanban-read.ts`**: `dueWakes(db, appId)`, beside `dueSubscriptions`; `pendingWakes`;
  `wakesInLastHour(db, at, now)`; `wakeOfShell(db, sessionId)`; `lastWokeOf(db, taskId)`;
  `unblockMessage`'s lift gains `woken`.
- **`src/db/turns.ts`**: `turnByKey(db, sessionId, idempotencyKey)`, a read.
- **`src/core/ids.ts`**: `wakeBatchUuid`.
- **`src/core/session-actor.ts`**: `SubmitRequest.origin` and `onPrompted` (§6.1).
- **`src/channel/render.ts`**: the woken turn's first line.
- **`src/kanban/waker.ts`**, new: the `Waker`, `WAKE_KINDS`, `WAKE_POLL_MS`, `ROUND_WAKES`,
  `WAKE_REFUSALS`, `WAKE_BACKOFF_MAX_MS`, and the prompt's builder; `WakerDeps` = `{db, service,
  registry, channels, appId, people, hasTier, admits, cronTurns?, settings, blockRecurrenceLimit,
  zone, clock?, note?}`.
- **`src/kanban/service.ts`**: `setWake`, refusing as §3.4; `create` and the starts taking `wake`;
  the wake writes, as the waker's only way to the writer; `unblockForWake(session, token, taskId,
  comment)`, the checks of §9.2.
- **`src/kanban/socket.ts`**: the `wake` envelope, beside `cron` (cron §7.4's table gains `{wake,
  session, token?, input}`).
- **`src/kanban/chat.ts`, `chat-parse.ts`, `chat-render.ts`**: `--wake` on `task new` and
  `workflow start`; `task wake <id> on|off`, at talk tier; `renderShow`'s line; `renderNotice` for
  `wake_set` too deep; `renderUnblockRedraw`'s "(woken by the board)".
- **`src/kanban/workflow.ts`**: `wake` in a step and a DAG task.
- **`src/cli/operator.ts`, `src/cli/mt.ts`, `src/cli/plain.ts`**: `--wake`; `task wake`; the
  depth and principal from `wakeOfShell`; `task unblock`'s ask of the socket first (§9.2); `task
  show`'s line and `--json`; `USAGE`.
- **`src/config.ts`**: `kanban.wake`, in `KanbanSettings` and `TeamSettings`.
- **`src/index.ts`**: the waker built with the notifier when the board is on and wakes are on,
  started after the channel connects, stopped and idled before it disconnects; `envFor` giving
  chat sessions the socket and `PATH` with wakes on (§9.2); the startup line.
- **`src/db/WRITERS.md`**: §4.3.
- **Documents**: the guide's board section, the README's commands and settings, and
  `docs/examples.md`'s workflow example with `--wake`.

---

## 14. Testing

- **Unit, the waker, on a fake clock with a fake submitter** (a `SubmitRequest` recorder that
  resolves, rejects, or calls `onPrompted`, and a fake channel): each outcome of §2.2 wakes and
  each kind of §2.3 does not, a person's `blocked` and `stopped` among them, a `dependency` block
  and a retrying `run_ended`; each outcome woken once, and a block never woken again; the cursor
  starting at the latest event when wake is turned on, so an old block is not replayed; an event
  held until its notice cursor passes it, and woken at once after; a batch per conversation and
  principal, in event order; the busy session, by an open turn and by a queued actor, nothing
  moving until idle; the per-hour cap at 6, its line once, its time in the zone, and the seventh
  woken when the hour turns; the depth, a task at 4 woken and one at 5 not, with its note; the
  talk check failing, the task's events skipped, its line once, said again after a lapse and a
  return; the refusals, each kind (closed, full, held, a start that failed, superseded before
  delivery), the pause doubling to five minutes, a new attempt and message id each time, and the
  tenth dropping the batch with its two lines; a woken turn that fails after `onPrompted` counted
  delivered; a pending row after a restart with its turn present marked delivered, and without
  one submitted again with the same uuid and attempt; a repeated submit answered as the actor's
  duplicate; an archived task skipped; a deleted task let go of once; a conversation outside
  `auth.chats` passed over; at most 5 submits a round, the longest waiting first; the prompt,
  each piece cut at 1,000 and masked, the whole at 4,000 with "and N more", names by chat name,
  the block notes for an operator, a talk-tier setter, a recorded button and none, and a recurring
  block.
- **Unit, the session layer**: `onPrompted` called once, after the runtime started and before the
  first event, not on a failed start, not on a duplicate, and a throw from it noted; `origin` in
  `turn_submitted`; the card's first line, escaped and masked, and none for a typed turn.
- **Unit, the writer**: `setWake` and its event, refused without a subscription and when too deep,
  and the cursor set in its transaction; `createTask` inheriting `wake_by` and `wake_depth` from a
  run's task, with its `wake_set`; `recordWake` and its events in one transaction; `advanceWake`
  and `dropWake` moving each cursor forward only; `unblock` with `wake` in its payload; the
  migration on a database at 12.
- **Commands, chat**: `--wake` on `task new` and `workflow start`, a title ending `--wake`;
  `task wake on|off` at talk tier, refused at none, refused for a task another chat follows, the
  replacement of a setter and "already on"; refusals with wakes off; `task show`'s line in each
  form.
- **Commands, terminal**: `--wake` with and without `--chat`; the owner's principal, and refused
  with no owner in `people`; `task wake`; `workflow start --wake` and `apply` of a DAG with
  `"wake": true`; refused in a board run's shell; with `MT_AGENT_SESSION` in a woken turn, a task
  made at depth + 1 and its `--wake` as the wake's principal; `task show --json`'s `wake`.
- **Commands, workflow**: `wake: true` in a step, checked, carried into the DAG; a run's start
  inheriting the run's task's wake whatever the step says.
- **The woken unblock**: through the real socket, a woken turn's unblock of its own block with
  `wake_by` at operate tier, and its event's actor and `wake`, its comment's `steers` and body; each
  refusal of §9.2 in order; with cron on, the token required and another session's refused; with
  cron off, `not_woken` falling back to the operator's unblock; outside a woken turn, today's
  refusal unchanged.
- **End to end**, through `createGateway` with `FakeChannel`, as `tests/workflow-gateway.e2e.ts`
  and `tests/auth-gateway.e2e.ts` do: a task created in a group with `/kanban task new … --wake`,
  its thread opened, a fake agent's run completing it; the notice, then the marker, then the woken
  turn's card in the thread, in that order; a person's message during the woken turn queued; a
  block woken, the agent's `mt kanban task unblock` through the socket, and the notice redrawn
  "(woken by the board)"; the setter's grant revoked by `/auth revoke`, the next outcome noticed
  and not woken, with the line; a restart of the gateway on the same database with a pending row,
  woken once.
- **The smoke checklist** (§15), on the user's real tenant.

---

## 15. To be confirmed, by the smoke checklist

On the user's tenant, with the board and wakes on:

1. A task in a thread, wake on, completed by a run: the notice, then "Waking the agent for 1 board
   update.", then the card streaming its answer, in that order, all in the thread.
2. Two tasks of one thread completed together: one marker, "2 board updates", one card.
3. The card's first line, "(woken by the board, as …)", shows as a muted line, with the name.
4. A message typed during a woken turn: "Queued: 1 ahead of this one…"; `/stop` cancels the woken
   turn, and it is not woken again.
5. A block with an operator as setter: the agent's `mt kanban task unblock … <comment>` works with
   cron on; the notice's button is replaced by "Unblocked by … (woken by the board) at HH:MM"; the
   next run's prompt holds the comment.
6. A block with a talk-tier setter: the agent says it cannot lift it, and asks.
7. A grant revoked with `/auth revoke`: the next outcome's notice comes, with "wake is off for …",
   and no turn.
8. Seven outcomes in an hour in one thread: the pause line once, and a wake when the hour turns.
9. A wake in a direct message's task: the DM's session is woken, its card in the DM.
10. A first wake in a thread with no session: one is made, and a person typing after continues it.
11. A restart during a woken turn: no second wake; the boot's finding for the session, as for any
    turn cut off.
12. A topic group: a woken turn's card lands in the task's topic.

---

## 16. Limits

- **No reminders**: an outcome wakes once (§2.2).
- **A busy thread delays its wakes** for as long as it stays busy (§6.3).
- **The per-hour cap delays, it does not drop**: a thread over it gets its outcomes in one later
  turn.
- **A woken turn's shell, with cron off, is the operator's for every other command**, as every
  chat turn's is (grants §6.3, §12): `mt kanban task archive` there acts as the operator, not as
  `wake_by`. Only `task unblock` is judged by the wake.
- **The marker-only identity with cron off** (§9.2): any process of the gateway's user that sets
  `MT_AGENT_SESSION` to a session with a woken turn running can unblock that turn's blocks as its
  setter; such a process can run the operator's unblock anyway. With cron on, the chat token is
  required.
- **The tier lapse line, and the pause line, are said once a boot** (§5.3, §5.4).
- **A start failure cut off by a stop is taken as delivered** (§5.7): one batch lost, in a window
  of one write.
- **Depth is counted only for tasks made in a woken turn's shell**, which with cron on makes none;
  a run's follow-ups keep their parent's depth.
- **Lowering `max_depth` leaves wakes already set** (§5.4).
- **The terminal judges the switch and the depth by its own reading of the configuration**, as for
  every setting (kanban §22.7).
- **The marker is a separate message**, not part of the card: Lark may show a gap between them.

---

## 17. Departures from the approved design

- **D1. No `MT_WAKE_DEPTH` variable.** An agent's environment is fixed per actor build, not per
  turn (§9.1), so a variable cannot carry one turn's depth. The depth is read from the database by
  the shell's session marker and its running turn (`wakeOfShell`), which is the same fact without
  the variable.
- **D2. "Use mt kanban as in any turn": a chat turn's shell has no board commands.** With cron on,
  a chat agent's shell refuses the operator's `mt kanban`, and the worker's commands need a board
  run. The header keeps the approved words; the one board command a woken turn gains is `task
  unblock`, for the tasks that woke it, with `wake_by` at operate tier (§9.2), as the coordinator
  proposed, pending the user (Q1). With cron off, chat shells run the operator's commands as
  today, and the unblock is still judged by the wake.
- **D3. `mt kanban task unblock <task_id> [comment...]`, not `--comment "…"`.** The operator's
  command takes the comment after the id, and has no `--comment` flag (`src/cli/mt.ts`); the
  prompt and the woken unblock use that form.
- **D4. "Gates failed" is no outcome of its own.** A failing gate refuses the report and leaves the
  run undecided (kanban §7.7), writing `gates_ran` with `passed: false`; the agent may fix and
  report again. It wakes only through the `run_ended` that blocks, if its run ends so (§2.2).
- **D5. A batch per conversation and setter, not per conversation.** A turn runs as one person; a
  thread whose waking tasks were set by two people gets one turn for each, in order (§5.2).
- **D6. `kanban_wakes` names the turn by session and idempotency key, not by turn id.** The turn id
  is minted inside the actor after `submit` returns; the key is the waker's own and unique per
  session, and the turn id is one join away (§4.2).
- **D7. A woken unblock's comment is stored as `(woken by the board) <comment>`**, by `wake_by`, so
  the next run and people read who wrote it (§9.4). The design said only how the redraw names it.
- **D8. Wakes need the socket in a chat shell with cron off**: with wakes on, every Lark chat
  session gets `MT_KANBAN_SOCKET` and the `PATH` with the gateway's `mt`, and no token (§9.2),
  amending cron §10 and grants §6.3.
- **D9. Two additions to the limits**: at most 5 submits a round (§5.2), so a restart that finds
  many threads due does not start every agent at once; and a woken turn may not unblock a block
  that has recurred `block_recurrence_limit` times (§9.2), so an agent and a run cannot unblock
  each other in a loop (part of Q1).
- **D10. `/kanban task wake` only in a chat that follows the task** (§3.1): a turn set going in a
  conversation the setter is not in would run as them where they cannot see it.

---

## 18. Open questions for the user

- **Q1. The woken unblock (§9.2).** A woken turn may run `mt kanban task unblock` only for the
  tasks whose blocks woke it, only while `wake_by` holds operate tier, checked live, as an exception
  to the cron-on refusal; with cron on its shell is known by its chat token, with cron off by the
  session marker. Proposed by the coordinator; is it agreed? And the guard added with it: no woken
  unblock of a block that has recurred `kanban.block_recurrence_limit` times.
- **Q2. More board commands for a woken turn?** None but `task unblock` with cron on, so a woken
  agent cannot `task show`, `task comment` or make a task. The prompt carries what it needs for the
  common case; each further verb is a case of the same envelope.
- **Q3. A lapsed tier: skip, or turn wake off?** As written, wake stays on and its outcomes are
  skipped while the setter lacks talk tier, so a renewed grant resumes it. Turning it off at the
  first failure would make the line exact once for good, and need the wake set again.
- **Q4. Turning wakes back on catches up.** With `kanban.wake.enabled` false for a while and then
  true, the backlog wakes, one turn a conversation and setter, under the cap, as after a restart.
  Should it instead skip what came while it was off?
- **Q5. `/kanban task wake` only from a chat that follows the task** (D10): agreed?
