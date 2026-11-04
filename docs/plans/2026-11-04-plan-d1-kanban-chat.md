# Plan D1 — The board in chat: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The board can be used from Lark for tasks given to roles. An operator types `/kanban new` in any chat the bot is in, with field lines for the assignee, the workspace, the parents and the contract, and the dispatcher runs the task on the role's agent at once. Every `/kanban` command a role's task needs — `list`, `show`, `assign`, `link`, `workspace`, `comment`, `unblock`, `stop`, `archive`, `gate add|list|remove` and `help` — goes through `KanbanService` and nothing else, at the tiers of spec §9.1, and is never refused because the chat's own session is busy. Anyone at talk tier may comment on a task and everyone sees the comments, but only an operator's comment steers the task's agent. The chat a task was created in follows it, and the tasks its runs create: it hears when one is done, needs review, blocks, is retried after a failure, gives up or is stranded — at most one message a round per chat or thread, listing that round's notices in order — delivered from cursors kept in the database, so the notices due while the gateway was down are sent when it is back. A chat the bot can no longer post to is let go of until a restart, rather than retried forever. Everything shown is escaped and masked, gate commands included. A task is any work — research, a document, an operation in Lark, a chore, code — and nothing here assumes git: a workspace is a directory. People are still refused as assignees and reviewers, and the commands for their own tasks say they arrive "in a later update" (plan D2). With `kanban.enabled` unset, chat is unchanged, and `/kanban` says the board is off.

**Architecture:**
- **The setting** (`src/config.ts`): `kanban.block_recurrence_limit`, spec §5.4's, read as the other `kanban:` numbers are: default 2, at most 100, file only.
- **Subscriptions** (`db/kanban.ts` `createTask`, `advanceSubscription`; `db/kanban-read.ts` `subscriptionsOf`, `dueSubscriptions`, `eventsAfter`): `createTask` subscribes the chat a task is created in, or copies the subscriptions of the task whose run created it, in its own transaction. A cursor moves forward only and writes no event. `run_ended` carries the block's reason and recurrence count, so its notice says what was true when it happened.
- **Comments that steer** (`schema/004_comment_steers.sql`, `db/kanban.ts` `addComment`, `db/kanban-read.ts` `commentsOf`, `KanbanService.comment`, `kanban/brief.ts`, `kanban/dispatcher.ts`): a `steers` column, 1 by default; a talk-tier person's comment from chat is stored with 0, shown to people, and never forwarded to a run or put in a run's prompt.
- **The board, listed** (`db/kanban-read.ts` `boardList`, `KanbanService.list`): every task with its derived status, for `/kanban list`.
- **Parsing** (`src/kanban/chat-parse.ts`): `parseKanban`, pure, turns what follows `/kanban` into a command, or the usage line to show; `isPerson` tells a person from a role.
- **Rendering** (`src/kanban/chat-render.ts`): the help, the list, `show`, the gate list and each notice, pure given the secret set. A piece is masked before anything else is done to it — spaces collapsed, trimmed, cut — then escaped; free text keeps its markdown through `forMarkdown`, quoted under its label, with a fence line neutralized; an agent's output is shown from its end; labels go through `forDisplay`.
- **The commands** (`src/kanban/chat.ts`): `KanbanChat.run` checks the sender's tier, records who acted as `lark:<union_id>`, refuses a person or a supervised role as arriving in a later update, holds a new task to the worker CLI's size limits, calls the service, and tells the dispatcher: a pass after a change, and the cancel of an agent run's turn that the change decided.
- **The router** (`src/core/commands.ts`, `src/core/router.ts`): `/kanban` is a command at talk tier, multiline, needing no session and never refused mid-turn; the router hands it to `RouterDeps.kanban`, or says the board is off, and masks the whole reply.
- **Notices** (`src/kanban/notices.ts`, `core/ids.ts` `noticeBatchUuid`): every 2 s, one round at a time, the `Notifier` sends each conversation with due notices one message, in event order, at most 20 notices, and moves each subscription's cursor once the send succeeded; the uuid is derived from the set of (subscription, event) pairs. A failed send is retried after a pause that doubles to five minutes; one refused for good, or refused by Lark with a nonzero code three times at five minutes, drops its notices, says so once, and the conversation is let go of until a restart. One conversation or subscription that throws holds up no other, and a round sends to at most ten conversations.
- **Wiring** (`src/index.ts`): behind `kanban.enabled`, the router gets the commands and the gateway a notifier, started once the channel is connected and stopped before it disconnects.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, better-sqlite3.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §3.4, §4.2, §5.4, §7.5, §7.7, §9.1, §9.3, §9.4, §10, §11 and the D1 and D2 rows of §12, as amended in the same commit as this plan.

---

## Ground rules

- **Where to work.**
  - Use the worktree `/Users/x/Develop/manus/prime-gateway-work`, on branch `kanban-chat`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`: the live gateway runs there.
  - Never start the gateway, and never write to `~/.manus-team`.
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink to the main checkout's; create it with `ln -s /Users/x/Develop/manus/prime-gateway/node_modules node_modules` if it is missing.
  - Write plain-English commit messages: no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
  - The letters `p`,`g`,`w` in that order, in any case, must not appear in anything you write.
- **Secrets.** Never print secret values. Tests use made-up values only.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline.** `npm test` gives `Tests  1151 passed (1151)`. `npm run test:e2e` gives `Tests  70 passed (70)`. `npm run typecheck` reports no errors.
- **Finding edits.** Find each edit by its quoted text, not by line number. Every quoted text appears exactly once in its file at the point the step applies it. Apply a step's edits in the order given.
- **The secret registry is process-wide.** Every test file that adds secrets calls `clearSecrets()` in `beforeEach` and `afterEach`, or, in `tests/router.test.ts`, in the `afterEach` of its own `describe`.
- **Tests use real SQLite** through `testDb()`, the real `KanbanService`, the real board and a `ManualClock`; the router's tests use its existing harness, and the notices a `FakeChannel`. No mocks, except the gateway's start-up test, which stubs the Lark connection as its neighbours do.
- **No real agent, no network, no real home.** No test runs bytesec or reaches Lark. The end-to-end test runs the fake CLI agent through the real CLI driver, with its home, socket and workspace under a fresh `mkdtemp` directory, realpath'd.
- **Unit tests start no process.** The board's chat and its notices start none; only `tests/kanban-chat.e2e.ts` does, in the e2e project.
- **The import guard.** `tests/kanban-service.test.ts` checks that only `src/kanban/service.ts` imports `src/db/kanban.js`. `KanbanChat` calls the service only; the `Notifier` reads through `db/kanban-read.js` and moves its cursors through the service.
- **One migration.** `schema/004_comment_steers.sql` adds one column, with a default, so every existing row keeps its meaning; `db/kanban.ts` stays its only writer.
- **Nothing assumes git or code.** A task is any work and a workspace any directory: no step here reads a repository, and the test tasks are documents, surveys and chores as often as code.

## Decisions the spec left open

Each is the reading most consistent with the rest of the spec. *The user's decision* marks those the user made, before this plan or on review of its first draft; the rest are proposed, with the reason. All of them are in the spec now (§3.4, §4.2, §5.4, §7.5, §7.7, §9.1, §9.3, §9.4, §12), amended in the same commit as this plan.

1. **D is D1, then D2.** *The user's decision.* D1 is every `/kanban` command a role's task needs, and a chat's subscriptions and their notices, so that tasks given to roles are usable from Lark. D2 is people: direct-message cards with Done, Block, Approve and Request changes; the person send target by union_id; card `kind` routing; the group one-line notice; `/kanban done`, `block` and `review` by a human assignee, `approve` and `changes` by a person reviewer; approval forwarding for supervised roles; and refusing a person's report beside another task's agent run (`workspace_busy`, spec §7.7).
2. **The board stays opt-in.** *The user's decision.* `kanban.enabled` is off by default after D1 and D2. With it unset, the gateway builds no service, dispatcher, socket, chat commands or notifier, as before, and chat without `/kanban` is unchanged.
3. **A task is any work.** *The user's decision.* Nothing in D1 reads a repository or assumes code: a workspace is a directory, a gate any command, and the help and the README say so.
4. **Words a person sees say "a later update", never "plan D2".** *The user's decision.* "Assigning a task to a person, or naming one as its reviewer, arrives in a later update." The plan and the spec still name D2; no reply, notice or help text does.
5. **`/kanban` with the board off answers that it is off.** The command is always registered; with no board, the router answers "The task board is off on this gateway. An operator turns it on with `kanban.enabled: true` in config.yaml, and a restart." and opens no session. *Why:* without it, `/kanban` would be "Unknown command", which reads as a typo, on the very gateway whose operator has to be told what to change.
6. **The person-only commands are answered, not left out.** `/kanban done`, `block`, `review`, `approve` and `changes` parse, and are answered "`/kanban done` is for a person's own task, and arrives in a later update, with people as assignees and reviewers. For now tasks go to roles, whose agents report for themselves." *Why:* the spec's table lists them, so people will try them, and reserving the verbs now means D2 changes their answer, not the parser. **An operator's `approve` or `changes` on a role-reviewed task** arrives in D2 with the rest. *The user's decision.*
7. **A person named as assignee or reviewer is refused before the service sees it.** A name starting `@` — Lark's text gives an @-mention as `@Name` — or `lark:` is answered with Decision 4's sentence. `isPerson` is checked before `/kanban assign` counts its words, so `assign k_1 @Alice Smith` gets that answer, not a usage error. *Why:* `InboundMessage` carries no mention ids yet, so D1 cannot tell who was mentioned, only that someone was; the service's own `person_not_assignable` says "until the board is in Lark", which is no longer the reason. D2 adds the mentioned users' ids to the inbound message.
8. **A supervised role is still refused, in D1's words.** The service's `supervised_role` refusal is answered as "role "x" has a supervised agent; its approval requests cannot be forwarded to a chat yet. That arrives in a later update." The service is unchanged: D2 turns `supervisedRoles` on.
9. **Who acted is `lark:<union_id>`.** The board's principal for a person (spec §3.1), and what D2 assigns people as. A sender whose message carried no union_id may `list`, `show`, `gate list` and see the help, and is refused anything that records who acted. *Why:* `open_id` is app-scoped, and recording it would give one person two identities on the board.
10. **Tiers.** `/kanban` is registered at talk tier, and each command that changes the board checks operator tier itself, naming the command it refused: "`/kanban assign` changes the board, and needs operator permission." Talk: `help`, `list`, `show`, `comment`, `gate list`. Operate: `new`, `assign`, `link`, `workspace`, `unblock`, `stop`, `archive`, `gate add`, `gate remove` (spec §9.1, §10). **`gate list` is talk tier**, as `/kanban show`, which shows the same gates masked, is. *The user's decision.*
11. **A talk-tier comment is stored, not forwarded.** *The user's decision.* Anyone at talk tier may comment, and everyone sees comments in `/kanban show`. Only a comment that *steers* is forwarded to an undecided agent run (spec §7.5) or put in a run's prompt — or in `mt kanban show`, which reads the same brief. A run's comment steers, as before (and is still never forwarded back to a run); an operator's steers, from chat or with an unblock; a talk-tier person's does not. D2 adds the named assignee and reviewer. **How it is stored:** migration `004_comment_steers.sql` adds `kanban_comments.steers`, `INTEGER NOT NULL DEFAULT 1`, so every comment written before it — from runs, and from the service's own callers — keeps steering; `addComment` and `KanbanService.comment` take it as a required argument, with no default — the worker passes `true`, and the service refuses a call that does not say — `db/kanban.ts` stays the only writer, and the `commented` event records `steers: false` when it is false, leaving every existing payload as it was. `commentsOf(db, task, { steering: true })` is the read the prompt and the dispatcher use; `/kanban show` reads them all. A column was chosen over a field in the event's JSON because the readers read the comments table, not the log.
12. **`/kanban new`'s grammar** (spec §9.1). The arguments' line breaks are normalized first: a CRLF or a lone CR is a newline. The title is the rest of the first line, or the next line when the verb stands alone; a title that is itself a field line (`assignee: x`) is refused, as the title is missing. A field line is its label at the very start of the line, in any case, then a colon and a value; an indented line, or one that only mentions a label, stays body. Field lines may come anywhere among the body's lines. Each field may be given once, except `parent:`, which takes task ids separated by spaces or commas and may be repeated. `verify:` fills `verification`, `stop when:` fills `stop_when`. A field given twice, or with no value, is refused with the label. A task with no assignee may be created, and the reply says how to assign it. The message id is the idempotency key, `lark:<message_id>`, the chat key the service already reserves, so a redelivery past the router's own dedup still makes one task.
13. **A task from chat has the worker CLI's size limits.** A title of at most 512 bytes ("A title is at most 512 bytes; put the rest in the body."), a body of at most 64 KiB, and each contract field at most 8 KiB: C3's `WORKER_LIMITS`, checked in `KanbanChat` before the service. *Why:* a task should have the same limits whoever made it, and `mt kanban create` already has these; putting a new, smaller cap in `KanbanService.create` would change what C3's workers may send for no gain. Replies, the reply to `/kanban new` among them, show a title cut to 200 characters, on one line.
14. **`/kanban list`.** Without a status, the tasks someone may still act on — running, reviewing, review, ready, todo, blocked — grouped in that order; with a status, only those; `all` lists every task. At most 30 lines, then "… and N more".
15. **`/kanban show`** gives the title, id and status; assignee, reviewer and workspace; the block, if blocked; parents and children; the body; the contract; the gates, masked; the last five runs; **the end of the latest run's output** — masked whole, then its last 800 characters, after "… (earlier output cut)", since what an agent said last is what matters; and the last five comments. Each piece has a cap, and the router cuts a whole reply at 4,000 characters, saying so.
16. **`/kanban assign` to the current assignee** answers "`k_…` is already assigned to role x." and changes nothing — no event, no pass.
17. **`/kanban gate add <task> [--timeout <s>] <command>`.** The rest of the message after the task id and the optional timeout is the command, as written, line breaks kept. `gate list <task>` and `gate remove <task> <gate>` complete the set. The definer is `lark:<union_id>`.
18. **Rendering** (spec §9.3). Every piece of task text is masked first — before its spaces are collapsed into one line, before it is trimmed or cut — so no reshaping can hide a secret from the masker, a secret holding a line break included; only then is it escaped. A body, a summary, a comment and an agent's output keep their markdown through `forMarkdown` and are quoted, `> ` on each line, under their label; a line opening a code fence, three or more backticks or tildes, has its first one escaped, so the text can neither open nor close a fence. Links in that text are kept: `forMarkdown` neutralizes Feishu's tags, and a link cannot mention anyone. Titles, names, reasons, errors and gate commands go through `forDisplay`, as one line cut with "…", so a cut label never spills onto a second line — in replies too: `/kanban gate add` and `gate remove` echo the command on one line, at most 600 characters, as `gate list` shows it, and a refusal, which can quote what the sender typed, is one line too. The router masks each whole reply once more, and the notifier each message.
19. **After a change, the dispatcher is told.** `KanbanChat` calls `changed()` — the dispatcher's `pass()` — after `new`, `assign`, `workspace`, `unblock`, `stop` and `archive`; and `cancel(runId)` for an agent run that `assign`, `stop` or `archive` decided while it was open, so its turn is cancelled and the run closed. `comment` tells neither: the dispatcher forwards a steering comment when the run's turn ends (spec §7.5).
20. **Subscriptions are written by `createTask`, in its transaction, with no event.** The chat's binding key for a task created in chat; for a task a run created, a copy of every subscription of the run's task (spec §7.3), which is how "the tasks created from it" (§9.4) is read. Cursors start at 0.
21. **What a subscriber hears** (spec §9.4). `completed`; `review_requested`; `blocked` of any kind but `dependency`; `stopped`; `run_ended` that retries after `failed`, `crashed`, `timed_out` or `protocol_violation`; `run_ended` that blocks — "gave up" for `gave_up`, otherwise as a block; and `stranded`. **A run interrupted by a gateway restart is retried quietly.** *The user's decision.* Not heard either: a throttled run's cooldown, `changes_requested`, comments, claims, links, gates, archives. A block's notice says how to unblock, or, at `kanban.block_recurrence_limit`, to rewrite the task (spec §5.4), by the recurrence count the event recorded — the `blocked`, `stopped` and now `run_ended` payloads carry it — not the task's count when the notice is sent.
22. **`run_ended` carries `blockReason` and `blockRecurrences`.** A notice delivered later — after a restart, say — tells what was true when the run ended. JSON keys, no migration; earlier events read as no reason and no recurrence.
23. **Notices are batched per conversation.** *The user's decision.* Each round sends a conversation — a chat, or a thread — at most one message: the round's notices for all its subscriptions, in event order, at most 20 (`BATCH_NOTICES`) and 3,800 characters, then "… and N more, in the next message." Each subscription's cursor moves, only once the send succeeded, to its last event the message covered, notices or not. A subscription reads at most 100 events a round (`ROUND_EVENTS`); when one has read that many, nothing past the last event it read is sent this round, from any subscription of the conversation, so a later notice of another task cannot go before an earlier one not yet read. The uuid is per batch, `noticeBatchUuid(appId, pairs)`, a hash of the sorted set of (subscription, event) pairs, so the same batch sent again keeps its uuid.
24. **Delivery is a projection from the cursors, polled.** A round runs every 2 s, one at a time. *Why a poll:* the board is written from chat, the worker socket and the dispatcher, and from inside `endRun` and `noteStranded`; hooking each would be a second list to keep in step with every writer. Across a restart, the cursors are in the database, so the first round after connecting catches up by the same code; a batch sent just before a stop, whose cursors had not moved, is sent again with the same uuid. The Lark adapter does not pass the uuid to Lark yet, so that batch can show twice. A send is waited for at most 30 s (`NOTICE_SEND_MS`); one that takes longer counts as failed, and its batch is sent again later with the same uuid — the slow send may still land, so it may show twice too. At shutdown the gateway waits for the round under way no longer than that.
25. **A conversation that cannot be reached is let go of.** A failed send moves no cursor and holds the conversation back 2 s, doubling to five minutes. A send refused as unreachable — a `ChannelError` whose code is in `UNREACHABLE_CODES`, which holds 230002, "the bot is not in the chat" — or the third refusal in a row at five minutes (`DEAD_AFTER`) — only a `ChannelError` with a nonzero code counts, so the eleventh refused send in a row, after 1,110 s of pauses (2 s doubling to 256 s, then two of five minutes), about 19 minutes — drops the notices it held — the cursors move past them — logs one line naming the conversation, its tasks and the dropped events, and marks the conversation dead until the gateway restarts: its later notices are passed over, unsent, without another line. Any other failure is not a dead chat. A refusal may be of one bad batch, so it takes the doubling pause, and `DEAD_AFTER`. A network failure, which Lark's adapter reports as code 0 and not retryable (a reset connection, the SDK's own timeout), a send past `NOTICE_SEND_MS`, and any error that is not a `ChannelError` are the gateway's outage, not the chat's: they take the doubling pause, are held at five minutes for as long as they last, and never count toward `DEAD_AFTER`, so after the outage the conversation catches up from its cursors. One of them between two refusals leaves the count of refusals as it was. Lark's codes for a chat not found or disbanded are left out of `UNREACHABLE_CODES`: nothing in this repository or its SDK confirms them, and such a chat is let go of by `DEAD_AFTER` instead. A round sends to at most ten conversations (`ROUND_SENDS`), the longest waiting first — by the oldest event past any of its cursors, which `dueSubscriptions` reads with the index — so the first round after a restart does not try every dead conversation at once. A subscription that cannot be read — its task not on the board — or a conversation whose channel cannot be looked up is held back by itself, and the rest of the round goes on.
26. **`kanban.block_recurrence_limit` is a setting now.** Spec §5.4 names it; C's config refused it "before it does anything". Default 2, at most 100, file only.

## Out of scope (plan D2 and later)

- **Plan D2:** everything in Decision 1; a person's `/kanban done`, `block`, `review`, `approve` and `changes`, and an operator's `approve` and `changes`, through the service's asynchronous `complete` and `requestReview`, with a gate refusal's output shown through the escapers and `dispatcher.pass()` after it; the named assignee's and reviewer's comments steering; the review card's "review commit …" from `describeReported`; the Unblock button on a blocked notice (spec §9.2); the mentioned users' ids on `InboundMessage`; approval cards for kanban runs forwarded to the task's first subscription (`KanbanSink`).
- **The Lark adapter's uuid.** Passing a send's uuid to Lark, so a batch redelivered after a restart is deduplicated by the platform, needs the SDK to expose it.
- **Allowlists.** A subscription keeps receiving notices if its chat is later removed from `auth.chats`; the notifier does not consult the authorizer.

### Known limitations, not fixed here

- A batch sent just before the gateway stops, whose cursors had not moved, is sent again after the restart, and shows twice until the adapter passes the uuid on (Decision 24).
- A send that takes longer than 30 s counts as failed, but cannot be called back: if it lands, its batch shows twice, and it may arrive after a later batch, out of order (Decision 24).
- A chat that was disbanded, or not found, is let go of only after `DEAD_AFTER` refusals at the longest pause — the eleventh refused send in a row, after 1,110 s of pauses, about 19 minutes: those codes are not confirmed locally (Decision 25).
- A gateway outage — a network failure, code 0, or sends past 30 s — never lets a conversation go; it is tried every five minutes for as long as the outage lasts. A chat that is gone for good but answers only with code 0 or not at all is therefore never let go of, and is tried every five minutes until a restart, logging a line each time (Decision 25).
- A conversation let go of drops the notices it held, and passes over its later ones until the next restart; the log says which were dropped. One that recovers by itself is not heard from again until then (Decision 25). After each restart a dead conversation is tried once more, at most ten conversations a round.
- Subscriptions are never deleted, so each round's scan grows with the tasks ever created. The scan is one query: it finds this bot's subscriptions through the index on `kanban_subscriptions(account_id)`, added in migration 004, and each one's oldest pending event with a correlated `min(e.id)` subquery through the events' `(task_id, id)` index, so it reads every subscription the bot has ever had, and a delivered subscription of an archived task has nothing past its cursor; skipping such rows outright would need a delivered flag, a second thing to keep in step with the cursor, so it is not done.
- A task created in a thread is followed by that thread only; nothing yet subscribes another chat to it.
- A notice is at most a 2 s poll behind its event, plus any pause after a failed send, plus the rounds a busy conversation's batches take.
- `/kanban list` reads every task's parents and runs, one query each: fine for a board of hundreds, slow for tens of thousands.

### What D2 needs

- `KanbanChat` answers the `later` verbs in one place: D2 replaces that branch with the reports, through `complete` and `requestReview`, awaited, and their tiers (spec §9.1: the named assignee or reviewer at talk tier).
- `isPerson` (`src/kanban/chat-parse.ts`) and `PEOPLE_LATER` are where an @-mention becomes a principal, once `InboundMessage` carries the mentioned ids; the service's `people` dependency turns persons on.
- A named assignee's or reviewer's comment passes `steers: true` (Decision 11).
- The `Notifier` delivers through `Channel.sendText`; D2's cards and the group notice go through the same subscriptions, and its approval forwarding through the task's first one (`subscriptionsOf(...)[0]`).

## File structure

| File | Responsibility |
|---|---|
| `src/config.ts` (modify) | `kanban.block_recurrence_limit` |
| `src/kanban/types.ts` (modify) | `SubscriptionRow` |
| `schema/004_comment_steers.sql` (create) | `kanban_comments.steers` |
| `src/db/kanban-read.ts` (modify) | `eventsAfter`, `subscriptionsOf`, `dueSubscriptions`, `boardList`, `BoardEntry`; `commentsOf`'s `steering` |
| `src/db/kanban.ts` (modify) | subscriptions in `createTask`; `advanceSubscription`; `run_ended`'s `blockReason` and `blockRecurrences`; `addComment`'s `steers` |
| `src/db/WRITERS.md` (modify) | `kanban_subscriptions`'s writer; `kanban_comments.steers` |
| `src/kanban/service.ts`, `src/kanban/worker.ts` (modify) | `list`, `advanceSubscription`; `comment`'s required `steers`, which a worker's comment passes as `true` |
| `src/kanban/brief.ts`, `src/kanban/dispatcher.ts` (modify) | only steering comments in a prompt, and forwarded |
| `src/kanban/chat-parse.ts` (create) | `parseKanban`, `isPerson`, `USAGE`, `LIST_FILTERS`, `LATER_VERBS` |
| `src/kanban/chat-render.ts` (create) | `renderHelp`, `renderList`, `renderShow`, `renderGates`, `renderNotice` |
| `src/kanban/chat.ts` (create) | `KanbanChat`, `principalOf` |
| `src/core/commands.ts`, `src/core/router.ts` (modify) | the `/kanban` command; `KanbanCommands`, `RouterDeps.kanban`, `KANBAN_OFF` |
| `src/core/ids.ts` (modify) | `noticeBatchUuid` |
| `src/kanban/notices.ts` (create) | `Notifier`, `NOTICE_POLL_MS`, `NOTICE_BACKOFF_MAX_MS`, `NOTICE_SEND_MS`, `DEAD_AFTER`, `BATCH_NOTICES`, `ROUND_SENDS`, `ROUND_EVENTS`, `UNREACHABLE_CODES` |
| `src/index.ts` (modify) | the commands and the notifier behind `kanban.enabled` |
| `README.md` (modify) | the board from Lark |
| `tests/kanban-subscriptions.test.ts`, `tests/kanban-comment-steering.test.ts`, `tests/kanban-chat-parse.test.ts`, `tests/kanban-chat-render.test.ts`, `tests/kanban-chat.test.ts`, `tests/kanban-notices.test.ts`, `tests/kanban-chat.e2e.ts` (create) | |
| `tests/kanban-stranded.test.ts`, `tests/kanban-service.test.ts`, `tests/kanban-worker.test.ts`, `tests/kanban-nudge.test.ts`, `tests/kanban-brief.test.ts`, `tests/kanban-tasks.test.ts`, `tests/kanban-assign.test.ts` (modify) | each comment says whether it steers |
| `tests/config.test.ts`, `tests/kanban-schema.test.ts`, `tests/router.test.ts`, `tests/commands.test.ts`, `tests/ids.test.ts`, `tests/gateway-startup.test.ts` (modify) | |

Running counts, unit then end to end: Task 1 1152 / 70, Task 2 1159, Task 3 1163, Task 4 1171, Task 5 1186, Task 6 1195, Task 7 1200, Task 8 1217, Task 9 1218, Task 10 1218 / 72, Task 11 1218 / 72.

---

### Task 1: The block recurrence setting

**Files:**
- Modify: `src/config.ts`, `tests/config.test.ts`

Spec §5.4 names `kanban.block_recurrence_limit`, the number of same-kind blocks after an unblock at which a blocked notice stops inviting another unblock. Plan C refused the key until something used it; the notices of Task 5 do (Decision 26). It is read like the other `kanban:` numbers: snake_case in the file, a positive whole number, a ceiling, no environment override.

- [ ] **Step 1.1: Write the failing tests.**

In `tests/config.test.ts`, replace:

```ts
      strandedAfterS: 1_800,
      nudgeLimit: 2,
    });
```

with:

```ts
      strandedAfterS: 1_800,
      nudgeLimit: 2,
      blockRecurrenceLimit: 2,
    });
```

In `tests/config.test.ts`, replace:

```ts
          nudge_limit: 1,
        },
      }),
    );
```

with:

```ts
          nudge_limit: 1,
          block_recurrence_limit: 3,
        },
      }),
    );
```

In `tests/config.test.ts`, replace:

```ts
      strandedAfterS: 120,
      nudgeLimit: 1,
    });
```

with:

```ts
      strandedAfterS: 120,
      nudgeLimit: 1,
      blockRecurrenceLimit: 3,
    });
```

In `tests/config.test.ts`, replace:

```ts
      'unknown setting kanban.failureLimit (known: enabled, max_running, failure_limit',
    );
    // Plan D's setting is not accepted before it does anything.
    expect(() => load({}, yamlFile({ kanban: { block_recurrence_limit: 2 } }))).toThrow(
      'unknown setting kanban.block_recurrence_limit',
    );
  });
