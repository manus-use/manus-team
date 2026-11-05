# Plan D2 — People on the board: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People are assignees and reviewers on the board, beside roles. An operator names a person with an @-mention — `assignee: @Alice`, `reviewer: @Bob`, `/kanban assign k_… @Alice` — and the board records them by the union_id Lark sent with the mention, refusing anyone without talk tier, since being assigned is permission to report. When a person's task is ready, the dispatcher opens their run, which parks and never times out, and they are sent the task as a card in a direct message, by union_id: its title, body, contract and the parents' summaries, a box, and Done and Block. A review for a person comes the same way, with the handoff, the commit to review when one was recorded, and Approve and Request changes. A button press acts as the callback's operator, never as anything in the payload, on the run the card was sent for, re-checked inside the board's transaction, so a card for a run that is over does nothing and is redrawn as out of date; a card acted on is redrawn without its buttons. The chat a task came from hears one line, "📋 *title* — assigned to *name*", the name in plain text, and a block's notice carries an Unblock button. In chat, the named assignee reports with `/kanban done`, `block` and `review`, the named reviewer answers with `approve` and `changes` — an operator may answer any review — and their comments steer the task's agent as an operator's do. A person's report that would run gates beside another task's agent in the same workspace is refused, `workspace_busy`. A role whose agent is supervised may be given tasks: its approval cards go to the chat that follows the task. Every message the gateway sends as one message carries its uuid to Lark, so a notice or a card sent again after a restart is one message. A task is any work, and nothing here assumes git: a card shows a reported commit only when one was recorded. `kanban.enabled` stays opt-in.

**Architecture:**
- **Mentions** (`src/types.ts`, `src/channel/lark/inbound.ts`): `InboundMessage.mentions`, each mentioned person's key, name, open_id and union_id, read from the raw event the normalizer trims, without `@all` or the bot; `InboundCardAction.input`, the text of a card's box, from the callback's `form_value`.
- **People** (`schema/005_people.sql`, `src/db/people.ts`, `src/kanban/people.ts`): a `people` table of the open_id and name Lark last gave with each union_id, written only by `db/people.ts`; `PeopleDirectory` notes each person Lark identifies and is the service's `People`, checking a principal's talk tier through the open_id last seen with it.
- **The channel** (`src/channel/types.ts`, `src/channel/lark/adapter.ts`): `personTarget(unionId)`, sent by `receive_id_type: union_id`; `CardView` and `CardButton`, `sendCard` and `updateCard`, and buttons under a text; every one-message send — a text of up to `ONE_MESSAGE`, 4,000 characters, an approval card, a board card — through the SDK's client with its uuid.
- **The board** (`src/db/kanban.ts`, `src/db/kanban-read.ts`, `src/kanban/service.ts`, `src/kanban/types.ts`): a person's `Reporter` may carry the card's `runId`, re-checked in the transaction (`run_superseded`); `workspace_busy` for a person's report with gates beside another task's open agent run; `claimed` records `assigneeKind`; `recordCard` writes `card_sent` or `card_failed` once per run, and `cardsDue` lists the people's runs still waiting; `unblock` takes the `blockedAt` event an Unblock was for (`stale` once lifted).
- **Approvals** (`src/kanban/sink.ts`): the sink forwards a run's approval card to its task's first subscription, naming the task, and redraws it there.
- **Chat** (`src/kanban/chat-parse.ts`, `src/kanban/chat-render.ts`, `src/kanban/chat.ts`, `src/core/ids.ts`): the people's verbs parsed; the help, the one-line claim notice, a refused card's notice, a gate's refusal, the task, review and outcome cards and the Unblock button rendered, escaped and masked; `KanbanChat` resolves @-mentions, checks who is named, reports through the service and acts on card presses (`card()`); a card's uuid and its buttons' nonce, bound to the task and the run, not the boot.
- **The router** (`src/core/router.ts`): `onCardAction` dispatches on the card's `kind` first — `kanban` to the board, `approval` or none to the approval path, at operator tier as before.
- **Cards** (`src/kanban/cards.ts`): `CardPoster` sends each due run its card every 2 s, from the board, by union_id with the run's one uuid, records it, reports a refusal to the task's subscribers, and waits out an outage.
- **Notices** (`src/kanban/notices.ts`): people by name; an Unblock under a message for each task its notices left blocked.
- **Wiring** (`src/index.ts`): behind `kanban.enabled`, the service gets people and supervised roles, the sink forwards through Lark, and `CardPoster` starts and stops with the notifier.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, better-sqlite3, `@larksuiteoapi/node-sdk` 1.73.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §4.2, §5.1, §5.3, §7.1, §7.5, §7.7, §7.8, §9.1–§9.4, §10, §11 and the D2 row of §12, as amended in the same commit as this plan.

---

## Ground rules

- **Where to work.**
  - Use the worktree `/Users/x/Develop/manus/prime-gateway-work`, on branch `kanban-people`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`: the live gateway runs there.
  - Never start the gateway, and never write to `~/.manus-team`.
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink to the main checkout's; create it with `ln -s /Users/x/Develop/manus/prime-gateway/node_modules node_modules` if it is missing.
  - Write plain-English commit messages: no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
  - The letters `p`,`g`,`w` in that order, in any case, must not appear in anything you write.
- **Secrets.** Never print secret values. Tests use made-up values only.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline.** `npm test` gives `Tests  1229 passed (1229)`. `npm run test:e2e` gives `Tests  72 passed (72)`. `npm run typecheck` reports no errors.
- **Finding edits.** Find each edit by its quoted text, not by line number. Every quoted text appears exactly once in its file at the point the step applies it. Apply a step's edits in the order given. A step that replaces a whole file gives all of it.
- **The secret registry is process-wide.** Every test file that adds secrets calls `clearSecrets()` in `beforeEach` and `afterEach`, or, in `tests/router.test.ts`, in the `afterEach` of its own `describe`.
- **Tests use real SQLite** through `testDb()`, the real `KanbanService`, the real board and a `ManualClock`; the router's tests use its existing harness, and the notices and cards a `FakeChannel`. No mocks, except the gateway's start-up test, which stubs the Lark connection as its neighbours do.
- **No real agent, no network, no real home.** No test runs bytesec or reaches Lark. The end-to-end tests run the fake CLI agent through the real CLI driver, with its home, socket and workspace under a fresh `mkdtemp` directory, realpath'd. What Lark itself does with a card's JSON is not tested: the JSON is built by pure functions, and tested as D1 tested the answered approval card.
- **Unit tests start no process.** Only `tests/kanban-people.e2e.ts` and D1's `tests/kanban-chat.e2e.ts` do, in the e2e project.
- **The import guard.** `tests/kanban-service.test.ts` checks that only `src/kanban/service.ts` imports `src/db/kanban.js`. `KanbanChat` calls the service only; `CardPoster` and the sink read through `db/kanban-read.js`, and `CardPoster` records through the service.
- **One migration.** `schema/005_people.sql` adds the `people` table, and nothing else; `db/people.ts` is its only writer. No kanban table changes: the new events are rows of `kanban_events`, written by `db/kanban.ts`, and the new payload keys are JSON.
- **Nothing assumes git or code.** A task is any work and a workspace any directory. The review card shows what to review only when the report recorded a commit (spec §7.8), and the end-to-end review runs in a workspace that is no repository.
- **Words a person sees** never say "D2" or "plan".

## Decisions the spec left open

Each is the reading most consistent with the rest of the spec. *The user's decision* marks those the user made before this plan; **[you decide]** marks those the user should decide rather than accept; the rest are proposed, with the reason. All of them are in the spec now (§4.2, §7.1, §7.7, §9.1–§9.4, §12), amended in the same commit as this plan.

1. **D is D1, then D2.** *The user's decision.* D1 made the board usable from Lark for roles; D2 adds people, approval forwarding, and the rest of spec §12's D2 row.
2. **The board stays opt-in.** *The user's decision.* `kanban.enabled` is off by default; with it unset, the gateway builds no service, dispatcher, socket, chat commands, notifier or card poster.
3. **A task is any work.** *The user's decision.* Nothing here reads a repository; the review card shows the reported commit only when one was recorded, and says nothing of one otherwise.
4. **Chat never says "D2" or "plan".** *The user's decision.* D1's "arrives in a later update" answers are gone: the commands they stood in for are here.
5. **A talk-tier comment is stored, not forwarded; the named assignee's and reviewer's steer.** *The user's decision.* A comment steers when its author is an operator, or is the task's assignee or reviewer, a person, at the time of the comment (spec §7.5).
6. **Notices stay batched per chat.** *The user's decision.* The one line for a person's claim, and a refused card's notice, are notices like the others, in the same batches.
7. **An operator may answer any review.** *The user's decision.* `/kanban approve` and `changes`, and a review card's buttons, are for the task's reviewer, a person, at talk tier, or an operator — for a role's review too. While a role's review run is open the board refuses a person's answer, as for any person's report while an agent works (spec §5.1).
8. **How a person named by union_id is checked for talk tier: a `people` table.** *The user's decision* ("remember people seen"). The tiers are by open_id; the board knows people by union_id. Migration 005 adds `people`, the open_id and name Lark last gave with each union_id, noted for each `/kanban` sender, each person a `/kanban` command mentions, and each person who presses a board card's button. A principal checked for talk tier — `assignee: lark:on_…` typed out, or an agent's `mt kanban create` or `review` — is checked through the open_id last seen with it, and a principal never seen is refused. *Why:* it survives restarts, needs no new Lark scope and no network at assignment, and changes no allowlist. The alternatives: a map in memory, which forgets everyone at a restart, so an agent's follow-up naming its task's reviewer would be refused after one; asking Lark's contact API for the open_id at assignment, which needs a contact scope and a network call inside the service's synchronous check; or letting allowlists hold union_ids, which changes the auth configuration every deployment has.
9. **An @-mention is found by the name Lark's text shows.** Lark's text gives a mention as `@Name`; the field's value is matched against the message's mentions by that name, or by the mention's key. A name no mention has is refused ("type @ and pick them"), as is one two mentions share, and one whose mention came without a union_id. A principal typed out, `lark:<union_id>`, is accepted once the gateway has seen that person. *Why:* the ids come from Lark, never from the text, so there is no name to resolve or confuse (spec §9.1).
10. **A card's box, not a pop-up.** Spec §9.2 says a button "opens Lark's input form". A Lark card has no form that a button opens; a card takes text through a form with an input in it, submitted by a button. So a task card has one box — "A summary, or why it is blocked" — above Done and Block, and a review card one — "What needs changing" — above Approve and Request changes. Block and Request changes with an empty box are refused, and say to type a reason; Done and Approve may be empty, as a person approving may say nothing. A box holds at most 1,000 characters; the typed commands take more.
11. **A person's card is delivered from the board.** `CardPoster` reads the open people's runs with no card recorded every 2 s, sends each its card by union_id with one uuid per run, and records `card_sent` with the message. So a card a restart cut off is sent then, one message within Lark's hour, and a recorded one never again. Only Lark refusing because it cannot reach the person — `PERSON_UNREACHABLE_CODES`, which holds 230013, "the bot has no availability to this user" — records `card_failed`, and so does a person who has lost talk tier since being named: the task's subscribers hear it, with the commands the person can type instead, and the card is not tried again. Every other refusal — a scope or a token Lark refuses (its 9999…-codes), a plain 400 — and every failure that never reached Lark are taken for the gateway's problem: tried again after a pause doubling from 2 s to five minutes, with a log line, for as long as it lasts, as D1's notices are. A card sent whose record then fails is not sent again until a restart, said once: resending it every five minutes would outlive the uuid's hour. *Why:* a scope missing is the operator's to fix, and recording it as the person's unreachability would end their card for good; a person outside the app's reach does not come back by itself, and the task can be re-claimed by `/kanban stop` and `unblock` once they do. 230013 is from Lark's documentation of sending a message; nothing in this repository or its SDK confirms it.
12. **The group's one line is the notice of a person's claim.** A `claimed` event records its assignee's kind now, and a person's is a notice: "📋 **title** `k_…` — assigned to Alice", or "review assigned to", named by the name Lark last gave, else the principal, in plain text, never a mention (spec §9.3). *The user's decision:* it goes to every subscription of the task, as any notice does: a subscription does not record whether its chat is a group, so a task created in a direct message hears the line too. *Why:* it says who has the task wherever the task is followed, and needs no new column.
13. **A card's nonce is bound to the task and the run, not the boot.** An approval's nonce binds the boot; a person's run parks across restarts (spec §4.2), and its card must still work after one. The nonce is an unkeyed hash of ids anyone who sees the card can read: it catches a pointer mixed or mangled, and is no secret. What protects a press is who made it — the callback's operator, checked against the tiers and the task — and the board's re-check inside its transaction that the card's run is the task's open run (`Reporter.runId`); a card for a run that is over is refused `run_superseded`, said to be out of date, and redrawn so. An Unblock's nonce is bound to the event that blocked the task, which must be a block of that task. *Not done:* an HMAC with a per-gateway secret, which would need a secret kept and shared by every renderer for no change in what a press may do.
14. **Who may press what, and a refused press.** Done and Block: the run's assignee, at talk tier. Approve and Request changes: the review run's reviewer at talk tier, or an operator. Unblock: an operator. Identity is the callback's operator; the payload is a pointer (spec §9.2, §10). The SDK drops a press it has seen — keyed `card:<message>:<presser>:<tag>|<name>|<option>|<the value's first 128 characters>`, for twelve hours, `form_value` left out (`lib/index.js` of node-sdk 1.73, `cardActionId` and `DEFAULT_DEDUP`) — so a press refused for what it carried — an empty box, a gate, a busy workspace, a report in progress — redraws the card live from the board, saying why under the title, with buttons named `button_<place>_<attempt>` — whole in the key, whatever order Lark gives the value's keys — and whose value starts with `try`, the attempt, outside the nonce; a `try` that cannot be read starts over at 1. A refused report whose run ended meanwhile redraws the card as out of date instead. A press by the wrong person, or with a payload that does not match, changes nothing and redraws nothing.
15. **A typed report leaves the card live.** `/kanban done` typed by the assignee decides the run; the card's buttons are left, and a later press is refused as out of date and redraws the card then. *Why:* chat does not need to find the card's message — `card_sent` records it, for a later plan to redraw from — and a stale press does nothing either way.
16. **Unblock under a notice, not redrawn.** A message whose notices left tasks blocked carries an Unblock for each task's latest block, at most five, in the order told. The message is not redrawn once one is pressed: it carries the round's other notices, which a redraw would lose. A second press finds the block lifted and does nothing, which is noted in the log — the re-check spec §9.2 asks for, without the redraw. As the message is not redrawn, the SDK drops the same operator's second press of one Unblock for twelve hours (Decision 14); another operator's, and `/kanban unblock`, still work.
17. **The people's commands.** `/kanban done <task> [summary]` and `approve <task> [comment]`: the text may be empty. `block <task> <reason>` and `changes <task> <reason>`: a reason is required. *The user's decision:* `review <task> [summary]` names its reviewer on a line `reviewer: <role or @person>`, anywhere in it, as on `/kanban new`, rather than the spec's positional `[reviewer]`: a name at the end of free text could be the summary's last word. Without the line, the task's reviewer is used, and a task with none is refused, saying to add the line.
18. **A person reports in the phase their report is for.** `done`, `block` and `review` are the assignee's while the task is `open`; `approve` and `changes` are for a task in `review`. *Why:* the board's `complete` takes a task in either phase, so without the check an assignee could complete their own task while a person reviewed it, deciding the reviewer's run.
19. **`workspace_busy` only when there are gates to run.** *The user's decision.* Spec §7.7 says D2 must refuse a person's report while another task's agent run is open in the workspace. A person's report changes nothing in a checkout except by running gates, so it is refused only when the task has gates and its workspace is fixed, while any agent run of another task, decided or not, is open there. It is asked in `reportCheck`, before the gates; once a report's gates start, no agent is claimed into the workspace until they end.
20. **A person's block is `needs_input`** (spec §5.4), from chat and from the card alike.
21. **The uuid is passed to Lark.** Every message sent as one message goes through the SDK's own client, `im.v1.message.create` or `reply`, with its uuid: a text of up to 4,000 characters — every router reply, which the router cuts at 4,000, and every batch of notices, at most 3,800 — as a post of one markdown element, as the SDK's own markdown send makes one; an approval card; a board card. A post Lark refuses as invalid content goes as plain text, and a reply to a message that is gone — 230011, 230017 or an HTTP 404 — goes to its chat, as the SDK's own send does (Decision 34). A longer text is still split by the SDK, and a streamed answer is still the SDK's to send: neither carries the uuid. Lark sends one message per uuid within an hour.
22. **Approvals go to the task's first subscription.** The sink posts a run's approval card to its task's first subscription, on that subscription's channel, as "Task `k_…`, *title*, asks: …", and redraws it there once answered. It is answered as any approval card is: at operator tier, through the approval's session (spec §7.1). A task nobody follows has nobody to ask: the send fails and the agent is released as cancelled, as before.
23. **Supervised roles are accepted.** The service is given `supervisedRoles: true`, and D1's refusal of such a role in chat is gone.
24. **A person without talk tier is refused by the name typed.** Chat checks a named person before the service does, and says "@Carol cannot be given work: being assigned lets a person report on the task, which needs talk tier, and the gateway does not know them to have it." The service's own refusal, which an agent's `mt kanban create` gets, says the same, and how a person becomes known.
25. **What a card shows.** A task card: the title, any changes a reviewer asked for, the body (1,500 characters), the contract, and up to five parents' summaries (600 each). A review card: the handoff (1,500), "To review: review commit `abc…`" only when the report recorded a commit (spec §7.8), the body (1,200) and the contract. Each piece masked, cut and escaped as chat's replies are (spec §9.3), and the whole markdown masked once more before it is sent. Each ends with the typed commands that do the same.
26. **A person's run parks.** Nothing new is needed: the dispatcher already never times out, nudges or ends a person's run, at a sweep or a restart. A test now shows a person's run claimed beside an agent's in the same workspace, outside `max_running`, and still open past the runtime limit.
27. **Named by the task as it stands.** Whether a comment steers, and who may report or answer, are read from the task when the command arrives; a card's buttons, from the run the card was sent for.
28. **A press is answered at once, and shown only on its card.** Lark waits about three seconds for a callback's answer, and the SDK's websocket client answers only once the handler returns (node-sdk `lib/index.js`, the `ws` message handler awaiting `eventDispatcher.invoke`, which awaits the card handler through the SDK's per-chat queue). So `KanbanChat.card` checks the nonce, the presser and the box, redraws the card as "Working on it…", answers, and makes the report in the background — tracked, waited for by `idle()` at shutdown under the drain's bound, its gates aborted by `stop()` first, so nothing is applied, its errors masked and logged — then redraws the card with the outcome. Every redraw is bounded by `REDRAW_MS`, 10 s, and logged when it is late, as the SDK's card update has no timeout of its own; the redraws a press makes before its answer — an empty box, an out-of-date card — go in the background too, so none holds Lark's three seconds, and an ended run is told out of date before a press already being worked on is considered. *The user's decision:* a board card's press posts nothing in the chat; the card alone shows it. The router notes the board's answer, masked, for a press the card cannot show — someone else's, a mangled payload, an Unblock's — and an approval's press is acknowledged in the chat as before, its message sent after the handler returns, unawaited, and tracked for the shutdown's drain. A second press of a card while one is worked on is refused without a redraw, so neither redraws over the other.
29. **A typed report is bound to what it was checked against.** `/kanban done`, `block`, `review`, `approve` and `changes` pass the task's open run, as read when the report is checked, as `Reporter.runId` — `null` when none was open, meaning "expects none open" — and what the person reports as, `Reporter.as`: `assignee` for `done`, `block` and `review`; `reviewer` for `approve` and `changes` by the task's reviewer, else `operator`. A card's press passes its run and the same `as`. Inside the transaction, after the gates, the board refuses with `run_superseded` a report whose run is no longer the open one (a run opened since a `null` binding among them), an assignee's on a task now someone else's or no longer open, a reviewer's on a review now someone else's, and a reviewer's or operator's on a task no longer in review. So a reassignment while the report's gates run never lets it decide another run, or complete a task now someone else's — with no run claimed too. A person `Reporter` with neither field, as the board's own tests make, is checked as before.
30. **Every uuid is one message's.** With the uuid reaching Lark, which sends one message per uuid for an hour across receivers, a uuid shared by two messages loses one: a boot finding's message is keyed on the binding and the boot (`findingUuid`), a click's acknowledgement on the callback's token and the box's text, and an approval card on its approval rather than the millisecond. Every other uuid was already one message's: a control reply's is the message and its purpose, a notice batch's its (subscription, event) pairs, a card's its run.
31. **The approval card in schema 2.0.** Its buttons go in the body with callback behaviors, as a board card's do, instead of a 1.0 `action` container with a `value` on each button. The router reads `action.value` either way, which the SDK takes from the callback, for a card posted before this as for one after.
32. **A send that never reached Lark is retried.** Through the SDK's client, a network failure is an error with no response; it is made retryable, as the SDK's own send retried it, and the uuid makes a retry that did land one message.
33. **A notice's buttons never hold its text back.** A text with buttons is a card; a card Lark refuses for a reason that is not the chat's — a nonzero code, not retryable, not 230002, "the bot is not in the chat" — is sent again as plain text, without its buttons, with the same uuid, which a failed send has not used.
34. **230020 is a rate limit, not a gone message.** A reply refused with 230011 (Lark's documented code for a withdrawn message), 230017 or an HTTP 404 — the SDK's own codes for a revoked target — goes to its chat with the same uuid, as the SDK's send does. The SDK counts 230020 among them too; Lark documents 230020 as the chat's rate limit, and `RETRYABLE_CODES` already retries it as one. Where the two readings meet, the retry wins, and 230020 is left out of the fallback (`WITHDRAWN_CODES` in `src/channel/lark/adapter.ts`). *Why:* the reading is ambiguous, and the retry is the safe side of it: a reply retried with its uuid is at worst late, while one moved to the chat on a rate limit loses its thread and hits the same limit again.

## Out of scope, and known limitations

- **Lark's card JSON is not checked against Lark.** The cards follow Lark's card schema 2.0 as documented — a form with an input, buttons with callback behaviors, a markdown element — and no test reaches Lark. The first live use is the check.
- **A typed report leaves its card's buttons live** until they are pressed, which then redraws the card as out of date (Decision 15).
- **A notice's Unblock button stays** after it is pressed; a second press finds the block lifted and does nothing, which is noted in the log (Decision 16).
- **A card Lark refuses is not sent again** (Decision 11). The person can type the commands the notice gives; once Lark can reach them, `/kanban stop` and `unblock` give the task a new run, and a new card.
- **The people table learns only from `/kanban`.** A principal an agent names who has never sent a `/kanban` command, been mentioned in one, or pressed a card is refused (Decision 8).
- **Texts over 4,000 characters, and streamed answers, still go without the uuid** (Decision 21), and Lark's uuid lasts an hour: a batch sent again after a longer outage can show twice, and so can a person's card whose send timed out but landed, if it is sent again after the hour.
- **A press whose redraw does not land in time shows nothing.** A redraw is waited for at most 10 s (`REDRAW_MS`): one that never answers is given up on and logged, and the card keeps what it last showed. At shutdown, a press's gates are killed and its card redrawn to say so; if the drain's bound runs out before that redraw lands, the card stays "Working on it…", with no buttons. The person can still type the commands.
- **A card can go dead.** If a card's "Not done" redraw fails, the card keeps the buttons it had, and the SDK drops the same person's second press of the same button for twelve hours (Decision 14): the card's buttons may stay dead for 12 h. The typed commands (`/kanban done` and the rest) still work.
- **A press the card cannot show is said nowhere but the log** (Decision 28): someone else's press, a mangled payload, and an Unblock's result. `/kanban show` tells where the task is.
- **The one line goes to every subscription**, a direct message included (Decision 12).
- **An approval forwarded to a chat counts toward its run's runtime limit.** A supervised agent waiting on an unanswered approval is cancelled at `max_runtime_s` like any run; after a restart, its card resolves to "no longer bound", as the run's session is archived (spec §8.4).
- **Texts no longer go through the SDK's markdown tidying** (headings demoted, blank lines compressed): the router's replies and the notices use neither.
- **A person may review their own work**: nothing refuses a reviewer who is the assignee.
- **A renamed person's name can be stale** in a notice or a card: it is the name Lark last gave with their ids, noted when they last used `/kanban`, were mentioned in it or pressed a card. The ids are what the board goes by.
- **The post fallback is narrower than the SDK's.** A post Lark refuses as invalid content (230001) goes as plain text; the SDK fell back on any refusal it classed as a format error, its own classing, which counts 230002 among them.
- **One operator's second press of one Unblock is dropped by the SDK** for twelve hours (Decision 16).
- **Codes not confirmed here:** 230013 (Decision 11) and 230001 (Decision 33) are from Lark's documentation; the SDK names 230001 a format error, and 230017 and 230020 a revoked target, of which only 230017 is taken so (Decision 34).

## File structure

| File | Responsibility |
|---|---|
| `src/types.ts` (modify) | `InboundMention`, `InboundMessage.mentions` |
| `src/channel/lark/inbound.ts` (modify) | `mentionsOf`, `cardInput`; `clickUuid`, and the acknowledgement sent without holding the callback |
| `schema/005_people.sql` (create) | the `people` table |
| `src/db/people.ts` (create) | `notePerson`, `personOf` |
| `src/db/WRITERS.md` (modify) | `people`'s writer |
| `src/kanban/people.ts` (create) | `PeopleDirectory`, `personPrincipal`, `unionIdOf` |
| `src/channel/types.ts` (modify) | `SendTarget.receiveIdType`, `personTarget`, `CardButton`, `CardView`, `sendCard`, `updateCard`, buttons on `sendText` |
| `src/channel/lark/adapter.ts` (modify) | the uuid on every one-message send; `messageRequest`, `postContent`, `boardCard`, `approvalCard`, `sendError`, `ONE_MESSAGE`; `LarkAdapterDeps` for tests |
| `src/core/session-actor.ts` (modify) | an approval card's uuid, one per approval |
| `src/kanban/types.ts` (modify) | `Reporter`'s `runId` |
| `src/db/kanban.ts` (modify) | the card's run re-checked; `workspace_busy`; `claimed`'s `assigneeKind`; `recordCard`, `CardOutcome`; `unblock`'s `blockedAt` |
| `src/db/kanban-read.ts` (modify) | `cardsDue`, `cardReading` |
| `src/kanban/service.ts` (modify) | `recordCard`, `cardReading`; `unblock`'s `blockedAt`; the refusal of a person it cannot check |
| `src/kanban/sink.ts` (modify) | `ApprovalForwarding`: approvals to the task's first subscription |
| `src/kanban/chat-parse.ts` (modify) | `ReportCommand`, `ReviewCommand`, their `USAGE` |
| `src/core/ids.ts` (modify) | `boardCardUuid`, `boardCardNonce` |
| `src/kanban/chat-render.ts` (modify) | the help; the claim's line and a refused card's notice; `blocksTask`, `unblockButton`; `renderTaskCard`, `renderReviewCard`, `renderCardOutcome`, `renderGateFailure` |
| `src/kanban/chat.ts` (modify) | people by @-mention; the people's reports, on the open run; steering by the named; `card()`, answered at once, and `idle()` |
| `src/core/router.ts` (modify) | `InboundCardAction.input`; `KanbanCommands.card`; `onCardAction` by `kind` |
| `src/kanban/cards.ts` (create) | `CardPoster`, `CARD_POLL_MS`, `CARD_BACKOFF_MAX_MS`, `CARD_SEND_MS`, `PERSON_UNREACHABLE_CODES` |
| `src/kanban/notices.ts` (modify) | `nameOf`; Unblock buttons, `UNBLOCK_BUTTONS` |
| `src/index.ts` (modify) | the people directory, supervised roles, forwarding and `CardPoster` behind `kanban.enabled`; `findingUuid`; the shutdown's waits together |
| `README.md` (modify) | people on the board |
| `tests/lark-inbound.test.ts`, `tests/lark-adapter.test.ts`, `tests/people.test.ts`, `tests/kanban-people-reports.test.ts`, `tests/kanban-cards.test.ts`, `tests/kanban-people.e2e.ts` (create) | |
| `tests/helpers/channel.ts`, `tests/helpers/dispatch.ts`, `tests/fakes/cli-agent.mjs` (modify) | board cards in the fake channel; people in the dispatch harness; the agent's `kanban-review` mode |
| `tests/lark-cards.test.ts`, `tests/kanban-schema.test.ts`, `tests/kanban-sink.test.ts`, `tests/kanban-chat-parse.test.ts`, `tests/kanban-chat-render.test.ts`, `tests/ids.test.ts`, `tests/kanban-chat.test.ts`, `tests/kanban-chat.e2e.ts`, `tests/router.test.ts`, `tests/kanban-notices.test.ts`, `tests/gateway-startup.test.ts`, `tests/kanban-service.test.ts` (modify) | |

Running counts, unit then end to end: Task 1 1233 / 72, Task 2 1236, Task 3 1250, Task 4 1257, Task 5 1260, Task 6 1261, Task 7 1268, Task 8 1288, Task 9 1295, Task 10 1305, Task 11 1307, Task 12 1309, Task 13 1309 / 74, Task 14 1309 / 74.


---

### Task 1: The mentions on a message, and the text of a card's box

**Files:**
- Create: `tests/lark-inbound.test.ts`
- Modify: `src/channel/lark/inbound.ts`, `src/core/router.ts`, `src/types.ts`

Lark sends a message's mentions with each person's open_id and union_id, and the SDK's normalizer keeps only the open_id: D1 found that `InboundMessage` drops them, so chat could tell that someone was mentioned, never who (spec §9.1). The raw event is kept already (`includeRawEvent`), for the sender's union_id; the mentions are read from it the same way, leaving out `@all` and the bot's own mention, which is how a group addresses it. A card's box, which Task 7's cards carry, comes back with the button that submitted it as `form_value`, which the normalizer drops too (Decision 10). Both are pure functions of the raw event, so they are tested without a connection.

- [ ] **Step 1.1: Write the failing tests.**

Create `tests/lark-inbound.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cardInput, mentionsOf } from '../src/channel/lark/inbound.js';

/**
 * What the Lark side reads from a raw event that the SDK's normalizer drops: the
 * union_ids of the people a message mentions, which is how the board knows a
 * person (spec §9.1), and the text a card's box held when its button was pressed.
 */

const BOT = 'ou_bot';

function raw(mentions: unknown): unknown {
  return { sender: { sender_id: { union_id: 'on_sender' } }, message: { message_id: 'om_1', mentions } };
}

describe('mentionsOf', () => {
  it("gives each person's key, name and ids, leaving out the bot and @all", () => {
    expect(
      mentionsOf(
        raw([
          { key: '@_user_1', name: 'Bot', id: { open_id: BOT, union_id: 'on_bot' } },
          { key: '@_user_2', name: 'Alice Smith', id: { open_id: 'ou_alice', union_id: 'on_alice' } },
          { key: '@_all', name: 'Everyone', id: {} },
          { key: '@_user_3', id: { open_id: 'ou_bob' } },
        ]),
        BOT,
      ),
    ).toEqual([
      { key: '@_user_2', name: 'Alice Smith', openId: 'ou_alice', unionId: 'on_alice' },
      { key: '@_user_3', name: null, openId: 'ou_bob', unionId: null },
    ]);
  });

  it('is empty for an event without mentions, or with anything else in their place', () => {
    expect(mentionsOf(raw(undefined), BOT)).toEqual([]);
    expect(mentionsOf(undefined, BOT)).toEqual([]);
    expect(mentionsOf(raw('@_user_1'), BOT)).toEqual([]);
    expect(mentionsOf(raw([null, 'x', { name: 'no key' }]), BOT)).toEqual([]);
  });
});

describe('cardInput', () => {
  it("is what the card's box named text held", () => {
    expect(cardInput({ action: { value: {}, form_value: { text: 'shipped it' } } })).toEqual({ input: 'shipped it' });
    expect(cardInput({ action: { form_value: { text: '' } } })).toEqual({ input: '' });
  });

  it('is nothing for a button that submitted no form', () => {
    expect(cardInput({ action: { value: {} } })).toEqual({});
    expect(cardInput({ action: { form_value: { other: 'x' } } })).toEqual({});
    expect(cardInput(undefined)).toEqual({});
  });
});
```


- [ ] **Step 1.2: Run them to verify they fail.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` and then `npx vitest run --project unit tests/lark-inbound.test.ts`. Expected: all four FAIL, with `TypeError: (0 , mentionsOf) is not a function`. `Tests  4 failed (4)`.

- [ ] **Step 1.3: Implement.**

In `src/channel/lark/inbound.ts`, replace:

```ts
import type { InboundAttachment, InboundMessage, Principal } from '../../types.js';
```

with:

```ts
import type { InboundAttachment, InboundMention, InboundMessage, Principal } from '../../types.js';
```

In `src/channel/lark/inbound.ts`, replace:

```ts
      mentionAll: msg.mentionAll,
      attachments: await this.#download(msg),
```

with:

```ts
      mentionAll: msg.mentionAll,
      // From the raw event: the normalizer keeps a mention's open_id and drops its
      // union_id, which is how the board knows a person (spec §9.1).
      mentions: mentionsOf(msg.raw, botOpenId),
      attachments: await this.#download(msg),
```

In `src/channel/lark/inbound.ts`, replace:

```ts
      value: isRecord(evt.action.value) ? evt.action.value : {},
    };
```

with:

```ts
      value: isRecord(evt.action.value) ? evt.action.value : {},
      ...cardInput(evt.raw),
    };
```

In `src/channel/lark/inbound.ts`, replace:

```ts
}

interface RawCardActionShape {
  operator?: { union_id?: string };
```

with:

```ts
}

/** The ids Lark sends with a message's mentions, in its raw event. */
interface RawMentionsShape {
  message?: { mentions?: unknown };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The people a message @-mentions, from its raw event: each mention's key, the
 * name the text shows, and the open_id and union_id Lark gave. `@all` is not a
 * person, and the bot's own mention is how a group addresses it, so both are
 * left out. Anything not shaped like a mention is skipped.
 */
export function mentionsOf(raw: unknown, botOpenId: string): InboundMention[] {
  const list = isRecord(raw) ? (raw as RawMentionsShape).message?.mentions : undefined;
  if (!Array.isArray(list)) return [];
  const out: InboundMention[] = [];
  for (const m of list) {
    if (!isRecord(m)) continue;
    const key = text(m['key']);
    if (key === null || key === '@_all') continue;
    const ids = isRecord(m['id']) ? m['id'] : {};
    const openId = text(ids['open_id']);
    if (openId !== null && openId === botOpenId) continue;
    out.push({ key, name: text(m['name']), openId, unionId: text(ids['union_id']) });
  }
  return out;
}

interface RawCardActionShape {
  operator?: { union_id?: string };
```

In `src/channel/lark/inbound.ts`, replace:

```ts
  operator?: { union_id?: string };
}
```

with:

```ts
  operator?: { union_id?: string };
}

/** What a card's input box held, sent with the button that submitted its form. */
interface RawFormShape {
  action?: { form_value?: unknown };
}

/**
 * The text typed in a card's box (spec §9.2: Done and Block take a summary or a
 * reason, Request changes a reason), from the raw callback's `form_value`, where
 * the box is named `text`. Absent when the button submitted no form.
 */
export function cardInput(raw: unknown): { input?: string } {
  const form = isRecord(raw) ? (raw as RawFormShape).action?.form_value : undefined;
  if (!isRecord(form)) return {};
  const value = form['text'];
  return typeof value === 'string' ? { input: value } : {};
}
```

In `src/core/router.ts`, replace:

```ts
  value: Record<string, unknown>;
}
```

with:

```ts
  value: Record<string, unknown>;
  /** What was typed in the card's box, when the button submitted it with its form. */
  input?: string;
}
```

In `src/types.ts`, replace:

```ts
}

export interface InboundMessage {
  messageId: string;
```

with:

```ts
}

/**
 * A person @-mentioned in a message, with the ids Lark gave for them. An
 * @-mention is how chat names a person (spec §9.1): the ids come from Lark, not
 * from the text, so there is no name to resolve or confuse.
 */
export interface InboundMention {
  /** The placeholder Lark's raw text has for the mention, such as `@_user_1`. */
  key: string;
  /** The name the message's text shows in its place, as `@Name`; null when Lark gave none. */
  name: string | null;
  openId: string | null;
  unionId: string | null;
}

export interface InboundMessage {
  messageId: string;
```

In `src/types.ts`, replace:

```ts
  mentionAll: boolean;
  attachments: InboundAttachment[];
```

with:

```ts
  mentionAll: boolean;
  /** The people @-mentioned, the bot and `@all` left out. Absent means none. */
  mentions?: readonly InboundMention[];
  attachments: InboundAttachment[];
```


- [ ] **Step 1.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/lark-inbound.test.ts`. Expected: `Tests  4 passed (4)`.

- [ ] **Step 1.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1233 passed (1233)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  72 passed (72)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 1.6: Commit.**

```bash
git add src/channel/lark/inbound.ts src/core/router.ts src/types.ts tests/lark-inbound.test.ts
git commit -m "Carry the people a message mentions, with the open_id and union_id Lark gives for each, on the inbound message, and the text a card's box held on a button's callback"
```

---

### Task 2: The people the gateway has seen

**Files:**
- Create: `schema/005_people.sql`, `src/db/people.ts`, `src/kanban/people.ts`, `tests/people.test.ts`
- Modify: `src/db/WRITERS.md`, `tests/kanban-schema.test.ts`

The board knows a person as `lark:<union_id>`; the allowlists that decide tiers hold open_ids (spec §4.2; Decision 8). A person named by @-mention comes with both ids, but one named by principal alone -- typed out in chat, or in an agent's `mt kanban create` or `review` -- can be checked for talk tier only through an open_id Lark gave with the same union_id. Migration 005 adds a `people` table, one row per person per bot, written only by `src/db/people.ts`; `PeopleDirectory` notes each person Lark identifies and implements the service's `People`: a person never seen cannot be checked, so is not given work.

- [ ] **Step 2.1: Write the failing tests.**

In `tests/kanban-schema.test.ts`, replace:

```ts
    // 004 adds a column to kanban_comments and an index; every table is 003's.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(4);
```

with:

```ts
    // 004 adds a column to kanban_comments and an index, 005 the people table; every kanban table is 003's.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(5);
```

Create `tests/people.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notePerson, personOf } from '../src/db/people.js';
import { PeopleDirectory, unionIdOf } from '../src/kanban/people.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';

/**
 * The people the gateway has seen (migration 005): the board knows a person by
 * union_id, the tiers by open_id, and a person named only by principal is checked
 * through the open_id last seen with it (spec §4.2).
 */

let t: TestDb;
let clock: ManualClock;
let people: PeopleDirectory;
const TALK = new Set(['ou_alice']);

beforeEach(() => {
  t = testDb();
  clock = new ManualClock();
  people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: (openId) => TALK.has(openId), clock });
});
afterEach(() => t.close());

describe('notePerson', () => {
  it('keeps the last ids and name Lark gave, and a known name when it gave none', () => {
    notePerson(t.db, { appId: 'cli_app', unionId: 'on_alice', openId: 'ou_alice', name: 'Alice' }, 1);
    notePerson(t.db, { appId: 'cli_app', unionId: 'on_alice', openId: 'ou_alice2', name: null }, 2);
    expect(personOf(t.db, 'cli_app', 'on_alice')).toEqual({
      appId: 'cli_app',
      unionId: 'on_alice',
      openId: 'ou_alice2',
      name: 'Alice',
      seenAt: 2,
    });
    notePerson(t.db, { appId: 'cli_app', unionId: 'on_alice', openId: 'ou_alice2', name: 'Alice Smith' }, 3);
    expect(personOf(t.db, 'cli_app', 'on_alice')?.name).toBe('Alice Smith');
    // Per bot: another app's open_ids are another app's.
    expect(personOf(t.db, 'cli_other', 'on_alice')).toBeUndefined();
  });
});

describe('PeopleDirectory', () => {
  it('gives a person their principal once Lark gave both ids, and checks their tier by open_id', () => {
    expect(people.canTalk('lark:on_alice')).toBe(false);
    expect(people.saw({ openId: 'ou_alice', unionId: 'on_alice', name: 'Alice' })).toBe('lark:on_alice');
    expect(people.canTalk('lark:on_alice')).toBe(true);
    expect(people.nameOf('lark:on_alice')).toBe('Alice');
    expect(people.saw({ openId: 'ou_bob', unionId: 'on_bob', name: null })).toBe('lark:on_bob');
    expect(people.canTalk('lark:on_bob')).toBe(false);
    expect(people.nameOf('lark:on_bob')).toBeUndefined();
  });

  it('notes nobody who came without both ids, and knows no role or stranger', () => {
    expect(people.saw({ openId: 'ou_carol', unionId: null, name: 'Carol' })).toBeUndefined();
    expect(people.saw({ openId: null, unionId: 'on_carol', name: 'Carol' })).toBeUndefined();
    expect(people.canTalk('lark:on_carol')).toBe(false);
    expect(people.canTalk('implementer')).toBe(false);
    expect(people.canTalk('lark:')).toBe(false);
    expect(unionIdOf('lark:on_x')).toBe('on_x');
    expect(unionIdOf('implementer')).toBeUndefined();
  });
});
```


- [ ] **Step 2.2: Run them to verify they fail.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` and then `npx vitest run --project unit tests/people.test.ts tests/kanban-schema.test.ts`. Expected: `tests/people.test.ts` FAILS to load, with `Error: Cannot find module '../src/db/people.js'`, and the schema test FAILS, its version 4, not 5. `Tests  1 failed | 9 passed (10)`.

- [ ] **Step 2.3: Implement.**

Create `schema/005_people.sql`:

```sql
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
```

In `src/db/WRITERS.md`, replace:

```md
| `kanban_subscriptions` | `db/kanban.ts` | Added by `createTask`, in its transaction: the chat a task is created in, or the subscriptions of the task whose run created it (spec §9.4). `cursor` is moved forward only, by `advanceSubscription`, which writes no event: it is the notifier's own cursor, as a binding's `cursor_seq` is the card writer's. Never deleted. |
| `schema_version`, `user_version` | `db/open.ts` (`migrate`) | Migration files own the `schema_version` row contents; the runner owns `user_version`. |
```

with:

```md
| `kanban_subscriptions` | `db/kanban.ts` | Added by `createTask`, in its transaction: the chat a task is created in, or the subscriptions of the task whose run created it (spec §9.4). `cursor` is moved forward only, by `advanceSubscription`, which writes no event: it is the notifier's own cursor, as a binding's `cursor_seq` is the card writer's. Never deleted. |
| `people` | `db/people.ts` | One row per person per bot (migration 005): the open_id and name Lark last gave with a union_id, noted when a person sends a `/kanban` command, is mentioned in one, or presses a board card's button. How a person named by `lark:<union_id>` alone is checked for talk tier (spec §4.2). |
| `schema_version`, `user_version` | `db/open.ts` (`migrate`) | Migration files own the `schema_version` row contents; the runner owns `user_version`. |
```

Create `src/db/people.ts`:

```ts
import type { Db } from './open.js';
import { txImmediate } from './open.js';

/**
 * The people the gateway has seen in Lark (migration 005): for each union_id,
 * the open_id and name Lark last gave with it. The board knows people by
 * union_id, and the tiers by open_id, so this is how a person named only as
 * `lark:<union_id>` is checked for talk tier (spec §4.2). The only writer of
 * `people` (src/db/WRITERS.md).
 */

export interface PersonRow {
  appId: string;
  unionId: string;
  openId: string;
  name: string | null;
  seenAt: number;
}

interface PersonRaw {
  app_id: string;
  union_id: string;
  open_id: string;
  name: string | null;
  seen_at: number;
}

/**
 * Note a person as Lark gave them: the open_id and name replace what was known,
 * so a renamed person shows their new name. A name Lark did not give keeps the
 * one known.
 */
export function notePerson(
  db: Db,
  p: { appId: string; unionId: string; openId: string; name: string | null },
  now: number,
): void {
  txImmediate(db, (d) =>
    d
      .prepare(
        `INSERT INTO people (app_id, union_id, open_id, name, seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (app_id, union_id) DO UPDATE
           SET open_id = excluded.open_id, name = coalesce(excluded.name, people.name), seen_at = excluded.seen_at`,
      )
      .run(p.appId, p.unionId, p.openId, p.name, now),
  );
}

/** The person with this union_id, as this bot last saw them; undefined if never. */
export function personOf(db: Db, appId: string, unionId: string): PersonRow | undefined {
  const row = db
    .prepare<[string, string], PersonRaw>(
      'SELECT app_id, union_id, open_id, name, seen_at FROM people WHERE app_id = ? AND union_id = ?',
    )
    .get(appId, unionId);
  return row === undefined
    ? undefined
    : { appId: row.app_id, unionId: row.union_id, openId: row.open_id, name: row.name, seenAt: row.seen_at };
}
```

Create `src/kanban/people.ts`:

```ts
import type { Db } from '../db/open.js';
import { notePerson, personOf } from '../db/people.js';
import { systemClock, type Clock } from '../time.js';
import type { People } from './service.js';

/**
 * The people the board can give work to (spec §4.2, §9.1), as the gateway has
 * seen them in Lark.
 *
 * The board knows a person as `lark:<union_id>`; the tiers are decided by
 * open_id. Lark gives both for a sender, for whoever presses a card's button,
 * and for each person a message mentions, so each is noted as it is seen, and
 * a person named by principal alone -- typed out, or by an agent's `mt kanban
 * create` -- is checked through the open_id last seen with their union_id. A
 * person the gateway has never seen cannot be checked, and so is not given work.
 */

export interface PeopleDeps {
  db: Db;
  /** This bot: open_ids are per app. */
  appId: string;
  /** Whether an open_id has talk tier: the router's authorizer. */
  canTalk(openId: string): boolean;
  clock?: Clock;
}

/** Someone Lark identified: a sender, a card's presser, or a person a message mentions. */
export interface SeenPerson {
  openId: string | null;
  unionId: string | null;
  name: string | null;
}

const PREFIX = 'lark:';

/** A person's principal on the board (spec §3.1). */
export function personPrincipal(unionId: string): string {
  return `${PREFIX}${unionId}`;
}

/** The union_id in a person's principal, or undefined for anything else. */
export function unionIdOf(principal: string): string | undefined {
  return principal.startsWith(PREFIX) && principal.length > PREFIX.length ? principal.slice(PREFIX.length) : undefined;
}

export class PeopleDirectory implements People {
  readonly #deps: PeopleDeps;
  readonly #clock: Clock;

  constructor(deps: PeopleDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
  }

  /**
   * Note a person Lark identified, and give their principal. One that came
   * without both ids is not noted, and has no principal: the board records
   * people by union_id, and checks them by open_id.
   */
  saw(p: SeenPerson): string | undefined {
    if (p.unionId === null || p.unionId === '' || p.openId === null || p.openId === '') return undefined;
    notePerson(this.#deps.db, { appId: this.#deps.appId, unionId: p.unionId, openId: p.openId, name: p.name }, this.#clock.now());
    return personPrincipal(p.unionId);
  }

  /** Whether this person may be given work: seen, and at talk tier by the open_id last seen for them. */
  canTalk(principal: string): boolean {
    const unionId = unionIdOf(principal);
    if (unionId === undefined) return false;
    const person = personOf(this.#deps.db, this.#deps.appId, unionId);
    return person !== undefined && this.#deps.canTalk(person.openId);
  }

  /** The name Lark last gave for this person, if any: what a notice calls them. */
  nameOf(principal: string): string | undefined {
    const unionId = unionIdOf(principal);
    if (unionId === undefined) return undefined;
    return personOf(this.#deps.db, this.#deps.appId, unionId)?.name ?? undefined;
  }
}
```


- [ ] **Step 2.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/people.test.ts tests/kanban-schema.test.ts`. Expected: `Tests  13 passed (13)`.

- [ ] **Step 2.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1236 passed (1236)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  72 passed (72)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 2.6: Commit.**

```bash
git add schema/005_people.sql src/db/WRITERS.md src/db/people.ts src/kanban/people.ts tests/kanban-schema.test.ts tests/people.test.ts
git commit -m "Note each person Lark identifies, by union_id with the open_id and name it gave, in a people table, so a person named by principal alone can be checked for talk tier"
```

---

### Task 3: Sending to a person, with the uuid, and board cards

**Files:**
- Create: `tests/lark-adapter.test.ts`
- Modify: `src/channel/lark/adapter.ts`, `src/channel/types.ts`, `src/core/session-actor.ts`, `src/kanban/sink.ts`, `tests/helpers/channel.ts`, `tests/lark-cards.test.ts`

Three changes to the channel port and the Lark adapter (spec §9.2, §9.4; Decisions 10, 16, 21). A `SendTarget` may name a person by union_id (`receiveIdType`), which Lark takes per message, so a direct message needs no chat opened first. Every message that goes out as one message -- a text of up to 4,000 characters, which every router reply and every batch of notices is, an approval card, a board card -- is sent through the SDK's own client, `im.v1.message.create` or `reply`, with its uuid: Lark sends one message for any number of sends with one uuid within an hour, which closes the gap D1 lived with. And a board card, a `CardView` of markdown, an optional box and buttons, is posted with `sendCard` and redrawn with `updateCard`; a text may carry buttons too, for a notice's Unblock. An approval card's buttons now say `kind: 'approval'`. The request and the card's JSON are pure functions, tested as D1 tested the answered approval card; the fake channel records board cards and their redraws. Three more, as the uuid now reaches Lark and the SDK's own send no longer stands between: a send that never reached Lark -- no response, no code -- is retryable, as the SDK's send retried it; a text whose card of buttons Lark refuses, for a reason that is not the chat's, goes as plain text, so one bad card cannot hold a chat's notices back; and an approval card is built in schema 2.0 as a board card is, its buttons in the body with callback behaviors, and keyed one uuid per approval rather than per millisecond (Decisions 21, 31, 32, 33). A board card's buttons are named by their place and the card's attempt, so a redrawn card's buttons are new ones to the SDK (Decision 14). The adapter takes the SDK's channel, and how a retry waits, from a test, which `tests/lark-adapter.test.ts` uses to send through a stand-in; each of its tests checks the stand-in was taken before anything is sent, so none reaches Lark even before the adapter takes one.

- [ ] **Step 3.1: Write the failing tests.**

In `tests/helpers/channel.ts`, replace:

```ts
  ApprovalOutcomeView,
  CardSession,
```

with:

```ts
  ApprovalOutcomeView,
  CardButton,
  CardSession,
```

In `tests/helpers/channel.ts`, replace:

```ts
  CardSession,
  Channel,
```

with:

```ts
  CardSession,
  CardView,
  Channel,
```

In `tests/helpers/channel.ts`, replace:

```ts
  | 'updateApprovalCard'
  | 'react'
```

with:

```ts
  | 'updateApprovalCard'
  | 'sendCard'
  | 'updateCard'
  | 'react'
```

In `tests/helpers/channel.ts`, replace:

```ts
  target: SendTarget;
  text: string;
  uuid: string;
}

export interface ApprovalCall {
```

with:

```ts
  target: SendTarget;
  text: string;
  uuid: string;
  /** The buttons under it, when it was sent with some. */
  buttons?: readonly CardButton[];
}

export interface BoardCardCall {
  target: SendTarget;
  view: CardView;
  uuid: string;
}

export interface CardUpdateCall {
  messageId: string;
  view: CardView;
}

export interface ApprovalCall {
```

In `tests/helpers/channel.ts`, replace:

```ts
  readonly reactions: ReactionCall[] = [];
  readonly approvalUpdates: ApprovalUpdateCall[] = [];

  readonly #clock: Clock;
```

with:

```ts
  readonly reactions: ReactionCall[] = [];
  readonly approvalUpdates: ApprovalUpdateCall[] = [];
  /** Board cards posted (spec §9.2), and their redraws. */
  readonly boardCards: BoardCardCall[] = [];
  readonly cardUpdates: CardUpdateCall[] = [];

  readonly #clock: Clock;
```

In `tests/helpers/channel.ts`, replace:

```ts
  async sendText(target: SendTarget, text: string, uuid: string): Promise<SendResult> {
```

with:

```ts
  async sendText(target: SendTarget, text: string, uuid: string, buttons?: readonly CardButton[]): Promise<SendResult> {
```

In `tests/helpers/channel.ts`, replace:

```ts
    this.texts.push({ target, text, uuid });
```

with:

```ts
    this.texts.push({ target, text, uuid, ...(buttons === undefined ? {} : { buttons }) });
```

In `tests/helpers/channel.ts`, replace:

```ts
  }

  async react(messageId: string, emoji: string): Promise<void> {
    this.calls.push('react');
```

with:

```ts
  }

  async sendCard(target: SendTarget, view: CardView, uuid: string): Promise<SendResult> {
    this.calls.push('sendCard');
    await this.gate('sendCard');
    this.boardCards.push({ target, view, uuid });
    return { messageId: `om_board_${++this.#seq}`, deduped: false };
  }

  async updateCard(messageId: string, view: CardView): Promise<void> {
    this.calls.push('updateCard');
    await this.gate('updateCard');
    this.cardUpdates.push({ messageId, view });
  }

  async react(messageId: string, emoji: string): Promise<void> {
    this.calls.push('react');
```

Create `tests/lark-adapter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { LarkAdapter, sendError } from '../src/channel/lark/adapter.js';
import { ChannelError } from '../src/channel/types.js';

/**
 * How the Lark adapter sends one message (spec §9.4): through the SDK's client,
 * with the uuid, retried on a failure that never reached Lark, and falling back
 * as the SDK's own send does. Over a stand-in for the SDK's channel: nothing
 * here reaches Lark.
 */

interface Call {
  kind: 'create' | 'reply';
  payload: { params?: { receive_id_type: string }; path?: { message_id: string }; data: { msg_type: string; content: string; uuid: string; receive_id?: string } };
}

/** An HTTP error as axios throws one: Lark's code in the response body. */
function refused(code: number, status = 400): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { code, msg: `refused ${code}` }, headers: {} },
  });
}

function adapter(answers: Array<Error | undefined>): { a: LarkAdapter; calls: Call[]; waits: number[] } {
  const calls: Call[] = [];
  const waits: number[] = [];
  let seq = 0;
  const answer = async (kind: Call['kind'], payload: Call['payload']) => {
    calls.push({ kind, payload });
    const next = answers.shift();
    if (next !== undefined) throw next;
    return { code: 0, msg: 'ok', data: { message_id: `om_${++seq}` } };
  };
  const lark = {
    rawClient: {
      im: {
        v1: {
          message: {
            create: (p: Call['payload']) => answer('create', p),
            reply: (p: Call['payload']) => answer('reply', p),
          },
        },
      },
    },
  } as unknown as LarkChannel;
  const a = new LarkAdapter({ appId: 'cli_app', appSecret: 'not-a-secret' }, undefined, {
    lark,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  // Before anything is sent: an adapter that built its own SDK channel would reach Lark.
  if (a.raw !== lark) throw new Error('the adapter did not take the stand-in for the SDK');
  return { a, calls, waits };
}

const CHAT = { chatId: 'oc_team', threadId: '' };

describe('LarkAdapter.sendText', () => {
  it('sends a text as one post, with its uuid', async () => {
    const { a, calls } = adapter([]);
    expect(await a.sendText(CHAT, '**Done**', 'u-1')).toEqual({ messageId: 'om_1', deduped: false });
    expect(calls).toEqual([
      {
        kind: 'create',
        payload: {
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: 'oc_team',
            msg_type: 'post',
            content: JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'md', text: '**Done**' }]] } }),
            uuid: 'u-1',
          },
        },
      },
    ]);
  });

  it('retries a send that never reached Lark, with the same uuid, and not one Lark refused', async () => {
    const { a, calls, waits } = adapter([new Error('socket hang up'), new Error('ETIMEDOUT')]);
    expect((await a.sendText(CHAT, 'hi', 'u-2')).messageId).toBe('om_1');
    expect(calls.map((c) => c.payload.data.uuid)).toEqual(['u-2', 'u-2', 'u-2']);
    expect(waits).toHaveLength(2);
    const refusing = adapter([refused(230099)]);
    await expect(refusing.a.sendText(CHAT, 'hi', 'u-3')).rejects.toMatchObject({ code: 230099, retryable: false });
    expect(refusing.calls).toHaveLength(1);
  });

  it('sends a post Lark refuses as invalid content as plain text, and a reply to a withdrawn message to its chat', async () => {
    const invalid = adapter([refused(230001)]);
    await invalid.a.sendText(CHAT, 'hi', 'u-4');
    expect(invalid.calls.map((c) => [c.payload.data.msg_type, c.payload.data.content])).toEqual([
      ['post', JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'md', text: 'hi' }]] } })],
      ['text', JSON.stringify({ text: 'hi' })],
    ]);
    const withdrawn = adapter([refused(230011)]);
    await withdrawn.a.sendText({ chatId: 'oc_team', threadId: 'omt_gone' }, 'hi', 'u-5');
    expect(withdrawn.calls.map((c) => [c.kind, c.payload.path?.message_id ?? c.payload.data.receive_id])).toEqual([
      ['reply', 'omt_gone'],
      ['create', 'oc_team'],
    ]);
  });

  it('sends a text whose card of buttons Lark refuses without them, unless the bot is not in the chat', async () => {
    const button = { label: 'Unblock k_1', style: 'primary' as const, value: { kind: 'kanban' } };
    const fallback = adapter([refused(200621)]);
    expect((await fallback.a.sendText(CHAT, 'Blocked', 'u-6', [button])).messageId).toBe('om_1');
    expect(fallback.calls.map((c) => c.payload.data.msg_type)).toEqual(['interactive', 'post']);
    const outside = adapter([refused(230002)]);
    await expect(outside.a.sendText(CHAT, 'Blocked', 'u-7', [button])).rejects.toMatchObject({ code: 230002 });
    expect(outside.calls).toHaveLength(1);
  });
});

describe('LarkAdapter.sendApprovalCard', () => {
  it('posts the card with its uuid', async () => {
    const { a, calls } = adapter([]);
    await a.sendApprovalCard(CHAT, { approvalId: 'a_1', action: 'rm x', options: [{ optionId: 'allow', name: 'Allow' }], nonce: 'n' }, 'u-8');
    expect(calls[0]?.payload.data).toMatchObject({ msg_type: 'interactive', uuid: 'u-8' });
  });
});

describe('sendError', () => {
  it('makes a failure that never reached Lark retryable, and leaves an answer as Lark gave it', () => {
    expect(sendError(new Error('socket hang up'))).toMatchObject({ code: 0, retryable: true });
    expect(sendError(refused(230099))).toMatchObject({ code: 230099, retryable: false });
    expect(sendError(refused(99991400, 429))).toMatchObject({ code: 99991400, retryable: true });
    expect(sendError(new ChannelError(5, 'x', false))).toMatchObject({ code: 5, retryable: false });
  });
});
```

Replace the whole of `tests/lark-cards.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { approvalCard, approvalOutcomeCard, boardCard, messageRequest, postContent } from '../src/channel/lark/adapter.js';
import { personTarget, type CardView } from '../src/channel/types.js';

/**
 * The answered-approval card replaces one that carried live buttons. Two things
 * matter about it: the buttons are really gone, and nothing on it -- the agent's
 * request text, or the answerer's display name, which is whatever they set in
 * their profile -- is rendered somewhere a tag could be injected.
 */

const VIEW = { action: 'rm -rf /', choice: 'Deny', answeredBy: 'Alice' };

function elements(card: object): Array<Record<string, unknown>> {
  return (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
}

function texts(card: object): Array<{ tag: string; content: string }> {
  return elements(card)
    .map((e) => e['text'] as { tag: string; content: string } | undefined)
    .filter((t): t is { tag: string; content: string } => t !== undefined);
}

describe('approvalOutcomeCard', () => {
  it('has no buttons left to click', () => {
    const card = approvalOutcomeCard(VIEW);
    expect(JSON.stringify(card)).not.toContain('"button"');
    expect(elements(card).some((e) => e['tag'] === 'action')).toBe(false);
  });

  it('shows the request, the answer and who gave it', () => {
    const shown = texts(approvalOutcomeCard(VIEW)).map((t) => t.content).join('\n');
    expect(shown).toContain('rm -rf /');
    expect(shown).toContain('Deny');
    expect(shown).toContain('Alice');
  });

  it('renders every piece of text as plain_text, so none of it can become a mention', () => {
    const card = approvalOutcomeCard({
      action: '<at id=all></at>',
      choice: 'Allow',
      answeredBy: '<at id=all></at>',
    });
    expect(texts(card).every((t) => t.tag === 'plain_text')).toBe(true);
  });

  it('stays updatable, like the card it replaces', () => {
    const card = approvalOutcomeCard(VIEW) as { config?: { update_multi?: boolean } };
    expect(card.config?.update_multi).toBe(true);
  });
});

describe('approvalCard', () => {
  const spec = {
    approvalId: 'a_1',
    action: '<at id=all></at> rm -rf build',
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
    nonce: 'n1',
  };

  it("puts one button per option in the body, each value returned by a callback behavior and saying it is an approval's", () => {
    const els = elements(approvalCard(spec));
    expect(els[0]).toEqual({ tag: 'div', text: { tag: 'plain_text', content: '<at id=all></at> rm -rf build' } });
    expect(els.slice(1).map((b) => [b['tag'], b['type'], b['behaviors']])).toEqual([
      ['button', 'primary', [{ type: 'callback', value: { kind: 'approval', approvalId: 'a_1', optionId: 'allow', nonce: 'n1' } }]],
      ['button', 'danger', [{ type: 'callback', value: { kind: 'approval', approvalId: 'a_1', optionId: 'deny', nonce: 'n1' } }]],
    ]);
    // No container of schema 1.0: every element is one schema 2.0 has.
    expect(JSON.stringify(approvalCard(spec))).not.toContain('"action"');
    expect((approvalCard(spec) as { schema?: string; config?: { update_multi?: boolean } })).toMatchObject({
      schema: '2.0',
      config: { update_multi: true },
    });
  });
});

describe('messageRequest', () => {
  const card = { schema: '2.0' };

  it('sends a person a direct message by union_id, with the uuid (spec §9.2)', () => {
    expect(messageRequest(personTarget('on_alice'), 'interactive', card, 'u-1')).toEqual({
      kind: 'create',
      params: { receive_id_type: 'union_id' },
      data: { receive_id: 'on_alice', msg_type: 'interactive', content: JSON.stringify(card), uuid: 'u-1' },
    });
  });

  it('replies in a thread, quotes at chat scope, and posts new otherwise, the uuid always with it', () => {
    expect(messageRequest({ chatId: 'oc_team', threadId: 'omt_topic' }, 'post', card, 'u-2')).toEqual({
      kind: 'reply',
      path: { message_id: 'omt_topic' },
      data: { msg_type: 'post', content: JSON.stringify(card), uuid: 'u-2', reply_in_thread: true },
    });
    expect(messageRequest({ chatId: 'oc_team', threadId: '', replyTo: 'om_q' }, 'post', card, 'u-3')).toEqual({
      kind: 'reply',
      path: { message_id: 'om_q' },
      data: { msg_type: 'post', content: JSON.stringify(card), uuid: 'u-3' },
    });
    expect(messageRequest({ chatId: 'oc_team', threadId: '' }, 'post', card, 'u-4')).toEqual({
      kind: 'create',
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_team', msg_type: 'post', content: JSON.stringify(card), uuid: 'u-4' },
    });
  });

  it('makes a text one post of one markdown element, as the SDK does', () => {
    expect(postContent('**Done** — x')).toEqual({ zh_cn: { title: '', content: [[{ tag: 'md', text: '**Done** — x' }]] } });
  });
});

describe('boardCard', () => {
  const view: CardView = {
    markdown: '📋 **Draft the notes** `k_1`',
    input: { placeholder: '<at id=all></at> a summary' },
    buttons: [
      { label: 'Done', style: 'primary', value: { kind: 'kanban', act: 'done', task: 'k_1', run: 'r_1', nonce: 'n' } },
      { label: '<at id=all></at>', style: 'danger', value: { kind: 'kanban', act: 'block', task: 'k_1', run: 'r_1', nonce: 'n' } },
    ],
  };

  it("puts the box and the buttons in one form, so a button submits the box's text", () => {
    const els = elements(boardCard(view));
    expect(els[0]).toEqual({ tag: 'markdown', content: view.markdown });
    const form = els[1] as { tag: string; elements: Array<Record<string, unknown>> };
    expect(form.tag).toBe('form');
    expect(form.elements[0]).toMatchObject({ tag: 'input', name: 'text' });
    expect(form.elements.slice(1).map((b) => [b['form_action_type'], b['behaviors']])).toEqual([
      ['submit', [{ type: 'callback', value: view.buttons[0]?.value }]],
      ['submit', [{ type: 'callback', value: view.buttons[1]?.value }]],
    ]);
  });

  it('renders every label and the placeholder as plain_text, so none can become a mention', () => {
    const json = JSON.stringify(boardCard(view));
    expect(json).not.toContain('"lark_md"');
    const form = elements(boardCard(view))[1] as { elements: Array<Record<string, { tag: string }>> };
    expect(form.elements.map((e) => (e['text'] ?? e['placeholder'])?.tag)).toEqual(['plain_text', 'plain_text', 'plain_text']);
  });

  it("names each button by its place and the card's attempt, so a redrawn card's buttons are new ones", () => {
    const names = (v: CardView) =>
      (elements(boardCard(v))[1] as { elements: Array<Record<string, unknown>> }).elements.slice(1).map((b) => b['name']);
    expect(names(view)).toEqual(['button_0_0', 'button_1_0']);
    expect(names({ ...view, attempt: 2 })).toEqual(['button_0_2', 'button_1_2']);
  });

  it('has no form without a box, and no buttons once acted on; and stays updatable', () => {
    const plain = elements(boardCard({ markdown: view.markdown, buttons: view.buttons }));
    expect(plain.map((e) => e['tag'])).toEqual(['markdown', 'button', 'button']);
    expect(plain[1]?.['form_action_type']).toBeUndefined();
    const acted = boardCard({ markdown: 'Done — by Alice', buttons: [] });
    expect(JSON.stringify(acted)).not.toContain('"button"');
    expect((acted as { config?: { update_multi?: boolean } }).config?.update_multi).toBe(true);
  });
});
```


- [ ] **Step 3.2: Run them to verify they fail.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` and then `npx vitest run --project unit tests/lark-cards.test.ts tests/lark-adapter.test.ts`. Expected: fourteen FAIL: each of `tests/lark-adapter.test.ts`'s adapter tests with `Error: the adapter did not take the stand-in for the SDK`, before anything is sent, so none reaches Lark, and its `sendError` test with `TypeError: (0 , sendError) is not a function`; and the cards' tests on the missing `personTarget`, `messageRequest`, `postContent`, `boardCard` and `approvalCard`; the answered approval card's four pass. `Tests  14 failed | 4 passed (18)`.

- [ ] **Step 3.3: Implement.**

In `src/channel/lark/adapter.ts`, replace:

```ts
import type {
  ApprovalCardSpec,
  ApprovalOutcomeView,
  CardSession,
  Channel,
  SendResult,
  SendTarget,
```

with:

```ts
import {
  ChannelError,
  type ApprovalCardSpec,
  type ApprovalOutcomeView,
  type CardButton,
  type CardSession,
  type CardView,
  type Channel,
  type SendResult,
  type SendTarget,
```

In `src/channel/lark/adapter.ts`, replace:

```ts
 * **Known gap.** The port's `uuid` parameter is accepted and not forwarded: the
 * SDK's high-level `send`/`stream` do not expose Feishu's `uuid` field, so
 * platform-side send dedup is unavailable here. Sends are therefore at-least-once
 * *without* the one-hour dedup window the design assumes, and a retry after an
 * ambiguous failure can post a second copy. The parameter stays in the port
 * rather than being deleted, because deleting it would erase the requirement
 * along with the gap -- and closing it is a one-line change once the SDK exposes
 * the field.
```

with:

```ts
 * **The uuid.** The SDK's high-level `send`/`stream` do not expose Feishu's
 * `uuid` field, so every message that goes out as one message -- a text of up to
 * `ONE_MESSAGE` characters, an approval card, a board card -- is sent through the
 * SDK's own client instead (`im.v1.message.create` or `reply`), with the uuid:
 * Feishu then sends one message for any number of sends with the same uuid
 * within an hour, so a retry, or a notice sent again after a restart, is one
 * message (spec §9.4). A longer text is split by the SDK into several messages,
 * and a streamed card is the SDK's to send; neither carries the uuid, so a retry
 * of those can still post a second copy.
```

In `src/channel/lark/adapter.ts`, replace:

```ts
const MAX_SEND_ATTEMPTS = 4;
/** Feishu's text message ceiling, with headroom. */
```

with:

```ts
const MAX_SEND_ATTEMPTS = 4;
/** Lark's code for "the bot is not in the chat": a card refused so would be refused as text too. */
const NOT_IN_CHAT = 230002;
/** Feishu's text message ceiling, with headroom. */
```

In `src/channel/lark/adapter.ts`, replace:

```ts
/** Feishu's text message ceiling, with headroom. */
const TEXT_BUDGET = 12_000;

export class LarkAdapter implements Channel {
```

with:

```ts
/** Feishu's text message ceiling, with headroom. */
const TEXT_BUDGET = 12_000;
/**
 * The longest text sent as one message, with its uuid. Every reply the router
 * sends (cut at 4,000) and every batch of notices (at most 3,800) fits; a longer
 * text is split by the SDK, at its own 3,500, without one.
 */
export const ONE_MESSAGE = 4_000;
/** Lark's code for a message that was withdrawn: a reply to it goes to its chat instead, as the SDK's own send does. */
const WITHDRAWN = 230011;
/** Lark's code for content it will not take: a post refused so goes as plain text, as the SDK's own send does. */
const INVALID_CONTENT = 230001;

/**
 * What a test gives the adapter in place of Lark: the SDK's channel, and how a
 * retry waits. Absent, the real ones.
 */
export interface LarkAdapterDeps {
  lark?: LarkChannel;
  sleep?: (ms: number) => Promise<void>;
}

export class LarkAdapter implements Channel {
```

In `src/channel/lark/adapter.ts`, replace:

```ts
  readonly #clock: Clock;
  #botOpenId: string | undefined;
```

with:

```ts
  readonly #clock: Clock;
  readonly #sleep: (ms: number) => Promise<void>;
  #botOpenId: string | undefined;
```

In `src/channel/lark/adapter.ts`, replace:

```ts
  constructor(config: LarkChannelConfig, clock: Clock = systemClock) {
```

with:

```ts
  constructor(config: LarkChannelConfig, clock: Clock = systemClock, deps: LarkAdapterDeps = {}) {
```

In `src/channel/lark/adapter.ts`, replace:

```ts
    this.#lark = createLarkChannel({
```

with:

```ts
    this.#sleep = deps.sleep ?? sleep;
    this.#lark = deps.lark ?? createLarkChannel({
```

In `src/channel/lark/adapter.ts`, replace:

```ts
  async sendText(target: SendTarget, text: string, _uuid: string): Promise<SendResult> {
```

with:

```ts
  async sendText(target: SendTarget, text: string, uuid: string, buttons?: readonly CardButton[]): Promise<SendResult> {
    if (buttons !== undefined && buttons.length > 0) {
      try {
        return await this.sendCard(target, { markdown: text, buttons }, uuid);
      } catch (err) {
        // A card Lark will not take, for a reason that is not the chat's, must not
        // hold back the text it carries: the text goes alone, without its buttons.
        if (!(err instanceof ChannelError) || err.code === 0 || err.retryable || err.code === NOT_IN_CHAT) throw err;
        return this.sendText(target, text, uuid);
      }
    }
    if (text.length <= ONE_MESSAGE) {
      return this.#withRetry(async () => {
        try {
          return await this.#post(target, 'post', postContent(text), uuid);
        } catch (err) {
          if (!(err instanceof ChannelError) || err.code !== INVALID_CONTENT) throw err;
          return this.#post(target, 'text', { text }, uuid);
        }
      });
    }
```

In `src/channel/lark/adapter.ts`, replace:

```ts
      );
      return { messageId: result.messageId, deduped: false };
    });
  }

  /**
```

with:

```ts
      );
      return { messageId: result.messageId, deduped: false };
    });
  }

  async sendCard(target: SendTarget, view: CardView, uuid: string): Promise<SendResult> {
    return this.#withRetry(() => this.#post(target, 'interactive', boardCard(view), uuid));
  }

  async updateCard(messageId: string, view: CardView): Promise<void> {
    try {
      await this.#lark.updateCard(messageId, boardCard(view));
    } catch (err) {
      throw toChannelError(err);
    }
  }

  /**
   * One message, sent through the SDK's client with its uuid. A reply whose
   * message was withdrawn goes to the chat instead, as the SDK's own send does.
   */
  async #post(target: SendTarget, msgType: 'post' | 'text' | 'interactive', content: object, uuid: string): Promise<SendResult> {
    const im = this.#lark.rawClient.im.v1.message;
    const send = async (req: MessageRequest): Promise<SendResult> => {
      let r: { code?: number | undefined; msg?: string | undefined; data?: { message_id?: string | undefined } | undefined };
      try {
        r = req.kind === 'create' ? await im.create({ params: req.params, data: req.data }) : await im.reply({ path: req.path, data: req.data });
      } catch (err) {
        throw sendError(err);
      }
      if (typeof r.code === 'number' && r.code !== 0) throw toChannelError(r);
      const messageId = r.data?.message_id;
      if (messageId === undefined || messageId === '') throw new ChannelError(0, 'Lark answered the send with no message id', false);
      return { messageId, deduped: false };
    };
    const req = messageRequest(target, msgType, content, uuid);
    try {
      return await send(req);
    } catch (err) {
      if (req.kind !== 'reply' || !(err instanceof ChannelError) || err.code !== WITHDRAWN) throw err;
      return send(messageRequest({ chatId: target.chatId, threadId: '' }, msgType, content, uuid));
    }
  }

  /**
```

In `src/channel/lark/adapter.ts`, replace:

```ts
    _uuid: string,
```

with:

```ts
    uuid: string,
```

In `src/channel/lark/adapter.ts`, replace:

```ts
    const card = {
      schema: '2.0',
      config: { update_multi: true },
      body: {
        elements: [
          {
            tag: 'div',
            text: { tag: 'plain_text', content: forPlainText(spec.action) },
          },
          {
            tag: 'action',
            actions: spec.options.map((option) => ({
              tag: 'button',
              text: { tag: 'plain_text', content: forPlainText(option.name) },
              type: buttonType(option.kind),
              // `action.value` round-trips through the client and Lark does not
              // verify it. It is a pointer, never a claim: identity comes from
              // `operator.openId` on the callback, and the nonce is re-checked
              // against the log by a generation CAS before anything happens.
              value: { approvalId: spec.approvalId, optionId: option.optionId, nonce: spec.nonce },
            })),
          },
        ],
      },
    };

    return this.#withRetry(async () => {
      const result = await this.#lark.send(target.chatId, { card }, this.#sendOptions(target));
      return { messageId: result.messageId, deduped: false };
    });
```

with:

```ts
    return this.#withRetry(() => this.#post(target, 'interactive', approvalCard(spec), uuid));
```

In `src/channel/lark/adapter.ts`, replace:

```ts
        await sleep(wait);
```

with:

```ts
        await this.#sleep(wait);
```

In `src/channel/lark/adapter.ts`, replace:

```ts
    }
    throw toChannelError(lastError);
  }
}

/**
```

with:

```ts
    }
    throw toChannelError(lastError);
  }
}

/**
 * An approval card, in Lark's card schema 2.0: the request, then one button per
 * offered option, each directly in the body, its value returned through a
 * callback behavior, as a board card's buttons are (`boardCard`).
 *
 * `value` round-trips through the client and Lark does not verify it. It is a
 * pointer, never a claim: identity comes from `operator.openId` on the callback,
 * and the nonce is re-checked against the log by a generation CAS before
 * anything happens. `kind` is how the router tells an approval's button from a
 * board card's (spec §9.2); a card posted before it had one is an approval's.
 */
export function approvalCard(spec: ApprovalCardSpec): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    body: {
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: forPlainText(spec.action) } },
        ...spec.options.map((option, i) => ({
          tag: 'button',
          name: `option_${i}`,
          text: { tag: 'plain_text', content: forPlainText(option.name) },
          type: buttonType(option.kind),
          behaviors: [
            {
              type: 'callback',
              value: { kind: 'approval', approvalId: spec.approvalId, optionId: option.optionId, nonce: spec.nonce },
            },
          ],
        })),
      ],
    },
  };
}

/**
```

In `src/channel/lark/adapter.ts`, replace:

```ts
}

function buttonType(kind: string | undefined): string {
  switch (kind) {
```

with:

```ts
}

/**
 * A send's failure, as the channel reports it. One that never reached Lark -- no
 * response, so no status and no code: a reset connection, a timeout -- is worth
 * retrying, as the SDK's own send retried it; the uuid makes a retry of a send
 * that did land one message.
 */
export function sendError(err: unknown): ChannelError {
  const e = toChannelError(err);
  const answered = typeof err === 'object' && err !== null && (err as { response?: unknown }).response !== undefined;
  if (e.code !== 0 || e.retryable || answered) return e;
  return new ChannelError(0, err instanceof Error && err.message !== '' ? err.message : 'lark request failed', true);
}

/** One message, as `#post` sends it: a reply where the target threads or quotes, otherwise a new message. */
export type MessageRequest =
  | {
      kind: 'create';
      params: { receive_id_type: 'chat_id' | 'union_id' };
      data: { receive_id: string; msg_type: string; content: string; uuid: string };
    }
  | {
      kind: 'reply';
      path: { message_id: string };
      data: { msg_type: string; content: string; reply_in_thread?: boolean; uuid: string };
    };

/**
 * The request for one message to `target`, as `#sendOptions` places a message:
 * in its thread, as a quoted reply, or new in the chat -- or, for a person, as a
 * direct message by union_id. The uuid goes with it either way.
 */
export function messageRequest(target: SendTarget, msgType: string, content: object, uuid: string): MessageRequest {
  const body = { msg_type: msgType, content: JSON.stringify(content), uuid };
  if (target.receiveIdType !== 'union_id') {
    if (target.threadId !== '') return { kind: 'reply', path: { message_id: target.threadId }, data: { ...body, reply_in_thread: true } };
    if (target.replyTo !== undefined) return { kind: 'reply', path: { message_id: target.replyTo }, data: body };
  }
  return {
    kind: 'create',
    params: { receive_id_type: target.receiveIdType ?? 'chat_id' },
    data: { receive_id: target.chatId, ...body },
  };
}

/**
 * A text as a post of one markdown element, as the SDK's own markdown send makes
 * one: Feishu renders the markdown.
 */
export function postContent(text: string): object {
  return { zh_cn: { title: '', content: [[{ tag: 'md', text }]] } };
}

/**
 * A board card (spec §9.2), in Lark's card schema 2.0: its markdown, then its
 * buttons -- in a form with the box, named `text`, when the card has one, so
 * each button submits what was typed (the inbound side reads it as
 * `form_value.text`). Each button's value goes back through a callback behavior.
 * Button labels and the box's placeholder are `plain_text`, as on an approval
 * card; the markdown was escaped by whoever rendered it. Updatable, so it can be
 * redrawn once acted on.
 */
export function boardCard(view: CardView): object {
  const buttons = view.buttons.map((b, i) => ({
    tag: 'button',
    // The attempt in the name: the SDK keys a press on the button's name, whole,
    // and on only the start of its value, however Lark orders the value's keys.
    name: `button_${i}_${view.attempt ?? 0}`,
    text: { tag: 'plain_text', content: forPlainText(b.label) },
    type: b.style,
    behaviors: [{ type: 'callback', value: { ...b.value } }],
    ...(view.input === undefined ? {} : { form_action_type: 'submit' }),
  }));
  const elements: object[] = [{ tag: 'markdown', content: view.markdown }];
  if (buttons.length > 0 && view.input !== undefined) {
    elements.push({
      tag: 'form',
      name: 'board',
      elements: [
        {
          tag: 'input',
          name: 'text',
          width: 'fill',
          max_length: 1000,
          placeholder: { tag: 'plain_text', content: forPlainText(view.input.placeholder) },
        },
        ...buttons,
      ],
    });
  } else {
    elements.push(...buttons);
  }
  return { schema: '2.0', config: { update_multi: true }, body: { elements } };
}

function buttonType(kind: string | undefined): string {
  switch (kind) {
```

In `src/channel/types.ts`, replace:

```ts
export interface SendTarget {
  chatId: string;
```

with:

```ts
export interface SendTarget {
  /** The chat; or, when `receiveIdType` is `union_id`, the person. */
  chatId: string;
```

In `src/channel/types.ts`, replace:

```ts
  replyTo?: string;
}
```

with:

```ts
  replyTo?: string;
  /**
   * How `chatId` names who receives the message: absent, a chat; `union_id`, a
   * person, sent a direct message (spec §9.2). Lark takes the type per message,
   * so a person need not have opened a chat with the bot first.
   */
  receiveIdType?: 'union_id';
}

/** A direct message to a person, by union_id (spec §9.2). */
export function personTarget(unionId: string): SendTarget {
  return { chatId: unionId, threadId: '', receiveIdType: 'union_id' };
}

/**
 * A button on a card. `value` round-trips through the client and Lark does not
 * verify it: a pointer at most, never a claim about who pressed it.
 */
export interface CardButton {
  label: string;
  style: 'primary' | 'danger' | 'default';
  value: Readonly<Record<string, string>>;
}

/**
 * A card a person acts on (spec §9.2): markdown, already escaped and masked by
 * whoever rendered it; a box whose text the buttons submit with them, for a
 * summary or a reason; and the buttons -- none once it has been acted on.
 */
export interface CardView {
  markdown: string;
  input?: { placeholder: string };
  buttons: readonly CardButton[];
  /**
   * How many times the card has been redrawn live after a press it refused. The
   * buttons' names carry it, so a press of the redrawn card is not taken for the
   * press before it by a channel that drops a press it has seen.
   */
  attempt?: number;
}
```

In `src/channel/types.ts`, replace:

```ts
  /** Plain text message. Used for rejections, errors, and command output. */
  sendText(target: SendTarget, text: string, uuid: string): Promise<SendResult>;
```

with:

```ts
  /**
   * Plain text message. Used for rejections, errors, command output and the
   * board's notices; with buttons under it, a card (spec §9.2: a blocked task's
   * Unblock).
   */
  sendText(target: SendTarget, text: string, uuid: string, buttons?: readonly CardButton[]): Promise<SendResult>;
```

In `src/channel/types.ts`, replace:

```ts
   */
  updateApprovalCard(messageId: string, view: ApprovalOutcomeView): Promise<void>;

  /** Add the bot's reaction to a message. */
```

with:

```ts
   */
  updateApprovalCard(messageId: string, view: ApprovalOutcomeView): Promise<void>;

  /** Post a board card: a task for its assignee, a review for its reviewer (spec §9.2). */
  sendCard(target: SendTarget, view: CardView, uuid: string): Promise<SendResult>;

  /** Redraw a board card once it has been acted on, so its buttons stop working. */
  updateCard(messageId: string, view: CardView): Promise<void>;

  /** Add the bot's reaction to a message. */
```

In `src/core/session-actor.ts`, replace:

```ts
        sendUuid(this.#key.appId, this.sessionId, now),
```

with:

```ts
        // One per approval: keyed on the time, two in one millisecond would share a
        // uuid, and Lark, which sends one message per uuid, would drop the second.
        sendUuid(this.#key.appId, approvalId, generation),
```

In `src/kanban/sink.ts`, replace:

```ts
  CardSession,
  Channel,
```

with:

```ts
  CardSession,
  CardView,
  Channel,
```

In `src/kanban/sink.ts`, replace:

```ts
  }

  async updateApprovalCard(_messageId: string, _view: ApprovalOutcomeView): Promise<void> {}

  async react(_messageId: string, _emoji: string): Promise<void> {}

  async unreact(_messageId: string, _emoji: string): Promise<void> {}
}
```

with:

```ts
  }

  async updateApprovalCard(_messageId: string, _view: ApprovalOutcomeView): Promise<void> {}

  /** A run's session posts no board card; one would be discarded, as its other cards are. */
  async sendCard(_target: SendTarget, _view: CardView, uuid: string): Promise<SendResult> {
    return { messageId: `kanban:${uuid}`, deduped: false };
  }

  async updateCard(_messageId: string, _view: CardView): Promise<void> {}

  async react(_messageId: string, _emoji: string): Promise<void> {}

  async unreact(_messageId: string, _emoji: string): Promise<void> {}
}
```


- [ ] **Step 3.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/lark-cards.test.ts tests/lark-adapter.test.ts`. Expected: `Tests  18 passed (18)`.

- [ ] **Step 3.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1250 passed (1250)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  72 passed (72)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 3.6: Commit.**

```bash
git add src/channel/lark/adapter.ts src/channel/types.ts src/core/session-actor.ts src/kanban/sink.ts tests/helpers/channel.ts tests/lark-adapter.test.ts tests/lark-cards.test.ts
git commit -m "Send a direct message to a person by union_id, pass the uuid to Lark for every message sent as one, retrying a send that never reached Lark, and post board cards, and approval cards, in card schema 2.0"
```

---

### Task 4: What the board checks of a person's report

**Files:**
- Create: `tests/kanban-people-reports.test.ts`
- Modify: `src/db/kanban-read.ts`, `src/db/kanban.ts`, `src/kanban/service.ts`, `src/kanban/types.ts`

Four things the board does for people (spec §5.1, §7.7, §9.2; Decisions 11, 12, 13, 16, 19). A person's `Reporter` may name the run a card was for, re-checked inside the transaction against the task's open run, so a card for a run that is over does nothing (`run_superseded`). A person's `complete` or `review` on a task with gates is refused `workspace_busy` while another task's agent run is open in the workspace the gates would run in: spec §7.7's known limitation, asked before the gates, as nothing is claimed into a workspace while a report's gates run. A claim records its assignee's kind, so a person's can be told as one. `recordCard` records once that a person's run was sent its card (`card_sent`), or that Lark refused it for good (`card_failed`), and `cardsDue` lists the runs still waiting for one. And `unblock` takes the event an Unblock button was for -- refused as `invalid` unless it is a block of that task, and as `stale` once that block has been lifted. `cardReading` reads what a person's card shows of the board, for the cards Task 10 sends and the live redraws of Task 8.

- [ ] **Step 4.1: Write the failing tests.**

Create `tests/kanban-people-reports.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cardsDue, eventsOf, getRun, getTask } from '../src/db/kanban-read.js';
import type { GateExit, GateRunOptions } from '../src/kanban/gates.js';
import { KanbanService, type CreateRequest } from '../src/kanban/service.js';
import type { RunRow, TaskRow } from '../src/kanban/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES, role } from './helpers/dispatch.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * What the board checks of a person's report, from plan D2 (spec §5.1, §7.7,
 * §9.2): a card's run, re-checked in the transaction, so a card for a run that is
 * over does nothing; a person's report refused while another task's agent run
 * is open in the workspace its gates would run in; a person's claim told as
 * one; a card recorded once; and an Unblock for a block already lifted refused.
 */

const BOB = 'lark:on_bob';
const DIRS = new Map([...WORKSPACES].map((w) => [w, `/ws/${w}`]));

let t: TestDb;
let service: KanbanService;
let ran: string[];

beforeEach(() => {
  t = testDb();
  ran = [];
  const runGate = async (command: string, _opts: GateRunOptions): Promise<GateExit> => {
    ran.push(command);
    return { exitCode: 0, signal: null, timedOut: false, output: '' };
  };
  service = new KanbanService({
    db: t.db,
    // Gates on a task no agent has run on run as the role default (spec §7.7).
    roles: new Map([...DEFAULT_ROLES, role('default')].map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
    people: { canTalk: (p) => p === ALICE || p === BOB },
    checks: { workspaceDirs: DIRS, env: {}, runGate },
  });
});
afterEach(() => t.close());

function create(req: Partial<CreateRequest> = {}): TaskRow {
  const r = service.create({ title: 'Check the links', assignee: ALICE, workspace: 'docs', createdBy: BOB, createdVia: VIA, ...req });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.task;
}

function claim(taskId: string): RunRow {
  const r = service.claim(taskId);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.run;
}

describe("a person's report through a card", () => {
  it('decides the run the card was for, and does nothing once that run is over', async () => {
    const task = create();
    const first = claim(task.taskId);
    // Reassigned and back: a new run, and the first card is out of date.
    expect(service.assign(task.taskId, BOB, BOB).ok).toBe(true);
    expect(service.assign(task.taskId, ALICE, BOB).ok).toBe(true);
    const second = claim(task.taskId);
    const stale = await service.complete(task.taskId, { kind: 'person', principal: ALICE, runId: first.runId }, { summary: 'all fine' });
    expect(stale).toMatchObject({ ok: false, code: 'run_superseded' });
    expect(getRun(t.db, second.runId)?.outcome).toBeNull();
    const fresh = await service.complete(task.taskId, { kind: 'person', principal: ALICE, runId: second.runId }, { summary: 'all fine' });
    expect(fresh.ok).toBe(true);
    expect(getRun(t.db, second.runId)).toMatchObject({ outcome: 'completed', summary: 'all fine' });
    expect(getRun(t.db, second.runId)?.endedAt).not.toBeNull();
  });

  it('refuses a block or a change through a card for a run that is over', () => {
    const task = create();
    const run = claim(task.taskId);
    expect(service.block(task.taskId, { kind: 'person', principal: ALICE, runId: 'r_gone' }, { kind: 'needs_input', reason: 'which wiki?' }))
      .toMatchObject({ ok: false, code: 'run_superseded' });
    expect(service.block(task.taskId, { kind: 'person', principal: ALICE, runId: run.runId }, { kind: 'needs_input', reason: 'which wiki?' }).ok)
      .toBe(true);
    expect(getTask(t.db, task.taskId)?.phase).toBe('blocked');
  });
});

describe("a person's report beside another task's agent", () => {
  it('is refused while that agent run is open in the workspace its gates run in, and runs no gate', async () => {
    const task = create();
    expect(service.addGate(task.taskId, { command: 'test -f notes.md' }, BOB).ok).toBe(true);
    const run = claim(task.taskId);
    const other = create({ assignee: 'implementer', title: 'Tidy the docs' });
    const agent = service.claim(other.taskId);
    if (!agent.ok) throw new Error(agent.message);
    const refused = await service.complete(task.taskId, { kind: 'person', principal: ALICE, runId: run.runId }, { summary: 'done' });
    expect(refused).toMatchObject({ ok: false, code: 'workspace_busy' });
    if (refused.ok) throw new Error('not refused');
    expect(refused.message).toContain(`where task ${other.taskId}'s agent run ${agent.run.runId} is open`);
    expect(ran).toEqual([]);
    // A review asked for by the person is refused the same way: it runs the gates too.
    expect(await service.requestReview(task.taskId, { kind: 'person', principal: ALICE }, { summary: 'done', reviewer: BOB }))
      .toMatchObject({ ok: false, code: 'workspace_busy' });
    // Once the agent run is over, the report goes through, its gates run.
    expect(service.endRun(agent.run.runId, { outcome: 'failed', error: 'x', hadSideEffects: false }).ok).toBe(true);
    expect(service.closeRun(agent.run.runId).ok).toBe(true);
    expect((await service.complete(task.taskId, { kind: 'person', principal: ALICE }, { summary: 'done' })).ok).toBe(true);
    expect(ran).toEqual(['test -f notes.md']);
  });

  it('goes through when the task has no gate: nothing would run in the checkout', async () => {
    const task = create();
    claim(task.taskId);
    const other = create({ assignee: 'implementer', title: 'Tidy the docs' });
    expect(service.claim(other.taskId).ok).toBe(true);
    expect((await service.complete(task.taskId, { kind: 'person', principal: ALICE }, { summary: 'done' })).ok).toBe(true);
  });
});

describe("a person's claim, and their card", () => {
  it('records the claim as a person\'s, and lists the run as due a card until one is recorded, once', () => {
    const task = create();
    const run = claim(task.taskId);
    expect(eventsOf(t.db, task.taskId).find((e) => e.kind === 'claimed')?.payload).toMatchObject({
      assignee: ALICE,
      assigneeKind: 'human',
    });
    expect(cardsDue(t.db).map((r) => r.runId)).toEqual([run.runId]);
    expect(service.recordCard(run.runId, { messageId: 'om_card' })).toEqual({ ok: true, recorded: true });
    expect(service.recordCard(run.runId, { error: 'later' })).toEqual({ ok: true, recorded: false });
    expect(cardsDue(t.db)).toEqual([]);
    expect(eventsOf(t.db, task.taskId).filter((e) => e.kind.startsWith('card_')).map((e) => [e.kind, e.payload])).toEqual([
      ['card_sent', { kind: 'work', to: ALICE, messageId: 'om_card' }],
    ]);
  });

  it("records a card refused for good, and none for an agent's run", () => {
    const task = create();
    const run = claim(task.taskId);
    expect(service.recordCard(run.runId, { error: 'the user is not in the app' })).toEqual({ ok: true, recorded: true });
    expect(cardsDue(t.db)).toEqual([]);
    const agentTask = create({ assignee: 'implementer' });
    const agent = service.claim(agentTask.taskId);
    if (!agent.ok) throw new Error(agent.message);
    expect(service.recordCard(agent.run.runId, { messageId: 'om_x' })).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('an Unblock for a block already lifted', () => {
  it('is refused, and one for the block that stands goes through', () => {
    const task = create();
    claim(task.taskId);
    expect(service.block(task.taskId, { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason: 'which wiki?' }).ok).toBe(true);
    const first = eventsOf(t.db, task.taskId).findLast((e) => e.kind === 'blocked')?.id ?? 0;
    expect(service.unblock(task.taskId, BOB, undefined, { blockedAt: first }).ok).toBe(true);
    claim(task.taskId);
    expect(service.block(task.taskId, { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason: 'still unsure' }).ok).toBe(true);
    // The first notice's button: its block was lifted, and this is another.
    expect(service.unblock(task.taskId, BOB, undefined, { blockedAt: first })).toMatchObject({ ok: false, code: 'stale' });
    expect(getTask(t.db, task.taskId)?.phase).toBe('blocked');
    const second = eventsOf(t.db, task.taskId).findLast((e) => e.kind === 'blocked')?.id ?? 0;
    // A button's event must be a block of this task: another task's, or a claim, is no pointer to one.
    const claimEvent = eventsOf(t.db, task.taskId).findLast((e) => e.kind === 'claimed')?.id ?? 0;
    expect(service.unblock(task.taskId, BOB, undefined, { blockedAt: claimEvent })).toMatchObject({ ok: false, code: 'invalid' });
    const other = create({ title: 'Another' });
    const otherEvent = eventsOf(t.db, other.taskId).at(-1)?.id ?? 0;
    expect(service.unblock(task.taskId, BOB, undefined, { blockedAt: otherEvent })).toMatchObject({ ok: false, code: 'invalid' });
    expect(service.unblock(task.taskId, BOB, undefined, { blockedAt: second }).ok).toBe(true);
  });
});
```


- [ ] **Step 4.2: Run them to verify they fail.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` and then `npx vitest run --project unit tests/kanban-people-reports.test.ts`. Expected: six FAIL: a card for a run that is over decides the new run, the report beside an agent goes through and runs its gate, a claim records no `assigneeKind`, `service.recordCard` is not a function, and an Unblock for a lifted block, or pointing at no block, goes through; the report with no gate passes. `Tests  6 failed | 1 passed (7)`.

- [ ] **Step 4.3: Implement.**

In `src/db/kanban-read.ts`, replace:

```ts
}

/** The run a gateway session belongs to: at most one, by the unique index on session_id. */
export function runBySession(db: Db, sessionId: string): RunRow | undefined {
```

with:

```ts
}

/**
 * The people's runs whose card is still to be sent (spec §9.2): open, a
 * person's, with neither a `card_sent` nor a `card_failed` event, oldest first.
 */
export function cardsDue(db: Db): RunRow[] {
  return db
    .prepare<[], RunRaw>(
      `SELECT ${RUN_COLS} FROM kanban_runs r
        WHERE r.ended_at IS NULL AND r.assignee_kind = 'human'
          AND NOT EXISTS (
            SELECT 1 FROM kanban_events e
             WHERE e.task_id = r.task_id AND e.run_id = r.run_id AND e.kind IN ('card_sent', 'card_failed'))
        ORDER BY r.started_at, r.rowid`,
    )
    .all()
    .map(decodeRun);
}

/**
 * What a person's card shows of the board (spec §9.2), read for the run it is
 * for: the task, its parents' latest completions as its children are given them
 * (spec §4.4), and for a work run the changes a review asked for, for a review
 * run the handoff under review. Undefined for a run, or a task, not on the board.
 */
export interface CardReading {
  task: TaskRow;
  run: RunRow;
  parents: Array<{ task: TaskRow; summary: string }>;
  changes?: ChangesAsked;
  handoff?: ReviewRequest;
}

export function cardReading(db: Db, runId: string): CardReading | undefined {
  const run = getRun(db, runId);
  const task = run === undefined ? undefined : getTask(db, run.taskId);
  if (run === undefined || task === undefined) return undefined;
  const parents = parentsOf(db, task.taskId).map((p) => ({ task: p, summary: latestCompletion(db, p.taskId)?.summary ?? '' }));
  if (run.kind === 'review') {
    const handoff = latestReviewRequest(db, task.taskId);
    return handoff === undefined ? { task, run, parents } : { task, run, parents, handoff };
  }
  const changes = changesAsked(db, task.taskId);
  return changes === undefined ? { task, run, parents } : { task, run, parents, changes };
}

/** The run a gateway session belongs to: at most one, by the unique index on session_id. */
export function runBySession(db: Db, sessionId: string): RunRow | undefined {
```

In `src/db/kanban.ts`, replace:

```ts
        payload: { kind, attempt, assignee: who.name, workspace, seededFromRun },
```

with:

```ts
        // The kind, so a person's claim can be told as one: the group's one line (spec §9.2).
        payload: { kind, attempt, assignee: who.name, assigneeKind: who.kind, workspace, seededFromRun },
```

In `src/db/kanban.ts`, replace:

```ts
  const open = openRunOf(d, task.taskId);
  if (open === undefined) return { ok: true, run: undefined };
```

with:

```ts
  const open = openRunOf(d, task.taskId);
  // A card is for one run: pressed once that run is over, it does nothing (spec §9.2).
  if (by.runId !== undefined && open?.runId !== by.runId) {
    return refuse('run_superseded', `run ${by.runId} of task ${task.taskId} is over: the task has moved on since this report was made`);
  }
  if (open === undefined) return { ok: true, run: undefined };
```

In `src/db/kanban.ts`, replace:

```ts
    return refuse('no_reviewer', `nobody is named to review task ${taskId}`);
  }
```

with:

```ts
    return refuse('no_reviewer', `nobody is named to review task ${taskId}`);
  }
  // A person's run holds no workspace (spec §6.3), so another task's agent may be
  // changing the checkout the gates would test (spec §7.7). Asked here, before the
  // gates: once they start, no agent is claimed into the workspace until they end.
  const workspace = r.task.workspace;
  if (by.kind === 'person' && workspace !== null && gatesOf(db, taskId).length > 0) {
    const busy = openAgentRunIn(db, workspace);
    if (busy !== undefined) {
      return refuse(
        'workspace_busy',
        `task ${taskId}'s gates run in workspace ${workspace}, where task ${busy.taskId}'s agent run ${busy.runId} is open; ` +
          'report again once it has finished',
      );
    }
  }
```

In `src/db/kanban.ts`, replace:

```ts
  comment: string | undefined,
  now: number,
): Result<{ task: TaskRow }> {
  return tx(db, (d) => {
```

with:

```ts
  comment: string | undefined,
  now: number,
  opts: { blockedAt?: number } = {},
): Result<{ task: TaskRow }> {
  return tx(db, (d) => {
```

In `src/db/kanban.ts`, replace:

```ts
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    if (task.phase !== 'blocked') return refuse('illegal_transition', `task ${taskId} is ${task.phase}, not blocked`);
```

with:

```ts
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    // An Unblock button is for the block its notice told of (spec §9.2): once that
    // has been lifted, the task may be blocked again for another reason.
    if (opts.blockedAt !== undefined) {
      const blocking = d
        .prepare<[string, number], { id: number }>(
          "SELECT id FROM kanban_events WHERE task_id = ? AND id = ? AND kind IN ('blocked', 'stopped', 'run_ended')",
        )
        .get(taskId, opts.blockedAt);
      if (blocking === undefined) return refuse('invalid', `event ${opts.blockedAt} is no block of task ${taskId}`);
      const since = d
        .prepare<[string, number], { id: number }>(
          "SELECT id FROM kanban_events WHERE task_id = ? AND kind = 'unblocked' AND id > ? LIMIT 1",
        )
        .get(taskId, opts.blockedAt);
      if (since !== undefined) {
        return refuse('stale', `the block of task ${taskId} this button was for has been lifted already`);
      }
    }
    if (task.phase !== 'blocked') return refuse('illegal_transition', `task ${taskId} is ${task.phase}, not blocked`);
```

In `src/db/kanban.ts`, replace:

```ts
}

/**
 * Count a prompt sent into an agent run's session (spec §3.3): the task prompt,
```

with:

```ts
}

/** What became of a person's card (spec §9.2): sent, as this message, or refused for good by the channel. */
export type CardOutcome = { messageId: string } | { error: string };

/**
 * Record that a person's run was sent its card, or that the channel refused it
 * (spec §9.2): `card_sent`, or `card_failed`, which its subscribers hear. Once
 * per run, while it is open: a run that has either is not sent another.
 */
export function recordCard(db: Db, runId: string, card: CardOutcome, now: number): Result<{ recorded: boolean }> {
  return tx(db, (d) => {
    const run = getRun(d, runId);
    if (run === undefined) return refuse('not_found', `no run ${runId}`);
    if (run.agentConfig !== null) return refuse('invalid', `run ${runId} is an agent's, and gets no card`);
    if (run.endedAt !== null) return { ok: true, recorded: false };
    const had = d
      .prepare<[string, string], { id: number }>(
        "SELECT id FROM kanban_events WHERE task_id = ? AND run_id = ? AND kind IN ('card_sent', 'card_failed') LIMIT 1",
      )
      .get(run.taskId, runId);
    if (had !== undefined) return { ok: true, recorded: false };
    const base = { kind: run.kind, to: run.assignee.name };
    record(
      d,
      'messageId' in card
        ? { taskId: run.taskId, runId, kind: 'card_sent', actor: 'gateway', payload: { ...base, messageId: card.messageId } }
        : { taskId: run.taskId, runId, kind: 'card_failed', actor: 'gateway', payload: { ...base, error: card.error } },
      now,
    );
    return { ok: true, recorded: true };
  });
}

/**
 * Count a prompt sent into an agent run's session (spec §3.3): the task prompt,
```

In `src/kanban/service.ts`, replace:

```ts
import { boardList, gatesOf, getRun, getTask, runsOf, taskView, type BoardEntry, type TaskView } from '../db/kanban-read.js';
```

with:

```ts
import {
  boardList,
  cardReading,
  gatesOf,
  getRun,
  getTask,
  runsOf,
  taskView,
  type BoardEntry,
  type CardReading,
  type TaskView,
} from '../db/kanban-read.js';
```

In `src/kanban/service.ts`, replace:

```ts
  unblock(taskId: string, by: string, comment?: string): Result<{ task: TaskRow }> {
```

with:

```ts
  /**
   * `blockedAt`: an Unblock button's, the event that blocked the task as its
   * notice told it (spec §9.2); refused once that block has been lifted.
   */
  unblock(taskId: string, by: string, comment?: string, opts: { blockedAt?: number } = {}): Result<{ task: TaskRow }> {
```

In `src/kanban/service.ts`, replace:

```ts
    return board.unblock(this.#db, taskId, by, comment, this.#clock.now());
```

with:

```ts
    if (opts.blockedAt !== undefined && !Number.isSafeInteger(opts.blockedAt)) {
      return board.refuse('invalid', 'a block is an event id, a whole number');
    }
    return board.unblock(this.#db, taskId, by, comment, this.#clock.now(), opts);
  }

  /** What a person's card for this run shows of the board (spec §9.2); undefined for a run not on it. */
  cardReading(runId: string): CardReading | undefined {
    return isText(runId) ? cardReading(this.#db, runId) : undefined;
  }

  /** A person's run was sent its card, or the channel refused it for good (spec §9.2). */
  recordCard(runId: string, card: board.CardOutcome): Result<{ recorded: boolean }> {
    if (!isText(runId)) return board.refuse('invalid', 'a run id is text');
    return board.recordCard(this.#db, runId, card, this.#clock.now());
```

In `src/kanban/types.ts`, replace:

```ts
 * chat (plan D). Who may act is checked by the caller; what the rows allow, here.
 */
```

with:

```ts
 * chat (plan D). Who may act is checked by the caller; what the rows allow, here.
 *
 * A person pressing a card's button reports on the run the card was sent for
 * (spec §9.2): `runId`, re-checked inside the transaction against the task's
 * open run, so a card for a run that is over does nothing.
 */
```

In `src/kanban/types.ts`, replace:

```ts
export type Reporter = { kind: 'run'; runId: string } | { kind: 'person'; principal: string };
```

with:

```ts
export type Reporter = { kind: 'run'; runId: string } | { kind: 'person'; principal: string; runId?: string };
```


- [ ] **Step 4.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/kanban-people-reports.test.ts`. Expected: `Tests  7 passed (7)`.

- [ ] **Step 4.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1257 passed (1257)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  72 passed (72)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 4.6: Commit.**

```bash
git add src/db/kanban-read.ts src/db/kanban.ts src/kanban/service.ts src/kanban/types.ts tests/kanban-people-reports.test.ts
git commit -m "Re-check a card's run inside a person's report, refuse a person's report beside another task's agent where gates would run, record a person's claim and card, and refuse an Unblock for a block already lifted"
```

---

### Task 5: A supervised agent's approvals, forwarded to the chat that follows its task

**Files:**
- Modify: `src/kanban/sink.ts`, `tests/kanban-sink.test.ts`

A kanban run's session posts through the sink, which until now refused an approval card, so the board refused roles whose agent is supervised (spec §7.1, §12; Decision 22). The sink now forwards one to the task's first subscription -- the chat, or thread, the task was created in -- on that subscription's channel, naming the task, and redraws it there once answered. It is answered as any approval card is: at operator tier, through the approval's session, which the router finds by `approvalId`. Only this bot's subscriptions count, as for the notifier; the title is cut on a code point; and a card is forgotten once redrawn, the oldest past a thousand. A task nobody follows has nobody to ask: the send fails, and the actor releases the agent as cancelled.

- [ ] **Step 5.1: Write the failing tests.**

In `tests/kanban-sink.test.ts`, replace:

```ts
import type { BindingKey } from '../src/types.js';
import { FakeDriver } from './helpers/driver.js';
```

with:

```ts
import type { BindingKey } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { FakeDriver } from './helpers/driver.js';
```

In `tests/kanban-sink.test.ts`, replace:

```ts
import { FakeDriver } from './helpers/driver.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';

const NOW = 1_760_000_000_000;
```

with:

```ts
import { FakeDriver } from './helpers/driver.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { newTask } from './helpers/kanban.js';

const NOW = 1_760_000_000_000;
```

In `tests/kanban-sink.test.ts`, replace:

```ts
    expect(JSON.stringify(errors.map((e) => e.payload))).toContain('nothing can reach a person for it');
```

with:

```ts
    expect(JSON.stringify(errors.map((e) => e.payload))).toContain('forwards no approval card to a chat');
```

In `tests/kanban-sink.test.ts`, replace:

```ts
  });
});
```

with:

```ts
  });
});

describe('KanbanSink forwarding approvals (spec §7.1)', () => {
  function actorOn(h: TestDb, taskId: string, sink: KanbanSink, driver: FakeDriver, clock: ManualClock): SessionActor {
    const key: BindingKey = { channel: KANBAN_CHANNEL, appId: 'cli_app', conversationId: taskId, threadId: 'r_1' };
    createSession(h.db, { id: 's_run', agentId: 'watched', workspaceId: 'default', ownerPrincipal: 'kanban' }, NOW);
    bindSession(h.db, key, 's_run', NOW);
    return new SessionActor({
      db: h.db,
      sessionId: 's_run',
      driver,
      channel: sink,
      key,
      target: { chatId: taskId, threadId: 'r_1' },
      cwd: '/tmp/workspace',
      clock,
    });
  }

  it("posts a supervised agent's approval card to the task's first subscription, naming the task, and redraws it there", async () => {
    const h = testDb();
    open.push(h);
    const clock = new ManualClock(NOW);
    // A long title is cut on a code point: an emoji at the cut is dropped whole.
    const task = newTask(h.db, { title: `Rotate the logs ${'x'.repeat(183)}😀😀` });
    const lark = new FakeChannel({ id: 'lark', clock });
    const sink = new KanbanSink(() => clock.now(), { db: h.db, channels: new Map([['lark', lark]]), appId: 'cli_app' });
    const driver = new FakeDriver();
    let answer: unknown;
    driver.scripts.push(async (ctl) => {
      answer = await ctl.ask('delete old.log', [{ optionId: 'allow', name: 'Allow' }]);
      ctl.end('completed');
    });
    const actor = actorOn(h, task.taskId, sink, driver, clock);
    const turn = actor.submit({ messageId: 'kanban:r_1:0', appId: 'cli_app', input: { text: 'go', paths: [] } });
    for (let i = 0; i < 50 && lark.approvalCards.length === 0; i += 1) await new Promise((r) => setImmediate(r));
    expect(lark.approvalCards.map((c) => [c.target, c.spec.action])).toEqual([
      [{ chatId: 'oc_chat', threadId: '' }, `Task ${task.taskId}, Rotate the logs ${'x'.repeat(183)}…, asks: delete old.log`],
    ]);
    const card = lark.approvalCards[0]!;
    const report = actor.resolveFromCard({
      approvalId: card.spec.approvalId,
      optionId: 'allow',
      nonce: card.spec.nonce,
      principal: { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' },
      via: 'lark',
    });
    expect(report.kind).toBe('resolved');
    expect(await turn).toBe('completed');
    expect(answer).toEqual({ kind: 'selected', optionId: 'allow' });
    await actor.close();
    expect(lark.approvalUpdates.map((u) => u.messageId)).toEqual(['om_approval_1']);
    // Redrawn once, then forgotten: the sink holds no card it has no more use for.
    await sink.updateApprovalCard('om_approval_1', { action: 'a', choice: 'b', answeredBy: 'c' });
    expect(lark.approvalUpdates).toHaveLength(1);
    expect(getApproval(h.db, card.spec.approvalId)?.cardMessageId).toBe('om_approval_1');
  });

  it("asks no chat of another bot's, and releases the agent as cancelled", async () => {
    const h = testDb();
    open.push(h);
    const clock = new ManualClock(NOW);
    const task = newTask(h.db, { title: 'Rotate the logs' });
    const lark = new FakeChannel({ id: 'lark', clock });
    const sink = new KanbanSink(() => clock.now(), { db: h.db, channels: new Map([['lark', lark]]), appId: 'cli_other' });
    const driver = new FakeDriver();
    let answer: unknown;
    driver.scripts.push(async (ctl) => {
      answer = await ctl.ask('delete old.log', [{ optionId: 'allow', name: 'Allow' }]);
      ctl.end('completed');
    });
    const actor = actorOn(h, task.taskId, sink, driver, clock);
    await actor.submit({ messageId: 'kanban:r_1:0', appId: 'cli_app', input: { text: 'go', paths: [] } });
    await actor.close();
    expect(answer).toEqual({ kind: 'cancelled' });
    expect(lark.approvalCards).toEqual([]);
  });

  it('releases the agent as cancelled when nobody follows the task', async () => {
    const h = testDb();
    open.push(h);
    const clock = new ManualClock(NOW);
    const lark = new FakeChannel({ id: 'lark', clock });
    const sink = new KanbanSink(() => clock.now(), { db: h.db, channels: new Map([['lark', lark]]), appId: 'cli_app' });
    const driver = new FakeDriver();
    let answer: unknown;
    driver.scripts.push(async (ctl) => {
      answer = await ctl.ask('delete old.log', [{ optionId: 'allow', name: 'Allow' }]);
      ctl.end('completed');
    });
    const actor = actorOn(h, 'k_nobody', sink, driver, clock);
    await actor.submit({ messageId: 'kanban:r_1:0', appId: 'cli_app', input: { text: 'go', paths: [] } });
    await actor.close();
    expect(answer).toEqual({ kind: 'cancelled' });
    expect(lark.approvalCards).toEqual([]);
  });
});
```


- [ ] **Step 5.2: Run them to verify they fail.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` and then `npx vitest run --project unit tests/kanban-sink.test.ts`. Expected: two FAIL: the forwarded card never reaches the chat, and the sink's refusal still says nothing can reach a person; a task nobody follows, and one followed only by another bot's chat, already release their agent as cancelled, and pass. `Tests  2 failed | 4 passed (6)`.

- [ ] **Step 5.3: Implement.**

Replace the whole of `src/kanban/sink.ts` with:

```ts
import { getTask, subscriptionsOf } from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import type {
  ApprovalCardSpec,
  ApprovalOutcomeView,
  CardSession,
  CardView,
  Channel,
  SendResult,
  SendTarget,
} from '../channel/types.js';

/**
 * The channel a kanban run's session posts through (spec §7.1): the `kanban`
 * entry of the registry's channel map, so a run's session never posts to Lark.
 *
 * Card output is discarded: the session log keeps every event, and `/kanban show`
 * reads it there. Nobody is watching a card for a run.
 *
 * An approval card, for a supervised agent, is forwarded to the task's first
 * subscription (spec §7.1): the chat, or thread, the task was created in, where
 * someone follows it. It names the task, and is answered as any approval card
 * is -- at operator tier, resolved through the approval's session, which the
 * router looks up by `approvalId`. A task nobody follows, or one followed on a
 * channel this gateway has not got, cannot have anyone asked: sending fails, and
 * the actor releases the request as cancelled, the honest outcome. Without
 * forwarding -- a sink built without it -- every approval card fails so.
 */
export const KANBAN_CHANNEL = 'kanban';

/** Where a run's approval cards go: its task's first subscription, on that subscription's channel. */
export interface ApprovalForwarding {
  db: Db;
  /** By a subscription's channel id: `lark` to the Lark adapter. */
  channels: ReadonlyMap<string, Channel>;
  /** This bot: only its subscriptions are posted to, as the notifier's are. */
  appId: string;
}

/** A task's title on an approval card, as one line, in characters. */
const TITLE_MAX = 200;
/** Forwarded cards remembered for their redraw; the oldest are forgotten past this. */
const FORWARDED_MAX = 1_000;

/** A title as one line, cut to `TITLE_MAX` characters on a code point, never half an emoji. */
function oneLine(title: string): string {
  const chars = Array.from(title.replace(/\s+/g, ' ').trim());
  return chars.length <= TITLE_MAX ? chars.join('') : `${chars.slice(0, TITLE_MAX - 1).join('')}…`;
}

class DiscardedCard implements CardSession {
  readonly messageId: string;
  readonly createdAt: number;

  constructor(messageId: string, createdAt: number) {
    this.messageId = messageId;
    this.createdAt = createdAt;
  }

  async set(_text: string): Promise<void> {}

  async finish(_text: string): Promise<void> {}
}

export class KanbanSink implements Channel {
  readonly id = KANBAN_CHANNEL;
  readonly #now: () => number;
  readonly #forward: ApprovalForwarding | undefined;
  /** The channel each forwarded approval card went to, by its message, for its redraw. */
  readonly #forwarded = new Map<string, Channel>();

  constructor(now: () => number = Date.now, forward?: ApprovalForwarding) {
    this.#now = now;
    this.#forward = forward;
  }

  async sendText(_target: SendTarget, _text: string, uuid: string): Promise<SendResult> {
    return { messageId: `kanban:${uuid}`, deduped: false };
  }

  async openCard(_target: SendTarget, _initialText: string, uuid: string): Promise<CardSession> {
    return new DiscardedCard(`kanban:${uuid}`, this.#now());
  }

  /** A run's session is bound at (task, run), so the target's chat is the task. */
  async sendApprovalCard(target: SendTarget, spec: ApprovalCardSpec, uuid: string): Promise<SendResult> {
    const taskId = target.chatId;
    const forward = this.#forward;
    if (forward === undefined) {
      throw new Error(`task ${taskId} asked for approval, and this gateway forwards no approval card to a chat`);
    }
    const sub = subscriptionsOf(forward.db, taskId).find((s) => s.appId === forward.appId);
    if (sub === undefined) throw new Error(`task ${taskId} asked for approval, and no chat follows it to be asked`);
    const channel = forward.channels.get(sub.channel);
    if (channel === undefined) {
      throw new Error(`task ${taskId} asked for approval, and the chat that follows it is on channel ${sub.channel}, which this gateway has not got`);
    }
    // Named, so the chat knows which task's agent is asking: the card is rendered as plain text, masked.
    const title = oneLine(getTask(forward.db, taskId)?.title ?? '');
    const named = title === '' ? `Task ${taskId}` : `Task ${taskId}, ${title}`;
    const sent = await channel.sendApprovalCard(
      { chatId: sub.conversationId, threadId: sub.threadId },
      { ...spec, action: `${named}, asks: ${spec.action}` },
      uuid,
    );
    this.#forwarded.set(sent.messageId, channel);
    // Bounded: an approval never answered is never redrawn, and must not be held forever.
    for (const oldest of this.#forwarded.keys()) {
      if (this.#forwarded.size <= FORWARDED_MAX) break;
      this.#forwarded.delete(oldest);
    }
    return sent;
  }

  /**
   * A forwarded card is redrawn where it went, once, and then forgotten; one this
   * process did not forward, or has forgotten, is not its to redraw.
   */
  async updateApprovalCard(messageId: string, view: ApprovalOutcomeView): Promise<void> {
    const channel = this.#forwarded.get(messageId);
    this.#forwarded.delete(messageId);
    await channel?.updateApprovalCard(messageId, view);
  }

  /** A run's session posts no board card; one would be discarded, as its other cards are. */
  async sendCard(_target: SendTarget, _view: CardView, uuid: string): Promise<SendResult> {
    return { messageId: `kanban:${uuid}`, deduped: false };
  }

  async updateCard(_messageId: string, _view: CardView): Promise<void> {}

  async react(_messageId: string, _emoji: string): Promise<void> {}

  async unreact(_messageId: string, _emoji: string): Promise<void> {}
}
```


- [ ] **Step 5.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/kanban-sink.test.ts`. Expected: `Tests  6 passed (6)`.

- [ ] **Step 5.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1260 passed (1260)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  72 passed (72)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 5.6: Commit.**

```bash
git add src/kanban/sink.ts tests/kanban-sink.test.ts
git commit -m "Forward a kanban run's approval cards to the chat that follows its task, naming the task, and redraw them there once answered"
```

---

### Task 6: Parsing a person's reports

**Files:**
- Modify: `src/kanban/chat-parse.ts`, `src/kanban/chat.ts`, `tests/kanban-chat-parse.test.ts`

`/kanban done`, `block`, `review`, `approve` and `changes` parse as themselves, no longer as `later` (spec §9.1; Decision 17): `done` and `approve` with an optional summary or comment, `block` and `changes` with a reason, and `review` with an optional summary and a `reviewer:` line anywhere in it, as on `/kanban new`. `KanbanChat` keeps answering them as arriving in a later update until Task 8 replaces that, so the board stays as it was in between.

- [ ] **Step 6.1: Write the failing tests.**

In `tests/kanban-chat-parse.test.ts`, replace:

```ts
    // A person, whose name may hold a space, is kept whole for the refusal that says it arrives later.
```

with:

```ts
    // A person, whose name may hold a space, is kept whole, to be found among the message's mentions.
```

In `tests/kanban-chat-parse.test.ts`, replace:

```ts
  it("names the people's commands, which arrive in a later update", () => {
    for (const name of ['done', 'block', 'review', 'approve', 'changes']) {
      expect(parseKanban(`${name} k_1 looks good`)).toEqual({ ok: true, command: { verb: 'later', name } });
```

with:

```ts
  it("reads a person's reports on their own task, the summary or the reason as written", () => {
    expect(parseKanban('done k_1 the page is up\nlinks checked')).toEqual({
      ok: true,
      command: { verb: 'done', taskId: 'k_1', text: 'the page is up\nlinks checked' },
    });
    expect(parseKanban('done k_1')).toEqual({ ok: true, command: { verb: 'done', taskId: 'k_1', text: '' } });
    expect(parseKanban('approve k_1')).toEqual({ ok: true, command: { verb: 'approve', taskId: 'k_1', text: '' } });
    expect(parseKanban('block k_1 which wiki?')).toEqual({ ok: true, command: { verb: 'block', taskId: 'k_1', text: 'which wiki?' } });
    expect(parseKanban('changes k_1 cite the sources')).toEqual({
      ok: true,
      command: { verb: 'changes', taskId: 'k_1', text: 'cite the sources' },
    });
    for (const text of ['done', 'approve', 'block k_1', 'changes k_1  ', 'review']) {
      expect(parseKanban(text)).toMatchObject({ ok: false, usage: expect.stringMatching(/^Usage: `\/kanban /) });
```

In `tests/kanban-chat-parse.test.ts`, replace:

```ts
    }
  });
```

with:

```ts
    }
  });

  it("reads a review's reviewer from a reviewer: line, anywhere in it, once", () => {
    expect(parseKanban('review k_1 drafted the notes\nREVIEWER: @Bob Lee\nsee the wiki page')).toEqual({
      ok: true,
      command: { verb: 'review', taskId: 'k_1', summary: 'drafted the notes\nsee the wiki page', reviewer: '@Bob Lee' },
    });
    // A name at the end of the summary is the summary's.
    expect(parseKanban('review k_1 asked the reviewer')).toEqual({
      ok: true,
      command: { verb: 'review', taskId: 'k_1', summary: 'asked the reviewer' },
    });
    expect(parseKanban('review k_1 x\nreviewer:')).toEqual({ ok: false, usage: '`reviewer:` needs a value.' });
    expect(parseKanban('review k_1 x\nreviewer: a\nreviewer: b')).toEqual({ ok: false, usage: '`reviewer:` is given twice.' });
  });
```


- [ ] **Step 6.2: Run them to verify they fail.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` and then `npx vitest run --project unit tests/kanban-chat-parse.test.ts`. Expected: the two new tests FAIL: the people's verbs still parse as `later`, with no text. `Tests  2 failed | 10 passed (12)`.

- [ ] **Step 6.3: Implement.**

In `src/kanban/chat-parse.ts`, replace:

```ts
/** The commands for people's own tasks, which arrive with people in plan D2. */
export const LATER_VERBS = ['done', 'block', 'review', 'approve', 'changes'] as const;
export type LaterVerb = (typeof LATER_VERBS)[number];
```

with:

```ts
/**
 * A person's report on their own task (spec §9.1): `done` and `block` by its
 * assignee, `approve` and `changes` by its reviewer or an operator. The text is
 * the summary, the reason, or an approval's optional comment.
 */
export interface ReportCommand {
  verb: 'done' | 'block' | 'approve' | 'changes';
  taskId: string;
  text: string;
}

/** `/kanban review`: the assignee asks for same-task review (spec §5.3), naming a reviewer on a `reviewer:` line, or not. */
export interface ReviewCommand {
  verb: 'review';
  taskId: string;
  summary: string;
  reviewer?: string;
}
```

In `src/kanban/chat-parse.ts`, replace:

```ts
  | { verb: 'later'; name: LaterVerb };
```

with:

```ts
  | ReportCommand
  | ReviewCommand;
```

In `src/kanban/chat-parse.ts`, replace:

```ts
  assign: '/kanban assign <task> <role>',
```

with:

```ts
  assign: '/kanban assign <task> <role or @person>',
```

In `src/kanban/chat-parse.ts`, replace:

```ts
  'gate remove': '/kanban gate remove <task> <gate>',
} as const;
```

with:

```ts
  'gate remove': '/kanban gate remove <task> <gate>',
  done: '/kanban done <task> [summary]',
  block: '/kanban block <task> <reason>',
  review: '/kanban review <task> [summary], and a line reviewer: <role or @person> unless the task names one',
  approve: '/kanban approve <task> [comment]',
  changes: '/kanban changes <task> <reason>',
} as const;
```

In `src/kanban/chat-parse.ts`, replace:

```ts
/** Zero-width characters at the start of a line, after any indent. */
const LEADING_ZW = new RegExp(`^([ \\t]*)[${ZW}]+`, 'gm');

/**
```

with:

```ts
/** Zero-width characters at the start of a line, after any indent. */
const LEADING_ZW = new RegExp(`^([ \\t]*)[${ZW}]+`, 'gm');

/** `/kanban review`'s reviewer line: its label at the start of a line, in any case, as `/kanban new`'s fields are. */
const REVIEWER_LINE = new RegExp(`^reviewer[ \\t${ZW}]*:[ \\t${ZW}]*(.*)$`, 'i');

/**
```

In `src/kanban/chat-parse.ts`, replace:

```ts
    default: {
      const later = LATER_VERBS.find((v) => v === verb);
      if (later !== undefined) return { ok: true, command: { verb: 'later', name: later } };
```

with:

```ts
    case 'done':
    case 'approve': {
      // A person finishing, or approving, may say nothing more.
      const [taskId, text] = shift(rest);
      if (taskId === '') return usage(verb);
      return { ok: true, command: { verb, taskId, text: text.trim() } };
    }
    case 'block':
    case 'changes': {
      // A block, and changes, need a reason someone can act on.
      const [taskId, text] = shift(rest);
      if (taskId === '' || text.trim() === '') return usage(verb);
      return { ok: true, command: { verb, taskId, text: text.trim() } };
    }
    case 'review':
      return parseReview(rest);
    default:
```

In `src/kanban/chat-parse.ts`, replace:

```ts
      return { ok: false, usage: `Unknown \`/kanban\` command \`${echoed(rawVerb, 80)}\`. \`/kanban help\` lists them.` };
    }
```

with:

```ts
      return { ok: false, usage: `Unknown \`/kanban\` command \`${echoed(rawVerb, 80)}\`. \`/kanban help\` lists them.` };
  }
}

/**
 * `/kanban review <task>`, then the summary; a `reviewer:` line anywhere in it
 * names the reviewer, as on `/kanban new`, since a name at the end of free text
 * could be the summary's last word. Given once, with a value.
 */
function parseReview(text: string): ParsedKanban {
  const [taskId, rest] = shift(text);
  if (taskId === '') return usage('review');
  let reviewer: string | undefined;
  const lines: string[] = [];
  for (const line of rest.split('\n')) {
    const m = REVIEWER_LINE.exec(line);
    if (m === null) {
      lines.push(line);
      continue;
    }
```

In `src/kanban/chat-parse.ts`, replace:

```ts
    }
  }
```

with:

```ts
    }
    const value = (m[1] ?? '').trim();
    if (value === '') return { ok: false, usage: '`reviewer:` needs a value.' };
    if (reviewer !== undefined) return { ok: false, usage: '`reviewer:` is given twice.' };
    reviewer = value;
  }
```

In `src/kanban/chat-parse.ts`, replace:

```ts
    if (reviewer !== undefined) return { ok: false, usage: '`reviewer:` is given twice.' };
    reviewer = value;
  }
}

function parseGate(text: string): ParsedKanban {
```

with:

```ts
    if (reviewer !== undefined) return { ok: false, usage: '`reviewer:` is given twice.' };
    reviewer = value;
  }
  const summary = lines.join('\n').trim();
  return { ok: true, command: { verb: 'review', taskId, summary, ...(reviewer === undefined ? {} : { reviewer }) } };
}

function parseGate(text: string): ParsedKanban {
```

In `src/kanban/chat.ts`, replace:

```ts
import { isPerson, parseKanban, type KanbanCommand, type LaterVerb, type NewTaskCommand } from './chat-parse.js';
```

with:

```ts
import { isPerson, parseKanban, type KanbanCommand, type NewTaskCommand } from './chat-parse.js';
```

In `src/kanban/chat.ts`, replace:

```ts
  later: 'talk',
```

with:

```ts
  done: 'talk',
  block: 'talk',
  review: 'talk',
  approve: 'talk',
  changes: 'talk',
```

In `src/kanban/chat.ts`, replace:

```ts
function later(name: LaterVerb): string {
```

with:

```ts
function later(name: 'done' | 'block' | 'review' | 'approve' | 'changes'): string {
```

In `src/kanban/chat.ts`, replace:

```ts
      case 'later':
        return later(command.name);
```

with:

```ts
      case 'done':
      case 'block':
      case 'review':
      case 'approve':
      case 'changes':
        return later(command.verb);
```


- [ ] **Step 6.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/kanban-chat-parse.test.ts`. Expected: `Tests  12 passed (12)`.

- [ ] **Step 6.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1261 passed (1261)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  72 passed (72)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 6.6: Commit.**

```bash
git add src/kanban/chat-parse.ts src/kanban/chat.ts tests/kanban-chat-parse.test.ts
git commit -m "Parse /kanban done, block, review, approve and changes as a person's reports, with the reviewer on a line of its own"
```

---

### Task 7: What a person sees: help, notices and cards

**Files:**
- Modify: `src/core/ids.ts`, `src/kanban/chat-render.ts`, `tests/ids.test.ts`, `tests/kanban-chat-render.test.ts`

The words and cards for people, pure given the secret set (spec §9.2, §9.3; Decisions 10, 12, 13, 25). The help lists the people's commands with who may run them. A person's claim is a notice -- the one line "📋 *title* — assigned to *name*", or "review assigned to", the name in plain text, never a mention -- and so is a card Lark refused, with the typed commands to use instead. A task card has the title, body, contract and the parents' summaries, a box, and Done and Block; a review card the handoff, what to review when a commit was recorded, and Approve and Request changes; a card acted on is redrawn with what happened and no buttons. Each button's value carries a nonce bound to the task and the run, and an Unblock's to the event that blocked the task, from `core/ids.ts`, which also gives a run's card its one uuid.

- [ ] **Step 7.1: Write the failing tests.**

In `tests/ids.test.ts`, replace:

```ts
  approvalNonce,
  newApprovalId,
```

with:

```ts
  approvalNonce,
  boardCardNonce,
  boardCardUuid,
  newApprovalId,
```

In `tests/ids.test.ts`, replace:

```ts
    expect(turnIdempotencyKey('cli_a', 'om_1')).not.toBe(replyUuid('cli_a', 'om_1', 'turn'));
  });
});
```

with:

```ts
    expect(turnIdempotencyKey('cli_a', 'om_1')).not.toBe(replyUuid('cli_a', 'om_1', 'turn'));
  });
});

describe("a person's card", () => {
  it('has one uuid per run, and a nonce bound to the task and the run, not to the boot', () => {
    expect(boardCardUuid('cli_app', 'r_1')).toBe(boardCardUuid('cli_app', 'r_1'));
    expect(boardCardUuid('cli_app', 'r_1')).toHaveLength(50);
    expect(boardCardUuid('cli_app', 'r_2')).not.toBe(boardCardUuid('cli_app', 'r_1'));
    const n = boardCardNonce('cli_app', 'k_1', 'r_1');
    expect(n).toHaveLength(32);
    expect(new Set([n, boardCardNonce('cli_app', 'k_2', 'r_1'), boardCardNonce('cli_app', 'k_1', 'r_2'), boardCardNonce('cli_x', 'k_1', 'r_1')]).size).toBe(4);
  });
});
```

In `tests/kanban-chat-render.test.ts`, replace:

```ts
import { renderGates, renderHelp, renderList, renderNotice, renderShow } from '../src/kanban/chat-render.js';
```

with:

```ts
import { boardCardNonce } from '../src/core/ids.js';
import {
  blocksTask,
  renderCardOutcome,
  renderGates,
  renderHelp,
  renderList,
  renderNotice,
  renderReviewCard,
  renderShow,
  renderTaskCard,
  unblockButton,
} from '../src/kanban/chat-render.js';
```

In `tests/kanban-chat-render.test.ts`, replace:

```ts
  it('lists every command with the tier it needs, and says people arrive in a later update', () => {
```

with:

```ts
  it('lists every command with who may run it, people as assignees and reviewers among them', () => {
```

In `tests/kanban-chat-render.test.ts`, replace:

```ts
    expect(help).toContain('arrives in a later update');
```

with:

```ts
    expect(help).toContain("`/kanban done <task> [summary]` (the task's assignee)");
    expect(help).toContain('`/kanban changes <task> <reason>` (its reviewer, or an operator)');
    expect(help).toContain('Name a person with an @-mention');
    expect(help).not.toContain('later update');
```

In `tests/kanban-chat-render.test.ts`, replace:

```ts
    for (const kind of ['created', 'claimed', 'commented', 'linked', 'gates_ran', 'archived', 'changes_requested']) {
```

with:

```ts
    for (const kind of ['created', 'claimed', 'commented', 'linked', 'gates_ran', 'archived', 'changes_requested', 'card_sent']) {
```

In `tests/kanban-chat-render.test.ts`, replace:

```ts
  });

  it('masks a secret in what it tells', () => {
    addSecrets(['sk-said-12345678']);
```

with:

```ts
  });

  it("tells who a person's claim gave the task to, by name, in plain text, and nothing of a role's", () => {
    const k = newTask(h.db, { title: `Check the links ${SPOOF}`, assignee: { kind: 'human', name: ALICE } });
    claimed(h.db, k.taskId);
    const nameOf = (p: string) => (p === ALICE ? 'Alice <at id=all></at>' : undefined);
    expect(renderNotice(last(k.taskId), task(k.taskId), { ...LIMIT, nameOf })).toBe(
      `📋 **Check the links hi \\<at id=all\\>\\</at\\> team** \`${k.taskId}\` — assigned to Alice \\<at id=all\\>\\</at\\>`,
    );
    // Without a name known, the principal.
    expect(renderNotice(last(k.taskId), task(k.taskId), LIMIT)).toMatch(/— assigned to lark:on\\_alice$/);
    const review = { ...last(k.taskId), payload: { kind: 'review', assignee: ALICE, assigneeKind: 'human' } };
    expect(renderNotice(review, task(k.taskId), { ...LIMIT, nameOf })).toMatch(/— review assigned to Alice /);
    const role = newTask(h.db);
    claimed(h.db, role.taskId);
    expect(renderNotice(last(role.taskId), task(role.taskId), { ...LIMIT, nameOf })).toBeUndefined();
    const asked = { ...last(k.taskId), kind: 'review_requested', payload: { summary: 'v1', reviewer: ALICE, reviewerKind: 'human' } };
    expect(renderNotice(asked, task(k.taskId), { ...LIMIT, nameOf: () => 'Alice' })).toMatch(/, from Alice\.$/);
  });

  it("tells of a card that could not be sent, and how its person can answer without it", () => {
    const k = newTask(h.db, { title: 'Survey' });
    const event = (payload: unknown): KanbanEvent => ({ ...last(k.taskId), kind: 'card_failed', payload });
    expect(renderNotice(event({ kind: 'work', to: ALICE, error: 'the user is not in the app' }), task(k.taskId), { ...LIMIT, nameOf: () => 'Alice' })).toBe(
      `Could not send Alice the card for **Survey** \`${k.taskId}\`: the user is not in the app\n` +
        `They can answer from any chat with the bot: \`/kanban done ${k.taskId} [summary]\` or \`/kanban block ${k.taskId} <reason>\`.`,
    );
    expect(renderNotice(event({ kind: 'review', to: ALICE, error: 'x' }), task(k.taskId), LIMIT)).toContain(`\`/kanban approve ${k.taskId}\``);
  });

  it('knows which events left the task blocked, for the Unblock under their notice', () => {
    const k = newTask(h.db);
    const event = (kind: string, payload: unknown): KanbanEvent => ({ ...last(k.taskId), kind, payload });
    expect(blocksTask(event('blocked', { kind: 'needs_input', reason: 'x' }))).toBe(true);
    expect(blocksTask(event('blocked', { kind: 'dependency', reason: 'x' }))).toBe(false);
    expect(blocksTask(event('stopped', {}))).toBe(true);
    expect(blocksTask(event('run_ended', { next: 'blocked' }))).toBe(true);
    expect(blocksTask(event('run_ended', { next: 'retry' }))).toBe(false);
    expect(blocksTask(event('completed', {}))).toBe(false);
    const b = event('blocked', { kind: 'needs_input', reason: 'x' });
    expect(unblockButton('cli_app', b)).toEqual({
      label: `Unblock ${k.taskId}`,
      style: 'primary',
      value: { kind: 'kanban', act: 'unblock', task: k.taskId, event: String(b.id), nonce: boardCardNonce('cli_app', k.taskId, `event:${b.id}`) },
    });
  });

  it('masks a secret in what it tells', () => {
    addSecrets(['sk-said-12345678']);
```

In `tests/kanban-chat-render.test.ts`, replace:

```ts
    expect(renderNotice(event, created.task, LIMIT)).toContain(`key ${MASK} refused`);
  });
});
```

with:

```ts
    expect(renderNotice(event, created.task, LIMIT)).toContain(`key ${MASK} refused`);
  });
});

describe("a person's cards", () => {
  it('shows a task card its title, body, contract and parents, escaped and masked, with Done and Block for its run', () => {
    addSecrets(['sk-card-12345678']);
    const parent = newTask(h.db, { title: 'Collect the numbers' });
    const prun = claimed(h.db, parent.taskId);
    expect(complete(h.db, parent.taskId, { kind: 'run', runId: prun.runId }, { summary: 'in sheet Q3' }, NOW).ok).toBe(true);
    const k = newTask(h.db, {
      title: `Write them up ${SPOOF}`,
      body: 'Use the sk-card-12345678 key\n# not a heading',
      contract: { outcome: 'a page' },
      assignee: { kind: 'human', name: ALICE },
      parents: [parent.taskId],
    });
    const run = claimed(h.db, k.taskId);
    const view = renderTaskCard({ task: task(k.taskId), run, parents: [{ task: task(parent.taskId), summary: 'in sheet Q3' }] }, 'cli_app');
    expect(view.markdown).toContain(`📋 **Write them up hi \\<at id=all\\>\\</at\\> team** \`${k.taskId}\` — for you to do`);
    expect(view.markdown).toContain(`> Use the ${MASK} key\n> # not a heading`);
    expect(view.markdown).toContain('outcome: a page');
    expect(view.markdown).toContain(`\`${parent.taskId}\` **Collect the numbers**:\n> in sheet Q3`);
    expect(view.markdown).toContain(`\`/kanban done ${k.taskId} [summary]\``);
    expect(view.input).toEqual({ placeholder: 'A summary, or why it is blocked' });
    const nonce = boardCardNonce('cli_app', k.taskId, run.runId);
    expect(view.buttons).toEqual([
      { label: 'Done', style: 'primary', value: { kind: 'kanban', act: 'done', task: k.taskId, run: run.runId, nonce } },
      { label: 'Block', style: 'danger', value: { kind: 'kanban', act: 'block', task: k.taskId, run: run.runId, nonce } },
    ]);
    const rework = renderTaskCard({ task: task(k.taskId), run, parents: [], changes: { reason: 'cite it', actor: 'lark:on_bob' }, nameOf: () => 'Bob' }, 'cli_app');
    expect(rework.markdown).toContain('**Changes asked** by Bob:\n> cite it');
  });

  it('shows a review card the handoff and the commit to review, when one was recorded, with Approve and Request changes', () => {
    const k = newTask(h.db, { title: 'Fix the footer', reviewer: { kind: 'human', name: ALICE } });
    const run = claimed(h.db, k.taskId);
    const handoff = { runId: 'r_work', actor: 'run:r_work', summary: 'moved it', metadata: null, reportedCommit: 'abc1234', reportedDirty: false };
    const view = renderReviewCard({ task: task(k.taskId), run, parents: [], handoff }, 'cli_app');
    expect(view.markdown).toContain(`🔎 **Fix the footer** \`${k.taskId}\` — for you to review`);
    expect(view.markdown).toContain('**The handoff**, from its agent:\n> moved it');
    expect(view.markdown).toContain('To review: review commit abc1234.');
    expect(view.buttons.map((b) => [b.label, b.value['act']])).toEqual([
      ['Approve', 'approve'],
      ['Request changes', 'changes'],
    ]);
    // Any work, not only code: no commit recorded, no line for one.
    const doc = renderReviewCard(
      { task: task(k.taskId), run, parents: [], handoff: { ...handoff, runId: null, actor: 'lark:on_bob', reportedCommit: null, reportedDirty: null } },
      'cli_app',
    );
    expect(doc.markdown).not.toContain('To review:');
    expect(doc.markdown).toContain('from lark:on\\_bob');
  });

  it('redraws a card acted on with what happened, and no buttons', () => {
    expect(renderCardOutcome({ taskId: 'k_1', title: `x ${SPOOF}` }, 'Done — by Alice.')).toEqual({
      markdown: '**x hi \\<at id=all\\>\\</at\\> team** `k_1`\nDone — by Alice.',
      buttons: [],
    });
  });
});
```


- [ ] **Step 7.2: Run them to verify they fail.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` and then `npx vitest run --project unit tests/kanban-chat-render.test.ts tests/ids.test.ts`. Expected: eight FAIL: the help still says people arrive in a later update, a person's claim and a refused card are no notice, and `blocksTask`, the card renderers and `boardCardUuid` are not functions. `Tests  8 failed | 31 passed (39)`.

- [ ] **Step 7.3: Implement.**

In `src/core/ids.ts`, replace:

```ts
/**
 * The opaque value carried in a card button's `action.value`.
```

with:

```ts
/**
 * The `uuid` of a person's card for a run (spec §9.2): the same however often it
 * is sent, so a card sent again after a restart, before it was recorded, is one
 * message.
 */
export function boardCardUuid(appId: string, runId: string): string {
  const canonical = [appId, 'kanban-card', runId].join(SEP);
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 50);
}

/**
 * The nonce on a board card's buttons (spec §9.2): bound to the task, and to what
 * the card is for -- a run, or for an Unblock, the event that blocked the task --
 * so a button whose fields were mixed or mangled is refused before anything is
 * read.
 *
 * It is not a secret, and cannot be: an unkeyed hash of ids anyone who sees the
 * card can read, which anyone can recompute. What protects a press is who made
 * it -- the callback's operator, checked against the tiers and the task -- and
 * the board's re-check of the run, or the block, inside its transaction. Not
 * bound to the boot, unlike an approval's: a person's run parks across restarts
 * (spec §4.2), and its card must still work after one.
 */
export function boardCardNonce(appId: string, taskId: string, ref: string): string {
  const canonical = [appId, 'kanban-card', taskId, ref].join(SEP);
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}

/**
 * The opaque value carried in a card button's `action.value`.
```

In `src/kanban/chat-render.ts`, replace:

```ts
import type { BoardEntry, TaskView } from '../db/kanban-read.js';
```

with:

```ts
import type { CardButton, CardView } from '../channel/types.js';
import { boardCardNonce } from '../core/ids.js';
import type { BoardEntry, ReviewRequest, TaskView } from '../db/kanban-read.js';
```

In `src/kanban/chat-render.ts`, replace:

```ts
import { LIST_FILTERS, USAGE } from './chat-parse.js';
import type { DisplayStatus } from './status.js';
```

with:

```ts
import { LIST_FILTERS, USAGE } from './chat-parse.js';
import { describeReported } from './commit.js';
import type { DisplayStatus } from './status.js';
```

In `src/kanban/chat-render.ts`, replace:

```ts
  const talk = 'anyone allowed';
  const lines: Array<[string, string]> = [
```

with:

```ts
  const talk = 'anyone allowed';
  const assignee = "the task's assignee";
  const reviewer = 'its reviewer, or an operator';
  const lines: Array<[string, string]> = [
```

In `src/kanban/chat-render.ts`, replace:

```ts
    [USAGE['gate remove'], operate],
  ];
```

with:

```ts
    [USAGE['gate remove'], operate],
    [USAGE.done, assignee],
    [USAGE.block, assignee],
    [USAGE.review, assignee],
    [USAGE.approve, reviewer],
    [USAGE.changes, reviewer],
  ];
```

In `src/kanban/chat-render.ts`, replace:

```ts
    '**The task board.** A task is any work -- research, a document, an operation in Lark, a chore, a change to code -- given to a role, whose agent runs it in a workspace.',
```

with:

```ts
    '**The task board.** A task is any work -- research, a document, an operation in Lark, a chore, a change to code -- given to a role, whose agent runs it in a workspace, or to a person.',
```

In `src/kanban/chat-render.ts`, replace:

```ts
    'Assignees and reviewers are roles for now: naming a person, with an @-mention, arrives in a later update, with `/kanban done`, `block`, `review`, `approve` and `changes`.',
    'The chat a task is created in hears when it is done, needs review, blocks, is retried after a failure, gives up, or is stranded.',
```

with:

```ts
    'Name a person with an @-mention: they are sent the task as a card in a direct message, with Done and Block, or a review with Approve and Request changes. A person named may comment on, and report on, their own task.',
    'The chat a task is created in hears when it is done, needs review, blocks, is retried after a failure, gives up, or is stranded, and who a person was given it.',
```

In `src/kanban/chat-render.ts`, replace:

```ts
}

/**
 * The notice a subscription hears of one event (spec §9.4), or undefined when
```

with:

```ts
}

/** Who a principal is, by name, where the gateway knows one: what a notice or a card calls a person. */
export type NameOf = (principal: string) => string | undefined;

/** A person, by the name Lark gave, else their principal; a role, as a role. */
function whom(a: Assignee | null, nameOf: NameOf | undefined): string {
  if (a?.kind !== 'human') return who(a);
  return label(nameOf?.(a.name) ?? a.name, 80);
}

function payloadOf(event: KanbanEvent): Record<string, unknown> {
  return (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
}

/**
 * Whether the event left the task blocked, so that its notice offers Unblock
 * (spec §9.2): a block of any kind but dependency, a stop, or a run whose end
 * blocked the task.
 */
export function blocksTask(event: KanbanEvent): boolean {
  const p = payloadOf(event);
  if (event.kind === 'blocked') return text(p, 'kind') !== '' && text(p, 'kind') !== 'dependency';
  if (event.kind === 'stopped') return true;
  return event.kind === 'run_ended' && p['next'] === 'blocked';
}

/**
 * The notice a subscription hears of one event (spec §9.4), or undefined when
```

In `src/kanban/chat-render.ts`, replace:

```ts
 * clears by itself, and blocks as transient at its limit, which is one.
```

with:

```ts
 * clears by itself, and blocks as transient at its limit, which is one. From plan
 * D2: the one line that says who a person's claim gave the task to (spec §9.2),
 * named in plain text, never mentioned, and a card that could not be sent.
```

In `src/kanban/chat-render.ts`, replace:

```ts
export function renderNotice(event: KanbanEvent, task: TaskRow, opts: { blockRecurrenceLimit: number }): string | undefined {
  const p = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
```

with:

```ts
export function renderNotice(
  event: KanbanEvent,
  task: TaskRow,
  opts: { blockRecurrenceLimit: number; nameOf?: NameOf },
): string | undefined {
  const p = payloadOf(event);
```

In `src/kanban/chat-render.ts`, replace:

```ts
      return `Review requested — ${name}, from ${who(reviewer === '' ? null : { kind, name: reviewer })}.`;
```

with:

```ts
      return `Review requested — ${name}, from ${whom(reviewer === '' ? null : { kind, name: reviewer }, opts.nameOf)}.`;
    }
    case 'claimed': {
      // A role's claim is no notice: its outcome is. A person's is the group's one line.
      if (p['assigneeKind'] !== 'human') return undefined;
      const person = whom({ kind: 'human', name: text(p, 'assignee') }, opts.nameOf);
      return `📋 ${name} — ${p['kind'] === 'review' ? 'review ' : ''}assigned to ${person}`;
    }
    case 'card_failed': {
      const person = whom({ kind: 'human', name: text(p, 'to') }, opts.nameOf);
      const how =
        p['kind'] === 'review'
          ? `\`/kanban approve ${task.taskId}\` or \`/kanban changes ${task.taskId} <reason>\``
          : `\`/kanban done ${task.taskId} [summary]\` or \`/kanban block ${task.taskId} <reason>\``;
      return (
        `Could not send ${person} the card for ${name}: ${label(text(p, 'error'), 300)}\n` +
        `They can answer from any chat with the bot: ${how}.`
      );
```

In `src/kanban/chat-render.ts`, replace:

```ts
  }
}
```

with:

```ts
  }
}

// ---------------------------------------------------------------------------
// A person's cards (spec §9.2)
// ---------------------------------------------------------------------------

/** What a person's card shows, as read from the board when it is sent. */
export interface CardFacts {
  task: TaskRow;
  /** The person's run the card is for: its buttons report on it, and on nothing later. */
  run: RunRow;
  /** Each parent's latest completion, as its children are given it (spec §4.4). */
  parents: ReadonlyArray<{ task: TaskRow; summary: string }>;
  /** For a work run after a review asked for changes: what was asked, and by whom (spec §5.3). */
  changes?: { reason: string; actor: string };
  /** For a review run: the handoff under review, with what its report recorded of the workspace (spec §7.8). */
  handoff?: ReviewRequest;
  nameOf?: NameOf;
}

/** The buttons' value: a pointer, with the nonce that binds it to the task and the run (spec §9.2). */
function act(appId: string, run: RunRow, name: string): Readonly<Record<string, string>> {
  return { kind: 'kanban', act: name, task: run.taskId, run: run.runId, nonce: boardCardNonce(appId, run.taskId, run.runId) };
}

/** The task's own text, as a card shows it: the body, then the contract. */
function taskText(task: TaskRow, bodyMax: number): string[] {
  const out: string[] = [];
  if (task.body.trim() !== '') out.push(block(task.body, bodyMax));
  const contract = Object.entries(task.contract).filter(([, v]) => v !== undefined && v.trim() !== '');
  if (contract.length > 0) {
    out.push('**Contract**');
    for (const [field, value] of contract) out.push(`${forDisplay(field)}: ${label(value ?? '', 400)}`);
  }
  return out;
}

/**
 * A task card, sent to its assignee when it becomes ready (spec §9.2): the title,
 * the body, the contract, the parents' summaries, and Done and Block, which
 * submit what was typed in the box -- the summary, or the reason.
 */
export function renderTaskCard(f: CardFacts, appId: string): CardView {
  const { task, run } = f;
  const out = [`📋 **${label(task.title)}** ${id(task.taskId)} — for you to do`];
  if (f.changes !== undefined) {
    out.push(`**Changes asked** by ${label(f.nameOf?.(f.changes.actor) ?? f.changes.actor, 80)}:`, block(f.changes.reason, 1200));
  }
  out.push(...taskText(task, 1500));
  const parents = f.parents.slice(0, 5);
  if (parents.length > 0) {
    out.push('**From its parents**');
    for (const p of parents) {
      out.push(`${id(p.task.taskId)} **${label(p.task.title, 120)}**:`, block(p.summary === '' ? '(no summary)' : p.summary, 600));
    }
    if (f.parents.length > parents.length) out.push(`… and ${f.parents.length - parents.length} more: \`/kanban show ${task.taskId}\``);
  }
  out.push(
    `Type a summary and press **Done**, or why it is blocked and press **Block**. ` +
      `In any chat with the bot, \`/kanban done ${task.taskId} [summary]\` and \`/kanban block ${task.taskId} <reason>\` do the same.`,
  );
  const buttons: CardButton[] = [
    { label: 'Done', style: 'primary', value: act(appId, run, 'done') },
    { label: 'Block', style: 'danger', value: act(appId, run, 'block') },
  ];
  return { markdown: out.join('\n'), input: { placeholder: 'A summary, or why it is blocked' }, buttons };
}

/**
 * A review card, sent to its reviewer (spec §9.2): the handoff, what to review --
 * the reported commit, when one was recorded (spec §7.8) -- the task, and Approve
 * and Request changes, which submits the reason typed in the box.
 */
export function renderReviewCard(f: CardFacts, appId: string): CardView {
  const { task, run } = f;
  const out = [`🔎 **${label(task.title)}** ${id(task.taskId)} — for you to review`];
  const h = f.handoff;
  if (h !== undefined) {
    // A run's report is its agent's; a person's, by name.
    const by = h.actor.startsWith('run:') ? 'its agent' : label(f.nameOf?.(h.actor) ?? h.actor, 80);
    out.push(`**The handoff**, from ${by}:`, block(h.summary === '' ? '(no summary)' : h.summary, 1500));
    const state = describeReported(h);
    if (state !== undefined) out.push(`To review: ${forDisplay(state)}.`);
  }
  out.push(...taskText(task, 1200));
  out.push(
    `Press **Approve**, or type what needs changing and press **Request changes**. ` +
      `In any chat with the bot, \`/kanban approve ${task.taskId}\` and \`/kanban changes ${task.taskId} <reason>\` do the same.`,
  );
  const buttons: CardButton[] = [
    { label: 'Approve', style: 'primary', value: act(appId, run, 'approve') },
    { label: 'Request changes', style: 'danger', value: act(appId, run, 'changes') },
  ];
  return { markdown: out.join('\n'), input: { placeholder: 'What needs changing' }, buttons };
}

/**
 * A card once acted on, or found out of date (spec §9.2): its title and what
 * happened, with no buttons left to press.
 */
export function renderCardOutcome(task: { taskId: string; title: string }, outcome: string): CardView {
  return { markdown: `**${label(task.title)}** ${id(task.taskId)}\n${outcome}`, buttons: [] };
}

/** An Unblock under a notice of a block (spec §9.2), bound to the task and the event that blocked it. */
export function unblockButton(appId: string, event: KanbanEvent): CardButton {
  const ref = `event:${event.id}`;
  return {
    label: `Unblock ${event.taskId}`,
    style: 'primary',
    value: { kind: 'kanban', act: 'unblock', task: event.taskId, event: String(event.id), nonce: boardCardNonce(appId, event.taskId, ref) },
  };
}
```


- [ ] **Step 7.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/kanban-chat-render.test.ts tests/ids.test.ts`. Expected: `Tests  39 passed (39)`.

- [ ] **Step 7.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1268 passed (1268)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  72 passed (72)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 7.6: Commit.**

```bash
git add src/core/ids.ts src/kanban/chat-render.ts tests/ids.test.ts tests/kanban-chat-render.test.ts
git commit -m "Render the one line that says who a person's claim gave a task to, a card Lark refused, and a person's task, review and Unblock cards, with nonces bound to the task and the run"
```

---

### Task 8: People in /kanban, and the buttons of their cards

**Files:**
- Modify: `src/index.ts`, `src/kanban/chat-render.ts`, `src/kanban/chat.ts`, `tests/kanban-chat.e2e.ts`, `tests/kanban-chat.test.ts`

`KanbanChat` gives work to people and takes their reports (spec §9.1, §9.2, §4.2, §7.5; Decisions 8, 9, 13, 14, 15, 18, 23, 24, 27). Each sender and each person a command mentions is noted in the people directory first. An @-mention becomes the mentioned person's principal, by the name Lark's text shows; a person without talk tier is refused, by the name typed. A named assignee reports `done`, `block` and `review` on their own task while it is open, a named reviewer answers with `approve` or `changes` while it is in review, with talk tier, and an operator may answer any review. Their comments steer, as an operator's do. A gate's refusal is shown with its output, masked and escaped. A role whose agent is supervised is accepted. And `card()` takes a press of a card's button: the nonce checked, the presser from the callback's operator, the report made on the card's run, and the card redrawn when it was acted on or is out of date. The gateway passes the people directory and the card redraw now; the service gets people in Task 12.

Two things Lark and its SDK force (Decisions 13, 28, 29). Lark waits about three seconds for a callback's answer, and the SDK answers only once the handler returns, so a press is answered at once: the card is redrawn as being worked on, the report made in the background, tracked by `idle()`, and the card redrawn with the outcome. And the SDK drops a press it has seen -- the card, the presser and the button's value -- for twelve hours, whatever the box held, so a press refused for what it carried is redrawn live, saying why, with buttons named for, and valued with, the next attempt. A second press of a card while one is worked on is refused without a redraw, and a refused report whose run ended meanwhile redraws the card as out of date. And `stop()` aborts the gates of every report from chat, a press's or typed, so the gateway's stop kills them and applies nothing, as the worker socket's are. A typed report is made on the task's open run as it was checked, so a reassignment while its gates run refuses it rather than let it decide someone else's.

- [ ] **Step 8.1: Write the failing tests.**

In `tests/kanban-chat.e2e.ts`, replace:

```ts
import { Notifier } from '../src/kanban/notices.js';
import { KanbanService } from '../src/kanban/service.js';
```

with:

```ts
import { Notifier } from '../src/kanban/notices.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
```

In `tests/kanban-chat.e2e.ts`, replace:

```ts
      hasTier: (principal, tier) => authorizer.hasTier(principal, tier),
      changed: () => d.pass(),
```

with:

```ts
      hasTier: (principal, tier) => authorizer.hasTier(principal, tier),
      people: new PeopleDirectory({
        db: t.db,
        appId: 'cli_app',
        canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }),
      }),
      appId: 'cli_app',
      changed: () => d.pass(),
```

Replace the whole of `tests/kanban-chat.test.ts` with:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CardView } from '../src/channel/types.js';
import type { InboundCardAction } from '../src/core/router.js';
import { commentsOf, eventsOf, gatesOf, getRun, getTask, subscriptionsOf } from '../src/db/kanban-read.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { renderTaskCard } from '../src/kanban/chat-render.js';
import type { GateExit } from '../src/kanban/gates.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import type { RunRow } from '../src/kanban/types.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import type { BindingKey, InboundMention, InboundMessage, Principal } from '../src/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES, role } from './helpers/dispatch.js';
import { WORKSPACES } from './helpers/kanban.js';

/**
 * /kanban in chat (spec §9.1): tiers, the identity the board records, people
 * named by @-mention, their own reports and the buttons of their cards, and
 * every change done through the service, with the dispatcher told.
 */

const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const GUEST: Principal = { openId: 'ou_guest', unionId: 'on_guest', displayName: 'Guest' };
const ALICE: Principal = { openId: 'ou_alice', unionId: 'on_alice', displayName: 'Alice Smith' };
const BOB: Principal = { openId: 'ou_bob', unionId: 'on_bob', displayName: 'Bob' };
const NAMELESS: Principal = { openId: 'ou_owner', unionId: null, displayName: 'Owner' };
const KEY: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' };

/** As Lark sends a mention of each: its key, the name the text shows, and the ids. */
const AT_ALICE: InboundMention = { key: '@_user_1', name: 'Alice Smith', openId: 'ou_alice', unionId: 'on_alice' };
const AT_BOB: InboundMention = { key: '@_user_2', name: 'Bob', openId: 'ou_bob', unionId: 'on_bob' };
/** Someone the bot answers nobody for: no talk tier. */
const AT_CAROL: InboundMention = { key: '@_user_3', name: 'Carol', openId: 'ou_carol', unionId: 'on_carol' };

let t: TestDb;
let service: KanbanService;
let chat: KanbanChat;
let passes: number;
let cancelled: string[];
let redrawn: Array<{ messageId: string; view: CardView }>;
/** How the next gate exits, by command: a command missing exits 0. */
let exits: Map<string, Partial<GateExit>>;
/** Gates held until the test lets them go, by command. */
let holds: Map<string, Promise<void>>;
let seq = 0;

beforeEach(() => {
  clearSecrets();
  t = testDb();
  const authorizer = new Authorizer({
    ...defaultAuthConfig(OWNER.openId),
    allowTalk: [OWNER.openId, GUEST.openId, ALICE.openId, BOB.openId],
  });
  const people = new PeopleDirectory({
    db: t.db,
    appId: 'cli_app',
    canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }),
  });
  exits = new Map();
  holds = new Map();
  service = new KanbanService({
    db: t.db,
    roles: new Map(
      [...DEFAULT_ROLES, role('default'), role('watched', { agent: { ...DEFAULT_ROLES[0]!.agent, unsupervised: false } })].map(
        (r) => [r.name, r],
      ),
    ),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
    people,
    supervisedRoles: true,
    checks: {
      workspaceDirs: new Map([...WORKSPACES].map((w) => [w, `/ws/${w}`])),
      env: {},
      runGate: async (command, opts) => {
        // A held gate ends when the test lets it go, or when the gateway stops, as a killed one does.
        const stopped = new Promise<'stopped'>((resolve) => opts.signal?.addEventListener('abort', () => resolve('stopped')));
        if ((await Promise.race([holds.get(command), stopped])) === 'stopped') {
          return { exitCode: null, signal: 'SIGTERM', timedOut: false, output: '' };
        }
        return { exitCode: 0, signal: null, timedOut: false, output: '', ...exits.get(command) };
      },
    },
  });
  passes = 0;
  cancelled = [];
  redrawn = [];
  chat = new KanbanChat({
    service,
    hasTier: (p, tier) => authorizer.hasTier(p, tier),
    people,
    appId: 'cli_app',
    redraw: async (messageId, view) => {
      redrawn.push({ messageId, view });
    },
    changed: () => (passes += 1),
    cancel: (runId) => cancelled.push(runId),
  });
});
afterEach(() => {
  clearSecrets();
  t.close();
});

function message(sender: Principal = OWNER, messageId = `om_${++seq}`, mentions: InboundMention[] = []): InboundMessage {
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
    mentions,
    attachments: [],
    createTime: 0,
  };
}

function say(arg: string, sender: Principal = OWNER, mentions: InboundMention[] = []): Promise<string> {
  return chat.run(arg, message(sender, undefined, mentions), KEY);
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

  it('refuses an unknown role or workspace, and an oversized task, creating nothing', async () => {
    expect(await say('new t\nassignee: nobody-here')).toBe('Not done: role "nobody-here" is not configured');
    expect(await say('new t\nassignee: implementer\nworkspace: nowhere')).toBe(
      'Not done: workspace "nowhere" is not configured',
    );
    expect(await say(`new ${'t'.repeat(513)}`)).toBe('A title is at most 512 bytes; put the rest in the body.');
    expect(await say('new t\noutcome: ' + 'x'.repeat(8193))).toBe("The contract's outcome is at most 8192 bytes.");
    expect(taskCount()).toBe(0);
  });

  it("gives a task to a role whose agent is supervised: its approvals go to the chat that follows it", async () => {
    const taskId = created(await say('new Rotate the logs\nassignee: watched'));
    expect(getTask(t.db, taskId)?.assignee).toEqual({ kind: 'role', name: 'watched' });
  });
});

describe('people, named by @-mention', () => {
  it('gives a task to the person a mention names, by their union_id, and says they get a card', async () => {
    const reply = await say('new Check the links\nassignee: @Alice Smith\nreviewer: @Bob', OWNER, [AT_ALICE, AT_BOB]);
    const taskId = created(reply);
    expect(reply).toBe(
      `Created \`${taskId}\` — **Check the links**, for Alice Smith (lark:on\\_alice). ` +
        'They are sent it as a card, in a direct message, once it is ready. ' +
        'This chat hears when it is done, needs review, blocks, is retried after a failure, gives up or is stranded.',
    );
    expect(getTask(t.db, taskId)).toMatchObject({
      assignee: { kind: 'human', name: 'lark:on_alice' },
      reviewer: { kind: 'human', name: 'lark:on_bob' },
    });
    // Once seen, a person may be named by principal too.
    expect(created(await say('new Again\nassignee: lark:on_alice'))).toMatch(/^k_/);
  });

  it('refuses a person without talk tier, one the message does not mention, and one never seen, creating nothing', async () => {
    expect(await say('new t\nassignee: @Carol', OWNER, [AT_CAROL])).toBe(
      '@Carol cannot be given work: being assigned lets a person report on the task, which needs talk tier, ' +
        'and the gateway does not know them to have it.',
    );
    expect(await say('new t\nreviewer: @Dan Lee', OWNER, [AT_ALICE])).toBe(
      '@Dan Lee is not someone this message mentions: type @ and pick them, so Lark says who they are.',
    );
    expect(await say('new t\nassignee: lark:on_stranger')).toMatch(/^lark:on\\_stranger cannot be given work/);
    expect(await say('new t\nassignee: @Alice Smith', OWNER, [{ ...AT_ALICE, unionId: null }])).toMatch(
      /^Lark did not say who @Alice Smith is/,
    );
    expect(taskCount()).toBe(0);
  });

  it('assigns a task to a person, and says when they have it already', async () => {
    const taskId = created(await say('new Survey the vendors\nassignee: implementer'));
    expect(await say(`assign ${taskId} @Alice Smith`, OWNER, [AT_ALICE])).toBe(
      `\`${taskId}\` is now for Alice Smith (lark:on\\_alice).`,
    );
    expect(await say(`assign ${taskId} @Alice Smith`, OWNER, [AT_ALICE])).toBe(
      `\`${taskId}\` is already assigned to Alice Smith (lark:on\\_alice).`,
    );
  });
});

/** A task for Alice, reviewed by Bob, with Alice's run open: what the dispatcher would have claimed. */
async function aliceTask(title = 'Check the links'): Promise<{ taskId: string; run: RunRow }> {
  const taskId = created(await say(`new ${title}\nassignee: @Alice Smith\nreviewer: @Bob`, OWNER, [AT_ALICE, AT_BOB]));
  const claim = service.claim(taskId);
  if (!claim.ok) throw new Error(claim.message);
  return { taskId, run: claim.run };
}

describe("a person's own reports", () => {
  it('lets the assignee report done, at talk tier, and nobody else', async () => {
    const { taskId, run } = await aliceTask();
    expect(await say(`done ${taskId} all links answer`, GUEST)).toBe(
      `\`/kanban done\` is for the person a task is assigned to; \`${taskId}\` is for Alice Smith (lark:on\\_alice).`,
    );
    // Not even an operator: done is the assignee's report.
    expect(await say(`done ${taskId} all links answer`)).toMatch(/^`\/kanban done` is for the person a task is assigned to/);
    const before = passes;
    expect(await say(`done ${taskId} all links answer`, ALICE)).toBe(`Done: \`${taskId}\` is complete.`);
    expect(getRun(t.db, run.runId)).toMatchObject({ outcome: 'completed', summary: 'all links answer' });
    expect(getTask(t.db, taskId)?.phase).toBe('done');
    expect(passes).toBe(before + 1);
  });

  it("lets the assignee block their task as needing input, and ask for review of a reviewer they mention", async () => {
    const { taskId } = await aliceTask();
    expect(await say(`block ${taskId} which wiki?`, ALICE)).toBe(
      `Blocked \`${taskId}\` (needs\\_input). An operator unblocks it with \`/kanban unblock ${taskId} [comment]\`.`,
    );
    expect(getTask(t.db, taskId)).toMatchObject({ phase: 'blocked', blockKind: 'needs_input', blockReason: 'which wiki?' });
    expect(await say(`unblock ${taskId}`)).toContain('is unblocked');
    expect(service.claim(taskId).ok).toBe(true);
    expect(await say(`review ${taskId} checked them all\nreviewer: @Bob`, ALICE, [AT_BOB])).toBe(
      `\`${taskId}\` is waiting for review, by Bob (lark:on\\_bob).`,
    );
    expect(getTask(t.db, taskId)).toMatchObject({ phase: 'review', reviewer: { kind: 'human', name: 'lark:on_bob' } });
    // Once in review, the assignee's own reports are not the answer.
    expect(await say(`done ${taskId} x`, ALICE)).toBe(`\`${taskId}\` is review: \`/kanban done\` reports on work being done.`);
  });

  it('lets the named reviewer answer at talk tier, and an operator answer any review', async () => {
    const { taskId } = await aliceTask();
    expect(await say(`approve ${taskId}`, BOB)).toBe(`\`${taskId}\` is not waiting for review: it is open.`);
    expect(await say(`review ${taskId} checked them all`, ALICE)).toContain('is waiting for review, by Bob');
    expect(await say(`approve ${taskId}`, GUEST)).toBe(
      `\`/kanban approve\` answers a review, and is for \`${taskId}\`'s reviewer (Bob (lark:on\\_bob)) or an operator.`,
    );
    expect(await say(`changes ${taskId} cite the source of each link`, BOB)).toBe(
      `Changes requested on \`${taskId}\`: it goes back to its assignee, with your reason.`,
    );
    expect(getTask(t.db, taskId)?.phase).toBe('open');
    expect(service.claim(taskId).ok).toBe(true);
    expect(await say(`review ${taskId} sources added`, ALICE)).toContain('is waiting for review');
    // An operator answers a review that is not theirs.
    expect(await say(`approve ${taskId} fine by me`)).toBe(`Approved: \`${taskId}\` is complete.`);
    expect(getTask(t.db, taskId)?.phase).toBe('done');
  });

  it("lets an operator answer a role's review", async () => {
    const taskId = created(await say('new Fix the footer\nassignee: implementer\nreviewer: reviewer'));
    const work = service.claim(taskId);
    if (!work.ok) throw new Error(work.message);
    expect((await service.requestReview(taskId, { kind: 'run', runId: work.run.runId }, { summary: 'moved it' })).ok).toBe(true);
    expect(service.closeRun(work.run.runId).ok).toBe(true);
    expect(await say(`changes ${taskId} keep the old colour`)).toContain('Changes requested on');
    expect(getTask(t.db, taskId)?.phase).toBe('open');
  });

  it("shows a gate's refusal, its output masked and escaped, and applies nothing", async () => {
    const { taskId, run } = await aliceTask();
    expect(await say(`gate add ${taskId} test -f links.md`)).toContain('Gate 1 added');
    addSecrets(['sk-gate-12345678']);
    exits.set('test -f links.md', { exitCode: 1, output: 'no links.md <at id=all></at> sk-gate-12345678' });
    const reply = await say(`done ${taskId} all links answer`, ALICE);
    expect(reply).toBe(
      'Not done: the gate test -f links.md exited 1, so the report was not applied. Fix it, then report again.\n' +
        `Its output:\n> no links.md \\<at id=all\\>\\</at\\> ${MASK}`,
    );
    expect(getRun(t.db, run.runId)?.outcome).toBeNull();
  });

  it('refuses a typed done on a run the task no longer has, once its gates are done: reassigned while they ran', async () => {
    const { taskId, run } = await aliceTask();
    expect(await say(`gate add ${taskId} test -f links.md`)).toContain('Gate 1 added');
    let release!: () => void;
    holds.set('test -f links.md', new Promise<void>((resolve) => (release = resolve)));
    const reply = say(`done ${taskId} all links answer`, ALICE);
    await new Promise((resolve) => setImmediate(resolve));
    // While the gates run, the task is given to someone else.
    expect(await say(`assign ${taskId} implementer`)).toContain('is now for role implementer');
    release();
    expect(await reply).toBe(`Not done: run ${run.runId.replace(/_/g, '\\_')} of task ${taskId.replace(/_/g, '\\_')} is over: the task has moved on since this report was made`);
    expect(getTask(t.db, taskId)).toMatchObject({ phase: 'open', assignee: { kind: 'role', name: 'implementer' } });
  });

  it("lets the named assignee's comment steer, as an operator's does", async () => {
    const { taskId } = await aliceTask();
    expect(await say(`comment ${taskId} the wiki moved`, ALICE)).toContain('An agent working on it gets it');
    expect(await say(`comment ${taskId} the reviewer agrees`, BOB)).toContain('An agent working on it gets it');
    expect(await say(`comment ${taskId} me too`, GUEST)).toContain('for people');
    expect(commentsOf(t.db, taskId, { steering: true }).map((c) => c.author)).toEqual(['lark:on_alice', 'lark:on_bob']);
  });
});

describe("a person's card", () => {
  /** Press a button of the run's card as `presser`, with what the box held; the value as given, or as the card has it. */
  function press(
    run: RunRow,
    act: string,
    presser: Principal,
    input?: string,
    value: Record<string, unknown> = {},
  ): Promise<string> {
    const card = renderTaskCard({ task: getTask(t.db, run.taskId)!, run, parents: [] }, 'cli_app');
    const base = card.buttons.find((b) => b.value['act'] === 'done')?.value ?? {};
    const action: InboundCardAction = {
      chatId: 'oc_dm',
      messageId: 'om_card',
      operator: presser,
      value: { ...base, act, ...value },
      ...(input === undefined ? {} : { input }),
    };
    return chat.card(action);
  }

  it("answers at once, reports through the card's run in the background, and redraws the card as worked on, then with what happened", async () => {
    const { taskId, run } = await aliceTask();
    expect(await say(`gate add ${taskId} test -f links.md`)).toContain('Gate 1 added');
    let release!: () => void;
    holds.set('test -f links.md', new Promise<void>((resolve) => (release = resolve)));
    // Answered before the gate ends: Lark waits about three seconds for a callback's answer.
    expect(await press(run, 'done', ALICE, 'all links answer')).toBe(`Completing \`${taskId}\`: the card shows how it goes.`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(getRun(t.db, run.runId)?.outcome).toBeNull();
    expect(redrawn.map((r) => r.view.markdown)).toEqual([`**Check the links** \`${taskId}\`\nWorking on it…`]);
    release();
    expect(await chat.idle(5_000)).toBe(true);
    expect(getRun(t.db, run.runId)).toMatchObject({ outcome: 'completed', summary: 'all links answer' });
    expect(redrawn.at(-1)).toEqual({
      messageId: 'om_card',
      view: { markdown: `**Check the links** \`${taskId}\`\nDone — by Alice Smith.`, buttons: [] },
    });
  });

  it('redraws a card it refused for what a press carried live, saying why, with buttons a new press can be made with', async () => {
    const { taskId, run } = await aliceTask();
    expect(await press(run, 'block', ALICE, '  ')).toBe('Type why it is blocked in the box, then press Block.');
    const first = redrawn.at(-1)?.view;
    expect(first?.markdown).toContain('**Not done.** Type why it is blocked in the box, then press Block.');
    // The value differs from the button pressed, first: the SDK drops a press it has seen, by the value's start.
    expect(first?.buttons.map((b) => Object.keys(b.value)[0])).toEqual(['try', 'try']);
    expect(first?.buttons.map((b) => b.value['try'])).toEqual(['1', '1']);
    // And in the buttons' names, which the SDK keys a press on whole: the card carries the attempt.
    expect(first?.attempt).toBe(1);
    // A gate's refusal, in the background, the same way; the attempt goes on from the button pressed.
    expect(await say(`gate add ${taskId} test -f links.md`)).toContain('Gate 1 added');
    exits.set('test -f links.md', { exitCode: 1, output: 'no links.md' });
    await press(run, 'done', ALICE, 'all links answer', { try: '1' });
    await chat.idle(5_000);
    const second = redrawn.at(-1)?.view;
    expect(second?.markdown).toContain('**Not done.** Not done: the gate test -f links.md exited 1');
    expect(second?.markdown).toContain('> no links.md');
    expect(second?.buttons.map((b) => [b.label, b.value['try']])).toEqual([
      ['Done', '2'],
      ['Block', '2'],
    ]);
    expect(second?.attempt).toBe(2);
    // An attempt that cannot be read starts over.
    await press(run, 'block', ALICE, '', { try: 'x' });
    expect(redrawn.at(-1)?.view.attempt).toBe(1);
    expect(getRun(t.db, run.runId)?.outcome).toBeNull();
  });

  it('takes no second press of a card while one is worked on, so neither redraws over the other', async () => {
    const { taskId, run } = await aliceTask();
    expect(await say(`gate add ${taskId} test -f links.md`)).toContain('Gate 1 added');
    let release!: () => void;
    holds.set('test -f links.md', new Promise<void>((resolve) => (release = resolve)));
    await press(run, 'done', ALICE, 'all links answer');
    expect(await press(run, 'block', ALICE, '')).toBe('That card is being worked on: it shows the outcome when it is done.');
    await new Promise((resolve) => setImmediate(resolve));
    expect(redrawn.map((r) => r.view.markdown)).toEqual([`**Check the links** \`${taskId}\`\nWorking on it…`]);
    release();
    await chat.idle(5_000);
    expect(redrawn.at(-1)?.view.markdown).toContain('Done — by Alice Smith.');
  });

  it('redraws a card as out of date, not live, when its run ended while the refused report ran', async () => {
    const { taskId, run } = await aliceTask();
    expect(await say(`gate add ${taskId} test -f links.md`)).toContain('Gate 1 added');
    let release!: () => void;
    holds.set('test -f links.md', new Promise<void>((resolve) => (release = resolve)));
    exits.set('test -f links.md', { exitCode: 1, output: 'no links.md' });
    await press(run, 'done', ALICE, 'all links answer');
    await new Promise((resolve) => setImmediate(resolve));
    expect(await say(`stop ${taskId}`)).toContain('Stopped');
    release();
    await chat.idle(5_000);
    expect(redrawn.at(-1)?.view).toEqual({
      markdown: `**Check the links** \`${taskId}\`\nThis card is out of date: the task has moved on since it was sent.`,
      buttons: [],
    });
  });

  it("kills a press's gates when the gateway stops, applying nothing, and says so on the card", async () => {
    const { taskId, run } = await aliceTask();
    expect(await say(`gate add ${taskId} test -f links.md`)).toContain('Gate 1 added');
    holds.set('test -f links.md', new Promise<void>(() => undefined));
    await press(run, 'done', ALICE, 'all links answer');
    await new Promise((resolve) => setImmediate(resolve));
    chat.stop();
    expect(await chat.idle(5_000)).toBe(true);
    expect(getRun(t.db, run.runId)?.outcome).toBeNull();
    expect(redrawn.at(-1)?.view.markdown).toContain('the gateway is stopping');
    // A typed report's gates too.
    const typed = say(`done ${taskId} again`, ALICE);
    expect(await typed).toContain('the gateway is stopping');
  });

  it('bounds a redraw that never answers: the press ends, the card is not held, and an ended run is still told out of date', async () => {
    const notes: string[] = [];
    let first = true;
    const hung = new KanbanChat({
      service,
      hasTier: (p, tier) => new Authorizer({ ...defaultAuthConfig(OWNER.openId), allowTalk: [OWNER.openId, ALICE.openId] }).hasTier(p, tier),
      people: new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: () => true }),
      appId: 'cli_app',
      // The first redraw never answers, as an update with no timeout of its own may not.
      redraw: async (messageId, view) => {
        if (first) {
          first = false;
          return new Promise<void>(() => undefined);
        }
        redrawn.push({ messageId, view });
      },
      redrawTimeoutMs: 50,
      note: (line) => notes.push(line),
    });
    const { taskId, run } = await aliceTask();
    const card = renderTaskCard({ task: getTask(t.db, taskId)!, run, parents: [] }, 'cli_app');
    const value = card.buttons.find((b) => b.value['act'] === 'done')?.value ?? {};
    const action: InboundCardAction = { chatId: 'oc_dm', messageId: 'om_card', operator: ALICE, value, input: 'all links answer' };
    await hung.card(action);
    // While the press waits on the hung redraw, the run ends another way; a press of the card is told it is out of date.
    expect(await say(`done ${taskId} typed it`, ALICE)).toContain('is complete');
    expect(await hung.card(action)).toBe(`That card is out of date: \`${taskId}\` has moved on. \`/kanban show ${taskId}\` says where it is.`);
    expect(await hung.idle(5_000)).toBe(true);
    expect(notes).toContain('kanban: redrawing card om_card took longer than 50 ms; going on without it');
    expect(redrawn.at(-1)?.view.markdown).toContain('This card is out of date');
  });

  it('refuses a press by someone else, and an altered payload, changing nothing, the card left as it was', async () => {
    const { run } = await aliceTask();
    expect(await press(run, 'done', BOB, 'x')).toBe('This card is for Alice Smith (lark:on\\_alice).');
    expect(await press(run, 'done', ALICE, 'x', { run: 'r_other' })).toBe('That button does not match the card it is on.');
    expect(await press(run, 'done', { openId: 'ou_stranger', unionId: 'on_stranger', displayName: 'S' }, 'x')).toBe(
      'You are not on the allowlist.',
    );
    await chat.idle(5_000);
    expect(redrawn).toEqual([]);
    expect(getRun(t.db, run.runId)?.outcome).toBeNull();
  });

  it('does nothing for a card whose run is over, and redraws it as out of date', async () => {
    const { taskId, run } = await aliceTask();
    expect(await say(`done ${taskId} typed it instead`, ALICE)).toContain('is complete');
    expect(await press(run, 'done', ALICE, 'again')).toBe(
      `That card is out of date: \`${taskId}\` has moved on. \`/kanban show ${taskId}\` says where it is.`,
    );
    expect(redrawn.map((r) => r.view.markdown)).toEqual([
      `**Check the links** \`${taskId}\`\nThis card is out of date: the task has moved on since it was sent.`,
    ]);
    expect(getRun(t.db, run.runId)?.summary).toBe('typed it instead');
  });

  it("unblocks from a notice's button at operator tier, once", async () => {
    const { taskId } = await aliceTask();
    expect(await say(`block ${taskId} which wiki?`, ALICE)).toContain('Blocked');
    const blocked = eventsOf(t.db, taskId).findLast((e) => e.kind === 'blocked');
    if (blocked === undefined) throw new Error('not blocked');
    const { unblockButton } = await import('../src/kanban/chat-render.js');
    const value = unblockButton('cli_app', blocked).value;
    const action = (presser: Principal): InboundCardAction => ({ chatId: 'oc_team', messageId: 'om_notice', operator: presser, value });
    expect(await chat.card(action(ALICE))).toBe('Unblock changes the board, and needs operator permission.');
    expect(await chat.card(action(OWNER))).toBe(`\`${taskId}\` is unblocked, back to open.`);
    expect(await chat.card(action(OWNER))).toBe(
      `\`${taskId}\` is not blocked as that notice said any more: \`/kanban show ${taskId}\` says where it is.`,
    );
  });
});

describe('tiers and identity', () => {
  it('lets a talk-tier sender read and comment, and refuses every change of the board', async () => {
    const taskId = created(await say('new A task\nassignee: implementer'));
    expect(await say('list', GUEST)).toContain(taskId);
    expect(await say(`show ${taskId}`, GUEST)).toContain('**A task**');
    expect(await say(`gate list ${taskId}`, GUEST)).toBe(`Task \`${taskId}\` has no gates.`);
    expect(await say(`comment ${taskId} the 2024 figures, please`, GUEST)).toBe(
      `Comment added to \`${taskId}\`, for people: \`/kanban show\` shows it. Only an operator's comment, or its assignee's or reviewer's, is given to the task's agent.`,
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
    expect(await say(`assign ${child} @Carol Jones`)).toBe(
      '@Carol Jones is not someone this message mentions: type @ and pick them, so Lark says who they are.',
    );
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

describe('a wrong command line', () => {
  it('is answered with its usage, and an unknown task as the board says', async () => {
    expect(await say('done k_missing finished', ALICE)).toBe('Not done: no task k\\_missing');
    expect(await say('show')).toBe('Usage: `/kanban show <task>`');
    expect(await say('show k_missing')).toBe('Not done: no task k\\_missing');
    expect(await say('')).toContain('**The task board.**');
  });
});
```


- [ ] **Step 8.2: Run them to verify they fail.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` and then `npx vitest run --project unit tests/kanban-chat.test.ts`. Expected: twenty-two FAIL: a person is still refused as arriving in a later update (`Error: not created: Assigning a task to a person, …`), the people's reports are answered the same way, and `chat.card` and `chat.stop` are not functions. `Tests  22 failed | 7 passed (29)`.

- [ ] **Step 8.3: Implement.**

In `src/index.ts`, replace:

```ts
import { writeMtShim } from './kanban/shim.js';
import { KanbanSink } from './kanban/sink.js';
```

with:

```ts
import { writeMtShim } from './kanban/shim.js';
import { PeopleDirectory } from './kanban/people.js';
import { KanbanSink } from './kanban/sink.js';
```

In `src/index.ts`, replace:

```ts
    worker = { api: new WorkerApi({ db, service, changed: () => dispatcher?.pass() }), socket };
    // /kanban in chat (spec §9.1): through the same service, with the router's tiers.
```

with:

```ts
    worker = { api: new WorkerApi({ db, service, changed: () => dispatcher?.pass() }), socket };
    // Who the gateway has seen in Lark: how a person named by principal is checked for talk tier (spec §4.2).
    const people = new PeopleDirectory({
      db,
      appId: config.lark.appId,
      canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }),
    });
    // /kanban in chat (spec §9.1): through the same service, with the router's tiers.
```

In `src/index.ts`, replace:

```ts
      hasTier: (principal, tier) => authorizer.hasTier(principal, tier),
      changed: () => dispatcher?.pass(),
```

with:

```ts
      hasTier: (principal, tier) => authorizer.hasTier(principal, tier),
      people,
      appId: config.lark.appId,
      redraw: (messageId, view) => adapter.updateCard(messageId, view),
      changed: () => dispatcher?.pass(),
```

In `src/kanban/chat-render.ts`, replace:

```ts
import type { Assignee, GateRow, KanbanEvent, RunRow, TaskRow } from './types.js';
```

with:

```ts
import type { Assignee, FailedGate, GateRow, KanbanEvent, RunRow, TaskRow } from './types.js';
```

In `src/kanban/chat-render.ts`, replace:

```ts
/**
 * The outcomes a retry follows that are failures to tell a subscriber of (spec
```

with:

```ts
/**
 * A person's report refused by a gate (spec §7.7): the gate, how it ended, and
 * the end of its output, masked whole before it is cut, as a run's output is.
 */
export function renderGateFailure(gate: FailedGate): string {
  const how = gate.timedOut
    ? 'ran past its timeout'
    : gate.exitCode !== null
      ? `exited ${gate.exitCode}`
      : gate.signal === null
        ? 'could not start'
        : `was ended by ${forDisplay(gate.signal)}`;
  const head = `Not done: the gate ${label(gate.command, 300)} ${how}, so the report was not applied. Fix it, then report again.`;
  return gate.output.trim() === '' ? head : `${head}\nIts output:\n${tail(gate.output, 1500)}`;
}

/**
 * The outcomes a retry follows that are failures to tell a subscriber of (spec
```

In `src/kanban/chat-render.ts`, replace:

```ts
  nameOf?: NameOf;
}
```

with:

```ts
  nameOf?: NameOf;
  /**
   * How many times the card has been redrawn live after a press it refused --
   * an empty box, a gate. Its buttons carry it, so a press of the redrawn card is
   * not the press before it: the SDK drops a press it has seen, by the card, the
   * presser and the button's value, for twelve hours, whatever the box held.
   */
  attempt?: number;
  /** Why the last press did nothing, shown under the title, already escaped. */
  note?: string;
}
```

In `src/kanban/chat-render.ts`, replace:

```ts
/** The buttons' value: a pointer, with the nonce that binds it to the task and the run (spec §9.2). */
function act(appId: string, run: RunRow, name: string): Readonly<Record<string, string>> {
  return { kind: 'kanban', act: name, task: run.taskId, run: run.runId, nonce: boardCardNonce(appId, run.taskId, run.runId) };
```

with:

```ts
/**
 * The buttons' value: a pointer, with the nonce that binds it to the task and the
 * run (spec §9.2). The attempt goes first: the SDK keys a press on the value's
 * first 128 characters. It is not under the nonce, and needs no checking.
 */
function act(appId: string, run: RunRow, name: string, attempt: number | undefined): Readonly<Record<string, string>> {
  return {
    ...(attempt === undefined || attempt === 0 ? {} : { try: String(attempt) }),
    kind: 'kanban',
    act: name,
    task: run.taskId,
    run: run.runId,
    nonce: boardCardNonce(appId, run.taskId, run.runId),
  };
```

In `src/kanban/chat-render.ts`, replace:

```ts
  const out = [`📋 **${label(task.title)}** ${id(task.taskId)} — for you to do`];
  if (f.changes !== undefined) {
```

with:

```ts
  const out = [`📋 **${label(task.title)}** ${id(task.taskId)} — for you to do`];
  if (f.note !== undefined) out.push(f.note);
  if (f.changes !== undefined) {
```

In `src/kanban/chat-render.ts`, replace:

```ts
    { label: 'Done', style: 'primary', value: act(appId, run, 'done') },
    { label: 'Block', style: 'danger', value: act(appId, run, 'block') },
```

with:

```ts
    { label: 'Done', style: 'primary', value: act(appId, run, 'done', f.attempt) },
    { label: 'Block', style: 'danger', value: act(appId, run, 'block', f.attempt) },
```

In `src/kanban/chat-render.ts`, replace:

```ts
  return { markdown: out.join('\n'), input: { placeholder: 'A summary, or why it is blocked' }, buttons };
```

with:

```ts
  return {
    markdown: out.join('\n'),
    input: { placeholder: 'A summary, or why it is blocked' },
    buttons,
    ...(f.attempt === undefined || f.attempt === 0 ? {} : { attempt: f.attempt }),
  };
```

In `src/kanban/chat-render.ts`, replace:

```ts
  const out = [`🔎 **${label(task.title)}** ${id(task.taskId)} — for you to review`];
  const h = f.handoff;
```

with:

```ts
  const out = [`🔎 **${label(task.title)}** ${id(task.taskId)} — for you to review`];
  if (f.note !== undefined) out.push(f.note);
  const h = f.handoff;
```

In `src/kanban/chat-render.ts`, replace:

```ts
    { label: 'Approve', style: 'primary', value: act(appId, run, 'approve') },
    { label: 'Request changes', style: 'danger', value: act(appId, run, 'changes') },
```

with:

```ts
    { label: 'Approve', style: 'primary', value: act(appId, run, 'approve', f.attempt) },
    { label: 'Request changes', style: 'danger', value: act(appId, run, 'changes', f.attempt) },
```

In `src/kanban/chat-render.ts`, replace:

```ts
  return { markdown: out.join('\n'), input: { placeholder: 'What needs changing' }, buttons };
```

with:

```ts
  return {
    markdown: out.join('\n'),
    input: { placeholder: 'What needs changing' },
    buttons,
    ...(f.attempt === undefined || f.attempt === 0 ? {} : { attempt: f.attempt }),
  };
```

Replace the whole of `src/kanban/chat.ts` with:

```ts
import { timingSafeEqual } from 'node:crypto';
import { forDisplay } from '../channel/escape.js';
import type { CardView } from '../channel/types.js';
import { boardCardNonce } from '../core/ids.js';
import type { InboundCardAction } from '../core/router.js';
import type { BindingKey, InboundMention, InboundMessage, Principal, Tier } from '../types.js';
import { isPerson, parseKanban, type KanbanCommand, type NewTaskCommand, type ReportCommand, type ReviewCommand } from './chat-parse.js';
import {
  label,
  renderCardOutcome,
  renderGateFailure,
  renderGates,
  renderHelp,
  renderList,
  renderReviewCard,
  renderShow,
  renderTaskCard,
  type CardFacts,
} from './chat-render.js';
import { redactKnownSecrets } from '../secrets.js';
import { personPrincipal, type PeopleDirectory } from './people.js';
import type { KanbanService } from './service.js';
import type { Assignee, Refusal, Reporter, RunRow, TaskRow } from './types.js';
import { WORKER_LIMITS } from './worker.js';

/**
 * `/kanban` in chat (spec §9.1): a parsed command, checked against the sender's
 * tier, done through `KanbanService` and nothing else, and answered as text the
 * router sends. It never touches the chat's session, so a busy session never
 * refuses it: it is control-plane, like `/status`.
 *
 * A person is recorded as `lark:<union_id>` (spec §3.1), the identity the board
 * knows people by; a sender whose union_id is unknown can read the board but not
 * change it. A person is named by @-mention: the message carries the mentioned
 * people's ids, so there is no name to resolve or confuse. Each sender, and each
 * person a command mentions, is noted in the people directory, which is how a
 * person named later by principal alone is checked for talk tier (spec §4.2).
 *
 * Anyone at talk tier may comment, and everyone sees comments in `/kanban show`;
 * only an operator's, or the task's named assignee's or reviewer's, may steer
 * its agent (spec §9.1, §7.5). A named assignee reports on their own task, and a
 * named reviewer answers its review, with talk tier: being named is the
 * authorization. An operator may answer any review.
 *
 * The buttons of a person's cards (spec §9.2) arrive here too, from the router,
 * which dispatches on the card's `kind`: who pressed comes from the callback's
 * operator, never from the payload, and the action is re-checked against the
 * card's run inside the board's transaction.
 */

export interface KanbanChatDeps {
  service: KanbanService;
  /** The sender's tier, as the router's authorizer decides it. */
  hasTier(principal: Principal, tier: Tier): boolean;
  /** Who the gateway has seen: each sender, mention and card presser is noted here. */
  people: PeopleDirectory;
  /** This bot: a card's nonce is bound to it. */
  appId: string;
  /** Redraw a card once acted on, so its buttons stop working: the Lark adapter's. */
  redraw?: (messageId: string, view: CardView) => Promise<void>;
  /** Metadata, masked: a press whose work in the background failed. */
  note?: (line: string) => void;
  /** How long a redraw is waited for; `REDRAW_MS` unless a test says otherwise. */
  redrawTimeoutMs?: number;
  /** After a change that can make a task claimable: the dispatcher's pass. */
  changed?: () => void;
  /** After a change that decided an agent run: the dispatcher cancels its turn and closes it. */
  cancel?: (runId: string) => void;
}

/** Who may run each command (spec §9.1, §10); a person's own reports check who is named, below. */
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
  done: 'talk',
  block: 'talk',
  review: 'talk',
  approve: 'talk',
  changes: 'talk',
};

/** The board's principal for a chat sender: `lark:<union_id>`, or undefined when Lark gave none. */
export function principalOf(sender: Principal): string | undefined {
  return sender.unionId === null || sender.unionId === '' ? undefined : `lark:${sender.unionId}`;
}

const NO_UNION_ID =
  'Lark did not say who you are (no union_id came with the message), and the board records who changes it. Ask the operator to check the app can read user ids.';

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

/** A refusal, in words for chat: the board's message, on one line, since it can quote what the sender typed. */
function refused(r: Refusal): string {
  if (r.code === 'gate_failed' && r.gate !== undefined) return renderGateFailure(r.gate);
  return `Not done: ${label(r.message, 600)}`;
}

/** The board's own ids are code; anything else the sender typed is escaped like any text. */
function id(taskId: string): string {
  return /^[kr]_[0-9a-z]+$/.test(taskId) ? `\`${taskId}\`` : forDisplay(taskId);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function field(value: Record<string, unknown>, name: string): string | undefined {
  const raw = value[name];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

function seen(p: Principal | InboundMention): { openId: string | null; unionId: string | null; name: string | null } {
  return 'key' in p
    ? { openId: p.openId, unionId: p.unionId, name: p.name }
    : { openId: p.openId, unionId: p.unionId, name: p.displayName };
}

/** Whether this principal is the person named here. */
function isNamed(a: Assignee | null, principal: string): boolean {
  return a?.kind === 'human' && a.name === principal;
}

type Named = { ok: true; name: string } | { ok: false; reply: string };

/** The longest a card's redraw is waited for. */
export const REDRAW_MS = 10_000;

function outOfDate(taskId: string): string {
  return `That card is out of date: ${id(taskId)} has moved on. \`/kanban show ${taskId}\` says where it is.`;
}

/** A press being acted on: the card's message, its run, and the attempt its redraw gets. */
interface Press {
  messageId: string;
  run: RunRow;
  attempt: number;
}

export class KanbanChat {
  readonly #deps: KanbanChatDeps;
  /** Presses being worked on in the background. */
  readonly #pending = new Set<Promise<void>>();
  /** The cards a press is being worked on for, by message: a second press waits for the first. */
  readonly #busy = new Set<string>();
  /** Aborted when the gateway stops: a report's gates are killed, and nothing is applied (spec §7.7). */
  readonly #stopping = new AbortController();

  constructor(deps: KanbanChatDeps) {
    this.#deps = deps;
  }

  #note(line: string): void {
    try {
      this.#deps.note?.(line);
    } catch {
      // Nowhere left to say it.
    }
  }

  /** Run `/kanban <arg>` from this message, bound at `key`; the reply to send. */
  async run(arg: string, message: InboundMessage, key: BindingKey): Promise<string> {
    const parsed = parseKanban(arg);
    if (!parsed.ok) return parsed.usage;
    const command = parsed.command;
    // Noted first: an @-mention in this very command is checked for talk tier through it.
    this.#deps.people.saw(seen(message.sender));
    for (const m of message.mentions ?? []) this.#deps.people.saw(seen(m));
    const tier = TIERS[command.verb];
    if (tier === 'operate' && !this.#deps.hasTier(message.sender, 'operate')) {
      return `\`/kanban ${command.verb}\` changes the board, and needs operator permission.`;
    }
    switch (command.verb) {
      case 'help':
        return renderHelp();
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
    if (by === undefined) return NO_UNION_ID;
    // A change is made, then its reply rendered. Should the render throw after the
    // change succeeded, the router answers that the board could not do it: the
    // change stands though the reply says it was not done, and `/kanban show` tells.
    return this.#change(command, by, message, key);
  }

  async #change(command: KanbanCommand, by: string, message: InboundMessage, key: BindingKey): Promise<string> {
    const service = this.#deps.service;
    switch (command.verb) {
      case 'new':
        return this.#create(command, by, message, key);
      case 'assign': {
        const named = this.#named(command.assignee, message);
        if (!named.ok) return named.reply;
        const now = service.show(command.taskId);
        const current = now.ok ? now.view.task.assignee : null;
        if (current !== null && current.name === named.name) {
          return `${id(command.taskId)} is already assigned to ${this.#whom(current)}.`;
        }
        const r = service.assign(command.taskId, named.name, by);
        if (!r.ok) return refused(r);
        this.#decided(r.run);
        this.#changed();
        const whom = r.task.assignee === null ? 'nobody' : this.#whom(r.task.assignee);
        return `${id(command.taskId)} is now for ${whom}${r.run === undefined ? '' : `; its run ${id(r.run.runId)} was ${forDisplay(r.run.outcome ?? 'ended')}`}.`;
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
        return `${id(command.taskId)} works in ${label(command.workspace)}.`;
      }
      case 'comment': {
        // An operator's comment, and the named assignee's or reviewer's, may steer the
        // task's agent; anyone's is shown to people (spec §9.1, §7.5).
        const shown = service.show(command.taskId);
        const named = shown.ok && (isNamed(shown.view.task.assignee, by) || isNamed(shown.view.task.reviewer, by));
        const steers = named || this.#deps.hasTier(message.sender, 'operate');
        const r = service.comment(command.taskId, command.text, by, { steers });
        if (!r.ok) return refused(r);
        return steers
          ? `Comment added to ${id(command.taskId)}. An agent working on it gets it when its current turn ends; otherwise the next run reads it.`
          : `Comment added to ${id(command.taskId)}, for people: \`/kanban show\` shows it. Only an operator's comment, or its assignee's or reviewer's, is given to the task's agent.`;
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
      case 'done':
      case 'block':
      case 'approve':
      case 'changes':
        return this.#report(command, by, message.sender);
      case 'review':
        return this.#review(command, by, message);
      default:
        return renderHelp();
    }
  }

  /**
   * A person's report on their own task (spec §9.1): `done` and `block` by its
   * assignee while the work is open, `approve` and `changes` by its reviewer, or an
   * operator, while it waits for review. The board decides the person's open run.
   */
  async #report(command: ReportCommand, by: string, sender: Principal): Promise<string> {
    const shown = this.#deps.service.show(command.taskId);
    if (!shown.ok) return refused(shown);
    const task = shown.view.task;
    const allowed = this.#mayReport(command.verb, task, by, sender);
    if (allowed !== undefined) return allowed;
    const r = await this.#apply(command.verb, task.taskId, this.#reporter(by, shown.view.runs), command.text);
    if (!r.ok) return refused(r);
    this.#changed();
    return this.#reported(command.verb, task.taskId);
  }

  /** `/kanban review`: the assignee asks for same-task review (spec §5.3), of a reviewer named here or on the task. */
  async #review(command: ReviewCommand, by: string, message: InboundMessage): Promise<string> {
    const shown = this.#deps.service.show(command.taskId);
    if (!shown.ok) return refused(shown);
    const task = shown.view.task;
    const allowed = this.#mayReport('review', task, by, message.sender);
    if (allowed !== undefined) return allowed;
    let reviewer: string | undefined;
    if (command.reviewer !== undefined) {
      const named = this.#named(command.reviewer, message);
      if (!named.ok) return named.reply;
      reviewer = named.name;
    }
    const r = await this.#deps.service.requestReview(
      task.taskId,
      this.#reporter(by, shown.view.runs),
      { summary: command.summary, ...(reviewer === undefined ? {} : { reviewer }) },
      { signal: this.#stopping.signal },
    );
    if (!r.ok) {
      return r.code === 'no_reviewer'
        ? `Nobody is named to review ${id(task.taskId)}: add a line \`reviewer: <role or @person>\`.`
        : refused(r);
    }
    this.#changed();
    return `${id(task.taskId)} is waiting for review, by ${r.task.reviewer === null ? 'nobody' : this.#whom(r.task.reviewer)}.`;
  }

  /**
   * A person reporting as they type it: on the task's open run as it was when the
   * report was checked, so that should the run change while the report's gates
   * run -- the task reassigned -- the board refuses the report rather than decide
   * someone else's run (spec §9.2's re-check, for a typed report too).
   */
  #reporter(by: string, runs: readonly RunRow[]): Reporter {
    const open = runs.find((r) => r.endedAt === null);
    return open === undefined ? { kind: 'person', principal: by } : { kind: 'person', principal: by, runId: open.runId };
  }

  /** Undefined when this person may make this report on this task now; otherwise why not. */
  #mayReport(verb: ReportCommand['verb'] | 'review', task: TaskRow, by: string, sender: Principal): string | undefined {
    if (verb === 'approve' || verb === 'changes') {
      if (!isNamed(task.reviewer, by) && !this.#deps.hasTier(sender, 'operate')) {
        return `\`/kanban ${verb}\` answers a review, and is for ${id(task.taskId)}'s reviewer (${task.reviewer === null ? 'nobody' : this.#whom(task.reviewer)}) or an operator.`;
      }
      if (task.phase !== 'review') return `${id(task.taskId)} is not waiting for review: it is ${forDisplay(task.phase)}.`;
      return undefined;
    }
    if (!isNamed(task.assignee, by)) {
      return `\`/kanban ${verb}\` is for the person a task is assigned to; ${id(task.taskId)} is for ${task.assignee === null ? 'nobody' : this.#whom(task.assignee)}.`;
    }
    // Its assignee reports on the work; once it is in review, the reviewer answers.
    if (task.phase !== 'open') return `${id(task.taskId)} is ${forDisplay(task.phase)}: \`/kanban ${verb}\` reports on work being done.`;
    return undefined;
  }

  /** The report, through the board: on the person's open run, or the card's when `by` names one. */
  async #apply(
    verb: ReportCommand['verb'],
    taskId: string,
    by: Reporter,
    text: string,
  ): Promise<{ ok: true; task: TaskRow } | Refusal> {
    const service = this.#deps.service;
    switch (verb) {
      case 'done':
      case 'approve':
        return service.complete(taskId, by, { summary: text }, { signal: this.#stopping.signal });
      case 'block':
        // A person's block on their own task needs their input (spec §5.4).
        return service.block(taskId, by, { kind: 'needs_input', reason: text });
      case 'changes':
        return service.requestChanges(taskId, by, text);
    }
  }

  #reported(verb: ReportCommand['verb'], taskId: string): string {
    switch (verb) {
      case 'done':
        return `Done: ${id(taskId)} is complete.`;
      case 'approve':
        return `Approved: ${id(taskId)} is complete.`;
      case 'block':
        return `Blocked ${id(taskId)} (needs\\_input). An operator unblocks it with \`/kanban unblock ${taskId} [comment]\`.`;
      case 'changes':
        return `Changes requested on ${id(taskId)}: it goes back to its assignee, with your reason.`;
    }
  }

  /**
   * A press of one of a person's card's buttons (spec §9.2), or of a notice's
   * Unblock: the board's answer, which the router notes in the log -- the chat is
   * told nothing, and the card shows what happened. The nonce must match the task and what
   * the card was for; who pressed is the callback's operator; the run is
   * re-checked in the board's transaction.
   *
   * **Answered at once.** Lark waits about three seconds for a callback's answer,
   * and the SDK answers only once this returns, so a report -- whose gates may
   * run for minutes -- is made in the background: the card is redrawn as being
   * worked on, and then with what happened. `idle()` waits for that work.
   *
   * **A card refused stays pressable.** The SDK drops a press it has seen -- the
   * same card, presser and button value -- for twelve hours, whatever the box
   * held. So a press this person may make that is refused for what it carried --
   * an empty box, a gate, a busy workspace -- redraws the card live, saying why,
   * with buttons whose value carries the next attempt. A card acted on, or out of
   * date, is redrawn without buttons. A press by the wrong person, or one whose
   * payload does not match, changes nothing.
   */
  async card(action: InboundCardAction): Promise<string> {
    const v = action.value;
    const verb = field(v, 'act');
    const taskId = field(v, 'task');
    const nonce = field(v, 'nonce');
    const event = field(v, 'event');
    // What the card is for: its run, or for an Unblock, the event that blocked the task.
    const ref = verb === 'unblock' ? (event === undefined ? undefined : `event:${event}`) : field(v, 'run');
    if (verb === undefined || taskId === undefined || nonce === undefined || ref === undefined) {
      return 'That button is missing its payload.';
    }
    if (!constantTimeEqual(boardCardNonce(this.#deps.appId, taskId, ref), nonce)) {
      return 'That button does not match the card it is on.';
    }
    const presser = action.operator;
    if (!this.#deps.hasTier(presser, 'talk')) return 'You are not on the allowlist.';
    this.#deps.people.saw(seen(presser));
    const by = principalOf(presser);
    if (by === undefined) return NO_UNION_ID;
    if (verb === 'unblock') {
      if (!this.#deps.hasTier(presser, 'operate')) return 'Unblock changes the board, and needs operator permission.';
      const r = this.#deps.service.unblock(taskId, by, undefined, { blockedAt: Number(event) });
      if (!r.ok) {
        return r.code === 'stale' || r.code === 'illegal_transition'
          ? `${id(taskId)} is not blocked as that notice said any more: \`/kanban show ${taskId}\` says where it is.`
          : refused(r);
      }
      this.#changed();
      return `${id(taskId)} is unblocked, back to ${r.task.phase}.`;
    }
    if (verb !== 'done' && verb !== 'block' && verb !== 'approve' && verb !== 'changes') {
      return 'That button is not one the board knows.';
    }
    const shown = this.#deps.service.show(taskId);
    if (!shown.ok) return refused(shown);
    const { task } = shown.view;
    const run = shown.view.runs.find((r) => r.runId === ref);
    if (run === undefined) return 'That button is not for a run of this task.';
    const allowed = this.#mayPress(verb, run, by, presser);
    if (allowed !== undefined) return allowed;
    const tried = Number(field(v, 'try') ?? '0');
    const press: Press = { messageId: action.messageId, run, attempt: Number.isSafeInteger(tried) && tried >= 0 ? tried + 1 : 1 };
    // Redraws go in the background, each bounded: Lark waits about three seconds for this answer.
    if (run.endedAt !== null) {
      this.#track(this.#outOfDate(press, task).then(() => undefined));
      return outOfDate(task.taskId);
    }
    // A press while one is being worked on for this card would redraw over it.
    if (this.#busy.has(action.messageId)) return 'That card is being worked on: it shows the outcome when it is done.';
    const text = (action.input ?? '').trim();
    const empty =
      verb === 'block' && text === ''
        ? 'Type why it is blocked in the box, then press Block.'
        : verb === 'changes' && text === ''
          ? 'Type what needs changing in the box, then press Request changes.'
          : undefined;
    if (empty !== undefined) {
      this.#track(this.#redrawLive(press, empty));
      return empty;
    }
    const name = label(presser.displayName ?? by, 80);
    this.#busy.add(press.messageId);
    this.#track(this.#press(verb, press, by, name, text).finally(() => this.#busy.delete(press.messageId)));
    return `${{ done: 'Completing', block: 'Blocking', approve: 'Approving', changes: 'Asking for changes on' }[verb]} ${id(taskId)}: the card shows how it goes.`;
  }

  /** The report a press asked for, in the background: the card redrawn as worked on, then with the outcome. */
  async #press(verb: ReportCommand['verb'], press: Press, by: string, name: string, text: string): Promise<void> {
    const shown = this.#deps.service.show(press.run.taskId);
    const task = shown.ok ? shown.view.task : { taskId: press.run.taskId, title: '' };
    await this.#redraw(press.messageId, renderCardOutcome(task, 'Working on it…'));
    let r: { ok: true; task: TaskRow } | Refusal;
    try {
      r = await this.#apply(verb, press.run.taskId, { kind: 'person', principal: by, runId: press.run.runId }, text);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.#note(`kanban: a press on card ${press.messageId} failed: ${redactKnownSecrets(detail)}`);
      await this.#redrawLive(press, `The board could not do that: ${label(detail, 600)}`);
      return;
    }
    if (!r.ok) {
      if (r.code === 'run_superseded') await this.#outOfDate(press, task);
      else await this.#redrawLive(press, refused(r));
      return;
    }
    this.#changed();
    const outcome = {
      done: `Done — by ${name}.`,
      approve: `Approved — by ${name}.`,
      block: `Blocked — by ${name}: ${label(text, 300)}`,
      changes: `Changes requested — by ${name}: ${label(text, 300)}`,
    }[verb];
    await this.#redraw(press.messageId, renderCardOutcome(task, outcome));
  }

  /** A card for a run that is over: redrawn so, and said so. */
  async #outOfDate(press: Press, task: { taskId: string; title: string }): Promise<string> {
    await this.#redraw(press.messageId, renderCardOutcome(task, 'This card is out of date: the task has moved on since it was sent.'));
    return outOfDate(task.taskId);
  }

  /** The card redrawn as it was, from the board as it is, with why the press did nothing, and buttons of the next attempt. */
  async #redrawLive(press: Press, note: string): Promise<void> {
    const reading = this.#deps.service.cardReading(press.run.runId);
    if (reading === undefined) return;
    // A run that ended meanwhile -- typed, stopped, reassigned -- has no card to press again.
    if (reading.run.endedAt !== null) {
      await this.#outOfDate(press, reading.task);
      return;
    }
    const facts: CardFacts = {
      ...reading,
      attempt: press.attempt,
      note: `**Not done.** ${note}`,
      nameOf: (p) => this.#deps.people.nameOf(p),
    };
    const view = press.run.kind === 'review' ? renderReviewCard(facts, this.#deps.appId) : renderTaskCard(facts, this.#deps.appId);
    await this.#redraw(press.messageId, { ...view, markdown: redactKnownSecrets(view.markdown) });
  }

  /** Background work, tracked so `idle()` -- and the gateway's stop -- can wait for it. */
  #track(work: Promise<void>): void {
    const tracked = work.catch((err: unknown) => this.#note(`kanban: ${redactKnownSecrets(err instanceof Error ? err.message : String(err))}`));
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }

  /**
   * The gateway is stopping: the gates of a report being made -- from a press or
   * typed -- are killed, and nothing is applied, as the worker socket's are; the
   * next report after a restart runs them again.
   */
  stop(): void {
    this.#stopping.abort();
  }

  /** Once no press is being worked on, or `boundMs` has passed: true once drained. */
  async idle(boundMs?: number): Promise<boolean> {
    const drained = (async () => {
      while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
      return true;
    })();
    if (boundMs === undefined) return drained;
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), boundMs);
    });
    try {
      return await Promise.race([drained, bound]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Undefined when this person may press this button of this run's card; otherwise why not. */
  #mayPress(verb: ReportCommand['verb'], run: RunRow, by: string, presser: Principal): string | undefined {
    const forWork = verb === 'done' || verb === 'block';
    if (forWork !== (run.kind === 'work')) return 'That button is not for this kind of card.';
    if (run.assignee.name === by) return undefined;
    if (!forWork && this.#deps.hasTier(presser, 'operate')) return undefined;
    return `This card is for ${this.#whom(run.assignee)}.`;
  }

  /**
   * Best effort: the board has the decision already, and the card is only a
   * picture of it. Bounded by `redrawTimeoutMs`: the SDK's card update has no
   * timeout of its own, and a redraw that never answered would hold the press
   * that waits for it -- and so its card, as being worked on -- until a restart.
   */
  async #redraw(messageId: string, view: CardView): Promise<void> {
    const redraw = this.#deps.redraw;
    if (redraw === undefined) return;
    const ms = this.#deps.redrawTimeoutMs ?? REDRAW_MS;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), ms);
    });
    const sent = redraw(messageId, view);
    try {
      if ((await Promise.race([sent.then(() => 'drawn' as const), late])) === 'late') {
        this.#note(`kanban: redrawing card ${messageId} took longer than ${ms} ms; going on without it`);
      }
    } catch (err) {
      this.#note(`kanban: redrawing card ${messageId} failed: ${redactKnownSecrets(err instanceof Error ? err.message : String(err))}`);
    } finally {
      clearTimeout(timer);
      sent.catch(() => undefined);
    }
  }

  /**
   * `/kanban new` (spec §9.1): created from this chat, which is subscribed to it.
   * The message id is the idempotency key, so a redelivery that got past the
   * router's own dedup still makes one task.
   */
  #create(command: NewTaskCommand, by: string, message: InboundMessage, key: BindingKey): string {
    const named: { assignee?: string; reviewer?: string } = {};
    for (const role of ['assignee', 'reviewer'] as const) {
      const name = command[role];
      if (name === undefined) continue;
      const n = this.#named(name, message);
      if (!n.ok) return n.reply;
      named[role] = n.name;
    }
    const tooBig = oversized(command);
    if (tooBig !== undefined) return tooBig;
    const r = this.#deps.service.create({
      title: command.title,
      ...(command.body === '' ? {} : { body: command.body }),
      contract: command.contract,
      ...named,
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
        ? 'nobody yet: `/kanban assign ' + task.taskId + ' <role or @person>` gives it to someone'
        : this.#whom(task.assignee);
    const card =
      task.assignee?.kind === 'human' ? ' They are sent it as a card, in a direct message, once it is ready.' : '';
    return (
      `Created ${id(task.taskId)} — **${label(task.title)}**, for ${whom}` +
      `${task.workspace === null ? '' : `, in ${label(task.workspace)}`}.${card} ` +
      'This chat hears when it is done, needs review, blocks, is retried after a failure, gives up or is stranded.'
    );
  }

  /**
   * The principal a name in chat stands for: an @-mention, found among the
   * message's mentions by the name Lark's text shows, or a principal typed out.
   * A bare word is a role, as typed. A person without talk tier is refused here,
   * by the name typed (spec §4.2); the service refuses them too, for its other
   * callers.
   */
  #named(name: string, message: InboundMessage): Named {
    if (!isPerson(name)) return { ok: true, name };
    const found = this.#mentioned(name, message);
    if (!found.ok) return found;
    if (!this.#deps.people.canTalk(found.name)) {
      return {
        ok: false,
        reply: `${label(name, 80)} cannot be given work: being assigned lets a person report on the task, which needs talk tier, and the gateway does not know them to have it.`,
      };
    }
    return found;
  }

  /** A person's principal: typed out, or the @-mention's, by the ids Lark sent with the message. */
  #mentioned(name: string, message: InboundMessage): Named {
    if (!name.startsWith('@')) return { ok: true, name: `lark:${name.slice('lark:'.length)}` };
    const shown = name.slice(1).trim();
    const found = (message.mentions ?? []).filter((m) => m.name === shown || m.key === name);
    const unionIds = [...new Set(found.map((m) => m.unionId).filter((u): u is string => u !== null))];
    if (found.length === 0) {
      return {
        ok: false,
        reply: `${label(name, 80)} is not someone this message mentions: type @ and pick them, so Lark says who they are.`,
      };
    }
    if (unionIds.length === 0) {
      return {
        ok: false,
        reply: `Lark did not say who ${label(name, 80)} is (no union_id came with the mention). Ask the operator to check the app can read user ids.`,
      };
    }
    if (unionIds.length > 1) {
      return { ok: false, reply: `More than one person mentioned is called ${label(name, 80)}; say which with \`lark:<union_id>\`.` };
    }
    return { ok: true, name: personPrincipal(unionIds[0] ?? '') };
  }

  /** A role, as a role; a person, by the name Lark last gave, with their principal. */
  #whom(a: Assignee): string {
    if (a.kind === 'role') return `role ${forDisplay(a.name)}`;
    const name = this.#deps.people.nameOf(a.name);
    return name === undefined ? label(a.name, 80) : `${label(name, 80)} (${label(a.name, 80)})`;
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


- [ ] **Step 8.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/kanban-chat.test.ts`. Expected: `Tests  29 passed (29)`.

- [ ] **Step 8.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1288 passed (1288)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  72 passed (72)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 8.6: Commit.**

```bash
git add src/index.ts src/kanban/chat-render.ts src/kanban/chat.ts tests/kanban-chat.e2e.ts tests/kanban-chat.test.ts
git commit -m "Give tasks to people named by @-mention in /kanban, take a named assignee's and reviewer's reports on the open run and their steering comments, and act on their cards' buttons in the background, redrawing a refused card live"
```

---

### Task 9: Routing a card's button by its kind

**Files:**
- Modify: `src/channel/lark/inbound.ts`, `src/core/router.ts`, `tests/lark-inbound.test.ts`, `tests/router.test.ts`

`Router.onCardAction` treated every press as an approval's, checking operator tier before it read the payload (spec §9.2; Decision 14). It now dispatches on the card's `kind` first: `kanban` goes to the board's `card()`, whose rules decide who may press -- a named assignee at talk tier may press Done -- its answer noted, masked; `approval`, or no kind, for cards posted before there was one, is an approval as before; any other kind is refused. The inbound side says nothing in the chat for a board card's press, whose card shows what happened (Decision 28): the router notes the board's answer, masked, and returns none. An approval's press is acknowledged as before, but after the handler has returned, unawaited and tracked by `idle()`, so the acknowledgement's retries never hold Lark's callback; that message's uuid keyed on the callback's token and what the box held, so a second press of one button is acknowledged too (Decisions 28, 30).

- [ ] **Step 9.1: Write the failing tests.**

Replace the whole of `tests/lark-inbound.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import type { CardActionEvent } from '@larksuiteoapi/node-sdk';
import type { LarkAdapter } from '../src/channel/lark/adapter.js';
import { LarkInbound, cardInput, clickUuid, mentionsOf } from '../src/channel/lark/inbound.js';
import type { InboundCardAction, Router } from '../src/core/router.js';

/**
 * What the Lark side reads from a raw event that the SDK's normalizer drops: the
 * union_ids of the people a message mentions, which is how the board knows a
 * person (spec §9.1), and the text a card's box held when its button was pressed.
 */

const BOT = 'ou_bot';

function raw(mentions: unknown): unknown {
  return { sender: { sender_id: { union_id: 'on_sender' } }, message: { message_id: 'om_1', mentions } };
}

describe('mentionsOf', () => {
  it("gives each person's key, name and ids, leaving out the bot and @all", () => {
    expect(
      mentionsOf(
        raw([
          { key: '@_user_1', name: 'Bot', id: { open_id: BOT, union_id: 'on_bot' } },
          { key: '@_user_2', name: 'Alice Smith', id: { open_id: 'ou_alice', union_id: 'on_alice' } },
          { key: '@_all', name: 'Everyone', id: {} },
          { key: '@_user_3', id: { open_id: 'ou_bob' } },
        ]),
        BOT,
      ),
    ).toEqual([
      { key: '@_user_2', name: 'Alice Smith', openId: 'ou_alice', unionId: 'on_alice' },
      { key: '@_user_3', name: null, openId: 'ou_bob', unionId: null },
    ]);
  });

  it('is empty for an event without mentions, or with anything else in their place', () => {
    expect(mentionsOf(raw(undefined), BOT)).toEqual([]);
    expect(mentionsOf(undefined, BOT)).toEqual([]);
    expect(mentionsOf(raw('@_user_1'), BOT)).toEqual([]);
    expect(mentionsOf(raw([null, 'x', { name: 'no key' }]), BOT)).toEqual([]);
  });
});

describe('cardInput', () => {
  it("is what the card's box named text held", () => {
    expect(cardInput({ action: { value: {}, form_value: { text: 'shipped it' } } })).toEqual({ input: 'shipped it' });
    expect(cardInput({ action: { form_value: { text: '' } } })).toEqual({ input: '' });
  });

  it('is nothing for a button that submitted no form', () => {
    expect(cardInput({ action: { value: {} } })).toEqual({});
    expect(cardInput({ action: { form_value: { other: 'x' } } })).toEqual({});
    expect(cardInput(undefined)).toEqual({});
  });
});

describe('clickUuid', () => {
  const press = (token: string): CardActionEvent => ({
    messageId: 'om_card',
    chatId: 'oc_dm',
    operator: { openId: 'ou_alice' },
    action: { value: { kind: 'kanban', act: 'block' }, tag: 'button' },
    raw: { token },
  });

  it("is the same for a re-delivered press, and differs for another press of the same button, or another box's text", () => {
    expect(clickUuid('cli_app', press('t1'), 'x')).toBe(clickUuid('cli_app', press('t1'), 'x'));
    expect(clickUuid('cli_app', press('t1'), 'x')).toHaveLength(50);
    expect(clickUuid('cli_app', press('t2'), 'x')).not.toBe(clickUuid('cli_app', press('t1'), 'x'));
    expect(clickUuid('cli_app', press('t1'), 'y')).not.toBe(clickUuid('cli_app', press('t1'), 'x'));
    expect(clickUuid('cli_app', press('t1'), undefined)).not.toBe(clickUuid('cli_app', press('t1'), 'x'));
  });
});

describe('LarkInbound, on a button press', () => {
  /** An inbound side over stand-ins: the SDK's channel captures its handlers, and nothing reaches Lark. */
  function inbound(answer: string | undefined): {
    press: (evt: CardActionEvent) => Promise<void>;
    sent: string[];
    release: () => void;
    inbound: LarkInbound;
  } {
    let handlers: { cardAction?: (evt: CardActionEvent) => Promise<void> } = {};
    const sent: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const adapter = {
      raw: { on: (h: typeof handlers) => ((handlers = h), () => undefined) },
      botOpenId: 'ou_bot',
      sendText: async (_target: unknown, text: string) => {
        await held;
        sent.push(text);
        return { messageId: 'om_ack', deduped: false };
      },
    } as unknown as LarkAdapter;
    const router = { onCardAction: async (_a: InboundCardAction) => answer } as unknown as Router;
    const i = new LarkInbound({ adapter, router, config: { appId: 'cli_app', downloadDir: '/nonexistent' } });
    i.start();
    return { press: (evt) => handlers.cardAction?.(evt) ?? Promise.resolve(), sent, release, inbound: i };
  }

  const evt: CardActionEvent = {
    messageId: 'om_card',
    chatId: 'oc_team',
    operator: { openId: 'ou_owner' },
    action: { value: { kind: 'approval' }, tag: 'button' },
  };

  it("returns before an approval's acknowledgement is sent, and is idle once it is", async () => {
    const i = inbound('Sent: Deny.');
    // Returns although the send is held: the SDK answers Lark's callback only once this has.
    await i.press(evt);
    expect(i.sent).toEqual([]);
    expect(await i.inbound.idle(20)).toBe(false);
    i.release();
    expect(await i.inbound.idle(1_000)).toBe(true);
    expect(i.sent).toEqual(['Sent: Deny.']);
  });

  it("sends nothing for a board card's press", async () => {
    const i = inbound(undefined);
    i.release();
    await i.press(evt);
    expect(await i.inbound.idle(1_000)).toBe(true);
    expect(i.sent).toEqual([]);
  });
});
```

In `tests/router.test.ts`, replace:

```ts
import { ACK_EMOJI, KANBAN_OFF, Router, type KanbanCommands } from '../src/core/router.js';
```

with:

```ts
import { ACK_EMOJI, KANBAN_OFF, Router, type InboundCardAction, type KanbanCommands } from '../src/core/router.js';
```

In `tests/router.test.ts`, replace:

```ts
      },
    };
```

with:

```ts
      },
      card: async () => answer('card'),
    };
```

In `tests/router.test.ts`, replace:

```ts
  });

  it('requires operator tier to answer, the same as the equivalent command', async () => {
    const h = harness({
```

with:

```ts
  });

  it("hands a board card's button to the board, whatever the presser's tier, posting nothing and noting its answer masked", async () => {
    addSecrets(['sk-card-12345678']);
    const pressed: InboundCardAction[] = [];
    const h = harness({
      auth: { allowTalk: [OWNER.openId, GUEST.openId], allowOperate: [OWNER.openId] },
      kanban: {
        run: async () => 'unused',
        card: async (action) => {
          pressed.push(action);
          return 'Done: `k_1` is complete, sk-card-12345678';
        },
      },
    });
    const action = { chatId: CHAT, messageId: 'om_card', operator: GUEST, value: { kind: 'kanban', act: 'done' }, input: 'all fine' };
    // A named assignee at talk tier may press Done: the board's rules, not operator tier, decide (spec §9.2).
    // The card shows the outcome: nothing is said in the chat.
    expect(await h.router.onCardAction(action)).toBeUndefined();
    expect(pressed).toEqual([action]);
    expect(h.notes).toContain(`kanban card on om_card: Done: \`k_1\` is complete, ${MASK}`);
    clearSecrets();
  });

  it('notes a board card pressed with the board off, posting nothing, and refuses a kind it does not know', async () => {
    const h = harness();
    const value = { kind: 'kanban', act: 'done' };
    expect(await h.router.onCardAction({ chatId: CHAT, messageId: 'om_card', operator: OWNER, value })).toBeUndefined();
    expect(h.notes).toContain('kanban card on om_card pressed with the board off');
    expect(await h.router.onCardAction({ chatId: CHAT, messageId: 'om_card', operator: OWNER, value: { kind: 'poll' } })).toBe(
      'That button is not one this gateway knows.',
    );
  });

  it("notes a board card's button that throws, masked, and posts nothing", async () => {
    const h = harness({
      kanban: {
        run: async () => 'unused',
        card: async () => {
          throw new Error('database_locked\nsecond line');
        },
      },
    });
    const reply = await h.router.onCardAction({ chatId: CHAT, messageId: 'om_card', operator: OWNER, value: { kind: 'kanban' } });
    expect(reply).toBeUndefined();
    expect(h.notes.some((n) => n.includes('kanban card on om_card failed'))).toBe(true);
  });

  it("answers an approval's button that says it is one, as one without a kind", async () => {
    const h = harness();
    const state = await ask(h);
    const reply = await h.router.onCardAction({ ...click(state.approvalId, 'deny', state.nonce), value: { kind: 'approval', approvalId: state.approvalId, optionId: 'deny', nonce: state.nonce } });
    expect(reply).toBe('Sent: Deny.');
  });

  it('requires operator tier to answer, the same as the equivalent command', async () => {
    const h = harness({
```


- [ ] **Step 9.2: Run them to verify they fail.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` and then `npx vitest run --project unit tests/router.test.ts tests/lark-inbound.test.ts`. Expected: six FAIL: a board card's button is taken for an approval's — refused for its missing payload, or for operator tier — and an unknown kind is too; `clickUuid` is not a function; and the inbound side holds a press until its acknowledgement is sent, and has no `idle`. `Tests  6 failed | 73 passed (79)`.

- [ ] **Step 9.3: Implement.**

In `src/channel/lark/inbound.ts`, replace:

```ts
  readonly #note: (line: string) => void;
  #unsubscribe: (() => void) | undefined;

  constructor(deps: LarkInboundDeps) {
```

with:

```ts
  readonly #note: (line: string) => void;
  #unsubscribe: (() => void) | undefined;
  /** Approvals' acknowledgements being sent. */
  readonly #acks = new Set<Promise<void>>();

  constructor(deps: LarkInboundDeps) {
```

In `src/channel/lark/inbound.ts`, replace:

```ts
   * **Known gap.** Feishu allows a callback response body within three seconds,
   * which is how a click produces a toast. The SDK's high-level `Channel` module
   * acknowledges the event itself and discards this handler's return value, so the
   * toast is unreachable from here. The outcome is therefore posted as a message in
   * the thread instead. That is slower and noisier, and also durable and visible to
   * everyone who can see the card -- which for an authorization decision is
   * arguably the better record. It is a deviation from the design either way, and a
   * small change once the SDK exposes a response channel.
```

with:

```ts
   * **The callback waits for this.** The SDK answers Lark's callback only once
   * this handler returns, and Lark waits about three seconds for the answer. So
   * the handler returns as soon as the router has: a board card's press is shown
   * on its card, and posts nothing (spec §9.2); an approval's acknowledgement is a
   * message of its own, sent after, unawaited, and tracked so `idle()` can wait
   * for it at shutdown.
   *
   * **Known gap.** The SDK discards this handler's return value, so a toast -- a
   * callback's own response body -- is unreachable from here; an approval's
   * outcome is posted as a message in the chat instead, durable and visible to
   * everyone who can see the card.
```

In `src/channel/lark/inbound.ts`, replace:

```ts
    const outcome = await this.#deps.router.onCardAction(action);
    try {
```

with:

```ts
    const outcome = await this.#deps.router.onCardAction(action);
    // A board card's press is acknowledged by its card, not in the chat (spec §9.2).
    if (outcome === undefined) return;
    const ack = this.#acknowledge(evt, action, outcome);
    this.#acks.add(ack);
    void ack.finally(() => this.#acks.delete(ack));
  }

  /**
   * Once every acknowledgement being sent has been, or `boundMs` has passed: for
   * shutdown, before the channel disconnects. True once drained.
   */
  async idle(boundMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), boundMs);
    });
    try {
      return await Promise.race([Promise.allSettled([...this.#acks]).then(() => true), bound]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** An approval's acknowledgement; never rejects. */
  async #acknowledge(evt: CardActionEvent, action: InboundCardAction, outcome: string): Promise<void> {
    try {
```

In `src/channel/lark/inbound.ts`, replace:

```ts
        clickUuid(this.#deps.config.appId, evt),
```

with:

```ts
        clickUuid(this.#deps.config.appId, evt, action.input),
```

In `src/channel/lark/inbound.ts`, replace:

```ts
  operator?: { union_id?: string };
}
```

with:

```ts
  operator?: { union_id?: string };
  /** Lark's token for this one callback: a new press has a new one, a re-delivery the same. */
  token?: string;
}
```

In `src/channel/lark/inbound.ts`, replace:

```ts
function clickUuid(appId: string, evt: CardActionEvent): string {
  const canonical = `${appId} ${evt.messageId} ${evt.operator.openId} ${JSON.stringify(evt.action.value ?? null)}`;
```

with:

```ts
/**
 * The uuid of a click's acknowledgement. Lark sends one message per uuid for an
 * hour, so two presses of one button -- a Block refused for an empty box, then
 * pressed with a reason -- must not share one: the callback's own token, which a
 * re-delivery of the same press keeps, and what the box held, are part of it.
 */
export function clickUuid(appId: string, evt: CardActionEvent, input: string | undefined): string {
  const token = asRawCardAction(evt.raw)?.token ?? '';
  const canonical = [appId, evt.messageId, evt.operator.openId, JSON.stringify(evt.action.value ?? null), token, input ?? ''].join(
    '\u0000',
  );
```

In `src/core/router.ts`, replace:

```ts
 * message that typed it, answered as the reply to send. Plan D1's `KanbanChat`.
```

with:

```ts
 * message that typed it, answered as the reply to send; and a press of a board
 * card's button (spec §9.2), answered the same way. `KanbanChat`.
```

In `src/core/router.ts`, replace:

```ts
  run(arg: string, message: InboundMessage, key: BindingKey): Promise<string>;
}
```

with:

```ts
  run(arg: string, message: InboundMessage, key: BindingKey): Promise<string>;
  card(action: InboundCardAction): Promise<string>;
}
```

In `src/core/router.ts`, replace:

```ts
   * Handle a button click. Returns the toast text.
```

with:

```ts
   * Handle a button click. Returns the text to acknowledge it with in the chat,
   * or undefined for a board card's, whose card shows the outcome itself (spec §9.2).
```

In `src/core/router.ts`, replace:

```ts
  async onCardAction(action: InboundCardAction): Promise<string> {
```

with:

```ts
  async onCardAction(action: InboundCardAction): Promise<string | undefined> {
    // The card's kind first (spec §9.2), then that kind's authorization: the board's
    // rules for a board card, under which a named assignee at talk tier may press
    // Done; operator tier for an approval. A card posted before cards said which
    // they are is an approval's.
    const kind = action.value['kind'];
    if (kind === 'kanban') return this.#boardCard(action);
    if (kind !== undefined && kind !== 'approval') return 'That button is not one this gateway knows.';

```

In `src/core/router.ts`, replace:

```ts
    return report.message;
  }
```

with:

```ts
    return report.message;
  }

  /**
   * A board card's button, for the board to authorize and act on. Nothing is
   * posted in the chat: the card shows what happened -- "Working on it…", then the
   * outcome, or why the press did nothing -- and the board's answer is noted,
   * masked, for a press the card cannot show, such as someone else's.
   */
  async #boardCard(action: InboundCardAction): Promise<undefined> {
    const kanban = this.#deps.kanban;
    if (kanban === undefined) {
      this.#note(`kanban card on ${action.messageId} pressed with the board off`);
      return undefined;
    }
    try {
      const answer = Array.from(redactKnownSecrets(await kanban.card(action)).replace(/\s+/g, ' ').trim()).slice(0, 300).join('');
      this.#note(`kanban card on ${action.messageId}: ${answer}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.#note(`kanban card on ${action.messageId} failed: ${redactKnownSecrets(detail)}`);
    }
    return undefined;
  }
```


- [ ] **Step 9.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/router.test.ts tests/lark-inbound.test.ts`. Expected: `Tests  79 passed (79)`.

- [ ] **Step 9.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1295 passed (1295)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  72 passed (72)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 9.6: Commit.**

```bash
git add src/channel/lark/inbound.ts src/core/router.ts tests/lark-inbound.test.ts tests/router.test.ts
git commit -m "Dispatch a card's button on its kind, the board's own rules for a board card and operator tier for an approval, and acknowledge an approval's press after the callback is answered, keyed on the press"
```

---

### Task 10: Sending people their cards

**Files:**
- Create: `src/kanban/cards.ts`, `tests/kanban-cards.test.ts`
- Modify: `tests/helpers/dispatch.ts`

`CardPoster` sends a person's run its card as a direct message when the run is claimed, from the board (spec §9.2; Decision 11): every 2 s a round reads `cardsDue`, renders each run's task or review card from the board as it is, sends it by union_id with the run's one uuid, masked once more as a whole, and records `card_sent`. Lark refusing because it cannot reach the person -- `PERSON_UNREACHABLE_CODES` -- and a person who no longer has talk tier, record `card_failed`, which the task's subscribers hear, and are not tried again; any other refusal or failure is taken for the gateway's, tried again after a pause that doubles to five minutes. A card sent and not recorded is not sent again until a restart. A restart sends again only a card that was not recorded, with the same uuid. A person's run is claimed by the dispatcher's pass as before, holds no workspace and no agent slot, and parks past any runtime limit (spec §4.2), which a dispatcher test now shows.

- [ ] **Step 10.1: Write the failing tests.**

In `tests/helpers/dispatch.ts`, replace:

```ts
import { KanbanService, type CreateRequest, type ReportChecks } from '../../src/kanban/service.js';
```

with:

```ts
import { KanbanService, type CreateRequest, type People, type ReportChecks } from '../../src/kanban/service.js';
```

In `tests/helpers/dispatch.ts`, replace:

```ts
  checks?: ReportChecks;
}
```

with:

```ts
  checks?: ReportChecks;
  /** Who the board may give work to; absent, no person. */
  people?: People;
}
```

In `tests/helpers/dispatch.ts`, replace:

```ts
    ...(opts.checks === undefined ? {} : { checks: opts.checks }),
  });
```

with:

```ts
    ...(opts.checks === undefined ? {} : { checks: opts.checks }),
    ...(opts.people === undefined ? {} : { people: opts.people }),
  });
```

Create `tests/kanban-cards.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelError } from '../src/channel/types.js';
import { boardCardUuid } from '../src/core/ids.js';
import { cardsDue, eventsOf, getRun, runsOf } from '../src/db/kanban-read.js';
import { CARD_BACKOFF_MAX_MS, CardPoster } from '../src/kanban/cards.js';
import { KanbanService, type CreateRequest } from '../src/kanban/service.js';
import type { RunRow, TaskRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES, dispatchHarness } from './helpers/dispatch.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * A person's cards (spec §9.2): sent as a direct message by union_id when their
 * run is claimed, recorded once, sent again after a restart only if they were
 * not recorded, with the same uuid; a card Lark refuses for good recorded, for
 * its subscribers to hear; an outage tried again after a pause.
 */

const BOB = 'lark:on_bob';

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
    people: { canTalk: (p) => p === ALICE || p === BOB },
  });
  lark = new FakeChannel({ id: 'lark', clock });
  notes = [];
});
afterEach(() => {
  clearSecrets();
  t.close();
});

function poster(opts: { canTalk?: (p: string) => boolean } = {}): CardPoster {
  return new CardPoster({
    ...(opts.canTalk === undefined ? {} : { canTalk: opts.canTalk }),
    db: t.db,
    service,
    channel: lark,
    appId: 'cli_app',
    nameOf: (p) => (p === BOB ? 'Bob' : undefined),
    clock,
    note: (line) => notes.push(line),
  });
}

function create(req: Partial<CreateRequest> = {}): TaskRow {
  const r = service.create({ title: 'Check the links', assignee: ALICE, createdBy: BOB, createdVia: VIA, ...req });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.task;
}

function claim(taskId: string): RunRow {
  const r = service.claim(taskId);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.run;
}

describe('CardPoster', () => {
  it("sends a person's run its task card by union_id, records it once, and sends nothing more", async () => {
    addSecrets(['sk-body-12345678']);
    const task = create({ body: 'the key is sk-body-12345678' });
    const run = claim(task.taskId);
    const p = poster();
    expect(await p.deliver()).toBe(1);
    expect(lark.boardCards).toHaveLength(1);
    const card = lark.boardCards[0]!;
    expect(card.target).toEqual({ chatId: 'on_alice', threadId: '', receiveIdType: 'union_id' });
    expect(card.uuid).toBe(boardCardUuid('cli_app', run.runId));
    expect(card.view.markdown).toContain(`📋 **Check the links** \`${task.taskId}\` — for you to do`);
    expect(card.view.markdown).toContain(`> the key is ${MASK}`);
    expect(card.view.buttons.map((b) => b.label)).toEqual(['Done', 'Block']);
    expect(eventsOf(t.db, task.taskId).at(-1)).toMatchObject({ kind: 'card_sent', runId: run.runId, payload: { messageId: 'om_board_1' } });
    expect(await p.deliver()).toBe(0);
    expect(lark.boardCards).toHaveLength(1);
  });

  it("sends a person's review its review card, with the reviewer's rework after changes on the next task card", async () => {
    const task = create({ reviewer: BOB });
    const work = claim(task.taskId);
    expect((await service.requestReview(task.taskId, { kind: 'person', principal: ALICE, runId: work.runId }, { summary: 'all answer' })).ok).toBe(
      true,
    );
    const review = claim(task.taskId);
    const p = poster();
    await p.deliver();
    const card = lark.boardCards.at(-1)!;
    expect(card.target.chatId).toBe('on_bob');
    expect(card.view.markdown).toContain('— for you to review');
    expect(card.view.markdown).toContain('**The handoff**, from lark:on\\_alice:\n> all answer');
    expect(card.view.buttons.map((b) => b.value['run'])).toEqual([review.runId, review.runId]);
    expect(service.requestChanges(task.taskId, { kind: 'person', principal: BOB, runId: review.runId }, 'cite them').ok).toBe(true);
    claim(task.taskId);
    await p.deliver();
    expect(lark.boardCards.at(-1)?.view.markdown).toContain('**Changes asked** by Bob:\n> cite them');
  });

  it('sends no card for an agent run', async () => {
    const task = create({ assignee: 'implementer' });
    claim(task.taskId);
    expect(await poster().deliver()).toBe(0);
    expect(lark.boardCards).toEqual([]);
  });

  it('records a card Lark refuses for good, once, and never sends it again', async () => {
    const task = create();
    const run = claim(task.taskId);
    lark.failNext('sendCard', new ChannelError(230013, 'Bot has NO availability to this user', false));
    const p = poster();
    expect(await p.deliver()).toBe(0);
    expect(eventsOf(t.db, task.taskId).at(-1)).toMatchObject({
      kind: 'card_failed',
      runId: run.runId,
      payload: { kind: 'work', to: ALICE, error: 'Bot has NO availability to this user (code 230013)' },
    });
    expect(cardsDue(t.db)).toEqual([]);
    clock.advance(CARD_BACKOFF_MAX_MS);
    expect(await p.deliver()).toBe(0);
    expect(lark.calls.filter((c) => c === 'sendCard')).toHaveLength(1);
    expect(notes.some((n) => n.includes(`the card of run ${run.runId} cannot be sent`))).toBe(true);
  });

  it("takes any other refusal for the gateway's problem: a scope Lark refuses, or a bad request, is tried again", async () => {
    const task = create();
    const run = claim(task.taskId);
    lark.failNext('sendCard', new ChannelError(99991672, 'Access denied: scope missing', false));
    lark.failNext('sendCard', new ChannelError(400, 'Bad Request', false));
    const p = poster();
    expect(await p.deliver()).toBe(0);
    clock.advance(2_000);
    expect(await p.deliver()).toBe(0);
    clock.advance(4_000);
    expect(await p.deliver()).toBe(1);
    expect(eventsOf(t.db, task.taskId).some((e) => e.kind === 'card_failed')).toBe(false);
    expect(notes.filter((n) => n.startsWith(`kanban: the card of run ${run.runId} was not sent`))).toHaveLength(2);
  });

  it('sends no card to a person who no longer has talk tier, and records why', async () => {
    const task = create();
    const run = claim(task.taskId);
    expect(await poster({ canTalk: () => false }).deliver()).toBe(0);
    expect(lark.boardCards).toEqual([]);
    expect(eventsOf(t.db, task.taskId).at(-1)).toMatchObject({
      kind: 'card_failed',
      runId: run.runId,
      payload: { error: `${ALICE} no longer has talk tier on this gateway` },
    });
  });

  it('sends a card that could not be recorded once, and not again until a restart, saying so once', async () => {
    const task = create();
    const run = claim(task.taskId);
    // A board that will not take the record: the database locked, say.
    service.recordCard = () => ({ ok: false, code: 'invalid', message: 'locked' });
    const p = poster();
    expect(await p.deliver()).toBe(1);
    clock.advance(CARD_BACKOFF_MAX_MS);
    expect(await p.deliver()).toBe(0);
    expect(lark.boardCards).toHaveLength(1);
    expect(notes.filter((n) => n.includes(`the card of run ${run.runId} was sent, and not recorded`))).toHaveLength(1);
  });

  it('tries a card again after an outage, the pause doubling, and sends it once it can', async () => {
    const task = create();
    claim(task.taskId);
    lark.failNext('sendCard', new ChannelError(0, 'socket hang up', false));
    lark.failNext('sendCard', new ChannelError(500, 'internal error', true));
    const p = poster();
    expect(await p.deliver()).toBe(0);
    // Held back 2 s.
    clock.advance(1_000);
    expect(await p.deliver()).toBe(0);
    expect(lark.calls.filter((c) => c === 'sendCard')).toHaveLength(1);
    clock.advance(1_000);
    expect(await p.deliver()).toBe(0);
    // Then 4 s.
    clock.advance(3_000);
    expect(await p.deliver()).toBe(0);
    clock.advance(1_000);
    expect(await p.deliver()).toBe(1);
    expect(lark.boardCards).toHaveLength(1);
    expect(eventsOf(t.db, task.taskId).some((e) => e.kind === 'card_failed')).toBe(false);
  });

  it('after a restart, sends again only a card that was not recorded, with the same uuid', async () => {
    const sentBefore = create({ title: 'Sent before' });
    const sentRun = claim(sentBefore.taskId);
    await poster().deliver();
    // A card sent just before a stop, and not recorded: the send outlives the process.
    const unsent = create({ title: 'Not recorded' });
    const unsentRun = claim(unsent.taskId);
    const first = lark.boardCards.length;
    // A new poster is a new process: it knows only what the database does.
    await poster().deliver();
    expect(lark.boardCards.slice(first).map((c) => c.uuid)).toEqual([boardCardUuid('cli_app', unsentRun.runId)]);
    expect(lark.boardCards.map((c) => c.uuid)).not.toContain(undefined);
    expect(lark.boardCards.filter((c) => c.uuid === boardCardUuid('cli_app', sentRun.runId))).toHaveLength(1);
  });
});

describe("a person's run, as the dispatcher has it", () => {
  it('is claimed by a pass, holds no workspace and no agent slot, and waits past any runtime limit', async () => {
    const h = dispatchHarness({ people: { canTalk: (p) => p === ALICE }, settings: { maxRunning: 1, defaultMaxRuntimeS: 60 } });
    try {
      const person = h.create({ title: 'Read the draft', assignee: ALICE, workspace: 'web' });
      const agent = h.create({ title: 'Fix the footer', workspace: 'web' });
      const held = h.driver('implementer').scripts;
      held.push(async () => new Promise<void>(() => undefined));
      h.dispatcher.pass();
      await h.dispatcher.idle(50);
      const [personRun] = runsOf(h.t.db, person.taskId);
      expect(personRun).toMatchObject({ kind: 'work', assignee: { kind: 'human', name: ALICE }, sessionId: null, outcome: null });
      // The agent's task in the same workspace was claimed beside it.
      expect(runsOf(h.t.db, agent.taskId)).toHaveLength(1);
      h.clock.advance(10 * 60_000);
      h.dispatcher.sweep();
      // A person taking a day is not a failure: the run parks.
      expect(getRun(h.t.db, personRun!.runId)).toMatchObject({ outcome: null, endedAt: null });
    } finally {
      h.dispatcher.stop();
      await h.registry.closeAll();
      h.close();
    }
  });
});
```


- [ ] **Step 10.2: Run them to verify they fail.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` and then `npx vitest run --project unit tests/kanban-cards.test.ts`. Expected: the file FAILS to load, with `Error: Cannot find module '../src/kanban/cards.js'`. `Tests  no tests`.

- [ ] **Step 10.3: Implement.**

Create `src/kanban/cards.ts`:

```ts
import { ChannelError, personTarget, type Channel } from '../channel/types.js';
import { boardCardUuid } from '../core/ids.js';
import { cardsDue } from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import { redactKnownSecrets } from '../secrets.js';
import { systemClock, type Clock } from '../time.js';
import { renderReviewCard, renderTaskCard, type CardFacts, type NameOf } from './chat-render.js';
import { unionIdOf } from './people.js';
import type { KanbanService } from './service.js';
import type { RunRow } from './types.js';

/**
 * A person's cards (spec §9.2): when a person's run is claimed -- a task ready
 * for its assignee, or a review for its reviewer -- they are sent its card as a
 * direct message, by union_id, so they need not have opened a chat with the bot.
 *
 * **From the board, like the notices.** A round reads the open people's runs
 * that have no card recorded, sends each its card, and records `card_sent` with
 * the message, through the service. A run's card has one uuid, so one sent just
 * before a stop, and not yet recorded, is one message when it is sent again
 * after the restart. Every `CARD_POLL_MS`, one round at a time.
 *
 * **A card that cannot be sent.** Lark refusing because it cannot reach the
 * person -- one of `PERSON_UNREACHABLE_CODES` -- and a person who no longer has
 * talk tier, are recorded as `card_failed`, which the task's subscribers hear,
 * with how the person can answer from a chat instead; the run stays open, and is
 * never sent another card. Anything else -- any other refusal, a scope or token
 * Lark refuses among them, a network failure, a throttle that outlasted the
 * adapter's retries, a send not answered in `CARD_SEND_MS` -- is taken for the
 * gateway's problem, not the person's: the run is tried again after a pause that
 * doubles to five minutes, with a log line, for as long as it lasts.
 *
 * **A card sent and not recorded** is not sent again, in a loop that would
 * outlast the uuid's hour: the run is passed over until a restart, said once.
 */

/** How often a round looks for cards to send. */
export const CARD_POLL_MS = 2_000;
/** The longest a run whose card could not be sent waits before it is tried again. */
export const CARD_BACKOFF_MAX_MS = 5 * 60_000;
/** The longest a send is waited for; past it, it counts as the gateway's failure. */
export const CARD_SEND_MS = 30_000;

/**
 * Lark's codes for a person a message cannot reach, which retrying cannot change:
 * the only refusals that record `card_failed`. 230013 is "the bot has no
 * availability to this user": the person is outside the app's availability. It
 * is from Lark's documentation of sending a message, not confirmed against
 * anything in this repository or its SDK.
 */
export const PERSON_UNREACHABLE_CODES: ReadonlySet<number> = new Set([230013]);

export interface CardPosterDeps {
  db: Db;
  service: KanbanService;
  /** The Lark adapter: a person's direct messages. */
  channel: Channel;
  /** This bot: a card's uuid and its buttons' nonces are bound to it. */
  appId: string;
  /** What a card calls a person, by the name Lark last gave. */
  nameOf?: NameOf;
  /** Whether a person still has talk tier: one who lost it is sent no card (spec §4.2). */
  canTalk?: (principal: string) => boolean;
  clock?: Clock;
  /** Metadata only: ids, never task text. */
  note?: (line: string) => void;
  /** How long a send is waited for; `CARD_SEND_MS` unless a test says otherwise. */
  sendTimeoutMs?: number;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class CardPoster {
  readonly #deps: CardPosterDeps;
  readonly #clock: Clock;
  readonly #note: (line: string) => void;
  /** Runs held back after a failed send, by run id: until when, and the pause that was. */
  readonly #backoff = new Map<string, { until: number; waitMs: number }>();
  /** Runs whose card was sent and could not be recorded: passed over until a restart. */
  readonly #unrecorded = new Set<string>();
  #round: Promise<number> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(deps: CardPosterDeps) {
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

  /** Send every `CARD_POLL_MS`, starting now: the first round sends what a restart left unsent. */
  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setInterval(() => void this.deliver(), CARD_POLL_MS);
    this.#timer.unref();
    void this.deliver();
  }

  /** No more rounds; one under way stops after its current send. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Once the round under way, if any, is over, or `boundMs` has passed: for shutdown. */
  async idle(boundMs = this.#deps.sendTimeoutMs ?? CARD_SEND_MS): Promise<boolean> {
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

  /** One round, or the one already under way; resolves to the cards sent. Never rejects. */
  deliver(): Promise<number> {
    if (this.#round !== undefined) return this.#round;
    const round = this.#deliverOnce()
      .catch((err: unknown) => {
        this.#note(`kanban: sending cards failed: ${message(err)}`);
        return 0;
      })
      .finally(() => {
        this.#round = undefined;
      });
    this.#round = round;
    return round;
  }

  async #deliverOnce(): Promise<number> {
    let sent = 0;
    for (const run of cardsDue(this.#deps.db)) {
      if (this.#stopped) break;
      if (this.#unrecorded.has(run.runId)) continue;
      const held = this.#backoff.get(run.runId);
      if (held !== undefined && this.#clock.now() < held.until) continue;
      try {
        if (await this.#post(run)) sent += 1;
      } catch (err) {
        // One run's failure -- a read, a render -- is that run's.
        this.#holdBack(run, message(err));
      }
    }
    return sent;
  }

  /** Send one run its card, and record it; true once it was sent. */
  async #post(run: RunRow): Promise<boolean> {
    const unionId = unionIdOf(run.assignee.name);
    if (unionId === undefined) {
      this.#refused(run, `${run.assignee.name} is not a person Lark can be asked to message`);
      return false;
    }
    if (this.#deps.canTalk !== undefined && !this.#deps.canTalk(run.assignee.name)) {
      this.#refused(run, `${run.assignee.name} no longer has talk tier on this gateway`);
      return false;
    }
    const view = this.#render(run);
    if (view === undefined) return false;
    let messageId: string;
    try {
      const sent = await this.#bounded(
        this.#deps.channel.sendCard(
          personTarget(unionId),
          // Masked once more as a whole, as every reply and notice is (spec §9.3).
          { ...view, markdown: redactKnownSecrets(view.markdown) },
          boardCardUuid(this.#deps.appId, run.runId),
        ),
      );
      messageId = sent.messageId;
    } catch (err) {
      if (err instanceof ChannelError && PERSON_UNREACHABLE_CODES.has(err.code)) {
        this.#refused(run, message(err));
      } else {
        this.#holdBack(run, message(err));
      }
      return false;
    }
    this.#backoff.delete(run.runId);
    let why: string | undefined;
    try {
      const recorded = this.#deps.service.recordCard(run.runId, { messageId });
      if (!recorded.ok) why = recorded.code;
    } catch (err) {
      why = message(err);
    }
    if (why !== undefined) {
      this.#unrecorded.add(run.runId);
      this.#note(`kanban: the card of run ${run.runId} was sent, and not recorded (${why}); not sending it again until the gateway restarts`);
    }
    return true;
  }

  /** The run's card, from the board as it is now; undefined when its task is gone. */
  #render(run: RunRow): ReturnType<typeof renderTaskCard> | undefined {
    const reading = this.#deps.service.cardReading(run.runId);
    if (reading === undefined) return undefined;
    const facts: CardFacts = { ...reading, ...(this.#deps.nameOf === undefined ? {} : { nameOf: this.#deps.nameOf }) };
    return run.kind === 'review' ? renderReviewCard(facts, this.#deps.appId) : renderTaskCard(facts, this.#deps.appId);
  }

  /** A card Lark will not take: recorded once, which its subscribers hear, and never sent again. */
  #refused(run: RunRow, why: string): void {
    this.#backoff.delete(run.runId);
    const recorded = this.#deps.service.recordCard(run.runId, { error: why });
    this.#note(
      recorded.ok
        ? `kanban: the card of run ${run.runId} cannot be sent (${why}); its subscribers are told`
        : `kanban: the card of run ${run.runId} cannot be sent (${why}), and that was not recorded (${recorded.code})`,
    );
  }

  /** Held back for a pause that doubles from 2 s to five minutes, and said so. */
  #holdBack(run: RunRow, why: string): void {
    const waitMs = Math.min((this.#backoff.get(run.runId)?.waitMs ?? CARD_POLL_MS / 2) * 2, CARD_BACKOFF_MAX_MS);
    this.#backoff.set(run.runId, { until: this.#clock.now() + waitMs, waitMs });
    this.#note(`kanban: the card of run ${run.runId} was not sent (${why}); trying again in ${Math.round(waitMs / 1000)} s`);
  }

  /** A send, waited for at most `sendTimeoutMs`; a slow one may still land, which its uuid makes one message. */
  async #bounded<T>(send: Promise<T>): Promise<T> {
    const ms = this.#deps.sendTimeoutMs ?? CARD_SEND_MS;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      const took = ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
      timer = setTimeout(() => reject(new Error(`the send took longer than ${took}`)), ms);
    });
    try {
      return await Promise.race([send, late]);
    } finally {
      clearTimeout(timer);
      send.catch(() => undefined);
    }
  }
}
```


- [ ] **Step 10.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/kanban-cards.test.ts`. Expected: `Tests  10 passed (10)`.

- [ ] **Step 10.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1305 passed (1305)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  72 passed (72)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 10.6: Commit.**

```bash
git add src/kanban/cards.ts tests/helpers/dispatch.ts tests/kanban-cards.test.ts
git commit -m "Send a person's run its task or review card as a direct message, from the board, recording it once, and report to the task's subscribers a card Lark cannot deliver to the person"
```

---

### Task 11: Names in notices, and Unblock under a block's

**Files:**
- Modify: `src/kanban/notices.ts`, `tests/kanban-notices.test.ts`

The notifier tells a person by the name Lark last gave (spec §9.3), and puts an Unblock button under a message whose notices left tasks blocked, one for each task's latest block, at most five, bound to the event that blocked it (spec §9.2; Decision 16). The message is not redrawn when one is pressed, since it carries the round's other notices; a second press finds the block lifted and does nothing, which is noted in the log.

- [ ] **Step 11.1: Write the failing tests.**

In `tests/kanban-notices.test.ts`, replace:

```ts
  ROUND_SENDS,
} from '../src/kanban/notices.js';
```

with:

```ts
  ROUND_SENDS,
  UNBLOCK_BUTTONS,
} from '../src/kanban/notices.js';
```

In `tests/kanban-notices.test.ts`, replace:

```ts
} from '../src/kanban/notices.js';
import { KanbanService } from '../src/kanban/service.js';
```

with:

```ts
} from '../src/kanban/notices.js';
import { unblockButton } from '../src/kanban/chat-render.js';
import { KanbanService } from '../src/kanban/service.js';
```

In `tests/kanban-notices.test.ts`, replace:

```ts
function notifier(opts: { appId?: string; channels?: ReadonlyMap<string, Channel>; sendTimeoutMs?: number } = {}): Notifier {
```

with:

```ts
function notifier(
  opts: { appId?: string; channels?: ReadonlyMap<string, Channel>; sendTimeoutMs?: number; nameOf?: (p: string) => string | undefined } = {},
): Notifier {
```

In `tests/kanban-notices.test.ts`, replace:

```ts
    ...(opts.sendTimeoutMs === undefined ? {} : { sendTimeoutMs: opts.sendTimeoutMs }),
    db: t.db,
```

with:

```ts
    ...(opts.sendTimeoutMs === undefined ? {} : { sendTimeoutMs: opts.sendTimeoutMs }),
    ...(opts.nameOf === undefined ? {} : { nameOf: opts.nameOf }),
    db: t.db,
```

In `tests/kanban-notices.test.ts`, replace:

```ts
    expect(subscriptionsOf(t.db, b.taskId)[0]?.cursor).toBe(eventsOf(t.db, b.taskId).at(-1)?.id);
    expect(await n.deliver()).toBe(0);
    expect(lark.texts).toHaveLength(1);
  });

  it('sends at most a batch of notices a message, says more follow, and sends them in the next round', async () => {
```

with:

```ts
    expect(subscriptionsOf(t.db, b.taskId)[0]?.cursor).toBe(eventsOf(t.db, b.taskId).at(-1)?.id);
    expect(await n.deliver()).toBe(0);
    expect(lark.texts).toHaveLength(1);
  });

  it('puts an Unblock under a message for each task its notices left blocked, the latest block of each, and none under one without', async () => {
    const a = create('Draft the notes');
    const b = create('Check the links');
    const person = { kind: 'person' as const, principal: ALICE };
    expect(service.block(a.taskId, person, { kind: 'needs_input', reason: 'which wiki?' }).ok).toBe(true);
    expect(service.unblock(a.taskId, ALICE).ok).toBe(true);
    expect(service.block(a.taskId, person, { kind: 'needs_input', reason: 'still unsure' }).ok).toBe(true);
    expect(service.block(b.taskId, person, { kind: 'capability', reason: 'no access' }).ok).toBe(true);
    const n = notifier();
    expect(await n.deliver()).toBe(3);
    const blocks = eventsOf(t.db, a.taskId).filter((e) => e.kind === 'blocked');
    expect(lark.texts[0]?.buttons).toEqual([
      unblockButton('cli_app', blocks.at(-1)!),
      unblockButton('cli_app', eventsOf(t.db, b.taskId).find((e) => e.kind === 'blocked')!),
    ]);
    await done(create('Plain'), 'ok');
    await n.deliver();
    expect(lark.texts[1]?.buttons).toBeUndefined();
    // At most a handful, in the order told.
    const many = Array.from({ length: UNBLOCK_BUTTONS + 2 }, (_, i) => create(`blocked ${i}`));
    for (const task of many) expect(service.block(task.taskId, person, { kind: 'needs_input', reason: 'x' }).ok).toBe(true);
    await n.deliver();
    expect(lark.texts[2]?.buttons?.map((x) => x.value['task'])).toEqual(many.slice(0, UNBLOCK_BUTTONS).map((x) => x.taskId));
  });

  it("tells who a person's claim gave a task to, by the name Lark gave", async () => {
    const people = new KanbanService({
      db: t.db,
      roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
      workspaces: WORKSPACES,
      clock,
      people: { canTalk: () => true },
    });
    const r = people.create({ title: 'Check the links', assignee: ALICE, createdBy: ALICE, createdVia: VIA });
    if (!r.ok) throw new Error(r.message);
    expect(people.claim(r.task.taskId).ok).toBe(true);
    await notifier({ nameOf: (p) => (p === ALICE ? 'Alice' : undefined) }).deliver();
    expect(lark.texts.map((m) => m.text)).toEqual([`📋 **Check the links** \`${r.task.taskId}\` — assigned to Alice`]);
  });

  it('sends at most a batch of notices a message, says more follow, and sends them in the next round', async () => {
```


- [ ] **Step 11.2: Run them to verify they fail.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` and then `npx vitest run --project unit tests/kanban-notices.test.ts`. Expected: the two new tests FAIL: no button goes under the message, and the claim's line names `lark:on\_alice`, the notifier passing no names. `Tests  2 failed | 20 passed (22)`.

- [ ] **Step 11.3: Implement.**

In `src/kanban/notices.ts`, replace:

```ts
import { ChannelError, type Channel, type SendTarget } from '../channel/types.js';
```

with:

```ts
import { ChannelError, type CardButton, type Channel, type SendTarget } from '../channel/types.js';
```

In `src/kanban/notices.ts`, replace:

```ts
import { renderNotice } from './chat-render.js';
```

with:

```ts
import { blocksTask, renderNotice, unblockButton, type NameOf } from './chat-render.js';
```

In `src/kanban/notices.ts`, replace:

```ts
 * read when nothing is due.
 */
```

with:

```ts
 * read when nothing is due.
 *
 * **A block's notice offers Unblock** (spec §9.2): a message whose notices left
 * tasks blocked carries an Unblock button for each, at most `UNBLOCK_BUTTONS`,
 * bound to the event that blocked it. The message is not redrawn when one is
 * pressed -- it carries the round's other notices too -- so a second press
 * finds the block lifted and does nothing, which is noted in the log.
 */
```

In `src/kanban/notices.ts`, replace:

```ts
/** The longest a send is waited for; past it, it counts as failed. */
export const NOTICE_SEND_MS = 30_000;

/**
```

with:

```ts
/** The longest a send is waited for; past it, it counts as failed. */
export const NOTICE_SEND_MS = 30_000;
/** Unblock buttons under one message; a block past them is unblocked by `/kanban unblock`, as its notice says. */
export const UNBLOCK_BUTTONS = 5;

/**
```

In `src/kanban/notices.ts`, replace:

```ts
  blockRecurrenceLimit: number;
  clock?: Clock;
```

with:

```ts
  blockRecurrenceLimit: number;
  /** What a notice calls a person, by the name Lark last gave: the people directory's. */
  nameOf?: NameOf;
  clock?: Clock;
```

In `src/kanban/notices.ts`, replace:

```ts
    const text = [...batch.map((n) => n.text), ...(more > 0 ? [`… and ${more} more, in the next message.`] : [])].join('\n\n');
    // The last event the message covers: each cursor moves to it, notices or not.
```

with:

```ts
    const text = [...batch.map((n) => n.text), ...(more > 0 ? [`… and ${more} more, in the next message.`] : [])].join('\n\n');
    const buttons = this.#unblockButtons(batch.map((n) => n.event));
    // The last event the message covers: each cursor moves to it, notices or not.
```

In `src/kanban/notices.ts`, replace:

```ts
          ),
        ),
```

with:

```ts
          ),
          ...(buttons.length === 0 ? [] : [buttons]),
        ),
```

In `src/kanban/notices.ts`, replace:

```ts
  }

  /** A subscription's events past its cursor, and the notices among them. */
  #read(sub: SubscriptionRow): Pending {
```

with:

```ts
  }

  /**
   * An Unblock for each task a batch's notices left blocked: the latest such
   * notice of each, since an earlier one's block was lifted before it, in the
   * order the batch tells them, at most `UNBLOCK_BUTTONS`.
   */
  #unblockButtons(events: readonly KanbanEvent[]): CardButton[] {
    const latest = new Map<string, KanbanEvent>();
    for (const e of events) if (blocksTask(e)) latest.set(e.taskId, e);
    return [...latest.values()]
      .sort((a, b) => a.id - b.id)
      .slice(0, UNBLOCK_BUTTONS)
      .map((e) => unblockButton(this.#deps.appId, e));
  }

  /** A subscription's events past its cursor, and the notices among them. */
  #read(sub: SubscriptionRow): Pending {
```

In `src/kanban/notices.ts`, replace:

```ts
      const text = renderNotice(event, task, { blockRecurrenceLimit: this.#deps.blockRecurrenceLimit });
```

with:

```ts
      const text = renderNotice(event, task, {
        blockRecurrenceLimit: this.#deps.blockRecurrenceLimit,
        ...(this.#deps.nameOf === undefined ? {} : { nameOf: this.#deps.nameOf }),
      });
```


- [ ] **Step 11.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/kanban-notices.test.ts`. Expected: `Tests  22 passed (22)`.

- [ ] **Step 11.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1307 passed (1307)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  72 passed (72)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 11.6: Commit.**

```bash
git add src/kanban/notices.ts tests/kanban-notices.test.ts
git commit -m "Name people in notices by the name Lark gave, and put an Unblock button under a message of notices for each task they left blocked"
```

---

### Task 12: Wiring people into the gateway

**Files:**
- Modify: `src/index.ts`, `src/kanban/service.ts`, `tests/gateway-startup.test.ts`, `tests/kanban-service.test.ts`

Behind `kanban.enabled`, as before: the service is given the people directory and accepts supervised roles; the sink forwards approval cards through the Lark adapter; the notifier names people; and `CardPoster` starts once the channel is connected, after the notifier; at shutdown the gates of reports from chat are aborted, then the notices, the cards and the card presses being worked on are waited for together, under one bound, before the channel disconnects. A boot finding's message now has a uuid per binding and per boot, as Lark sends one message per uuid for an hour (Decision 30). The service's refusal of a person it cannot check now says how a person becomes known.

- [ ] **Step 12.1: Write the failing tests.**

In `tests/gateway-startup.test.ts`, replace:

```ts
import { createGateway, findingsOn, registerConfiguredSecrets } from '../src/index.js';
```

with:

```ts
import { createGateway, findingUuid, findingsOn, registerConfiguredSecrets } from '../src/index.js';
```

In `tests/gateway-startup.test.ts`, replace:

```ts
      expect(gateway.notifier).toBeUndefined();
    } finally {
```

with:

```ts
      expect(gateway.notifier).toBeUndefined();
      expect(gateway.cards).toBeUndefined();
      expect(gateway.chat).toBeUndefined();
    } finally {
```

In `tests/gateway-startup.test.ts`, replace:

```ts
  it('starts delivering notices once connected, and stops before it disconnects, waiting a few seconds at most, when kanban.enabled is set', async () => {
```

with:

```ts
  it("starts delivering notices and people's cards once connected, and stops before it disconnects, waiting a few seconds at most, when kanban.enabled is set", async () => {
```

In `tests/gateway-startup.test.ts`, replace:

```ts
    if (notifier === undefined) throw new Error('no notifier');
    vi.spyOn(notifier, 'start').mockImplementation(() => {
```

with:

```ts
    if (notifier === undefined) throw new Error('no notifier');
    const cards = gateway.cards;
    if (cards === undefined) throw new Error('no cards');
    vi.spyOn(notifier, 'start').mockImplementation(() => {
```

In `tests/gateway-startup.test.ts`, replace:

```ts
      order.push('notices start');
    });
```

with:

```ts
      order.push('notices start');
    });
    vi.spyOn(cards, 'start').mockImplementation(() => {
      order.push('cards start');
    });
```

In `tests/gateway-startup.test.ts`, replace:

```ts
    });
    await gateway.start();
```

with:

```ts
    });
    vi.spyOn(cards, 'idle').mockImplementation(async (boundMs) => {
      order.push('cards idle');
      bounds.push(boundMs);
      return true;
    });
    await gateway.start();
```

In `tests/gateway-startup.test.ts`, replace:

```ts
    expect(order).toEqual(['notices start', 'notices idle', 'disconnect']);
```

with:

```ts
    expect(order).toEqual(['notices start', 'cards start', 'notices idle', 'cards idle', 'disconnect']);
```

In `tests/gateway-startup.test.ts`, replace:

```ts
    expect(bounds).toHaveLength(1);
    expect(bounds[0]).toBeGreaterThan(0);
    expect(bounds[0]).toBeLessThanOrEqual(10_000);
```

with:

```ts
    expect(bounds).toHaveLength(2);
    for (const bound of bounds) {
      expect(bound).toBeGreaterThan(0);
      expect(bound).toBeLessThanOrEqual(10_000);
    }
  });

  it("stops the gates of a report from chat before it waits for the card presses being worked on", async () => {
    const gateway = await createGateway({ ...config, kanban: { ...config.kanban, enabled: true } }, team);
    const chat = gateway.chat;
    if (chat === undefined) throw new Error('no chat');
    const order: string[] = [];
    vi.spyOn(chat, 'stop').mockImplementation(() => {
      order.push('stop');
    });
    vi.spyOn(chat, 'idle').mockImplementation(async () => {
      order.push('idle');
      return true;
    });
    await gateway.stop();
    expect(order).toEqual(['stop', 'idle']);
```

In `tests/gateway-startup.test.ts`, replace:

```ts
  });

  it("posts boot findings to the chat channel's bindings only: a kanban binding's conversation is a task", () => {
    const lark = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat', threadId: '' };
```

with:

```ts
  });

  it('gives a boot finding a uuid per binding and per boot, as Lark sends one message per uuid for an hour', () => {
    const a = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_a', threadId: '' };
    const b = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_b', threadId: '' };
    const uuids = [
      findingUuid('cli_app', 's_1', a, 'boot1'),
      findingUuid('cli_app', 's_1', b, 'boot1'),
      findingUuid('cli_app', 's_1', { ...a, threadId: 'omt_1' }, 'boot1'),
      findingUuid('cli_app', 's_1', a, 'boot2'),
    ];
    expect(new Set(uuids).size).toBe(4);
    expect(findingUuid('cli_app', 's_1', a, 'boot1')).toBe(uuids[0]);
  });

  it("posts boot findings to the chat channel's bindings only: a kanban binding's conversation is a task", () => {
    const lark = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat', threadId: '' };
```

In `tests/kanban-service.test.ts`, replace:

```ts
      message: '"lark:on_eve" does not have talk tier, so cannot be given work',
```

with:

```ts
      message:
        '"lark:on_eve" cannot be given work: being assigned lets a person report on the task, which needs talk tier, ' +
        'and this gateway does not know them to have it -- a person is known once they have used /kanban, or been @-mentioned in it',
```


- [ ] **Step 12.2: Run them to verify they fail.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` and then `npx vitest run --project unit tests/gateway-startup.test.ts tests/kanban-service.test.ts`. Expected: four FAIL: the start-up tests with `Error: no cards` and `Error: no chat`, `findingUuid` not a function, and the service's refusal of a person it cannot check, in its old words. `Tests  4 failed | 40 passed (44)`.

- [ ] **Step 12.3: Implement.**

In `src/index.ts`, replace:

```ts
import { replyUuid } from './core/ids.js';
```

with:

```ts
import { BOOT_ID, replyUuid } from './core/ids.js';
import type { BindingKey } from './types.js';
```

In `src/index.ts`, replace:

```ts
import { writeMtShim } from './kanban/shim.js';
import { PeopleDirectory } from './kanban/people.js';
```

with:

```ts
import { writeMtShim } from './kanban/shim.js';
import { CardPoster } from './kanban/cards.js';
import { PeopleDirectory } from './kanban/people.js';
```

In `src/index.ts`, replace:

```ts
  readonly notifier: Notifier | undefined;
}
```

with:

```ts
  readonly notifier: Notifier | undefined;
  /** What sends people their task and review cards, when `kanban.enabled` is set. */
  readonly cards: CardPoster | undefined;
  /** `/kanban` and the board cards' buttons, when `kanban.enabled` is set. */
  readonly chat: KanbanChat | undefined;
}
```

In `src/index.ts`, replace:

```ts
    .filter((f) => f.bindings.length > 0);
}
```

with:

```ts
    .filter((f) => f.bindings.length > 0);
}

/**
 * The uuid of a boot finding's message to one binding. Lark sends one message
 * per uuid for an hour, across receivers, so it is keyed on the binding, and on
 * this boot: two chats bound to one session each hear it, and a second restart
 * within the hour is said again.
 */
export function findingUuid(appId: string, sessionId: string, key: BindingKey, boot: string = BOOT_ID): string {
  return replyUuid(appId, `boot:${boot}:${sessionId}`, `reconcile:${key.conversationId}:${key.threadId}`);
}
```

In `src/index.ts`, replace:

```ts
    // A chat's session posts to Lark; a kanban run's into the sink (spec §2.4 item 4).
```

with:

```ts
    // A chat's session posts to Lark; a kanban run's into the sink (spec §2.4 item 4),
    // which forwards a supervised agent's approval cards to the chat following its task (spec §7.1).
```

In `src/index.ts`, replace:

```ts
      ['kanban', new KanbanSink()],
```

with:

```ts
      ['kanban', new KanbanSink(undefined, { db, channels: new Map<string, Channel>([[adapter.id, adapter]]), appId: config.lark.appId })],
```

In `src/index.ts`, replace:

```ts
  let notifier: Notifier | undefined;
  let workerServer: WorkerServer | undefined;
```

with:

```ts
  let notifier: Notifier | undefined;
  let cards: CardPoster | undefined;
  let workerServer: WorkerServer | undefined;
```

In `src/index.ts`, replace:

```ts
    const { failureLimit, transientLimit, transientCooldownS } = config.kanban;
    const service = new KanbanService({
```

with:

```ts
    const { failureLimit, transientLimit, transientCooldownS } = config.kanban;
    // Who the gateway has seen in Lark: how a person named by principal is checked for talk tier (spec §4.2).
    const people = new PeopleDirectory({
      db,
      appId: config.lark.appId,
      canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }),
    });
    const service = new KanbanService({
```

In `src/index.ts`, replace:

```ts
      limits: { failureLimit, transientLimit, transientCooldownS },
      // A report runs its task's gates in the workspace, and reads the commit there
```

with:

```ts
      limits: { failureLimit, transientLimit, transientCooldownS },
      // People are given work, and sent cards for it (spec §9.2); a supervised role's
      // approval cards go to the chat that follows its task (spec §7.1).
      people,
      supervisedRoles: true,
      // A report runs its task's gates in the workspace, and reads the commit there
```

In `src/index.ts`, replace:

```ts
    worker = { api: new WorkerApi({ db, service, changed: () => dispatcher?.pass() }), socket };
    // Who the gateway has seen in Lark: how a person named by principal is checked for talk tier (spec §4.2).
    const people = new PeopleDirectory({
      db,
      appId: config.lark.appId,
      canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }),
    });
    // /kanban in chat (spec §9.1): through the same service, with the router's tiers.
```

with:

```ts
    worker = { api: new WorkerApi({ db, service, changed: () => dispatcher?.pass() }), socket };
    // /kanban in chat (spec §9.1): through the same service, with the router's tiers.
```

In `src/index.ts`, replace:

```ts
      redraw: (messageId, view) => adapter.updateCard(messageId, view),
      changed: () => dispatcher?.pass(),
```

with:

```ts
      redraw: (messageId, view) => adapter.updateCard(messageId, view),
      note,
      changed: () => dispatcher?.pass(),
```

In `src/index.ts`, replace:

```ts
      blockRecurrenceLimit: config.kanban.blockRecurrenceLimit,
      note,
```

with:

```ts
      blockRecurrenceLimit: config.kanban.blockRecurrenceLimit,
      nameOf: (principal) => people.nameOf(principal),
      note,
    });
    // A person's run is sent its card, as a direct message (spec §9.2).
    cards = new CardPoster({
      db,
      service,
      channel: adapter,
      appId: config.lark.appId,
      nameOf: (principal) => people.nameOf(principal),
      canTalk: (principal) => people.canTalk(principal),
      note,
```

In `src/index.ts`, replace:

```ts
    dispatcher,
    notifier,

    async start(): Promise<void> {
```

with:

```ts
    dispatcher,
    notifier,
    cards,
    get chat() {
      return kanbanChat;
    },

    async start(): Promise<void> {
```

In `src/index.ts`, replace:

```ts
      // Once connected: its first round catches up on what the chats missed while the gateway was down.
      notifier?.start();

      // Only now, because saying it requires a connection. Failing to deliver a
```

with:

```ts
      // Once connected: its first round catches up on what the chats missed while the gateway was down.
      notifier?.start();
      // And sends the cards of people's runs that a stop left unsent.
      cards?.start();

      // Only now, because saying it requires a connection. Failing to deliver a
```

In `src/index.ts`, replace:

```ts
              replyUuid(config.lark.appId, `boot:${finding.sessionId}`, 'reconcile'),
```

with:

```ts
              findingUuid(config.lark.appId, finding.sessionId, key),
```

In `src/index.ts`, replace:

```ts
      // No more notices; what was not sent is sent by the next boot, from the cursors.
```

with:

```ts
      // No more notices, nor cards; what was not sent is sent by the next boot, from the board.
```

In `src/index.ts`, replace:

```ts
      notifier?.stop();
      // Stop taking work before draining it, or the drain never finishes.
```

with:

```ts
      notifier?.stop();
      cards?.stop();
      // And the gates of a report from chat, a press's or typed: killed, nothing applied,
      // as the worker socket's are below; the next report after a restart runs them again.
      kanbanChat?.stop();
      // Stop taking work before draining it, or the drain never finishes.
```

In `src/index.ts`, replace:

```ts
      if ((await notifier?.idle(SHUTDOWN_DRAIN_MS)) === false) note('kanban: stopped with a notice still being sent; the next boot sends it again');
```

with:

```ts
      // Together, under one bound: the notices, the cards, and the card presses being
      // worked on, whose redraws need the channel.
      const [notices, sent, pressed] = await Promise.all([
        notifier?.idle(SHUTDOWN_DRAIN_MS),
        cards?.idle(SHUTDOWN_DRAIN_MS),
        kanbanChat?.idle(SHUTDOWN_DRAIN_MS),
        inbound.idle(SHUTDOWN_DRAIN_MS),
      ]);
      if (notices === false) note('kanban: stopped with a notice still being sent; the next boot sends it again');
      if (sent === false) note('kanban: stopped with a card still being sent; the next boot sends it again');
      if (pressed === false) note('kanban: stopped with a card press still being worked on; its card may not show the outcome');
```

In `src/kanban/service.ts`, replace:

```ts
 * Until plan D nothing can deliver a card to a person, so people cannot be
 * assigned or named as reviewers, and a role whose agent is supervised is
 * refused: its approval cards would have nowhere to go (spec §12). Plan D passes
 * `people` and `supervisedRoles` to turn them on. Who may act -- tiers, the
```

with:

```ts
 * Without `people`, nothing can deliver a card to a person, so people cannot be
 * assigned or named as reviewers; without `supervisedRoles`, a role whose agent
 * is supervised is refused, as its approval cards would have nowhere to go (spec
 * §12). The gateway passes both from plan D2, which sends people their cards and
 * forwards approvals to the chat following a task. Who may act -- tiers, the
```

In `src/kanban/service.ts`, replace:

```ts
        // Being assigned is permission to report on the task.
        return board.refuse('person_not_assignable', `${quoted} does not have talk tier, so cannot be given work`);
```

with:

```ts
        // Being assigned is permission to report on the task (spec §4.2). A person is
        // known by the open_id Lark last gave with their union_id, from chat.
        return board.refuse(
          'person_not_assignable',
          `${quoted} cannot be given work: being assigned lets a person report on the task, which needs talk tier, ` +
            'and this gateway does not know them to have it -- a person is known once they have used /kanban, or been @-mentioned in it',
        );
```


- [ ] **Step 12.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/gateway-startup.test.ts tests/kanban-service.test.ts`. Expected: `Tests  44 passed (44)`.

- [ ] **Step 12.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1309 passed (1309)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  72 passed (72)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 12.6: Commit.**

```bash
git add src/index.ts src/kanban/service.ts tests/gateway-startup.test.ts tests/kanban-service.test.ts
git commit -m "Give the gateway's board the people directory and supervised roles, forward approvals through Lark, start and stop the sending of people's cards with the notices, and give each boot finding a uuid per binding and boot"
```

---

### Task 13: End to end: a person's task, and a person's review

**Files:**
- Create: `tests/kanban-people.e2e.ts`
- Modify: `tests/fakes/cli-agent.mjs`

Two tests through the router, the real dispatcher, the real socket and the fake CLI agent (spec §11): a task given to a person by @-mention in a group thread reaches them as a card, by union_id; their Done, pressed as the callback's operator, completes it; and the thread hears who had it and that it is done. And an agent's work with a person reviewer: the agent asks for review through `mt kanban review`, the reviewer is sent the review card, asks for changes, the agent's rework run revises with the reason, and the reviewer approves the second review, the first card now out of date. A press is answered at once and its work waited for; an empty box redraws the card live. The fake agent gains a `kanban-review` mode.

- [ ] **Step 13.1: Write the tests.**

In `tests/fakes/cli-agent.mjs`, replace:

```js
 *               file `gate-ok` is in the workspace; then write it and report again
 *
```

with:

```js
 *               file `gate-ok` is in the workspace; then write it and report again
 *   kanban-review run `mt kanban show`, then ask for review with `mt kanban review`,
 *               saying, on a rework, the reviewer's reason it revised for
 *
```

In `tests/fakes/cli-agent.mjs`, replace:

```js
  }

  case 'kanban-late': {
    if (prompt.includes('reminder 1 of')) {
```

with:

```js
  }

  case 'kanban-review': {
    const shown = mt('show');
    let title = '?';
    let reason;
    try {
      const brief = JSON.parse(shown.answer);
      title = brief.task.title;
      reason = brief.rework?.reason;
    } catch {
      process.stderr.write(`mt kanban show failed: ${shown.error} ${shown.answer}\n`);
    }
    const asked = mt('review', { summary: reason === undefined ? `drafted: ${title}` : `revised (${reason}): ${title}` });
    delta(`review: ${asked.answer}`);
    summary('completed', `asked for review of ${title}`);
    break;
  }

  case 'kanban-late': {
    if (prompt.includes('reminder 1 of')) {
```

Create `tests/kanban-people.e2e.ts`:

```ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CardView, Channel } from '../src/channel/types.js';
import { SessionRegistry } from '../src/core/registry.js';
import { Router } from '../src/core/router.js';
import { NamedWorkspaces } from '../src/core/workspace.js';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import { createCliDriver } from '../src/driver/cli/driver.js';
import type { Driver } from '../src/driver/types.js';
import { CardPoster } from '../src/kanban/cards.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { Dispatcher } from '../src/kanban/dispatcher.js';
import { Notifier } from '../src/kanban/notices.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import { writeMtShim } from '../src/kanban/shim.js';
import { KanbanSink } from '../src/kanban/sink.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { WorkerApi } from '../src/kanban/worker.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import { clearSecrets } from '../src/secrets.js';
import type { InboundMention, InboundMessage, Principal } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { FakeDriver } from './helpers/driver.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';

/**
 * People on the board, end to end (spec §9.2, §11): a task given to a person by
 * @-mention in a group thread is sent to them as a card in a direct message, by
 * union_id; their press of Done, as the callback's operator, completes it; and
 * the thread hears who had it and that it is done. And a person reviewing an
 * agent's work -- the fake CLI agent, a real process reporting through `mt
 * kanban` and the real socket -- is sent the review card, asks for changes, which
 * the agent's rework run revises, and approves the second review.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));
const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const ALICE: Principal = { openId: 'ou_alice', unionId: 'on_alice', displayName: 'Alice Smith' };
const BOB: Principal = { openId: 'ou_bob', unionId: 'on_bob', displayName: 'Bob' };
const AT_ALICE: InboundMention = { key: '@_user_1', name: 'Alice Smith', openId: 'ou_alice', unionId: 'on_alice' };
const AT_BOB: InboundMention = { key: '@_user_2', name: 'Bob', openId: 'ou_bob', unionId: 'on_bob' };

interface Stack {
  t: TestDb;
  lark: FakeChannel;
  router: Router;
  dispatcher: Dispatcher;
  /** A new one is a new process: it knows only what the database does. */
  notifier: () => Notifier;
  cards: () => CardPoster;
  chat: KanbanChat;
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-people-e2e-')));
  const home = join(dir, 'home');
  const workspace = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(workspace);
  const t = testDb();
  const authorizer = new Authorizer({
    ...defaultAuthConfig(OWNER.openId),
    allowTalk: [OWNER.openId, ALICE.openId, BOB.openId],
  });
  const people = new PeopleDirectory({
    db: t.db,
    appId: 'cli_app',
    canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }),
  });
  const roles = new Map([['implementer', role('implementer')]]);
  const service = new KanbanService({ db: t.db, roles, workspaces: new Set(['default']), people, supervisedRoles: true });
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
      ['kanban', new KanbanSink(undefined, { db: t.db, channels: new Map<string, Channel>([['lark', lark]]), appId: 'cli_app' })],
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
  const chat = new KanbanChat({
    service,
    hasTier: (principal, tier) => authorizer.hasTier(principal, tier),
    people,
    appId: 'cli_app',
    redraw: (messageId, view) => lark.updateCard(messageId, view),
    changed: () => d.pass(),
    cancel: (runId) => {
      d.cancel(runId);
    },
  });
  const router = new Router({
    db: t.db,
    registry,
    authorizer,
    channel: lark,
    channelId: 'lark',
    appId: 'cli_app',
    kanban: chat,
  });
  const nameOf = (principal: string) => people.nameOf(principal);
  stack = {
    t,
    lark,
    router,
    dispatcher,
    notifier: () =>
      new Notifier({ db: t.db, service, channels: new Map([['lark', lark]]), appId: 'cli_app', blockRecurrenceLimit: 2, nameOf }),
    cards: () => new CardPoster({ db: t.db, service, channel: lark, appId: 'cli_app', nameOf }),
    chat,
    server,
    registry,
    dir,
  };
  return stack;
}

/** A message in the team's group, in a topic thread, mentioning the bot and whoever else. */
function said(text: string, mentions: InboundMention[] = []): InboundMessage {
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
    mentions,
    attachments: [],
    createTime: Date.now(),
  };
}

function createdIn(lark: FakeChannel): string {
  const reply = lark.texts.at(-1)?.text ?? '';
  const id = /^Created `(k_[0-9a-z]+)`/.exec(reply)?.[1];
  if (id === undefined) throw new Error(`no task created: ${reply}`);
  return id;
}

/**
 * Press a card's button as `who`, with what was typed in its box: as Lark's
 * callback gives it, through the router, on the card as it was last drawn. Then
 * wait for the work the press began, and give the card it left, and what was
 * said in the chat: nothing, as a board card's press is shown on its card.
 */
async function press(
  s: Stack,
  card: { view: CardView; messageId: string },
  label: string,
  who: Principal,
  input?: string,
): Promise<{ said: number; card: string }> {
  const drawn = s.lark.cardUpdates.filter((u) => u.messageId === card.messageId && u.view.buttons.length > 0).at(-1)?.view ?? card.view;
  const button = drawn.buttons.find((b) => b.label === label);
  if (button === undefined) throw new Error(`no ${label} on the card`);
  const texts = s.lark.texts.length;
  const answer = await s.router.onCardAction({
    chatId: `oc_dm_${who.unionId ?? ''}`,
    messageId: card.messageId,
    operator: who,
    value: { ...button.value },
    ...(input === undefined ? {} : { input }),
  });
  if (answer !== undefined) throw new Error(`a board card's press was answered in the chat: ${answer}`);
  await s.chat.idle(10_000);
  const last = s.lark.cardUpdates.filter((u) => u.messageId === card.messageId).at(-1)?.view.markdown ?? '';
  return { said: s.lark.texts.length - texts, card: last };
}

/** The cards sent so far, each with the message it became. */
function cardsOf(lark: FakeChannel): Array<{ view: CardView; to: string; messageId: string }> {
  return lark.boardCards.map((c, i) => ({ view: c.view, to: c.target.chatId, messageId: `om_board_${i + 1}` }));
}

describe('people on the board, end to end', () => {
  it('a task for a person reaches them as a card, their Done completes it, and the thread hears both', async () => {
    const s = await build('kanban');
    await s.router.onMessage(said('/kanban new Check the links\nassignee: @Alice Smith\nEvery link on the wiki page.', [AT_ALICE]));
    const taskId = createdIn(s.lark);
    await s.dispatcher.idle();
    expect(runsOf(s.t.db, taskId)).toMatchObject([{ kind: 'work', assignee: { kind: 'human', name: 'lark:on_alice' }, outcome: null }]);

    // The card goes to Alice herself, by union_id, and only there.
    expect(await s.cards().deliver()).toBe(1);
    const [card] = cardsOf(s.lark);
    if (card === undefined) throw new Error('no card');
    expect(s.lark.boardCards[0]?.target).toEqual({ chatId: 'on_alice', threadId: '', receiveIdType: 'union_id' });
    expect(card.view.markdown).toContain('> Every link on the wiki page.');
    // The thread gets one line, naming her in plain text.
    const replies = s.lark.texts.length;
    expect(await s.notifier().deliver()).toBe(1);
    expect(s.lark.texts.slice(replies).map((m) => [m.target, m.text])).toEqual([
      [{ chatId: 'oc_team', threadId: 'omt_topic' }, `📋 **Check the links** \`${taskId}\` — assigned to Alice Smith`],
    ]);

    // Someone else's press does nothing; Alice's, with her summary, completes it.
    expect(await press(s, card, 'Done', BOB, 'not mine')).toEqual({ said: 0, card: '' });
    expect(runsOf(s.t.db, taskId)[0]?.outcome).toBeNull();
    const done = await press(s, card, 'Done', ALICE, 'all links answer');
    expect(done.said).toBe(0);
    expect(done.card).toBe(`**Check the links** \`${taskId}\`\nDone — by Alice Smith.`);
    expect(getTask(s.t.db, taskId)?.phase).toBe('done');
    expect(runsOf(s.t.db, taskId)[0]).toMatchObject({ outcome: 'completed', summary: 'all links answer' });
    expect(s.lark.cardUpdates.map((u) => [u.messageId, u.view.buttons.length])).toEqual([
      [card.messageId, 0],
      [card.messageId, 0],
    ]);
    // Pressed again, the card says it is out of date, and changes nothing.
    expect((await press(s, card, 'Done', ALICE, 'again')).card).toMatch(/\nThis card is out of date/);

    const before = s.lark.texts.length;
    expect(await s.notifier().deliver()).toBe(1);
    expect(s.lark.texts.slice(before).map((m) => m.text)).toEqual([`Done — **Check the links** \`${taskId}\`:\n> all links answer`]);
    // A restart sends no card again, and no notice.
    expect(await s.cards().deliver()).toBe(0);
    expect(await s.notifier().deliver()).toBe(0);
  });

  it("a person reviewing an agent's work asks for changes, the agent revises, and the person approves", async () => {
    const s = await build('kanban-review');
    await s.router.onMessage(
      said('/kanban new Draft the notes\nassignee: implementer\nreviewer: @Bob\nworkspace: default', [AT_BOB]),
    );
    const taskId = createdIn(s.lark);
    await s.dispatcher.idle();
    s.dispatcher.pass();
    await s.dispatcher.idle();
    expect(getTask(s.t.db, taskId)?.phase).toBe('review');
    expect(runsOf(s.t.db, taskId).map((r) => [r.kind, r.assignee.kind, r.outcome])).toEqual([
      ['work', 'role', 'review_requested'],
      ['review', 'human', null],
    ]);

    // Bob's review card: the agent's handoff, from its agent; no commit line, as the workspace is no repository.
    expect(await s.cards().deliver()).toBe(1);
    const first = cardsOf(s.lark)[0];
    if (first === undefined) throw new Error('no card');
    expect(first.to).toBe('on_bob');
    expect(first.view.markdown).toContain('**The handoff**, from its agent:\n> drafted: Draft the notes');
    expect(first.view.markdown).not.toContain('To review:');

    // Request changes needs a reason; with one, the task goes back to the agent, which revises.
    // An empty box is refused, and the card redrawn live, with buttons a second press can be made with.
    const empty = await press(s, first, 'Request changes', BOB);
    expect(empty.said).toBe(0);
    expect(empty.card).toContain('**Not done.** Type what needs changing');
    const asked = await press(s, first, 'Request changes', BOB, 'cite the sources');
    expect(asked.said).toBe(0);
    expect(asked.card).toBe(`**Draft the notes** \`${taskId}\`\nChanges requested — by Bob: cite the sources`);
    await s.dispatcher.idle();
    s.dispatcher.pass();
    await s.dispatcher.idle();
    expect(runsOf(s.t.db, taskId).map((r) => [r.kind, r.outcome, r.summary])).toEqual([
      ['work', 'review_requested', 'drafted: Draft the notes'],
      ['review', 'changes_requested', 'cite the sources'],
      ['work', 'review_requested', 'revised (cite the sources): Draft the notes'],
      ['review', null, null],
    ]);

    // The second review's card; the first one is out of date now.
    expect(await s.cards().deliver()).toBe(1);
    const second = cardsOf(s.lark)[1];
    if (second === undefined) throw new Error('no second card');
    expect(second.view.markdown).toContain('> revised (cite the sources): Draft the notes');
    expect((await press(s, second, 'Approve', BOB)).card).toBe(`**Draft the notes** \`${taskId}\`\nApproved — by Bob.`);
    expect((await press(s, first, 'Request changes', BOB, 'again')).card).toMatch(/\nThis card is out of date/);
    expect(getTask(s.t.db, taskId)?.phase).toBe('done');

    // The thread heard each request for review, who had each review, and the end.
    await s.notifier().deliver();
    const told = s.lark.texts
      .filter((m) => m.target.threadId === 'omt_topic' && !m.text.startsWith('Created'))
      .flatMap((m) => m.text.split('\n\n'));
    const name = `**Draft the notes** \`${taskId}\``;
    expect(told).toEqual([
      `Review requested — ${name}, from Bob.`,
      `📋 ${name} — review assigned to Bob`,
      `Review requested — ${name}, from Bob.`,
      `📋 ${name} — review assigned to Bob`,
      // Approved with nothing more to say.
      `Done — ${name}.`,
    ]);
  });
});
```


- [ ] **Step 13.2: Run them to verify they pass.** Every piece they use exists after Task 12, so these tests are the integration check rather than a driver of new code. Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` and then `npx vitest run --project e2e tests/kanban-people.e2e.ts`. Expected: `Tests  2 passed (2)`.

- [ ] **Step 13.3: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1309 passed (1309)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  74 passed (74)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 13.4: Commit.**

```bash
git add tests/fakes/cli-agent.mjs tests/kanban-people.e2e.ts
git commit -m "End to end: a person's task reaches them as a card and their Done completes it, and a person's review asks an agent for changes and approves its rework"
```

---

### Task 14: The README

**Files:**
- Modify: `README.md`

People on the board: naming a person by @-mention and the talk tier it needs, how the gateway learns a person's ids, the cards and their buttons, the typed commands, the one line the group hears, Unblock, a card Lark refuses, the `workspace_busy` refusal, supervised roles, notices sent again after a stop shown once, the known limitations, and the smoke test to run before turning the board on; and `kanban.enabled`'s row naming people's cards and approval forwarding.

- [ ] **Step 14.1: Edit.**

In `README.md`, replace:

```md
role, whose agent runs it in a workspace, which is just a directory.
```

with:

```md
role, whose agent runs it in a workspace, which is just a directory, or to a person.
```

In `README.md`, replace:

```md
line is the body. An unknown role or workspace is refused at once, and so is a role whose agent
is supervised. The dispatcher looks for work as soon as the task is created.
```

with:

```md
line is the body. A bare word names a role, and an @-mention a person. An unknown role or
workspace is refused at once. The dispatcher looks for work as soon as the task is created.
```

In `README.md`, replace:

```md
| `/kanban assign <task> <role>` | operate: an undecided run ends `superseded` |
```

with:

```md
| `/kanban assign <task> <role or @person>` | operate: an undecided run ends `superseded` |
```

In `README.md`, replace:

```md
| `/kanban comment <task> <text>` | talk: everyone sees it in `/kanban show`; an operator's also reaches the task's agent, when its turn ends or in its next run |
```

with:

```md
| `/kanban comment <task> <text>` | talk: everyone sees it in `/kanban show`; an operator's, or the task's assignee's or reviewer's, also reaches its agent, when its turn ends or in its next run |
```

In `README.md`, replace:

```md
| `/kanban gate remove <task> <gate>` | operate |
| `/kanban help` | talk |
```

with:

```md
| `/kanban gate remove <task> <gate>` | operate |
| `/kanban done <task> [summary]` | the task's assignee, a person |
| `/kanban block <task> <reason>` | the task's assignee: it blocks as needing input |
| `/kanban review <task> [summary]`, and a line `reviewer: <role or @person>` unless the task names one | the task's assignee |
| `/kanban approve <task> [comment]` | the task's reviewer, a person, or an operator |
| `/kanban changes <task> <reason>` | the task's reviewer, a person, or an operator |
| `/kanban help` | talk |
```

In `README.md`, replace:

```md
may be sent twice. A chat the bot can no longer post to — removed from it, or refused by
```

with:

```md
is sent again with the same uuid, which Lark shows once if it comes within the hour. A chat
the bot can no longer post to — removed from it, or refused by
```

In `README.md`, replace:

```md
**Not yet:** people as assignees or reviewers. Naming one, with an @-mention, is refused, and
`/kanban done`, `block`, `review`, `approve` and `changes` say they arrive in a later update
(plan D2), with cards to a person's direct messages.
```

with:

```md
**People.** Name a person with an @-mention — type @ and pick them, so Lark sends who they
are — as `assignee:` or `reviewer:`, or in `/kanban assign`. Being named lets a person report on
the task, so they must have talk tier (`auth.talk`); a person without talk tier is
refused. The board knows a person as `lark:<union_id>`, which is how `/kanban show` lists them
and how an agent's `mt kanban create` or `review` names one; the gateway learns each person's
ids as they use `/kanban`, are mentioned in it, or press a card's button, and refuses a
principal it has never seen.

When a person's task is ready, they are sent it as a card in a direct message — the title, the
body, the contract and the parents' summaries — with a box and **Done** and **Block**: type a
summary, or why it is blocked, and press one. A review for a person comes the same way, with the
handoff, the commit to review when one was recorded, and **Approve** and **Request changes**.
Only the person named may press them (an operator may also answer a review); a card for a run
that is over says it is out of date and does nothing. A press is answered at once, and the card
shows the outcome once the report is made, gates and all; one refused for what it carried — an
empty box, a failing gate — redraws the card, saying why, ready to be pressed again. `/kanban done`, `block`, `review`,
`approve` and `changes` do the same from any chat with the bot. A person's task never times out:
it waits for them, across restarts. The chat the task came from hears one line — "📋 *title* —
assigned to *name*", the name in plain text, never a mention — and its notices as usual; a
notice of a block carries an **Unblock** button for an operator. A card Lark refuses to deliver
is reported to the chat instead, with the commands to use. A person's report is refused while
another task's agent is working in the same workspace, if the task has gates to run there.

A role whose agent is supervised may be given tasks too: its approval cards go to the chat that
follows the task, naming it, and are answered there at operator tier, as in a chat session.

**Known limitations.**

- A typed report (`/kanban done` and the rest) leaves its card's buttons live, until the next
  press shows the card as out of date.
- A notice's **Unblock** button stays after it is pressed; a second press does nothing.
- A card that Lark refuses as unreachable is never sent again; the person can type the
  commands the chat was given.
- The gateway learns about people only from `/kanban` messages, the people they mention, and
  the people who press cards; a principal it has never seen is refused.
- An approval forwarded to a chat counts toward the run's `max_runtime_s`: a supervised agent
  waiting on one is cancelled at that limit like any run.
- A person may review their own work: nothing refuses a reviewer who is the assignee.
- A person's name, in a notice or a card, is the one Lark last gave with their ids, and can be
  out of date.

Before setting `kanban.enabled: true` on a live tenant, run the smoke test at the end of
docs/plans/2026-11-05-plan-d2-kanban-people.md. It is the section "Before turning the board on:
a smoke test against Lark".
```

In `README.md`, replace:

```md
| `kanban.enabled` | — | Run the board: its dispatcher, the worker socket, `/kanban` in chat and its notices. Default
```

with:

```md
| `kanban.enabled` | — | Run the board: its dispatcher, the worker socket, `/kanban` in chat and its notices, people's cards, and forwarding supervised roles' approvals to the chat that follows a task. Default
```


- [ ] **Step 14.2: Check.** Run `git grep -n -i "p[g]w" -- . ':!package-lock.json'`. Expected: no output. Run `git grep -n -i "later update\|plan D2" -- README.md`. Expected: no output. Run `npm test 2>&1 | tail -4`. Expected: `Tests  1309 passed (1309)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  74 passed (74)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 14.3: Commit.**

```bash
git add README.md
git commit -m "Document people on the board: naming them by @-mention, their cards and commands, what the group hears, and supervised roles' approvals in the chat that follows a task"
```

---

## Done when

- `npm test` gives `Tests  1323 passed (1323)`, after the review follow-ups below (1309 at Task 14). `npm run test:e2e` gives `Tests  75 passed (75)`. `npm run typecheck` reports no errors. All of these run under Node 22, in the worktree.
- Only `src/db/kanban.ts` writes a `kanban_` table, and only `src/kanban/service.ts` imports it (the guard in `tests/kanban-service.test.ts`); only `src/db/people.ts` writes `people`. `src/kanban/chat.ts`, `src/kanban/cards.ts`, `src/kanban/sink.ts` and `src/kanban/notices.ts` write nothing themselves.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing, and no reply, notice, card or help text says "D2", "plan" or "a later update".
- A task given to a person by @-mention reaches them as a card in a direct message, by union_id; their Done, pressed as the callback's operator, completes it, and the thread it came from hears who had it and that it is done (`tests/kanban-people.e2e.ts`).
- A person reviewing an agent's work is sent the review card, requests changes, which the agent's rework run revises, and approves the second review; the first card is then out of date (`tests/kanban-people.e2e.ts`).
- A person without talk tier, one the message does not mention, and a principal never seen are refused at assignment; a named assignee and reviewer act on their own task at talk tier, and an operator answers any review; their comments steer (`tests/kanban-chat.test.ts`).
- A card's button is routed by its kind; a press is checked against its nonce, its presser and its run inside the transaction, and a card acted on or out of date is redrawn without buttons (`tests/router.test.ts`, `tests/kanban-chat.test.ts`, `tests/kanban-people-reports.test.ts`).
- A person's report with gates beside another task's agent run in the workspace is refused `workspace_busy`, running no gate (`tests/kanban-people-reports.test.ts`).
- A supervised agent's approval card reaches the chat that follows its task, and its answer releases the agent (`tests/kanban-sink.test.ts`).
- Every message sent as one message carries its uuid to Lark (`tests/lark-cards.test.ts`); a person's card is sent once, again after a restart only if it was not recorded, with the same uuid, and a refused one is reported to the task's subscribers (`tests/kanban-cards.test.ts`).
- With `kanban.enabled` unset, the gateway builds no service, dispatcher, socket, chat commands, notifier or card poster.
- A typed report is bound to the run open when it was checked, or to none, and to what the person reports as; a task reassigned, or a review given to someone else, while its gates run is refused `run_superseded`, with no run claimed too (`tests/kanban-chat.test.ts`, `tests/kanban-people-reports.test.ts`).
- The README's "People" section ends with its known limitations and the smoke test to run before turning the board on.

## Review follow-ups

The review of the finished plan found the following, fixed after Task 14, each behaviour test first. The task steps above show the code as first written; the code and tests in the tree are the corrected ones.

- **An unbound typed report could decide a reassigned task** (I1). With no run open, `#reporter` in `src/kanban/chat.ts` gave no `runId`, and the board accepted the report on no run without checking the assignee again: Alice's `done` on an unclaimed task with gates, the task given to a role while they ran, ended `done`, assigned to the role. `Reporter` now carries `runId: string | null` — `null` meaning "expects none open" — and `as`, `assignee`, `reviewer` or `operator`; `reportingRun` in `src/db/kanban.ts` refuses `run_superseded` when the open run is not the one bound, and `namedRefused` when the task is no longer the assignee's and open, or no longer in review and, for a reviewer, theirs. Typed `done`, `block`, `review`, `approve` and `changes`, and a card's press, all pass both. Tests: a typed `done` with no run claimed, the task reassigned while its gates run; a typed `approve` of a review not yet claimed, its reviewer changed while they run (`tests/kanban-chat.test.ts`); the board's refusals of each binding, an operator answering any review, and a `null` binding with a run open (`tests/kanban-people-reports.test.ts`). Decision 29 says so. A claim cannot happen while a report's gates run (`report_in_progress`), so a run opened under a `null` binding is tested at the board only.
- **The README's "People" section** (I2) ends with a "Known limitations" list — a typed report leaving its card live, Unblock staying, a card refused as unreachable never resent, how the gateway learns of people, a forwarded approval counting toward `max_runtime_s`, self-review, a name out of date — and says to run the smoke test at the end of this plan before setting `kanban.enabled: true` on a live tenant. Task 14 shows it.
- **The `kanban.enabled` row** lists people's cards and forwarding supervised roles' approvals. "A person the bot answers nobody for" is now "a person without talk tier".
- **"Not done" twice.** A refusal redrawn on a card read "**Not done.** Not done: …"; `cardNote` drops the refusal's own prefix and capitalizes what follows. Test: the gate refusal's redraw.
- **A redraw that throws at once** rejected the press before its report. `#redraw` calls the redraw through `Promise.resolve().then(...)`, so a throw is a failed redraw, noted. Test: a redraw that throws synchronously; the press is applied.
- **A press on a card for a run that is not a person's** is refused, "That button is not for a person's card.", before anything else is checked: an operator may answer any review, and without it an operator's Approve on a role's review run reached the board. Test: a role's work run, and an operator on a role's review run.
- **"Working on it…" held the report back** until it was drawn, up to `REDRAW_MS`. The redraw is now started, the report applied at once, and the outcome redrawn once the first redraw has settled or been given up on, so it is always drawn after it. Test: a working redraw that never answers; the report is applied at once, the outcome drawn after it. The hung-redraw test now holds a gate and stops the task meanwhile, since the press no longer waits for the redraw.
- **An indented `reviewer:` line** is read: spaces, tabs and zero-width characters may come before `reviewer`. Test (`tests/kanban-chat-parse.test.ts`).
- **The forwarded map's bound** (`FORWARDED_MAX`, now exported): a test sends one past it and finds the oldest forgotten and the rest redrawn (`tests/kanban-sink.test.ts`).
- **A comment said "From plan D2"** in `renderNotice`; it now says "For people".
- **A card for a run that ended mid-round.** `CardPoster.#render` returns nothing for a run ended since the round read it, so no card is sent; `#refused` says "its run is over, or its card was recorded already, so nobody is told" when `recordCard` recorded nothing. Tests (`tests/kanban-cards.test.ts`).
- **The stop notice** names a person who stopped the task by `nameOf`, escaped, else the actor as recorded. Test (`tests/kanban-chat-render.test.ts`).
- **`#acknowledge`** in `src/channel/lark/inbound.ts` catches a note that throws, so the acknowledgement never rejects unhandled. Test: a send and a note that both throw (`tests/lark-inbound.test.ts`).
- **The shutdown's messages** say that work still in flight when the drain's bound runs out has its write dropped: a notice's cursor not moved, a card not recorded, a press's and the dispatcher's writes.
- **`#withRetry`'s doc** says a retry of a one-message send is deduplicated by its uuid, and only a long text is not. **The withdrawn fallback's doc** says the SDK keys its fallback on its own codes (230017, 230020 and HTTP 404), and this code on 230011, Lark's documented code for a withdrawn message. Not done: falling back on HTTP 404 too, which nothing here has seen Lark send for a withdrawn message.
- **An Unblock's event** may be a `run_ended` only when its `payload.next` was `blocked`, not one the task was retried after. Test: a retried run's end refused `invalid` as a stopped task's Unblock, and a run's end that gave up accepted (`tests/kanban-people-reports.test.ts`).
- **Docs.** Spec §9.1 (the indented reviewer line, who is named checked again), §9.2 (a typed report's binding, a press on an agent's run, the outcome after "Working on it…", "Not done." once, an Unblock's `run_ended`, a run ended mid-round) and §9.4 (the stop notice's name) say what the code does. This section is placed before the smoke test, which the README sends readers to the end of the plan for.

Counts after the first review follow-ups: `Tests  1322 passed (1322)` unit, `Tests  74 passed (74)` end to end.

The final review then found the following, fixed the same way.

- **The adapter's changes reach every chat on deploy**, the board on or off. The smoke test below now begins with "Before deploying this build at all (kanban off)": the chat-session half of step 1, step 8, step 11, and a `/help` reply in a direct message, a group and a thread; the rest stays before `kanban.enabled: true`. The README says the same under "Sending to Lark".
- **The withdrawn fallback takes the SDK's codes**: a reply refused with 230017 or an HTTP 404, whatever its body's code, goes to its chat with the same uuid, as one refused with 230011 does. 230020 is retried as the chat's rate limit and kept out of the fallback (Decision 34). This replaces the earlier "Not done: falling back on HTTP 404 too". Test: 230017, a 404 with another code and a 404 with none each go to the chat, an approval card's too; 230020 is retried in the thread (`tests/lark-adapter.test.ts`).
- **The README's account of a card that cannot be sent** says that only a person outside the app's reach (230013), or one who lost talk tier, gets the chat's report; any other failure is retried and logged.
- **The adapter's limitations everyone sees** are in the README, under "Sending to Lark", outside the People section: no SDK markdown tidying, texts over 4,000 characters and streamed answers without the uuid, and the narrower post fallback.
- **Smoke step 6** also checks that the `Created …` reply, a post's `md`, shows the escaped `<at id=all></at>` title as text, and a new step 12 has the assignee type `/kanban done k_… typed` in a direct message.
- **A card can go dead**: a failed "Not done" redraw may leave a card's buttons dead for 12 h, while the typed commands work. Known limitations here and in the README.
- **A router-level test of a forwarded approval card**: a supervised role's task, created in a thread, forwards its approval card there; a press by a person at talk tier is refused with nothing answered, and the operator's, through `Router.onCardAction`, answers "Sent: Allow.", resolves the approval and releases the agent, and the card is redrawn (`tests/kanban-people.e2e.ts`).
- **A timing-dependent test**: the test of a press applied while its "Working on it…" redraw hangs waits with `until(...)` from `tests/helpers/dispatch.ts`, not five `setImmediate` ticks (`tests/kanban-chat.test.ts`).

Counts after the final review follow-ups: `Tests  1323 passed (1323)` unit, `Tests  75 passed (75)` end to end.

## Before turning the board on: a smoke test against Lark

Not a task for the implementer: the user runs it, once, against the real Lark tenant, after these tasks are in. No test reaches Lark (ground rules), so this is where the cards' JSON and the SDK's behaviour are checked. Use a test chat, a test role and two people: the operator, and a second person, B, on `auth.talk`, who has never opened a chat with the bot.

### Before deploying this build at all (kanban off)

The adapter's changes — the uuid on every one-message send, the approval card in schema 2.0, the withdrawn fallback — reach every chat as soon as this build is deployed, with the board off. So these must pass first, against the live tenant with `kanban.enabled` off, before the build is deployed at all:

- the chat-session half of step 1: an approval card in a chat with a supervised role, pressed, redrawn, and the agent going on;
- step 8: one message per uuid, at chat scope and in a thread;
- step 11: a reply to a withdrawn message arrives in its chat;
- a `/help` reply in a direct message, in a group (as a quoted reply) and in a thread, each arriving once, as written.

### Before `kanban.enabled: true`

The rest — the group half of step 1, and steps 2 to 7, 9, 10 and 12 — before `kanban.enabled: true` goes into the live config.

1. **Approval cards.** In a chat with a supervised role (`unsupervised: false`, a driver that asks), send a prompt that makes the agent ask. *Expected:* an approval card with one button per option; pressing one answers it, the card is redrawn "Answered: … — by …", and the agent goes on. Then, in a group, give the board a task for that role (`/kanban new … assignee: <role>`). *Expected:* its approval card arrives in that group, as "Task `k_…`, *title*, asks: …"; pressing an option as the operator releases the agent, Lark shows no error on the press, the chat gets the acknowledgement ("Sent: …"), and the card in the group is redrawn "Answered: … — by …".
2. **A direct message by union_id.** `/kanban new Check the links` with `assignee: @B` (type @ and pick B). *Expected:* B, who never opened the bot, gets the task card in a direct message within a few seconds, with the box, Done and Block; the chat gets "📋 **Check the links** `k_…` — assigned to B".
3. **The box's text.** Press Done on B's card with "hello" in the box, then run `/kanban show k_…`. *Expected:* the latest run reads `completed — hello`: the text arrived as `form_value.text`. If it reads `completed` with no summary, add `console.error('form_value', JSON.stringify((evt.raw as { action?: { form_value?: unknown } } | undefined)?.action?.form_value));` as the first line of `#onCardAction` in `src/channel/lark/inbound.ts` in a scratch build, press Done on a new card, and report what the gateway's stderr shows; then remove the line.
4. **A refused press, then the same button again.** On a fresh task card, press Block with the box empty. *Expected:* the card is redrawn with "**Not done.** Type why it is blocked…" and its buttons. Type a reason and press Block again. *Expected:* the second press is not dropped: the task blocks, the card says "Blocked — by B: …".
5. **A long press.** Give a task for B a gate that takes over 3 s (`/kanban gate add k_… sleep 5`), then press Done. *Expected:* the card shows "Working on it…" at once, Lark shows no error on the press, and about five seconds later the card says "Done — by B.".
6. **Unblock, and escaping.** Create a task titled `Check <at id=all></at> links` for a role, and have it block (or `/kanban stop` it). *Expected:* the `Created …` reply, a post's `md`, shows the title as text, with `<at id=all></at>` written out and nobody notified; the notice in the chat shows the title the same way, and an "Unblock k_…" button under it; pressing it as the operator unblocks the task, which `/kanban show` then shows open, with nothing said in the chat.
7. **A redraw.** After any press in steps 3 to 6. *Expected:* the card changes in place, in every client the card shows in (desktop and phone), and its old buttons no longer act.
8. **One message per uuid.** With the gateway stopped, run a scratch script with `npx tsx` that builds a `LarkAdapter` from the same `LARK_APP_ID` and `LARK_APP_SECRET`, calls `connect()`, then `sendText` twice with one text and one uuid (any 50 hex characters) to `{ chatId: '<test chat>', threadId: '' }`, and twice with another uuid to `{ chatId: '<test chat>', threadId: '<a thread there>' }`, then `disconnect()`. *Expected:* one message at chat scope and one in the thread, not two of either.
9. **A review card.** `/kanban new Review the notes` with `assignee: <role>` and `reviewer: @B`, for a role whose agent asks for review. *Expected:* B gets a review card with the handoff, a box, Approve and Request changes. Press Request changes with the box empty. *Expected:* the card is redrawn "**Not done.** Type what needs changing…", with its buttons. Type a reason and press Request changes again. *Expected:* the press is not dropped: the card says "Changes requested — by B: …", and the task goes back to its assignee. When the next review card comes, press Approve. *Expected:* "Approved — by B.", and the task is done.
10. **A person the app cannot reach.** Give a task (`/kanban new … assignee: @C`) to a person C on `auth.talk` who is outside the app's availability (the app's availability scope, in Lark's developer console). *Expected:* no card reaches C, and the chat hears "Could not send C the card for …: … (code 230013)", with the commands C can type. If the code is another, report it: the gateway then takes it for its own problem, and retries and logs it every five minutes.
11. **A reply to a withdrawn message.** In a group, send a message the bot replies to as a quoted reply (a `/help` at chat scope, or a `/kanban list` with the board on), withdraw the message while the bot is busy (or reply by script to a withdrawn message id). *Expected:* the answer arrives in the chat, unquoted, rather than failing.
12. **A typed report from a direct message.** Give B a task (`/kanban new … assignee: @B`) and, once B's card arrives, have B type `/kanban done k_… typed` in their direct message with the bot. *Expected:* the reply in the DM says it is done, `/kanban show k_…` reads `completed — typed`, and the chat the task came from hears that it is done. The card's buttons stay; pressing Done then redraws it as out of date.

Afterwards, archive every task the test made: `/kanban list all`, then `/kanban archive k_…` for each.

If any step fails, keep `kanban.enabled` off and report the step and what Lark showed.
