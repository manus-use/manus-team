# Plan P: Progress cards. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While an agent run on the board is under way, the chat that follows its task, in a thread or a direct message, gets one card that shows the run as it goes: the task, the role, which try it is and how long it has run, each tool call and its state, the tail of what the agent last said, and a **Stop** button. When the run ends the card is drawn once more, final, with its outcome and its total time. Off by default, behind `kanban.progress.enabled`.

**Architecture:** one migration, one loop.

- **The record** (`schema/014_progress_cards.sql`, `src/db/kanban.ts`, Task 1): `kanban_progress_cards` and its six writers, through `KanbanService`.
- **The reads** (`src/db/kanban-read.ts`, `src/db/events.ts`, Task 2): the runs due a card, the open cards, a run's `run_ended` and `stopped`, a chat's kind, a session's tool events, the agent's last output.
- **The setting** (`src/config.ts`, Task 3): `kanban.progress.enabled` and `min_seconds`.
- **The card** (`src/channel/render.ts`, `src/kanban/chat-render.ts`, `src/core/ids.ts`, Task 4): `toolGroups`, `renderProgressCard`, the outcome words, the times, the uuid.
- **The loop** (`src/kanban/progress.ts`, Task 5): the fold, the round, the pace and holds, the errors, the final draw and a boot-closed run's time.
- **Stop** (`src/db/kanban.ts`, `src/kanban/service.ts`, `src/kanban/chat.ts`, `src/kanban/progress.ts`, Task 6): `stop` bound to a run, the press, its redraws.
- **The wiring** (`src/index.ts`, `tests/fakes/cli-agent.mjs`, Task 7): built, started and stopped with the other loops, the startup line, end to end.
- **The documents** (`README.md`, `docs/kanban-guide.md`, Task 8).

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, better-sqlite3 11. No new dependency.

**Spec:** `docs/specs/2026-11-24-progress-cards-design.md`, as approved at `503ce49`. Below, "§n" is that spec's.

---

## Ground rules

