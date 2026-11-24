# Progress cards: a live card in a task's thread for each board run

**Date:** 2026-11-24
**Status:** draft, for review
**Scope:** plan P. While an agent run on the board is under way, the chat that follows its task
gets one card, in the task's thread, that shows the run as it goes: the task, the role, which try
it is and how long it has run, each tool call and its state, and the tail of what the agent last
said, with a **Stop** button. When the run ends the card is drawn once more, final, with its
outcome and its total time. It builds kanban §1's deferred row, "Live progress cards for a run".

This document assumes [`../architecture.md`](../architecture.md), the Lark channel spec,
[`2026-08-21-lark-channel-design.md`](2026-08-21-lark-channel-design.md), cited as "channel §n",
the kanban spec, [`2026-11-02-kanban-design.md`](2026-11-02-kanban-design.md), cited as "kanban
§n", and the wake spec, [`2026-11-19-wake-design.md`](2026-11-19-wake-design.md), cited as "wake
§n". It amends two of their rules, each said where it is changed: kanban §9.2's "Only a person's
run has a card: a press on one for an agent's run is refused" (§8.1), and kanban §7.1's "card
output is discarded", which stays true of the run's session and gains a card of the board's own
beside it (§11). Elsewhere, where this document and they disagree, they win and this document is a
bug. As in them, every rule that looks arbitrary states the mechanism that forces it, so that it
is not "simplified" away later.

---

## 0. The thesis

> **A progress card is a projection of the run's session log, drawn by a loop that reads it.**

A run's session already records every tool call, its state and every chunk of text the agent
says (kanban §3, §8.3); `/kanban task show` and a retry's prompt read them there. Nothing has to be
told when a tool starts or the agent speaks: a loop, `ProgressCards`, looks every 3 s at the open
runs a chat follows, reads each one's new session events, and redraws its card when what it shows
has changed. It is the notifier's shape (kanban §9.4) and the unblock redraw's (kanban §9.2,
amended), with a table of its own for what each card is and how far it has been drawn.

Approach B of the approved design: a loop over the session log, not a hook in the run's session.
The run's session goes on posting into the sink, which discards its reply cards (§11); the
progress card is an ordinary board card, sent with `sendCard` and redrawn with `updateCard`,
because what it shows is replaced, not appended: the tail of the text moves, a tool's state
changes, the time goes up.

---

## 1. Boundaries

**In:** `kanban.progress` (§3); `kanban_progress_cards`, migration `014_progress_cards.sql`
(§4); the reads of a run's session and its end (§5); the card (§6); the loop (§7); the Stop
button, its press and the board's check of its run (§8); errors (§9); restarts and the switch
(§10).

**Out, each with the seam that keeps it cheap later:**

| Deferred | Seam |
|---|---|
| A card for a person's run | A person's run has its own card already (kanban §9.2), with Done and Block; it has no session to read |
| A card for a cron fire | A fire is not a board run and has no subscription; its result is posted (cron §5.6). `ProgressCards` reads a run's session by `kanban_runs.session_id`; a fire's would be a second source |
| A card in a chat that does not follow the task | A card goes where the task's first subscription of this bot is (§2), as an approval card does (kanban §7.1); another place is another target |
| Buttons beyond Stop (nudge, comment) | The press is the board card's dispatch (kanban §9.2); another verb is one more case in `KanbanChat.card` |
| Showing the agent's plan or thoughts | `renderCard` leaves them out as noise at chat width (channel §4.5), and so does this card; the reader in §5.2 sees them and passes over them |
| A summary or reason on the final card | The notice that follows says those (kanban §9.4); the final card says only the outcome and the time (§6.6) |

---

## 2. Which runs get a card

A run gets a card when all of these hold, checked at each round (§7.2):

1. **`kanban.progress.enabled` is true**, and `kanban.enabled` too. With it off there is no loop
   and nothing changes (§10).
2. **It is an agent run**: `assignee_kind = 'role'`. A person's claim gets no card: it has its own
   (kanban §9.2), and no session.
3. **It is open and undecided**: `ended_at IS NULL AND outcome IS NULL`. A run that reported
   within `min_seconds` and is still tidying up has said what it did; its notice is on its way.
4. **It has run `min_seconds`**: `now - started_at >= min_seconds × 1000`, `started_at` being the
   claim (kanban §3.3). A run that ends sooner gets no card: its notice says enough.
5. **A chat follows its task**: the task's first subscription of this bot, `subscriptionsOf(db,
   taskId).find((s) => s.appId === appId)`, exactly as `KanbanSink.sendApprovalCard` finds it
   (`src/kanban/sink.ts`), on a channel this gateway has. A task no chat follows gets none: a
   terminal's task with no `--chat` (kanban §22.1), or a reaction task of a chatless wake (wake
   §19.16).
6. **Its task is not held** while its "Created" reply is under way (kanban §19.4): `KanbanChat.held`,
   asked as the card poster asks it, so a card does not go to the group in the moment before the
   subscription moves to its thread.
7. **It has no row** in `kanban_progress_cards` yet: one card per run.

Every agent run that passes gets one: a work run, a review run by a reviewer role, a rework, a
retry, a reaction task's run (wake §19.3). Each retry is a new run (kanban §8.3), so it gets a new
card, below its predecessor's, once it has run `min_seconds`.

**Where it goes.** The subscription's conversation, as the approval card goes there (kanban
§19.7): `{ chatId: sub.conversationId, threadId: sub.threadId }`, and `root: sub.rootMessageId`
when the subscription is in a thread with a root, so the send replies to the root in the thread.
A task at chat scope (a direct message, a task from before threads) gets its card in that chat, as
its notices go there. The target does not set `stayInThread`, as neither the approval card's nor
a notice's does: a card whose thread's root was withdrawn goes to the chat by the adapter's
fallback, where the notices go too.

---

## 3. Configuration, and the startup line

```yaml
kanban:
  progress:
    enabled: false     # default false; true: a live card for each agent run a chat follows
    min_seconds: 30    # a run gets its card once it has run this long; default 30, 0 to 3600