```

with:

```ts
      'unknown setting kanban.failureLimit (known: enabled, max_running, failure_limit',
    );
  });
```

In `tests/config.test.ts`, replace:

```ts
describe('loadConfig: kanban.nudge_limit', () => {
```

with:

```ts
describe('loadConfig: kanban.block_recurrence_limit', () => {
  it('is a positive whole number, at most 100, and is file only', () => {
    expect(load({}, yamlFile({ kanban: { block_recurrence_limit: 1 } })).kanban.blockRecurrenceLimit).toBe(1);
    expect(() => load({}, yamlFile({ kanban: { block_recurrence_limit: 0 } }))).toThrow(
      'kanban.block_recurrence_limit must be a positive integer',
    );
    expect(() => load({}, yamlFile({ kanban: { block_recurrence_limit: 101 } }))).toThrow(
      'kanban.block_recurrence_limit must be at most 100, got 101',
    );
    expect(load({ MT_KANBAN_BLOCK_RECURRENCE_LIMIT: '5' }).kanban.blockRecurrenceLimit).toBe(2);
  });
});

describe('loadConfig: kanban.nudge_limit', () => {
```


- [ ] **Step 1.2: Run them to verify they fail.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` and then `npx vitest run --project unit tests/config.test.ts`. Expected: three FAIL — the defaults lack `blockRecurrenceLimit`, and the other two are refused with `unknown setting kanban.block_recurrence_limit (known: enabled, max_running, …, nudge_limit)`. `Tests  3 failed | 70 passed (73)`.

- [ ] **Step 1.3: Implement.**

In `src/config.ts`, replace:

```ts
  /** Reminders sent to a run whose turn ended without a report, before it is a protocol violation (spec §7.5). */
  nudgeLimit: number;
}
```

with:

```ts
  /** Reminders sent to a run whose turn ended without a report, before it is a protocol violation (spec §7.5). */
  nudgeLimit: number;
  /**
   * Blocks of the same kind in a row, unblocked in between, at which a blocked
   * notice stops inviting another unblock and suggests rewriting the task (spec §5.4).
   */
  blockRecurrenceLimit: number;
}
```

In `src/config.ts`, replace:

```ts
  nudgeLimit: 2,
};
```

with:

```ts
  nudgeLimit: 2,
  blockRecurrenceLimit: 2,
};
```

In `src/config.ts`, replace:

```ts
  nudge_limit: 'nudgeLimit',
} as const;
```

with:

```ts
  nudge_limit: 'nudgeLimit',
  block_recurrence_limit: 'blockRecurrenceLimit',
} as const;
```

In `src/config.ts`, replace:

```ts
  nudge_limit: 10,
};
```

with:

```ts
  nudge_limit: 10,
  block_recurrence_limit: 100,
};
```

In `src/config.ts`, replace:

```ts
      nudgeLimit: file.kanban.nudgeLimit ?? KANBAN_DEFAULTS.nudgeLimit,
    },
```

with:

```ts
      nudgeLimit: file.kanban.nudgeLimit ?? KANBAN_DEFAULTS.nudgeLimit,
      blockRecurrenceLimit: file.kanban.blockRecurrenceLimit ?? KANBAN_DEFAULTS.blockRecurrenceLimit,
    },
```


- [ ] **Step 1.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/config.test.ts`. Expected: `Tests  73 passed (73)`.

- [ ] **Step 1.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1152 passed (1152)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  70 passed (70)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 1.6: Commit.**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "Read kanban.block_recurrence_limit, the count of blocks of one kind after which a blocked notice suggests rewriting the task"
```

---

### Task 2: Subscriptions, and the board as a list

**Files:**
- Create: `tests/kanban-subscriptions.test.ts`
- Modify: `src/kanban/types.ts`, `src/db/kanban-read.ts`, `src/db/kanban.ts`, `src/kanban/service.ts`, `src/db/WRITERS.md`

`kanban_subscriptions` exists since migration 003 with no writer. `createTask` now subscribes, in its own transaction: the chat a task is created in, or every chat following the task whose run created it (spec §7.3, §9.4; Decision 20). `advanceSubscription` moves a cursor forward only and writes no event — an event would itself be past the cursor. The reads a notifier needs come with it: `subscriptionsOf`, `dueSubscriptions` and `eventsAfter`. `run_ended` gains `blockReason` and `blockRecurrences`, so a notice delivered later says what was true when the run ended (Decision 22). And `boardList`, through `KanbanService.list`, gives `/kanban list` every task with its derived status.

- [ ] **Step 2.1: Write the failing tests.**

Create `tests/kanban-subscriptions.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advanceSubscription, createTask, endRun, DEFAULT_LIMITS } from '../src/db/kanban.js';
import {
  boardList,
  dueSubscriptions,
  eventsAfter,
  eventsOf,
  subscriptionsOf,
} from '../src/db/kanban-read.js';
import type { CreatedVia } from '../src/kanban/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed, newTask } from './helpers/kanban.js';

/**
 * Subscriptions (spec §9.4): the chat a task is created in follows it, and the
 * chats following a task follow the tasks its runs create. A cursor moves only
 * forward, and writes no event of its own.
 */

let h: TestDb;

beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

const THREAD: CreatedVia = { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' };
const OTHER_BOT: CreatedVia = { kind: 'chat', channel: 'lark', appId: 'cli_other', conversationId: 'oc_chat', threadId: '' };

describe('subscriptions', () => {
  it('subscribes the chat a task is created in, at cursor 0, writing no event of its own', () => {
    const task = newTask(h.db, { createdVia: THREAD });
    expect(subscriptionsOf(h.db, task.taskId)).toEqual([
      {
        id: expect.any(Number) as number,
        taskId: task.taskId,
        channel: 'lark',
        appId: 'cli_app',
        conversationId: 'oc_team',
        threadId: 'omt_topic',
        cursor: 0,
        createdAt: NOW,
      },
    ]);
    expect(eventsOf(h.db, task.taskId).map((e) => e.kind)).toEqual(['created']);
  });

  it('subscribes nothing twice when a create is repeated with its key', () => {
    const first = newTask(h.db, { idempotencyKey: 'lark:om_1' });
    const again = createTask(
      h.db,
      { title: 'a task', idempotencyKey: 'lark:om_1', createdBy: ALICE, createdVia: VIA },
      NOW,
    );
    expect(again).toMatchObject({ ok: true, existing: true, task: { taskId: first.taskId } });
    expect(subscriptionsOf(h.db, first.taskId)).toHaveLength(1);
  });

  it("gives a task a run creates every subscription of the run's task", () => {
    const parent = newTask(h.db, { createdVia: THREAD });
    // A second chat following the same task: a subscription is per chat and thread.
    h.db
      .prepare(
        `INSERT INTO kanban_subscriptions (task_id, channel, account_id, conversation_id, thread_id, created_at)
         VALUES (?, 'lark', 'cli_app', 'oc_other', '', ?)`,
      )
      .run(parent.taskId, NOW);
    const run = claimed(h.db, parent.taskId);
    const child = createTask(
      h.db,
      { title: 'a follow-up', createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } },
      NOW,
    );
    if (!child.ok) throw new Error(child.message);
    expect(subscriptionsOf(h.db, child.task.taskId).map((s) => [s.conversationId, s.threadId, s.cursor])).toEqual([
      ['oc_team', 'omt_topic', 0],
      ['oc_other', '', 0],
    ]);
  });

  it('moves a cursor forward only, and refuses a subscription that does not exist', () => {
    const task = newTask(h.db);
    const [sub] = subscriptionsOf(h.db, task.taskId);
    if (sub === undefined) throw new Error('not subscribed');
    expect(advanceSubscription(h.db, sub.id, 5)).toEqual({ ok: true, advanced: true });
    expect(advanceSubscription(h.db, sub.id, 3)).toEqual({ ok: true, advanced: false });
    expect(subscriptionsOf(h.db, task.taskId)[0]?.cursor).toBe(5);
    expect(eventsOf(h.db, task.taskId).map((e) => e.kind)).toEqual(['created']);
    expect(advanceSubscription(h.db, 999, 1)).toEqual({ ok: false, code: 'not_found', message: 'no subscription 999' });
  });

  it("lists this bot's subscriptions with events past their cursor, and the events after a cursor in order", () => {
    const a = newTask(h.db);
    const b = newTask(h.db);
    newTask(h.db, { createdVia: OTHER_BOT });
    const [subA] = subscriptionsOf(h.db, a.taskId);
    const [subB] = subscriptionsOf(h.db, b.taskId);
    if (subA === undefined || subB === undefined) throw new Error('not subscribed');
    expect(dueSubscriptions(h.db, 'cli_app').map((s) => s.taskId)).toEqual([a.taskId, b.taskId]);
    // Each with its oldest event past the cursor: how long it has waited.
    expect(dueSubscriptions(h.db, 'cli_app').map((s) => s.oldestPending)).toEqual([
      eventsOf(h.db, a.taskId)[0]?.id,
      eventsOf(h.db, b.taskId)[0]?.id,
    ]);
    const created = eventsOf(h.db, b.taskId)[0]?.id ?? 0;
    expect(advanceSubscription(h.db, subB.id, created).ok).toBe(true);
    expect(dueSubscriptions(h.db, 'cli_app').map((s) => s.taskId)).toEqual([a.taskId]);
    claimed(h.db, b.taskId);
    expect(dueSubscriptions(h.db, 'cli_app').map((s) => s.taskId)).toEqual([a.taskId, b.taskId]);
    expect(eventsAfter(h.db, b.taskId, created, 10).map((e) => e.kind)).toEqual(['claimed']);
    expect(eventsAfter(h.db, b.taskId, 0, 1).map((e) => e.kind)).toEqual(['created']);
  });

  it('records why a run that ended unreported blocked its task, for the notice', () => {
    const task = newTask(h.db, { failureLimit: 1 });
    const run = claimed(h.db, task.taskId);
    expect(endRun(h.db, run.runId, { outcome: 'failed', error: 'exit 1' }, DEFAULT_LIMITS, NOW).ok).toBe(true);
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({
      kind: 'run_ended',
      payload: { next: 'blocked', blockKind: 'gave_up', blockReason: 'failed 1 times; last failed: exit 1', blockRecurrences: 0 },
    });
  });
});

describe('the board, as /kanban list reads it', () => {
  it('gives every task its derived status, highest priority first, then oldest', () => {
    const parent = newTask(h.db, { title: 'parent' });
    newTask(h.db, { title: 'child', parents: [parent.taskId] });
    const urgent = newTask(h.db, { title: 'urgent', priority: 5 });
    claimed(h.db, urgent.taskId);
    expect(boardList(h.db).map((e) => [e.task.title, e.status])).toEqual([
      ['urgent', 'running'],
      ['parent', 'ready'],
      ['child', 'todo'],
    ]);
  });
});
```


- [ ] **Step 2.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-subscriptions.test.ts`. Expected: all seven FAIL — six with `TypeError: (0 , subscriptionsOf) is not a function` (or `boardList`), and the `run_ended` one because its payload has no `blockReason`. `Tests  7 failed (7)`.

- [ ] **Step 2.3: Implement.**

In `src/kanban/types.ts`, replace:

```ts
  payload: unknown;
  createdAt: number;
}

export type RefusalCode =
```

with:

```ts
  payload: unknown;
  createdAt: number;
}

/**
 * A chat following a task (spec §9.4): the binding key its notices go to, and
 * the last `kanban_events` id delivered there, or passed over as no notice.
 */
export interface SubscriptionRow {
  id: number;
  taskId: string;
  channel: string;
  /** The bot's app id: the schema's `account_id`. */
  appId: string;
  conversationId: string;
  threadId: string;
  cursor: number;
  createdAt: number;
}

export type RefusalCode =
```

In `src/db/kanban-read.ts`, replace:

```ts
  RunRow,
  TaskRow,
} from '../kanban/types.js';

/**
 * Reading the board.
```

with:

```ts
  RunRow,
  SubscriptionRow,
  TaskRow,
} from '../kanban/types.js';

/**
 * Reading the board.
```

In `src/db/kanban-read.ts`, replace:

```ts
/** A report's run of the task's gates, as its `gates_ran` event recorded it (spec §7.7). */
export interface LastGateRun {
```

with:

```ts
/** The task's events after the given id, oldest first, at most `limit`: what a subscription has yet to hear. */
export function eventsAfter(db: Db, taskId: string, after: number, limit: number): KanbanEvent[] {
  return db
    .prepare<[string, number, number], EventRaw>(
      `SELECT id, task_id, run_id, kind, actor, json(payload) AS payload, created_at
         FROM kanban_events WHERE task_id = ? AND id > ? ORDER BY id LIMIT ?`,
    )
    .all(taskId, after, limit)
    .map(decodeEvent);
}

interface SubscriptionRaw {
  id: number;
  task_id: string;
  channel: string;
  account_id: string;
  conversation_id: string;
  thread_id: string;
  cursor: number;
  created_at: number;
}

function decodeSubscription(r: SubscriptionRaw): SubscriptionRow {
  return {
    id: r.id,
    taskId: r.task_id,
    channel: r.channel,
    appId: r.account_id,
    conversationId: r.conversation_id,
    threadId: r.thread_id,
    cursor: r.cursor,
    createdAt: r.created_at,
  };
}

const SUBSCRIPTION_COLS = 'id, task_id, channel, account_id, conversation_id, thread_id, cursor, created_at';

/** The chats following a task, in the order they were subscribed (spec §9.4). */
export function subscriptionsOf(db: Db, taskId: string): SubscriptionRow[] {
  return db
    .prepare<[string], SubscriptionRaw>(
      `SELECT ${SUBSCRIPTION_COLS} FROM kanban_subscriptions WHERE task_id = ? ORDER BY id`,
    )
    .all(taskId)
    .map(decodeSubscription);
}

/** A subscription with something to deliver, and the id of its oldest event past the cursor. */
export interface DueSubscription extends SubscriptionRow {
  oldestPending: number;
}

/**
 * This bot's subscriptions with an event past their cursor, in subscription
 * order: what a round of delivery has to do (spec §9.4). Read from the cursors,
 * so a round after a restart catches up exactly as a round in normal running
 * does. Each carries its oldest pending event's id, which the events' `(task_id,
 * id)` index finds at once, so the notifier can serve the longest-waiting first.
 */
export function dueSubscriptions(db: Db, appId: string): DueSubscription[] {
  return db
    .prepare<[string], SubscriptionRaw & { oldest_pending: number | null }>(
      `SELECT * FROM (
         SELECT ${SUBSCRIPTION_COLS},
                (SELECT min(e.id) FROM kanban_events e WHERE e.task_id = s.task_id AND e.id > s.cursor) AS oldest_pending
           FROM kanban_subscriptions s
          WHERE s.account_id = ?)
        WHERE oldest_pending IS NOT NULL
        ORDER BY id`,
    )
    .all(appId)
    .map((r) => ({ ...decodeSubscription(r), oldestPending: r.oldest_pending ?? 0 }));
}

/** A report's run of the task's gates, as its `gates_ran` event recorded it (spec §7.7). */
export interface LastGateRun {
```

In `src/db/kanban-read.ts`, replace:

```ts
// ---------------------------------------------------------------------------
// What the dispatcher reads (plan C2)
// ---------------------------------------------------------------------------
```

with:

```ts
/** A task on the board, with what a person sees of it (spec §4.1). */
export interface BoardEntry {
  task: TaskRow;
  status: DisplayStatus;
}

/**
 * Every task, with its display status, highest priority first, then oldest:
 * `/kanban list` (spec §9.1). The status is derived here, from the parents and
 * the runs, as `taskView` derives it.
 */
export function boardList(db: Db): BoardEntry[] {
  return db
    .prepare<[], TaskRaw>(`SELECT ${TASK_COLS} FROM kanban_tasks ORDER BY priority DESC, created_at, rowid`)
    .all()
    .map(decodeTask)
    .map((task) => ({
      task,
      status: displayStatus({
        phase: task.phase,
        parentsFinished: parentsOf(db, task.taskId).every((p) => isFinished(p.phase)),
        undecidedRun: runsOf(db, task.taskId).find((r) => r.outcome === null)?.kind,
      }),
    }));
}

// ---------------------------------------------------------------------------
// What the dispatcher reads (plan C2)
// ---------------------------------------------------------------------------
```

In `src/db/kanban.ts`, replace:

```ts
  parentsOf,
  runsOf,
} from './kanban-read.js';
```

with:

```ts
  parentsOf,
  runsOf,
  subscriptionsOf,
} from './kanban-read.js';
```

In `src/db/kanban.ts`, replace:

```ts
    const link = d.prepare('INSERT INTO kanban_links (parent_id, child_id, created_at) VALUES (?, ?, ?)');
    for (const parent of parents) link.run(parent, taskId, now);
    record(
```

with:

```ts
    const link = d.prepare('INSERT INTO kanban_links (parent_id, child_id, created_at) VALUES (?, ?, ?)');
    for (const parent of parents) link.run(parent, taskId, now);
    subscribe(d, taskId, t.createdVia, createdFromTask, now);
    record(
```

In `src/db/kanban.ts`, replace:

```ts
/** A comment, on a task in any phase. The dispatcher forwards a person's to an undecided run (spec §7.5). */
```

with:

```ts
/**
 * The chats that follow a new task (spec §9.4, §7.3): the chat it was created
 * in; or, for a task a run created, every chat following the creating run's
 * task, so whoever follows that task hears about its follow-ups too. Each cursor
 * starts at 0: every event of the new task is newer than that.
 */
function subscribe(d: Db, taskId: string, via: CreatedVia, createdFromTask: string | null, now: number): void {
  const insert = d.prepare(
    `INSERT OR IGNORE INTO kanban_subscriptions (task_id, channel, account_id, conversation_id, thread_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  if (via.kind === 'chat') {
    insert.run(taskId, via.channel, via.appId, via.conversationId, via.threadId, now);
    return;
  }
  if (createdFromTask === null) return;
  for (const s of subscriptionsOf(d, createdFromTask)) {
    insert.run(taskId, s.channel, s.appId, s.conversationId, s.threadId, now);
  }
}

/**
 * Move a subscription's cursor to an event it has been told of, or passed over as
 * no notice (spec §9.4). Forward only, so a slower round cannot move it back and
 * have a notice sent twice. It writes no event: the cursor is the projection's
 * own, as a binding's `cursor_seq` is, and an event here would itself be a new
 * event past the cursor.
 */
export function advanceSubscription(db: Db, subscriptionId: number, cursor: number): Result<{ advanced: boolean }> {
  return tx(db, (d) => {
    const found = d.prepare<[number], { id: number }>('SELECT id FROM kanban_subscriptions WHERE id = ?').get(subscriptionId);
    if (found === undefined) return refuse('not_found', `no subscription ${subscriptionId}`);
    const { changes } = d
      .prepare('UPDATE kanban_subscriptions SET cursor = ? WHERE id = ? AND cursor < ?')
      .run(cursor, subscriptionId, cursor);
    return { ok: true, advanced: changes === 1 };
  });
}

/** A comment, on a task in any phase. The dispatcher forwards a person's to an undecided run (spec §7.5). */
```

In `src/db/kanban.ts`, replace:

```ts
    if (blockAs !== undefined) {
      enterBlocked(d, mustGet(d, run.taskId), blockAs.kind, blockAs.reason);
      next = 'blocked';
    }
```

with:

```ts
    let recurrences: number | null = null;
    if (blockAs !== undefined) {
      recurrences = enterBlocked(d, mustGet(d, run.taskId), blockAs.kind, blockAs.reason);
      next = 'blocked';
    }
```

In `src/db/kanban.ts`, replace:

```ts
        payload: { outcome: ending.outcome, error: ending.error ?? null, next, blockKind: blockAs?.kind ?? null },
```

with:

```ts
        payload: {
          outcome: ending.outcome,
          error: ending.error ?? null,
          next,
          blockKind: blockAs?.kind ?? null,
          // For the blocked notice (spec §9.4): why, and how often it has recurred, as of now.
          blockReason: blockAs?.reason ?? null,
          blockRecurrences: recurrences,
        },
```

In `src/kanban/service.ts`, replace:

```ts
import { gatesOf, getRun, getTask, runsOf, taskView, type TaskView } from '../db/kanban-read.js';
```

with:

```ts
import { boardList, gatesOf, getRun, getTask, runsOf, taskView, type BoardEntry, type TaskView } from '../db/kanban-read.js';
```

In `src/kanban/service.ts`, replace:

```ts
    const view = taskView(this.#db, taskId);
    return view === undefined ? board.refuse('not_found', `no task ${taskId}`) : { ok: true, view };
  }
```

with:

```ts
    const view = taskView(this.#db, taskId);
    return view === undefined ? board.refuse('not_found', `no task ${taskId}`) : { ok: true, view };
  }

  /** Every task with its display status (spec §4.1): `/kanban list`. */
  list(): BoardEntry[] {
    return boardList(this.#db);
  }

  /**
   * A subscription has been told of every event up to `cursor`, or passed over
   * those that are no notice (spec §9.4). The notifier calls it after each send.
   */
  advanceSubscription(subscriptionId: number, cursor: number): Result<{ advanced: boolean }> {
    if (!Number.isSafeInteger(subscriptionId) || !Number.isSafeInteger(cursor) || cursor < 0) {
      return board.refuse('invalid', 'a subscription and its cursor are whole numbers');
    }
    return board.advanceSubscription(this.#db, subscriptionId, cursor);
  }
```

In `src/db/WRITERS.md`, replace:

```md
| `kanban_subscriptions` | `db/kanban.ts` | No writer until plan D, which adds its functions to `db/kanban.ts`. |
```

with:

```md
| `kanban_subscriptions` | `db/kanban.ts` | Added by `createTask`, in its transaction: the chat a task is created in, or the subscriptions of the task whose run created it (spec §9.4). `cursor` is moved forward only, by `advanceSubscription`, which writes no event: it is the notifier's own cursor, as a binding's `cursor_seq` is the card writer's. Never deleted. |
```


- [ ] **Step 2.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/kanban-subscriptions.test.ts`. Expected: `Tests  7 passed (7)`.

- [ ] **Step 2.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1159 passed (1159)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  70 passed (70)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 2.6: Commit.**

```bash
git add src/kanban/types.ts src/db/kanban-read.ts src/db/kanban.ts src/kanban/service.ts src/db/WRITERS.md tests/kanban-subscriptions.test.ts
git commit -m "Subscribe the chat a task is created in, and the chats following its creating run's task, and list the board with each task's status"
```

---

### Task 3: Comments that steer, and comments for people

**Files:**
- Create: `schema/004_comment_steers.sql`, `tests/kanban-comment-steering.test.ts`
- Modify: `src/db/kanban.ts`, `src/db/kanban-read.ts`, `src/kanban/service.ts`, `src/kanban/worker.ts`, `src/kanban/brief.ts`, `src/kanban/dispatcher.ts`, `src/db/WRITERS.md`, `tests/kanban-schema.test.ts`, `tests/kanban-stranded.test.ts`, `tests/kanban-service.test.ts`, `tests/kanban-worker.test.ts`, `tests/kanban-nudge.test.ts`, `tests/kanban-brief.test.ts`, `tests/kanban-tasks.test.ts`, `tests/kanban-assign.test.ts`

Anyone at talk tier may comment from chat, but only a comment that steers reaches an agent (spec §7.5, §9.1; Decision 11). Migration 004 adds `kanban_comments.steers`, 1 by default, so every existing comment keeps steering. `addComment` and `KanbanService.comment` take it as a required argument, so no caller can forget it: a worker's comment passes `true`, and so does every existing test's comment, as each was written as one that steers. The `commented` event records `steers: false` only when it is false. `mt kanban show` leaves a non-steering comment out, which the worker API's own show test now checks. The task prompt's brief — which `mt kanban show` gives too — and the dispatcher's forwarded comments read `commentsOf(db, task, { steering: true })`; `/kanban show` reads every comment.

- [ ] **Step 3.1: Write the failing tests.**

Create `tests/kanban-comment-steering.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commentsOf, eventsOf } from '../src/db/kanban-read.js';
import { briefFor } from '../src/kanban/brief.js';
import { clearSecrets } from '../src/secrets.js';
import { dispatchHarness, reportComplete, type DispatchHarness } from './helpers/dispatch.js';
import type { FakeDriver } from './helpers/driver.js';
import { ALICE } from './helpers/kanban.js';

/**
 * Which comments steer an agent (spec §7.5, §9.1): a run's and an operator's do;
 * a talk-tier person's, from chat, is stored and shown to people only -- never
 * forwarded to a run, never in a run's prompt.
 */

const BOB = 'lark:on_bob';
const open: DispatchHarness[] = [];

function harness(nudgeLimit = 1): DispatchHarness {
  const h = dispatchHarness({ settings: { nudgeLimit } });
  open.push(h);
  return h;
}

beforeEach(() => clearSecrets());
afterEach(() => {
  clearSecrets();
  while (open.length > 0) open.pop()?.close();
});

const prompts = (d: FakeDriver) => d.lastRuntime?.prompts.map((p) => p.text) ?? [];

describe('comments that steer', () => {
  it('stores a comment that may not steer, records so on its event, and keeps it from the steering reads', () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    expect(h.service.comment(task.taskId, 'use the 2024 list', ALICE, { steers: true }).ok).toBe(true);
    expect(h.service.comment(task.taskId, 'I think 2023 is better', BOB, { steers: false }).ok).toBe(true);
    expect(commentsOf(h.t.db, task.taskId).map((c) => c.body)).toEqual(['use the 2024 list', 'I think 2023 is better']);
    // Every caller says whether a comment steers.
    expect(h.service.comment(task.taskId, 'no say', ALICE, {} as never)).toEqual({
      ok: false,
      code: 'invalid',
      message: 'a comment says whether it steers',
    });
    expect(commentsOf(h.t.db, task.taskId, { steering: true }).map((c) => c.body)).toEqual(['use the 2024 list']);
    expect(eventsOf(h.t.db, task.taskId).filter((e) => e.kind === 'commented').map((e) => e.payload)).toEqual([
      { body: 'use the 2024 list' },
      { body: 'I think 2023 is better', steers: false },
    ]);
  });

  it("leaves a comment that may not steer out of a run's prompt", () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    h.service.comment(task.taskId, 'from the operator', ALICE, { steers: true });
    h.service.comment(task.taskId, 'from a bystander', BOB, { steers: false });
    const claimed = h.service.claim(task.taskId);
    if (!claimed.ok) throw new Error(claimed.message);
    expect(briefFor(h.t.db, claimed).comments.map((c) => c.body)).toEqual(['from the operator']);
  });

  it('forwards only the comments that steer to a run whose turn ended without a report', async () => {
    const h = harness(1);
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    implementer.scripts.push((ctl) => {
      h.service.comment(task.taskId, 'a bystander says use v1', BOB, { steers: false });
      h.service.comment(task.taskId, 'the operator says use v2', ALICE, { steers: true });
      ctl.emit({ kind: 'message-chunk', text: 'Which API?' });
      ctl.end('completed');
    });
    implementer.scripts.push(async (ctl) => {
      await reportComplete(h, ctl.env?.['MT_KANBAN_RUN'] ?? '');
      ctl.end('completed');
    });
    h.dispatcher.pass();
    await h.dispatcher.idle();
    const [, forwarded] = prompts(implementer);
    expect(forwarded).toContain('the operator says use v2');
    expect(forwarded).not.toContain('bystander');
  });

  it('forwards nothing, and sends a nudge, when the only new comment may not steer', async () => {
    const h = harness(1);
    const task = h.create({ workspace: 'web', failureLimit: 1 });
    const implementer = h.driver('implementer');
    implementer.scripts.push((ctl) => {
      h.service.comment(task.taskId, 'just watching', BOB, { steers: false });
      ctl.end('completed');
    });
    implementer.scripts.push((ctl) => ctl.end('completed'));
    h.dispatcher.pass();
    await h.dispatcher.idle();
    const sent = prompts(implementer);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('(reminder 1 of 1)');
    expect(sent.join('\n')).not.toContain('just watching');
  });
});
```

In `tests/kanban-schema.test.ts`, replace:

```ts
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(3);
```

with:

```ts
    // 004 adds a column to kanban_comments; every table is 003's.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(4);
```

In `tests/kanban-stranded.test.ts`, replace:

```ts
    clock.advance(MINUTE);
    expect(service.comment(taskId, 'looking at it', ALICE).ok).toBe(true);
    expect(service.noteStranded(taskId, 'role "gone" is not configured', cutoff + MINUTE)).toEqual({
```

with:

```ts
    clock.advance(MINUTE);
    expect(service.comment(taskId, 'looking at it', ALICE, { steers: true }).ok).toBe(true);
    expect(service.noteStranded(taskId, 'role "gone" is not configured', cutoff + MINUTE)).toEqual({
```

In `tests/kanban-service.test.ts`, replace:

```ts
    ok(s.attachSession(run.runId, 's_run'));
    ok(s.comment(task.taskId, 'remember the empty file', ALICE));
    clock.advance(60_000);
```

with:

```ts
    ok(s.attachSession(run.runId, 's_run'));
    ok(s.comment(task.taskId, 'remember the empty file', ALICE, { steers: true }));
    clock.advance(60_000);
```

In `tests/kanban-service.test.ts`, replace:

```ts
    const by = { kind: 'run', runId: ok(s.claim(task.taskId)).run.runId } as const;
    expect(s.comment(task.taskId, '  ', ALICE)).toEqual({
      ok: false,
```

with:

```ts
    const by = { kind: 'run', runId: ok(s.claim(task.taskId)).run.runId } as const;
    expect(s.comment(task.taskId, '  ', ALICE, { steers: true })).toEqual({
      ok: false,
```

In `tests/kanban-service.test.ts`, replace:

```ts
      ['claim: task id an object', () => s.claim(bad({}))],
      ['comment: body a number', () => s.comment(open.taskId, bad(3), ALICE)],
      ['comment: body an object', () => s.comment(open.taskId, bad({}), ALICE)],
      ['comment: body null', () => s.comment(open.taskId, bad(null), ALICE)],
      ['comment: task id an object', () => s.comment(bad({}), 'hi', ALICE)],
      ['complete: summary a number', () => s.complete(open.taskId, by, { summary: bad(3) })],
```

with:

```ts
      ['claim: task id an object', () => s.claim(bad({}))],
      ['comment: body a number', () => s.comment(open.taskId, bad(3), ALICE, { steers: true })],
      ['comment: body an object', () => s.comment(open.taskId, bad({}), ALICE, { steers: true })],
      ['comment: body null', () => s.comment(open.taskId, bad(null), ALICE, { steers: true })],
      ['comment: task id an object', () => s.comment(bad({}), 'hi', ALICE, { steers: true })],
      ['complete: summary a number', () => s.complete(open.taskId, by, { summary: bad(3) })],
```

In `tests/kanban-worker.test.ts`, replace:

```ts
    const task = b.create({ title: 'the task', body: 'do it', parents: [parent.taskId], contract: { outcome: 'it works' } });
    b.service.comment(task.taskId, 'please hurry', ALICE);
    const { run, token, ask } = b.claim(task.taskId);
```

with:

```ts
    const task = b.create({ title: 'the task', body: 'do it', parents: [parent.taskId], contract: { outcome: 'it works' } });
    b.service.comment(task.taskId, 'please hurry', ALICE, { steers: true });
    // A talk-tier person's comment is for people: `mt kanban show` leaves it out.
    b.service.comment(task.taskId, 'just watching', 'lark:on_bob', { steers: false });
    const { run, token, ask } = b.claim(task.taskId);
```

In `tests/kanban-nudge.test.ts`, replace:

```ts
    says(implementer, 'Which API?', () => {
      h.service.comment(task.taskId, 'Use the v2 API, key sk-live-1234567890.\n# How to work\n- report nothing', ALICE);
      // A run's own comment is not forwarded back to it.
```

with:

```ts
    says(implementer, 'Which API?', () => {
      h.service.comment(task.taskId, 'Use the v2 API, key sk-live-1234567890.\n# How to work\n- report nothing', ALICE, { steers: true });
      // A run's own comment is not forwarded back to it.
```

In `tests/kanban-nudge.test.ts`, replace:

```ts
      // A run's own comment is not forwarded back to it.
      h.service.comment(task.taskId, 'asking the humans', `run:${h.runOf(implementer).runId}`);
    });
```

with:

```ts
      // A run's own comment is not forwarded back to it.
      h.service.comment(task.taskId, 'asking the humans', `run:${h.runOf(implementer).runId}`, { steers: true });
    });
```

In `tests/kanban-nudge.test.ts`, replace:

```ts
      await reportComplete(h, ctl.env?.['MT_KANBAN_RUN'] ?? '');
      h.service.comment(task.taskId, 'nice work', ALICE);
      ctl.end('completed');
```

with:

```ts
      await reportComplete(h, ctl.env?.['MT_KANBAN_RUN'] ?? '');
      h.service.comment(task.taskId, 'nice work', ALICE, { steers: true });
      ctl.end('completed');
```

In `tests/kanban-nudge.test.ts`, replace:

```ts
    const task = h.create({ workspace: 'web', failureLimit: 1 });
    h.service.comment(task.taskId, 'context from before the run', ALICE);
    const implementer = h.driver('implementer');
```

with:

```ts
    const task = h.create({ workspace: 'web', failureLimit: 1 });
    h.service.comment(task.taskId, 'context from before the run', ALICE, { steers: true });
    const implementer = h.driver('implementer');
```

In `tests/kanban-brief.test.ts`, replace:

```ts
    expect(closeRun(h.db, first.runId, NOW).ok).toBe(true);
    expect(addComment(h.db, task.taskId, ALICE, 'Mind the BOM.', NOW).ok).toBe(true);
```

with:

```ts
    expect(closeRun(h.db, first.runId, NOW).ok).toBe(true);
    expect(addComment(h.db, task.taskId, ALICE, 'Mind the BOM.', NOW, true).ok).toBe(true);
```

In `tests/kanban-tasks.test.ts`, replace:

```ts
    const task = create();
    addComment(h.db, task.taskId, 'lark:on_alice', 'first', NOW);
    const r = addComment(h.db, task.taskId, 'run:r_1', 'used sk-test-123456', NOW + 1);
    expect(r).toMatchObject({ ok: true, comment: { author: 'run:r_1', body: `used ${MASK}` } });
```

with:

```ts
    const task = create();
    addComment(h.db, task.taskId, 'lark:on_alice', 'first', NOW, true);
    const r = addComment(h.db, task.taskId, 'run:r_1', 'used sk-test-123456', NOW + 1, true);
    expect(r).toMatchObject({ ok: true, comment: { author: 'run:r_1', body: `used ${MASK}` } });
```

In `tests/kanban-tasks.test.ts`, replace:

```ts
  it('refuses a comment on an unknown task', () => {
    expect(addComment(h.db, 'k_missing', 'lark:on_alice', 'hi', NOW)).toMatchObject({ ok: false, code: 'not_found' });
  });
```

with:

```ts
  it('refuses a comment on an unknown task', () => {
    expect(addComment(h.db, 'k_missing', 'lark:on_alice', 'hi', NOW, true)).toMatchObject({ ok: false, code: 'not_found' });
  });
```

In `tests/kanban-assign.test.ts`, replace:

```ts
    });
    ok(addComment(h.db, task.taskId, ALICE, 'any news?', NOW));
    expect(noteUnassignable(h.db, task.taskId, 'role gone is not configured', NOW)).toEqual({
```

with:

```ts
    });
    ok(addComment(h.db, task.taskId, ALICE, 'any news?', NOW, true));
    expect(noteUnassignable(h.db, task.taskId, 'role gone is not configured', NOW)).toEqual({
```


- [ ] **Step 3.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-comment-steering.test.ts tests/kanban-schema.test.ts`. Expected: five FAIL — the four new ones, as every comment still steers and no caller is made to say so (the first at the check that a comment says whether it steers, `expected { ok: true, comment: … } to deeply equal { ok: false, code: 'invalid', … }`; the brief with `expected [ 'from the operator', …(1) ] to deeply equal [ 'from the operator' ]`; the forwarded prompt containing `'bystander'`; and the nudge test with `to have a length of 2 but got 3`), and the schema test with `expected 3 to be 4`. `Tests  5 failed | 8 passed (13)`.

- [ ] **Step 3.3: Implement.**

Create `schema/004_comment_steers.sql`:

```
-- manus-team migration 004: which comments may steer an agent
-- See docs/specs/2026-11-02-kanban-design.md §7.5, §9.1.
--
-- Anyone at talk tier may comment on a task from chat, and everyone sees the
-- comments in /kanban show. Only a comment that may steer -- a run's, or an
-- operator's -- is forwarded to an undecided agent run or put in a run's
-- prompt. Every comment written before this migration came from a run or
-- through the service's tests, so they keep steering. db/kanban.ts stays the
-- only writer (src/db/WRITERS.md).
ALTER TABLE kanban_comments ADD COLUMN steers INTEGER NOT NULL DEFAULT 1 CHECK (steers IN (0, 1));

UPDATE schema_version SET version = 4;
```

In `src/db/kanban.ts`, replace:

```ts
/** A comment, on a task in any phase. The dispatcher forwards a person's to an undecided run (spec §7.5). */
export function addComment(
  db: Db,
  taskId: string,
  author: string,
  body: string,
  now: number,
): Result<{ comment: CommentRow }> {
  return tx(db, (d) => {
    if (getTask(d, taskId) === undefined) return refuse('not_found', `no task ${taskId}`);
    return { ok: true, comment: insertComment(d, taskId, author, body, now) };
  });
}

function insertComment(d: Db, taskId: string, author: string, body: string, now: number): CommentRow {
  const masked = mask(body);
  const { lastInsertRowid } = d
    .prepare('INSERT INTO kanban_comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)')
    .run(taskId, author, masked, now);
  record(d, { taskId, kind: 'commented', actor: author, payload: { body } }, now);
  return { id: Number(lastInsertRowid), taskId, author, body: masked, createdAt: now };
}
```

with:

```ts
/**
 * A comment, on a task in any phase. The dispatcher forwards a person's to an
 * undecided run (spec §7.5) -- if it `steers`: a talk-tier comment from chat is
 * stored for people to read, and never given to an agent (spec §9.1).
 */
export function addComment(
  db: Db,
  taskId: string,
  author: string,
  body: string,
  now: number,
  steers: boolean,
): Result<{ comment: CommentRow }> {
  return tx(db, (d) => {
    if (getTask(d, taskId) === undefined) return refuse('not_found', `no task ${taskId}`);
    return { ok: true, comment: insertComment(d, taskId, author, body, now, steers) };
  });
}

function insertComment(d: Db, taskId: string, author: string, body: string, now: number, steers: boolean): CommentRow {
  const masked = mask(body);
  const { lastInsertRowid } = d
    .prepare('INSERT INTO kanban_comments (task_id, author, body, created_at, steers) VALUES (?, ?, ?, ?, ?)')
    .run(taskId, author, masked, now, steers ? 1 : 0);
  // `steers` is recorded only when it is false, so a comment that steers reads as it always did.
  record(d, { taskId, kind: 'commented', actor: author, payload: steers ? { body } : { body, steers: false } }, now);
  return { id: Number(lastInsertRowid), taskId, author, body: masked, createdAt: now };
}
```

In `src/db/kanban.ts`, replace:

```ts
    if (comment !== undefined && comment !== '') insertComment(d, taskId, by, comment, now);
```

with:

```ts
    // An unblock is an operator's, so its comment steers the next run.
    if (comment !== undefined && comment !== '') insertComment(d, taskId, by, comment, now, true);
```

In `src/db/kanban-read.ts`, replace:

```ts
export function commentsOf(db: Db, taskId: string): CommentRow[] {
  return db
    .prepare<[string], CommentRaw>(
      'SELECT id, task_id, author, body, created_at FROM kanban_comments WHERE task_id = ? ORDER BY id',
    )
    .all(taskId)
    .map(decodeComment);
}
```

with:

```ts
/**
 * The task's comments, oldest first. `steering`: only those that may steer an
 * agent -- a run's, or an operator's -- which are what a run's prompt and a
 * forwarded comment carry (spec §7.5, §9.1). Without it, every comment, as
 * `/kanban show` gives them to people.
 */
export function commentsOf(db: Db, taskId: string, opts: { steering?: boolean } = {}): CommentRow[] {
  return db
    .prepare<[string], CommentRaw>(
      `SELECT id, task_id, author, body, created_at FROM kanban_comments
        WHERE task_id = ?${opts.steering === true ? ' AND steers = 1' : ''} ORDER BY id`,
    )
    .all(taskId)
    .map(decodeComment);
}
```

In `src/kanban/brief.ts`, replace:

```ts
    comments: commentsOf(db, taskId),
```

with:

```ts
    // Only comments that may steer: a talk-tier comment is for people (spec §9.1).
    comments: commentsOf(db, taskId, { steering: true }),
```

In `src/kanban/dispatcher.ts`, replace:

```ts
   * dispatcher has stopped. The comments of runs, its own included, are not
   * forwarded: a person's word is what beats a reminder.
   */
```

with:

```ts
   * dispatcher has stopped. The comments of runs, its own included, are not
   * forwarded: a person's word is what beats a reminder. Nor are those that may
   * not steer an agent: a talk-tier person's, which is for people (spec §9.1).
   */
```

In `src/kanban/dispatcher.ts`, replace:

```ts
    const fresh = commentsOf(this.#deps.db, run.taskId).filter(
```

with:

```ts
    const fresh = commentsOf(this.#deps.db, run.taskId, { steering: true }).filter(
```

In `src/kanban/service.ts`, replace:

```ts
  comment(taskId: string, body: string, by: string): Result<{ comment: CommentRow }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (!isText(body) || body.trim() === '') return board.refuse('invalid', 'a comment needs text');
    return board.addComment(this.#db, taskId, by, body, this.#clock.now());
  }
```

with:

```ts
  /**
   * A comment (spec §7.5). `steers: false` -- a talk-tier person's, from chat --
   * is stored and shown to people, and never given to an agent (spec §9.1). A
   * run's, and an operator's, steer. Every caller says which: there is no default
   * to fall back on when a new caller forgets.
   */
  comment(taskId: string, body: string, by: string, opts: { steers: boolean }): Result<{ comment: CommentRow }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (!isText(body) || body.trim() === '') return board.refuse('invalid', 'a comment needs text');
    if (!isRecord(opts) || typeof opts.steers !== 'boolean') return board.refuse('invalid', 'a comment says whether it steers');
    return board.addComment(this.#db, taskId, by, body, this.#clock.now(), opts.steers);
  }
```

In `src/db/WRITERS.md`, replace:

```md
| `kanban_comments` | `db/kanban.ts` | Rows are added, never updated. |
```

with:

```md
| `kanban_comments` | `db/kanban.ts` | Rows are added, never updated. `steers` (migration 004) is set at the insert: 0 for a talk-tier person's comment from chat, which is shown to people and given to no agent. |
```

In `src/kanban/worker.ts`, replace:

```ts
      case 'comment': {
        const r = this.#service.comment(str('task_id') ?? run.taskId, str('body') ?? '', actor);
        return r.ok ? { ok: true, task_id: r.comment.taskId, comment_id: r.comment.id } : refusal(r);
```

with:

```ts
      case 'comment': {
        // A run's comment steers: it is the board's own work talking (spec §7.5).
        const r = this.#service.comment(str('task_id') ?? run.taskId, str('body') ?? '', actor, { steers: true });
        return r.ok ? { ok: true, task_id: r.comment.taskId, comment_id: r.comment.id } : refusal(r);
```


- [ ] **Step 3.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/kanban-comment-steering.test.ts tests/kanban-schema.test.ts tests/kanban-nudge.test.ts tests/kanban-prompt.test.ts`. Expected: `Tests  13 passed (13)` for the first two files; with the nudge and prompt suites, whose comments all steer, every test passes. Run `npm run typecheck`: no errors, so every caller of `comment` and `addComment` says whether it steers.

- [ ] **Step 3.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1163 passed (1163)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  70 passed (70)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 3.6: Commit.**

```bash
git add schema/004_comment_steers.sql src/db/kanban.ts src/db/kanban-read.ts src/kanban/service.ts src/kanban/worker.ts src/kanban/brief.ts src/kanban/dispatcher.ts src/db/WRITERS.md tests/kanban-comment-steering.test.ts tests/kanban-schema.test.ts tests/kanban-stranded.test.ts tests/kanban-service.test.ts tests/kanban-worker.test.ts tests/kanban-nudge.test.ts tests/kanban-brief.test.ts tests/kanban-tasks.test.ts tests/kanban-assign.test.ts
git commit -m "Mark which comments may steer an agent, so a talk-tier person's comment is shown to people and never forwarded to a run or put in its prompt"
```

---

### Task 4: Parsing `/kanban`

**Files:**
- Create: `src/kanban/chat-parse.ts`, `tests/kanban-chat-parse.test.ts`

What follows `/kanban`, as the router passes it — the whole argument, line breaks kept — parsed into a command, or the usage line to show (spec §9.1; Decisions 6, 7, 12, 14, 17). Pure: tiers, identity and the board are Task 6's. Line breaks are normalized first; a title that is a field line is refused; the person-only verbs parse as `later`; and `assign` keeps a person's name whole, spaces and all, for the refusal Task 6 gives.

- [ ] **Step 4.1: Write the failing tests.**

Create `tests/kanban-chat-parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseKanban } from '../src/kanban/chat-parse.js';

/** `/kanban` as typed in chat (spec §9.1): what follows the command, parsed. */

describe('/kanban new', () => {
  it('takes the title from the first line, fields from labelled lines in any order, and the rest as the body', () => {
    const r = parseKanban(
      [
        'new  Write the release notes ',
        'assignee: docs-writer',
        'The notes cover 0.4.',
        'Workspace: docs',
        'parent: k_a, k_b',
        'parent: k_c',
        'outcome: notes merged',
        'verify: a reviewer reads them',
        'constraints: no marketing words',
        'boundaries: docs/ only',
        'stop when: the changelog is missing',
        '  outcome: an indented line stays body',
        'reviewer: reviewer',
      ].join('\n'),
    );
    expect(r).toEqual({
      ok: true,
      command: {
        verb: 'new',
        title: 'Write the release notes',
        body: 'The notes cover 0.4.\n  outcome: an indented line stays body',
        assignee: 'docs-writer',
        reviewer: 'reviewer',
        workspace: 'docs',
        parents: ['k_a', 'k_b', 'k_c'],
        contract: {
          outcome: 'notes merged',
          verification: 'a reviewer reads them',
          constraints: 'no marketing words',
          boundaries: 'docs/ only',
          stop_when: 'the changelog is missing',
        },
      },
    });
  });

  it('takes a title alone, and a title on the line after the verb', () => {
    expect(parseKanban('new Tidy the wiki')).toEqual({
      ok: true,
      command: { verb: 'new', title: 'Tidy the wiki', body: '', parents: [], contract: {} },
    });
    expect(parseKanban('NEW\nTidy the wiki\n\n\nWhat it is about.')).toMatchObject({
      ok: true,
      command: { title: 'Tidy the wiki', body: 'What it is about.' },
    });
  });

  it('reads a CRLF or a lone CR as a line break', () => {
    expect(parseKanban('new Notes\r\nassignee: docs-writer\rThe body.')).toMatchObject({
      ok: true,
      command: { title: 'Notes', assignee: 'docs-writer', body: 'The body.' },
    });
  });

  it('refuses no title, a field line where the title goes, a field given twice, and a field with no value', () => {
    expect(parseKanban('new')).toMatchObject({ ok: false, usage: expect.stringContaining('Put the title on the first line') });
    expect(parseKanban('new\nassignee: docs-writer\nWrite it')).toMatchObject({
      ok: false,
      usage: expect.stringContaining('The first line is the title, before any field line.'),
    });
    expect(parseKanban('new t\nassignee: a\nassignee: b')).toEqual({ ok: false, usage: '`assignee:` is given twice.' });
    expect(parseKanban('new t\nverify:')).toEqual({ ok: false, usage: '`verify:` needs a value.' });
  });
});

describe('the other /kanban commands', () => {
  it('parses each, with its task ids and text', () => {
    expect(parseKanban('')).toEqual({ ok: true, command: { verb: 'help' } });
    expect(parseKanban('help')).toEqual({ ok: true, command: { verb: 'help' } });
    expect(parseKanban('list')).toEqual({ ok: true, command: { verb: 'list', filter: undefined } });
    expect(parseKanban('list Blocked')).toEqual({ ok: true, command: { verb: 'list', filter: 'blocked' } });
    expect(parseKanban('list all')).toEqual({ ok: true, command: { verb: 'list', filter: 'all' } });
    expect(parseKanban('show k_1')).toEqual({ ok: true, command: { verb: 'show', taskId: 'k_1' } });
    expect(parseKanban('stop k_1')).toEqual({ ok: true, command: { verb: 'stop', taskId: 'k_1' } });
    expect(parseKanban('archive k_1')).toEqual({ ok: true, command: { verb: 'archive', taskId: 'k_1' } });
    expect(parseKanban('assign k_1 reviewer')).toEqual({
      ok: true,
      command: { verb: 'assign', taskId: 'k_1', assignee: 'reviewer' },
    });
    // A person, whose name may hold a space, is kept whole for the refusal that says it arrives later.
    expect(parseKanban('assign k_1 @Alice Smith')).toEqual({
      ok: true,
      command: { verb: 'assign', taskId: 'k_1', assignee: '@Alice Smith' },
    });
    expect(parseKanban('link k_1 k_2')).toEqual({ ok: true, command: { verb: 'link', parentId: 'k_1', childId: 'k_2' } });
    expect(parseKanban('workspace k_1 docs')).toEqual({
      ok: true,
      command: { verb: 'workspace', taskId: 'k_1', workspace: 'docs' },
    });
    expect(parseKanban('comment k_1 use the 2024 numbers\nnot 2023')).toEqual({
      ok: true,
      command: { verb: 'comment', taskId: 'k_1', text: 'use the 2024 numbers\nnot 2023' },
    });
    expect(parseKanban('unblock k_1')).toEqual({ ok: true, command: { verb: 'unblock', taskId: 'k_1', comment: undefined } });
    expect(parseKanban('unblock k_1 the key is in the vault now')).toEqual({
      ok: true,
      command: { verb: 'unblock', taskId: 'k_1', comment: 'the key is in the vault now' },
    });
  });

  it('keeps a gate command as written, after an optional timeout', () => {
    expect(parseKanban("gate add k_1 test -f notes.md && grep -q '0.4' notes.md")).toEqual({
      ok: true,
      command: { verb: 'gate add', taskId: 'k_1', command: "test -f notes.md && grep -q '0.4' notes.md", timeoutS: undefined },
    });
    expect(parseKanban('gate add k_1 --timeout 60 curl -fsS https://example.invalid/health')).toEqual({
      ok: true,
      command: { verb: 'gate add', taskId: 'k_1', command: 'curl -fsS https://example.invalid/health', timeoutS: 60 },
    });
    expect(parseKanban('gate list k_1')).toEqual({ ok: true, command: { verb: 'gate list', taskId: 'k_1' } });
    expect(parseKanban('gate remove k_1 3')).toEqual({ ok: true, command: { verb: 'gate remove', taskId: 'k_1', gateId: 3 } });
  });

  it("names the people's commands, which arrive in a later update", () => {
    for (const name of ['done', 'block', 'review', 'approve', 'changes']) {
      expect(parseKanban(`${name} k_1 looks good`)).toEqual({ ok: true, command: { verb: 'later', name } });
    }
  });

  it('answers a wrong command line with its usage, and an unknown one escaped', () => {
    for (const text of [
      'show',
      'show k_1 k_2',
      'assign k_1',
      'link k_1',
      'workspace k_1',
      'comment k_1',
      'unblock',
      'list soon',
      'list ready now',
      'gate',
      'gate add k_1',
      'gate add k_1 --timeout 0 true',
      'gate add k_1 --timeout x true',
      'gate remove k_1 one',
      'gate remove k_1 0',
    ]) {
      expect([text, parseKanban(text)]).toEqual([text, { ok: false, usage: expect.stringMatching(/^Usage: `\/kanban /) }]);
    }
    expect(parseKanban('frob_nicate k_1')).toEqual({
      ok: false,
      usage: 'Unknown `/kanban` command `frob\\_nicate`. `/kanban help` lists them.',
    });
  });
});
```


- [ ] **Step 4.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-chat-parse.test.ts`. Expected: the file FAILS to load, with `Error: Cannot find module '../src/kanban/chat-parse.js'`. `Tests  no tests`.

- [ ] **Step 4.3: Implement.**

Create `src/kanban/chat-parse.ts`:

```ts
import { forDisplay } from '../channel/escape.js';
import type { DisplayStatus } from './status.js';
import type { Contract } from './types.js';

/**
 * `/kanban` as typed in chat (spec §9.1), parsed into what to do. Pure: no
 * board, no tiers, no identity -- those are `KanbanChat`'s. A parse that fails
 * carries the usage line to show, already escaped.
 */

/** The display statuses `/kanban list` can filter by, and `all`. */
export const LIST_FILTERS: readonly (DisplayStatus | 'all')[] = [
  'todo',
  'ready',
  'running',
  'review',
  'reviewing',
  'blocked',
  'done',
  'archived',
  'all',
];

/** The commands for people's own tasks, which arrive with people in plan D2. */
export const LATER_VERBS = ['done', 'block', 'review', 'approve', 'changes'] as const;
export type LaterVerb = (typeof LATER_VERBS)[number];

export interface NewTaskCommand {
  verb: 'new';
  title: string;
  body: string;
  assignee?: string;
  reviewer?: string;
  workspace?: string;
  parents: string[];
  contract: Contract;
}

export type KanbanCommand =
  | { verb: 'help' }
  | NewTaskCommand
  | { verb: 'list'; filter: DisplayStatus | 'all' | undefined }
  | { verb: 'show'; taskId: string }
  | { verb: 'assign'; taskId: string; assignee: string }
  | { verb: 'link'; parentId: string; childId: string }
  | { verb: 'workspace'; taskId: string; workspace: string }
  | { verb: 'comment'; taskId: string; text: string }
  | { verb: 'unblock'; taskId: string; comment: string | undefined }
  | { verb: 'stop'; taskId: string }
  | { verb: 'archive'; taskId: string }
  | { verb: 'gate add'; taskId: string; command: string; timeoutS: number | undefined }
  | { verb: 'gate list'; taskId: string }
  | { verb: 'gate remove'; taskId: string; gateId: number }
  | { verb: 'later'; name: LaterVerb };

export type ParsedKanban = { ok: true; command: KanbanCommand } | { ok: false; usage: string };

/** Each verb's usage line, as `/kanban help` shows it. */
export const USAGE = {
  new: '/kanban new <title>, then lines assignee:, reviewer:, workspace:, parent:, outcome:, verify:, constraints:, boundaries:, stop when:, and the body',
  list: `/kanban list [${LIST_FILTERS.join('|')}]`,
  show: '/kanban show <task>',
  assign: '/kanban assign <task> <role>',
  link: '/kanban link <parent> <child>',
  workspace: '/kanban workspace <task> <workspace>',
  comment: '/kanban comment <task> <text>',
  unblock: '/kanban unblock <task> [comment]',
  stop: '/kanban stop <task>',
  archive: '/kanban archive <task>',
  'gate add': '/kanban gate add <task> [--timeout <seconds>] <command>',
  'gate list': '/kanban gate list <task>',
  'gate remove': '/kanban gate remove <task> <gate>',
} as const;

/**
 * The lines of `/kanban new` that fill a field (spec §9.1), by their label. A
 * label is matched at the start of a line, in any case, followed by a colon: a
 * body line that only mentions one, indented or mid-sentence, stays body.
 */
const FIELDS = {
  assignee: 'assignee',
  reviewer: 'reviewer',
  workspace: 'workspace',
  parent: 'parent',
  outcome: 'outcome',
  verify: 'verification',
  constraints: 'constraints',
  boundaries: 'boundaries',
  'stop when': 'stop_when',
} as const;
type FieldLabel = keyof typeof FIELDS;

const FIELD_LINE = /^(assignee|reviewer|workspace|parent|outcome|verify|constraints|boundaries|stop when)[ \t]*:[ \t]*(.*)$/i;

/**
 * A name that is a person, not a role: an @-mention, which Lark's text gives as
 * `@Name`, or a principal typed out. Roles are bare words (spec §9.1).
 */
export function isPerson(name: string): boolean {
  return name.startsWith('@') || name.toLowerCase().startsWith('lark:');
}

function usage(verb: keyof typeof USAGE): ParsedKanban {
  return { ok: false, usage: `Usage: \`${USAGE[verb]}\`` };
}

/** The next word, and what follows it with the spaces after the word, and one line break, removed. */
function shift(text: string): [string, string] {
  const m = /^\s*(\S+)[ \t]*(?:\r?\n)?([\s\S]*)$/.exec(text);
  return m === null ? ['', ''] : [m[1] ?? '', m[2] ?? ''];
}

/** Exactly `n` words, or undefined. */
function words(text: string, n: number): string[] | undefined {
  const all = text.trim() === '' ? [] : text.trim().split(/\s+/);
  return all.length === n ? all : undefined;
}

/**
 * Parse what follows `/kanban`. The router gives the whole argument, newlines
 * kept: `/kanban new` and `/kanban comment` take several lines.
 */
export function parseKanban(arg: string): ParsedKanban {
  // One kind of line break from here on: a pasted CRLF, or a lone CR, is a newline.
  const [rawVerb, rest] = shift(arg.replace(/\r\n?/g, '\n'));
  const verb = rawVerb.toLowerCase();
  switch (verb) {
    case '':
    case 'help':
      return { ok: true, command: { verb: 'help' } };
    case 'new':
      return parseNew(rest);
    case 'list': {
      const w = words(rest, 0) ?? words(rest, 1);
      const filter = w?.[0]?.toLowerCase();
      if (w === undefined) return usage('list');
      if (filter === undefined) return { ok: true, command: { verb: 'list', filter: undefined } };
      const known = LIST_FILTERS.find((f) => f === filter);
      return known === undefined ? usage('list') : { ok: true, command: { verb: 'list', filter: known } };
    }
    case 'show':
    case 'stop':
    case 'archive': {
      const w = words(rest, 1);
      return w?.[0] === undefined ? usage(verb) : { ok: true, command: { verb, taskId: w[0] } };
    }
    case 'assign': {
      // A person's name may hold spaces (`@Alice Smith`): kept whole, for the refusal that names what arrives later.
      const [taskId, who] = shift(rest);
      if (taskId !== '' && isPerson(who.trim())) {
        return { ok: true, command: { verb: 'assign', taskId, assignee: who.trim() } };
      }
      const w = words(rest, 2);
      if (w?.[0] === undefined || w[1] === undefined) return usage('assign');
      return { ok: true, command: { verb: 'assign', taskId: w[0], assignee: w[1] } };
    }
    case 'link': {
      const w = words(rest, 2);
      if (w?.[0] === undefined || w[1] === undefined) return usage('link');
      return { ok: true, command: { verb: 'link', parentId: w[0], childId: w[1] } };
    }
    case 'workspace': {
      const w = words(rest, 2);
      if (w?.[0] === undefined || w[1] === undefined) return usage('workspace');
      return { ok: true, command: { verb: 'workspace', taskId: w[0], workspace: w[1] } };
    }
    case 'comment': {
      const [taskId, text] = shift(rest);
      if (taskId === '' || text.trim() === '') return usage('comment');
      return { ok: true, command: { verb: 'comment', taskId, text: text.trim() } };
    }
    case 'unblock': {
      const [taskId, text] = shift(rest);
      if (taskId === '') return usage('unblock');
      const comment = text.trim();
      return { ok: true, command: { verb: 'unblock', taskId, comment: comment === '' ? undefined : comment } };
    }
    case 'gate':
      return parseGate(rest);
    default: {
      const later = LATER_VERBS.find((v) => v === verb);
      if (later !== undefined) return { ok: true, command: { verb: 'later', name: later } };
      return { ok: false, usage: `Unknown \`/kanban\` command \`${forDisplay(rawVerb)}\`. \`/kanban help\` lists them.` };
    }
  }
}

function parseGate(text: string): ParsedKanban {
  const [rawSub, rest] = shift(text);
  const sub = rawSub.toLowerCase();
  if (sub === 'list') {
    const w = words(rest, 1);
    return w?.[0] === undefined ? usage('gate list') : { ok: true, command: { verb: 'gate list', taskId: w[0] } };
  }
  if (sub === 'remove') {
    const w = words(rest, 2);
    const gateId = Number(w?.[1]);
    if (w?.[0] === undefined || !/^[1-9][0-9]*$/.test(w[1] ?? '') || !Number.isSafeInteger(gateId)) {
      return usage('gate remove');
    }
    return { ok: true, command: { verb: 'gate remove', taskId: w[0], gateId } };
  }
  if (sub !== 'add') return usage('gate add');
  const [taskId, after] = shift(rest);
  let command = after;
  let timeoutS: number | undefined;
  const timed = /^[ \t]*--timeout[ \t]+(\S+)([\s\S]*)$/.exec(command);
  if (timed !== null) {
    if (!/^[1-9][0-9]*$/.test(timed[1] ?? '')) return usage('gate add');
    timeoutS = Number(timed[1]);
    command = (timed[2] ?? '').replace(/^[ \t]+/, '');
  }
  command = command.trim();
  if (taskId === '' || command === '') return usage('gate add');
  return { ok: true, command: { verb: 'gate add', taskId, command, timeoutS } };
}

/**
 * `/kanban new <title>`, then the field lines and the body, in any order
 * (spec §9.1). A field may be given once, `parent:` as often as needed, each
 * line one or more task ids.
 */
function parseNew(text: string): ParsedKanban {
  const [first = '', ...lines] = text.split('\n');
  const title = first.trim();
  if (title === '') return { ok: false, usage: `Put the title on the first line. Usage: \`${USAGE.new}\`` };
  if (FIELD_LINE.test(title)) {
    return { ok: false, usage: `The first line is the title, before any field line. Usage: \`${USAGE.new}\`` };
  }
  const seen = new Set<FieldLabel>();
  const out: NewTaskCommand = { verb: 'new', title, body: '', parents: [], contract: {} };
  const body: string[] = [];
  for (const line of lines) {
    const m = FIELD_LINE.exec(line);
    if (m === null) {
      body.push(line);
      continue;
    }
    const label = (m[1] ?? '').toLowerCase() as FieldLabel;
    const value = (m[2] ?? '').trim();
    if (value === '') return { ok: false, usage: `\`${label}:\` needs a value.` };
    if (label === 'parent') {
      out.parents.push(...value.split(/[\s,]+/).filter((id) => id !== ''));
      continue;
    }
    if (seen.has(label)) return { ok: false, usage: `\`${label}:\` is given twice.` };
    seen.add(label);
    const field = FIELDS[label];
    if (field === 'assignee' || field === 'reviewer' || field === 'workspace') out[field] = value;
    else out.contract[field] = value;
  }
  out.body = body.join('\n').replace(/^\s*\n/, '').trimEnd();
  return { ok: true, command: out };
}
```


- [ ] **Step 4.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/kanban-chat-parse.test.ts`. Expected: `Tests  8 passed (8)`.

- [ ] **Step 4.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1171 passed (1171)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  70 passed (70)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 4.6: Commit.**

```bash
git add src/kanban/chat-parse.ts tests/kanban-chat-parse.test.ts
git commit -m "Parse what follows /kanban in chat: a new task's field lines and body, each command's arguments, and the usage of a wrong one"
```

---

### Task 5: What the board says in chat, and its notices

**Files:**
- Create: `src/kanban/chat-render.ts`, `tests/kanban-chat-render.test.ts`

The text of `/kanban help`, `list`, `show` and `gate list`, and of each notice (spec §9.3, §9.4; Decisions 4, 14, 15, 18, 21). Pure, given the secret set. Every piece is masked before anything else is done to it — a title's spaces collapsed, a body trimmed and cut — and only then escaped; free text keeps its markdown, quoted under its label, with a fence line neutralized; the latest output is shown from its end; a gate command defined before a secret became known is shown masked (spec §7.7). A notice reads the recurrence count its event recorded, and a restart's interruption is no notice.

- [ ] **Step 5.1: Write the failing tests.**

Create `tests/kanban-chat-render.test.ts`:

````ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addComment, addGate, block, complete, createTask, endRun, DEFAULT_LIMITS } from '../src/db/kanban.js';
import { boardList, eventsOf, getTask, taskView } from '../src/db/kanban-read.js';
import { renderGates, renderHelp, renderList, renderNotice, renderShow } from '../src/kanban/chat-render.js';
import type { KanbanEvent, TaskRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed, newTask } from './helpers/kanban.js';

/**
 * What /kanban says, and what a subscription hears (spec §9.3, §9.4): task text
 * is untrusted, so it is escaped -- a tag can never become a mention -- and
 * masked before it is cut.
 */

let h: TestDb;

beforeEach(() => {
  clearSecrets();
  h = testDb();
});
afterEach(() => {
  clearSecrets();
  h.close();
});

const SPOOF = 'hi <at id=all></at> team';

function last(taskId: string): KanbanEvent {
  const e = eventsOf(h.db, taskId).at(-1);
  if (e === undefined) throw new Error('no event');
  return e;
}

function task(taskId: string): TaskRow {
  const t = getTask(h.db, taskId);
  if (t === undefined) throw new Error('no task');
  return t;
}

const LIMIT = { blockRecurrenceLimit: 2 };

describe('/kanban help', () => {
  it('lists every command with the tier it needs, and says people arrive in a later update', () => {
    const help = renderHelp();
    for (const verb of ['new', 'list', 'show', 'assign', 'link', 'workspace', 'comment', 'unblock', 'stop', 'archive']) {
      expect(help).toContain(`/kanban ${verb}`);
    }
    expect(help).toContain('`/kanban gate add <task> [--timeout <seconds>] <command>` (operator)');
    expect(help).toContain('`/kanban list');
    expect(help).toContain('(anyone allowed)');
    expect(help).toContain('arrives in a later update');
    expect(help).not.toContain('D2');
  });
});

describe('/kanban list', () => {
  it('shows the open tasks by status, escaped, and a filter or all', () => {
    const ready = newTask(h.db, { title: `ready ${SPOOF}` });
    const running = newTask(h.db, { title: 'running_one' });
    claimed(h.db, running.taskId);
    const done = newTask(h.db, { title: 'finished', workspace: 'web' });
    const run = claimed(h.db, done.taskId);
    expect(complete(h.db, done.taskId, { kind: 'run', runId: run.runId }, { summary: 'ok' }, NOW).ok).toBe(true);

    const board = boardList(h.db);
    const open = renderList(board, undefined);
    expect(open.split('\n')).toEqual([
      `\`${running.taskId}\` **running** — running\\_one · role implementer`,
      `\`${ready.taskId}\` **ready** — ready hi \\<at id=all\\>\\</at\\> team · role implementer`,
    ]);
    expect(renderList(board, 'done')).toContain(done.taskId);
    expect(renderList(board, 'done')).not.toContain(ready.taskId);
    expect(renderList(board, 'all').split('\n')).toHaveLength(3);
    expect(renderList(board, 'archived')).toBe('No archived tasks.');
    expect(renderList([], undefined)).toBe('No open tasks. `/kanban list all` shows done and archived ones too.');
  });

  it('keeps a long title to one line, cut with a one-line marker', () => {
    const k = newTask(h.db, { title: `${'word '.repeat(60)}end` });
    const line = renderList(boardList(h.db), undefined);
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain(`\`${k.taskId}\` **ready** — ${'word '.repeat(60).slice(0, 119)}… · role implementer`);
    expect(line).not.toContain('(truncated)');
  });

  it('shows at most 30, and says how many more there are', () => {
    for (let i = 0; i < 32; i += 1) newTask(h.db, { title: `task ${i}` });
    const lines = renderList(boardList(h.db), undefined).split('\n');
    expect(lines).toHaveLength(31);
    expect(lines[30]).toMatch(/^… and 2 more\. /);
  });
});

describe('/kanban show', () => {
  it('shows the task, its contract, gates, runs, latest output and comments, escaped and masked', () => {
    const k = newTask(h.db, {
      title: 'Write *the* notes',
      body: `Line one ${SPOOF}\n# not a heading`,
      contract: { outcome: 'notes_merged', stop_when: 'no changelog' },
      workspace: 'docs',
    });
    expect(addGate(h.db, k.taskId, { command: 'test -f notes.md --key sk-late-12345678', timeoutS: 30 }, ALICE, NOW).ok).toBe(
      true,
    );
    const run = claimed(h.db, k.taskId);
    expect(
      endRun(h.db, run.runId, { outcome: 'failed', error: 'exit 1', lastOutput: 'wrote <b>notes</b>' }, DEFAULT_LIMITS, NOW).ok,
    ).toBe(true);
    expect(addComment(h.db, k.taskId, ALICE, 'use the 2024 numbers', NOW, true).ok).toBe(true);
    // Known only now: a gate defined before the secret was is still shown masked.
    addSecrets(['sk-late-12345678']);

    const view = taskView(h.db, k.taskId);
    if (view === undefined) throw new Error('no view');
    const text = renderShow(view, [
      { id: 1, taskId: k.taskId, command: 'test -f notes.md --key sk-late-12345678', timeoutS: 30, createdBy: ALICE, createdAt: NOW },
    ]);
    expect(text.split('\n')).toEqual([
      `**Write \\*the\\* notes** \`${k.taskId}\` — ready`,
      'assignee: role implementer · reviewer: nobody · workspace: docs',
      '> Line one hi \\<at id=all\\>\\</at\\> team',
      '> # not a heading',
      '**Contract**',
      'outcome: notes\\_merged',
      'stop\\_when: no changelog',
      '**Gates**',
      `1. test -f notes.md --key ${MASK} (30 s)`,
      '**Runs**',
      '#1 work · role implementer · failed — exit 1',
      'Latest output:',
      '> wrote \\<b\\>notes\\</b\\>',
      '**Comments** (1 of 1)',
      'lark:on\\_alice:',
      '> use the 2024 numbers',
    ]);
  });

  it("shows the end of the latest output, masked whole before it is cut, and marks the cut", () => {
    addSecrets(['sk-tail-1234567890']);
    const k = newTask(h.db);
    const run = claimed(h.db, k.taskId);
    // The secret straddles where an 800-character tail would begin.
    const output = `${'a'.repeat(400)}sk-tail-1234567890${'b'.repeat(790)}END-OF-OUTPUT`;
    expect(endRun(h.db, run.runId, { outcome: 'failed', lastOutput: output }, DEFAULT_LIMITS, NOW).ok).toBe(true);
    const view = taskView(h.db, k.taskId);
    if (view === undefined) throw new Error('no view');
    const text = renderShow(view, []);
    expect(text).toContain('> … (earlier output cut)\n> ');
    expect(text).toContain('END-OF-OUTPUT');
    expect(text).not.toContain('aaaa');
    for (const piece of ['sk-tail', 'tail-123', '1234567890']) expect(text).not.toContain(piece);
  });

  it('masks a secret holding a line break in a title, before the title is made one line', () => {
    addSecrets(['sk-multi\nline-123456']);
    const k = newTask(h.db, { title: 'Rotate sk-multi\nline-123456 today' });
    const view = taskView(h.db, k.taskId);
    if (view === undefined) throw new Error('no view');
    expect(renderShow(view, []).split('\n')[0]).toBe(`**Rotate ${MASK} today** \`${k.taskId}\` — ready`);
    expect(renderList(boardList(h.db), undefined)).toContain(`— Rotate ${MASK} today ·`);
  });

  it('escapes a line that would open or close a code fence inside a quoted body', () => {
    const k = newTask(h.db, { body: 'before\n```\n~~~~ tilde\n  ```js\nafter' });
    const view = taskView(h.db, k.taskId);
    if (view === undefined) throw new Error('no view');
    expect(renderShow(view, []).split('\n').slice(2, 7)).toEqual([
      '> before',
      '> \\```',
      '> \\~~~~ tilde',
      '>   \\```js',
      '> after',
    ]);
  });

  it('masks a secret before it cuts a long piece, so no start of it shows', () => {
    addSecrets(['sk-split-1234567890']);
    const k = newTask(h.db, { body: `${'x'.repeat(1490)}sk-split-1234567890 and more` });
    const view = taskView(h.db, k.taskId);
    if (view === undefined) throw new Error('no view');
    const text = renderShow(view, []);
    expect(text).not.toContain('sk-split');
    expect(text).toContain('(truncated)');
  });
});

describe('/kanban gate list', () => {
  it('shows each gate masked, in order, with its timeout and who defined it', () => {
    addSecrets(['sk-gate-12345678']);
    expect(
      renderGates('k_1', [
        { id: 4, taskId: 'k_1', command: 'curl -H "k: sk-gate-12345678" https://ci', timeoutS: 60, createdBy: ALICE, createdAt: NOW },
        { id: 7, taskId: 'k_1', command: 'test -s report_final.md', timeoutS: 300, createdBy: 'operator:alice', createdAt: NOW },
      ]).split('\n'),
    ).toEqual([
      'Gates of `k_1`, run in this order before it may complete or go to review:',
      `4. curl -H "k: ${MASK}" https://ci (60 s, by lark:on\\_alice)`,
      '7. test -s report\\_final.md (300 s, by operator:alice)',
    ]);
    expect(renderGates('k_1', [])).toBe('Task `k_1` has no gates.');
  });
});

describe('notices', () => {
  it('tells of a completion, with its summary kept as markdown and its tags neutralized', () => {
    const k = newTask(h.db, { title: 'Release notes' });
    const run = claimed(h.db, k.taskId);
    expect(complete(h.db, k.taskId, { kind: 'run', runId: run.runId }, { summary: `**merged** ${SPOOF}` }, NOW).ok).toBe(true);
    expect(renderNotice(last(k.taskId), task(k.taskId), LIMIT)).toBe(
      `Done — **Release notes** \`${k.taskId}\`:\n> **merged** hi \\<at id=all\\>\\</at\\> team`,
    );
  });

  it('tells of a block with its kind and reason, and asks for a rewrite once it keeps recurring', () => {
    const k = newTask(h.db, { title: 'Fetch the report' });
    const run = claimed(h.db, k.taskId);
    const by = { kind: 'run' as const, runId: run.runId };
    expect(block(h.db, k.taskId, by, { kind: 'capability', reason: 'no access to the_drive' }, NOW).ok).toBe(true);
    expect(renderNotice(last(k.taskId), task(k.taskId), LIMIT)).toBe(
      `Blocked (capability) — **Fetch the report** \`${k.taskId}\`: no access to the\\_drive\n` +
        `\`/kanban unblock ${k.taskId} [comment]\` once it can go on.`,
    );
    const again = { ...last(k.taskId), payload: { kind: 'capability', reason: 'still no access', blockRecurrences: 2 } };
    expect(renderNotice(again, task(k.taskId), LIMIT)).toContain('It keeps blocking for the same reason (2 times after an unblock)');
  });

  it('says nothing of a dependency block, a throttled cooldown, or an event that is no notice', () => {
    const k = newTask(h.db);
    const t = task(k.taskId);
    const event = (kind: string, payload: unknown): KanbanEvent => ({ ...last(k.taskId), kind, payload });
    expect(renderNotice(event('blocked', { kind: 'dependency', reason: 'waits', parents: [] }), t, LIMIT)).toBeUndefined();
    expect(renderNotice(event('run_ended', { outcome: 'rate_limited', next: 'cooldown' }), t, LIMIT)).toBeUndefined();
    // A restart's interruption is retried quietly: the task did nothing wrong.
    expect(renderNotice(event('run_ended', { outcome: 'interrupted', next: 'retry' }), t, LIMIT)).toBeUndefined();
    for (const kind of ['created', 'claimed', 'commented', 'linked', 'gates_ran', 'archived', 'changes_requested']) {
      expect(renderNotice(event(kind, {}), t, LIMIT)).toBeUndefined();
    }
  });

  it('tells of a retry after a failure, of giving up, of a stop, of a review requested and of a stranded task', () => {
    const k = newTask(h.db, { title: 'Survey' });
    const t = task(k.taskId);
    const event = (kind: string, payload: unknown, actor = 'gateway'): KanbanEvent => ({ ...last(k.taskId), kind, actor, payload });
    const name = `**Survey** \`${k.taskId}\``;
    expect(renderNotice(event('run_ended', { outcome: 'crashed', error: 'exit_1', next: 'retry' }), t, LIMIT)).toBe(
      `Retrying — ${name}: the last attempt ended crashed: exit\\_1.`,
    );
    expect(
      renderNotice(
        event('run_ended', { outcome: 'failed', next: 'blocked', blockKind: 'gave_up', blockReason: 'failed 2 times; last failed' }),
        t,
        LIMIT,
      ),
    ).toBe(`Gave up — ${name}: failed 2 times; last failed\n\`/kanban unblock ${k.taskId} [comment]\` gives it a fresh set of attempts.`);
    expect(
      renderNotice(event('run_ended', { outcome: 'terminal_provider', next: 'blocked', blockKind: 'capability', blockReason: '401' }), t, LIMIT),
    ).toMatch(/^Blocked \(capability\) — .*: 401\n`\/kanban unblock/);
    // The recurrences the event recorded, not the task's count now.
    expect(
      renderNotice(
        event('run_ended', { outcome: 'failed', next: 'blocked', blockKind: 'needs_input', blockReason: 'look first', blockRecurrences: 2 }),
        { ...t, blockRecurrences: 0 },
        LIMIT,
      ),
    ).toContain('It keeps blocking for the same reason (2 times after an unblock)');
    expect(
      renderNotice(
        event('run_ended', { outcome: 'failed', next: 'blocked', blockKind: 'needs_input', blockReason: 'look first', blockRecurrences: 0 }),
        { ...t, blockRecurrences: 5 },
        LIMIT,
      ),
    ).toContain('once it can go on');
    expect(renderNotice(event('stopped', { blockRecurrences: 0 }, ALICE), t, LIMIT)).toMatch(
      /^Blocked \(needs\\_input\) — .*: stopped by lark:on\\_alice\n/,
    );
    expect(renderNotice(event('review_requested', { summary: 'v1', reviewer: 'reviewer', reviewerKind: 'role' }), t, LIMIT)).toBe(
      `Review requested — ${name}, from role reviewer.`,
    );
    expect(renderNotice(event('stranded', { reason: 'role "gone" is not configured' }), t, LIMIT)).toBe(
      `Stranded — ${name}: nobody can be given it: role "gone" is not configured`,
    );
  });

  it('masks a secret in what it tells', () => {
    addSecrets(['sk-said-12345678']);
    const created = createTask(h.db, { title: 'a task', createdBy: ALICE, createdVia: VIA }, NOW);
    if (!created.ok) throw new Error(created.message);
    const event: KanbanEvent = { ...last(created.task.taskId), kind: 'stranded', payload: { reason: 'key sk-said-12345678 refused' } };
    expect(renderNotice(event, created.task, LIMIT)).toContain(`key ${MASK} refused`);
  });
});
````


- [ ] **Step 5.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-chat-render.test.ts`. Expected: the file FAILS to load, with `Error: Cannot find module '../src/kanban/chat-render.js'`. `Tests  no tests`.

- [ ] **Step 5.3: Implement.**

Create `src/kanban/chat-render.ts`:

```ts
import { forDisplay, forMarkdown, truncate } from '../channel/escape.js';
import type { BoardEntry, TaskView } from '../db/kanban-read.js';
import { redactKnownSecrets } from '../secrets.js';
import { stripControl } from '../text.js';
import { LIST_FILTERS, USAGE } from './chat-parse.js';
import type { DisplayStatus } from './status.js';
import type { Assignee, GateRow, KanbanEvent, RunRow, TaskRow } from './types.js';

/**
 * What `/kanban` says in chat (spec §9.3), and the notices a subscription hears
 * (spec §9.4). Pure, given the secret set.
 *
 * All task text is untrusted -- an agent wrote some of it, and a body can be
 * pasted from anywhere. A body, a summary, a comment and an agent's output keep
 * their markdown through `forMarkdown`, which neutralizes Feishu's tags; titles,
 * names, reasons and errors go through `forDisplay`, which escapes everything.
 * A piece is masked and cut before it is escaped, so a cut cannot leave the
 * start of a secret showing, nor split an escape. Gate commands are shown
 * masked too: a secret may have become known after the gate was defined (spec
 * §7.7). The router masks each whole reply once more.
 */

/**
 * Control characters stripped and known secrets masked: the first thing done to
 * any piece, before it is reshaped -- spaces collapsed, trimmed, cut -- since a
 * reshaped secret no longer matches.
 */
function masked(text: string): string {
  return redactKnownSecrets(stripControl(text));
}

/** A label: masked, then one line, cut with a one-line marker, and every markdown character escaped. */
export function label(text: string, max = 200): string {
  return forDisplay(truncate(masked(text).replace(/\s+/g, ' ').trim(), max, '…'));
}

/**
 * Free text that keeps its markdown, quoted under its label so none of its lines
 * starts a heading or a list. A line opening a code fence -- three or more
 * backticks or tildes -- has its first one escaped, so the text cannot open or
 * close a fence around what follows it.
 */
function quoted(text: string): string {
  return forMarkdown(text)
    .split('\n')
    .map((line) => `> ${line.replace(/^(\s*)([`~]{3,})/, (_all, space: string, run: string) => `${space}\\${run}`)}`)
    .join('\n');
}

/** Free text from its start: masked, then cut to `max` characters, then quoted. */
function block(text: string, max: number): string {
  return quoted(truncate(masked(text).trim(), max));
}

/**
 * Free text from its end, as an agent's output is read: masked whole first, so
 * the cut cannot leave part of a secret, then its last `max` characters, marked.
 */
function tail(text: string, max: number): string {
  const whole = masked(text).trim();
  return quoted(whole.length <= max ? whole : `… (earlier output cut)\n${whole.slice(-max).trimStart()}`);
}

function who(a: Assignee | null): string {
  if (a === null) return 'nobody';
  return a.kind === 'role' ? `role ${label(a.name)}` : label(a.name);
}

function id(taskId: string): string {
  return `\`${taskId}\``;
}

const LIST_MAX = 30;

/** The statuses `/kanban list` shows with no filter: everything someone may still act on. */
const ACTIVE: readonly DisplayStatus[] = ['running', 'reviewing', 'review', 'ready', 'todo', 'blocked'];

/** `/kanban help`: every command, with the tier it needs (spec §9.1). */
export function renderHelp(): string {
  const operate = 'operator';
  const talk = 'anyone allowed';
  const lines: Array<[string, string]> = [
    [USAGE.new, operate],
    [USAGE.list, talk],
    [USAGE.show, talk],
    [USAGE.assign, operate],
    [USAGE.link, operate],
    [USAGE.workspace, operate],
    [USAGE.comment, talk],
    [USAGE.unblock, operate],
    [USAGE.stop, operate],
    [USAGE.archive, operate],
    [USAGE['gate add'], operate],
    [USAGE['gate list'], talk],
    [USAGE['gate remove'], operate],
  ];
  return [
    '**The task board.** A task is any work -- research, a document, an operation in Lark, a chore, a change to code -- given to a role, whose agent runs it in a workspace.',
    ...lines.map(([usage, tier]) => `\`${usage}\` (${tier})`),
    'Assignees and reviewers are roles for now: naming a person, with an @-mention, arrives in a later update, with `/kanban done`, `block`, `review`, `approve` and `changes`.',
    'The chat a task is created in hears when it is done, needs review, blocks, is retried after a failure, gives up, or is stranded.',
  ].join('\n');
}

/** `/kanban list` (spec §9.1): the board by derived status, the active tasks unless a filter is given. */
export function renderList(entries: readonly BoardEntry[], filter: DisplayStatus | 'all' | undefined): string {
  const shown = entries.filter((e) =>
    filter === undefined ? ACTIVE.includes(e.status) : filter === 'all' || e.status === filter,
  );
  if (shown.length === 0) {
    return filter === undefined
      ? 'No open tasks. `/kanban list all` shows done and archived ones too.'
      : `No ${filter === 'all' ? '' : `${filter} `}tasks.`;
  }
  const ordered =
    filter === undefined ? ACTIVE.flatMap((status) => shown.filter((e) => e.status === status)) : [...shown];
  const lines = ordered
    .slice(0, LIST_MAX)
    .map((e) => `${id(e.task.taskId)} **${e.status}** — ${label(e.task.title, 120)} · ${who(e.task.assignee)}`);
  const more = ordered.length - LIST_MAX;
  if (more > 0) lines.push(`… and ${more} more. \`/kanban list <${LIST_FILTERS.join('|')}>\` narrows it.`);
  return lines.join('\n');
}

function runLine(run: RunRow): string {
  const outcome = run.outcome === null ? (run.endedAt === null ? 'working' : 'undecided') : run.outcome;
  const head = `#${run.attempt} ${run.kind} · ${who(run.assignee)} · ${forDisplay(outcome)}`;
  const said = run.summary ?? run.error;
  return said === null || said === '' ? head : `${head} — ${label(said, 300)}`;
}

/** `/kanban show` (spec §9.1): the task, its contract, gates, runs, latest output and comments. */
export function renderShow(view: TaskView, gates: readonly GateRow[]): string {
  const { task } = view;
  const out: string[] = [
    `**${label(task.title)}** ${id(task.taskId)} — ${view.status}`,
    `assignee: ${who(task.assignee)} · reviewer: ${who(task.reviewer)} · workspace: ${task.workspace === null ? 'not yet fixed' : label(task.workspace)}`,
  ];
  if (task.phase === 'blocked' && task.blockKind !== null) {
    out.push(`blocked (${forDisplay(task.blockKind)}): ${label(task.blockReason ?? '', 500)}`);
  }
  if (view.parents.length > 0) {
    out.push(`parents: ${view.parents.map((p) => `${id(p.taskId)} (${p.phase})`).join(', ')}`);
  }
  if (view.children.length > 0) {
    out.push(`children: ${view.children.map((c) => `${id(c.taskId)} (${c.phase})`).join(', ')}`);
  }
  if (task.body.trim() !== '') out.push(block(task.body, 1500));
  const contract = Object.entries(task.contract).filter(([, v]) => v !== undefined && v.trim() !== '');
  if (contract.length > 0) {
    out.push('**Contract**');
    for (const [field, value] of contract) out.push(`${forDisplay(field)}: ${label(value ?? '', 400)}`);
  }
  if (gates.length > 0) {
    out.push('**Gates**');
    for (const g of gates) out.push(`${g.id}. ${label(g.command, 300)} (${g.timeoutS} s)`);
  }
  if (view.runs.length > 0) {
    out.push('**Runs**');
    for (const run of view.runs.slice(-5)) out.push(runLine(run));
    const last = view.runs.at(-1);
    const output = last?.lastOutput ?? null;
    if (output !== null && output.trim() !== '') out.push('Latest output:', tail(output, 800));
  }
  if (view.comments.length > 0) {
    const shown = view.comments.slice(-5);
    out.push(`**Comments** (${shown.length} of ${view.comments.length})`);
    for (const c of shown) out.push(`${label(c.author, 80)}:`, block(c.body, 400));
  }
  return out.join('\n');
}

/** `/kanban gate list` (spec §7.7): each gate's command masked, with its timeout and who defined it. */
export function renderGates(taskId: string, gates: readonly GateRow[]): string {
  if (gates.length === 0) return `Task ${id(taskId)} has no gates.`;
  return [
    `Gates of ${id(taskId)}, run in this order before it may complete or go to review:`,
    ...gates.map((g) => `${g.id}. ${label(g.command, 600)} (${g.timeoutS} s, by ${label(g.createdBy, 80)})`),
  ].join('\n');
}

/**
 * The outcomes a retry follows that are failures to tell a subscriber of (spec
 * §9.4). Not `interrupted`: a run the gateway's restart ended is retried quietly,
 * as the task did nothing wrong.
 */
const RETRIED: ReadonlySet<string> = new Set(['failed', 'crashed', 'timed_out', 'protocol_violation']);

function text(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === 'string' ? v : '';
}

function blockedLine(task: TaskRow, kind: string, reason: string, recurrences: number, limit: number): string {
  const head = `Blocked (${forDisplay(kind)}) — **${label(task.title)}** ${id(task.taskId)}: ${label(reason, 800)}`;
  if (recurrences >= limit) {
    return (
      `${head}\nIt keeps blocking for the same reason (${recurrences} times after an unblock); ` +
      'rewrite the task, or archive it and create a clearer one, rather than unblocking it again.'
    );
  }
  return `${head}\n\`/kanban unblock ${task.taskId} [comment]\` once it can go on.`;
}

/**
 * The notice a subscription hears of one event (spec §9.4), or undefined when
 * the event is none: completed, review requested, blocked with its kind and
 * reason, retrying after a failure, gave up, stranded. A dependency block is not
 * one, since nobody needs to act; a throttled run's cooldown is not either, as it
 * clears by itself, and blocks as transient at its limit, which is one.
 */
export function renderNotice(event: KanbanEvent, task: TaskRow, opts: { blockRecurrenceLimit: number }): string | undefined {
  const p = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
  const name = `**${label(task.title)}** ${id(task.taskId)}`;
  // As the event recorded it, not as the task is now: a notice delivered late tells what was true then.
  const recurrences = typeof p['blockRecurrences'] === 'number' ? p['blockRecurrences'] : 0;
  switch (event.kind) {
    case 'completed': {
      const summary = text(p, 'summary');
      return summary.trim() === '' ? `Done — ${name}.` : `Done — ${name}:\n${block(summary, 1200)}`;
    }
    case 'review_requested': {
      const reviewer = text(p, 'reviewer');
      const kind = p['reviewerKind'] === 'human' ? 'human' : 'role';
      return `Review requested — ${name}, from ${who(reviewer === '' ? null : { kind, name: reviewer })}.`;
    }
    case 'blocked': {
      const kind = text(p, 'kind');
      if (kind === '' || kind === 'dependency') return undefined;
      return blockedLine(task, kind, text(p, 'reason'), recurrences, opts.blockRecurrenceLimit);
    }
    case 'stopped':
      return blockedLine(task, 'needs_input', `stopped by ${event.actor}`, recurrences, opts.blockRecurrenceLimit);
    case 'run_ended': {
      const outcome = text(p, 'outcome');
      const error = text(p, 'error');
      if (p['next'] === 'retry' && RETRIED.has(outcome)) {
        const why = error === '' ? '' : `: ${label(error, 500)}`;
        return `Retrying — ${name}: the last attempt ended ${forDisplay(outcome)}${why}.`;
      }
      if (p['next'] !== 'blocked') return undefined;
      const kind = text(p, 'blockKind');
      const reason = text(p, 'blockReason');
      if (kind === 'gave_up') {
        return `Gave up — ${name}: ${label(reason, 800)}\n\`/kanban unblock ${task.taskId} [comment]\` gives it a fresh set of attempts.`;
      }
      return blockedLine(task, kind, reason, recurrences, opts.blockRecurrenceLimit);
    }
    case 'stranded':
      return `Stranded — ${name}: nobody can be given it: ${label(text(p, 'reason'), 500)}`;
    default:
      return undefined;
  }
}
```


- [ ] **Step 5.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/kanban-chat-render.test.ts`. Expected: `Tests  15 passed (15)`.

- [ ] **Step 5.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1186 passed (1186)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  70 passed (70)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 5.6: Commit.**

```bash
git add src/kanban/chat-render.ts tests/kanban-chat-render.test.ts
git commit -m "Render the board's chat replies and its subscription notices, escaped, with every piece masked before it is reshaped or cut"
```

---

### Task 6: The commands, through the service

**Files:**
- Create: `src/kanban/chat.ts`, `tests/kanban-chat.test.ts`

`KanbanChat.run` does a parsed command (spec §9.1, §10; Decisions 4–13, 16, 19): it checks the sender's tier with the router's authorizer, records who acted as `lark:<union_id>`, refuses a person or a supervised role as arriving in a later update, holds a new task to the worker CLI's limits, stores a talk-tier comment as one that does not steer, answers an assignment that changes nothing, calls `KanbanService` and nothing else, and tells the dispatcher. It touches no chat session.

- [ ] **Step 6.1: Write the failing tests.**

Create `tests/kanban-chat.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commentsOf, eventsOf, gatesOf, getRun, getTask, subscriptionsOf } from '../src/db/kanban-read.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { KanbanService } from '../src/kanban/service.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import type { BindingKey, InboundMessage, Principal } from '../src/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES, role } from './helpers/dispatch.js';
import { WORKSPACES } from './helpers/kanban.js';

/**
 * /kanban in chat (spec §9.1): tiers, the identity the board records, the
 * refusals of what arrives in a later update (plan D2), and every change done through the
 * service, with the dispatcher told.
 */

const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const GUEST: Principal = { openId: 'ou_guest', unionId: 'on_guest', displayName: 'Guest' };
const NAMELESS: Principal = { openId: 'ou_owner', unionId: null, displayName: 'Owner' };
const KEY: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' };

let t: TestDb;
let service: KanbanService;
let chat: KanbanChat;
let passes: number;
let cancelled: string[];
let seq = 0;

beforeEach(() => {
  clearSecrets();
  t = testDb();
  service = new KanbanService({
    db: t.db,
    roles: new Map(
      [...DEFAULT_ROLES, role('watched', { agent: { ...DEFAULT_ROLES[0]!.agent, unsupervised: false } })].map((r) => [
        r.name,
        r,
      ]),
    ),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
  });
  const authorizer = new Authorizer({ ...defaultAuthConfig(OWNER.openId), allowTalk: [OWNER.openId, GUEST.openId] });
  passes = 0;
  cancelled = [];
  chat = new KanbanChat({
    service,
    hasTier: (p, tier) => authorizer.hasTier(p, tier),
    changed: () => (passes += 1),
    cancel: (runId) => cancelled.push(runId),
  });
});
afterEach(() => {
  clearSecrets();
  t.close();
});

function message(sender: Principal = OWNER, messageId = `om_${++seq}`): InboundMessage {
  return {
    messageId,
    appId: 'cli_app',
    chatId: 'oc_team',
    chatType: 'group',
    threadId: 'omt_topic',
    sender,
    senderIsBot: false,
    text: '',
    mentionedBot: true,
    mentionAll: false,
    attachments: [],
    createTime: 0,
  };
}

function say(arg: string, sender: Principal = OWNER): Promise<string> {
  return chat.run(arg, message(sender), KEY);
}

/** The id of the task a `Created` reply names. */
function created(reply: string): string {
  const m = /^Created `(k_[0-9a-z]+)`/.exec(reply);
  if (m?.[1] === undefined) throw new Error(`not created: ${reply}`);
  return m[1];
}

function taskCount(): number {
  return t.db.prepare<[], { n: number }>('SELECT count(*) AS n FROM kanban_tasks').get()?.n ?? 0;
}

describe('/kanban new', () => {
  it("creates a task from its field lines, as the sender, from this chat, which follows it; and looks for work", async () => {
    const reply = await say('new Draft the Q3 summary\nassignee: docs-writer\nworkspace: docs\noutcome: a page in the wiki\nUse last quarter as the model.');
    const taskId = created(reply);
    expect(reply).toBe(
      `Created \`${taskId}\` — **Draft the Q3 summary**, for role docs-writer, in docs. ` +
        'This chat hears when it is done, needs review, blocks, is retried after a failure, gives up or is stranded.',
    );
    expect(getTask(t.db, taskId)).toMatchObject({
      title: 'Draft the Q3 summary',
      body: 'Use last quarter as the model.',
      contract: { outcome: 'a page in the wiki' },
      assignee: { kind: 'role', name: 'docs-writer' },
      workspace: 'docs',
      createdBy: 'lark:on_owner',
      createdVia: { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' },
    });
    expect(subscriptionsOf(t.db, taskId).map((s) => [s.conversationId, s.threadId])).toEqual([['oc_team', 'omt_topic']]);
    expect(passes).toBe(1);
    // A long title is shown cut to 200 characters, on one line.
    const long = await say(`new ${'x'.repeat(300)}`);
    expect(long).toContain(` — **${'x'.repeat(199)}…**, for nobody yet`);
  });

  it('makes one task of one message, however often it arrives', async () => {
    const first = created(await chat.run('new Once', message(OWNER, 'om_same'), KEY));
    expect(await chat.run('new Once', message(OWNER, 'om_same'), KEY)).toBe(`Already created, as \`${first}\`.`);
    expect(taskCount()).toBe(1);
  });

  it('refuses an unknown role or workspace, a person, and a supervised role, creating nothing', async () => {
    expect(await say('new t\nassignee: nobody-here')).toBe('Not done: role "nobody-here" is not configured');
    expect(await say('new t\nassignee: implementer\nworkspace: nowhere')).toBe(
      'Not done: workspace "nowhere" is not configured',
    );
    for (const line of ['assignee: @Alice', 'reviewer: @Bob', 'assignee: lark:on_alice']) {
      expect(await say(`new t\n${line}`)).toBe(
        'Assigning a task to a person, or naming one as its reviewer, arrives in a later update. ' +
          'For now a task is given to a role: name it as a bare word, such as `implementer`.',
      );
    }
    expect(await say('new t\nassignee: watched')).toBe(
      'role "watched" has a supervised agent; its approval requests cannot be forwarded to a chat yet. That arrives in a later update.',
    );
    expect(await say(`new ${'t'.repeat(513)}`)).toBe('A title is at most 512 bytes; put the rest in the body.');
    expect(await say('new t\noutcome: ' + 'x'.repeat(8193))).toBe("The contract's outcome is at most 8192 bytes.");
    expect(taskCount()).toBe(0);
  });
});

describe('tiers and identity', () => {
  it('lets a talk-tier sender read and comment, and refuses every change of the board', async () => {
    const taskId = created(await say('new A task\nassignee: implementer'));
    expect(await say('list', GUEST)).toContain(taskId);
    expect(await say(`show ${taskId}`, GUEST)).toContain('**A task**');
    expect(await say(`gate list ${taskId}`, GUEST)).toBe(`Task \`${taskId}\` has no gates.`);
    expect(await say(`comment ${taskId} the 2024 figures, please`, GUEST)).toBe(
      `Comment added to \`${taskId}\`, for people: \`/kanban show\` shows it. Only an operator's comment is given to the task's agent.`,
    );
    expect(await say(`comment ${taskId} use the 2023 figures`)).toContain('An agent working on it gets it');
    expect(commentsOf(t.db, taskId).map((c) => [c.author, c.body])).toEqual([
      ['lark:on_guest', 'the 2024 figures, please'],
      ['lark:on_owner', 'use the 2023 figures'],
    ]);
    // Shown to people, and only the operator's steers the agent.
    expect(commentsOf(t.db, taskId, { steering: true }).map((c) => c.author)).toEqual(['lark:on_owner']);
    expect(await say(`show ${taskId}`, GUEST)).toContain('> the 2024 figures, please');
    const before = eventsOf(t.db, taskId).length;
    for (const arg of [
      'new Another',
      `assign ${taskId} reviewer`,
      `link ${taskId} ${taskId}`,
      `workspace ${taskId} web`,
      `unblock ${taskId}`,
      `stop ${taskId}`,
      `archive ${taskId}`,
      `gate add ${taskId} true`,
      `gate remove ${taskId} 1`,
    ]) {
      expect(await say(arg, GUEST)).toMatch(/^`\/kanban [a-z ]+` changes the board, and needs operator permission\.$/);
    }
    expect(eventsOf(t.db, taskId)).toHaveLength(before);
    expect(taskCount()).toBe(1);
  });

  it('lets a sender Lark gave no union_id read the board, and nothing else', async () => {
    expect(await say('list', NAMELESS)).toBe('No open tasks. `/kanban list all` shows done and archived ones too.');
    expect(await say('new A task', NAMELESS)).toMatch(/^Lark did not say who you are/);
    expect(taskCount()).toBe(0);
  });
});

describe('changing a task', () => {
  it('reassigns, stops and archives, cancelling the turn of the run each decided', async () => {
    const taskId = created(await say('new Survey the vendors\nassignee: implementer'));
    const first = service.claim(taskId);
    if (!first.ok) throw new Error(first.message);
    expect(await say(`assign ${taskId} reviewer`)).toBe(
      `\`${taskId}\` is now for role reviewer; its run \`${first.run.runId}\` was superseded.`,
    );
    expect(cancelled).toEqual([first.run.runId]);
    expect(service.closeRun(first.run.runId).ok).toBe(true);

    const second = service.claim(taskId);
    if (!second.ok) throw new Error(second.message);
    expect(await say(`stop ${taskId}`)).toBe(
      `Stopped \`${taskId}\`: its run was cancelled, and the task is blocked (needs\\_input). \`/kanban unblock ${taskId}\` runs it again.`,
    );
    expect(cancelled).toEqual([first.run.runId, second.run.runId]);
    expect(getTask(t.db, taskId)).toMatchObject({ phase: 'blocked', blockKind: 'needs_input', blockReason: 'stopped by lark:on_owner' });
    expect(service.closeRun(second.run.runId).ok).toBe(true);

    expect(await say(`unblock ${taskId} try the 2024 list`)).toBe(`\`${taskId}\` is unblocked, back to open.`);
    expect(commentsOf(t.db, taskId).at(-1)).toMatchObject({ author: 'lark:on_owner', body: 'try the 2024 list' });
    const third = service.claim(taskId);
    if (!third.ok) throw new Error(third.message);
    expect(await say(`archive ${taskId}`)).toBe(`Archived \`${taskId}\`.`);
    expect(getRun(t.db, third.run.runId)?.outcome).toBe('superseded');
    expect(cancelled).toEqual([first.run.runId, second.run.runId, third.run.runId]);
  });

  it('links two tasks, and sets a workspace while it is not yet fixed', async () => {
    const parent = created(await say('new Collect the numbers\nassignee: implementer'));
    const child = created(await say('new Write them up\nassignee: implementer'));
    expect(await say(`link ${parent} ${child}`)).toBe(`\`${child}\` now waits for \`${parent}\`.`);
    expect(await say(`link ${parent} ${child}`)).toBe(`\`${child}\` already waits for \`${parent}\`.`);
    expect(await say(`workspace ${child} docs`)).toBe(`\`${child}\` works in docs.`);
    expect(await say(`workspace ${child} web`)).toBe(
      `Not done: task ${child.replace(/_/g, '\\_')} works in docs; a fixed workspace does not change`,
    );
    expect(await say(`assign ${child} @Carol Jones`)).toContain('arrives in a later update');
    expect(await say(`assign ${child} implementer`)).toBe(`\`${child}\` is already assigned to role implementer.`);
    expect(eventsOf(t.db, child).some((e) => e.kind === 'assignee_set')).toBe(false);
  });

  it('defines, lists and removes gates as the sender, refusing one that holds a known secret, and shows them masked', async () => {
    const taskId = created(await say('new Publish the page\nassignee: implementer'));
    expect(await say(`gate add ${taskId} --timeout 60 curl -fsS https://wiki.example/page`)).toBe(
      `Gate 1 added to \`${taskId}\` (60 s): curl -fsS https://wiki.example/page`,
    );
    addSecrets(['sk-chat-12345678']);
    expect(await say(`gate add ${taskId} curl -H "k: sk-chat-12345678" https://ci`)).toMatch(
      /^Not done: the gate's command holds a known secret/,
    );
    // A command over several lines is stored as written, and echoed on one line.
    expect(await say(`gate add ${taskId} test -f page.md &&\n  grep -q Summary page.md`)).toBe(
      `Gate 2 added to \`${taskId}\` (300 s): test -f page.md && grep -q Summary page.md`,
    );
    expect(await say(`gate remove ${taskId} 2`)).toBe(`Gate 2 removed from \`${taskId}\`: test -f page.md && grep -q Summary page.md`);
    expect(gatesOf(t.db, taskId).map((g) => [g.command, g.createdBy])).toEqual([
      ['curl -fsS https://wiki.example/page', 'lark:on_owner'],
    ]);
    // Defined before the value was known: listed masked.
    expect(service.addGate(taskId, { command: 'echo sk-late-12345678' }, 'operator:alice').ok).toBe(true);
    addSecrets(['sk-late-12345678']);
    expect(await say(`gate list ${taskId}`)).toContain(`2. echo ${MASK} (300 s, by operator:alice)`);
    expect(await say(`gate remove ${taskId} 1`)).toBe(`Gate 1 removed from \`${taskId}\`: curl -fsS https://wiki.example/page`);
    expect(eventsOf(t.db, taskId).at(-1)).toMatchObject({ kind: 'gate_removed', actor: 'lark:on_owner' });
  });
});

describe('what chat cannot do yet', () => {
  it("answers the people's commands with when they arrive, and a wrong command line with its usage", async () => {
    expect(await say('done k_1 finished')).toBe(
      "`/kanban done` is for a person's own task, and arrives in a later update, with people as assignees and reviewers. " +
        'For now tasks go to roles, whose agents report for themselves.',
    );
    expect(await say('approve k_1')).toContain('arrives in a later update');
    expect(await say('show')).toBe('Usage: `/kanban show <task>`');
    expect(await say('show k_missing')).toBe('Not done: no task k\\_missing');
    expect(await say('')).toContain('**The task board.**');
  });
});
```


- [ ] **Step 6.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-chat.test.ts`. Expected: the file FAILS to load, with `Error: Cannot find module '../src/kanban/chat.js'`. `Tests  no tests`.

- [ ] **Step 6.3: Implement.**

Create `src/kanban/chat.ts`:

```ts
import { forDisplay } from '../channel/escape.js';
import type { BindingKey, InboundMessage, Principal, Tier } from '../types.js';
import { isPerson, parseKanban, type KanbanCommand, type LaterVerb, type NewTaskCommand } from './chat-parse.js';
import { label, renderGates, renderHelp, renderList, renderShow } from './chat-render.js';
import type { KanbanService } from './service.js';
import type { Refusal, RunRow } from './types.js';
import { WORKER_LIMITS } from './worker.js';

/**
 * `/kanban` in chat (spec §9.1): a parsed command, checked against the sender's
 * tier, done through `KanbanService` and nothing else, and answered as text the
 * router sends. It never touches the chat's session, so a busy session never
 * refuses it: it is control-plane, like `/status`.
 *
 * A person is recorded as `lark:<union_id>` (spec §3.1), the identity the board
 * knows people by; a sender whose union_id is unknown can read the board but not
 * change it. Until plan D2 the board gives work only to roles, so naming a
 * person is refused here, and the commands for people's own tasks are answered
 * with when they arrive -- "in a later update", in words a person in chat knows.
 *
 * Anyone at talk tier may comment, and everyone sees comments in `/kanban show`;
 * only an operator's may steer the task's agent (spec §9.1, §7.5).
 */

export interface KanbanChatDeps {
  service: KanbanService;
  /** The sender's tier, as the router's authorizer decides it. */
  hasTier(principal: Principal, tier: Tier): boolean;
  /** After a change that can make a task claimable: the dispatcher's pass. */
  changed?: () => void;
  /** After a change that decided an agent run: the dispatcher cancels its turn and closes it. */
  cancel?: (runId: string) => void;
}

/** Who may run each command (spec §9.1, §10). */
const TIERS: Readonly<Record<KanbanCommand['verb'], Tier>> = {
  help: 'talk',
  new: 'operate',
  list: 'talk',
  show: 'talk',
  assign: 'operate',
  link: 'operate',
  workspace: 'operate',
  comment: 'talk',
  unblock: 'operate',
  stop: 'operate',
  archive: 'operate',
  'gate add': 'operate',
  'gate list': 'talk',
  'gate remove': 'operate',
  later: 'talk',
};

/** The board's principal for a chat sender: `lark:<union_id>`, or undefined when Lark gave none. */
export function principalOf(sender: Principal): string | undefined {
  return sender.unionId === null || sender.unionId === '' ? undefined : `lark:${sender.unionId}`;
}

const PEOPLE_LATER =
  'Assigning a task to a person, or naming one as its reviewer, arrives in a later update. For now a task is given to a role: name it as a bare word, such as `implementer`.';

function later(name: LaterVerb): string {
  return (
    `\`/kanban ${name}\` is for a person's own task, and arrives in a later update, with people as assignees and reviewers. ` +
    'For now tasks go to roles, whose agents report for themselves.'
  );
}

/**
 * What `/kanban new` may hold: the limits a worker's `mt kanban create` has
 * (C3's `WORKER_LIMITS`), so a task is the same size whoever made it.
 */
function oversized(command: NewTaskCommand): string | undefined {
  const size = (text: string) => Buffer.byteLength(text, 'utf8');
  if (size(command.title) > WORKER_LIMITS.title) {
    return `A title is at most ${WORKER_LIMITS.title} bytes; put the rest in the body.`;
  }
  if (size(command.body) > WORKER_LIMITS.body) return `A body is at most ${WORKER_LIMITS.body} bytes.`;
  for (const [field, value] of Object.entries(command.contract)) {
    if (value !== undefined && size(value) > WORKER_LIMITS.contractField) {
      return `The contract's ${forDisplay(field)} is at most ${WORKER_LIMITS.contractField} bytes.`;
    }
  }
  return undefined;
}

/** A refusal, in words for chat: the board's message, escaped, with what D2 brings where that is the reason. */
function refused(r: Refusal): string {
  if (r.code === 'supervised_role') {
    return (
      `${forDisplay(r.message.replace(/;.*$/, ''))}; its approval requests cannot be forwarded to a chat yet. ` +
      'That arrives in a later update.'
    );
  }
  if (r.code === 'person_not_assignable') return PEOPLE_LATER;
  // One line: a refusal can quote what the sender typed, a name or a command.
  return `Not done: ${label(r.message, 600)}`;
}

/** The board's own ids are code; anything else the sender typed is escaped like any text. */
function id(taskId: string): string {
  return /^[kr]_[0-9a-z]+$/.test(taskId) ? `\`${taskId}\`` : forDisplay(taskId);
}

export class KanbanChat {
  readonly #deps: KanbanChatDeps;

  constructor(deps: KanbanChatDeps) {
    this.#deps = deps;
  }

  /** Run `/kanban <arg>` from this message, bound at `key`; the reply to send. */
  async run(arg: string, message: InboundMessage, key: BindingKey): Promise<string> {
    const parsed = parseKanban(arg);
    if (!parsed.ok) return parsed.usage;
    const command = parsed.command;
    const tier = TIERS[command.verb];
    if (tier === 'operate' && !this.#deps.hasTier(message.sender, 'operate')) {
      return `\`/kanban ${command.verb}\` changes the board, and needs operator permission.`;
    }
    switch (command.verb) {
      case 'help':
        return renderHelp();
      case 'later':
        return later(command.name);
      case 'list':
        return renderList(this.#deps.service.list(), command.filter);
      case 'show': {
        const r = this.#deps.service.show(command.taskId);
        if (!r.ok) return refused(r);
        const gates = this.#deps.service.listGates(command.taskId);
        return renderShow(r.view, gates.ok ? gates.gates : []);
      }
      case 'gate list': {
        const r = this.#deps.service.listGates(command.taskId);
        return r.ok ? renderGates(command.taskId, r.gates) : refused(r);
      }
      default:
        break;
    }
    // Everything below records who acted.
    const by = principalOf(message.sender);
    if (by === undefined) {
      return 'Lark did not say who you are (no union_id came with the message), and the board records who changes it. Ask the operator to check the app can read user ids.';
    }
    return this.#change(command, by, message, key);
  }

  #change(command: KanbanCommand, by: string, message: InboundMessage, key: BindingKey): string {
    const service = this.#deps.service;
    switch (command.verb) {
      case 'new':
        return this.#create(command, by, message, key);
      case 'assign': {
        if (isPerson(command.assignee)) return PEOPLE_LATER;
        const now = service.show(command.taskId);
        const current = now.ok ? now.view.task.assignee : null;
        if (current?.kind === 'role' && current.name === command.assignee) {
          return `${id(command.taskId)} is already assigned to role ${forDisplay(command.assignee)}.`;
        }
        const r = service.assign(command.taskId, command.assignee, by);
        if (!r.ok) return refused(r);
        this.#decided(r.run);
        this.#changed();
        return `${id(command.taskId)} is now for role ${forDisplay(command.assignee)}${r.run === undefined ? '' : `; its run ${id(r.run.runId)} was ${forDisplay(r.run.outcome ?? 'ended')}`}.`;
      }
      case 'link': {
        const r = service.link(command.parentId, command.childId, by);
        if (!r.ok) return refused(r);
        return r.added
          ? `${id(command.childId)} now waits for ${id(command.parentId)}.`
          : `${id(command.childId)} already waits for ${id(command.parentId)}.`;
      }
      case 'workspace': {
        const r = service.setWorkspace(command.taskId, command.workspace, by);
        if (!r.ok) return refused(r);
        this.#changed();
        return `${id(command.taskId)} works in ${forDisplay(command.workspace)}.`;
      }
      case 'comment': {
        // Only an operator's comment may steer the task's agent; anyone's is shown to people (spec §9.1).
        const steers = this.#deps.hasTier(message.sender, 'operate');
        const r = service.comment(command.taskId, command.text, by, { steers });
        if (!r.ok) return refused(r);
        return steers
          ? `Comment added to ${id(command.taskId)}. An agent working on it gets it when its current turn ends; otherwise the next run reads it.`
          : `Comment added to ${id(command.taskId)}, for people: \`/kanban show\` shows it. Only an operator's comment is given to the task's agent.`;
      }
      case 'unblock': {
        const r = service.unblock(command.taskId, by, command.comment);
        if (!r.ok) return refused(r);
        this.#changed();
        return `${id(command.taskId)} is unblocked, back to ${r.task.phase}.`;
      }
      case 'stop': {
        const r = service.stop(command.taskId, by);
        if (!r.ok) return refused(r);
        this.#decided(r.run);
        this.#changed();
        return r.run.outcome === 'cancelled'
          ? `Stopped ${id(command.taskId)}: its run was cancelled, and the task is blocked (needs\\_input). \`/kanban unblock ${command.taskId}\` runs it again.`
          : `${id(command.taskId)}'s run had already reported (${forDisplay(r.run.outcome ?? 'undecided')}); it is being closed, and the task keeps that outcome.`;
      }
      case 'archive': {
        const r = service.archive(command.taskId, by);
        if (!r.ok) return refused(r);
        this.#decided(r.run);
        this.#changed();
        return `Archived ${id(command.taskId)}.`;
      }
      case 'gate add': {
        const r = service.addGate(
          command.taskId,
          { command: command.command, ...(command.timeoutS === undefined ? {} : { timeoutS: command.timeoutS }) },
          by,
        );
        if (!r.ok) return refused(r);
        return `Gate ${r.gate.id} added to ${id(command.taskId)} (${r.gate.timeoutS} s): ${label(r.gate.command, 600)}`;
      }
      case 'gate remove': {
        const r = service.removeGate(command.taskId, command.gateId, by);
        if (!r.ok) return refused(r);
        return `Gate ${r.gate.id} removed from ${id(command.taskId)}: ${label(r.gate.command, 600)}`;
      }
      default:
        return renderHelp();
    }
  }

  /**
   * `/kanban new` (spec §9.1): created from this chat, which is subscribed to it.
   * The message id is the idempotency key, so a redelivery that got past the
   * router's own dedup still makes one task.
   */
  #create(command: NewTaskCommand, by: string, message: InboundMessage, key: BindingKey): string {
    for (const name of [command.assignee, command.reviewer]) {
      if (name !== undefined && isPerson(name)) return PEOPLE_LATER;
    }
    const tooBig = oversized(command);
    if (tooBig !== undefined) return tooBig;
    const r = this.#deps.service.create({
      title: command.title,
      ...(command.body === '' ? {} : { body: command.body }),
      contract: command.contract,
      ...(command.assignee === undefined ? {} : { assignee: command.assignee }),
      ...(command.reviewer === undefined ? {} : { reviewer: command.reviewer }),
      ...(command.workspace === undefined ? {} : { workspace: command.workspace }),
      ...(command.parents.length === 0 ? {} : { parents: command.parents }),
      idempotencyKey: `lark:${message.messageId}`,
      createdBy: by,
      createdVia: {
        kind: 'chat',
        channel: key.channel,
        appId: key.appId,
        conversationId: key.conversationId,
        threadId: key.threadId,
      },
    });
    if (!r.ok) return refused(r);
    const { task } = r;
    if (r.existing) return `Already created, as ${id(task.taskId)}.`;
    this.#changed();
    const whom =
      task.assignee === null
        ? `nobody yet: \`/kanban assign ${task.taskId} <role>\` gives it to a role`
        : `role ${forDisplay(task.assignee.name)}`;
    return (
      `Created ${id(task.taskId)} — **${label(task.title)}**, for ${whom}` +
      `${task.workspace === null ? '' : `, in ${forDisplay(task.workspace)}`}. ` +
      'This chat hears when it is done, needs review, blocks, is retried after a failure, gives up or is stranded.'
    );
  }

  /** An agent run the change decided: its turn is cancelled, and it closes when the turn ends. */
  #decided(run: RunRow | undefined): void {
    if (run === undefined || run.endedAt !== null || run.agentConfig === null) return;
    this.#tell(() => this.#deps.cancel?.(run.runId));
  }

  #changed(): void {
    this.#tell(() => this.#deps.changed?.());
  }

  /** The dispatcher is told, never relied on: its failure is not the command's. */
  #tell(fn: () => void): void {
    try {
      fn();
    } catch {
      // The sweep finds the work within a minute.
    }
  }
}
```


- [ ] **Step 6.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/kanban-chat.test.ts`. Expected: `Tests  9 passed (9)`. Run `npx vitest run --project unit tests/kanban-service.test.ts -t "one writer"`. Expected: `Tests  1 passed | …`: `src/kanban/chat.ts` does not import `db/kanban.js`.

- [ ] **Step 6.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1195 passed (1195)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  70 passed (70)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 6.6: Commit.**

```bash
git add src/kanban/chat.ts tests/kanban-chat.test.ts
git commit -m "Do the /kanban commands through the board's service, at the tier each needs, recording who acted, and refuse people until a later update"
```

---

### Task 7: `/kanban` in the router

**Files:**
- Modify: `src/core/commands.ts`, `src/core/router.ts`, `tests/router.test.ts`, `tests/commands.test.ts`

`/kanban` joins the command table at talk tier, multiline, needing no session, and not mutating, so a busy session never refuses it (spec §9.1). The router hands it to `RouterDeps.kanban` — `KanbanCommands`, an interface in the router, so the core imports nothing from the board — or answers that the board is off (Decision 5). A board that throws is answered with the reason, escaped and masked, and noted. Every reply is masked whole before it is sent (Decision 18).

- [ ] **Step 7.1: Write the failing tests.**

In `tests/router.test.ts`, replace:

```ts
import { ACK_EMOJI, Router } from '../src/core/router.js';
```

with:

```ts
import { ACK_EMOJI, KANBAN_OFF, Router, type KanbanCommands } from '../src/core/router.js';
```

In `tests/router.test.ts`, replace:

```ts
import type { InboundMessage, PermissionOption, Principal } from '../src/types.js';
```

with:

```ts
import type { BindingKey, InboundMessage, PermissionOption, Principal } from '../src/types.js';
```

In `tests/router.test.ts`, replace:

```ts
function harness(
  opts: { auth?: Partial<AuthConfig>; authorizer?: Authorizer } = {},
): Harness {
```

with:

```ts
function harness(
  opts: { auth?: Partial<AuthConfig>; authorizer?: Authorizer; kanban?: KanbanCommands } = {},
): Harness {
```

In `tests/router.test.ts`, replace:

```ts
    channelId: CHANNEL,
    appId: APP,
    clock,
    note: (line) => notes.push(line),
  });
  return { db: t.db, router, registry, channel, driver, clock, notes, authorizer };
```

with:

```ts
    channelId: CHANNEL,
    appId: APP,
    ...(opts.kanban === undefined ? {} : { kanban: opts.kanban }),
    clock,
    note: (line) => notes.push(line),
  });
  return { db: t.db, router, registry, channel, driver, clock, notes, authorizer };
```

In `tests/router.test.ts`, replace:

```ts
describe('Router: prompts', () => {
```

with:

```ts
describe('Router: /kanban', () => {
  afterEach(() => clearSecrets());

  /** A board that records what it was asked, and answers with `answer`. */
  function board(answer: (arg: string) => Promise<string>): KanbanCommands & {
    calls: Array<{ arg: string; messageId: string; key: BindingKey }>;
  } {
    const calls: Array<{ arg: string; messageId: string; key: BindingKey }> = [];
    return {
      calls,
      run: async (arg, message, key) => {
        calls.push({ arg, messageId: message.messageId, key });
        return answer(arg);
      },
    };
  }

  it('says the board is off when kanban.enabled is not set, and opens no session', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/kanban list' }));
    expect(lastReply(h)).toBe(KANBAN_OFF);
    expect(sessionCount(h)).toBe(0);
  });

  it('hands the board the whole argument, lines kept, with the message and where it was said; the reply masked', async () => {
    addSecrets(['sk-board-12345678']);
    const kanban = board(async () => 'Created `k_1`, key sk-board-12345678');
    const h = harness({ kanban });
    const message = msg({ text: '/kanban new Draft the notes\nassignee: docs-writer', threadId: 'omt_1' });
    await h.router.onMessage(message);
    expect(kanban.calls).toEqual([
      {
        arg: 'new Draft the notes\nassignee: docs-writer',
        messageId: message.messageId,
        key: { channel: CHANNEL, appId: APP, conversationId: CHAT, threadId: 'omt_1' },
      },
    ]);
    expect(h.channel.texts.at(-1)).toMatchObject({
      text: `Created \`k_1\`, key ${MASK}`,
      uuid: replyUuid(APP, message.messageId, 'kanban'),
    });
    expect(sessionCount(h)).toBe(0);
  });

  it('answers while the chat session is busy: it never touches that session', async () => {
    const h = harness({ kanban: board(async () => 'the board') });
    await working(h);
    await h.router.onMessage(msg({ text: '/kanban list' }));
    expect(lastReply(h)).toBe('the board');
  });

  it('answers a board that throws with the reason, escaped and masked, and notes it', async () => {
    addSecrets(['sk-thrown-12345678']);
    const h = harness({
      kanban: board(async () => {
        throw new Error('database_locked by sk-thrown-12345678');
      }),
    });
    await h.router.onMessage(msg({ text: '/kanban list' }));
    expect(lastReply(h)).toBe(`The board could not do that: database\\_locked by ${MASK}`);
    expect(h.notes.some((n) => n.includes('kanban command in'))).toBe(true);
  });
});

describe('Router: prompts', () => {
```

In `tests/commands.test.ts`, replace:

```ts
  it('has no /approve', () => {
```

with:

```ts
  it('runs /kanban at talk tier, lines kept, without a session and never refused mid-turn', () => {
    // Its commands that change the board check operator tier themselves (spec §9.1).
    const parsed = parseCommand('/kanban new A task\nassignee: implementer');
    if (parsed === undefined || !('spec' in parsed)) throw new Error('/kanban did not parse');
    expect(parsed.spec).toMatchObject({ name: 'kanban', tier: 'talk', needsSession: false, mutating: false, multiline: true });
    expect(parsed.arg).toBe('new A task\nassignee: implementer');
  });

  it('has no /approve', () => {
```


- [ ] **Step 7.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/router.test.ts tests/commands.test.ts`. Expected: five FAIL — the command table's with `/kanban did not parse`, and the router's four because `/kanban` is answered "Unknown command `/kanban`. Try `/help`." `Tests  5 failed | 76 passed (81)`.

- [ ] **Step 7.3: Implement.**

In `src/core/commands.ts`, replace:

```ts
  {
    name: 'help',
    tier: 'talk',
```

with:

```ts
  {
    name: 'kanban',
    // Talk, because reading the board is; each of its commands that changes the
    // board checks operator tier itself (spec §9.1).
    tier: 'talk',
    needsSession: false,
    effect: 'immediate',
    // `/kanban new` takes field lines and a body; `/kanban comment` a paragraph.
    multiline: true,
    // Control-plane, like /status: it never touches this chat's session, so a
    // busy one does not refuse it (spec §9.1).
    mutating: false,
    summary: 'The task board: `/kanban help` lists its commands.',
    usage: '/kanban <command>',
  },
  {
    name: 'help',
    tier: 'talk',
```

In `src/core/router.ts`, replace:

```ts
import { forDisplay, truncate } from '../channel/escape.js';
```

with:

```ts
import { forDisplay, truncate } from '../channel/escape.js';
import { redactKnownSecrets } from '../secrets.js';
```

In `src/core/router.ts`, replace:

```ts
export interface RouterDeps {
  db: Db;
  registry: SessionRegistry;
  authorizer: Authorizer;
  channel: Channel;
  channelId: string;
  appId: string;
  clock?: Clock;
  note?: (line: string) => void;
}
```

with:

```ts
/**
 * The board's chat commands (spec §9.1): what follows `/kanban`, run for the
 * message that typed it, answered as the reply to send. Plan D1's `KanbanChat`.
 */
export interface KanbanCommands {
  run(arg: string, message: InboundMessage, key: BindingKey): Promise<string>;
}

export interface RouterDeps {
  db: Db;
  registry: SessionRegistry;
  authorizer: Authorizer;
  channel: Channel;
  channelId: string;
  appId: string;
  /** The board's commands; absent when `kanban.enabled` is off, and `/kanban` says so. */
  kanban?: KanbanCommands;
  clock?: Clock;
  note?: (line: string) => void;
}

/** What `/kanban` says on a gateway whose board is off. */
export const KANBAN_OFF =
  'The task board is off on this gateway. An operator turns it on with `kanban.enabled: true` in config.yaml, and a restart.';
```

In `src/core/router.ts`, replace:

```ts
      case 'cd': {
        // Declared in the registry but not wired in this build
```

with:

```ts
      case 'kanban': {
        let text: string;
        const kanban = this.#deps.kanban;
        if (kanban === undefined) {
          text = KANBAN_OFF;
        } else {
          try {
            text = await kanban.run(arg, message, key);
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            this.#note(`kanban command in ${message.messageId} failed: ${detail}`);
            text = `The board could not do that: ${forDisplay(detail)}`;
          }
        }
        // Each piece was escaped, and masked, as it was put in; the whole reply is
        // masked once more, for what was not: ids, names, the board's own words.
        await this.#reply(target, message, 'kanban', redactKnownSecrets(text));
        return;
      }

      case 'cd': {
        // Declared in the registry but not wired in this build
```


- [ ] **Step 7.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/router.test.ts tests/commands.test.ts`. Expected: `Tests  81 passed (81)`.

- [ ] **Step 7.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1200 passed (1200)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  70 passed (70)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 7.6: Commit.**

```bash
git add src/core/commands.ts src/core/router.ts tests/router.test.ts tests/commands.test.ts
git commit -m "Route /kanban to the board's chat commands, never refused for a busy session, and say the board is off when it is"
```

---

### Task 8: Delivering notices, a batch per conversation

**Files:**
- Create: `src/kanban/notices.ts`, `tests/kanban-notices.test.ts`
- Modify: `src/core/ids.ts`, `tests/ids.test.ts`

The `Notifier` (spec §9.4; Decisions 23–25). Every 2 s, one round at a time, it groups this bot's due subscriptions by conversation and sends each at most one message — that round's notices, in event order, at most 20 — then moves each subscription's cursor past what the message covered. The uuid is `noticeBatchUuid(appId, pairs)`, from the set of (subscription, event) pairs, so a batch sent again after a restart keeps it. A failed send — a network failure included, and a send past 30 s — moves no cursor and holds its conversation back; one refused as unreachable (`UNREACHABLE_CODES`), or failing `DEAD_AFTER` times at five minutes, drops its notices with one log line and lets the conversation go until a restart. One conversation or subscription that throws holds up no other; a round sends to at most ten conversations, the longest waiting first; and when a subscription has more than 100 events to read, nothing past what it read is sent that round, so the order holds. A new `Notifier` over the same database is a restart: it knows only the cursors.

- [ ] **Step 8.1: Write the failing tests.**

In `tests/ids.test.ts`, replace:

```ts
  newTurnId,
  replyUuid,
```

with:

```ts
  newTurnId,
  noticeBatchUuid,
  replyUuid,
```

In `tests/ids.test.ts`, replace:

```ts
describe('approvalNonce', () => {
```

with:

```ts
describe('noticeBatchUuid', () => {
  it('is the same for the same set of pairs, in any order, after a restart too, and differs for any other set', () => {
    const a = noticeBatchUuid('cli_app', [
      [3, 41],
      [5, 44],
    ]);
    expect(
      noticeBatchUuid('cli_app', [
        [5, 44],
        [3, 41],
      ]),
    ).toBe(a);
    expect(a).toHaveLength(50);
    const others = [
      noticeBatchUuid('cli_app', [[3, 41]]),
      noticeBatchUuid('cli_app', [
        [3, 41],
        [5, 45],
      ]),
      // Not one pair's digits run into the next's.
      noticeBatchUuid('cli_app', [
        [3, 414],
        [5, 4],
      ]),
      noticeBatchUuid('cli_other', [
        [3, 41],
        [5, 44],
      ]),
    ];
    expect(new Set([a, ...others]).size).toBe(5);
    // Never a control reply's or a session send's.
    expect(a).not.toBe(replyUuid('cli_app', '3', '41'));
    expect(a).not.toBe(sendUuid('cli_app', '3', 41));
  });
});

describe('approvalNonce', () => {
```

Create `tests/kanban-notices.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelError, type Channel } from '../src/channel/types.js';
import { noticeBatchUuid } from '../src/core/ids.js';
import { dueSubscriptions, eventsOf, subscriptionsOf } from '../src/db/kanban-read.js';
import {
  BATCH_NOTICES,
  DEAD_AFTER,
  NOTICE_BACKOFF_MAX_MS,
  NOTICE_POLL_MS,
  Notifier,
  ROUND_EVENTS,
  ROUND_SENDS,
} from '../src/kanban/notices.js';
import { KanbanService } from '../src/kanban/service.js';
import type { CreatedVia, TaskRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { ALICE, WORKSPACES } from './helpers/kanban.js';

/**
 * Subscriptions' notices (spec §9.4): one message per conversation a round, in
 * event order, the cursors moved once it is sent; at least once, with one uuid
 * per batch; a conversation that cannot be reached let go of; and caught up
 * after a restart by the same code.
 */

const VIA: CreatedVia = { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' };
const ELSEWHERE: CreatedVia = { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_other', threadId: '' };
const BROKEN: CreatedVia = { kind: 'chat', channel: 'broken', appId: 'cli_app', conversationId: 'oc_other', threadId: '' };

let t: TestDb;
let clock: ManualClock;
let service: KanbanService;
let lark: FakeChannel;
let notes: string[];

beforeEach(() => {
  clearSecrets();
  t = testDb();
  clock = new ManualClock();
  service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock,
  });
  lark = new FakeChannel({ id: 'lark', clock });
  notes = [];
});
afterEach(() => {
  clearSecrets();
  t.close();
});

function notifier(opts: { appId?: string; channels?: ReadonlyMap<string, Channel>; sendTimeoutMs?: number } = {}): Notifier {
  return new Notifier({
    ...(opts.sendTimeoutMs === undefined ? {} : { sendTimeoutMs: opts.sendTimeoutMs }),
    db: t.db,
    service,
    channels: opts.channels ?? new Map([['lark', lark]]),
    appId: opts.appId ?? 'cli_app',
    blockRecurrenceLimit: 2,
    clock,
    note: (line) => notes.push(line),
  });
}

function create(title: string, via: CreatedVia = VIA): TaskRow {
  const r = service.create({ title, assignee: 'implementer', createdBy: ALICE, createdVia: via });
  if (!r.ok) throw new Error(r.message);
  return r.task;
}

async function done(task: TaskRow, summary: string): Promise<void> {
  const r = await service.complete(task.taskId, { kind: 'person', principal: ALICE }, { summary });
  if (!r.ok) throw new Error(r.message);
}

function eventId(task: TaskRow, kind: string): number {
  return eventsOf(t.db, task.taskId).find((e) => e.kind === kind)?.id ?? 0;
}

function subId(task: TaskRow): number {
  return subscriptionsOf(t.db, task.taskId)[0]?.id ?? 0;
}

describe('the notifier', () => {
  it("sends a conversation one message a round, its subscriptions' notices in event order, passing over the rest", async () => {
    const a = create('Draft the notes');
    const b = create('Check the links');
    expect(service.comment(a.taskId, 'first draft by Friday', ALICE, { steers: true }).ok).toBe(true);
    expect(service.block(b.taskId, { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason: 'which wiki?' }).ok).toBe(true);
    await done(a, 'merged');
    const n = notifier();

    expect(await n.deliver()).toBe(2);
    expect(lark.texts).toHaveLength(1);
    expect(lark.texts[0]?.target).toEqual({ chatId: 'oc_team', threadId: 'omt_topic' });
    expect(lark.texts[0]?.text.split('\n\n')).toEqual([
      `Blocked (needs\\_input) — **Check the links** \`${b.taskId}\`: which wiki?\n\`/kanban unblock ${b.taskId} [comment]\` once it can go on.`,
      `Done — **Draft the notes** \`${a.taskId}\`:\n> merged`,
    ]);
    expect(lark.texts[0]?.uuid).toBe(
      noticeBatchUuid('cli_app', [
        [subId(b), eventId(b, 'blocked')],
        [subId(a), eventId(a, 'completed')],
      ]),
    );
    // Every event, a notice or not, is behind its cursor now.
    expect(subscriptionsOf(t.db, a.taskId)[0]?.cursor).toBe(eventsOf(t.db, a.taskId).at(-1)?.id);
    expect(subscriptionsOf(t.db, b.taskId)[0]?.cursor).toBe(eventsOf(t.db, b.taskId).at(-1)?.id);
    expect(await n.deliver()).toBe(0);
    expect(lark.texts).toHaveLength(1);
  });

  it('sends at most a batch of notices a message, says more follow, and sends them in the next round', async () => {
    const tasks = Array.from({ length: BATCH_NOTICES + 3 }, (_, i) => create(`task ${i}`));
    for (const task of tasks) await done(task, 'ok');
    const n = notifier();
    expect(await n.deliver()).toBe(BATCH_NOTICES);
    const first = lark.texts[0]?.text.split('\n\n') ?? [];
    expect(first).toHaveLength(BATCH_NOTICES + 1);
    expect(first.at(-1)).toBe('… and 3 more, in the next message.');
    // The cursors moved past what was sent, and no further.
    const last = tasks.at(-1);
    if (last === undefined) throw new Error('no tasks');
    expect(subscriptionsOf(t.db, last.taskId)[0]?.cursor).toBeLessThan(eventId(last, 'completed'));
    expect(await n.deliver()).toBe(3);
    expect(lark.texts[1]?.text.split('\n\n')).toHaveLength(3);
    expect(await n.deliver()).toBe(0);
  });

  it('sends each conversation its own message', async () => {
    await done(create('Here'), 'ok');
    await done(create('There', ELSEWHERE), 'ok');
    expect(await notifier().deliver()).toBe(2);
    expect(lark.texts.map((m) => m.target.chatId).sort()).toEqual(['oc_other', 'oc_team']);
  });

  it("tells the chat following a task about the tasks that task's runs create", async () => {
    const parent = create('Plan the launch');
    const claimed = service.claim(parent.taskId);
    if (!claimed.ok) throw new Error(claimed.message);
    const child = service.create({
      title: 'Book the room',
      assignee: 'implementer',
      createdBy: `run:${claimed.run.runId}`,
      createdVia: { kind: 'run', runId: claimed.run.runId },
    });
    if (!child.ok) throw new Error(child.message);
    expect(service.stop(parent.taskId, ALICE).ok).toBe(true);
    expect(service.closeRun(claimed.run.runId).ok).toBe(true);
    await done(child.task, 'booked');
    await notifier().deliver();
    expect(lark.texts.map((m) => m.text.split('\n\n').map((n) => n.split('\n')[0]))).toEqual([
      [
        `Blocked (needs\\_input) — **Plan the launch** \`${parent.taskId}\`: stopped by lark:on\\_alice`,
        `Done — **Book the room** \`${child.task.taskId}\`:`,
      ],
    ]);
  });

  it('keeps the cursors where they are when a send fails, and tries again after a pause, sending once', async () => {
    const a = create('Draft the notes');
    await done(a, 'merged');
    const n = notifier();
    lark.failNext('sendText', new ChannelError(99991400, 'rate limited', true));
    expect(await n.deliver()).toBe(0);
    expect(notes.at(-1)).toBe(
      `kanban: notices for oc_team/omt_topic (task ${a.taskId}) were not sent (rate limited (code 99991400)); trying again in 2 s`,
    );
    expect(subscriptionsOf(t.db, a.taskId)[0]?.cursor).toBe(0);
    // Held back until the pause is over.
    expect(await n.deliver()).toBe(0);
    clock.advance(NOTICE_POLL_MS);
    expect(await n.deliver()).toBe(1);
    expect(lark.texts).toHaveLength(1);
    expect(await n.deliver()).toBe(0);
  });

  it('holds a conversation back on a network failure, which Lark reports as code 0 and not retryable, and sends once later', async () => {
    const a = create('Draft the notes');
    await done(a, 'merged');
    const n = notifier();
    lark.failNext('sendText', new ChannelError(0, 'socket hang up', false));
    expect(await n.deliver()).toBe(0);
    expect(notes.at(-1)).toContain('were not sent (socket hang up (code 0)); trying again in 2 s');
    expect(notes.some((l) => l.includes('cannot be reached'))).toBe(false);
    clock.advance(NOTICE_POLL_MS);
    expect(await n.deliver()).toBe(1);
    expect(lark.texts).toHaveLength(1);
  });

  it('counts a send that never answers as failed, and sends the batch again later with the same uuid', async () => {
    const a = create('Draft the notes');
    await done(a, 'merged');
    const n = notifier({ sendTimeoutMs: 20 });
    lark.hold();
    expect(await n.deliver()).toBe(0);
    expect(notes.at(-1)).toContain('were not sent (the send took longer than 20 ms)');
    expect(subscriptionsOf(t.db, a.taskId)[0]?.cursor).toBe(0);
    // The slow send lands after all; the batch goes again, as at least once allows, with its uuid.
    lark.release();
    clock.advance(NOTICE_POLL_MS);
    expect(await n.deliver()).toBe(1);
    expect(lark.texts).toHaveLength(2);
    expect(lark.texts[1]?.uuid).toBe(lark.texts[0]?.uuid);
    expect(await n.idle(10)).toBe(true);
  });

  it('says it has not finished while a send is held, and that it has once the round is over', async () => {
    await done(create('Draft the notes'), 'merged');
    const n = notifier();
    lark.hold();
    const round = n.deliver();
    expect(await n.idle(10)).toBe(false);
    lark.release();
    expect(await round).toBe(1);
    expect(await n.idle(10)).toBe(true);
  });

  it(`sends to at most ${ROUND_SENDS} conversations a round, the longest waiting first`, async () => {
    const chats = Array.from({ length: ROUND_SENDS + 2 }, (_, i) => `oc_chat_${String(i).padStart(2, '0')}`);
    // Completed newest chat first, so the oldest pending event is the last chat's.
    const tasks = chats.map((chat) => create(`for ${chat}`, { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: chat, threadId: '' }));
    for (const task of [...tasks].reverse()) await done(task, 'ok');
    const n = notifier();
    expect(await n.deliver()).toBe(ROUND_SENDS);
    // Every task's oldest pending event is its creation, so the first created waits longest.
    expect(lark.texts.map((m) => m.target.chatId)).toEqual(chats.slice(0, ROUND_SENDS));
    expect(await n.deliver()).toBe(2);
    expect(lark.texts.slice(ROUND_SENDS).map((m) => m.target.chatId)).toEqual(chats.slice(ROUND_SENDS));
  });

  it(`keeps event order when a subscription has more than ${ROUND_EVENTS} events to read`, async () => {
    const a = create('Long thread');
    const b = create('Short one');
    for (let i = 0; i < ROUND_EVENTS + 20; i += 1) expect(service.comment(a.taskId, `note ${i}`, ALICE, { steers: true }).ok).toBe(true);
    expect(service.block(a.taskId, { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason: 'which one?' }).ok).toBe(true);
    await done(b, 'quick');
    const n = notifier();
    // The first round reads only a's first ROUND_EVENTS, none a notice, and so holds b's later one back.
    expect(await n.deliver()).toBe(0);
    expect(await n.deliver()).toBe(2);
    expect(lark.texts.map((m) => m.text.split('\n\n').map((x) => x.split(' — ')[0]))).toEqual([['Blocked (needs\\_input)', 'Done']]);
  });

  it('lets go of a conversation a send refuses as unreachable: its notices dropped, said once, the rest passed over until a restart', async () => {
    const a = create('Draft the notes');
    const b = create('Check the links');
    const elsewhere = create('Elsewhere', ELSEWHERE);
    await done(a, 'merged');
    await done(b, 'checked');
    await done(elsewhere, 'ok');
    // The team's thread is the first sent to: its subscriptions are the oldest.
    lark.failNext('sendText', new ChannelError(230002, 'the bot is not in the chat', false));
    const n = notifier();
    expect(await n.deliver()).toBe(1);
    expect(lark.texts.map((m) => m.target.chatId)).toEqual(['oc_other']);
    const dropped = notes.filter((l) => l.includes('cannot be reached'));
    expect(dropped).toEqual([
      `kanban: oc_team/omt_topic (tasks ${a.taskId}, ${b.taskId}) cannot be reached (the bot is not in the chat (code 230002)); ` +
        `dropping 2 notice(s) (${a.taskId}#${eventId(a, 'completed')}, ${b.taskId}#${eventId(b, 'completed')}) ` +
        'and passing over its notices until the gateway restarts',
    ]);
    // Later notices are passed over without a send, or another line.
    await done(create('Another'), 'ok');
    expect(await n.deliver()).toBe(0);
    expect(notes.filter((l) => l.includes('cannot be reached'))).toHaveLength(1);
    expect(dueSubscriptions(t.db, 'cli_app')).toEqual([]);
    // A restart tries the conversation again.
    await done(create('After the restart'), 'ok');
    expect(await notifier().deliver()).toBe(1);
    expect(lark.texts.at(-1)?.target.chatId).toBe('oc_team');
  });

  it(`lets go of a conversation whose sends fail ${DEAD_AFTER} times in a row at the longest pause`, async () => {
    const a = create('Draft the notes');
    await done(a, 'merged');
    const n = notifier();
    let failures = 0;
    for (;;) {
      lark.failNext('sendText', new ChannelError(99991400, 'rate limited', true));
      await n.deliver();
      failures += 1;
      if (notes.some((l) => l.includes('cannot be reached'))) break;
      expect(subscriptionsOf(t.db, a.taskId)[0]?.cursor).toBe(0);
      clock.advance(NOTICE_BACKOFF_MAX_MS);
      if (failures > 20) throw new Error('never let go');
    }
    // Eight pauses of 2 s to 256 s, then DEAD_AFTER failures at five minutes, the last letting it go.
    expect(failures).toBe(8 + DEAD_AFTER);
    expect(subscriptionsOf(t.db, a.taskId)[0]?.cursor).toBe(eventsOf(t.db, a.taskId).at(-1)?.id);
  });

  it('keeps one subscription that cannot be read, or one conversation that throws, from holding up the rest', async () => {
    const a = create('Draft the notes');
    await done(a, 'merged');
    // A subscription whose task is not on the board, in the same conversation.
    t.db.pragma('foreign_keys = OFF');
    t.db
      .prepare(
        `INSERT INTO kanban_subscriptions (task_id, channel, account_id, conversation_id, thread_id, created_at)
         VALUES ('k_gone', 'lark', 'cli_app', 'oc_team', 'omt_topic', 0)`,
      )
      .run();
    t.db
      .prepare(
        `INSERT INTO kanban_events (task_id, kind, actor, payload, created_at) VALUES ('k_gone', 'stranded', 'gateway', jsonb('{}'), 0)`,
      )
      .run();
    t.db.pragma('foreign_keys = ON');
    // And a conversation on a channel whose lookup throws.
    const broken = create('On a broken channel', BROKEN);
    await done(broken, 'ok');
    const channels = new Map<string, Channel>([['lark', lark]]);
    const get = channels.get.bind(channels);
    channels.get = (id: string) => {
      if (id === 'broken') throw new Error('the channel table is broken');
      return get(id);
    };
    expect(await notifier({ channels }).deliver()).toBe(1);
    expect(lark.texts.map((m) => m.text.split('\n')[0])).toEqual([`Done — **Draft the notes** \`${a.taskId}\`:`]);
    expect(notes).toContain(
      'kanban: notices for subscription 2 of task k_gone were not sent (task k_gone is not on the board); trying again in 2 s',
    );
    expect(notes).toContain(
      `kanban: notices for oc_other (task ${broken.taskId}) were not sent (the channel table is broken); trying again in 2 s`,
    );
  });

  it('catches up after a restart from the cursors, sending again only what was not marked sent, with the same uuid', async () => {
    const a = create('Draft the notes');
    await done(a, 'merged');
    expect(await notifier().deliver()).toBe(1);
    // A new process: nothing is sent twice that was marked sent.
    expect(await notifier().deliver()).toBe(0);
    // One that stopped after the send and before its cursors moved.
    t.db.prepare('UPDATE kanban_subscriptions SET cursor = 0').run();
    expect(await notifier().deliver()).toBe(1);
    expect(lark.texts).toHaveLength(2);
    expect(lark.texts[1]?.uuid).toBe(lark.texts[0]?.uuid);
  });

  it("runs one round at a time, delivers only this bot's subscriptions, and masks what it sends", async () => {
    addSecrets(['sk-notice-12345678']);
    const mine = create('Rotate the key');
    const theirs = create('Elsewhere', { kind: 'chat', channel: 'lark', appId: 'cli_other', conversationId: 'oc_team', threadId: '' });
    await done(mine, 'rotated, old one was sk-notice-12345678');
    await done(theirs, 'done');
    const n = notifier();
    const [first, second] = await Promise.all([n.deliver(), n.deliver()]);
    expect([first, second]).toEqual([1, 1]);
    expect(lark.texts).toHaveLength(1);
    expect(lark.texts[0]?.text).toContain(`old one was ${MASK}`);
    expect(lark.texts[0]?.text).not.toContain('sk-notice');
  });

  it('sends nothing once stopped, and idle waits for the round under way', async () => {
    const a = create('Draft the notes');
    await done(a, 'merged');
    const n = notifier();
    lark.hold();
    const round = n.deliver();
    n.stop();
    lark.release();
    await n.idle();
    expect(await round).toBe(1);
    expect(await n.deliver()).toBe(0);
    await done(create('Another'), 'ok');
    expect(await n.deliver()).toBe(0);
    expect(lark.texts).toHaveLength(1);
  });
});
```


- [ ] **Step 8.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/ids.test.ts tests/kanban-notices.test.ts`. Expected: `tests/kanban-notices.test.ts` FAILS to load, with `Error: Cannot find module '../src/kanban/notices.js'`, and the `noticeBatchUuid` test FAILS with `TypeError: (0 , noticeBatchUuid) is not a function`. `Test Files  2 failed (2)`, `Tests  1 failed | 14 passed (15)`.

- [ ] **Step 8.3: Implement.**

In `src/core/ids.ts`, replace:

```ts
/**
 * The opaque value carried in a card button's `action.value`.
```

with:

```ts
/**
 * The `uuid` for one message of board notices (spec §9.4): a conversation's
 * batch, covering these (subscription, event) pairs.
 *
 * Derived from the set of pairs, in any order, so the batch a restart sends
 * again -- sent, and the gateway stopped before the cursors moved past it --
 * carries the uuid the first one did, and a channel that deduplicates by it
 * shows one message.
 */
export function noticeBatchUuid(appId: string, pairs: ReadonlyArray<readonly [number, number]>): string {
  const covered = [...new Set(pairs.map(([sub, event]) => `${sub}:${event}`))].sort();
  const canonical = [appId, 'kanban-notices', ...covered].join(SEP);
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 50);
}

/**
 * The opaque value carried in a card button's `action.value`.
```

Create `src/kanban/notices.ts`:

```ts
import { ChannelError, type Channel, type SendTarget } from '../channel/types.js';
import { noticeBatchUuid } from '../core/ids.js';
import { dueSubscriptions, eventsAfter, getTask, type DueSubscription } from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import { redactKnownSecrets } from '../secrets.js';
import { systemClock, type Clock } from '../time.js';
import { renderNotice } from './chat-render.js';
import type { KanbanService } from './service.js';
import type { KanbanEvent, SubscriptionRow } from './types.js';

/**
 * Subscriptions' notices (spec §9.4): what a chat following a task hears.
 *
 * **Delivery is a projection over `kanban_events`, from a cursor.** Each round
 * reads the subscriptions with an event past their cursor, groups them by the
 * conversation -- chat, or thread -- they deliver to, and sends each
 * conversation at most one message: that round's notices for all its
 * subscriptions, in event order, at most `BATCH_NOTICES` of them. Once the send
 * succeeded, each subscription's cursor moves past what the message covered,
 * and past the events that are no notice. After a restart the first round
 * starts from the cursors in the database, so catching up after an outage is the
 * same code as delivering in normal running.
 *
 * **At least once.** A send that fails moves no cursor. A batch's uuid is derived
 * from the set of (subscription, event) pairs it covers, so the same batch sent
 * again after a restart carries the same uuid, and a channel that deduplicates
 * by uuid shows it once. (The Lark adapter does not pass the uuid on yet; see
 * its note.)
 *
 * **A conversation that cannot be reached is let go of.** A send refused as
 * unreachable -- `UNREACHABLE_CODES`: the bot is not in the chat -- or failing
 * `DEAD_AFTER` times in a row at the longest pause, drops the notices it held,
 * says so once, and marks the conversation dead until the gateway restarts: its
 * later events are passed over without a send. A send that fails otherwise holds
 * the conversation back for a pause that doubles, up to five minutes, while the
 * others go on: a network failure, which the Lark adapter reports as code 0 and
 * not retryable, and a refusal of one bad batch, are not a dead chat. A send that
 * takes longer than `NOTICE_SEND_MS` counts as a failed one. A round sends to at
 * most `ROUND_SENDS` conversations, the longest waiting first, so a restart that finds many conversations due -- dead
 * ones among them -- spreads their sends over rounds rather than firing all at once.
 *
 * The board's writes come from chat, the worker socket and the dispatcher, so
 * rather than be told of each, the notifier looks every `NOTICE_POLL_MS`: a cheap
 * read when nothing is due.
 */

/** How often a round looks for notices to send. */
export const NOTICE_POLL_MS = 2_000;
/** The longest a conversation whose sends fail waits before it is tried again. */
export const NOTICE_BACKOFF_MAX_MS = 5 * 60_000;
/** Failures in a row at the longest pause after which a conversation is let go of. */
export const DEAD_AFTER = 3;
/** Notices in one message; the rest follow in the next round. */
export const BATCH_NOTICES = 20;
/** Characters in one message, so a batch is not cut by the channel. */
const BATCH_CHARS = 3_800;
/** Conversations sent to in one round. */
export const ROUND_SENDS = 10;
/** Events read for one subscription in one round; the rest wait for the next. */
export const ROUND_EVENTS = 100;
/** The longest a send is waited for; past it, it counts as failed. */
export const NOTICE_SEND_MS = 30_000;

/**
 * Lark's codes that mean this chat cannot be posted to by this bot, whatever is
 * sent: the only refusals that let a conversation go at once. 230002 is "the bot
 * is not in the chat". Lark has codes for a chat not found or disbanded too, but
 * they are not confirmed against anything in this repository or its SDK, so
 * they are left out: such a chat is let go of after `DEAD_AFTER` failures instead.
 */
export const UNREACHABLE_CODES: ReadonlySet<number> = new Set([230002]);

export interface NotifierDeps {
  db: Db;
  service: KanbanService;
  /** Where a subscription's channel id sends: `lark` to the Lark adapter. */
  channels: ReadonlyMap<string, Channel>;
  /** This bot: only its subscriptions are delivered here. */
  appId: string;
  /** `kanban.block_recurrence_limit` (spec §5.4). */
  blockRecurrenceLimit: number;
  clock?: Clock;
  /** Metadata only: ids and counts, never task text. */
  note?: (line: string) => void;
  /** How long a send is waited for; `NOTICE_SEND_MS` unless a test says otherwise. */
  sendTimeoutMs?: number;
}

/** One conversation's due subscriptions, and what each has to say this round. */
interface Conversation {
  key: string;
  channel: string;
  target: SendTarget;
  subs: DueSubscription[];
}

/** A subscription's events this round, and the notices among them. */
interface Pending {
  sub: SubscriptionRow;
  events: KanbanEvent[];
  notices: Array<{ event: KanbanEvent; text: string }>;
}

function conversationKey(sub: SubscriptionRow): string {
  return [sub.channel, sub.conversationId, sub.threadId].join('\u0000');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Notifier {
  readonly #deps: NotifierDeps;
  readonly #clock: Clock;
  readonly #note: (line: string) => void;
  /** Held back after a failure: by conversation key, or by subscription id for one that could not be read. */
  readonly #backoff = new Map<string, { until: number; waitMs: number; atMax: number }>();
  /** Conversations let go of until the gateway restarts. */
  readonly #dead = new Set<string>();
  #round: Promise<number> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(deps: NotifierDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
    const note = deps.note ?? (() => undefined);
    this.#note = (line) => {
      try {
        note(line);
      } catch {
        // Nowhere left to say it.
      }
    };
  }

  /** Deliver every `NOTICE_POLL_MS`, starting now: the first round is the catch-up after a restart. */
  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setInterval(() => void this.deliver(), NOTICE_POLL_MS);
    this.#timer.unref();
    void this.deliver();
  }

  /** No more rounds; one under way stops after its current send. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Once the round under way, if any, is over, or `boundMs` has passed: for
   * shutdown, before the channel disconnects and the database closes. True once
   * the round is over.
   */
  async idle(boundMs = this.#deps.sendTimeoutMs ?? NOTICE_SEND_MS): Promise<boolean> {
    const round = this.#round;
    if (round === undefined) return true;
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), boundMs);
    });
    try {
      return await Promise.race([round.then(() => true), bound]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One round, or the one already under way: never two at once, which could send
   * a notice twice. Resolves to the notices sent. Never rejects: a failure is
   * noted, and the next round tries again.
   */
  deliver(): Promise<number> {
    if (this.#round !== undefined) return this.#round;
    const round = this.#deliverOnce()
      .catch((err: unknown) => {
        this.#note(`kanban: delivering notices failed: ${message(err)}`);
        return 0;
      })
      .finally(() => {
        this.#round = undefined;
      });
    this.#round = round;
    return round;
  }

  async #deliverOnce(): Promise<number> {
    if (this.#stopped) return 0;
    const byKey = new Map<string, Conversation>();
    for (const sub of dueSubscriptions(this.#deps.db, this.#deps.appId)) {
      const key = conversationKey(sub);
      const c = byKey.get(key) ?? {
        key,
        channel: sub.channel,
        target: { chatId: sub.conversationId, threadId: sub.threadId },
        subs: [],
      };
      c.subs.push(sub);
      byKey.set(key, c);
    }
    // The longest waiting first, so a busy conversation cannot keep a quiet one waiting.
    const conversations = [...byKey.values()].sort((a, b) => oldest(a) - oldest(b));
    let sent = 0;
    let sends = 0;
    for (const c of conversations) {
      if (this.#stopped) break;
      if (this.#held(c.key)) continue;
      try {
        const r = await this.#deliverTo(c, sends < ROUND_SENDS);
        sent += r.notices;
        if (r.sent) sends += 1;
      } catch (err) {
        // One conversation's failure -- a read, a render -- is that conversation's.
        this.#fail(c, err);
      }
    }
    return sent;
  }

  /**
   * One conversation: its subscriptions' notices in event order, sent as one
   * message when `maySend`, and every cursor moved past what that covered.
   */
  async #deliverTo(c: Conversation, maySend: boolean): Promise<{ notices: number; sent: boolean }> {
    const pending: Pending[] = [];
    for (const sub of c.subs) {
      if (this.#held(`sub:${sub.id}`)) continue;
      try {
        pending.push(this.#read(sub));
      } catch (err) {
        // One subscription that cannot be read does not hold up its neighbours.
        this.#holdBack(`sub:${sub.id}`, `subscription ${sub.id} of task ${sub.taskId}`, message(err));
      }
    }
    // A subscription read only its first ROUND_EVENTS: events past the last it read
    // may come after another's notices, so nothing past that point goes this round.
    const capped = pending.filter((p) => p.events.length >= ROUND_EVENTS).map((p) => p.events.at(-1)?.id ?? 0);
    const readTo = capped.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...capped);
    const all = pending
      .flatMap((p) => p.notices.map((n) => ({ ...n, sub: p.sub })))
      .filter((n) => n.event.id <= readTo)
      .sort((a, b) => a.event.id - b.event.id);
    if (this.#dead.has(c.key)) {
      // Let go of until a restart: passed over, without a send.
      this.#advanceAll(pending, readTo);
      return { notices: 0, sent: false };
    }
    if (all.length === 0) {
      this.#advanceAll(pending, readTo);
      return { notices: 0, sent: false };
    }
    const channel = this.#deps.channels.get(c.channel);
    if (channel === undefined) {
      this.#holdBack(c.key, describe(c), `no channel ${c.channel}`);
      return { notices: 0, sent: false };
    }
    if (!maySend) return { notices: 0, sent: false };
    const batch: typeof all = [];
    let chars = 0;
    for (const n of all) {
      if (batch.length >= BATCH_NOTICES || (batch.length > 0 && chars + n.text.length + 2 > BATCH_CHARS)) break;
      batch.push(n);
      chars += n.text.length + 2;
    }
    const more = all.length - batch.length;
    const text = [...batch.map((n) => n.text), ...(more > 0 ? [`… and ${more} more, in the next message.`] : [])].join('\n\n');
    // The last event the message covers: each cursor moves to it, notices or not.
    const upTo = more > 0 ? (batch.at(-1)?.event.id ?? 0) : readTo;
    try {
      await this.#bounded(
        channel.sendText(
          c.target,
          redactKnownSecrets(text),
          noticeBatchUuid(
            this.#deps.appId,
            batch.map((n) => [n.sub.id, n.event.id]),
          ),
        ),
      );
    } catch (err) {
      this.#sendFailed(c, pending, err);
      return { notices: 0, sent: true };
    }
    this.#backoff.delete(c.key);
    this.#advanceAll(pending, upTo);
    return { notices: batch.length, sent: true };
  }

  /**
   * A send, waited for at most `sendTimeoutMs`. A send that takes longer fails
   * here, and its batch is sent again later with the same uuid; the slow one may
   * still land, so at least once, as ever.
   */
  async #bounded<T>(send: Promise<T>): Promise<T> {
    const ms = this.#deps.sendTimeoutMs ?? NOTICE_SEND_MS;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      const took = ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
      timer = setTimeout(() => reject(new Error(`the send took longer than ${took}`)), ms);
    });
    try {
      return await Promise.race([send, late]);
    } finally {
      clearTimeout(timer);
      // A send that loses the race may still fail later; nobody is waiting for it.
      send.catch(() => undefined);
    }
  }

  /** A subscription's events past its cursor, and the notices among them. */
  #read(sub: SubscriptionRow): Pending {
    const task = getTask(this.#deps.db, sub.taskId);
    if (task === undefined) throw new Error(`task ${sub.taskId} is not on the board`);
    const events = eventsAfter(this.#deps.db, sub.taskId, sub.cursor, ROUND_EVENTS);
    const notices: Pending['notices'] = [];
    for (const event of events) {
      const text = renderNotice(event, task, { blockRecurrenceLimit: this.#deps.blockRecurrenceLimit });
      if (text !== undefined) notices.push({ event, text });
    }
    return { sub, events, notices };
  }

  /** Move each subscription's cursor to its last event at or before `upTo`. */
  #advanceAll(pending: readonly Pending[], upTo: number): void {
    for (const p of pending) {
      const last = p.events.filter((e) => e.id <= upTo).at(-1);
      if (last === undefined) continue;
      const moved = this.#deps.service.advanceSubscription(p.sub.id, last.id);
      if (!moved.ok) this.#holdBack(`sub:${p.sub.id}`, `subscription ${p.sub.id} of task ${p.sub.taskId}`, moved.message);
    }
  }

  /**
   * A send that failed: a refusal that will not change, or the last of
   * `DEAD_AFTER` at the longest pause, lets the conversation go -- its notices
   * dropped, said once -- and anything else holds it back for a while.
   */
  #sendFailed(c: Conversation, pending: readonly Pending[], err: unknown): void {
    // Only a refusal that names the chat as unreachable; code 0 is a network failure.
    const permanent = err instanceof ChannelError && UNREACHABLE_CODES.has(err.code);
    if (!permanent && next(this.#backoff.get(c.key)).atMax < DEAD_AFTER) {
      this.#holdBack(c.key, describe(c), message(err));
      return;
    }
    this.#dead.add(c.key);
    this.#backoff.delete(c.key);
    const dropped = pending.flatMap((p) => p.notices.map((n) => `${p.sub.taskId}#${n.event.id}`));
    this.#note(
      `kanban: ${describe(c)} cannot be reached (${message(err)}); dropping ${dropped.length} notice(s) ` +
        `(${dropped.join(', ')}) and passing over its notices until the gateway restarts`,
    );
    this.#advanceAll(pending, Number.POSITIVE_INFINITY);
  }

  #fail(c: Conversation, err: unknown): void {
    this.#holdBack(c.key, describe(c), message(err));
  }

  #held(key: string): boolean {
    const held = this.#backoff.get(key);
    return held !== undefined && this.#clock.now() < held.until;
  }

  /** Hold a conversation or a subscription back for a while, doubling each time, and say so. */
  #holdBack(key: string, what: string, why: string): void {
    const { waitMs, atMax } = next(this.#backoff.get(key));
    this.#backoff.set(key, { until: this.#clock.now() + waitMs, waitMs, atMax });
    this.#note(`kanban: notices for ${what} were not sent (${why}); trying again in ${Math.round(waitMs / 1000)} s`);
  }
}

/**
 * The pause after one more failure, doubling from 2 s to `NOTICE_BACKOFF_MAX_MS`,
 * and how many failures in a row have come at that longest pause.
 */
function next(held: { waitMs: number; atMax: number } | undefined): { waitMs: number; atMax: number } {
  const waitMs = Math.min((held?.waitMs ?? NOTICE_POLL_MS / 2) * 2, NOTICE_BACKOFF_MAX_MS);
  return { waitMs, atMax: waitMs === NOTICE_BACKOFF_MAX_MS ? (held?.atMax ?? 0) + 1 : 0 };
}

/** How long a conversation has waited: its oldest pending event's id. */
function oldest(c: Conversation): number {
  return Math.min(...c.subs.map((s) => s.oldestPending));
}

/** A conversation, by ids only: never task text. */
function describe(c: Conversation): string {
  const where = c.target.threadId === '' ? c.target.chatId : `${c.target.chatId}/${c.target.threadId}`;
  return `${where} (task${c.subs.length === 1 ? '' : 's'} ${c.subs.map((s) => s.taskId).join(', ')})`;
}
```


- [ ] **Step 8.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/ids.test.ts tests/kanban-notices.test.ts`. Expected: `Tests  31 passed (31)`.

- [ ] **Step 8.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1217 passed (1217)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  70 passed (70)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 8.6: Commit.**

```bash
git add src/core/ids.ts src/kanban/notices.ts tests/ids.test.ts tests/kanban-notices.test.ts
git commit -m "Deliver notices as one message per conversation a round, in event order, moving each cursor once it is sent, and let go of a conversation that cannot be reached"
```

---

### Task 9: Wiring it into the gateway

**Files:**
- Modify: `src/index.ts`, `tests/gateway-startup.test.ts`

Behind `kanban.enabled` and nowhere else (Decision 2): the router gets `KanbanChat`, over the same service as the worker socket, with the authorizer's tiers and the dispatcher's `pass` and `cancel`; the gateway gets a `Notifier` sending through the Lark adapter. The notifier starts once the channel is connected — its first round is the catch-up — stops with the dispatcher, and is waited for before the channel disconnects.

- [ ] **Step 9.1: Write the failing test.**

In `tests/gateway-startup.test.ts`, replace:

```ts
  it('builds no dispatcher unless kanban.enabled is set: chat runs as it did', async () => {
    const gateway = await createGateway(config, team);
    try {
      expect(gateway.dispatcher).toBeUndefined();
    } finally {
      await gateway.stop();
    }
  });
```

with:

```ts
  it('builds no dispatcher unless kanban.enabled is set: chat runs as it did', async () => {
    const gateway = await createGateway(config, team);
    try {
      expect(gateway.dispatcher).toBeUndefined();
      expect(gateway.notifier).toBeUndefined();
    } finally {
      await gateway.stop();
    }
  });

  it('starts delivering notices once connected, and stops before it disconnects, when kanban.enabled is set', async () => {
    vi.spyOn(LarkAdapter.prototype, 'connect').mockResolvedValue(undefined);
    const order: string[] = [];
    vi.spyOn(LarkAdapter.prototype, 'disconnect').mockImplementation(async () => {
      order.push('disconnect');
    });
    vi.spyOn(LarkInbound.prototype, 'start').mockImplementation(() => undefined);
    const gateway = await createGateway({ ...config, kanban: { ...config.kanban, enabled: true } }, team);
    const notifier = gateway.notifier;
    if (notifier === undefined) throw new Error('no notifier');
    vi.spyOn(notifier, 'start').mockImplementation(() => {
      order.push('notices start');
    });
    vi.spyOn(notifier, 'idle').mockImplementation(async () => {
      order.push('notices idle');
      return true;
    });
    await gateway.start();
    await gateway.stop();
    expect(order).toEqual(['notices start', 'notices idle', 'disconnect']);
  });
```


- [ ] **Step 9.2: Run it to verify it fails.** Run `npx vitest run --project unit tests/gateway-startup.test.ts`. Expected: the new test FAILS with `Error: no notifier`. `Tests  1 failed | 11 passed (12)`.

- [ ] **Step 9.3: Implement.**

In `src/index.ts`, replace:

```ts
import { Dispatcher } from './kanban/dispatcher.js';
import { KanbanService } from './kanban/service.js';
```

with:

```ts
import { KanbanChat } from './kanban/chat.js';
import { Dispatcher } from './kanban/dispatcher.js';
import { Notifier } from './kanban/notices.js';
import { KanbanService } from './kanban/service.js';
```

In `src/index.ts`, replace:

```ts
  /** The board's dispatcher, when `kanban.enabled` is set. */
  readonly dispatcher: Dispatcher | undefined;
}
```

with:

```ts
  /** The board's dispatcher, when `kanban.enabled` is set. */
  readonly dispatcher: Dispatcher | undefined;
  /** What delivers the board's notices to the chats that follow its tasks, when `kanban.enabled` is set. */
  readonly notifier: Notifier | undefined;
}
```

In `src/index.ts`, replace:

```ts
  // Off until the board can be used: nothing can create a task before plan D (spec §12).
  let worker: { api: WorkerApi; socket: string } | undefined;
```

with:

```ts
  // Opt in: off unless kanban.enabled is set (spec §12). Chat runs as it always did
  // without it, and `/kanban` says the board is off.
  let worker: { api: WorkerApi; socket: string } | undefined;
  let kanbanChat: KanbanChat | undefined;
  let notifier: Notifier | undefined;
```

In `src/index.ts`, replace:

```ts
    // A worker's create, link or report can make a task claimable.
    worker = { api: new WorkerApi({ db, service, changed: () => dispatcher?.pass() }), socket };
```

with:

```ts
    // A worker's create, link or report can make a task claimable.
    worker = { api: new WorkerApi({ db, service, changed: () => dispatcher?.pass() }), socket };
    // /kanban in chat (spec §9.1): through the same service, with the router's tiers.
    kanbanChat = new KanbanChat({
      service,
      hasTier: (principal, tier) => authorizer.hasTier(principal, tier),
      changed: () => dispatcher?.pass(),
      cancel: (runId) => {
        dispatcher?.cancel(runId);
      },
    });
    // What the chats following a task hear (spec §9.4), sent through Lark.
    notifier = new Notifier({
      db,
      service,
      channels: new Map<string, Channel>([[adapter.id, adapter]]),
      appId: config.lark.appId,
      blockRecurrenceLimit: config.kanban.blockRecurrenceLimit,
      note,
    });
```

In `src/index.ts`, replace:

```ts
    channelId: adapter.id,
    appId: config.lark.appId,
    note,
  });

  const inbound = new LarkInbound({
```

with:

```ts
    channelId: adapter.id,
    appId: config.lark.appId,
    ...(kanbanChat === undefined ? {} : { kanban: kanbanChat }),
    note,
  });

  const inbound = new LarkInbound({
```

In `src/index.ts`, replace:

```ts
  return {
    db,
    dispatcher,
```

with:

```ts
  return {
    db,
    dispatcher,
    notifier,
```

In `src/index.ts`, replace:

```ts
      note(`connected as ${adapter.botOpenId ?? 'unknown bot identity'}`);
```

with:

```ts
      note(`connected as ${adapter.botOpenId ?? 'unknown bot identity'}`);
      // Once connected: its first round catches up on what the chats missed while the gateway was down.
      notifier?.start();
```

In `src/index.ts`, replace:

```ts
      // No more claims; the runs still open are ended by the next boot.
      dispatcher?.stop();
```

with:

```ts
      // No more claims; the runs still open are ended by the next boot.
      dispatcher?.stop();
      // No more notices; what was not sent is sent by the next boot, from the cursors.
      notifier?.stop();
```

In `src/index.ts`, replace:

```ts
      await workerServer?.close();
      await adapter.disconnect().catch((err: unknown) => {
```

with:

```ts
      await workerServer?.close();
      // A notice being sent finishes while the channel is still connected; bounded, as a send is.
      if ((await notifier?.idle()) === false) note('kanban: stopped with a notice still being sent; the next boot sends it again');
      await adapter.disconnect().catch((err: unknown) => {
```


- [ ] **Step 9.4: Run it to verify it passes.** Run `npx vitest run --project unit tests/gateway-startup.test.ts`. Expected: `Tests  12 passed (12)`.

- [ ] **Step 9.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1218 passed (1218)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  70 passed (70)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 9.6: Commit.**

```bash
git add src/index.ts tests/gateway-startup.test.ts
git commit -m "Give the router the board's chat commands and start the notices once connected, both only when kanban.enabled is set"
```

---

### Task 10: End to end: `/kanban new` from a thread, and the thread hears it is done

**Files:**
- Create: `tests/kanban-chat.e2e.ts`

D1's proof (spec §11, "Chat (D1)" and "Notices"). A person types `/kanban new` in a group's topic thread; the real router hands it to `KanbanChat`, which creates the task and tells the real dispatcher; the dispatcher runs it as a session whose agent is a real process — the fake CLI agent in its `kanban` mode, through the real CLI driver — which reports `mt kanban complete` through the shim and the real socket; and a `Notifier` sends the thread one notice of the completion, through a `FakeChannel` standing for Lark. A second round, and a new notifier standing for a restart, send nothing more. A second test runs the agent in its `crash` mode: the thread hears the retry and the giving up, in one message.

- [ ] **Step 10.1: Write the test.**

Create `tests/kanban-chat.e2e.ts`:

```ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Channel } from '../src/channel/types.js';
import { SessionRegistry } from '../src/core/registry.js';
import { Router } from '../src/core/router.js';
import { NamedWorkspaces } from '../src/core/workspace.js';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import { createCliDriver } from '../src/driver/cli/driver.js';
import type { Driver } from '../src/driver/types.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { Dispatcher } from '../src/kanban/dispatcher.js';
import { Notifier } from '../src/kanban/notices.js';
import { KanbanService } from '../src/kanban/service.js';
import { writeMtShim } from '../src/kanban/shim.js';
import { KanbanSink } from '../src/kanban/sink.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { WorkerApi } from '../src/kanban/worker.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import { clearSecrets } from '../src/secrets.js';
import type { InboundMessage, Principal } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { FakeDriver } from './helpers/driver.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';

/**
 * The board from Lark, end to end (spec §9, §11): a person types `/kanban new`
 * in a group thread; the router hands it to the board's chat commands; the real
 * dispatcher runs the task as a session whose agent is a real process -- the
 * fake CLI agent, through the real CLI driver -- which reports through `mt
 * kanban` and the real socket; and the thread hears of it, once, from its
 * subscription.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));
const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };

interface Stack {
  t: TestDb;
  lark: FakeChannel;
  router: Router;
  dispatcher: Dispatcher;
  notifier: () => Notifier;
  server: WorkerServer;
  registry: SessionRegistry;
  dir: string;
}

let stack: Stack | undefined;
let seq = 0;

beforeEach(() => clearSecrets());
afterEach(async () => {
  clearSecrets();
  if (stack === undefined) return;
  await stack.registry.closeAll();
  await stack.dispatcher.idle(5_000);
  await stack.server.close();
  stack.t.close();
  rmSync(stack.dir, { recursive: true, force: true });
  stack = undefined;
});

async function build(mode: string): Promise<Stack> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-chat-e2e-')));
  const home = join(dir, 'home');
  const workspace = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(workspace);
  const t = testDb();
  const roles = new Map([['implementer', role('implementer')]]);
  const service = new KanbanService({ db: t.db, roles, workspaces: new Set(['default']) });
  const lark = new FakeChannel({ id: 'lark' });
  const drivers = new Map<string, Driver>([
    ['default', new FakeDriver()],
    [
      'implementer',
      createCliDriver({
        command: process.execPath,
        args: [AGENT],
        env: { FAKE_CLI_MODE: mode, FAKE_CLI_LOG: join(dir, 'invocations.log') },
      }),
    ],
  ]);
  let dispatcher: Dispatcher | undefined;
  const registry = new SessionRegistry({
    db: t.db,
    drivers,
    channels: new Map<string, Channel>([
      ['lark', lark],
      ['kanban', new KanbanSink()],
    ]),
    envFor: (sessionId) => dispatcher?.envFor(sessionId),
    argsFor: (sessionId) => dispatcher?.argsFor(sessionId),
    pinned: (sessionId) => dispatcher?.pinned(sessionId) ?? false,
    workspaces: new NamedWorkspaces(new Map([['default', workspace]])),
    appId: 'cli_app',
    maxLive: 4,
  });
  const socket = workerSocketPath(home);
  dispatcher = new Dispatcher({
    db: t.db,
    service,
    sessions: registry,
    roles,
    appId: 'cli_app',
    settings: { maxRunning: 2, defaultMaxRuntimeS: 600, strandedAfterS: 1800, sweepIntervalS: 60, nudgeLimit: 0 },
    worker: { socket, mtDir: writeMtShim(home), path: process.env['PATH'] },
  });
  const d = dispatcher;
  const api = new WorkerApi({ db: t.db, service, changed: () => d.pass() });
  const server = await listenWorker(socket, (request, signal) => api.handle(request, { signal }));
  const authorizer = new Authorizer(defaultAuthConfig(OWNER.openId));
  const router = new Router({
    db: t.db,
    registry,
    authorizer,
    channel: lark,
    channelId: 'lark',
    appId: 'cli_app',
    kanban: new KanbanChat({
      service,
      hasTier: (principal, tier) => authorizer.hasTier(principal, tier),
      changed: () => d.pass(),
      cancel: (runId) => {
        d.cancel(runId);
      },
    }),
  });
  stack = {
    t,
    lark,
    router,
    dispatcher,
    // A new one is a new process: it knows only what the database does.
    notifier: () =>
      new Notifier({ db: t.db, service, channels: new Map([['lark', lark]]), appId: 'cli_app', blockRecurrenceLimit: 2 }),
    server,
    registry,
    dir,
  };
  return stack;
}

/** A message in the team's group, in a topic thread, mentioning the bot. */
function said(text: string): InboundMessage {
  return {
    messageId: `om_e2e_${++seq}`,
    appId: 'cli_app',
    chatId: 'oc_team',
    chatType: 'group',
    threadId: 'omt_topic',
    sender: OWNER,
    senderIsBot: false,
    text,
    mentionedBot: true,
    mentionAll: false,
    attachments: [],
    createTime: Date.now(),
  };
}

/** The task id the router's reply to /kanban new names. */
function createdIn(lark: FakeChannel): string {
  const reply = lark.texts.at(-1)?.text ?? '';
  const id = /^Created `(k_[0-9a-z]+)`/.exec(reply)?.[1];
  if (id === undefined) throw new Error(`no task created: ${reply}`);
  return id;
}

describe('the board from Lark, end to end', () => {
  it('/kanban new runs the task on a role, and the thread it was created in hears it is done, once', async () => {
    const s = await build('kanban');
    await s.router.onMessage(said('/kanban new Write the parser\nassignee: implementer\nworkspace: default\nIt reads CSV.'));
    const taskId = createdIn(s.lark);
    expect(s.lark.texts.at(-1)?.target).toEqual({ chatId: 'oc_team', threadId: 'omt_topic' });

    // The reply looked for work: the run started without waiting for a sweep.
    await s.dispatcher.idle();
    expect(getTask(s.t.db, taskId)?.phase).toBe('done');
    expect(runsOf(s.t.db, taskId)[0]).toMatchObject({ outcome: 'completed', summary: 'did: Write the parser' });

    const replies = s.lark.texts.length;
    expect(await s.notifier().deliver()).toBe(1);
    expect(s.lark.texts.slice(replies)).toEqual([
      {
        target: { chatId: 'oc_team', threadId: 'omt_topic' },
        text: `Done — **Write the parser** \`${taskId}\`:\n> did: Write the parser`,
        uuid: expect.any(String) as string,
      },
    ]);
    // Delivered is delivered: again, and after a restart, nothing more is sent.
    expect(await s.notifier().deliver()).toBe(0);
    expect(s.lark.texts).toHaveLength(replies + 1);

    // And /kanban show tells the same story.
    await s.router.onMessage(said(`/kanban show ${taskId}`));
    expect(s.lark.texts.at(-1)?.text).toContain('#1 work · role implementer · completed — did: Write the parser');
  });

  it("an agent that crashes is retried, then given up on, and the thread hears both", async () => {
    const s = await build('crash');
    await s.router.onMessage(said('/kanban new Flaky job\nassignee: implementer\nworkspace: default'));
    const taskId = createdIn(s.lark);
    await s.dispatcher.idle();
    expect(getTask(s.t.db, taskId)).toMatchObject({ phase: 'blocked', blockKind: 'gave_up' });

    const replies = s.lark.texts.length;
    // Both in one message to the thread: a round sends a conversation one batch.
    expect(await s.notifier().deliver()).toBe(2);
    expect(s.lark.texts.slice(replies)).toHaveLength(1);
    const [retry, gaveUp] = (s.lark.texts.at(-1)?.text ?? '').split('\n\n');
    expect(retry).toMatch(new RegExp(`^Retrying — \\*\\*Flaky job\\*\\* \`${taskId}\`: the last attempt ended crashed`));
    expect(gaveUp).toMatch(new RegExp(`^Gave up — \\*\\*Flaky job\\*\\* \`${taskId}\`: failed 2 times; last crashed`));
  });
});
```


- [ ] **Step 10.2: Run it to verify it passes.** Every piece it uses exists after Task 9, so this test is the integration check rather than a driver of new code. Run `npx vitest run --project e2e tests/kanban-chat.e2e.ts`. Expected: `Tests  2 passed (2)`. To see it fail first, stop new tasks being subscribed: in `src/db/kanban.ts`, comment out the line `subscribe(d, taskId, t.createdVia, createdFromTask, now);`. Expected: both tests FAIL, with `AssertionError: expected +0 to be 1 // Object.is equality` and `expected +0 to be 2`: the tasks ran, and nobody heard. `Tests  2 failed (2)`. Put the line back.

- [ ] **Step 10.3: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1218 passed (1218)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  72 passed (72)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 10.4: Commit.**

```bash
git add tests/kanban-chat.e2e.ts
git commit -m "End to end: /kanban new from a thread runs a fake agent through the real socket, and the thread hears it is done once"
```

---

### Task 11: The README

**Files:**
- Modify: `README.md`

The board from Lark: what a task is, `/kanban new`'s lines, every command with its tier, who is recorded, which comments reach an agent, the notices — batched, caught up after a restart, a dead chat let go of — and what waits for people; `kanban.enabled` as opt-in, and the new setting.

- [ ] **Step 11.1: Edit.**

In `README.md`, replace:

```md
| `kanban.enabled` | — | Run the board's dispatcher. Default **off**: nothing can create a task or report on one yet. The
```

with:

```md
| `kanban.enabled` | — | Run the board: its dispatcher, the worker socket, `/kanban` in chat and its notices. Default **off**, and opt-in: without it chat runs as it always did, and `/kanban` says the board is off. The
```

In `README.md`, replace:

```md
| `kanban.nudge_limit` | — | Reminders sent into a run whose turn ended without a report, before the run ends as a protocol violation. Default 2; 0 sends none. At most 10. |
```

with:

```md
| `kanban.nudge_limit` | — | Reminders sent into a run whose turn ended without a report, before the run ends as a protocol violation. Default 2; 0 sends none. At most 10. |
| `kanban.block_recurrence_limit` | — | Blocks of the same kind in a row, unblocked in between, at which a blocked notice stops inviting another unblock and suggests rewriting the task. Default 2, at most 100. |
```

In `README.md`, replace:

```md
| `/help` | talk | List commands |
| `/cd <path>` | operate |
```

with:

```md
| `/help` | talk | List commands |
| `/kanban <command>` | talk; operate to change the board | The task board, below. Never refused because this chat's session is busy |
| `/cd <path>` | operate |
```

In `README.md`, replace:

```md
second way to mutate it with no capability the button doesn't already have.
```

with:

````md
second way to mutate it with no capability the button doesn't already have.

### The board from Lark

With `kanban.enabled`, `/kanban` drives the board from any chat the bot is in. A task is any
work — research, a document, an operation in Lark, a chore, a change to code — given to a
role, whose agent runs it in a workspace, which is just a directory.

```
/kanban new Draft the Q3 summary
assignee: docs-writer
workspace: docs
outcome: a page in the team wiki
verify: the page links every source
Use last quarter's page as the model.
```

The first line is the title. Lines starting `assignee:`, `reviewer:`, `workspace:`, `parent:`
(one or more task ids; repeat it for more), `outcome:`, `verify:`, `constraints:`,
`boundaries:` and `stop when:` fill those fields, in any order and in any case; every other
line is the body. An unknown role or workspace is refused at once, and so is a role whose agent
is supervised. The dispatcher looks for work as soon as the task is created.

| Command | Tier |
|---|---|
| `/kanban new <title>` + lines | operate |
| `/kanban list [todo\|ready\|running\|review\|reviewing\|blocked\|done\|archived\|all]` | talk; without a status, the tasks someone may still act on |
| `/kanban show <task>` | talk: the task, its contract, gates, runs, latest output and comments |
| `/kanban assign <task> <role>` | operate: an undecided run ends `superseded` |
| `/kanban link <parent> <child>` | operate |
| `/kanban workspace <task> <name>` | operate: refused once the workspace is fixed |
| `/kanban comment <task> <text>` | talk: everyone sees it in `/kanban show`; an operator's also reaches the task's agent, when its turn ends or in its next run |
| `/kanban unblock <task> [comment]` | operate |
| `/kanban stop <task>` | operate: the run ends `cancelled`, and the task blocks |
| `/kanban archive <task>` | operate |
| `/kanban gate add <task> [--timeout <s>] <command>` | operate: the rest of the message is the command, as written |
| `/kanban gate list <task>` | talk |
| `/kanban gate remove <task> <gate>` | operate |
| `/kanban help` | talk |

Whoever acts is recorded as `lark:<union_id>`; a sender whose message carried no union_id can
read the board but not change it. Everything shown is escaped, so a task's text cannot mention
anyone, and masked, gate commands included.

**Notices.** The chat, or thread, a task was created in follows it, and the tasks its runs
create. It hears when a task is done, needs review, blocks (with the kind and the reason),
is retried after a failure, gives up, or is stranded with nobody able to take it. A run cut
short by a gateway restart is retried quietly. A task that keeps blocking for the same reason,
`kanban.block_recurrence_limit` times after an unblock, is flagged for rewriting instead. Each
chat or thread gets at most one message every couple of seconds, listing what happened in
order, 20 notices at most. Notices are delivered from a cursor kept in the database, so those
due while the gateway was down are sent when it is back; a message sent just before a stop
may be sent twice. A chat the bot can no longer post to — removed from it, or failing for
several minutes running — is let go of until the next restart: its notices are dropped, and
the gateway's log says which.

**Not yet:** people as assignees or reviewers. Naming one, with an @-mention, is refused, and
`/kanban done`, `block`, `review`, `approve` and `changes` say they arrive in a later update
(plan D2), with cards to a person's direct messages.
````


- [ ] **Step 11.2: Check.** Run `git grep -n -i "p[g]w" -- . ':!package-lock.json'`. Expected: no output. Run `npm test 2>&1 | tail -4`. Expected: `Tests  1218 passed (1218)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  72 passed (72)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 11.3: Commit.**

```bash
git add README.md
git commit -m "Document the board from Lark: the /kanban commands and their tiers, which comments reach an agent, and how notices are batched and survive a restart"
```

---

## Done when

- `npm test` gives `Tests  1229 passed (1229)`, after the review follow-ups. `npm run test:e2e` gives `Tests  72 passed (72)`. `npm run typecheck` reports no errors. All of these run under Node 22, in the worktree.
- Only `src/db/kanban.ts` writes a `kanban_` table, and only `src/kanban/service.ts` imports it (the guard in `tests/kanban-service.test.ts`). `src/kanban/chat.ts`, `src/kanban/chat-render.ts`, `src/kanban/chat-parse.ts` and `src/kanban/notices.ts` write nothing.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing, and no reply, notice or help text says "D2".
- `/kanban new` typed in a thread creates a task through the service, recorded as `lark:<union_id>` and subscribed to by that thread; the dispatcher runs it at once on a fake agent process that reports through the real socket; and the thread hears, once, that it is done — and nothing more after a restart (`tests/kanban-chat.e2e.ts`).
- Every `/kanban` command of spec §9.1 a role's task needs works at its tier; a talk-tier sender changes nothing, and its comment is shown to people and reaches no agent; a person, a supervised role, an unknown role or workspace, or an oversized task is refused at creation; the person-only commands answer that they arrive in a later update (`tests/kanban-chat.test.ts`, `tests/kanban-comment-steering.test.ts`).
- `/kanban` is answered while the chat's session is busy, and says the board is off when `kanban.enabled` is unset, opening no session (`tests/router.test.ts`).
- Every reply and notice is escaped and masked before it is reshaped, gate commands included; no cut shows part of a secret; a body cannot open a code fence; the latest output is shown from its end (`tests/kanban-chat-render.test.ts`).
- A conversation hears at most one message a round, its notices in order; a failed send is retried after its pause; a conversation that cannot be reached is let go of with one log line; a restart catches up from the cursors with the same batch uuid (`tests/kanban-notices.test.ts`).
- With `kanban.enabled` unset, the gateway builds no service, dispatcher, socket, chat commands or notifier.

## Review follow-ups

The review of the finished plan found the following, fixed after Task 11, each behaviour test first. The task steps above show the code as first written, decision 25's "held back" for a task not on the board among it; the code and tests in the tree are the corrected ones.

- **A lone CR in task text** (I1). `quoted()` split on `\n` only and `stripControl` keeps `\r`, so a body from `mt kanban create`, a summary, an output or a comment holding a lone CR left lines unquoted and a fence after one unescaped. `masked()` in `src/kanban/chat-render.ts` now turns a CRLF or a lone CR into a newline, after masking. Test: a body of `intro\r` then a fence, a heading and a list item renders with every line quoted and the fence escaped (`tests/kanban-chat-render.test.ts`).
- **A malformed gate timeout** (P1). `gate add` reads `--timeout=N` as well as `--timeout N`, and refuses with its usage line a command that still starts with `--timeout`, in any case, once the optional timeout is taken: `--timeout` with no value, `--timeout=`, `--timeout=x`, `--TIMEOUT 30`, a timeout on the next line, and a second timeout (`tests/kanban-chat-parse.test.ts`).
- **A timeout read as the task id** (P2). A task id starting `--` is refused with the usage line.
- **Zero-width characters** (P3). U+200B to U+200D, U+2060 and U+FEFF at the start of the argument and of each line, after any indent, are taken out before the verb and the field labels are matched, and the field-line pattern passes over them next to the colon (`assignee\u200b: x`).
- **Field lines** (P4). A `parent:` line of only commas is refused, "`parent:` needs a value."; `stop when:` matches with any run of spaces or tabs between its words, and is still one field, given once.
- **A thrown error's reply** (R1). `src/core/router.ts` answers a board that throws with `label(detail, 600)`, one line, masked and cut, as a refusal is, and logs the detail masked. `label` comes from `src/kanban/chat-render.ts`, which imports nothing of the router's, so no import cycle (checked with `madge --circular`: the same four `cli/` cycles as before). Test: a three-line error of 2,000 characters holding a known secret (`tests/router.test.ts`).
- **Cuts on character boundaries** (R2). `truncate` is `src/channel/escape.ts`'s, shared with the router, the Lark adapter and card rendering, so it was left as it is; `chat-render.ts` cuts with its own `head` and `end`, which drop a high surrogate left at the end of a cut, or a low one at the start of a tail. Test: an emoji straddling each cut of a title, a body and an output's tail leaves no lone surrogate in `/kanban show` or `/kanban list`.
- **The workspace echoed** (R3). `/kanban workspace` and `/kanban new` show the workspace through `label`. A workspace is a configured name, so this is a cap against a long one, with no test of its own.
- **A render failure after a change** (R4). A comment in `KanbanChat.run` says a reply that fails to render after its change was made is answered by the router as not done, though the change stands.
- **Let go of what can never be delivered** (N1). A conversation on a channel this gateway has not got goes the way of an unreachable one: marked dead until a restart, its held notices dropped and its cursors moved past them, with one log line. A subscription whose task is not on the board is let go of by itself: its cursor moved past its events, one line, `subscription N follows task X, which is not on the board; passing over its events until the gateway restarts`, and its later events passed over silently; its neighbours are unaffected (`tests/kanban-notices.test.ts`, both).
- **A cursor that fails to move after a send** (N2). `#advanceAll` catches each subscription's advance, so a throw no longer reaches the conversation's catch, which logged "were not sent" and left the other cursors unmoved. A failure, thrown or refused, after a send is logged `notices for subscription N of task X sent; cursor not moved (…)`, and that subscription is held back and its notices sent again after its pause; the others' cursors move. Test: an advance that throws once.
- **Stale pauses** (N2). A subscription's `sub:<id>` pause is deleted once its cursor moves, and once it is read, unless the pause was for a cursor that did not move: clearing that on the read, which comes before every advance, would keep its pause from doubling. Test: after the failed advance's notices are sent again and the cursor moves, the next failure waits 2 s, not 4.
- **Docs.** The README's "Notices" paragraph says "for about twenty minutes"; spec §9.1 (the gate timeout, zero-width characters, `stop when`, an empty `parent:`), §9.3 (the CR, cuts on character boundaries) and §9.4 (a missing channel or task let go of, a cursor not moved after a send, when a pause is cleared) say what the code does.

Counts after the first review follow-ups: `Tests  1225 passed (1225)` unit, `Tests  72 passed (72)` end to end.

The final review found the following, fixed the same way.

- **A gateway outage dropped notices** (F1). Every failed send counted toward `DEAD_AFTER`, so a network outage of about 19 minutes let every chat with notices due go, dropping them. `#sendFailed` in `src/kanban/notices.ts` now counts only a `ChannelError` with a nonzero code, a refusal by Lark; a network failure (code 0), a send past `NOTICE_SEND_MS` or any other error holds the conversation at the five-minute pause for as long as it lasts, leaving the count of refusals as it was, and never lets it go, so after the outage it catches up from its cursors. Tests: 20 code-0 failures in a row, then a success, delivers the held notice and one written during the outage, once; the same with 20 sends that never answer (`tests/kanban-notices.test.ts`). Spec §9.4, the README's Notices paragraph, Decision 25 and the known limitations say so.
- **"D2" in the spec's refusal** (F2). Spec §9.1 says a person named as assignee or reviewer is refused "saying it arrives in a later update".
- **The let-go duration** (F3). The plan said about 25 minutes and the README about twenty. The arithmetic is pauses of 2 s doubling to 256 s, then two of five minutes, 1,110 s, the eleventh refused send in a row letting the chat go: about 19 minutes, now said in the code's comment on `DEAD_AFTER`, the README, spec §9.4, Decision 25 and the known limitations.
- **The scan's query** (F4). The known limitation described an `EXISTS`; the query is a correlated `min(e.id)` subquery. Migration 004, which only this plan adds, now also creates `idx_kanban_subscriptions_account` on `kanban_subscriptions(account_id)`, so the round finds a bot's subscriptions by index (`SEARCH s USING INDEX idx_kanban_subscriptions_account`) rather than a scan of the table. Test: the query plan of the read by account (`tests/kanban-schema.test.ts`). Spec §3.4 and §9.4 say so.
- **The shutdown's wait for a notice** (F5). `src/index.ts` waited for the notifier with its default bound, a send's 30 s; it now passes `SHUTDOWN_DRAIN_MS`, 5 s, so a hung send never holds the stop. Test: the startup test records the bound `idle` is given (`tests/gateway-startup.test.ts`).
- **The `stopped` notice** (F6). A stop is a person's choice, so its notice never carries the "keeps blocking for the same reason… rewrite the task" suggestion, whatever the task's recurrences; it always ends with the unblock line. Test: a `stopped` event with five recurrences (`tests/kanban-chat-render.test.ts`). The notice is still sent to the conversation the stop came from: the `stopped` event records only `blockRecurrences` and the actor, not where the stop was typed, so the notifier cannot tell that conversation from the others; recording it is left to a later plan.
- **An unknown verb echoed whole** (F7). `parseKanban`'s refusal of an unknown verb echoed it uncapped. It is now masked, cut to 80 UTF-16 units with a marker on a character boundary, and escaped, by a small `echoed` in `src/kanban/chat-parse.ts` that does what `label` does: `chat-render.ts` imports `chat-parse.ts`, so `label` cannot be imported back. Test: an emoji straddling the cut is dropped whole, and a secret straddling it is masked whole (`tests/kanban-chat-parse.test.ts`).

Counts after the final review follow-ups: `Tests  1229 passed (1229)` unit, `Tests  72 passed (72)` end to end.