- **Where to work.** The worktree `/Users/x/Develop/manus/prime-gateway-wt2`, branch `progress-cards`, which holds the spec and this plan. Never edit `/Users/x/Develop/manus/prime-gateway` or `/Users/x/Develop/manus/prime-gateway-work`; never start the gateway, reach Lark or the network, or touch `~/.manus-team`. Every test makes its own home in a temporary directory.
- **Commits.** One a task, test first, named files only; never `git add -A`. `node_modules` is an untracked symlink to the main checkout's and stays untracked. Plain-English messages: no trailer, no mention of Claude or AI, no Chinese text, no long dash. The letters `p`, `g`, `w` in that order must not appear in anything written. No plan letter in a word a person sees.
- **Node 22.** `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every npm or vitest command.
- **Baseline.** At `503ce49`, `npx vitest run --project unit` gives `Tests  3419 passed (3419)`, and `npx vitest run --project e2e` `Tests  183 passed (183)`. `tests/update-run.test.ts` flakes under load: run it alone, and it passes.
- **The plan follows the code.** Where a step turns out wrong while building, the plan is fixed in the same commit as the task.
- **Finding edits.** Each edit is found by its quoted text, not by line number.
- **One writer.** `src/db/kanban.ts` writes `kanban_progress_cards`, and nothing else does (§4.2).

## Decisions

Each tied to the spec.

1. **The table is read at version 14 only** (§4.1): the gateway migrates at open, and nothing at a terminal reads it, so no read needs a fallback for an older database, unlike the wake's columns.
2. **`openProgressCard` is one `INSERT OR IGNORE … SELECT`** (§4.1): N and M are read by the insert, and a run decided since the round read it gets no row.
3. **`progressDue` reads runs in SQL and their subscription in code** (§2, §7.2): `subscriptionsOf(...).find(appId)`, as the sink finds it, then the thread, `p2p`, or null `chat_type` filter; the loop filters the nulls through `chatKindOf`.
4. **The fold is the loop's, the reader is `readEvents`** (§5.2): a whole fold through `readEvents(db, s, throughSeq, min(lastSeq, throughSeq + 5000))`, a final's through a new `readEventsOfTypes` over `idx_events_type`; each read moves `throughSeq` to its bound.
5. **The card is rendered in `chat-render.ts`**, beside the other board cards, with its `label`, `titleText`, `quoted` and `masked`; the loop masks the whole markdown once more before each send and update (§6.8).
6. **`toolSummary` becomes `toolGroups(...).join(' · ')`** (§6.2), so a reply card is drawn byte for byte as before.
7. **Pressing is `ProgressCards`'s, judging is `KanbanChat`'s** (§8): chat checks the tier, the run and the board, and asks the loop for one of three redraws through closures: `redrawNow(runId)` after a stop, `redrawEnded(messageId, runId)` for a stale press, `refusedTier(messageId, runId)` for a tier refusal, which bumps the run's `try`. The spec's §13 names the first two; the third is the tier refusal's redraw of §8.1, put beside them.
8. **The loop's memory** is one `Live` a run: its fold, the markdown, state and `try` last drawn, when an update was last tried, its holds, and a message id sent and not recorded; forgotten at `final` or `let_go`.
9. **No timer in the tests**: the loop is driven by `round()` on a `ManualClock`, as the card poster's tests drive `deliver()`.

## File map

| File | Change |
|---|---|
| `schema/014_progress_cards.sql` | new: the table and its index |
| `src/db/kanban.ts` | the six writers; `stop`'s `runId` |
| `src/db/kanban-read.ts` | `ProgressCardRow`, `progressCard`, `openProgressCards`, `countOpenProgressCards`, `progressDue`, `runEndedOf`, `stoppedOf`, `chatKindOf` |
| `src/db/events.ts` | `readEventsOfTypes`, `lastAgentEventAt`, `lastEventBefore` |
| `src/db/WRITERS.md` | the row of §4.2 |
| `src/kanban/service.ts` | the writers as methods; `stop(taskId, by, opts?)` |
| `src/config.ts` | `ProgressSettings`, `PROGRESS_DEFAULTS`, the subsection |
| `src/channel/render.ts` | `ToolLine`, `toolGroupsCounted` and `toolGroups` exported |
| `src/core/ids.ts` | `progressCardUuid` |
| `src/kanban/chat-render.ts` | `renderProgressCard`, `outcomeWord`, `progressState` |
| `src/kanban/progress.ts` | new: `foldProgress`, `ProgressCards` |
| `src/kanban/chat.ts` | `act: 'stop'` |
| `src/index.ts` | built, wired, started, stopped; the startup line |
| `tests/fakes/cli-agent.mjs` | a `progress` mode |
| `README.md`, `docs/kanban-guide.md` | the setting, the card, Stop, the exposure |
| `tests/progress-schema.test.ts` | new: Task 1 |
| `tests/progress-reads.test.ts` | new: Task 2 |
| `tests/progress-config.test.ts` | new: Task 3 |
| `tests/progress-render.test.ts` | new: Task 4 |
| `tests/progress-loop.test.ts` | new: Task 5 |
| `tests/progress-stop.test.ts` | new: Task 6 |
| `tests/progress-gateway.e2e.ts` | new: Task 7 |
| eight schema tests, `tests/gateway-startup.test.ts` | version 13 to 14 (Task 1) |
| `tests/helpers/progress.ts` | new: a run decided or closed for a test |

---

## Task 1: Migration 014 and its writers

**Files:** `schema/014_progress_cards.sql` (new), `src/db/kanban.ts`, `src/kanban/service.ts`, `src/db/WRITERS.md`; tests `tests/progress-schema.test.ts` (new), and `tests/kanban-schema.test.ts`, `tests/kanban-boards-schema.test.ts`, `tests/kanban-workflow-schema.test.ts`, `tests/kanban-worktree-schema.test.ts`, `tests/kanban-thread-roots.test.ts`, `tests/cron-schema.test.ts`, `tests/grants-writer.test.ts`, `tests/wake-schema.test.ts`, `tests/gateway-startup.test.ts`; helper `tests/helpers/progress.ts` (new).

- [ ] **Step 1: Write the tests.** `tests/progress-schema.test.ts`: the database at version 14, the table STRICT, its columns, the `state` check refusing `done`, the partial index; `openProgressCard` on an open undecided run writing `try_number` 1 and `try_limit` the gateway's 2, the task's own `failure_limit` 3 winning, `consecutive_failures` 1 giving 2; a second insert adding nothing; a decided run and a closed run given no row; `progressCardSent` writing the message once, a second call changing nothing; `progressCardDrawn` resetting `failures`; `progressCardRefused` answering 1, 2; `progressCardFinal` and `progressCardLetGo` only on an `open` row, neither moving a `final` row back. The eight schema tests' `13` becomes `14`, `tests/kanban-schema.test.ts` lists the new table, and `tests/gateway-startup.test.ts`'s startup line says `schema at version 14`. The helper decides a run with no event, for the tests of what the cards read of a decided run, and closes one through `closeRun`.
- [ ] **Step 2: Verify they fail.** `npx vitest run tests/progress-schema.test.ts` with the migration in place and the writers not: `Tests  7 failed | 1 passed (8)`, `openProgressCard` not a function.
- [ ] **Step 3: Implement.** The migration as §4.1 writes it. In `src/db/kanban.ts`, after `markUnblockRedrawn`:

  ```ts
  export function openProgressCard(db: Db, o: { runId: string; appId: string; channel: string; failureLimit: number }, now: number): Result<{ opened: boolean }> {
    return tx(db, (d) => {
      const { changes } = d.prepare(
        `INSERT OR IGNORE INTO kanban_progress_cards (run_id, task_id, app_id, channel, try_number, try_limit, opened_at)
         SELECT r.run_id, r.task_id, ?, ?, t.consecutive_failures + 1, COALESCE(t.failure_limit, ?), ?
           FROM kanban_runs r JOIN kanban_tasks t ON t.task_id = r.task_id
          WHERE r.run_id = ? AND r.ended_at IS NULL AND r.outcome IS NULL`,
      ).run(o.appId, o.channel, o.failureLimit, now, o.runId);
      return { ok: true, opened: changes === 1 };
    });
  }
  ```

  and `progressCardSent`, `progressCardDrawn`, `progressCardRefused`, `progressCardFinal`, `progressCardLetGo`, each one `UPDATE … WHERE run_id = ? AND state = 'open'` (and `message_id IS NULL` for the send). `KanbanService` gains each, refusing a run id or message id that is not text `invalid`. WRITERS.md gains §4.2's row.
- [ ] **Step 4: Run everything.** Unit: `Tests  3427 passed (3427)`, eight new.
- [ ] **Step 5: Commit** "Record each board run's progress card, in migration 014, through one writer".

## Task 2: The reads

**Files:** `src/db/kanban-read.ts`, `src/db/events.ts`; test `tests/progress-reads.test.ts` (new).

- [ ] **Step 1: Write the tests.**
  - `progressDue`: an open undecided role run started before the cut, followed in a thread, returned with its subscription; one in a direct message (`p2p`); one at chat scope with a null `chat_type`; not one at a group's chat scope, a person's run, a run started after the cut, a decided run, a run with a row, a task no subscription of this app follows.
  - `openProgressCards` of this app only, `open` rows only, oldest first; `progressCard` by run; `countOpenProgressCards`.
  - `runEndedOf` and `stoppedOf`: the latest such event of the run, not another run's.
  - `chatKindOf`: `p2p` from another subscription of the same app, channel and chat; nothing from another channel with the same conversation id, another app, or a chat no subscription knows.
  - `readEventsOfTypes`: only the types asked, in the range; `lastAgentEventAt`: the latest output event's `ts`, a later `turn_ended` and `session_state_changed` passed over, undefined for a session with none; `lastEventBefore`: the last event with `ts` below the bound.
- [ ] **Step 2: Verify they fail**: with the two modules as they were, `Tests  7 failed (7)`, `progressDue is not a function`.
- [ ] **Step 3: Implement.** `progressDue(db, appId, startedBy)` reads `SELECT … FROM kanban_runs r WHERE r.ended_at IS NULL AND r.outcome IS NULL AND r.assignee_kind = 'role' AND r.started_at <= ? AND NOT EXISTS (SELECT 1 FROM kanban_progress_cards c WHERE c.run_id = r.run_id) ORDER BY r.started_at, r.rowid`, and keeps each run whose `subscriptionsOf(...).find((s) => s.appId === appId)` has a `threadId`, or `chatType` `p2p` or null. `chatKindOf` is §2's query with `channel = ?`. `lastAgentEventAt` takes, for each of the six output types, the latest row by `idx_events_type`, and answers the greatest `ts`.
- [ ] **Step 4: Run everything.** Unit: `Tests  3434 passed (3434)`, seven new.
- [ ] **Step 5: Commit** "Read the runs due a progress card, the open cards, a chat's kind, and a session's tool events and last output".

## Task 3: The setting

**Files:** `src/config.ts`; tests `tests/progress-config.test.ts` (new), `tests/config.test.ts`.

- [ ] **Step 1: Write the tests.** Defaults `{ enabled: false, minSeconds: 30 }`; `enabled: true` and `min_seconds: 0` and `3600` read; `min_seconds: "30s"` refused with `<path>: kanban.progress.min_seconds must be a whole number, 0 or more, got "30s"`, `5000` with `<path>: kanban.progress.min_seconds must be from 0 to 3600, got 5000`, an unknown key refused, `enabled: 'yes'` refused. `tests/config.test.ts`'s two expectations of the whole section gain `progress`.
- [ ] **Step 2: Verify they fail**: with `src/config.ts` as it was, `Tests  6 failed (6)`, `kanban.progress` undefined and `progress` an unknown setting.
- [ ] **Step 3: Implement.** `ProgressSettings`, `PROGRESS_DEFAULTS`, `progress` in `KanbanSettings` and `KANBAN_DEFAULTS`, `'progress'` in `kanban`'s `reject`, the subsection read as `wake` is, `min_seconds` by `wholeNumber`.
- [ ] **Step 4: Run everything.** Unit: `Tests  3440 passed (3440)`, six new.
- [ ] **Step 5: Commit** "Read kanban.progress, off by default, with min_seconds".

## Task 4: The card

**Files:** `src/channel/render.ts`, `src/core/ids.ts`, `src/kanban/chat-render.ts`; test `tests/progress-render.test.ts` (new).

- [ ] **Step 1: Write the tests.**
  - `toolGroups`: the groups in first-heard order, counted, each state's icon; `toolSummary` its join (a reply card's line unchanged).
  - `renderProgressCard` live: the header `⚙️ **title** \`k_…\`` with the whole id, `implementer · run 1 of 2 · running under a minute`, `running 4 min`, `running 1 h 12 min`, the attempt when not N, `run 3` when N > M, `reviewer, reviewing`; the tool line, titles cut at 80 before grouping, over 1,500 cut from the front with `… 5 earlier · ` counting calls; `_Starting…_`, `_Working…_`; the tail between 400 and 600 characters at a line break in its first 200, else a space, else a character, quoted, `… (earlier output cut)` above it, masked whole first; the approval line; the Stop button's value and nonce, `try` first when above 0, `attempt` on the view; no button and the line in each decided state, with the word and never the raw outcome.
  - final: each outcome's mark and word, gave up from a `run_ended` that blocks as `gave_up`; `after 47 s`, `after 14 min 3 s`, `after 1 h 12 min`; no time when none; the tool line, no tail, no button; `This run has ended.` under the final line when asked.
  - masking and escaping: a known secret in a tool title, in the task's title, in an update's title, masked; a secret registered after the event was stored, masked at render; `<at id=all></at>` in a title and in the tail mentioning nobody.
  - `progressCardUuid` stable, and not `boardCardUuid`.