```

- **A subsection of `kanban:`**, snake case and file only, as `kanban.wake` is (wake §11):
  `progress` joins `kanban`'s keys in `parseFile`'s `reject`, and its own keys are checked the same
  way, an unknown one refused, `min_seconds` a whole number from 0 to 3,600, else `ConfigError`:
  "`kanban.progress.min_seconds must be from 0 to 3600, got 5000`". `KanbanSettings` gains
  `progress: { enabled: boolean; minSeconds: number }`, `PROGRESS_DEFAULTS = { enabled: false,
  minSeconds: 30 }`. `TeamSettings` does not: nothing at a terminal reads it.
- **Off by default.** It adds a message per long run to every thread that follows one, and an
  update every few seconds; an operator turns it on.
- **The startup line**, after the board's and the wakes': `kanban: progress cards on, for agent
  runs past 30 s`; or, with it off and rows still `open`, `kanban: progress cards off
  (kanban.progress.enabled is false); 2 card(s) left as they were`; and nothing when off with none.

---

## 4. Schema (migration `014_progress_cards.sql`)

### 4.1 `kanban_progress_cards`

```sql
-- manus-team migration 014: the progress card of a board run
-- See docs/specs/2026-11-24-progress-cards-design.md.
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
  try_number  INTEGER NOT NULL,                    -- "run N of M": N (§5.4)
  try_limit   INTEGER NOT NULL,                    -- and M
  opened_at   INTEGER NOT NULL                     -- unix ms the run was found due: the insert
) STRICT;

CREATE INDEX idx_kanban_progress_cards_open ON kanban_progress_cards(app_id) WHERE state = 'open';

UPDATE schema_version SET version = 14;
```

- **`state`.** `open` from the insert until the card is drawn final (`final`), or until it is let
  go of (`let_go`): never sent after ten refusals, its card or chat gone, its run ended before its
  first send landed, or a final draw refused ten times (§9). Only `open` rows are read by the
  loop.
- **A row before its send.** The row is written when the run is found due, before the first send,
  so the send's refusals are counted across a restart, and the run is not found due again.
- **`read_seq` and `drawn_at`** are written together, only when a draw lands: the first send, an
  update, the final one. `read_seq` lets a round pass over a card cheaply: a card whose session's
  `last_seq` is not past it, whose shown minute (§6.1) has not moved since `drawn_at`, and whose
  run has not changed state is not read or rendered (§7.2).
- **`try_number` and `try_limit`** are fixed at the insert, because the task's
  `consecutive_failures` moves at the run's own end, and the final draw must say the same "run N
  of M" as the live one (§5.4).
- **The foreign key** is to a table made in `003`, as `kanban_runs` rows are never deleted. No row
  is deleted either.
- **No event.** Like a subscription's cursor (kanban §9.4) and the unblock buttons' record, the
  card's record writes no `kanban_events` row: one would be a board change with nothing changed on
  the board.

### 4.2 The writers, and WRITERS.md

`db/kanban.ts` is the only writer, through `KanbanService`, as for every `kanban_` table:

| Writer | Writes |
|---|---|
| `openProgressCard(row)` | the insert, `state = 'open'`, `INSERT OR IGNORE` on the run, so a round that races a restart's adds nothing |
| `progressCardSent(runId, messageId, readSeq, at)` | `message_id`, once, while null, with `read_seq`, `drawn_at`, `failures = 0` |
| `progressCardDrawn(runId, readSeq, at)` | `read_seq`, `drawn_at`, `failures = 0`, on an `open` row with a message |
| `progressCardRefused(runId)` | `failures + 1` on an `open` row; answers the new count |
| `progressCardFinal(runId, readSeq, at)` | `state = 'final'` with `read_seq` and `drawn_at`, on an `open` row |
| `progressCardLetGo(runId)` | `state = 'let_go'`, on an `open` row |

Each is one statement in its own transaction, and each changes nothing on a row not in the state
it names, so a press's redraw and the loop's can never move a `final` row back. WRITERS.md gains
the row:

> | `kanban_progress_cards` | `db/kanban.ts` | Added by `openProgressCard` (migration 014), one row a run, when the progress loop finds an agent run due a card (progress cards spec §2), before its first send. `message_id` is written once, by `progressCardSent`. `read_seq` and `drawn_at` are written together, by `progressCardSent`, `progressCardDrawn` and `progressCardFinal`, only when a draw has landed. `failures` is added to by `progressCardRefused` and reset to 0 by a landed draw. `state` moves from `open` once, to `final` by `progressCardFinal` or to `let_go` by `progressCardLetGo`, each only on an `open` row. Writes no event. Never deleted. Only the gateway writes it, through `KanbanService`. |

---

## 5. Reading the run

### 5.1 Where a run's tool calls and text are

A run's session is `kanban_runs.session_id`, set once its session is made (kanban §7.1); null for
a run still starting. Its events are in `events`, by `(session_id, seq)`, read with
`readEvents(db, sessionId, afterSeq, throughSeq)` and `lastSeq(db, sessionId)` from
`src/db/events.ts`, the renderer's read path. The kinds the card uses, as `renderCard`
(`src/channel/render.ts`) and `session-log.ts` read them:

| Event | Payload | What the card takes |
|---|---|---|
| `tool_call` | `toolCallId`, `title`, `status` | a tool, titled, with its state |
| `tool_call_update` | `toolCallId`, `status`, maybe `title` | the tool's new state; an update for a call never seen gets a line of its own, as in `renderCard` |
| `agent_message_chunk` | `text` | the agent's text, joined, a blank line where a tool came between |
| `turn_submitted` | | a new turn: the task prompt, a nudge, a forwarded comment (kanban §7.5). The text starts again; the tools do not |
| `approval_requested`, `approval_resolved` | `approvalId` | whether an approval is waiting (§6.4) |
| `agent_error`, `turn_ended` | | nothing on the live card: the run's end is read from the board (§5.3) |

Each payload was masked value by value when it was stored (`storedPayload`, kanban §10.1), and
the joined text is masked again as a whole (§6.3).

**The tools are the run's, not the turn's.** `renderCard` resets at each `turn_submitted`, as a
reply card is the answer to one prompt; a run's card is the whole run, so a nudge's turn adds to
the tool line rather than clearing it. The text is the latest turn's, as the agent's latest words
are what a reader looks for.

### 5.2 Read incrementally

The loop keeps, in memory, one `RunProgress` for each open card it is drawing: the tools by
`toolCallId` in the order first heard of, each with its title and state; the latest turn's text,
its last 8,000 code points only; the approvals open; and `throughSeq`, the last event folded in.

- **The first round that draws a card** in this process folds the session from seq 0. A run's
  session holds one run, so this is bounded by the run itself.
- **Each round after** reads only `readEvents(db, sessionId, throughSeq, lastSeq(db, sessionId))`,
  at most 5,000 events a card a round, folding them in; a run that wrote more is caught up over the
  next rounds, as the notifier reads at most 100 events a subscription a round (kanban §9.4).
- **The 8,000 code points** keep the text the tail is cut from (§6.3) far longer than the tail, so
  a known secret that the cut would split is still whole in what is masked, unless it is itself
  longer than 7,400 characters.
- **Forgotten** once the card is `final` or let go of. Memory only: after a restart every card's
  run is closed (§10), and its final draw folds the session once more from seq 0.

`session-log.ts`'s `toolCallsOf` reads the whole log each time it is asked, which suits a run's end
and a retry's prompt; the card's reader is a fold of its own, `foldProgress(progress, events)`, in
`src/kanban/progress.ts`, sharing `toolCallsOf`'s rule for an update with no call (titled by its id,
as `renderCard` does, since a card shows it; `toolCallsOf` titles it `tool`, for `readOnlyTools`).

### 5.3 How the loop learns a run's end, and its outcome word

**From the board, not the session.** Each round reads each open card's run with `getRun`. The run
has **ended** when `ended_at` is set: it is closed, its session's last turn over (kanban §3.3).
That is the moment the card is drawn final, not the moment the run is decided: after a report the
agent may go on tidying up for a while (kanban §3.3), and the card goes on showing its tools until
it stops. The total time is `ended_at - started_at`.

The outcome word is read from `kanban_runs.outcome`, and, for a counted failure, from the run's
`run_ended` event, which says what came next (`next`, `blockKind`, kanban §9.4), read by a new
`runEndedOf(db, taskId, runId)` in `src/db/kanban-read.ts` through the events' `(task_id, id)`
index, as `cardsDue` reads a run's events:

| Outcome | The final line's mark and word |
|---|---|
| `completed` | `✓ completed` |
| `review_requested` | `✓ sent for review` |
| `changes_requested` (a review run's) | `✓ changes requested` |
| `blocked` | `⏸ blocked` |
| `terminal_provider` | `⏸ blocked`: it blocks the task as `capability` (kanban §8.1) |
| `failed`, `crashed`, `timed_out`, `protocol_violation` | `✗ gave up` when its `run_ended` has `next: 'blocked'` and `blockKind: 'gave_up'`; `✗ failed` otherwise, retried or blocked for a person to look first (kanban §8.3) |
| `rate_limited` | `✗ throttled`: it waits out a cooldown, and is not counted (kanban §8.2) |
| `cancelled` | `⏸ stopped` |
| `superseded` | `⏸ superseded`: reassigned, archived, or a review answered by an operator (kanban §5.1) |
| `interrupted` | `⏸ interrupted by a restart` |

**While open, but decided.** A run decided `cancelled` and not yet closed is a stop under way: the
live card says `⏸ stopping, asked by <name>` in place of the Stop button (§8.3), the name read
from the run's `stopped` event's actor, by the people directory's chat name. A run decided by its
own report and still open is drawn live with no Stop button (§6.5).

### 5.4 "Run N of M"

- **M** is the number of counted failures that blocks the task: the task's `failure_limit`, else
  `kanban.failure_limit` (default 2, kanban §8.2). With the default a task gets a first run and one
  retry, so "of 2".
- **N** is this run's place among them: the task's `consecutive_failures` + 1, read when the card's
  row is written. `consecutive_failures` counts the counted failures since the last success, of
  either run kind, and only a run's end moves it; a task has at most one open run (kanban §3.3), so
  while this run is open it is the count before it. "Run 2 of 2" is the last try before the task
  gives up.
- **Not the attempt.** `kanban_runs.attempt` counts every run of the task, of both kinds, from 1,
  and never resets: a task reviewed twice and retried once is on attempt 5, which "of 2" would
  make nonsense of. So the header says the attempt too when it is not N, as `/kanban task show`
  numbers runs: `run 1 of 2 (attempt #3)`.
- **Throttled and interrupted runs** are not counted (kanban §8.2, §8.4), so the run after one has
  the same N: it is the same try, again.
- **Fixed at the row's insert** (`try_number`, `try_limit`), so the final draw, after this run's
  failure has moved `consecutive_failures`, still says what the live card said.

---

## 6. The card

Rendered by `renderProgressCard(facts)` in `src/kanban/chat-render.ts`, beside the other board
cards, as a `CardView` the adapter's `boardCard` draws (schema 2.0, `update_multi: true`, so a
redraw shows to everyone in the chat). Every piece is masked before it is reshaped, and escaped
after (kanban §9.3); the whole markdown is masked once more before each send and update, as every
card is.

### 6.1 The header

```
⚙️ **Fix the flaky login test** `k_7f3a…`
implementer · run 1 of 2 · running 4 min
```

- **The title and id**, as every board card writes them: `titleText`, one line, a person's
  `lark:<union_id>` in it shown by chat name, cut at 200 characters, escaped; the id in code.
- **The role**, `run.assignee.name`, as a label; for a review run, `<role>, reviewing`.
- **"Run N of M"** (§5.4).
- **The time running**, from `started_at` to now, in whole minutes, so that it changes once a
  minute and not at every draw: `running under a minute`, `running 4 min`, `running 1 h 12 min`.
  A change in it counts as a change (§7.2), so a run silent in one long tool call is still redrawn
  about once a minute, and its card does not look stuck.

### 6.2 The tool line

Each tool call of the run, with its state, as on a chat reply card: render.ts's `toolSummary`,
exported for this with its `ToolLine` type, unchanged. Calls of one tool with one state are
counted, "✅ Read ×4", the groups in the order they first came, each state its icon: ✅ completed,
❌ failed, ⏳ in progress, • pending or anything else.

- **At most 1,500 characters.** A long run's line is cut from its start, so the latest tools stay:
  whole groups are dropped from the front until it fits, and the line starts `… 37 earlier ·`.
  A single group longer than the limit is cut with `…`, as render.ts cuts its own line.
- **None yet**: `_Starting…_` while the run has no session or no event, `_Working…_` once it has
  events but no tool.

### 6.3 The agent's latest text