- [ ] **Step 2: Verify they fail**: with the three modules as they were, `Tests  21 failed (21)`, `toolGroups is not a function`.
- [ ] **Step 3: Implement.** `render.ts` exports `ToolLine`, `toolGroupsCounted` (the groups with their counts, for the front cut's "N earlier", which counts calls) and `toolGroups`; `toolSummary` is `toolGroups(tools).join(' · ')`. `ids.ts`: `progressCardUuid(appId, runId)`, as `boardCardUuid` with its own purpose. `chat-render.ts`: `progressState(run)`, `outcomeWord(outcome, runEnded)`, `ProgressFacts`, `renderProgressCard(facts, appId): CardView`, with `runningFor(ms)`, `ranFor(ms)` and `progressTail(text)`.
- [ ] **Step 4: Run everything.** Unit: `Tests  3461 passed (3461)`, twenty-one new.
- [ ] **Step 5: Commit** "Draw a board run's progress card: its header, tool line, tail, Stop button and final form".

## Task 5: The loop

**Files:** `src/kanban/progress.ts` (new); test `tests/progress-loop.test.ts` (new).

- [ ] **Step 1: Write the tests**, on a `ManualClock` with the fake channel, through `round()`:
  - which runs and where, §14's first two bullets; a held task; a channel not configured, its line once; a null `chat_type` read through `chatKindOf`, a found kind cached, a miss looked up again at the next round only, and a task typed meanwhile giving the run its card;
  - the fold: capped at 5,000 a round, the first included; no send until caught up; each read moving `throughSeq` to its bound;
  - pace and caps: no update within 5 s of the last landed or tried; a failing update held 5 s, 10 s, … a minute; no update when nothing changed; an update when the minute moves, when the state changes, when the `try` changes; ten draws a round, the longest waiting first;
  - the end: final at close, with the tool line, only once every tool event is folded, a session ending in text reaching `lastSeq`;
  - errors: a refused send held 2 s doubling to five minutes, counted, let go at ten with its line; code 0, a timeout and the throttles 230020, 99991400, 429 and a 5xx held and not counted, at least `retryAfterMs`; 230002 let go at once; a send not recorded updated this boot; a subscription gone before its send let go quietly; ten refused updates left with one line and the final still tried; `CARD_GONE_CODES` let go; a final refused ten times let go;
  - the restart: open rows of runs closed by `registry.reconcileBoot()` and `Dispatcher.boot()` drawn final, `interrupted by a restart` with the time to the agent's last output; to the session's last event before the boot when the agent wrote nothing; no time with no session; a reported run with its outcome;
  - `stop()` ending a round after its current draw, and `idle()`;
  - the whole markdown masked before each send and update.
- [ ] **Step 2: Verify they fail**: the file fails to collect, `src/kanban/progress.ts` not there.
- [ ] **Step 3: Implement** `foldProgress(p, events)` and `ProgressCards` as §7: `start`, `stop`, `idle`, `round`, the `Live` map, `#due`, `#send`, `#update`, `#final`, the chain by message, the holds, and the classification: a refusal `code !== 0 && !retryable`; gone, `CARD_GONE_CODES` or 230002; everything else held.
- [ ] **Step 4: Run everything.** Unit: `Tests  3516 passed (3516)`, forty new.
- [ ] **Step 5: Commit** "Run the progress card loop: open a card for each long run a thread follows, redraw it as it goes, and draw it final".

## Task 6: Stop

**Files:** `src/db/kanban.ts`, `src/kanban/service.ts`, `src/kanban/chat.ts`, `src/kanban/progress.ts`; test `tests/progress-stop.test.ts` (new).

- [ ] **Step 1: Write the tests**, §14's Stop press bullet: through `KanbanChat.card` with a `ProgressCards` over the fake channel. An operator's press stops the run, blocks the task `needs_input`, cancels the turn, answers before the redraw settles, and the card says `⏸ stopping, asked by Alice`; a talk-tier press refused, the card redrawn with `try` 1, and the same person's press of the new value, once granted, stopping; two tier refusals within 5 s one redraw, and the loop's update at the pace's end landing with the second `try` and nothing else changed; a person's run refused; a stale press drawn final with `This run has ended.`, paced to one a message every 5 s; `run_superseded` and `no_open_run` taken as stale; a press on a stopping or ending run answered `That run is already ending.`; `board.stop` with another run's id refused `run_superseded`; a stop during an in-flight update: the update lands, then the stopping redraw; `redrawNow` on a closed run's row drawn final and marked final, on a `let_go` row drawn final and left.
- [ ] **Step 2: Verify they fail**: the stop press answered `That button is not one the board knows.`
- [ ] **Step 3: Implement.** `board.stop(db, taskId, by, now, runId?)` refuses `run_superseded` when the open run is not `runId`. `service.stop(taskId, by, opts?: { runId?: string })`. `KanbanChat.card` takes `act: 'stop'` before the person-card path; `KanbanChatDeps` gains `progressRedraw`, `progressEnded`, `progressRefused`. `ProgressCards` gains `redrawNow`, `redrawEnded`, `refusedTier`.
- [ ] **Step 4: Run everything.** Unit: `Tests  3531 passed (3531)`, fifteen new.
- [ ] **Step 5: Commit** "Stop a board run from its progress card, checked against the run, and redraw the card at once".

## Task 7: The wiring, end to end

**Files:** `src/index.ts`, `tests/fakes/cli-agent.mjs`; test `tests/progress-gateway.e2e.ts` (new).

- [ ] **Step 1: Write the tests**, through `createGateway` with the fake Lark channel and the fake CLI agent in a new `progress` mode (a tool running, then, once `release-1` is beside the log, the tool done and a line of text, then, once `release-2` is there, `mt kanban complete`): a run in a task's thread gets one card there with `min_seconds: 0`; it is updated as the tool completes; when the run completes the card is drawn final, `✓ completed`, and the notice comes after the card; a Stop pressed on the card stops the run, the card drawn final `⏸ stopped`; a task in a group at chat scope gets no card and its notice; off, nothing is sent; the startup lines.
- [ ] **Step 2: Verify they fail**: no card is sent.
- [ ] **Step 3: Implement.** In `createGateway`, inside `if (config.kanban.enabled)`, after `KanbanChat`, when `config.kanban.progress.enabled`, a `ProgressCards` with `held: (taskId) => chat.held(taskId)`; `KanbanChat` given the three closures through a `let progress`; the startup line of §3; `Gateway.progress`; `bootedAt` the clock at the top of `start()`; `progress?.start()` after `cards?.start()`; `progress?.stop()` after `cards?.stop()`, and `progress?.idle(SHUTDOWN_DRAIN_MS)` in the drain, with its line.
- [ ] **Step 4: Run everything.** Unit: `Tests  3531 passed (3531)`; e2e: `Tests  187 passed (187)`, four new.
- [ ] **Step 5: Commit** "Wire the progress cards into the gateway, started after the boot and drained before the channel closes".

## Task 8: The documents

**Files:** `README.md`, `docs/kanban-guide.md`.

- [ ] **Step 1: Write.** The README's configuration table gains `kanban.progress.enabled` and `kanban.progress.min_seconds`, with the exposure: the tools' titles and the agent's words mid-run go to everyone in the thread, and only the secrets the gateway knows are masked; its board section a paragraph on the card and Stop. The guide's §8 ("Watching and steering") gains "Progress cards", and §9's "Stop, assign and archive" the Stop button.
- [ ] **Step 2: Verify.** `tests/docs-*.test.ts` pass; typecheck and `npm run build` clean.
- [ ] **Step 3: Run everything.** Unit: `Tests  3531 passed (3531)`, 112 more than the baseline's 3419; e2e `Tests  187 passed (187)`.
- [ ] **Step 4: Commit** "Document progress cards and their Stop button, and what they show the thread".

---

## Smoke checklist

From the spec's §15, on the user's tenant, with the board and progress cards on:

1. **The look**: a run past 30 s gets one card in its task's thread; the header, the tool line's icons and the quoted tail read well on desktop and mobile, and the Stop button sits under them.
2. **The pace**: tools running update the card about every 5 s, and everyone in the group sees the update; Lark refuses none for its rate; a quiet run's time moves once a minute.
3. **Stop**: an operator's press shows "⏸ stopping, asked by …" within a second or two, then "⏸ stopped after …", then the notice; a talk-tier person's press changes nothing on the board, what Lark shows them is noted, and after `/auth grant` their second press stops.
4. **A run longer than 10 minutes**: over 120 updates of one card all land; whether Lark caps the updates of one message, and with which code.
5. **The final card and the notice**: the final card above the notice in the thread, with the outcome and the time.
6. **Withdrawing the card**: the code Lark answers the next update with, which should be one of `CARD_GONE_CODES`, and the card let go of.
7. **A restart mid-run**: the card "interrupted by a restart", its time to the agent's last output, and the retry's own card.
8. **A supervised role**: the waiting line, and the approval card below the progress card.
9. **Several cards in one thread**: three tasks of one thread running at once, their cards updating together; whether the chat's rate limit (230020) is met, and if so that the cards are held and catch up, none let go.
10. **A task at a group's chat scope**: a task from before threads, or a terminal's `--chat` naming the group, running past 30 s: no card in the group, and its notices there as before.
11. **A direct message**: a task created in a direct message with the bot gets its card there; a terminal's `--chat` naming that same direct message, after a task was typed there, gets its card too; one naming a direct message where nothing was ever typed gets none, and its notices still come.