The latest turn's text (§5.1), masked whole first (`redactKnownSecrets(withholdSecretPrefix(
stripControl(text)))`, as render.ts masks a reply), then its last 600 characters, cut forward to the
start of a whole line: the cut falls on the first line break inside the last 600 characters, so
the tail begins at a line's start. A last line longer than 600 characters has no break to cut at,
and is cut at a character, never inside a surrogate pair. Below its cut it is set off as quoted
lines, as `task show` quotes a run's output (`tail` in chat-render.ts): `… (earlier output cut)`
above it when anything was cut. No text yet: nothing, not an empty quote.

### 6.4 The status lines

Under the text, while the run is open:

- **An approval waiting**, for a supervised role: `_Waiting for an approval: see the card in this
  chat._` while the session has an `approval_requested` with no `approval_resolved`. The approval
  card is forwarded to the same conversation (kanban §7.1), so it is below this card.
- **Stopping**: `⏸ stopping, asked by <name>`, once the run is decided `cancelled` and still open
  (§5.3, §8.3), in place of the button.
- **Reported**: `_Reported <outcome>; finishing._`, once the run is decided by its own report and
  still open, in place of the button (§6.5): the agent is tidying up, and Stop would no longer stop
  the task.

### 6.5 The Stop button

One button, `Stop`, style `danger`, no box, while the run is open and undecided. Its value is a
board card's (kanban §9.2), with `act: 'stop'` and the run:

```ts
{ kind: 'kanban', act: 'stop', task: run.taskId, run: run.runId, nonce: boardCardNonce(appId, run.taskId, run.runId) }
```

The nonce is the one a person's card for the same run would carry; no agent run has a person's
card, and the verb tells the two apart. There is no `try` field: a Stop press is never refused in
a way the card could be pressed again for (§8.4).

### 6.6 The final redraw

Once the run has ended (§5.3), the card is drawn once more, with no button:

```
⚙️ **Fix the flaky login test** `k_7f3a…`
implementer · run 1 of 2
✓ completed after 14 min 3 s
✅ Read ×12 · ✅ Edit ×3 · ❌ Bash · ✅ Bash ×2
```

- **The header**, without "running".
- **The final line**: the mark and word of §5.3, then `after` and the total time to the second
  below an hour, `after 47 s`, `after 14 min 3 s`, and to the minute above, `after 1 h 12 min`.
- **The tool line**, as it last stood: what the run did.
- **No text, no summary, no reason**: the notice that follows says those (kanban §9.4); the tail
  of what the agent said last is often the start of its summary, cut.
- **Unchanged:** the notice, the Unblock button under it, wake (wake §5), and the agent-first hold
  of a block's button (wake §5.9). None of them reads the progress card or waits for it.

### 6.7 Size

The tail at most 600 characters, the tool line at most 1,500, the header about 300, the status
line about 150: under 3,000 characters with the markup, far under Lark's 30 KB of card and
cardkit's 30,000 characters an element (render.ts's note).

---

## 7. The loop

### 7.1 One owner, a round every 3 s

`ProgressCards` in `src/kanban/progress.ts`, built when `kanban.enabled` and
`kanban.progress.enabled` are both set, started after the channel is connected (§13). Every
`PROGRESS_POLL_MS = 3_000` it runs a round, one at a time: a round under way is returned to the
next tick, never run twice at once, as the notifier's `deliver` is. Never rejects: a round's
failure is noted, and the next round tries again. The board is written from chat, the worker
socket, the dispatcher and the terminal, so, as the notifier and the unblock redraw do, it looks
rather than being told.

### 7.2 A round

1. **New cards.** For each run due a card (§2), oldest `started_at` first, read by a new
   `progressDue(db, appId, now - minSeconds × 1000)` in `kanban-read.ts`: open undecided role runs
   started by then with no `kanban_progress_cards` row, whose task has a subscription of this bot.
   Each is given its row (`openProgressCard`), `try_number` and `try_limit` read then, `opened_at`
   now. A run whose subscription is on a channel this gateway has not got is passed over, said once
   a boot for each channel: `kanban: progress cards cannot go to channel <id>, which this gateway has
   not got`.
2. **What is due.** Every `open` row of this bot (`openProgressCards`), with its run:
   - **No message yet**: a **send** is due, unless the row is held back after a failure (§9); its
     run ended before the send: the row is let go of, quietly (§9).
   - **A message, and the run has ended**: a **final** draw is due.
   - **A message, and the run open**: an **update** is due when the card was last drawn at least
     `PROGRESS_PACE_MS = 5_000` ago, its failures are under ten (§9), and what it would show
     differs from what it last drew. The cheap check first: nothing has changed when the session's
     `last_seq` is not past `read_seq`, the shown minute is the one shown at `drawn_at`, and the run
     is in the state drawn last (undecided, stopping or reported); only otherwise is the session
     folded (§5.2) and the card rendered, and compared with the markdown last drawn, kept in memory.
3. **The longest waiting first.** The due sends, finals and updates are ordered by how long each
   has waited: a send since `opened_at`, a final or an update since `drawn_at`. At most
   `ROUND_DRAWS = 10` are made a round, one at a time; the rest wait for the next round. A restart
   that finds many cards to finish therefore spreads them over rounds.
4. **Each is made** with the newest render, read when its turn comes: never a view a round read
   before an earlier draw's await.

### 7.3 One draw at a time a card

A card's draws, the loop's and a press's (§8.3), go one after another, as the unblock redraw
chains a message's (`UnblockRedraws.#chains`): each waits for the one before it and reads the
board and the session only when its turn comes, so an older view never lands after a newer one. The
loop passes over a card with a draw under way.

### 7.4 Bounded

A send is waited for at most `CARD_SEND_MS` (30 s), as a person's card's is; an update and a
final at most `REDRAW_MS` (10 s), as every board card's redraw is: the SDK's card update has no
timeout of its own. Past its bound a draw counts as failed but not refused (§9). A send carries
one uuid for the run, `progressCardUuid(appId, runId)` in `src/core/ids.ts`, of its own purpose
beside `boardCardUuid`'s, so a send that timed out and landed, sent again within Lark's hour, is
one card.

---

## 8. Stop

### 8.1 The press

The router dispatches a press on `kind: 'kanban'` to `KanbanChat.card` (kanban §9.2), unchanged.
There, after the payload, the nonce, talk tier and the presser's `union_id`, as for every board
button, `act: 'stop'` is taken before the person-card path, which refuses an agent's run:

1. **Operate tier, live**: `hasTier(presser, 'operate')`, which reads the grants as they are now
   (tier grants spec). Without it: `Stop changes the board, and needs operator permission.`, the
   card unchanged.
2. **The run**: the card's `run` must be a run of the card's task, and an agent's: otherwise
   `That button is not for a run of this task.` or `That button is not for an agent's run.`
3. **Ended** (`ended_at` set): a stale press (§8.4).
4. **Decided `cancelled`, still open**: a repeated press (§8.4).
5. **Otherwise** the stop (§8.2), and the redraw (§8.3).

As for every board button, the answer is the board's, noted in the log; nothing is posted in the
chat (kanban §9.2). This amends kanban §9.2's "Only a person's run has a card: a press on one for
an agent's run is refused": an agent's run has a progress card, whose only button is Stop.

### 8.2 The effect

The same as `/kanban task stop <task>` typed by the presser (kanban §9.1): `service.stop(taskId,
by, { runId })`, then `#decided(run)`, which has the dispatcher cancel the run's turn, and
`#changed()`. The run is decided `cancelled`, the task blocks as `needs_input`, "stopped by
<name>", with a `stopped` event whose actor is the presser; its notice names them (kanban §9.4).
A stop never wakes an agent (wake §2.3).

**The run is checked inside the board's transaction.** `board.stop` stops the task's open run,
whichever it is; a press is for one run. So `stop` gains an optional `runId`: given, and the task's
open run is not that run, it refuses `run_superseded` and changes nothing, as a card's report is
bound to its run (kanban §9.2). Without the check, a press on a card whose run ended a moment
before, and whose retry has just opened, would stop the retry. Chat's typed `stop` passes none,
and is unchanged.

A run decided by its own report and still open has no Stop button (§6.5); one pressed on a card
drawn before the report lands is the stop of a decided run, as a typed one is: the board answers
that it had already reported, keeps the outcome, and closes the run's turn.

### 8.3 The card, at once

Once the stop is written, the card is redrawn through the loop's chain (§7.3), at once, outside
the 5 s pace and the round's ten: `ProgressCards.redrawNow(runId)`, in the background, bounded by
`REDRAW_MS`, as a press's redraw is, so the callback is answered within Lark's three seconds. The
redraw reads the board as it is: the run decided `cancelled` and open, so the card says `⏸
stopping, asked by <name>`, by the chat name of the `stopped` event's actor, two of one name told
apart (kanban §9.3), with no button. When the turn has ended and the run closes, the loop draws it
final, `⏸ stopped after 6 min 12 s`.

A stop typed in chat, at the terminal or by `mt` is found by the loop's next round, as any change
is (§7.2): the card says the same, within a round and the pace.

### 8.4 Stale and repeated presses

- **Stale**: a press on a card whose run has ended, the stop not made: the card is redrawn final,
  as §6.6, with one more line under the final line, `This run has ended.`, through the chain, at
  once, whatever the row's state, even `final`, as the press says the card may not show it yet.
  The answer: `That run has ended: /kanban task show <task> says where the task is.`
- **Repeated**: a press on a run already decided `cancelled` and still open does nothing more: no
  stop, no redraw. The answer: `That run is being stopped already.` The same person's second press
  of the same button never reaches the gateway: the SDK drops it for twelve hours (kanban §9.2).
- **With progress cards off**, a Stop pressed on a card left from before (§10) still stops, as the
  board command it is; nothing redraws the card.

---

## 9. Errors

**The first send.** Sent each round it is due, with the run's one uuid.

- **A refusal** (a `ChannelError` with a nonzero code) adds one to `failures`, and the row is held
  back for a pause that doubles from 2 s to five minutes, in memory, as the card poster's is. At the
  tenth refusal the run has no card: the row is let go of, and one line says so: `kanban: the
  progress card of run <run> was refused 10 times (<why>); the run goes without one`. With the
  pauses, that is about 13 minutes after the first.
- **A failure that never reached Lark**, code 0, or a send past `CARD_SEND_MS`, is the gateway's
  outage, not the card's, as for notices (kanban §9.4): held at the same doubling pause, never
  counted, so an hour without Lark does not lose every card in flight.
- **Unreachable**: Lark's 230002, the bot not in the chat (`UNREACHABLE_CODES`), lets the row go at
  once, with one line: `kanban: the progress card of run <run> cannot reach <chat> (<why>); the run
  goes without one`.
- **Its run ended** before a send landed: the row is let go of with no line. It may leave one card
  behind, live-looking, from a send that timed out and landed (§16).
- **Sent, and not recorded** (`progressCardSent` refused or thrown): said once, `kanban: the progress
  card of run <run> was sent as <message>, and not recorded (<why>)`, and the message id kept in
  memory so the card is still updated and drawn final this boot. A restart finds the row without
  it and its run closed by the boot, so the row is let go of, and the card stays as it last landed
  (§16).

**An update.** A failed update is not retried: the next due update replaces it, with the newest
view, after the pace.

- **A refusal** adds one to `failures`; a landed draw sets it back to 0. At the tenth in a row the
  card is left as it last landed: no more updates, and one line, `kanban: the progress card of run
  <run> (message <message>) was refused 10 updates in a row (<why>); it is left as it is, and drawn
  final if Lark takes it`. The row stays `open`, `failures` at ten, so the loop passes over it until
  the run ends, and then tries the final draw.
- **A failure that never reached Lark**, or an update past `REDRAW_MS`, is not counted, as above;
  the next update, after the pace, tries again.
- **A lost card or chat**: an update refused with one of `CARD_GONE_CODES` (230011 the message
  withdrawn, 200750, 200740, 300311, `src/channel/types.ts`) or with 230002 lets the row go at once,
  with one line, `kanban: the progress card of run <run> (message <message>) is gone (<why>); letting
  it go`. Nothing is sent in its place.

**The final draw** is an update like the others: tried each round from the run's end, at the pace,
until it lands (`final`) or is refused ten times in a row, counting any refusals before it, when
the row is let go of, said once. A row already at ten when its run ends gets one try.

**Every log line** names ids and codes only, never task text or agent output; an error from Lark is
masked before it is logged, as every error is.

---

## 10. Restarts, and turning it on and off

- **A restart.** Open rows carry on from the table. The boot closes every open agent run before
  the loop starts (kanban §8.4; `Dispatcher.boot`, run in `start()` before the channel connects), so
  every `open` row the first round finds has its run ended, and is drawn final: a run the restart
  interrupted is `interrupted`, `⏸ interrupted by a restart after 12 min`; one that had reported and
  was tidying keeps its outcome, `✓ completed after 9 min`. Recognised by the run's outcome alone:
  only the dispatcher's `#interrupt` writes `interrupted`, at boot or when an open run's session
  lost its environment to a restart (`envFor`). The retried run is a new run, which gets its own
  card past `min_seconds`. A row with no message, its send cut off by the stop, is let go of, as its
  run has ended.
- **The stop.** The loop stops with the others, and a draw under way finishes within the drain
  while the channel is connected (§13); no card is drawn final at a stop, since its run is not
  over: the next boot draws it.
- **Turning it on later** opens cards only for runs open and undecided then (§2). Rows left `open`
  by an earlier time it was on are drawn final at the first round, as after any restart: turning it
  on needs a restart, which closed their runs. A card older than Lark lets be updated is refused
  and let go of (§9).
- **Turning it off** leaves every card as it is: no loop, so no final draw. Their Stop buttons
  still stop (§8.4). The startup line says how many were left (§3).

---

## 11. The run's session and its reply-card writer

The run's session posts through `KanbanSink`, as today (kanban §7.1): `openCard` returns a
`DiscardedCard`, whose `set` and `finish` do nothing, and the session's card writer runs over it as
over any card, its cursor, retries and fallbacks unchanged. The progress card does not go through
it, and the sink is not changed:

- **The writer is per turn.** It opens a card per turn, and a run's session has a turn per nudge or
  forwarded comment (kanban §7.5); a card from the writer would be a new message at each, where a
  run has one card.
- **The reply card appends.** Its answer element streams, typed in from the start (channel §4.5); the
  progress card's tail is replaced, its time and states rewritten, which a streaming element would
  retype from the beginning at each draw.
- **The sink is shared.** A cron fire's session binds a sink of its own (cron §5.2); a writer
  pointed at Lark from inside the sink would need to know which is which.
- **Approval forwarding is unchanged.** A supervised run's approval card still goes to the task's
  first subscription (kanban §7.1), so it lands in the same thread, below the progress card, which
  says it is waiting (§6.4).

So kanban §7.1's "card output is discarded" stays true of the run's session; the board now draws a
card of its own beside it, from the log the session keeps.

---

## 12. The cases

- **A run that ends within `min_seconds`**: no card; its notice, as today.
- **A run past `min_seconds`** in a task's thread: one card in the thread, redrawn as tools run, at
  most once every 5 s; at its end, drawn final, and the notice below it.
- **A run that reports and keeps going**: the card says `_Reported completed; finishing._`, its
  Stop gone, its tools still updating; final, `✓ completed`, once the turn ends.
- **A run quiet in one long tool call**: redrawn once a minute, for its time.
- **A retry after a failure**: the failed run's card final, `✗ failed after 8 min`, the notice
  "Retrying…", and the retry's own card once it has run `min_seconds`, `run 2 of 2`.
- **The last try fails**: `✗ gave up after 7 min`, and the "Gave up" notice with its Unblock.
- **A throttled run**: `✗ throttled`, and the next run after the cooldown says the same N.
- **A review run by a role**: `reviewer, reviewing · run 1 of 2`.
- **A supervised run waiting for an approval**: the waiting line, the approval card below it.
- **An operator presses Stop**: `⏸ stopping, asked by Alice` at once, then `⏸ stopped after 6 min`,
  and the "stopped by Alice" notice with Unblock.
- **A talk-tier person presses Stop**: nothing changes; the log has "Stop changes the board, and
  needs operator permission."
- **Stop pressed twice by two operators**: the second does nothing more.
- **Stop pressed on a card whose run just ended, with its retry open**: the board refuses the stop
  for the retry (§8.2), and the card is drawn final with "This run has ended."
- **`/kanban task stop` typed**: the card says stopping within a round.
- **The task reassigned or archived mid-run**: `⏸ superseded`.
- **A restart mid-run**: `⏸ interrupted by a restart after 12 min`; the retry's new card.
- **The card withdrawn by someone in the chat**: the next update is refused as gone; let go.
- **The bot removed from the group**: 230002; let go. The notices let the chat go too (kanban §9.4).
- **A task at chat scope or in a direct message**: its card in that chat.
- **A task no chat follows**, a person's run, a cron fire: no card.
- **Two runs at once in one thread** (a task and its follow-up): two cards, each its own.
- **Lark down for an hour**: sends and updates held, not counted; afterwards the cards catch up.

---

## 13. Wiring

- **`schema/014_progress_cards.sql`** (§4.1). The migration test checks the table, its check and its
  index.
- **`src/db/kanban.ts`**: the six writers of §4.2; `stop` gains `runId?`, refusing `run_superseded`
  inside its transaction (§8.2). **`src/db/kanban-read.ts`**: `progressDue`, `openProgressCards`,
  `runEndedOf`, and the `stopped` event of a run for the stopping line. **`src/db/WRITERS.md`**: the
  row of §4.2.
- **`src/kanban/service.ts`**: the writers, as `KanbanService` methods, each refusing a bad id or
  message id `invalid`, as `buttonSent` does; `stop(taskId, by, opts?: { runId?: string })`.
- **`src/kanban/progress.ts`** (new): `ProgressCards`, with `start()`, `stop()`, `idle(boundMs)`,
  `round()`, `redrawNow(runId)` and `redrawEnded(messageId, runId)`; `foldProgress`; the constants
  `PROGRESS_POLL_MS`, `PROGRESS_PACE_MS`, `ROUND_DRAWS`, `REFUSALS_LIMIT = 10`, `TAIL_CHARS = 600`,
  `TOOLS_CHARS = 1_500`. Its deps: `db`, `service`, `channels` (by a subscription's channel id, as the
  notifier's), `appId`, `minSeconds`, `failureLimit` (`kanban.failure_limit`), `nameOf` (the people
  directory's chat name), `held` (`KanbanChat.held`), `clock`, `note`, `sendTimeoutMs`,
  `redrawTimeoutMs`.
- **`src/kanban/chat-render.ts`**: `renderProgressCard`, its final form and the stale press's line.
  **`src/channel/render.ts`**: `toolSummary` and `ToolLine` exported, unchanged.
  **`src/core/ids.ts`**: `progressCardUuid(appId, runId)`.
- **`src/kanban/chat.ts`**: `card()` takes `act: 'stop'` (§8.1); `KanbanChatDeps` gains `progress?:
  { redrawNow(runId: string): Promise<void>; redrawEnded(messageId: string, runId: string):
  Promise<void> }`, whose redraws are tracked in `#pending`, so `idle()` waits for them.
- **`src/config.ts`**: `kanban.progress` (§3), its defaults, its keys in `reject`, and its range.
- **`src/index.ts`**: built inside `if (config.kanban.enabled)`, after `KanbanChat`, when
  `config.kanban.progress.enabled`; passed to `KanbanChat` as `progress`; the startup line of §3.
  **Start**: `progress?.start()` after `cards?.start()`, so after `dispatcher.boot()`, which has closed
  the runs a restart killed, and after `adapter.connect()`; before `dispatcher.start()`, so the first
  round finishes the old cards before new runs begin. **Stop**, the order of the other loops:
  `progress?.stop()` after `cards?.stop()`, before `kanbanChat?.stop()` and `inbound.stop()`; then
  `progress?.idle(SHUTDOWN_DRAIN_MS)` in the one drain with the notifier, the cards, the presses and
  the unblock redraw, before `adapter.disconnect()`, with, if it was not drained, `kanban: stopped with
  a progress card still being drawn; the next boot draws it final`; then the registry's
  `closeAll()`, and the database's close, as today.
- **The router, the sink, the notifier, the waker and the card poster** are unchanged.
- **Docs**: the README's configuration section and the guide's board chapter gain `kanban.progress`
  and the Stop button.

---

## 14. Testing

- **Unit, the loop, on a fake clock with the fake channel** (`tests/helpers/channel.ts`, whose
  sends and updates can be gated, answered or failed), over a database with runs and session events
  written through the real writers:
  - which runs: an agent run past `min_seconds` gets one card, one at 29 s none; a person's run, a
    task with no subscription of this bot, one on a channel not configured (its line once), a held
    task, and a run decided before `min_seconds` none; a second round adds no second row;
  - where: in the thread with its root, at chat scope in the chat, with the run's uuid;
  - what it shows: the header with "run 1 of 2", "run 2 of 2" after a counted failure, the same N
    after a throttle, the attempt when it differs, the role and "reviewing"; the time in whole
    minutes; the tool line from `tool_call` and `tool_call_update`, grouped, an update with no call,
    a nudge's turn adding to it, the line over 1,500 cut from the front; the tail at 600 at a whole
    line, a long last line cut at a character, masked whole before the cut, a secret split across
    two chunks masked, nothing when there is no text; the approval line; the Stop button's value and
    nonce; no button once reported or stopping;
  - incremental reads: the first draw folds from seq 0, later rounds only past `throughSeq`, at most
    5,000 a round;
  - pace and caps: no update within 5 s of the last, no update when nothing shown changed, an update
    when the minute moves; at most ten draws a round, the longest waiting first, sends and updates
    together; a card's draws one at a time, a press's waiting for the loop's;
  - the end: each outcome's mark and word of §5.3, gave up from a `run_ended` that blocks as
    `gave_up`, the total time, no text and no button; a decided open run drawn live until closed;
  - errors: a refused send held back 2 s, 4 s, … five minutes, counted, let go at ten with its line
    once; a code-0 failure and a timeout held and not counted; 230002 let go at once; a send whose
    record fails, updated this boot; an update refused nine times then landing, `failures` back to 0;
    ten in a row, left, its line once, the final still tried and landing; `CARD_GONE_CODES` and
    230002 on an update let go; a final refused ten times let go; a row with no message whose run
    ended let go with no line;
  - the restart: `open` rows with runs closed by the boot drawn final, `interrupted` as "interrupted
    by a restart", a reported one with its outcome; the retry's new card;
  - the switch: off, no loop and the startup line's count; on again, the old rows drawn final.
- **Unit, the Stop press** (`KanbanChat.card`): an operator's press stops the run, blocks the task
  `needs_input` "stopped by" them, cancels the turn, and redraws "stopping, asked by <name>" at once
  within `REDRAW_MS`; operate tier read live, a grant revoked a moment before refused; talk tier
  refused with the message of §8.1 and no redraw; a bad nonce, a run of another task, a person's run
  refused; a stale press redrawn final with "This run has ended." and the board unchanged; a repeated
  press doing nothing; `board.stop` with a `runId` that is not the open run refused `run_superseded`;
  a press with progress cards off stopping with no redraw.
- **Unit, the writers and the config**: each writer changes only a row in the state it names; the
  migration; `kanban.progress` defaults, an unknown key refused, `min_seconds` out of range refused.
- **End to end, through `createGateway`** with the fake Lark channel and the fake CLI agent, as
  `tests/unblock-redraw-gateway.e2e.ts` does, `min_seconds: 0` and the clock advanced: a run past
  `min_seconds` gets one card in its task's thread; it is updated as the agent's tools run; when the
  run completes the card is drawn final, `✓ completed`, and the "Done" notice comes after the card in
  the thread; a Stop pressed through the card action handler stops the run and the task blocks; with
  `kanban.progress.enabled` false nothing is sent.

---

## 15. To be confirmed, by the smoke checklist

On the user's tenant, with the board and progress cards on:

1. **The look**: a run past 30 s gets one card in its task's thread; the header, the tool line's
   icons and the quoted tail read well on desktop and mobile, and the Stop button sits under them.
2. **The pace**: tools running update the card about every 5 s, and everyone in the group sees the
   update (`update_multi`); Lark refuses none for its rate; a quiet run's time moves once a minute.
3. **Stop**: an operator's press shows "⏸ stopping, asked by …" within a second or two, then "⏸
   stopped after …", then the notice; a talk-tier person's press changes nothing, and what Lark shows
   them is noted.
4. **A run longer than 10 minutes**: over 120 updates of one card all land; whether Lark caps the
   updates of one message, and with which code.
5. **The final card and the notice**: the final card above the notice in the thread, with the
   outcome and the time.
6. **Withdrawing the card**: the code Lark answers the next update with, which should be one of
   `CARD_GONE_CODES`, and the card let go of.
7. **A restart mid-run**: the card "interrupted by a restart", and the retry's own card.
8. **A supervised role**: the waiting line, and the approval card below the progress card.

---

## 16. Limits

- **At most one update every 5 s a card**, but for a Stop press's redraw (§8.3); **at most ten sends
  or updates a round**, the longest waiting first.
- **The tail at most 600 characters, the tool line at most 1,500**, the card far under 30 KB.
- **Everything masked**: each piece before it is cut, the whole before each send and update.
- **The time is whole minutes** while running, so a card can look the same for up to a minute.
- **A card can lag its run by up to a round and the pace**, about 8 s, and by more when ten other
  cards are due.
- **The final card and the notice are not ordered in time**: the notifier sends on its own round,
  and the final draw may land a few seconds after the notice. In the thread the card is above the
  notice, as it was sent first.
- **A send that timed out and landed, for a run that ended before any retry**, or a card sent and
  not recorded before a restart, leaves a card that
  looks live, with a Stop button that answers "This run has ended" and draws it final when pressed.
- **A card refused ten updates in a row stays as it last landed** until its final draw.
- **Turning it off leaves cards as they are**, live-looking, until pressed.
- **No card for a run shorter than `min_seconds`**, and none after ten refusals of its send.
- **A card in a chat at chat scope** adds a message to the group's timeline for each long run, as its
  notices do.

---

## 17. Departures from the approved design

- **D1. "Run N of M": N is the try within the failure limit, not the attempt.** `attempt` counts every
  run of the task, both kinds, and never resets, so "attempt of failure limit" could read "5 of 2".
  N is `consecutive_failures + 1` when the card opens, M the task's `failure_limit` or
  `kanban.failure_limit`, both fixed in the row; the attempt is added when it differs, "run 1 of 2
  (attempt #3)" (§5.4).
- **D2. More outcome words than the six named.** The design names completed, blocked, failed, gave
  up, stopped and interrupted by a restart; the board has outcomes those do not fit: `✓ sent for
  review`, `✓ changes requested`, `✗ throttled` and `⏸ superseded`, and `terminal_provider` shown
  as `⏸ blocked`, as it blocks the task (§5.3).
- **D3. "When the run ends" is when it closes.** A run is decided by its report and closed when its
  turn ends (kanban §3.3); the card is drawn final at the close, its total time `ended_at -
  started_at`, and, between the two, live with `_Reported <outcome>; finishing._` and no Stop
  button. The design gives Stop "while the run is open"; a run decided by its own report is still
  open, but a Stop there would not stop the task, only its tidying (§6.4, §6.5).
- **D4. Only Lark's refusals count toward the ten.** A failure that never reached Lark, code 0, or a
  send or update past its bound, is held at the doubling pause and not counted, as the notifier's
  rule is (kanban §9.4), so an outage does not let go of every card in flight (§9).
- **D5. The notice follows the final card in the thread, not in time.** Nothing holds the notice for
  the card: the notifier and this loop run on their own rounds, and the design leaves the notice
  unchanged. The card was sent first, so it is above the notice; its final draw may land a few
  seconds after the notice is sent (§16). The e2e test checks the place and the final view.
- **D6. A quiet run is redrawn once a minute.** "Redraw only if something changed" counts a change
  in the time shown, which is in whole minutes, so a run silent in one tool call does not look stuck,
  and the card is not redrawn every 5 s for a seconds counter (§6.1).
- **D7. No card carries on live across a restart.** The design says open cards carry on from the
  table, and a restart-interrupted run's card is drawn final; since the boot closes every open agent
  run before the loop starts (kanban §8.4), every open row is drawn final at the first round. Its
  table row is what carries on (§10).
- **D8. `stop` takes the run.** The design says a Stop press does what `/kanban task stop` does; the
  board's `stop` stops whatever run is open, so it gains an optional `runId`, refused
  `run_superseded` inside the transaction, so a press on an ended run's card never stops its retry
  (§8.2).
- **D9. A stop typed elsewhere** shows "stopping" within a round, not at once: only a press is a
  callback the card can be redrawn from at once (§8.3).

---

## 18. Decisions

Made while grounding the design in the code, each where it applies:

- **The tools are the whole run's, the text the latest turn's** (§5.1): a nudge's turn adds tools,
  and starts the text again.
- **The reader is a fold kept in memory**, rebuilt from seq 0 when a card is first drawn in a
  process, then read past `throughSeq`, at most 5,000 events a card a round (§5.2).
- **The end is read from `kanban_runs`**, `ended_at` and `outcome`, and a counted failure's
  `run_ended` for gave up or failed (§5.3); not from the session's `turn_ended`, which says nothing
  of what the board made of it.
- **A restart-interrupted run is recognised by `outcome = 'interrupted'`**, which only the
  dispatcher's `#interrupt` writes, at boot or for a session that lost its environment to a restart
  (§10).
- **The Stop press is a board card's press**, `kind: 'kanban'`, `act: 'stop'`, `run`, and the nonce
  `boardCardNonce(appId, taskId, runId)`, reaching `KanbanService.stop` through `KanbanChat.card`,
  then the dispatcher's `cancel` through `#decided` (§8).
- **The stopping line and its name come from the board**: the run decided `cancelled` while open, and
  its `stopped` event's actor, so a stop by any path draws the same card (§5.3, §8.3).
- **The shutdown order** puts the loop with the other loops: stopped after the card poster, drained in
  the one drain before the channel disconnects; started after the dispatcher's boot and the channel's
  connect, before the dispatcher's first pass (§13).
- **The reply-card writer stays discarded** (§11): the sink is unchanged, and the progress card is a
  board card the loop sends.
- **The row is written before the first send** (§4.1), so refusals count across a restart and a run
  is found due once.
- **The approval line** (§6.4) is added so a card waiting on a person does not look stuck; it says
  where the approval card is, as `renderCard` does on a reply card.
- **The final card keeps the header and the tool line, and drops the text** (§6.6): what the run did
  stays; what it said last is the notice's.
- **The tool line over its limit loses its earliest groups** (§6.2), so the card shows what the run is
  doing now.
- **`min_seconds` from 0 to 3,600** (§3); 0 opens a card at the first round of any run.

---

## 19. Open questions for the user

1. **A card at chat scope.** A task with no thread of its own, in a direct message, or created
   before threads, or followed by a terminal's `--chat` naming a group at chat scope, gets its card in
   that chat, as its notices go there (§2). In a group at chat scope that is a message in the main
   timeline for each long run. Should such tasks get a card, or only tasks whose subscription is in a
   thread?
