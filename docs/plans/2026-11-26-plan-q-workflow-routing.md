# Plan Q: Workflow routing. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workflow's results decide the rest of it. A step declares the facts its run reports, its `outputs`, checked at its completion; a later step is made only when its `when` holds on them, or skipped; a step fans out over a result's list, one task an item, its children joining on every item; and a step whose run blocks or gives up can be routed to a handler, which helps, or stands in for it with the step's own reviewer, gates and contract. One file then does what several did, as the vi assessment's six files fold into one. A file using none of the new keys starts, shows and archives exactly as before.

**Architecture:** five phases, each ending green: a checkpoint to review at, not a release. The branch merges whole, after Phase 5.

- **Phase 1, the schema and the frozen plan** (Tasks 1 to 10): migration 015 with every table and column of the spec, and the reads of them, nothing of them on a database not yet migrated (Tasks 1, 2); the parse of every new key (Task 3); the checks of `workflow check` (§6), the conditions and fan-outs (Task 4), the routes and handlers (Task 5), and the step lines (Task 6); the expansion into the plain steps' DAG and a plan of every step (Task 7); the plan stored at the start, with its waiting rows, after its templates are checked (Task 8); the output check at completion (Task 9); and `preview --json` and `apply` refusing a routed file (Task 10).
- **Phase 2, `decide()` and conditions** (Tasks 11 to 18): the pure `decide` in `src/kanban/routing.ts`, every clause and state, skipping, settling once the parents are, the effective parents, archive spreading and the cap (Task 11); the writer deciding in the transaction of each completion, archive, block and give-up, with the settled rows and the skips (Task 12), the tasks made late (Task 13) and the team check of them (Task 14); the savepoint, the fault and its mark (Task 15); `workflow archive` skipping every waiting step (Task 16); the dispatcher's retry by reconciliation (Task 17); and the instance's status (Task 18).
- **Phase 3, result-driven fan-out** (Tasks 19 and 20): the fan-out over the source's accepted list, its join, the empty list and the skipped source (Task 19); and the 500 cap, reserved at the reporting completion and skipped past later (Task 20).
- **Phase 4, routes and handlers** (Tasks 21 to 26): the trigger table and decide's routes (Task 21); the route rows and the handler's task with its paragraph, and `routed_from` in the worker's show (Task 22); the worker's `mt kanban unblock` (Task 23); a stand-in's reviewer, gates and contract (Task 24); the stand-in's settling and the archive of the task it stood in for (Task 25); and the runs that archive supersedes, cancelled through `KanbanServiceDeps.cancelRun` (Task 26).
- **Phase 5, what people see, and reconciliation** (Tasks 27 to 32): `workflow show`'s step lines (Task 27); the notices (Task 28); the preview, the start's reply and `waiting` (Task 29); the `reconcile` command and the startup's reconciliation (Task 30); the documents (Task 31); and the end-to-end test through `createGateway` (Task 32).

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`), vitest, better-sqlite3 11, `yaml` 2. No new dependency. One migration, 015.

**Spec:** `docs/specs/2026-11-26-workflow-routing-design.md`, all of it, §20's decisions and §21's departures included, as approved by the user on 2026-11-26. It extends `docs/specs/2026-11-16-workflows-design.md`, cited as "workflows spec §n". Below, "§N" is the routing spec's.

---

## Ground rules

- **Merging.** The branch `workflow-routing` merges into `main` whole, once Phase 5 is done. Each phase ends green, every test passing and the typecheck clean, so it is a checkpoint to stop and review at; none is a release, and none is merged alone.
- **Where to work.**
  - Use the worktree beside the main checkout, `/Users/x/Develop/manus/prime-gateway-wt2`, on the branch `workflow-routing`, which holds the spec and this plan, on top of `bef294b`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`, nor `/Users/x/Develop/manus/prime-gateway-work`: the live gateway runs from the first.
  - Never start the gateway, never reach the real Lark or the network, and never read or write `~/.manus-team`. Every test makes its own home in a temporary directory, its own database and its own roles; only the end-to-end test waits on real time, for the fake CLI agent it runs through the real socket.
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink to the main checkout's; create it with `ln -s /Users/x/Develop/manus/prime-gateway/node_modules node_modules` if it is missing.
  - Write plain-English commit messages: they name no assistant or tool that wrote them, and have no trailer, no Chinese text and no long dash.
  - The letters `p`, `g`, `w` in that order, in any case, must not appear in anything you write.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command. The default Node 23 breaks `better-sqlite3`.
- **Baseline.** At `bef294b`, `npx vitest run --project unit` gives `Tests  3569 passed (3569)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`. `npm run typecheck` reports no errors. The tests of `tests/update-run.test.ts` and `tests/install-sh.test.ts`, which time child processes, and `tests/kanban-worktree.e2e.ts`'s stopped git command, can fail on a loaded machine; run the file again alone before looking for a cause, and run the suite again: it is that file, not the task.
- **Git in tests.** The tests that run git use the isolated configuration of `tests/helpers/git.ts` and `tests/helpers/git-setup.ts`; keep it in every test that runs git.
- **Finding edits.** Find each edit by its quoted text, not by line number. Every quoted text is whole lines, and appears exactly once in its file at the point the step applies it. Apply a step's edits in the order given. Every step of this plan was applied in that order, from `bef294b`, in a throwaway copy, and gave the counts and failures it states: each "verify they fail" step was run with that task's test edits on the tree of the task before, and each "Run everything" step on the task's whole tree. The plan's own text was then applied in a second fresh copy, from `bef294b`, which reproduced the first copy's tree byte for byte at the end of every task.
- **Failures that name ids.** A failure message quoted below may name a generated id: the id differs on each run.
- **One writer.** `src/db/kanban.ts` stays the board's only writer: the plan, the pending, settled and route rows, the tasks made late and the routed task's archive are written there, inside the transitions' own transactions, and the service, chat, the worker API, the dispatcher and the terminal only call it. `src/db/WRITERS.md` says so (Tasks 1, 13).
- **The seam.** `src/kanban/routing.ts` is pure: it imports only `./types.js`, `./limits.js`, `./dag.js` and `../secrets.js` (§9.3). The dispatcher, the claim, the prompt and the waker read no workflow table: the dispatcher calls one service hook (Task 17).
- **Words a person sees** (replies, refusals, notices, `mt` output, the log, the README and the guide) are the spec's words where it gives them, never name a plan, and do not use the long dash.
- **No real agent.** No test runs bytesec or any agent; the end-to-end test runs the fake CLI agent of `tests/fakes/cli-agent.mjs`.

## Decisions

Each has its reason, tied to the spec. Where the code and the spec disagree, the code is the fact, and the decision says which reading keeps the spec's intent; those are listed again under "Where the code forced a reading" below.

1. **Five phases, one migration.** Migration 015 holds every column and table of §8, the route and settled tables Phase 4 writes included, so no later phase migrates.
2. **A database not yet at 15 reads as no routing.** The terminal opens the gateway's database without migrating it (§8): every read of a 015 column or table gives nothing there, `hasRouting(db)` reading `user_version`, and a routed start is refused with the spec's words.
3. **A file using no routing key is untouched.** `usesRouting` (Task 6) is false for it: `expand` returns a null plan and the same DAG, byte for byte (Task 7, by its hash), the writer reads one member row and pays nothing more (Task 12), and `mt workflow check` says what it said (Task 6).
4. **The writer decides inside each settling transaction**, in a savepoint, through `routeAfter` (Tasks 12, 15), and loops `decide` until nothing more is due, a chain of skipped steps settling in one call (§9.2).
5. **Each phase holds what is not yet built.** Phase 2's `decide` makes no route; Phase 3 adds the fan-out over a result, and until then such a step waits. A routed instance at a phase's checkpoint is never wrong, only incomplete; the branch is merged whole after Phase 5.

The decisions each task made, in its order:

- **Task 1.** The migration is §8's SQL as written, with a header in the style of 009's and 014's; `WRITERS.md` gains the three tables' rows and amends `kanban_workflow_instances` and `kanban_events` here, and `kanban_workflow_tasks` and `kanban_subscriptions` in Task 13, where the routing first writes them.
- **Task 2.** `hasRouting(db)` reads `user_version`, as `hasWakeColumns` does: only migration 015 adds the columns.
- **Task 2.** `plannedMemberOf` is a read of its own, not a change to `memberOf`, whose answer `task show` and the tests compare whole.
- **Task 3.** `paramFanOut(step)` names the list param a step fans out over, so the code that reads `forEach` as a param, the checks, `personParams`, `titleParams` and `expand`, reads it unchanged.
- **Task 3.** An empty `when` is refused, `steps.next.when is a list of clauses, at least one`: a clause list with none would make the step pending for nothing.
- **Task 3.** A clause's text value and an enum value holding a known secret are refused, as they are stored as written (§7.3).
- **Task 4.** A clause on a list output is refused, `steps.va.when[0] names intake.packages, a list: a list is read by a fan-out only` (§19's "No clause on a list output"), the spec giving no words.
- **Task 4.** The outputs sentence follows the outcome after a blank line, or stands alone for a step with none.
- **Task 5.** A handler's ancestors, for its references, are those every step routing to it shares, so a reference never names a step one of them may not have.
- **Task 5.** A handler's `{{item}}` refused for a step that is no fan-out keeps the existing words, `uses {{item}}, which only a for_each step has`.
- **Task 6.** `usesRouting(w)` is the test of a file using a routing key, shared by the check, the expansion and the DAG paths; an explicit `on_blocked: wait` is no use of one.
- **Task 7.** Every step has its template in the plan, plain ones included, as a stand-in for a plain step takes its reviewer, gates and contract (§5.2, §7.3).
- **Task 7.** A template's `wake` is null from the expansion; the service fills it in Task 8, as only it knows the start's wake.
- **Task 8.** The template check is `checkDagTasks` over a DAG of the filled templates, so a template is refused in the words a start's task is.
- **Task 8.** The preview makes the same checks as the start, as it does every other (workflows spec §6).
- **Task 9.** A person's done carries no metadata, so it is refused `output kind is missing` on a step with outputs, the same check.
- **Task 9.** A list's items are numbered from 1 in a refusal, as §2.2's `item 4 of output packages` reads.
- **Task 10.** The keys are named in one order, `outputs, when, for_each over an output, on_blocked, on_gave_up, handler`, as §13.5's message lists them.
- **Task 11.** `decide` keeps a running count of the members it makes, so two steps made in one call are counted together against the cap.
- **Task 11.** A skipped step settles as `archived` when it was skipped by archive or every parent's row is `archived`, else `skipped`, its event id the greatest of its parents' (§8).
- **Task 12.** `record` answers the event's id, so a transition hands its event to the routing as the decision's `cause_event`.
- **Task 12.** The sweep writes a member's row in the transaction of its own transition, and reads `entered` only for steps a `state` clause names, so a plain instance pays for no event read.
- **Task 13.** `insertTask`'s copied subscription becomes a list, `copySubscriptions`, which a reaction task gives one of and a late task its first member's; given, they are the task's only subscriptions.
- **Task 14.** The service passes the team, `#facts()`, to `complete`, `block`, `endRun` and `archive` (§9.3).
- **Task 15.** A busy database is not a fault: `isBusy`, exported from `src/db/open.ts`, rethrows it out of the savepoint, so `txImmediate` retries the transition whole.
- **Task 15.** The fault's error is masked and cut at 500 characters, as §9.4 says; the instance is found again outside the savepoint by a read that parses no JSON.
- **Task 16.** The skip is `by: instance`, so `show` and the notice tell it from a skip by a `when`.
- **Task 17.** A reconciliation that faults again throws, writing nothing; `retryRouting` catches it, and the mark stays for the next pass.
- **Task 18.** An instance whose every member is archived is `archived`, whatever its pending rows say, as before.
- **Task 19.** A result fan-out with no `when` gives its made line the why `per item of intake.packages`.
- **Task 20.** A stand-in's report is reserved against its step's fan-outs, as its result is read in its step's place.
- **Task 21.** A route made counts against the cap in the same call, as a made step does.
- **Task 22.** A route on a board found archived makes nothing and writes no row, so the routed task waits as with no route (§13.1).
- **Task 22.** A route is due only for the task's latest block, `latestBlockOf`, which must be the trigger: a block lifted, or a later stop, routes nothing.
- **Task 22.** `BOARD_KEYS` gains `routedFrom` and `standIn`, so the ids are never masked as text.
- **Task 23.** A handler's `stale` refusal names the handler, `the block of task k_… the handler escalate:1 was routed from has been lifted already`, not the button the old words name.
- **Task 23.** The prefix is the writer's, `(by the handler escalate:1) `, beside a woken turn's, so every path stores it alike.
- **Task 24.** A stand-in for a fan-out item takes the item's template's fields, a list param's, or the fan-out's one template.
- **Task 25.** A winning stand-in's archive returns the routed task's run only when that run was undecided: one that had reported is ending its own turn.
- **Task 26.** The service cancels in one place, `#cancelled`, wrapped around each deciding writer's call; a caller that cancels too cancels a run already cancelled, which does nothing (§9.5).
- **Task 27.** A handler's task's line names its ref, `escalate:1`, as §12.1's example shows.
- **Task 28.** A fan-out's line names at most 20 items, then how many more, as the payload holds.
- **Task 29.** `waiting` is present only for an instance with a plan, so an old file's answers are as they were.
- **Task 30.** An instance is due with a waiting step, a skipped step not yet settled, a member blocked from its work whose step routes and has a route due, or a fault not reconciled; a handler, having no row, never makes one due.
- **Task 30.** A reconciliation that throws marks an instance not yet marked, in a transaction of its own, with one `workflow_route_failed` event, `first`, on its first member; `mt kanban workflow reconcile` answers it in one line, `the routing of w_… failed: …; the gateway tries again`.
- **Task 30.** `RoutedLine` reaches the terminal through `service.ts`'s re-export, as only the service imports the writer.
- **Task 31.** The configuration guide is unchanged: routing adds no setting.
- **Task 32.** Every step is the default role's, so one fake agent runs them all, in the one shared workspace, one at a time.

## Known limitations

From §19, kept as it says: a fan-out at most its list's `max`, at most 100, an instance at most 500 tasks; at most 3 routes a routed task; no expressions, the five tests and four states, one `any` group; no clause on a fan-out step or a list output, no fan-out over a fan-out; no optional outputs, and outputs only from a role's run; handlers do not chain; no routing on a person's block or stop, a review's block or the team check's; no routing in a DAG; the plan is frozen; a late task's title and body are cut.

## Where the code forced a reading

- **Task 3.** §1 says an unknown key is an error naming its place, `steps.va.on_gave_up.rout`; the file's checks say it as `reject` says every unknown key, `unknown setting steps.va.on_gave_up.rout (known: route)`, which names that place.
- **Task 6.** §6 says `mt workflow check <name>` prints a line a step after the workflow's line; for a file using no routing key it prints only its line, as before, so that no old file's check changes (§7.1, "Old workflows don't change"). The user chose to keep it so.
- **Task 7.** §14 says a result never reaches a name field or a contract field; a result fan-out's `{{item}}`, and a handler's, is a result's, so the check refuses it in those fields too, `steps.each.outcome uses {{item}}, a result's: a result fills only a title and a body`.
- **Task 8.** §6 fills each reference to a result with its type's widest form at the start. A text output's widest is 8 KiB and a list's a hundred of those, wider than any title's 512 bytes, so every such reference would be refused; they take `(skipped)`, the text a skipped step fills, and are cut at the making as §7.4 says. Booleans take `false`, numbers the widest JSON number, an enum its longest value, each at least as wide as `(skipped)`.
- **Task 12.** §7.4 fills a reference to a skipped step's output with `(skipped)`; a step made while an ancestor it names is still unsettled, as one made on a `when: { state: gave_up }` of it, has no accepted value to read either, so the reference fills `(skipped)` too, and the text is never filled again once that ancestor settles.
- **Task 12.** §10's `Decision` and `StepFact` are the spec's in their meaning, with the fields the writer needs: a settled row's `eventId`, the items as a map by ref, a `fanned_out`'s `why`; and two reasons a step is skipped beyond decide's four, `board` for an archived board (§13.1, Task 13) and `instance` for `workflow archive` (§9.1, Task 16).
- **Task 12.** The review asked that `entered` be read only for the steps a `state` clause names, and only for members not yet settled. The first is done. The second is not: a `state` clause holds for a task that entered the state ever (§3.2), so a member that gave up and was later settled must still read as having given up, and its events are read.
- **Task 14.** §7.4's team check words a removed role `role verifier is not configured`; `checkTask` says it with quotes, so the writer says a role not configured itself, and any other refusal in `checkTask`'s words.
- **Task 20.** §2.2 counts "one for each step this result could make" in the reservation; the plan counts one for each other step still waiting, the most this result could make.
- **Task 21.** §10's `RouteFact` gains the event's block kind and reason, the item's ref, and whether the transient limit blocked it, for the handler's paragraph and the notice's words.
- **Task 22.** §5.2 writes the paragraph's second sentence `it gave up: …` in its example and `It blocked (capability): …` and `It stopped after 10 throttles: …` beside it; the plan writes all three after the colon in lower case, as the example does. The unblock line is the same for a helper and a stand-in, the spec giving one.
- **Task 22.** §13.1 skips a step on a board found archived, and gives a route no outcome for it: a route there makes nothing, writes no row and says nothing, and the routed task waits as with no route.
- **Task 23.** `mt kanban unblock` outside a run was answered as the old form of the operator's `mt kanban task unblock` (tests/mt.test.ts); as a worker command it is now answered as `show`, `comment` and `link` are there, `not_in_a_run` with the operator's command named.
- **Task 24.** A stand-in declares its step's outputs (§5.2), and its own outcome would gain the outputs sentence a second time beside its step's, which the merge carries (§2.1); a stand-in's own outcome takes none.
- **Task 26.** §9.5 gives every deciding writer's result `superseded: RunRow[]`; it is present only when a routing superseded a run, so every existing caller and test of `complete`, `block`, `endRun` and `archive` sees the result it saw.
- **Task 27.** §12.1's lines are plain; chat's markdown escapes them as every label, so the parentheses read `\(` in the text Lark is sent and `(` on the screen. The failed-routing line says its time as `10:41 UTC`, as chat says every time in UTC.
- **Task 27.** §12.1 names no answer for `show --plan` of an instance with no plan: it is refused `invalid`, `instance w_… has no plan: its workflow uses no routing key, and --dag prints all it made`.
- **Task 28.** §12.2's notice head says `gave up` after the title; the payload gains `after`, the trigger's words, so the notifier reads it from the payload alone; and a stand-in left open is one more line, saying the handler is left open and why (§5.2's "a line of the `workflow_routed` notice"). The cap's line is the plan's: §5.3 gives only `the instance has 500 tasks`.
- **Task 30.** §11's terminal answer lists decisions as `verify skipped (intake.verify is false); exposure: 3 tasks`; the plan words the other outcomes after them: `va made`, `escalate routed from va`, `escalate stands in for va`, `va over the limit of routes`, `va not routed: the instance has 500 tasks`, `escalate left open`. The startup's reconciliation runs where the service is built, after the migration and before the dispatcher exists, so before its first pass.
- **Task 30.** §11 gives a failed reconciliation's answer no code: `mt kanban workflow reconcile` answers it `routing_failed`, a code of `mt`'s own, as `no_bot` and `not_in_a_run` are, and no `RefusalCode` (§16): none of the board's codes names a fault in its routing. A database still busy after `txImmediate`'s retries is no fault, so that reconciliation marks nothing and says nothing (§9.4, Task 15's `isBusy`).
- **Task 30.** §9.4 writes a fault's event on the transitioning task. A reconciliation has none, so its fault's event goes on the instance's first member, and only when it sets the mark, so a retry that faults again every minute says nothing more.
- **Task 32.** §17's end-to-end test says `report` is linked to the three items and to `escalate`; with `registry` skipped, §3.2's rule links `registry`'s effective parent, the intake, in its place, and the test expects the intake too.

## Left for the user to decide

Nothing. The two questions of the first version are answered: the spec's §1 now quotes its param's description, and `mt workflow check <name>` keeps listing steps only for a file using a routing key (Task 6).

## File map

| File | Tasks |
|---|---|
| `README.md` (modify) | 23, 27, 30, 31 |
| `docs/kanban-guide.md` (modify) | 31 |
| `schema/015_workflow_routing.sql` (create) | 1 |
| `skills/mt-kanban/SKILL.md` (modify) | 31 |
| `src/cli/mt.ts` (modify) | 27, 30 |
| `src/cli/operator.ts` (modify) | 10, 27, 29, 30 |
| `src/cli/plain.ts` (modify) | 27, 29 |
| `src/cli/workflow.ts` (modify) | 6 |
| `src/db/WRITERS.md` (modify) | 1, 13 |
| `src/db/kanban-read.ts` (modify) | 2, 12, 17, 18, 21, 22, 27, 30 |
| `src/db/kanban.ts` (modify) | 8, 12, 13, 14, 15, 16, 17, 22, 23, 24, 25, 26, 28, 29, 30 |
| `src/db/open.ts` (modify) | 15 |
| `src/index.ts` (modify) | 26, 30 |
| `src/kanban/chat-render.ts` (modify) | 27, 28, 29 |
| `src/kanban/chat.ts` (modify) | 29 |
| `src/kanban/dag.ts` (modify) | 9 |
| `src/kanban/dispatcher.ts` (modify) | 17 |
| `src/kanban/routing.ts` (create) | 2, 4, 5, 6, 8, 9, 11, 12, 19, 21, 22, 25, 27, 29 |
| `src/kanban/service.ts` (modify) | 8, 9, 10, 14, 17, 18, 20, 23, 26, 27, 29, 30 |
| `src/kanban/worker.ts` (modify) | 22, 23, 29 |
| `src/kanban/workflow.ts` (modify) | 3, 4, 5, 6, 7, 10, 18, 24 |
| `tests/cron-schema.test.ts` (modify) | 1 |
| `tests/docs-examples.test.ts` (modify) | 31 |
| `tests/docs-routing.test.ts` (create) | 31 |
| `tests/docs-wake.test.ts` (modify) | 23 |
| `tests/fakes/cli-agent.mjs` (modify) | 32 |
| `tests/gateway-startup.test.ts` (modify) | 1 |
| `tests/grants-writer.test.ts` (modify) | 1 |
| `tests/helpers/routing.ts` (create) | 3, 8, 12, 22 |
| `tests/kanban-boards-schema.test.ts` (modify) | 1 |
| `tests/kanban-schema.test.ts` (modify) | 1 |
| `tests/kanban-thread-roots.test.ts` (modify) | 1 |
| `tests/kanban-worker.test.ts` (modify) | 23 |
| `tests/kanban-workflow-schema.test.ts` (modify) | 1 |
| `tests/kanban-worktree-schema.test.ts` (modify) | 1 |
| `tests/mt-kanban-operator-tasks.test.ts` (modify) | 23 |
| `tests/mt-kanban-workflow.test.ts` (modify) | 30 |
| `tests/mt-kanban.test.ts` (modify) | 23 |
| `tests/mt.test.ts` (modify) | 23 |
| `tests/progress-schema.test.ts` (modify) | 1 |
| `tests/routing-archive-workflow.test.ts` (create) | 16 |
| `tests/routing-cap.test.ts` (create) | 20 |
| `tests/routing-check-handlers.test.ts` (create) | 5 |
| `tests/routing-check-lines.test.ts` (create) | 6 |
| `tests/routing-check.test.ts` (create) | 4 |
| `tests/routing-dag-paths.test.ts` (create) | 10 |
| `tests/routing-decide-fanout.test.ts` (create) | 19 |
| `tests/routing-decide.test.ts` (create) | 11 |
| `tests/routing-expand.test.ts` (create) | 7 |
| `tests/routing-fanout-writer.test.ts` (create) | 19 |
| `tests/routing-fault.test.ts` (create) | 15 |
| `tests/routing-file.test.ts` (create) | 3 |
| `tests/routing-gateway.e2e.ts` (create) | 32 |
| `tests/routing-handler-workspace.test.ts` (create) | 22 |
| `tests/routing-handlers.test.ts` (create) | 22 |
| `tests/routing-notices.test.ts` (create) | 28 |
| `tests/routing-outputs.test.ts` (create) | 9 |
| `tests/routing-preview.test.ts` (create) | 29 |
| `tests/routing-reconcile.test.ts` (create) | 30 |
| `tests/routing-retry.test.ts` (create) | 17 |
| `tests/routing-rows.test.ts` (create) | 2 |
| `tests/routing-schema.test.ts` (create) | 1 |
| `tests/routing-show.test.ts` (create) | 27 |
| `tests/routing-standin-settle.test.ts` (create) | 25 |
| `tests/routing-standin.test.ts` (create) | 24 |
| `tests/routing-start.test.ts` (create) | 8 |
| `tests/routing-status.test.ts` (create) | 18 |
| `tests/routing-superseded.test.ts` (create) | 26 |
| `tests/routing-sweep.test.ts` (create) | 12 |
| `tests/routing-team-check.test.ts` (create) | 14 |
| `tests/routing-triggers.test.ts` (create) | 21 |
| `tests/routing-unblock.test.ts` (create) | 23 |
| `tests/routing-worktree-base.test.ts` (create) | 13 |
| `tests/routing-writer.test.ts` (create) | 13 |
| `tests/wake-schema.test.ts` (modify) | 1 |

Running counts, unit then end to end: Task 1 3575 / 187, Task 2 3579 / 187, Task 3 3585 / 187, Task 4 3595 / 187, Task 5 3605 / 187, Task 6 3609 / 187, Task 7 3615 / 187, Task 8 3622 / 187, Task 9 3627 / 187, Task 10 3631 / 187, Task 11 3644 / 187, Task 12 3647 / 187, Task 13 3657 / 187, Task 14 3658 / 187, Task 15 3663 / 187, Task 16 3664 / 187, Task 17 3669 / 187, Task 18 3671 / 187, Task 19 3682 / 187, Task 20 3684 / 187, Task 21 3690 / 187, Task 22 3700 / 187, Task 23 3704 / 187, Task 24 3707 / 187, Task 25 3718 / 187, Task 26 3725 / 187, Task 27 3730 / 187, Task 28 3737 / 187, Task 29 3742 / 187, Task 30 3749 / 187, Task 31 3754 / 187, Task 32 3754 / 188.

---

## Phase 1: the schema and the frozen plan

Tasks 1 to 10. Migration 015 and its reads; the routing keys read and checked, the check's step lines; the expansion into the plain steps' DAG and a frozen plan; the plan stored at the start, its templates checked; the output check at completion; and the DAG paths refusing a routed file. Nothing decides yet: a routed instance's pending steps wait. Phase 1 ends green, a checkpoint to review at.

---

### Task 1: Migration 015

**Files:**

- Create: `schema/015_workflow_routing.sql`, `tests/routing-schema.test.ts`
- Modify: `src/db/WRITERS.md`, `tests/cron-schema.test.ts`, `tests/gateway-startup.test.ts`, `tests/grants-writer.test.ts`, `tests/kanban-boards-schema.test.ts`, `tests/kanban-schema.test.ts`, `tests/kanban-thread-roots.test.ts`, `tests/kanban-workflow-schema.test.ts`, `tests/kanban-worktree-schema.test.ts`, `tests/progress-schema.test.ts`, `tests/wake-schema.test.ts`

§8. The one migration of the plan: `kanban_workflow_instances` gains `plan` and `routing_failed_at`; `kanban_workflow_pending`, `kanban_workflow_settled` and `kanban_workflow_routes` are new, with their checks and indexes, as §8 writes them. Nothing reads or writes them yet, so the other changes are the schema tests that pin version 14, which now pin 15, `kanban-schema.test.ts`'s list of the board's tables, `kanban-workflow-schema.test.ts`'s list of the workflows' own, and `src/db/WRITERS.md`'s rows for the three tables and the two columns.

- [ ] **Step 1.1: Write the tests.**

In `tests/cron-schema.test.ts`, replace:

```ts
    // 011 adds tier_grants, 012 kanban_unblock_buttons, 013 the wakes' tables, 014 kanban_progress_cards.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(14);
```

with:

```ts
    // 011 adds tier_grants, 012 kanban_unblock_buttons, 013 the wakes' tables, 014 kanban_progress_cards, 015 the routing's tables.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(15);
```

In `tests/cron-schema.test.ts`, replace:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(14);
```

with:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(15);
```

In `tests/gateway-startup.test.ts`, replace:

```ts
      expect(lines.some((l) => l.endsWith(` schema at version 14 (${config.dbPath})\n`))).toBe(true);
```

with:

```ts
      expect(lines.some((l) => l.endsWith(` schema at version 15 (${config.dbPath})\n`))).toBe(true);
```

In `tests/grants-writer.test.ts`, replace:

```ts
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(14);
```

with:

```ts
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(15);
```

In `tests/grants-writer.test.ts`, replace:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(14);
```

with:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(15);
```

In `tests/kanban-boards-schema.test.ts`, replace:

```ts
    expect(migrate(db, SCHEMA_DIR)).toBe(14);
```

with:

```ts
    expect(migrate(db, SCHEMA_DIR)).toBe(15);
```

In `tests/kanban-boards-schema.test.ts`, replace:

```ts
    // 010 left the row at 9; 011 to 014 set it again.
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 14 });
```

with:

```ts
    // 010 left the row at 9; 011 to 015 set it again.
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 15 });
```

In `tests/kanban-schema.test.ts`, replace:

```ts
    // 009 the workflows' two tables, 010 cron's, 011 tier_grants, 012 kanban_unblock_buttons, 013 the wakes' three tables, 014 kanban_progress_cards.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(14);
```

with:

```ts
    // 009 the workflows' two tables, 010 cron's, 011 tier_grants, 012 kanban_unblock_buttons, 013 the wakes' three tables, 014 kanban_progress_cards,
    // 015 the routing's three tables.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(15);
```

In `tests/kanban-schema.test.ts`, replace:

```ts
      { name: 'kanban_workflow_instances', strict: 1 },
```

with:

```ts
      { name: 'kanban_workflow_instances', strict: 1 },
      { name: 'kanban_workflow_pending', strict: 1 },
      { name: 'kanban_workflow_routes', strict: 1 },
      { name: 'kanban_workflow_settled', strict: 1 },
```

In `tests/kanban-thread-roots.test.ts`, replace:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(14);
```

with:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(15);
```

In `tests/kanban-workflow-schema.test.ts`, replace:

```ts
        "SELECT name, strict, wr FROM pragma_table_list WHERE name LIKE 'kanban_workflow_%' ORDER BY name",
```

with:

```ts
        "SELECT name, strict, wr FROM pragma_table_list WHERE name IN ('kanban_workflow_instances', 'kanban_workflow_tasks') ORDER BY name",
```

In `tests/kanban-workflow-schema.test.ts`, replace:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(14);
```

with:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(15);
```

In `tests/kanban-worktree-schema.test.ts`, replace:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(14);
```

with:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(15);
```

In `tests/progress-schema.test.ts`, replace:

```ts
  it('is migrated to version 14, its table STRICT, with its columns and its partial index', () => {
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(14);
    expect(h.db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 14 });
```

with:

```ts
  it('is migrated past version 14, its table STRICT, with its columns and its partial index', () => {
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(15);
    expect(h.db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 15 });
```

Create `tests/routing-schema.test.ts`:

```ts
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb } from '../src/db/open.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { NOW, newTask } from './helpers/kanban.js';

/**
 * Migration 015 (workflow routing spec §8): an instance's frozen plan and its
 * fault mark; a pending step's one row, moving once from `waiting`; a member's
 * settling, keyed by its step and ref; a route, keyed by its handler and the
 * event it routed.
 */

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

const indexes = (table: string): string[] =>
  h.db
    .prepare<[string], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name LIKE 'idx_%' ORDER BY name")
    .all(table)
    .map((r) => r.name);

function insert(table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  h.db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row));
}

function instance(id = 'w_1', extra: Record<string, unknown> = {}): void {
  insert('kanban_workflow_instances', {
    instance_id: id,
    name: 'vi-workflow',
    dag: '{}',
    dag_sha256: 'x',
    source: 'start',
    board: 'default',
    created_by: 'lark:on_alice',
    created_via: '{}',
    created_at: NOW,
    ...extra,
  });
}

describe('migration 015', () => {
  it('is migrated to version 15, its three tables STRICT, the pending and settled rows WITHOUT ROWID, with their indexes', () => {
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(15);
    expect(h.db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 15 });
    const strict = h.db
      .prepare<[], { name: string; strict: number; wr: number }>(
        "SELECT name, strict, wr FROM pragma_table_list WHERE name IN ('kanban_workflow_pending', 'kanban_workflow_settled', 'kanban_workflow_routes') ORDER BY name",
      )
      .all();
    expect(strict).toEqual([
      { name: 'kanban_workflow_pending', strict: 1, wr: 1 },
      { name: 'kanban_workflow_routes', strict: 1, wr: 0 },
      { name: 'kanban_workflow_settled', strict: 1, wr: 1 },
    ]);
    expect(indexes('kanban_workflow_pending')).toEqual(['idx_kanban_workflow_pending_waiting']);
    expect(indexes('kanban_workflow_routes')).toEqual(['idx_kanban_workflow_routes_from', 'idx_kanban_workflow_routes_task']);
    expect(indexes('kanban_workflow_settled')).toEqual([]);
  });

  it("gives an instance a plan, checked to be JSON, and a fault mark, both null unless written", () => {
    instance();
    expect(h.db.prepare("SELECT plan, routing_failed_at FROM kanban_workflow_instances WHERE instance_id = 'w_1'").get()).toEqual({ plan: null, routing_failed_at: null });
    expect(() => instance('w_2', { plan: 'not json' })).toThrow(/CHECK constraint failed/);
    instance('w_3', { plan: '{"format":1,"steps":[]}', routing_failed_at: NOW });
  });

  it('keys a pending row by its instance and step, decided_at set exactly when it is no longer waiting', () => {
    instance();
    insert('kanban_workflow_pending', { instance_id: 'w_1', step: 'va', state: 'waiting' });
    expect(() => insert('kanban_workflow_pending', { instance_id: 'w_1', step: 'va', state: 'waiting' })).toThrow(/UNIQUE constraint failed/);
    expect(() => insert('kanban_workflow_pending', { instance_id: 'w_1', step: 'verify', state: 'skipped' })).toThrow(/CHECK constraint failed/);
    expect(() => insert('kanban_workflow_pending', { instance_id: 'w_1', step: 'patch', state: 'waiting', decided_at: NOW })).toThrow(/CHECK constraint failed/);
    expect(() => insert('kanban_workflow_pending', { instance_id: 'w_1', step: 'report', state: 'done', decided_at: NOW })).toThrow(/CHECK constraint failed/);
    expect(() => insert('kanban_workflow_pending', { instance_id: 'w_1', step: 'exposure', state: 'made', decided_at: NOW, items: '[' })).toThrow(/CHECK constraint failed/);
    insert('kanban_workflow_pending', { instance_id: 'w_1', step: 'exposure', state: 'made', decided_at: NOW, items: '[]', reason: '{}', cause_event: 7 });
    expect(() => insert('kanban_workflow_pending', { instance_id: 'w_9', step: 'va', state: 'waiting' })).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('keys a settled row by its instance, step and ref, with one of four ways', () => {
    instance();
    const task = newTask(h.db);
    insert('kanban_workflow_settled', { instance_id: 'w_1', step: 'va', ref: 'va', how: 'done', task_id: task.taskId, event_id: 3, settled_at: NOW });
    insert('kanban_workflow_settled', { instance_id: 'w_1', step: 'exposure', ref: 'exposure:1', how: 'archived', event_id: 4, settled_at: NOW });
    expect(() => insert('kanban_workflow_settled', { instance_id: 'w_1', step: 'va', ref: 'va', how: 'stood_in', event_id: 5, settled_at: NOW })).toThrow(/UNIQUE constraint failed/);
    expect(() => insert('kanban_workflow_settled', { instance_id: 'w_1', step: 'x', ref: 'x', how: 'made', event_id: 5, settled_at: NOW })).toThrow(/CHECK constraint failed/);
    expect(() => insert('kanban_workflow_settled', { instance_id: 'w_1', step: 'y', ref: 'y', how: 'done', task_id: 'k_none', event_id: 5, settled_at: NOW })).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('keys a route row by its instance, handler and event, its task set exactly when it was made', () => {
    instance();
    const from = newTask(h.db);
    const handler = newTask(h.db);
    insert('kanban_workflow_routes', { instance_id: 'w_1', handler: 'escalate', event_id: 9, from_task: from.taskId, outcome: 'made', task_id: handler.taskId, created_at: NOW });
    insert('kanban_workflow_routes', { instance_id: 'w_1', handler: 'escalate', event_id: 12, from_task: from.taskId, outcome: 'over_limit', created_at: NOW });
    expect(() =>
      insert('kanban_workflow_routes', { instance_id: 'w_1', handler: 'escalate', event_id: 9, from_task: from.taskId, outcome: 'over_cap', created_at: NOW }),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      insert('kanban_workflow_routes', { instance_id: 'w_1', handler: 'escalate', event_id: 13, from_task: from.taskId, outcome: 'made', created_at: NOW }),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      insert('kanban_workflow_routes', {
        instance_id: 'w_1',
        handler: 'escalate',
        event_id: 14,
        from_task: from.taskId,
        outcome: 'over_cap',
        task_id: handler.taskId,
        created_at: NOW,
      }),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      insert('kanban_workflow_routes', { instance_id: 'w_1', handler: 'escalate', event_id: 15, from_task: from.taskId, outcome: 'routed', created_at: NOW }),
    ).toThrow(/CHECK constraint failed/);
  });

  it('migrates a database at version 14 with an instance in it: its plan and fault mark null, no row in the three tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-routing-schema-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) {
        if (/^01[0-4]_.*\.sql$/.test(f) || /^00[1-9]_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      }
      const d = openDb(join(dir, 'team.db'));
      try {
        expect(migrate(d, only)).toBe(14);
        // Written as version 14 wrote it, not through today's writer.
        d.prepare(
          `INSERT INTO kanban_workflow_instances (instance_id, name, dag, dag_sha256, source, board, created_by, created_via, created_at)
           VALUES ('w_old', 'vendor-eval', '{}', 'x', 'start', 'default', 'lark:on_alice', '{}', ?)`,
        ).run(NOW);
        expect(migrate(d, SCHEMA_DIR)).toBe(15);
        expect(d.prepare("SELECT plan, routing_failed_at FROM kanban_workflow_instances WHERE instance_id = 'w_old'").get()).toEqual({
          plan: null,
          routing_failed_at: null,
        });
        for (const table of ['kanban_workflow_pending', 'kanban_workflow_settled', 'kanban_workflow_routes']) {
          expect(d.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        }
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

In `tests/wake-schema.test.ts`, replace:

```ts
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(14);
    expect(h.db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 14 });
```

with:

```ts
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(15);
    expect(h.db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 15 });
```

In `tests/wake-schema.test.ts`, replace:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(14);
```

with:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(15);
```

- [ ] **Step 1.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/cron-schema.test.ts tests/gateway-startup.test.ts tests/grants-writer.test.ts tests/kanban-boards-schema.test.ts tests/kanban-schema.test.ts tests/kanban-thread-roots.test.ts tests/kanban-workflow-schema.test.ts tests/kanban-worktree-schema.test.ts tests/progress-schema.test.ts tests/routing-schema.test.ts tests/wake-schema.test.ts`. Expected: `Tests  19 failed | 70 passed (89)`, the first as `AssertionError: expected 14 to be 15 // Object.is equality`.

- [ ] **Step 1.3: Implement.**

Create `schema/015_workflow_routing.sql`:

```sql
-- manus-team migration 015: workflow routing
-- See docs/specs/2026-11-26-workflow-routing-design.md §8.
--
-- A started instance keeps its plan, frozen: each step's conditions, fan-out,
-- outputs, routes and template (§7.3). A pending step has one row, `waiting`
-- until it is made or skipped, once; a member's settling, plain steps included,
-- one row whose winner is read for good (§2.3); a route, one row keyed on the
-- event it routed (§5.3). Nothing in the kernel reads any of them: the writer,
-- db/kanban.ts, writes them in the transitions that settle, block or give up a
-- task (§9), and is their only writer (src/db/WRITERS.md). An instance made
-- before 015 has a null plan and no row, and is read, shown and archived as
-- before (§8).
ALTER TABLE kanban_workflow_instances ADD COLUMN plan TEXT CHECK (plan IS NULL OR json_valid(plan));
ALTER TABLE kanban_workflow_instances ADD COLUMN routing_failed_at INTEGER;  -- a fault not yet reconciled (§9.4)

CREATE TABLE kanban_workflow_pending (
  instance_id  TEXT NOT NULL REFERENCES kanban_workflow_instances(instance_id),
  step         TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('waiting', 'made', 'skipped')),
  reason       TEXT CHECK (reason IS NULL OR json_valid(reason)),  -- why it was made or skipped, masked
  items        TEXT CHECK (items IS NULL OR json_valid(items)),    -- a fan-out's join marker: [{item, task_id, ref}]
  cause_event  INTEGER,                                            -- the event whose transaction decided it
  decided_at   INTEGER,
  PRIMARY KEY (instance_id, step),
  CHECK ((state = 'waiting') = (decided_at IS NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_kanban_workflow_pending_waiting ON kanban_workflow_pending(instance_id) WHERE state = 'waiting';

-- A member's settling, plain steps included: whose result is the member's, for good (§2.3).
-- ref: the step's name for a step that is no fan-out, and for a fan-out's own row; an item's ref for an item.
CREATE TABLE kanban_workflow_settled (
  instance_id  TEXT NOT NULL REFERENCES kanban_workflow_instances(instance_id),
  step         TEXT NOT NULL,
  ref          TEXT NOT NULL,
  how          TEXT NOT NULL CHECK (how IN ('done', 'stood_in', 'skipped', 'archived')),
  task_id      TEXT REFERENCES kanban_tasks(task_id),               -- the winner; null for skipped, archived, a fan-out's own row
  event_id     INTEGER NOT NULL,                                   -- see §8: the fact that settled it, not the transaction
  settled_at   INTEGER NOT NULL,
  PRIMARY KEY (instance_id, step, ref)
) STRICT, WITHOUT ROWID;

CREATE TABLE kanban_workflow_routes (
  instance_id  TEXT NOT NULL REFERENCES kanban_workflow_instances(instance_id),
  handler      TEXT NOT NULL,
  event_id     INTEGER NOT NULL,                                   -- the blocked or run_ended event routed
  from_task    TEXT NOT NULL REFERENCES kanban_tasks(task_id),
  outcome      TEXT NOT NULL CHECK (outcome IN ('made', 'over_limit', 'over_cap')),
  task_id      TEXT REFERENCES kanban_tasks(task_id),               -- the handler's task; null unless made
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (instance_id, handler, event_id),
  CHECK ((outcome = 'made') = (task_id IS NOT NULL))
) STRICT;

CREATE INDEX idx_kanban_workflow_routes_from ON kanban_workflow_routes(from_task);
CREATE INDEX idx_kanban_workflow_routes_task ON kanban_workflow_routes(task_id) WHERE task_id IS NOT NULL;

UPDATE schema_version SET version = 15;
```

In `src/db/WRITERS.md`, replace:

```markdown
| `kanban_events` | `db/kanban.ts` | Append-only, written in the transaction of the change it records. String values in `payload` are masked on write (spec §10.1). `createTask` writes `task_created_followed` after `created` for a task a terminal named a chat to follow, the "Created" line the notifier posts there (kanban spec §22.1); and `applyDag` writes `workflow_started` on an instance's first member, after its member rows, for an instance a terminal named a chat to follow, holding the start's reply for the notifier (workflows spec §18.2). `setWake` writes `wake_set`, and `createTask` and `applyDag` write one for a task made with wake on, inherited or asked for, or refused as too deep (wake spec §4.4). `unblock` writes `wake` in an `unblocked` event's payload for a woken turn's unblock (wake spec §9.3). |
```

with:

```markdown
| `kanban_events` | `db/kanban.ts` | Append-only, written in the transaction of the change it records. String values in `payload` are masked on write (spec §10.1). `createTask` writes `task_created_followed` after `created` for a task a terminal named a chat to follow, the "Created" line the notifier posts there (kanban spec §22.1); and `applyDag` writes `workflow_started` on an instance's first member, after its member rows, for an instance a terminal named a chat to follow, holding the start's reply for the notifier (workflows spec §18.2). `setWake` writes `wake_set`, and `createTask` and `applyDag` write one for a task made with wake on, inherited or asked for, or refused as too deep (wake spec §4.4). `unblock` writes `wake` in an `unblocked` event's payload for a woken turn's unblock (wake spec §9.3). The routing (migration 015) writes `workflow_routed` on the task whose transition decided, listing every decision of that transaction, and `workflow_route_failed` on it when the routing faulted, `first` only when it set the instance's `routing_failed_at` (workflow routing spec §9.2, §9.4, §12.2). |
```

In `src/db/WRITERS.md`, replace:

```markdown
| `kanban_workflow_instances` | `db/kanban.ts` | Added by `applyDag` (migration 009), in the transaction that makes every task, link, gate and member of the instance, a start's included (workflows spec §8); never updated or deleted. `dag` is the DAG it was made from, its string values masked on write but its gates' commands; `dag_sha256` is of its canonical form, unmasked, and never printed. `idempotency_key` is kept for good, an archived instance's included. |
```

with:

```markdown
| `kanban_workflow_instances` | `db/kanban.ts` | Added by `applyDag` (migration 009), in the transaction that makes every task, link, gate and member of the instance, a start's included (workflows spec §8); never updated or deleted. `dag` is the DAG it was made from, its string values masked on write but its gates' commands; `dag_sha256` is of its canonical form, unmasked, and never printed. `idempotency_key` is kept for good, an archived instance's included. `plan` (migration 015) is written by `applyDag` only, in the same insert, and never changed (workflow routing spec §7.3); `routing_failed_at` is set by a routing fault from null, and cleared by the reconciliation that succeeds (§9.4). |
```

In `src/db/WRITERS.md`, replace:

```markdown
| `kanban_workflow_tasks` | `db/kanban.ts` | Added by `applyDag`, one row a task it made, in its transaction; never added later, changed or removed: a member is exactly what the apply made (workflows spec §7). `item` is masked on write. Read by the workflow commands and by `task show`'s one line, and by nothing in the kernel. |
```

with:

```markdown
| `kanban_workflow_tasks` | `db/kanban.ts` | Added by `applyDag`, one row a task it made, in its transaction; never added later, changed or removed: a member is exactly what the apply made (workflows spec §7). `item` is masked on write. Read by the workflow commands and by `task show`'s one line, and by nothing in the kernel. |
| `kanban_workflow_pending` | `db/kanban.ts` | Added by `applyDag` (migration 015), one `waiting` row a pending step of an instance with a plan, in its transaction; a handler has none (workflow routing spec §7.2). `state` moves once, from `waiting` to `made` or `skipped`, with `reason`, `cause_event` and `decided_at`, and a fan-out's `items`, by an `UPDATE … WHERE state = 'waiting'` in the routing's savepoint, or by `archiveWorkflow`, which skips every waiting row (§9.1). `reason` and `items` are masked on write. Never deleted. |
| `kanban_workflow_settled` | `db/kanban.ts` | Added by the routing (migration 015), one row a member's settling, plain steps included, by `INSERT` into its key, whichever transition or reconciliation first finds the facts justify it; never changed or deleted (workflow routing spec §8). |
| `kanban_workflow_routes` | `db/kanban.ts` | Added by the routing (migration 015), one row a route of a trigger event, `made` with its handler's task, or `over_limit` or `over_cap`; never changed or deleted (workflow routing spec §5.3, §8). |
```

- [ ] **Step 1.4: Run them to verify they pass.** Run the same command. Expected: `Tests  89 passed (89)`.

- [ ] **Step 1.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3575 passed (3575)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 1.6: Commit.**

```bash
git add schema/015_workflow_routing.sql src/db/WRITERS.md tests/cron-schema.test.ts tests/gateway-startup.test.ts tests/grants-writer.test.ts tests/kanban-boards-schema.test.ts tests/kanban-schema.test.ts tests/kanban-thread-roots.test.ts tests/kanban-workflow-schema.test.ts tests/kanban-worktree-schema.test.ts tests/progress-schema.test.ts tests/routing-schema.test.ts tests/wake-schema.test.ts
git commit -m "Add migration 015: an instance's frozen plan and its fault mark, the pending steps, the settled members and the routes"
```

---

### Task 2: The rows read the new columns

**Files:**

- Create: `src/kanban/routing.ts`, `tests/routing-rows.test.ts`
- Modify: `src/db/kanban-read.ts`

§7.3, §8. `InstanceRow` gains `plan` and `routingFailedAt`; `hasRouting(db)` says whether the database is at 15; `pendingOf`, `settledOf`, `routesOf`, `routesFrom` and `routeOfHandler` read the three tables; and `plannedMemberOf` finds a task's member row joined to its instance's plan in one read, the one cost every settling transition pays (§9.2 step 1). `src/kanban/routing.ts` is made here, with the plan's types only. On a database before 015 every read gives nothing.

- [ ] **Step 2.1: Write the tests.**

Create `tests/routing-rows.test.ts`:

```ts
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getInstance,
  hasRouting,
  pendingOf,
  plannedMemberOf,
  routeOfHandler,
  routesFrom,
  routesOf,
  settledOf,
} from '../src/db/kanban-read.js';
import { migrate, openDb } from '../src/db/open.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { NOW, newTask } from './helpers/kanban.js';

/**
 * The routing's rows read back (workflow routing spec §8): an instance's plan
 * and fault mark, its pending, settled and route rows, a handler's route by its
 * task, and a member with its planned instance in one read; and nothing of them
 * on a database the gateway has not yet migrated to 015.
 */

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

const PLAN = { format: 1, steps: [{ step: 'intake', made: 'start', parents: [], outputs: { verify: 'boolean' }, on_blocked: 'wait', on_gave_up: 'wait' }] };

function insert(table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  h.db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row));
}

function instance(id: string, plan: unknown = null, failedAt: number | null = null): void {
  insert('kanban_workflow_instances', {
    instance_id: id,
    name: 'vi-workflow',
    dag: '{"format":1}',
    dag_sha256: 'x',
    source: 'start',
    board: 'default',
    created_by: 'lark:on_alice',
    created_via: '{"kind":"operator"}',
    created_at: NOW,
    plan: plan === null ? null : JSON.stringify(plan),
    routing_failed_at: failedAt,
  });
}

function member(taskId: string, instanceId: string, ref: string, step: string, position: number): void {
  insert('kanban_workflow_tasks', { task_id: taskId, instance_id: instanceId, ref, step, item: null, position });
}

describe('the routing rows', () => {
  it("reads an instance's plan and its fault mark, null for an instance with none", () => {
    instance('w_1', PLAN, NOW + 5);
    instance('w_2');
    expect(getInstance(h.db, 'w_1')).toMatchObject({ instanceId: 'w_1', plan: PLAN, routingFailedAt: NOW + 5 });
    expect(getInstance(h.db, 'w_2')).toMatchObject({ instanceId: 'w_2', plan: null, routingFailedAt: null });
    expect(hasRouting(h.db)).toBe(true);
  });

  it('reads the pending, settled and route rows of an instance, decoded', () => {
    instance('w_1', PLAN);
    const [a, b] = [newTask(h.db), newTask(h.db)];
    insert('kanban_workflow_pending', { instance_id: 'w_1', step: 'verify', state: 'waiting' });
    insert('kanban_workflow_pending', {
      instance_id: 'w_1',
      step: 'exposure',
      state: 'made',
      reason: JSON.stringify({ why: 'intake.packages has 1 item' }),
      items: JSON.stringify([{ item: 'lodash', taskId: a.taskId, ref: 'exposure:1' }]),
      cause_event: 4,
      decided_at: NOW,
    });
    insert('kanban_workflow_settled', { instance_id: 'w_1', step: 'intake', ref: 'intake', how: 'done', task_id: a.taskId, event_id: 4, settled_at: NOW });
    insert('kanban_workflow_routes', { instance_id: 'w_1', handler: 'escalate', event_id: 7, from_task: a.taskId, outcome: 'made', task_id: b.taskId, created_at: NOW });
    insert('kanban_workflow_routes', { instance_id: 'w_1', handler: 'escalate', event_id: 9, from_task: a.taskId, outcome: 'over_limit', created_at: NOW });
    expect(pendingOf(h.db, 'w_1')).toEqual([
      {
        instanceId: 'w_1',
        step: 'exposure',
        state: 'made',
        reason: { why: 'intake.packages has 1 item' },
        items: [{ item: 'lodash', taskId: a.taskId, ref: 'exposure:1' }],
        causeEvent: 4,
        decidedAt: NOW,
      },
      { instanceId: 'w_1', step: 'verify', state: 'waiting', reason: null, items: null, causeEvent: null, decidedAt: null },
    ]);
    expect(settledOf(h.db, 'w_1')).toEqual([
      { instanceId: 'w_1', step: 'intake', ref: 'intake', how: 'done', taskId: a.taskId, eventId: 4, settledAt: NOW },
    ]);
    const made = { instanceId: 'w_1', handler: 'escalate', eventId: 7, fromTask: a.taskId, outcome: 'made', taskId: b.taskId, createdAt: NOW };
    const over = { instanceId: 'w_1', handler: 'escalate', eventId: 9, fromTask: a.taskId, outcome: 'over_limit', taskId: null, createdAt: NOW };
    expect(routesOf(h.db, 'w_1')).toEqual([made, over]);
    expect(routesFrom(h.db, a.taskId)).toEqual([made, over]);
    expect(routesFrom(h.db, b.taskId)).toEqual([]);
    expect(routeOfHandler(h.db, b.taskId)).toEqual(made);
    expect(routeOfHandler(h.db, a.taskId)).toBeUndefined();
  });

  it('finds a member with its instance only when the instance has a plan', () => {
    instance('w_1', PLAN);
    instance('w_2');
    const [a, b, c] = [newTask(h.db), newTask(h.db), newTask(h.db)];
    member(a.taskId, 'w_1', 'intake', 'intake', 0);
    member(b.taskId, 'w_2', 'shortlist', 'shortlist', 0);
    expect(plannedMemberOf(h.db, a.taskId)).toMatchObject({
      member: { taskId: a.taskId, instanceId: 'w_1', ref: 'intake', step: 'intake', item: null, position: 0 },
      instance: { instanceId: 'w_1', name: 'vi-workflow', plan: PLAN, board: 'default' },
    });
    expect(plannedMemberOf(h.db, b.taskId)).toBeUndefined();
    expect(plannedMemberOf(h.db, c.taskId)).toBeUndefined();
  });

  it('reads a database at version 14 as having no plan and no row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-routing-rows-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) {
        if (/^01[0-4]_.*\.sql$/.test(f) || /^00[1-9]_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      }
      const d = openDb(join(dir, 'team.db'));
      try {
        expect(migrate(d, only)).toBe(14);
        d.prepare(
          `INSERT INTO kanban_workflow_instances (instance_id, name, dag, dag_sha256, source, board, created_by, created_via, created_at)
           VALUES ('w_old', 'vendor-eval', '{"format":1}', 'x', 'start', 'default', 'lark:on_alice', '{"kind":"operator"}', ?)`,
        ).run(NOW);
        const task = newTask(d);
        d.prepare("INSERT INTO kanban_workflow_tasks (task_id, instance_id, ref, step, item, position) VALUES (?, 'w_old', 'a', 'a', NULL, 0)").run(task.taskId);
        expect(hasRouting(d)).toBe(false);
        expect(getInstance(d, 'w_old')).toMatchObject({ instanceId: 'w_old', plan: null, routingFailedAt: null });
        expect([pendingOf(d, 'w_old'), settledOf(d, 'w_old'), routesOf(d, 'w_old'), routesFrom(d, task.taskId)]).toEqual([[], [], [], []]);
        expect(routeOfHandler(d, task.taskId)).toBeUndefined();
        expect(plannedMemberOf(d, task.taskId)).toBeUndefined();
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-rows.test.ts`. Expected: `Tests  4 failed (4)`, the first as `AssertionError: expected { instanceId: 'w_1', …(8) } to match object { instanceId: 'w_1', …(2) }`.

- [ ] **Step 2.3: Implement.**

In `src/db/kanban-read.ts`, replace:

```ts
import type { Dag } from '../kanban/dag.js';
```

with:

```ts
import type { Dag } from '../kanban/dag.js';
import type { PendingState, Plan, RouteOutcome, SettledHow, SkippedBy } from '../kanban/routing.js';
```

In `src/db/kanban-read.ts`, replace:

```ts
  createdAt: number;
```

with:

```ts
  createdAt: number;
  /** Its frozen plan (workflow routing spec §7.3); null for an instance with none, and on a database before 015. */
  plan: Plan | null;
  /** When its routing last faulted, while no reconciliation has succeeded since (§9.4); null otherwise. */
  routingFailedAt: number | null;
```

In `src/db/kanban-read.ts`, replace:

```ts
  idempotency_key: string | null;
  created_at: number;
}
```

with:

```ts
  idempotency_key: string | null;
  created_at: number;
  plan: string | null;
  routing_failed_at: number | null;
}
```

In `src/db/kanban-read.ts`, replace:

```ts
const INSTANCE_COLS = 'instance_id, name, dag, dag_sha256, source, board, created_by, created_via, idempotency_key, created_at';
```

with:

```ts
const INSTANCE_BASE_COLS = 'instance_id, name, dag, dag_sha256, source, board, created_by, created_via, idempotency_key, created_at';

/**
 * Whether the database has migration 015's tables and columns (workflow routing
 * spec §8). The terminal opens the gateway's database without migrating it: on
 * one before 015, every instance reads with no plan, and the routing reads find
 * no row. Read from the file's header, as `hasWakeColumns` is.
 */
export function hasRouting(db: Db): boolean {
  return Number(db.pragma('user_version', { simple: true })) >= 15;
}

/** An instance's columns: the plan's, or what a database before 015 has for them. */
function instanceCols(db: Db): string {
  return hasRouting(db) ? `${INSTANCE_BASE_COLS}, plan, routing_failed_at` : `${INSTANCE_BASE_COLS}, NULL AS plan, NULL AS routing_failed_at`;
}
```

In `src/db/kanban-read.ts`, replace:

```ts
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
  };
```

with:

```ts
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
    plan: r.plan === null ? null : (JSON.parse(r.plan) as Plan),
    routingFailedAt: r.routing_failed_at,
  };
```

In `src/db/kanban-read.ts`, replace:

```ts
  const row = db.prepare<[string], InstanceRaw>(`SELECT ${INSTANCE_COLS} FROM kanban_workflow_instances WHERE instance_id = ?`).get(instanceId);
```

with:

```ts
  const row = db.prepare<[string], InstanceRaw>(`SELECT ${instanceCols(db)} FROM kanban_workflow_instances WHERE instance_id = ?`).get(instanceId);
```

In `src/db/kanban-read.ts`, replace:

```ts
    .prepare<[string], InstanceRaw>(`SELECT ${INSTANCE_COLS} FROM kanban_workflow_instances WHERE idempotency_key = ?`)
```

with:

```ts
    .prepare<[string], InstanceRaw>(`SELECT ${instanceCols(db)} FROM kanban_workflow_instances WHERE idempotency_key = ?`)
```

In `src/db/kanban-read.ts`, replace:

```ts
      `SELECT ${INSTANCE_COLS} FROM kanban_workflow_instances WHERE board = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
```

with:

```ts
      `SELECT ${instanceCols(db)} FROM kanban_workflow_instances WHERE board = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
```

In `src/db/kanban-read.ts`, replace:

```ts
    .all(instanceId, instanceId, instanceId)
    .map(decodeTask);
}
```

with:

```ts
    .all(instanceId, instanceId, instanceId)
    .map(decodeTask);
}

// ---------------------------------------------------------------------------
// Workflow routing (workflow routing spec §8)
// ---------------------------------------------------------------------------

/** Why a pending step was made or skipped (§8), as stored: masked. */
export interface PendingReason {
  /** For a skip: by its `when`, its source, the cap, an archive, its board, or the instance's archive. */
  by?: SkippedBy;
  why: string;
}

/** One task of a fan-out's join marker (§4.2): its item, masked, its task and its ref. */
export interface FanItem {
  item: string;
  taskId: string;
  ref: string;
}

/** A pending step's row (§8): `waiting`, then `made` or `skipped`, once. */
export interface PendingRow {
  instanceId: string;
  step: string;
  state: PendingState;
  reason: PendingReason | null;
  items: FanItem[] | null;
  causeEvent: number | null;
  decidedAt: number | null;
}

/** A member's settling (§8): its step and ref, how, its winner, and the fact that settled it. */
export interface SettledRow {
  instanceId: string;
  step: string;
  ref: string;
  how: SettledHow;
  taskId: string | null;
  eventId: number;
  settledAt: number;
}

/** A route of a trigger event (§5.3, §8): its handler, the event, the routed task, and the handler's task when made. */
export interface RouteRow {
  instanceId: string;
  handler: string;
  eventId: number;
  fromTask: string;
  outcome: RouteOutcome;
  taskId: string | null;
  createdAt: number;
}

interface PendingRaw {
  instance_id: string;
  step: string;
  state: string;
  reason: string | null;
  items: string | null;
  cause_event: number | null;
  decided_at: number | null;
}

interface SettledRaw {
  instance_id: string;
  step: string;
  ref: string;
  how: string;
  task_id: string | null;
  event_id: number;
  settled_at: number;
}

interface RouteRaw {
  instance_id: string;
  handler: string;
  event_id: number;
  from_task: string;
  outcome: string;
  task_id: string | null;
  created_at: number;
}

function decodePending(r: PendingRaw): PendingRow {
  return {
    instanceId: r.instance_id,
    step: r.step,
    state: r.state as PendingState,
    reason: r.reason === null ? null : (JSON.parse(r.reason) as PendingReason),
    items: r.items === null ? null : (JSON.parse(r.items) as FanItem[]),
    causeEvent: r.cause_event,
    decidedAt: r.decided_at,
  };
}

function decodeSettled(r: SettledRaw): SettledRow {
  return {
    instanceId: r.instance_id,
    step: r.step,
    ref: r.ref,
    how: r.how as SettledHow,
    taskId: r.task_id,
    eventId: r.event_id,
    settledAt: r.settled_at,
  };
}

function decodeRoute(r: RouteRaw): RouteRow {
  return {
    instanceId: r.instance_id,
    handler: r.handler,
    eventId: r.event_id,
    fromTask: r.from_task,
    outcome: r.outcome as RouteOutcome,
    taskId: r.task_id,
    createdAt: r.created_at,
  };
}

const ROUTE_COLS = 'instance_id, handler, event_id, from_task, outcome, task_id, created_at';

/** An instance's pending rows, by step; none on a database before 015. */
export function pendingOf(db: Db, instanceId: string): PendingRow[] {
  if (!hasRouting(db)) return [];
  return db
    .prepare<[string], PendingRaw>(
      'SELECT instance_id, step, state, reason, items, cause_event, decided_at FROM kanban_workflow_pending WHERE instance_id = ? ORDER BY step',
    )
    .all(instanceId)
    .map(decodePending);
}

/** An instance's settled rows, by step and ref; none on a database before 015. */
export function settledOf(db: Db, instanceId: string): SettledRow[] {
  if (!hasRouting(db)) return [];
  return db
    .prepare<[string], SettledRaw>(
      'SELECT instance_id, step, ref, how, task_id, event_id, settled_at FROM kanban_workflow_settled WHERE instance_id = ? ORDER BY step, ref',
    )
    .all(instanceId)
    .map(decodeSettled);
}

/** An instance's route rows, oldest first; none on a database before 015. */
export function routesOf(db: Db, instanceId: string): RouteRow[] {
  if (!hasRouting(db)) return [];
  return db
    .prepare<[string], RouteRaw>(`SELECT ${ROUTE_COLS} FROM kanban_workflow_routes WHERE instance_id = ? ORDER BY event_id, handler`)
    .all(instanceId)
    .map(decodeRoute);
}

/** The routes made from a task, by the index on `from_task`, oldest first. */
export function routesFrom(db: Db, taskId: string): RouteRow[] {
  if (!hasRouting(db)) return [];
  return db
    .prepare<[string], RouteRaw>(`SELECT ${ROUTE_COLS} FROM kanban_workflow_routes WHERE from_task = ? ORDER BY event_id, handler`)
    .all(taskId)
    .map(decodeRoute);
}

/** The route a handler's task was made by (§5.2, §5.4), by the index on `task_id`; undefined for any other task. */
export function routeOfHandler(db: Db, taskId: string): RouteRow | undefined {
  if (!hasRouting(db)) return undefined;
  const row = db.prepare<[string], RouteRaw>(`SELECT ${ROUTE_COLS} FROM kanban_workflow_routes WHERE task_id = ?`).get(taskId);
  return row === undefined ? undefined : decodeRoute(row);
}

/**
 * A task's member row and its instance, for an instance with a plan (§9.2 step
 * 1): one lookup by the members' primary key, joined to the instance. Undefined
 * for a task that is no member, for an instance with no plan, and on a database
 * before 015, which costs no read.
 */
export function plannedMemberOf(db: Db, taskId: string): { member: MemberRow; instance: InstanceRow } | undefined {
  if (!hasRouting(db)) return undefined;
  const row = db
    .prepare<[string], MemberRaw & InstanceRaw>(
      `SELECT m.task_id, m.ref, m.step, m.item, m.position, i.instance_id, i.name, i.dag, i.dag_sha256, i.source, i.board, i.created_by,
              i.created_via, i.idempotency_key, i.created_at, i.plan, i.routing_failed_at
         FROM kanban_workflow_tasks m JOIN kanban_workflow_instances i ON i.instance_id = m.instance_id
        WHERE m.task_id = ? AND i.plan IS NOT NULL`,
    )
    .get(taskId);
  return row === undefined ? undefined : { member: decodeMember(row), instance: decodeInstance(row) };
}
```

Create `src/kanban/routing.ts`:

```ts
import type { Contract, RetryOnCrash } from './types.js';

/**
 * Workflow routing (workflow routing spec): the plan an instance keeps, frozen
 * at its start (§7.3), and what decides, from it and the board's facts, which
 * of its pending steps are made, skipped, fanned out or routed (§10). Pure: it
 * imports no `db/` module, no service and no `workflow.ts`, so the writer,
 * `db/kanban.ts`, imports it as it imports `dag.ts`, and nothing here points
 * back (§9.3).
 */

/** The one plan format this build reads. */
export const PLAN_FORMAT = 1;

/** An output's type written as a bare word, or an enum (§2.1). */
export type ScalarType = 'boolean' | 'number' | 'string' | { enum: string[] };

/** An output's type: a scalar, or a list of one with its bound (§2.1). */
export type OutputType = ScalarType | { list: ScalarType; max: number };

/** A step's outputs, by name, in the order the file declares them. */
export type Outputs = Record<string, OutputType>;

/** A reported output's value, as JSON gives it. */
export type OutputValue = boolean | number | string | ReadonlyArray<boolean | number | string>;

/** What a clause compares an output with (§3). */
export type ClauseValue = string | number | boolean;

/** A step's state, as a clause reads it (§3.1). */
export type StepState = 'done' | 'skipped' | 'gave_up' | 'blocked';

/** One clause (§3): an ancestor's output and one test, or its state. */
export type Clause =
  | { step: string; output: string; equals: ClauseValue }
  | { step: string; output: string; in: ClauseValue[] }
  | { step: string; output: string; is: boolean }
  | { step: string; output: string; at_least: number }
  | { step: string; output: string; at_most: number }
  | { step: string; state: StepState };

/** An item of `when`: a clause, or the one `any` group (§3). */
export type WhenItem = Clause | { any: Clause[] };

/** `on_blocked` and `on_gave_up` (§5.1). */
export type RouteSpec = 'wait' | { route: string };

/** A late member's wake as the start resolved it (§7.3), the writer's `NewWake`; null for none. */
export interface PlanWake {
  by: string | null;
  depth: number;
  tooDeep?: true;
  role?: string;
}

/**
 * A task's fields as a DAG task has them (workflows spec §5), the params filled
 * in, `{{step.output}}` and a result fan-out's `{{item}}` left in place (§7.3).
 */
export interface Template {
  title: string;
  body: string | null;
  assignee: string | null;
  reviewer: string | null;
  workspace: string | null;
  priority: number;
  contract: Contract;
  failure_limit: number | null;
  retry_on_crash: RetryOnCrash;
  max_runtime_s: number | null;
  gates: Array<{ command: string; timeout_s: number }>;
  wake: PlanWake | null;
}

/** One step of the plan, every step of the file, in its order (§7.3). */
export interface PlanStep {
  step: string;
  /** `start` for a plain step, `decide` for a pending one, `route` for a handler (§7.1). */
  made: 'start' | 'decide' | 'route';
  parents: string[];
  /** Its declared outputs; empty for none. */
  outputs: Outputs;
  when?: WhenItem[];
  /** A result fan-out's source, or a list param's name. */
  for_each?: { step: string; output: string } | { param: string };
  on_blocked: RouteSpec;
  on_gave_up: RouteSpec;
  handler?: true;
  stands_in_for?: string;
  /** Its one task's template; for a step over a list param, `templates`, one an item. */
  template?: Template;
  templates?: Array<Template & { item: string }>;
}

/** An instance's plan, stored in `kanban_workflow_instances.plan` and never changed (§7.3). */
export interface Plan {
  format: typeof PLAN_FORMAT;
  steps: PlanStep[];
}

/** A pending row's state (§8): `skipped` is a pending row's only, never a task's phase. */
export type PendingState = 'waiting' | 'made' | 'skipped';

/** Why a step was skipped (§3.2, §4.1, §9.4, §13.1). */
export type SkippedBy = 'when' | 'source' | 'cap' | 'archive' | 'board' | 'instance';

/** How a member settled (§8). */
export type SettledHow = 'done' | 'stood_in' | 'skipped' | 'archived';

/** What a route row records (§5.3). */
export type RouteOutcome = 'made' | 'over_limit' | 'over_cap';
```

- [ ] **Step 2.4: Run them to verify they pass.** Run the same command. Expected: `Tests  4 passed (4)`.

- [ ] **Step 2.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3579 passed (3579)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 2.6: Commit.**

```bash
git add src/db/kanban-read.ts src/kanban/routing.ts tests/routing-rows.test.ts
git commit -m "Read an instance's plan and fault mark and its pending, settled and route rows, and none of them on a database not yet at 015"
```

---

### Task 3: The routing keys read

**Files:**

- Create: `tests/helpers/routing.ts`, `tests/routing-file.test.ts`
- Modify: `src/kanban/workflow.ts`

§1, §2.1, §3, §4, §5. `STEP_KEYS` gains `outputs`, `when`, `on_blocked`, `on_gave_up`, `handler` and `stands_in_for`, and `WorkflowStep` gains them, `forEach` becoming text or `{ step, output }`, told apart by their YAML type. Each key is read and its shape checked as the others are, a malformed one refused naming its place. The checks across steps are Tasks 4 and 5.

- [ ] **Step 3.1: Write the tests.**

Create `tests/helpers/routing.ts`:

```ts
import type { Role } from '../../src/roles.js';
import { role } from './dispatch.js';

/**
 * Building blocks for tests of workflow routing (workflow routing spec): the folded
 * vi assessment of its §1, as a file, and the roles it names.
 */

/** The file of workflow routing spec §1, as written there. */
export const VI_WORKFLOW = `description: CVE or supply-chain assessment, routed by its intake
board: vi
params:
  case: { required: true, description: "a CVE id, or the absolute path of a package CSV" }
steps:
  intake:
    title: "{{case}} · intake"
    assignee: vi-coordinator
    outputs:
      kind: { enum: [cve, supplychain] }
      verify: boolean
      patch: boolean
      bnpm: boolean
      packages: { list: string, max: 100 }
  va:
    title: "{{case}} · va"
    assignee: vulnerability-analyst
    parents: [intake]
    when:
      - { step: intake, output: kind, equals: cve }
    on_gave_up: { route: escalate }
    outputs:
      reachable: boolean
  escalate:
    title: "{{case}} · va, escalated"
    assignee: vi-coordinator
    handler: true
    stands_in_for: va
    outputs:
      reachable: boolean
  verify:
    title: "{{case}} · verify"
    assignee: verifier
    parents: [va]
    when:
      - { step: intake, output: verify, is: true }
      - { step: va, output: reachable, is: true }
  exposure:
    title: "{{case}} · exposure of {{item}}"
    assignee: exposure-analyst
    parents: [va]
    for_each: { step: intake, output: packages }
  registry:
    title: "{{case}} · registry"
    assignee: registry-analyst
    parents: [intake]
    when:
      - { step: intake, output: bnpm, is: true }
  report:
    title: "{{case}} · report"
    assignee: report-author
    reviewer: { role: assessment-reviewer }
    parents: [va, verify, exposure, registry]
  patch:
    title: "{{case}} · patch"
    assignee: patch-author
    parents: [report]
    when:
      - { step: intake, output: patch, is: true }
`;

/** The roles the file names, none with a workspace of its own. */
export const VI_ROLES: readonly string[] = [
  'vi-coordinator',
  'vulnerability-analyst',
  'verifier',
  'exposure-analyst',
  'registry-analyst',
  'report-author',
  'assessment-reviewer',
  'patch-author',
];

/** The roles, as a team holds them. */
export function viRoles(): Map<string, Role> {
  return new Map(VI_ROLES.map((name) => [name, role(name)]));
}
```

Create `tests/routing-file.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkWorkflow, type Workflow, type WorkflowFacts } from '../src/kanban/workflow.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { VI_WORKFLOW, viRoles } from './helpers/routing.js';

/**
 * The routing keys as a file writes them (workflow routing spec §1 to §5): each
 * read into its step, and each malformed one refused naming its place, an
 * unknown key included.
 */

const FACTS: WorkflowFacts = { roles: viRoles(), workspaces: new Set(['default', 'vi']), supervisedRoles: false };
const SECRET = 'sk-live-1234567890';

beforeEach(() => {
  clearSecrets();
  addSecrets([SECRET]);
});
afterEach(() => clearSecrets());

function read(text: string): Workflow {
  const r = checkWorkflow('vi-workflow', text, FACTS);
  if (!r.ok) throw new Error(r.problem);
  return r.workflow;
}

function problem(text: string): string | undefined {
  const r = checkWorkflow('vi-workflow', text, FACTS);
  return r.ok ? undefined : r.problem;
}

/** A file of one plain step, `intake`, and a step `next` below it whose keys are `keys`, indented as a step's. */
function withNext(keys: string, intake = 'outputs: { kind: { enum: [cve, ghsa] }, score: number, packages: { list: string, max: 5 } }'): string {
  return `steps:\n  intake:\n    title: intake\n    assignee: vi-coordinator\n    ${intake}\n  next:\n    title: next\n    assignee: verifier\n    parents: [intake]\n${keys
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')}\n`;
}

describe('the routing keys', () => {
  it('reads the folded vi file of §1: outputs, when, a result fan-out, a route and a handler standing in', () => {
    const w = read(VI_WORKFLOW);
    const step = (name: string) => w.steps.find((s) => s.name === name);
    expect(step('intake')).toMatchObject({
      outputs: { kind: { enum: ['cve', 'supplychain'] }, verify: 'boolean', patch: 'boolean', bnpm: 'boolean', packages: { list: 'string', max: 100 } },
      when: undefined,
      forEach: undefined,
      onBlocked: 'wait',
      onGaveUp: 'wait',
      handler: false,
      standsInFor: undefined,
    });
    expect(Object.keys(step('intake')?.outputs ?? {})).toEqual(['kind', 'verify', 'patch', 'bnpm', 'packages']);
    expect(step('va')).toMatchObject({ when: [{ step: 'intake', output: 'kind', equals: 'cve' }], onGaveUp: { route: 'escalate' }, outputs: { reachable: 'boolean' } });
    expect(step('escalate')).toMatchObject({ handler: true, standsInFor: 'va', parents: [], outputs: { reachable: 'boolean' } });
    expect(step('verify')?.when).toEqual([
      { step: 'intake', output: 'verify', is: true },
      { step: 'va', output: 'reachable', is: true },
    ]);
    expect(step('exposure')?.forEach).toEqual({ step: 'intake', output: 'packages' });
    expect(step('report')).toMatchObject({ outputs: {}, when: undefined, handler: false });
  });

  it('reads every test, a state and one any group', () => {
    const w = read(
      withNext(
        [
          'when:',
          '  - { step: intake, output: kind, equals: cve }',
          '  - { step: intake, output: kind, in: [cve, ghsa] }',
          '  - { step: intake, output: score, at_least: 7 }',
          '  - { step: intake, output: score, at_most: 9.5 }',
          '  - { step: intake, state: done }',
          '  - any:',
          '      - { step: intake, output: score, equals: 10 }',
          '      - { step: intake, state: skipped }',
        ].join('\n'),
      ),
    );
    expect(w.steps[1]?.when).toEqual([
      { step: 'intake', output: 'kind', equals: 'cve' },
      { step: 'intake', output: 'kind', in: ['cve', 'ghsa'] },
      { step: 'intake', output: 'score', at_least: 7 },
      { step: 'intake', output: 'score', at_most: 9.5 },
      { step: 'intake', state: 'done' },
      {
        any: [
          { step: 'intake', output: 'score', equals: 10 },
          { step: 'intake', state: 'skipped' },
        ],
      },
    ]);
  });

  it('refuses a malformed output, naming its place', () => {
    const out = (o: string) => problem(withNext('priority: 1', `outputs: { ${o} }`));
    expect(out('Kind: boolean')).toBe(
      "steps.intake.outputs: output name \"Kind\" must be lowercase letters, digits and '-', start with a letter, not end with '-', and be at most 40 characters",
    );
    expect(out('kind: text')).toBe('steps.intake.outputs.kind is boolean, number, string, { enum: [values] } or { list: <type>, max: <n> }');
    expect(out('packages: { list: string }')).toBe('steps.intake.outputs.packages: a list needs its max, from 1 to 100');
    expect(out('packages: { list: string, max: 101 }')).toBe('steps.intake.outputs.packages: a list needs its max, from 1 to 100');
    expect(out('packages: { list: { list: string, max: 2 }, max: 2 }')).toBe(
      "steps.intake.outputs.packages: a list's items are boolean, number, string or { enum: [values] }",
    );
    expect(out('kind: { enum: [] }')).toBe('steps.intake.outputs.kind: an enum has 1 to 50 values');
    expect(out('kind: { enum: [cve, cve] }')).toBe('steps.intake.outputs.kind: an enum names "cve" twice');
    expect(out('kind: { enum: [cve, 7] }')).toBe("steps.intake.outputs.kind: an enum's values are text of 1 to 256 bytes, on one line");
    expect(out(`kind: { enum: [cve, ${SECRET}] }`)).toBe('steps.intake.outputs.kind: an enum value holds a known secret, and an enum value is stored as written');
    expect(out('kind: { enum: [cve], other: 1 }')).toBe('unknown setting steps.intake.outputs.kind.other (known: enum)');
  });

  it('refuses a malformed when, naming its place', () => {
    const when = (w: string) => problem(withNext(`when:\n${w}`));
    expect(problem(withNext('when: { step: intake, state: done }'))).toBe('steps.next.when is a list of clauses, at least one');
    expect(when('  - any: [{ step: intake, state: done }]\n  - any: [{ step: intake, state: skipped }]')).toBe('steps.next.when has two any groups; it takes one');
    expect(when('  - any: []')).toBe('steps.next.when[0].any is a list of clauses, at least one');
    expect(when('  - any: [{ any: [{ step: intake, state: done }] }]')).toBe('steps.next.when[0].any[0] is a clause: an any group holds no other group');
    expect(when('  - { step: intake, output: kind, equals: cve, in: [cve] }')).toBe('steps.next.when[0] has two tests, equals and in; a clause takes one');
    expect(when('  - { step: intake, output: kind }')).toBe('steps.next.when[0] names an output and one test, or a state');
    expect(when('  - { step: intake, state: done, output: kind }')).toBe('steps.next.when[0] reads a state or an output, not both');
    expect(when('  - { step: intake, state: failed }')).toBe('steps.next.when[0].state is done, skipped, gave_up or blocked');
    expect(when('  - { step: intake, output: kind, is: yes }')).toBe('steps.next.when[0].is is true or false');
    expect(when('  - { step: intake, output: score, at_least: high }')).toBe('steps.next.when[0].at_least is a number');
    expect(when('  - { step: intake, output: kind, in: [] }')).toBe('steps.next.when[0].in is a list of text, numbers, true or false');
    expect(when('  - { step: intake, output: kind, equals: [cve] }')).toBe('steps.next.when[0].equals is text, a number, true or false');
    expect(when(`  - { step: intake, output: kind, equals: ${SECRET} }`)).toBe("steps.next.when[0].equals holds a known secret, and a clause's value is stored as written");
    expect(when('  - { step: intake, output: kind, equal: cve }')).toBe('unknown setting steps.next.when[0].equal (known: step, output, state, equals, in, is, at_least, at_most)');
    expect(when('  - cve')).toBe('steps.next.when[0] is a clause: { step, output, <test> } or { step, state }');
  });

  it('tells the two for_each forms apart by their YAML type, and refuses anything else', () => {
    expect(read(withNext('for_each: { step: intake, output: packages }')).steps[1]?.forEach).toEqual({ step: 'intake', output: 'packages' });
    const bad = "steps.next.for_each is a list param's name, or { step, output } naming an ancestor's list output";
    expect(problem(withNext('for_each: { step: intake }'))).toBe(bad);
    expect(problem(withNext('for_each: { step: intake, output: packages, max: 3 }'))).toBe(bad);
    expect(problem(withNext('for_each: [intake]'))).toBe(bad);
    // Text is a list param's name, as today: never the step.
    expect(problem(withNext('for_each: intake'))).toBe('steps.next.for_each names "intake", which is no param this file declares');
  });

  it('refuses a malformed route, handler or stands_in_for, naming its place', () => {
    expect(problem(withNext('on_gave_up: escalate'))).toBe('steps.next.on_gave_up is wait or { route: <handler step> }');
    expect(problem(withNext('on_gave_up: { rout: escalate }'))).toBe('unknown setting steps.next.on_gave_up.rout (known: route)');
    expect(problem(withNext('on_blocked: { route: 3 }'))).toBe("steps.next.on_blocked.route is a step's name");
    expect(problem(withNext('handler: yes'))).toBe('steps.next.handler is true or false');
    expect(problem(withNext('stands_in_for: [intake]'))).toBe("steps.next.stands_in_for is a step's name");
    expect(read(withNext('on_blocked: wait')).steps[1]).toMatchObject({ onBlocked: 'wait', onGaveUp: 'wait', handler: false });
  });
});
```

- [ ] **Step 3.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-file.test.ts`. Expected: `Tests  6 failed (6)`, the first as `Error: unknown setting steps.intake.outputs (known: title, body, assignee, reviewer, workspace, priority, outcome, verify, constraints, boundaries, stop_when, failure_limit, retry_on_crash, max_runtime_s, gates, parents, for_each, wake)`.

- [ ] **Step 3.3: Implement.**

In `src/kanban/workflow.ts`, replace:

```ts
import { gateProblem, gatesProblem } from './gate-command.js';
```

with:

```ts
import { gateProblem, gatesProblem } from './gate-command.js';
import type { Clause, ClauseValue, OutputType, Outputs, RouteSpec, ScalarType, StepState, WhenItem } from './routing.js';
```

In `src/kanban/workflow.ts`, replace:

```ts
  forEach: string | undefined;
```

with:

```ts
  /** A list param's name, or an ancestor's list output (workflow routing spec §4): told apart by their YAML type. */
  forEach: string | { step: string; output: string } | undefined;
  /** Its declared outputs (workflow routing spec §2), in the file's order; empty for none. */
  outputs: Outputs;
  /** Its conditions (workflow routing spec §3), or undefined for none. */
  when: WhenItem[] | undefined;
  /** `wait`, the default, or a route to a handler (workflow routing spec §5.1). */
  onBlocked: RouteSpec;
  onGaveUp: RouteSpec;
  /** Made only when routed to (workflow routing spec §5.2). */
  handler: boolean;
  /** On a handler: the step whose dependents its accepted completion settles. */
  standsInFor: string | undefined;
```

In `src/kanban/workflow.ts`, replace:

```ts
  'wake',
```

with:

```ts
  'wake',
  'outputs',
  'when',
  'on_blocked',
  'on_gave_up',
  'handler',
  'stands_in_for',
```

In `src/kanban/workflow.ts`, replace:

```ts
    forEach: optionalText(map['for_each'], `${place}.for_each`),
```

with:

```ts
    forEach: forEachOf(map['for_each'], place),
```

In `src/kanban/workflow.ts`, replace:

```ts
    wake,
```

with:

```ts
    wake,
    outputs: outputsOf(map['outputs'], place, path),
    when: whenOf(map['when'], place, path),
    onBlocked: routeOf(map['on_blocked'], `${place}.on_blocked`, path),
    onGaveUp: routeOf(map['on_gave_up'], `${place}.on_gave_up`, path),
    handler: flag(map['handler'], `${place}.handler`),
    standsInFor: map['stands_in_for'] === undefined || map['stands_in_for'] === null ? undefined : stepName(map['stands_in_for'], `${place}.stands_in_for`),
```

In `src/kanban/workflow.ts`, replace:

```ts
  };
}
```

with:

```ts
  };
}

// ---------------------------------------------------------------------------
// The routing keys (workflow routing spec §1 to §5)
// ---------------------------------------------------------------------------

/** The most values an enum takes, and the size of each (workflow routing spec §2.1). */
const ENUM_LIMITS = { values: 50, valueBytes: 256 } as const;

/** The most items a list output may be declared to hold (workflow routing spec §2.1). */
export const LIST_MAX = 100;

/** Whether a text holds a known secret: an enum's or a clause's value is stored as written (workflow routing spec §7.3). */
function secretIn(value: string): boolean {
  return redactKnownSecrets(value) !== value;
}

/** True or false, absent false. */
function flag(value: unknown, place: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') fail(`${place} is true or false`);
  return value as boolean;
}

/** A step's name as a key names one: text, checked against the steps once they are all read. */
function stepName(value: unknown, place: string): string {
  if (typeof value !== 'string' || value === '') fail(`${place} is a step's name`);
  return value as string;
}

/** `for_each`: a list param's name, as text, or `{ step, output }` (workflow routing spec §1). */
function forEachOf(value: unknown, place: string): WorkflowStep['forEach'] {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  const bad = `${place}.for_each is a list param's name, or { step, output } naming an ancestor's list output`;
  if (!isRecord(value)) fail(bad);
  const map = value as Record<string, unknown>;
  const keys = Object.keys(map).sort();
  if (keys.length !== 2 || keys[0] !== 'output' || keys[1] !== 'step' || typeof map['step'] !== 'string' || typeof map['output'] !== 'string') fail(bad);
  return { step: map['step'] as string, output: map['output'] as string };
}

/** A scalar type: a bare word, or `{ enum: [values] }` (workflow routing spec §2.1). */
function scalarOf(value: unknown, place: string, path: string): ScalarType | undefined {
  if (value === 'boolean' || value === 'number' || value === 'string') return value;
  if (!isRecord(value) || !('enum' in value)) return undefined;
  reject(path, place, value, ['enum'], HINTS);
  const values = value['enum'];
  if (!Array.isArray(values) || values.length === 0 || values.length > ENUM_LIMITS.values) fail(`${place}: an enum has 1 to ${ENUM_LIMITS.values} values`);
  for (const [n, v] of (values as unknown[]).entries()) {
    if (typeof v !== 'string' || v === '' || bytesOf(v) > ENUM_LIMITS.valueBytes || titleRefused(v)) {
      fail(`${place}: an enum's values are text of 1 to ${ENUM_LIMITS.valueBytes} bytes, on one line`);
    }
    if (secretIn(v)) fail(`${place}: an enum value holds a known secret, and an enum value is stored as written`);
    if ((values as unknown[]).indexOf(v) !== n) fail(`${place}: an enum names ${q(v)} twice`);
  }
  return { enum: [...(values as string[])] };
}

/** An output's type (workflow routing spec §2.1): a scalar, or `{ list: <scalar>, max: <n> }`. */
function outputTypeOf(value: unknown, place: string, path: string): OutputType {
  const scalar = scalarOf(value, place, path);
  if (scalar !== undefined) return scalar;
  if (isRecord(value) && 'list' in value) {
    reject(path, place, value, ['list', 'max'], HINTS);
    const item = scalarOf(value['list'], `${place}.list`, path);
    if (item === undefined) fail(`${place}: a list's items are boolean, number, string or { enum: [values] }`);
    const max = value['max'];
    if (!Number.isSafeInteger(max) || (max as number) < 1 || (max as number) > LIST_MAX) fail(`${place}: a list needs its max, from 1 to ${LIST_MAX}`);
    return { list: item as ScalarType, max: max as number };
  }
  return fail(`${place} is boolean, number, string, { enum: [values] } or { list: <type>, max: <n> }`);
}

/** A step's `outputs` (workflow routing spec §2.1): names in the param grammar, each with its type, in the file's order. */
function outputsOf(value: unknown, place: string, path: string): Outputs {
  if (value === undefined || value === null) return {};
  const map = section(path, `${place}.outputs`, value);
  const out: Outputs = {};
  for (const [name, type] of Object.entries(map)) {
    if (!NAME_PATTERN.test(name)) {
      fail(`${place}.outputs: output name ${visible(JSON.stringify(name))} must be lowercase letters, digits and '-', start with a letter, not end with '-', and be at most 40 characters`);
    }
    out[name] = outputTypeOf(type, `${place}.outputs.${name}`, path);
  }
  return out;
}

/** The tests a clause on an output takes, one of them (workflow routing spec §3). */
const TESTS = ['equals', 'in', 'is', 'at_least', 'at_most'] as const;

/** The states a clause reads (workflow routing spec §3.1). */
const STATES: readonly StepState[] = ['done', 'skipped', 'gave_up', 'blocked'];

/** A value a clause compares with: text, a number or true or false, holding no known secret. */
function clauseValue(value: unknown, place: string): ClauseValue {
  if (typeof value === 'string') {
    if (secretIn(value)) fail(`${place} holds a known secret, and a clause's value is stored as written`);
    return value;
  }
  if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') return value;
  return fail(`${place} is text, a number, true or false`);
}

/** One clause (workflow routing spec §3): `step` and either `output` with one test, or `state`. */
function clauseOf(value: unknown, place: string, path: string): Clause {
  if (!isRecord(value)) fail(`${place} is a clause: { step, output, <test> } or { step, state }`);
  const map = value as Record<string, unknown>;
  reject(path, place, map, ['step', 'output', 'state', ...TESTS], HINTS);
  const step = stepName(map['step'], `${place}.step`);
  const tests = TESTS.filter((t) => map[t] !== undefined);
  if (map['state'] !== undefined) {
    if (map['output'] !== undefined || tests.length > 0) fail(`${place} reads a state or an output, not both`);
    const state = map['state'];
    if (!STATES.includes(state as StepState)) fail(`${place}.state is ${STATES.slice(0, -1).join(', ')} or ${STATES.at(-1) ?? ''}`);
    return { step, state: state as StepState };
  }
  if (typeof map['output'] !== 'string' || map['output'] === '') fail(`${place} names an output and one test, or a state`);
  const output = map['output'] as string;
  if (tests.length === 0) fail(`${place} names an output and one test, or a state`);
  if (tests.length > 1) fail(`${place} has two tests, ${tests[0] ?? ''} and ${tests[1] ?? ''}; a clause takes one`);
  const test = tests[0] as (typeof TESTS)[number];
  const raw = map[test];
  const at = `${place}.${test}`;
  switch (test) {
    case 'equals':
      return { step, output, equals: clauseValue(raw, at) };
    case 'in':
      if (!Array.isArray(raw) || raw.length === 0) fail(`${at} is a list of text, numbers, true or false`);
      return { step, output, in: (raw as unknown[]).map((v, i) => clauseValue(v, `${at}[${i}]`)) };
    case 'is':
      if (typeof raw !== 'boolean') fail(`${at} is true or false`);
      return { step, output, is: raw as boolean };
    case 'at_least':
    case 'at_most':
      if (typeof raw !== 'number' || !Number.isFinite(raw)) fail(`${at} is a number`);
      return test === 'at_least' ? { step, output, at_least: raw as number } : { step, output, at_most: raw as number };
  }
}

/** A step's `when` (workflow routing spec §3): clauses, every one of which must hold, and at most one `any` group. */
function whenOf(value: unknown, place: string, path: string): WhenItem[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) fail(`${place}.when is a list of clauses, at least one`);
  let anys = 0;
  return (value as unknown[]).map((item, i): WhenItem => {
    const at = `${place}.when[${i}]`;
    if (isRecord(item) && 'any' in item) {
      anys += 1;
      if (anys > 1) fail(`${place}.when has two any groups; it takes one`);
      reject(path, at, item, ['any'], HINTS);
      const group = item['any'];
      if (!Array.isArray(group) || group.length === 0) fail(`${at}.any is a list of clauses, at least one`);
      return {
        any: (group as unknown[]).map((c, n) => {
          if (isRecord(c) && 'any' in c) fail(`${at}.any[${n}] is a clause: an any group holds no other group`);
          return clauseOf(c, `${at}.any[${n}]`, path);
        }),
      };
    }
    return clauseOf(item, at, path);
  });
}

/** `on_blocked` and `on_gave_up` (workflow routing spec §5.1): `wait`, the default, or `{ route: <handler step> }`. */
function routeOf(value: unknown, place: string, path: string): RouteSpec {
  if (value === undefined || value === null || value === 'wait') return 'wait';
  if (!isRecord(value)) fail(`${place} is wait or { route: <handler step> }`);
  reject(path, place, value as Record<string, unknown>, ['route'], HINTS);
  return { route: stepName((value as Record<string, unknown>)['route'], `${place}.route`) };
}
```

In `src/kanban/workflow.ts`, replace:

```ts
  return { role: role as string };
```

with:

```ts
  return { role: role as string };
}

/** The list param a step fans out over, or undefined for none and for a result's fan-out (workflow routing spec §1). */
export function paramFanOut(step: Pick<WorkflowStep, 'forEach'>): string | undefined {
  return typeof step.forEach === 'string' ? step.forEach : undefined;
```

In `src/kanban/workflow.ts`, replace:

```ts
    if (s.forEach !== undefined) {
      const param = params.get(s.forEach);
      if (param === undefined) fail(`${place}.for_each names ${q(s.forEach)}, which is no param this file declares`);
      if (!param.list) fail(`${place}.for_each names ${s.forEach}, a text param: for_each takes a list param`);
```

with:

```ts
    const over = paramFanOut(s);
    if (over !== undefined) {
      const param = params.get(over);
      if (param === undefined) fail(`${place}.for_each names ${q(over)}, which is no param this file declares`);
      if (!param.list) fail(`${place}.for_each names ${over}, a text param: for_each takes a list param`);
```

In `src/kanban/workflow.ts`, replace:

```ts
      if (ref === ITEM && s.forEach !== undefined) out.add(s.forEach);
```

with:

```ts
      if (ref === ITEM && paramFanOut(s) !== undefined) out.add(paramFanOut(s) ?? '');
```

In `src/kanban/workflow.ts`, replace:

```ts
      if (name === ITEM && s.forEach !== undefined) out.add(s.forEach);
```

with:

```ts
      if (name === ITEM && paramFanOut(s) !== undefined) out.add(paramFanOut(s) ?? '');
```

In `src/kanban/workflow.ts`, replace:

```ts
    const items: Array<string | null> = s.forEach === undefined ? [null] : [...((values.get(s.forEach) as string[] | undefined) ?? [])];
```

with:

```ts
    const over = paramFanOut(s);
    const items: Array<string | null> = over === undefined ? [null] : [...((values.get(over) as string[] | undefined) ?? [])];
```

In `src/kanban/workflow.ts`, replace:

```ts
        const bad = nameGiven(value, place, spec, kind, ref === ITEM ? (s.forEach ?? ITEM) : ref);
```

with:

```ts
        const bad = nameGiven(value, place, spec, kind, ref === ITEM ? (over ?? ITEM) : ref);
```

In `src/kanban/workflow.ts`, replace:

```ts
      const ref = s.forEach === undefined ? s.name : `${s.name}:${n + 1}`;
```

with:

```ts
      const ref = over === undefined ? s.name : `${s.name}:${n + 1}`;
```

In `src/kanban/workflow.ts`, replace:

```ts
      const total = w.steps.reduce((sum, x) => sum + (x.forEach === undefined ? 1 : ((values.get(x.forEach) as string[] | undefined)?.length ?? 0)), 0);
```

with:

```ts
      const total = w.steps.reduce((sum, x) => sum + (paramFanOut(x) === undefined ? 1 : ((values.get(paramFanOut(x) ?? '') as string[] | undefined)?.length ?? 0)), 0);
```

- [ ] **Step 3.4: Run them to verify they pass.** Run the same command. Expected: `Tests  6 passed (6)`.

- [ ] **Step 3.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3585 passed (3585)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 3.6: Commit.**

```bash
git add src/kanban/workflow.ts tests/helpers/routing.ts tests/routing-file.test.ts
git commit -m "Read the routing keys of a workflow file: outputs, when, a result's for_each, the routes, a handler and the step it stands in for"
```

---

### Task 4: The checks of conditions, fan-outs and references

**Files:**

- Create: `tests/routing-check.test.ts`
- Modify: `src/kanban/routing.ts`, `src/kanban/workflow.ts`

§6, §2.1, §7.1. `checkWhole` gains a scope of the file's steps, their ancestors and which are pending, and checks each clause, each result `for_each` and each `{{step.output}}` against the ancestors and their declared outputs, message for message; refuses a reference to a result in a plain step, a contract field and a name field; refuses outputs on a step whose assignee is written as a person; and checks an outcome with its outputs sentence against 8 KiB. `pendingSteps` gives §7.1's pending steps, and `outputsSentence` §2.1's sentence.

- [ ] **Step 4.1: Write the tests.**

Create `tests/routing-check.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { checkWorkflow, pendingSteps, type WorkflowFacts } from '../src/kanban/workflow.js';
import { outcomeWithOutputs, outputsSentence } from '../src/kanban/routing.js';
import { VI_WORKFLOW, viRoles } from './helpers/routing.js';

/**
 * The checks of a file's conditions, fan-outs and references to results
 * (workflow routing spec §6), message for message; which steps are pending
 * (§7.1); and the outputs sentence (§2.1).
 */

const FACTS: WorkflowFacts = { roles: viRoles(), workspaces: new Set(['default', 'vi']), supervisedRoles: false };

function problem(text: string): string | undefined {
  const r = checkWorkflow('vi-workflow', text, FACTS);
  return r.ok ? undefined : r.problem;
}

/** The vi file with one text replaced, which must be in it once. */
function viWith(from: string, to: string): string {
  if (VI_WORKFLOW.split(from).length !== 2) throw new Error(`not once in the file: ${from}`);
  return VI_WORKFLOW.replace(from, to);
}

describe('the checks of conditions and fan-outs', () => {
  it('passes the folded vi file of §1', () => {
    expect(problem(VI_WORKFLOW)).toBeUndefined();
  });

  it('refuses a clause, a for_each or a reference naming an undeclared output', () => {
    expect(problem(viWith('{ step: va, output: reachable, is: true }', '{ step: va, output: score, at_least: 7 }'))).toBe(
      'steps.verify.when[1] names va.score, which va does not declare (it declares reachable)',
    );
    expect(problem(viWith('for_each: { step: intake, output: packages }', 'for_each: { step: intake, output: pkgs }'))).toBe(
      'steps.exposure.for_each names intake.pkgs, which intake does not declare (it declares kind, verify, patch, bnpm, packages)',
    );
    expect(problem(viWith('title: "{{case}} · verify"', 'title: "{{case}} · verify, {{va.score}}"'))).toBe(
      'steps.verify.title names va.score, which va does not declare (it declares reachable)',
    );
    expect(problem(viWith('{ step: intake, output: bnpm, is: true }', '{ step: report, output: x, is: true }'))).toBe(
      'steps.registry.when[0] names report, which is not an ancestor of registry: a condition reads only steps its parents come after',
    );
  });

  it('refuses one naming a step that is not an ancestor, or no step', () => {
    expect(problem(viWith('{ step: va, output: reachable, is: true }', '{ step: registry, output: x, is: true }'))).toBe(
      'steps.verify.when[1] names registry, which is not an ancestor of verify: a condition reads only steps its parents come after',
    );
    expect(problem(viWith('{ step: va, output: reachable, is: true }', '{ step: nope, state: done }'))).toBe('steps.verify.when[1] names "nope", which is no step of this file');
    expect(problem(viWith('for_each: { step: intake, output: packages }', 'for_each: { step: registry, output: packages }'))).toBe(
      'steps.exposure.for_each names registry, which is not an ancestor of exposure: a fan-out reads only steps its parents come after',
    );
    expect(problem(viWith('title: "{{case}} · registry"', 'title: "{{case}} · registry, {{va.reachable}}"'))).toBe(
      'steps.registry.title names va, which is not an ancestor of registry: a reference reads only steps its parents come after',
    );
  });

  it('refuses a clause whose test does not fit the output, and a fan-out over no list', () => {
    expect(problem(viWith('{ step: va, output: reachable, is: true }', '{ step: va, output: reachable, at_least: 7 }'))).toBe(
      'steps.verify.when[1]: at_least compares a number, and va.reachable is a boolean',
    );
    expect(problem(viWith('{ step: intake, output: kind, equals: cve }', '{ step: intake, output: kind, equals: library }'))).toBe(
      "steps.va.when[0]: equals library is not one of intake.kind's values (cve, supplychain)",
    );
    expect(problem(viWith('{ step: intake, output: kind, equals: cve }', '{ step: intake, output: kind, in: [cve, ghsa] }'))).toBe(
      "steps.va.when[0]: in ghsa is not one of intake.kind's values (cve, supplychain)",
    );
    expect(problem(viWith('{ step: intake, output: kind, equals: cve }', '{ step: intake, output: kind, equals: 3 }'))).toBe(
      'steps.va.when[0]: equals compares a number, and intake.kind is an enum',
    );
    expect(problem(viWith('{ step: intake, output: kind, equals: cve }', '{ step: intake, output: verify, equals: yes }'))).toBe(
      'steps.va.when[0]: equals compares text, and intake.verify is a boolean',
    );
    expect(problem(viWith('{ step: intake, output: kind, equals: cve }', '{ step: intake, output: kind, is: true }'))).toBe(
      'steps.va.when[0]: is compares true or false, and intake.kind is an enum',
    );
    expect(problem(viWith('{ step: intake, output: kind, equals: cve }', '{ step: intake, output: packages, equals: lodash }'))).toBe(
      'steps.va.when[0] names intake.packages, a list: a list is read by a fan-out only',
    );
    expect(problem(viWith('for_each: { step: intake, output: packages }', 'for_each: { step: intake, output: kind }'))).toBe(
      'steps.exposure.for_each names intake.kind, which is no list',
    );
  });

  it('refuses a clause on a fan-out step, and a fan-out over a fan-out', () => {
    expect(problem(viWith('    parents: [va, verify, exposure, registry]\n', '    parents: [va, verify, exposure, registry]\n    when:\n      - { step: exposure, state: done }\n'))).toBe(
      'steps.report.when[0] names exposure, a fan-out step, whose items each have their own result',
    );
    const audit = `${VI_WORKFLOW}  audit:\n    title: audit {{item}}\n    assignee: verifier\n    parents: [exposure]\n    for_each: { step: exposure, output: reachable }\n`;
    expect(problem(audit)).toBe("steps.audit.for_each names exposure, itself a fan-out: a fan-out over another fan-out's items is not supported");
  });

  it('allows {{step.output}} in a pending step\'s title and body, and refuses it in a plain step, a contract field, a name field and a gate', () => {
    expect(problem(viWith('title: "{{case}} · verify"', 'title: "{{case}} · verify, {{intake.kind}}"\n    body: "reachable: {{va.reachable}}"'))).toBeUndefined();
    expect(problem(viWith('title: "{{case}} · va"', 'title: "{{case}} · va, {{intake.kind}}"'))).toBeUndefined();
    const plain = 'steps:\n  intake:\n    title: intake\n    assignee: vi-coordinator\n    outputs: { kind: string }\n  va:\n    title: "va {{intake.kind}}"\n    assignee: vulnerability-analyst\n    parents: [intake]\n';
    expect(problem(plain)).toBe('steps.va.title names {{intake.kind}}, and va is made at the start, before any result');
    expect(problem(viWith('title: "{{case}} · verify"', 'title: "{{case}} · verify"\n    outcome: "says {{intake.kind}}"'))).toBe(
      'steps.verify.outcome names {{intake.kind}}: a result fills only a title and a body',
    );
    expect(problem(viWith('    assignee: verifier\n', '    assignee: "{{intake.kind}}"\n'))).toBe('steps.verify.assignee names {{intake.kind}}: a result fills only a title and a body');
    expect(problem(viWith('    assignee: verifier\n', '    assignee: verifier\n    gates:\n      - command: "test {{intake.kind}}"\n'))).toBe(
      'steps.verify.gates[0].command holds {{, and a gate is a shell command: name the value as an environment variable instead',
    );
  });

  it("refuses outputs on a step whose assignee is written as a person", () => {
    const person = (who: string) =>
      problem(`steps:\n  intake:\n    title: intake\n    assignee: ${who}\n    outputs: { kind: string }\n`);
    const said = "steps.intake declares outputs, which a role's run reports in its metadata, and its assignee is a person: a person's done gives none";
    expect(person('"lark:on_alice"')).toBe(said);
    expect(person('{ person: "lark:on_alice" }')).toBe(said);
    expect(person('vi-coordinator')).toBeUndefined();
  });

  it('refuses an outcome past 8 KiB once its outputs sentence is added', () => {
    const long = 'x'.repeat(8_150);
    expect(problem(`steps:\n  intake:\n    title: intake\n    assignee: vi-coordinator\n    outcome: ${long}\n    outputs: { verify: boolean }\n`)).toBe(
      `steps.intake.outcome with its outputs sentence is ${8_150 + 2 + outputsSentence({ verify: 'boolean' }).length} bytes; at most 8192`,
    );
    expect(problem(`steps:\n  intake:\n    title: intake\n    assignee: vi-coordinator\n    outcome: ${long}\n`)).toBeUndefined();
  });
});

describe('which steps are pending (§7.1)', () => {
  it('makes pending a step with when, a result fan-out or handler, every step below one, and a child of a step a handler stands in for', () => {
    const r = checkWorkflow('vi-workflow', VI_WORKFLOW, FACTS);
    if (!r.ok) throw new Error(r.problem);
    expect([...pendingSteps(r.workflow.steps)].sort()).toEqual(['escalate', 'exposure', 'patch', 'registry', 'report', 'va', 'verify']);
    const stood = checkWorkflow(
      'x',
      'steps:\n  a:\n    title: a\n    assignee: verifier\n    on_gave_up: { route: h }\n  b:\n    title: b\n    assignee: verifier\n    parents: [a]\n  h:\n    title: h\n    assignee: verifier\n    handler: true\n    stands_in_for: a\n',
      FACTS,
    );
    if (!stood.ok) throw new Error(stood.problem);
    expect([...pendingSteps(stood.workflow.steps)].sort()).toEqual(['b', 'h']);
  });
});

describe('the outputs sentence (§2.1)', () => {
  it('names each output and its type', () => {
    expect(outputsSentence({ reachable: 'boolean', packages: { list: 'string', max: 50 } })).toBe(
      'Report in the metadata of your completion: reachable (true or false); packages (a list of at most 50 texts).',
    );
    expect(outputsSentence({ kind: { enum: ['cve', 'supplychain'] }, score: 'number', note: 'string', flags: { list: 'boolean', max: 3 }, kinds: { list: { enum: ['a', 'b'] }, max: 2 } })).toBe(
      'Report in the metadata of your completion: kind (one of cve, supplychain); score (a number); note (text); flags (a list of at most 3 true or false values); kinds (a list of at most 2 values of a, b).',
    );
    expect(outcomeWithOutputs('the verdict', { reachable: 'boolean' })).toBe('the verdict\n\nReport in the metadata of your completion: reachable (true or false).');
    expect(outcomeWithOutputs(undefined, { reachable: 'boolean' })).toBe('Report in the metadata of your completion: reachable (true or false).');
    expect(outcomeWithOutputs('the verdict', {})).toBe('the verdict');
  });
});
```

- [ ] **Step 4.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-check.test.ts`. Expected: `Tests  9 failed | 1 passed (10)`, the first as `AssertionError: expected undefined to be 'steps.verify.when[1] names va.score, …' // Object.is equality`.

- [ ] **Step 4.3: Implement.**

In `src/kanban/routing.ts`, replace:

```ts
export type RouteOutcome = 'made' | 'over_limit' | 'over_cap';
```

with:

```ts
export type RouteOutcome = 'made' | 'over_limit' | 'over_cap';

// ---------------------------------------------------------------------------
// The outputs sentence (§2.1)
// ---------------------------------------------------------------------------

/** A scalar type as the outputs sentence says it. */
function scalarWords(t: ScalarType): string {
  if (t === 'boolean') return 'true or false';
  if (t === 'number') return 'a number';
  if (t === 'string') return 'text';
  return `one of ${t.enum.join(', ')}`;
}

/** A list's items as the outputs sentence says them. */
function itemsWords(t: ScalarType): string {
  if (t === 'boolean') return 'true or false values';
  if (t === 'number') return 'numbers';
  if (t === 'string') return 'texts';
  return `values of ${t.enum.join(', ')}`;
}

/** An output's type as the outputs sentence says it: `true or false`, `a list of at most 50 texts`. */
export function typeWords(t: OutputType): string {
  if (typeof t === 'object' && 'list' in t) return `a list of at most ${t.max} ${itemsWords(t.list)}`;
  return scalarWords(t);
}

/**
 * The one sentence the expansion adds to a step's `outcome` when it declares
 * outputs (§2.1), so its agent knows what to report: `Report in the metadata of
 * your completion: reachable (true or false); packages (a list of at most 50 texts).`
 */
export function outputsSentence(outputs: Outputs): string {
  return `Report in the metadata of your completion: ${Object.entries(outputs)
    .map(([name, t]) => `${name} (${typeWords(t)})`)
    .join('; ')}.`;
}

/** A step's `outcome` with its outputs sentence after it, a blank line between; the outcome alone for a step with none. */
export function outcomeWithOutputs(outcome: string | undefined, outputs: Outputs): string {
  if (Object.keys(outputs).length === 0) return outcome ?? '';
  const sentence = outputsSentence(outputs);
  return outcome === undefined || outcome === '' ? sentence : `${outcome}\n\n${sentence}`;
}
```

In `src/kanban/workflow.ts`, replace:

```ts
import { DAG_FORMAT, DAG_LIMITS, titleRefused, type Dag, type DagTask, type ParamValue } from './dag.js';
```

with:

```ts
import { DAG_FORMAT, DAG_LIMITS, titleRefused, type Dag, type DagTask, type ParamValue } from './dag.js';
import { WORKER_LIMITS } from './limits.js';
```

In `src/kanban/workflow.ts`, replace:

```ts
import type { Clause, ClauseValue, OutputType, Outputs, RouteSpec, ScalarType, StepState, WhenItem } from './routing.js';
```

with:

```ts
import { outcomeWithOutputs, type Clause, type ClauseValue, type OutputType, type Outputs, type RouteSpec, type ScalarType, type StepState, type WhenItem } from './routing.js';
```

In `src/kanban/workflow.ts`, replace:

```ts

/** A file's problem, thrown inside the check and caught as its result. */
```

with:

```ts

/** A reference to a result (workflow routing spec §1): `{{<step>.<output>}}`, both in the name grammar, with no spaces. */
const RESULT_REFERENCE = /^\{\{([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)\.([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)\}\}/;

/** Every result reference in a text, `{{<step>.<output>}}`, in order. */
export const RESULT_REFERENCES = /\{\{([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)\.([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)\}\}/g;

/** A file's problem, thrown inside the check and caught as its result. */
```

In `src/kanban/workflow.ts`, replace:

```ts
/** Each `{{` in a text field opens a reference to a declared param, or to `item` in a for_each step (workflows spec §2). */
function references(value: string, place: string, params: ReadonlyMap<string, WorkflowParam>, forEach: boolean): void {
```

with:

```ts
/**
 * Each `{{` in a text field opens a reference to a declared param, to `item` in
 * a for_each step (workflows spec §2), or to a result, `{{<step>.<output>}}`,
 * which `result` judges (workflow routing spec §1).
 */
function references(
  value: string,
  place: string,
  params: ReadonlyMap<string, WorkflowParam>,
  forEach: boolean,
  result: (step: string, output: string) => void,
): void {
```

In `src/kanban/workflow.ts`, replace:

```ts
  for (let at = value.indexOf('{{'); at !== -1; at = value.indexOf('{{', at + 2)) {
```

with:

```ts
  for (let at = value.indexOf('{{'); at !== -1; at = value.indexOf('{{', at + 2)) {
    const r = RESULT_REFERENCE.exec(value.slice(at));
    if (r !== null) {
      result(r[1] ?? '', r[2] ?? '');
      continue;
    }
```

In `src/kanban/workflow.ts`, replace:

```ts
  if (!value.includes('{{')) return undefined;
```

with:

```ts
  if (!value.includes('{{')) return undefined;
  const r = RESULT_REFERENCE.exec(value);
  if (r !== null) fail(`${place} names ${r[0]}: a result fills only a title and a body`);
```

In `src/kanban/workflow.ts`, replace:

```ts
  if (cycle !== undefined) fail(`the steps' parents make a cycle: ${cycle}`);
```

with:

```ts
  if (cycle !== undefined) fail(`the steps' parents make a cycle: ${cycle}`);
  const scope = routingScope(steps);
```

In `src/kanban/workflow.ts`, replace:

```ts
    references(s.title, `${place}.title`, params, forEach);
    if (s.body !== undefined) references(s.body, `${place}.body`, params, forEach);
```

with:

```ts
    references(s.title, `${place}.title`, params, forEach, (step, output) => scope.result(s, step, output, `${place}.title`));
    if (s.body !== undefined) references(s.body, `${place}.body`, params, forEach, (step, output) => scope.result(s, step, output, `${place}.body`));
```

In `src/kanban/workflow.ts`, replace:

```ts
      if (v !== undefined) references(v, `${place}.${key}`, params, forEach);
```

with:

```ts
      const at = `${place}.${key}`;
      // Values from results fill titles and bodies only (workflow routing spec §14).
      if (v !== undefined) references(v, at, params, forEach, (step, output) => fail(`${at} names {{${step}.${output}}}: a result fills only a title and a body`));
```

In `src/kanban/workflow.ts`, replace:

```ts
      }
    }
  }
```

with:

```ts
      }
    }
    checkRouting(s, scope);
  }
}

// ---------------------------------------------------------------------------
// The routing checks (workflow routing spec §6)
// ---------------------------------------------------------------------------

/** What the routing checks read of the file's steps: each by name, its ancestors, and which are pending (§7.1). */
interface RoutingScope {
  byName: ReadonlyMap<string, WorkflowStep>;
  ancestors(name: string): ReadonlySet<string>;
  pending: ReadonlySet<string>;
  /** A `{{<step>.<output>}}` in step `s`'s title or body, at `place`, judged (§1, §6). */
  result(s: WorkflowStep, step: string, output: string, place: string): void;
}

/**
 * The steps that are pending (workflow routing spec §7.1): a step with `when`, a
 * result `for_each`, or `handler: true`; a step any of whose parents is pending;
 * and a child of a step a handler may stand in for. The others are plain.
 */
export function pendingSteps(steps: readonly Pick<WorkflowStep, 'name' | 'parents' | 'when' | 'forEach' | 'handler' | 'standsInFor'>[]): Set<string> {
  const stoodIn = new Set(steps.flatMap((s) => (s.handler && s.standsInFor !== undefined ? [s.standsInFor] : [])));
  const pending = new Set<string>();
  const byName = new Map(steps.map((s) => [s.name, s]));
  const memo = new Map<string, boolean>();
  const isPending = (name: string): boolean => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    const s = byName.get(name);
    memo.set(name, false);
    const out =
      s !== undefined &&
      (s.when !== undefined || (s.forEach !== undefined && typeof s.forEach !== 'string') || s.handler || s.parents.some((p) => isPending(p) || stoodIn.has(p)));
    memo.set(name, out);
    return out;
  };
  for (const s of steps) if (isPending(s.name)) pending.add(s.name);
  return pending;
}

/** A step's ancestors, transitively through its parents, memoized; the cycle check has run, so the walk ends. */
function ancestorsOf(byName: ReadonlyMap<string, WorkflowStep>): (name: string) => ReadonlySet<string> {
  const memo = new Map<string, Set<string>>();
  const walk = (name: string): Set<string> => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    const out = new Set<string>();
    memo.set(name, out);
    for (const p of byName.get(name)?.parents ?? []) {
      out.add(p);
      for (const a of walk(p)) out.add(a);
    }
    return out;
  };
  return walk;
}

/** A type as a check names it: `a boolean`, `a number`, `text`, `an enum`, `a list`. */
function typeWord(t: OutputType): string {
  if (t === 'boolean') return 'a boolean';
  if (t === 'number') return 'a number';
  if (t === 'string') return 'text';
  return 'enum' in t ? 'an enum' : 'a list';
}

/** A clause's value as a check names what it compares. */
function valueWord(v: ClauseValue): string {
  return typeof v === 'string' ? 'text' : typeof v === 'number' ? 'a number' : 'true or false';
}

/** A step's outputs as a check lists them: `reachable, score`, or `none`. */
function declared(outputs: Outputs): string {
  const names = Object.keys(outputs);
  return names.length === 0 ? 'none' : names.join(', ');
}

/** Whether a step is a fan-out, of either form. */
function isFanOut(s: WorkflowStep): boolean {
  return s.forEach !== undefined;
}

function routingScope(steps: readonly WorkflowStep[]): RoutingScope {
  const byName = new Map(steps.map((s) => [s.name, s]));
  const ancestors = ancestorsOf(byName);
  const pending = pendingSteps(steps);
  const scope: RoutingScope = {
    byName,
    ancestors,
    pending,
    result(s, step, output, place) {
      const ref = `{{${step}.${output}}}`;
      if (!pending.has(s.name)) fail(`${place} names ${ref}, and ${s.name} is made at the start, before any result`);
      readable(scope, s, step, place, 'a reference reads only steps its parents come after');
      const target = byName.get(step) as WorkflowStep;
      if (isFanOut(target)) fail(`${place} names ${step}, a fan-out step, whose items each have their own result`);
      if (target.outputs[output] === undefined) fail(`${place} names ${step}.${output}, which ${step} does not declare (it declares ${declared(target.outputs)})`);
    },
  };
  return scope;
}

/** A step a clause, a fan-out or a reference of `s` reads, at `place`: one of the file's, and an ancestor of `s`. */
function readable(scope: RoutingScope, s: WorkflowStep, step: string, place: string, why: string): void {
  if (!scope.byName.has(step)) fail(`${place} names ${q(step)}, which is no step of this file`);
  if (!scope.ancestors(s.name).has(step)) fail(`${place} names ${step}, which is not an ancestor of ${s.name}: ${why}`);
}

/** A clause's test against the output's declared type (§6), or why it cannot compare. */
function testProblem(c: Clause, type: OutputType, ref: string, at: string): string | undefined {
  if (typeof type === 'object' && 'list' in type) return `${at} names ${ref}, a list: a list is read by a fan-out only`;
  if ('is' in c) return type === 'boolean' ? undefined : `${at}: is compares true or false, and ${ref} is ${typeWord(type)}`;
  if ('at_least' in c || 'at_most' in c) {
    return type === 'number' ? undefined : `${at}: ${'at_least' in c ? 'at_least' : 'at_most'} compares a number, and ${ref} is ${typeWord(type)}`;
  }
  const test = 'equals' in c ? 'equals' : 'in';
  const values: ClauseValue[] = 'equals' in c ? [c.equals] : 'in' in c ? c.in : [];
  for (const v of values) {
    if (typeof type === 'object' && 'enum' in type) {
      if (typeof v !== 'string') return `${at}: ${test} compares ${valueWord(v)}, and ${ref} is an enum`;
      if (!type.enum.includes(v)) return `${at}: ${test} ${v} is not one of ${ref}'s values (${type.enum.join(', ')})`;
      continue;
    }
    const fits = (type === 'string' && typeof v === 'string') || (type === 'number' && typeof v === 'number') || (type === 'boolean' && typeof v === 'boolean');
    if (!fits) return `${at}: ${test} compares ${valueWord(v)}, and ${ref} is ${typeWord(type)}`;
  }
  return undefined;
}

/** One clause of `s`'s `when`, at `at` (§6). */
function checkClause(scope: RoutingScope, s: WorkflowStep, c: Clause, at: string): void {
  readable(scope, s, c.step, at, 'a condition reads only steps its parents come after');
  const target = scope.byName.get(c.step) as WorkflowStep;
  if (isFanOut(target)) fail(`${at} names ${c.step}, a fan-out step, whose items each have their own result`);
  if ('state' in c) return;
  const type = target.outputs[c.output];
  if (type === undefined) fail(`${at} names ${c.step}.${c.output}, which ${c.step} does not declare (it declares ${declared(target.outputs)})`);
  const problem = testProblem(c, type as OutputType, `${c.step}.${c.output}`, at);
  if (problem !== undefined) fail(problem);
}

/** Whether a name field is written as a person: `lark:…`, or `{ person: … }`. */
function writtenAsPerson(spec: NameSpec | undefined): boolean {
  return spec !== undefined && (spec.must === 'person' || (!spec.value.includes('{{') && spec.value.includes(':')));
}

/** A step's routing checks (workflow routing spec §2.1, §3, §4, §6), after its own. */
function checkRouting(s: WorkflowStep, scope: RoutingScope): void {
  const place = `steps.${s.name}`;
  if (Object.keys(s.outputs).length > 0 && writtenAsPerson(s.assignee)) {
    fail(`${place} declares outputs, which a role's run reports in its metadata, and its assignee is a person: a person's done gives none`);
  }
  for (const [i, item] of (s.when ?? []).entries()) {
    if ('any' in item) for (const [n, c] of item.any.entries()) checkClause(scope, s, c, `${place}.when[${i}].any[${n}]`);
    else checkClause(scope, s, item, `${place}.when[${i}]`);
  }
  if (typeof s.forEach === 'object') {
    const { step, output } = s.forEach;
    const at = `${place}.for_each`;
    readable(scope, s, step, at, 'a fan-out reads only steps its parents come after');
    const source = scope.byName.get(step) as WorkflowStep;
    if (isFanOut(source)) fail(`${at} names ${step}, itself a fan-out: a fan-out over another fan-out's items is not supported`);
    const type = source.outputs[output];
    if (type === undefined) fail(`${at} names ${step}.${output}, which ${step} does not declare (it declares ${declared(source.outputs)})`);
    if (typeof type !== 'object' || !('list' in type)) fail(`${at} names ${step}.${output}, which is no list`);
  }
  if (Object.keys(s.outputs).length > 0) {
    const outcome = outcomeWithOutputs(s.contract.outcome, s.outputs);
    const size = bytesOf(outcome);
    if (size > WORKER_LIMITS.contractField) fail(`${place}.outcome with its outputs sentence is ${size} bytes; at most ${WORKER_LIMITS.contractField}`);
  }
```

- [ ] **Step 4.4: Run them to verify they pass.** Run the same command. Expected: `Tests  10 passed (10)`.

- [ ] **Step 4.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3595 passed (3595)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 4.6: Commit.**

```bash
git add src/kanban/routing.ts src/kanban/workflow.ts tests/routing-check.test.ts
git commit -m "Check a file's conditions, result fan-outs and references to results against the ancestors and their declared outputs"
```

---

### Task 5: The checks of routes and handlers

**Files:**

- Create: `tests/routing-check-handlers.test.ts`
- Modify: `src/kanban/routing.ts`, `src/kanban/workflow.ts`

§5, §6. A handler takes no parents, `when` or `for_each`, routes nowhere, is routed to by some step, and is named in no `parents`, `when`, `for_each` or reference; a route goes to a handler; `stands_in_for` names a step that routes to it, with the same outputs, and a stand-in names no reviewer, keeps its step's gates and its own within a task's bounds, its merged contract within 8 KiB, and its workspace not certainly another; `{{item}}` in a handler only when every step routing to it is a fan-out; and a handler's references read its routed steps' ancestors. `standInContract` merges a contract per field (§5.2).

- [ ] **Step 5.1: Write the tests.**

Create `tests/routing-check-handlers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { checkWorkflow, type WorkflowFacts } from '../src/kanban/workflow.js';
import { standInContract } from '../src/kanban/routing.js';
import { role } from './helpers/dispatch.js';
import { VI_WORKFLOW, viRoles } from './helpers/routing.js';

/**
 * The checks of routes and handlers (workflow routing spec §5, §6), message for
 * message: a handler made only when routed to, never a step's parent or
 * ancestor, never chaining; a route to a handler; and a stand-in that takes its
 * step's outputs, reviewer, gates, contract and checkout.
 */

const ROLES = viRoles();
ROLES.set('vi-ops', role('vi-ops', { workspace: 'ops' }));
ROLES.set('vi-analyst', role('vi-analyst', { workspace: 'vi' }));
const FACTS: WorkflowFacts = { roles: ROLES, workspaces: new Set(['default', 'vi', 'ops']), supervisedRoles: false };

function problem(text: string): string | undefined {
  const r = checkWorkflow('vi-workflow', text, FACTS);
  return r.ok ? undefined : r.problem;
}

function viWith(from: string, to: string): string {
  if (VI_WORKFLOW.split(from).length !== 2) throw new Error(`not once in the file: ${from}`);
  return VI_WORKFLOW.replace(from, to);
}

const ESCALATE = '  escalate:\n    title: "{{case}} · va, escalated"\n    assignee: vi-coordinator\n    handler: true\n    stands_in_for: va\n';

describe('the checks of routes and handlers', () => {
  it('refuses a handler named in parents, in a when, as a for_each source or in a reference', () => {
    expect(problem(viWith('parents: [va, verify, exposure, registry]', 'parents: [va, verify, exposure, registry, escalate]'))).toBe(
      "steps.report.parents names escalate, a handler, which is made only when routed to and is no step's parent",
    );
    expect(problem(viWith('{ step: intake, output: patch, is: true }', '{ step: escalate, output: reachable, is: true }'))).toBe(
      "steps.patch.when[0] names escalate, a handler, which is made only when routed to and is no step's ancestor",
    );
    expect(problem(viWith('for_each: { step: intake, output: packages }', 'for_each: { step: escalate, output: reachable }'))).toBe(
      "steps.exposure.for_each names escalate, a handler, which is made only when routed to and is no step's ancestor",
    );
    expect(problem(viWith('title: "{{case}} · patch"', 'title: "{{case}} · patch {{escalate.reachable}}"'))).toBe(
      "steps.patch.title names escalate, a handler, which is made only when routed to and is no step's ancestor",
    );
  });

  it('refuses a handler routed from nowhere, one with parents, when or for_each, and a route from a handler', () => {
    expect(problem(viWith('    on_gave_up: { route: escalate }\n', ''))).toBe(
      'steps.escalate is a handler, and no step routes to it: add on_blocked or on_gave_up: { route: escalate } to the step it handles',
    );
    expect(problem(viWith(ESCALATE, `${ESCALATE}    parents: [intake]\n`))).toBe('steps.escalate is a handler, made with no parents when routed to: it takes no parents');
    expect(problem(viWith(ESCALATE, `${ESCALATE}    when: [{ step: intake, state: done }]\n`))).toBe('steps.escalate is a handler, made only when routed to: it takes no when');
    expect(problem(viWith(ESCALATE, `${ESCALATE}    on_gave_up: { route: escalate }\n`))).toBe(
      "steps.escalate is a handler, and a handler's blocks wait for a person: it takes no on_gave_up, so routes never chain",
    );
  });

  it('refuses a route to a step that is no handler, or to none', () => {
    expect(problem(viWith('on_gave_up: { route: escalate }', 'on_gave_up: { route: report }'))).toBe('steps.va.on_gave_up routes to report, which is not a handler (handler: true)');
    expect(problem(viWith('on_gave_up: { route: escalate }', 'on_gave_up: { route: nope }'))).toBe('steps.va.on_gave_up routes to "nope", which is no step of this file');
  });

  it('refuses stands_in_for off a handler, naming no step, or a step that does not route to it', () => {
    expect(problem(viWith('    parents: [report]\n', '    parents: [report]\n    stands_in_for: report\n'))).toBe('steps.patch takes stands_in_for only as a handler (handler: true)');
    expect(problem(viWith('    stands_in_for: va\n', '    stands_in_for: nope\n'))).toBe('steps.escalate.stands_in_for names "nope", which is no step of this file');
    expect(problem(viWith('    stands_in_for: va\n', '    stands_in_for: intake\n'))).toBe('steps.escalate stands in for intake, which does not route to it');
  });

  it("refuses a stand-in whose outputs differ from its step's", () => {
    const escalated = `${ESCALATE}    outputs:\n      reachable: boolean\n`;
    expect(problem(viWith(escalated, `${ESCALATE}    outputs:\n      reachable: string\n`))).toBe(
      'steps.escalate stands in for va, and its outputs differ: va declares reachable (boolean), escalate reachable (string)',
    );
    expect(problem(viWith(escalated, ESCALATE))).toBe('steps.escalate stands in for va, and its outputs differ: va declares reachable (boolean), escalate none');
  });

  it("refuses a stand-in that names a reviewer of its own, as it takes its step's", () => {
    const withReviewer = viWith('    assignee: vulnerability-analyst\n', '    assignee: vulnerability-analyst\n    reviewer: { role: assessment-reviewer }\n');
    const both = withReviewer.replace(ESCALATE, `${ESCALATE}    reviewer: verifier\n`);
    expect(problem(both)).toBe("steps.escalate stands in for va, and takes va's reviewer (role assessment-reviewer): it names none of its own");
    expect(problem(viWith(ESCALATE, `${ESCALATE}    reviewer: verifier\n`))).toBe("steps.escalate stands in for va, and takes va's reviewer (none): it names none of its own");
    expect(problem(withReviewer)).toBeUndefined();
  });

  it("refuses a stand-in whose gates with its step's pass a task's bounds", () => {
    const gates = (n: number, timeout = 10) => `    gates:\n${Array.from({ length: n }, (_, i) => `      - { command: "test -s f${i}", timeout_s: ${timeout} }\n`).join('')}`;
    const va = (n: number, t?: number) => viWith('    assignee: vulnerability-analyst\n', `    assignee: vulnerability-analyst\n${gates(n, t)}`);
    expect(problem(va(2).replace(ESCALATE, `${ESCALATE}${gates(19)}`))).toBe("steps.escalate stands in for va, and va's 2 gates with its own 19 are 21: a task has at most 20");
    expect(problem(va(2, 200).replace(ESCALATE, `${ESCALATE}${gates(1, 300)}`))).toBe(
      "steps.escalate stands in for va, and va's gates with its own would take up to 700 s together; at most 600 s",
    );
    expect(problem(va(2).replace(ESCALATE, `${ESCALATE}${gates(18)}`))).toBeUndefined();
  });

  it("refuses a stand-in whose merged contract field passes 8 KiB, and merges each field as the step's, then the handler's", () => {
    const long = 'v'.repeat(5_000);
    const text = viWith('    assignee: vulnerability-analyst\n', `    assignee: vulnerability-analyst\n    verify: ${long}\n`).replace(ESCALATE, `${ESCALATE}    verify: ${long}\n`);
    expect(problem(text)).toBe(`steps.escalate stands in for va: its contract's verification with va's is ${"the step's (va): ".length + 5_000 + "\n\nthis handler's: ".length + 5_000} bytes; at most 8192`);
    expect(standInContract('va', { outcome: 'the verdict', verification: 'cites the advisory' }, { verification: 'says who was asked', constraints: 'read only' })).toEqual({
      outcome: "the step's (va): the verdict",
      verification: "the step's (va): cites the advisory\n\nthis handler's: says who was asked",
      constraints: 'read only',
    });
  });

  it("refuses a stand-in whose workspace certainly differs from its step's", () => {
    const text = viWith('    assignee: vulnerability-analyst\n', '    assignee: vi-analyst\n').replace(ESCALATE, ESCALATE.replace('vi-coordinator', 'vi-ops'));
    expect(problem(text)).toBe('steps.escalate stands in for va, whose gates run in workspace vi, and escalate works in ops');
    expect(problem(viWith('    assignee: vulnerability-analyst\n', '    assignee: vi-analyst\n'))).toBeUndefined();
  });

  it('allows {{item}} in a handler only when every step routing to it is a fan-out, and its references from the routed step\'s ancestors', () => {
    const helper = '  help:\n    title: "help {{item}}"\n    assignee: vi-coordinator\n    handler: true\n';
    const fanned = viWith('    for_each: { step: intake, output: packages }\n', '    for_each: { step: intake, output: packages }\n    on_blocked: { route: help }\n') + helper;
    expect(problem(fanned)).toBeUndefined();
    expect(problem(viWith('on_gave_up: { route: escalate }', 'on_gave_up: { route: escalate }\n    on_blocked: { route: help }') + helper)).toBe(
      'steps.help.title uses {{item}}, which only a for_each step has',
    );
    expect(problem(viWith('title: "{{case}} · va, escalated"', 'title: "{{case}} · va, escalated, {{intake.kind}}"'))).toBeUndefined();
    expect(problem(viWith('title: "{{case}} · va, escalated"', 'title: "{{case}} · va, escalated, {{va.reachable}}"'))).toBe(
      'steps.escalate.title names va, which is not an ancestor of escalate: a reference reads only steps its parents come after',
    );
  });
});
```

- [ ] **Step 5.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-check-handlers.test.ts`. Expected: `Tests  10 failed (10)`, the first as `AssertionError: expected undefined to be 'steps.report.parents names escalate, …' // Object.is equality`.

- [ ] **Step 5.3: Implement.**

In `src/kanban/routing.ts`, replace:

```ts
import type { Contract, RetryOnCrash } from './types.js';
```

with:

```ts
import { CONTRACT_FIELDS, type Contract, type RetryOnCrash } from './types.js';
```

In `src/kanban/routing.ts`, replace:

```ts
  return outcome === undefined || outcome === '' ? sentence : `${outcome}\n\n${sentence}`;
}
```

with:

```ts
  return outcome === undefined || outcome === '' ? sentence : `${outcome}\n\n${sentence}`;
}

// ---------------------------------------------------------------------------
// A stand-in's contract (§5.2)
// ---------------------------------------------------------------------------

/**
 * A stand-in's contract, merged per field (§5.2): for each field the step sets,
 * `the step's (<step>): <its text>`, then, when the handler sets it too, a blank
 * line and `this handler's: <its text>`; a field only the handler sets is its
 * text alone. The step's `outcome` carries its outputs sentence already.
 */
export function standInContract(step: string, theirs: Contract, own: Contract): Contract {
  const out: Contract = {};
  for (const field of CONTRACT_FIELDS) {
    const a = theirs[field];
    const b = own[field];
    if (a === undefined && b === undefined) continue;
    if (a === undefined) out[field] = b as string;
    else out[field] = b === undefined ? `the step's (${step}): ${a}` : `the step's (${step}): ${a}\n\nthis handler's: ${b}`;
  }
  return out;
}
```

In `src/kanban/workflow.ts`, replace:

```ts
import { outcomeWithOutputs, type Clause, type ClauseValue, type OutputType, type Outputs, type RouteSpec, type ScalarType, type StepState, type WhenItem } from './routing.js';
```

with:

```ts
import { outcomeWithOutputs, standInContract, type Clause, type ClauseValue, type OutputType, type Outputs, type RouteSpec, type ScalarType, type StepState, type WhenItem } from './routing.js';
```

In `src/kanban/workflow.ts`, replace:

```ts
import { GATE_LIMITS, type Contract, type CreatedVia, type Phase, type Refusal, type Result, type RetryOnCrash } from './types.js';
```

with:

```ts
import { CONTRACT_FIELDS, GATE_LIMITS, type Contract, type CreatedVia, type Phase, type Refusal, type Result, type RetryOnCrash } from './types.js';
```

In `src/kanban/workflow.ts`, replace:

```ts
    const forEach = s.forEach !== undefined;
```

with:

```ts
    // A handler has an item when every step routing to it is a fan-out (workflow routing spec §5.2).
    const forEach = s.forEach !== undefined || (s.handler && scope.routedFrom(s.name).length > 0 && scope.routedFrom(s.name).every(isFanOut));
```

In `src/kanban/workflow.ts`, replace:

```ts
    checkRouting(s, scope);
```

with:

```ts
    checkRouting(s, scope, facts.roles);
```

In `src/kanban/workflow.ts`, replace:

```ts
  pending: ReadonlySet<string>;
```

with:

```ts
  pending: ReadonlySet<string>;
  /** The steps whose `on_blocked` or `on_gave_up` routes to a handler, in the file's order. */
  routedFrom(handler: string): WorkflowStep[];
```

In `src/kanban/workflow.ts`, replace:

```ts

function routingScope(steps: readonly WorkflowStep[]): RoutingScope {
```

with:

```ts

/** The handlers a step routes to, by `on_blocked` then `on_gave_up`. */
function routesOf(s: WorkflowStep): string[] {
  return [s.onBlocked, s.onGaveUp].flatMap((r) => (r === 'wait' ? [] : [r.route]));
}

/**
 * A handler's ancestors, for its references (workflow routing spec §5.2): those of
 * every step routing to it, the routed step itself excluded, as it has no result.
 */
function handlerAncestors(routed: readonly WorkflowStep[], ancestors: (name: string) => ReadonlySet<string>): Set<string> {
  const [first, ...rest] = routed;
  if (first === undefined) return new Set();
  return new Set([...ancestors(first.name)].filter((a) => rest.every((r) => ancestors(r.name).has(a))));
}

function routingScope(steps: readonly WorkflowStep[]): RoutingScope {
```

In `src/kanban/workflow.ts`, replace:

```ts
  const ancestors = ancestorsOf(byName);
```

with:

```ts
  const plain = ancestorsOf(byName);
  const routedFrom = (handler: string): WorkflowStep[] => steps.filter((s) => routesOf(s).includes(handler));
  // A handler has no parents: its ancestors are its routed steps' (§5.2).
  const ancestors = (name: string): ReadonlySet<string> => (byName.get(name)?.handler === true ? handlerAncestors(routedFrom(name), plain) : plain(name));
```

In `src/kanban/workflow.ts`, replace:

```ts
    pending,
```

with:

```ts
    pending,
    routedFrom,
```

In `src/kanban/workflow.ts`, replace:

```ts
  if (!scope.byName.has(step)) fail(`${place} names ${q(step)}, which is no step of this file`);
```

with:

```ts
  if (!scope.byName.has(step)) fail(`${place} names ${q(step)}, which is no step of this file`);
  if (scope.byName.get(step)?.handler === true) fail(`${place} names ${step}, a handler, which is made only when routed to and is no step's ancestor`);
```

In `src/kanban/workflow.ts`, replace:

```ts

/** A step's routing checks (workflow routing spec §2.1, §3, §4, §6), after its own. */
```

with:

```ts

/** An output's type, as a check says it: `boolean`, `enum cve, supplychain`, `list of string, max 100`. */
function typeShown(t: OutputType): string {
  if (typeof t === 'string') return t;
  if ('enum' in t) return `enum ${t.enum.join(', ')}`;
  return `list of ${typeShown(t.list)}, max ${t.max}`;
}

/** A step's outputs as a check lists them with their types: `reachable (boolean)`, or `none`. */
function typedOutputs(outputs: Outputs): string {
  const all = Object.entries(outputs);
  return all.length === 0 ? 'none' : all.map(([n, t]) => `${n} (${typeShown(t)})`).join(', ');
}

/** Whether two steps declare the same outputs, name for name and type for type. */
function sameOutputs(a: Outputs, b: Outputs): boolean {
  const names = Object.keys(a);
  return names.length === Object.keys(b).length && names.every((n) => b[n] !== undefined && typeShown(a[n] as OutputType) === typeShown(b[n] as OutputType));
}

/** A reviewer as a stand-in's check names it: `role assessment-reviewer`, a person or a reference as written, or `none`. */
function reviewerShown(spec: NameSpec | undefined): string {
  if (spec === undefined) return 'none';
  if (spec.must === 'person' || spec.value.includes('{{') || spec.value.includes(':')) return spec.value;
  return `role ${spec.value}`;
}

/** A handler's checks (workflow routing spec §5, §6): made only when routed to, never chaining, and a stand-in that takes its step's review, outputs, gates, contract and checkout. */
function checkHandler(s: WorkflowStep, scope: RoutingScope, roles: ReadonlyMap<string, Role>): void {
  const place = `steps.${s.name}`;
  if (s.parents.length > 0) fail(`${place} is a handler, made with no parents when routed to: it takes no parents`);
  if (s.when !== undefined) fail(`${place} is a handler, made only when routed to: it takes no when`);
  if (s.forEach !== undefined) fail(`${place} is a handler, made only when routed to: it takes no for_each`);
  for (const [key, r] of [['on_blocked', s.onBlocked], ['on_gave_up', s.onGaveUp]] as const) {
    if (r !== 'wait') fail(`${place} is a handler, and a handler's blocks wait for a person: it takes no ${key}, so routes never chain`);
  }
  const routed = scope.routedFrom(s.name);
  if (routed.length === 0) fail(`${place} is a handler, and no step routes to it: add on_blocked or on_gave_up: { route: ${s.name} } to the step it handles`);
  if (s.standsInFor === undefined) return;
  const name = s.standsInFor;
  const step = scope.byName.get(name);
  if (step === undefined) fail(`${place}.stands_in_for names ${q(name)}, which is no step of this file`);
  const theirs = step as WorkflowStep;
  if (!routed.includes(theirs)) fail(`${place} stands in for ${name}, which does not route to it`);
  if (!sameOutputs(theirs.outputs, s.outputs)) {
    fail(`${place} stands in for ${name}, and its outputs differ: ${name} declares ${typedOutputs(theirs.outputs)}, ${s.name} ${typedOutputs(s.outputs)}`);
  }
  if (s.reviewer !== undefined) fail(`${place} stands in for ${name}, and takes ${name}'s reviewer (${reviewerShown(theirs.reviewer)}): it names none of its own`);
  // The step's gates first, then its own, as addGate would take them (§5.2).
  const gates = [...theirs.gates, ...s.gates];
  if (gates.length > GATE_LIMITS.perTask) {
    fail(`${place} stands in for ${name}, and ${name}'s ${theirs.gates.length} gates with its own ${s.gates.length} are ${gates.length}: a task has at most ${GATE_LIMITS.perTask}`);
  }
  const total = gates.reduce((sum, g) => sum + g.timeoutS, 0);
  if (total > GATE_LIMITS.totalTimeoutS) {
    fail(`${place} stands in for ${name}, and ${name}'s gates with its own would take up to ${total} s together; at most ${GATE_LIMITS.totalTimeoutS} s`);
  }
  const merged = standInContract(name, { ...theirs.contract, ...(Object.keys(theirs.outputs).length > 0 ? { outcome: outcomeWithOutputs(theirs.contract.outcome, theirs.outputs) } : {}) }, s.contract);
  for (const field of CONTRACT_FIELDS) {
    const size = bytesOf(merged[field] ?? '');
    if (size > WORKER_LIMITS.contractField) fail(`${place} stands in for ${name}: its contract's ${field} with ${name}'s is ${size} bytes; at most ${WORKER_LIMITS.contractField}`);
  }
  const where = certainOf(theirs, roles);
  const own = certainOf(s, roles);
  if (where !== undefined && own !== undefined && where !== own) fail(`${place} stands in for ${name}, whose gates run in workspace ${where}, and ${s.name} works in ${own}`);
}

/** A step's routing checks (workflow routing spec §2.1, §3, §4, §6), after its own. */
```

In `src/kanban/workflow.ts`, replace:

```ts
function checkRouting(s: WorkflowStep, scope: RoutingScope): void {
```

with:

```ts
function checkRouting(s: WorkflowStep, scope: RoutingScope, roles: ReadonlyMap<string, Role>): void {
```

In `src/kanban/workflow.ts`, replace:

```ts
  const place = `steps.${s.name}`;
  if (Object.keys(s.outputs).length > 0 && writtenAsPerson(s.assignee)) {
```

with:

```ts
  const place = `steps.${s.name}`;
  for (const p of s.parents) {
    if (scope.byName.get(p)?.handler === true) fail(`${place}.parents names ${p}, a handler, which is made only when routed to and is no step's parent`);
  }
  if (s.handler) checkHandler(s, scope, roles);
  else if (s.standsInFor !== undefined) fail(`${place} takes stands_in_for only as a handler (handler: true)`);
  for (const [key, r] of [['on_blocked', s.onBlocked], ['on_gave_up', s.onGaveUp]] as const) {
    if (r === 'wait' || s.handler) continue;
    const target = scope.byName.get(r.route);
    if (target === undefined) fail(`${place}.${key} routes to ${q(r.route)}, which is no step of this file`);
    if (!(target as WorkflowStep).handler) fail(`${place}.${key} routes to ${r.route}, which is not a handler (handler: true)`);
  }
  if (Object.keys(s.outputs).length > 0 && writtenAsPerson(s.assignee)) {
```

- [ ] **Step 5.4: Run them to verify they pass.** Run the same command. Expected: `Tests  10 passed (10)`.

- [ ] **Step 5.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3605 passed (3605)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 5.6: Commit.**

```bash
git add src/kanban/routing.ts src/kanban/workflow.ts tests/routing-check-handlers.test.ts
git commit -m "Check a file's routes and handlers: a handler made only when routed to, and a stand-in that takes its step's outputs, reviewer, gates, contract and checkout"
```

---

### Task 6: The check's step lines

**Files:**

- Create: `tests/routing-check-lines.test.ts`
- Modify: `src/cli/workflow.ts`, `src/kanban/routing.ts`, `src/kanban/workflow.ts`

§6. `mt workflow check <name>` of a file using a routing key prints, after its line, one line a step in §6's words, and its line, named or not, counts the steps that are plain, pending and handlers. `clauseText`, `whenText`, `stepWords` and `stepCounts` in `routing.ts` make the words, which the preview reuses (Task 29).

- [ ] **Step 6.1: Write the tests.**

Create `tests/routing-check-lines.test.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clauseText, stepCounts, stepWords, whenText, type StepShape } from '../src/kanban/routing.js';
import { clearSecrets } from '../src/secrets.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';
import { VI_ROLES, VI_WORKFLOW } from './helpers/routing.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * What a check says of each step (workflow routing spec §6): `mt workflow check
 * <name>`'s one line a step after the workflow's, the counts in its line with or
 * without a name, and the words, clause by clause; and a file using no routing
 * key said as before.
 */

const BOARDS_NOTE = 'note: the gateway checks the board when the workflow is used, not here: this check opens no database';

describe('mt workflow check, of a routed file', () => {
  let f: MtFixture;
  beforeEach(() => {
    clearSecrets();
    f = mtFixture();
    for (const name of [...VI_ROLES, 'worker', 'reviewer']) {
      mkdirSync(join(f.home, 'roles', name), { recursive: true });
      writeFileSync(join(f.home, 'roles', name, 'config.yaml'), 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
    }
    mkdirSync(join(f.home, 'workflows'));
    writeFileSync(join(f.home, 'workflows', 'vi-workflow.yaml'), VI_WORKFLOW);
    writeFileSync(join(f.home, 'workflows', 'vendor-eval.yaml'), VENDOR_EVAL);
  });
  afterEach(() => {
    clearSecrets();
    f.cleanup();
  });

  it('prints, after its line, one line a step, in the words of §6', async () => {
    expect(await f.run(['workflow', 'check', 'vi-workflow'])).toEqual({
      code: 0,
      out: [
        'vi-workflow: ok, 8 steps (1 always, 6 on results, 1 handler); params: case (required); board vi',
        '  intake: always',
        '  va: when intake.kind is cve; on gave up, routed to escalate',
        '  escalate: handler for va, standing in',
        '  verify: when intake.verify is true and va.reachable is true',
        '  exposure: per item of intake.packages',
        '  registry: when intake.bnpm is true',
        '  report: when its parents are settled',
        '  patch: when intake.patch is true',
        BOARDS_NOTE,
      ].join('\n'),
      err: '',
    });
  });

  it('counts the steps in each line without a name, and says a file using no routing key as before', async () => {
    expect(await f.run(['workflow', 'check'])).toEqual({
      code: 0,
      out: [
        'vendor-eval: ok, 3 steps; params: topic (required), vendors (list, required), reviewer (default reviewer)',
        'vi-workflow: ok, 8 steps (1 always, 6 on results, 1 handler); params: case (required); board vi',
        BOARDS_NOTE,
      ].join('\n'),
      err: '',
    });
    expect((await f.run(['workflow', 'check', 'vendor-eval'])).out).toBe('vendor-eval: ok, 3 steps; params: topic (required), vendors (list, required), reviewer (default reviewer)');
  });
});

describe('the words of a step', () => {
  it('says each clause, and a when with its any group', () => {
    expect(clauseText({ step: 'va', output: 'reachable', is: true })).toBe('va.reachable is true');
    expect(clauseText({ step: 'va', output: 'reachable', is: false })).toBe('va.reachable is false');
    expect(clauseText({ step: 'intake', output: 'kind', equals: 'cve' })).toBe('intake.kind is cve');
    expect(clauseText({ step: 'va', output: 'score', equals: 7 })).toBe('va.score is 7');
    expect(clauseText({ step: 'intake', output: 'kind', in: ['cve', 'ghsa'] })).toBe('intake.kind is one of cve, ghsa');
    expect(clauseText({ step: 'va', output: 'score', at_least: 7 })).toBe('va.score is at least 7');
    expect(clauseText({ step: 'va', output: 'score', at_most: 9.5 })).toBe('va.score is at most 9.5');
    expect(clauseText({ step: 'va', state: 'gave_up' })).toBe('va gave up');
    expect(clauseText({ step: 'va', state: 'blocked' })).toBe('va blocked');
    expect(clauseText({ step: 'va', state: 'skipped' })).toBe('va is skipped');
    expect(clauseText({ step: 'va', state: 'done' })).toBe('va is done');
    expect(
      whenText([
        { step: 'va', state: 'done' },
        { any: [{ step: 'va', output: 'score', at_least: 9 }, { step: 'intake', output: 'kind', equals: 'ghsa' }] },
      ]),
    ).toBe('va is done and (va.score is at least 9 or intake.kind is ghsa)');
  });

  it("says a pending step over a list param, a fan-out's bound when asked, both routes, a helper, and counts", () => {
    const steps: StepShape[] = [
      { step: 'a', made: 'start', on_blocked: { route: 'h' }, on_gave_up: { route: 'h' } },
      { step: 'b', made: 'decide', for_each: { param: 'vendors' }, on_blocked: 'wait', on_gave_up: 'wait' },
      { step: 'c', made: 'decide', for_each: { step: 'a', output: 'list' }, when: [{ step: 'a', state: 'done' }], on_blocked: 'wait', on_gave_up: 'wait' },
      { step: 'h', made: 'route', handler: true, on_blocked: 'wait', on_gave_up: 'wait' },
    ];
    expect(steps.map((s) => stepWords(steps, s, () => 50))).toEqual([
      'always; on blocked, routed to h; on gave up, routed to h',
      'per item of vendors',
      'per item of a.list, at most 50, when a is done',
      'handler for a',
    ]);
    expect(stepCounts(steps)).toEqual({ always: 1, onResults: 2, handlers: 1 });
  });
});
```

- [ ] **Step 6.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-check-lines.test.ts`. Expected: `Tests  4 failed (4)`, the first as `AssertionError: expected { code: +0, …(2) } to deeply equal { code: +0, …(2) }`.

- [ ] **Step 6.3: Implement.**

In `src/cli/workflow.ts`, replace:

```ts
import { listWorkflows, paramsLine, readWorkflow, type Workflow, type WorkflowFacts, type WorkflowList } from '../kanban/workflow.js';
```

with:

```ts
import { listWorkflows, paramsLine, readWorkflow, stepShapes, usesRouting, type Workflow, type WorkflowFacts, type WorkflowList } from '../kanban/workflow.js';
import { stepCounts, stepWords } from '../kanban/routing.js';
```

In `src/cli/workflow.ts`, replace:

```ts
  return `${w.name}: ok, ${w.steps.length} step${w.steps.length === 1 ? '' : 's'}; params: ${paramsLine(w)}${board}`;
```

with:

```ts
  return `${w.name}: ok, ${stepsCounted(w)}; params: ${paramsLine(w)}${board}`;
}

/**
 * A workflow's steps, counted (workflow routing spec §6): `3 steps`, and for a file
 * using a routing key how many are plain, pending and handlers:
 * `8 steps (1 always, 6 on results, 1 handler)`.
 */
function stepsCounted(w: Workflow): string {
  const n = `${w.steps.length} step${w.steps.length === 1 ? '' : 's'}`;
  if (!usesRouting(w)) return n;
  const c = stepCounts(stepShapes(w));
  return `${n} (${c.always} always, ${c.onResults} on results, ${c.handlers} handler${c.handlers === 1 ? '' : 's'})`;
}

/** What `mt workflow check <name>` says of each step of a file using a routing key, after its line (§6): `  va: when intake.kind is cve`. */
function stepLines(w: Workflow): string[] {
  if (!usesRouting(w)) return [];
  const shapes = stepShapes(w);
  return shapes.map((s) => `  ${s.step}: ${stepWords(shapes, s)}`);
```

In `src/cli/workflow.ts`, replace:

```ts
      say(okLine(r.workflow));
```

with:

```ts
      say(okLine(r.workflow));
      for (const l of stepLines(r.workflow)) say(l);
```

In `src/kanban/routing.ts`, replace:

```ts
  return out;
}
```

with:

```ts
  return out;
}

// ---------------------------------------------------------------------------
// What a check, a preview and `show` say of a step (§6, §12)
// ---------------------------------------------------------------------------

/** What the words of a step read: a plan's step, or a file's as the check sees it. */
export type StepShape = Pick<PlanStep, 'step' | 'made' | 'when' | 'for_each' | 'on_blocked' | 'on_gave_up' | 'handler' | 'stands_in_for'>;

/** A clause's value as words say it: text as written, numbers and booleans as JSON writes them. */
function valueText(v: ClauseValue): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** A clause in words (§6): `va.reachable is true`, `intake.kind is one of cve, ghsa`, `va gave up`. */
export function clauseText(c: Clause): string {
  if ('state' in c) {
    if (c.state === 'gave_up') return `${c.step} gave up`;
    if (c.state === 'blocked') return `${c.step} blocked`;
    return `${c.step} is ${c.state}`;
  }
  const ref = `${c.step}.${c.output}`;
  if ('equals' in c) return `${ref} is ${valueText(c.equals)}`;
  if ('in' in c) return `${ref} is one of ${c.in.map(valueText).join(', ')}`;
  if ('is' in c) return `${ref} is ${c.is}`;
  if ('at_least' in c) return `${ref} is at least ${c.at_least}`;
  return `${ref} is at most ${c.at_most}`;
}

/** A `when` in words: its clauses joined by `and`, the `any` group in parentheses joined by `or`. */
export function whenText(when: readonly WhenItem[]): string {
  return when.map((item) => ('any' in item ? `(${item.any.map(clauseText).join(' or ')})` : clauseText(item))).join(' and ');
}

/** The steps that route to a handler, in the plan's order. */
export function routedFrom(steps: readonly StepShape[], handler: string): string[] {
  return steps.filter((s) => [s.on_blocked, s.on_gave_up].some((r) => r !== 'wait' && r.route === handler)).map((s) => s.step);
}

/**
 * What a check and a preview say of a step (§6): `always` for a plain step;
 * `per item of <step>.<output>` or `per item of <param>`, and `when <clauses>`,
 * for a pending one, or `when its parents are settled` with neither; `handler
 * for <steps>`, with `, standing in`; then its routes. With `max`, a result
 * fan-out says its list's bound, as a preview does (§12.3).
 */
export function stepWords(steps: readonly StepShape[], s: StepShape, max?: (fanOut: StepShape) => number | undefined): string {
  if (s.handler === true) return `handler for ${routedFrom(steps, s.step).join(', ')}${s.stands_in_for === undefined ? '' : ', standing in'}`;
  const parts: string[] = [];
  if (s.made === 'start') parts.push('always');
  else {
    const f = s.for_each;
    if (f !== undefined) {
      const bound = 'step' in f ? max?.(s) : undefined;
      parts.push(`per item of ${'step' in f ? `${f.step}.${f.output}` : f.param}${bound === undefined ? '' : `, at most ${bound}`}`);
    }
    if (s.when !== undefined) parts.push(`when ${whenText(s.when)}`);
    if (parts.length === 0) parts.push('when its parents are settled');
  }
  const routes = [
    ...(s.on_blocked === 'wait' ? [] : [`on blocked, routed to ${s.on_blocked.route}`]),
    ...(s.on_gave_up === 'wait' ? [] : [`on gave up, routed to ${s.on_gave_up.route}`]),
  ];
  return [parts.join(', '), ...routes].join('; ');
}

/** How many steps are plain, pending and handlers, as a check's line counts them (§6). */
export function stepCounts(steps: readonly StepShape[]): { always: number; onResults: number; handlers: number } {
  return {
    always: steps.filter((s) => s.made === 'start').length,
    onResults: steps.filter((s) => s.made === 'decide').length,
    handlers: steps.filter((s) => s.made === 'route').length,
  };
}
```

In `src/kanban/workflow.ts`, replace:

```ts
import { outcomeWithOutputs, standInContract, type Clause, type ClauseValue, type OutputType, type Outputs, type RouteSpec, type ScalarType, type StepState, type WhenItem } from './routing.js';
```

with:

```ts
import { outcomeWithOutputs, standInContract, type StepShape, type Clause, type ClauseValue, type OutputType, type Outputs, type RouteSpec, type ScalarType, type StepState, type WhenItem } from './routing.js';
```

In `src/kanban/workflow.ts`, replace:

```ts
  return pending;
```

with:

```ts
  return pending;
}

/**
 * Whether a file uses any routing key (workflow routing spec §7.1): outputs, a
 * `when`, a result fan-out, a route or a handler. A file using none expands
 * exactly as before, with no plan, and its check says what it said.
 */
export function usesRouting(w: Workflow): boolean {
  return w.steps.some(
    (s) => Object.keys(s.outputs).length > 0 || s.when !== undefined || typeof s.forEach === 'object' || s.onBlocked !== 'wait' || s.onGaveUp !== 'wait' || s.handler,
  );
}

/** A file's steps as the words of a check read them (§6): each with what makes it, plain, pending or a handler. */
export function stepShapes(w: Workflow): StepShape[] {
  const pending = pendingSteps(w.steps);
  return w.steps.map((s) => ({
    step: s.name,
    made: s.handler ? 'route' : pending.has(s.name) ? 'decide' : 'start',
    ...(s.when === undefined ? {} : { when: s.when }),
    ...(s.forEach === undefined ? {} : { for_each: typeof s.forEach === 'string' ? { param: s.forEach } : s.forEach }),
    on_blocked: s.onBlocked,
    on_gave_up: s.onGaveUp,
    ...(s.handler ? { handler: true as const } : {}),
    ...(s.standsInFor === undefined ? {} : { stands_in_for: s.standsInFor }),
  }));
```

- [ ] **Step 6.4: Run them to verify they pass.** Run the same command. Expected: `Tests  4 passed (4)`.

- [ ] **Step 6.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3609 passed (3609)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 6.6: Commit.**

```bash
git add src/cli/workflow.ts src/kanban/routing.ts src/kanban/workflow.ts tests/routing-check-lines.test.ts
git commit -m "Say each step of a routed file in mt workflow check, with how many are plain, pending and handlers"
```

---

### Task 7: The expansion into a DAG and a plan

**Files:**

- Create: `tests/routing-expand.test.ts`
- Modify: `src/kanban/workflow.ts`

§7. `expand` returns `{ dag, plan }`: the plain steps' tasks in the DAG, as today, and for a file using a routing key the plan of every step in the file's order, each with its parents, outputs, `when`, fan-out, routes and template, the params filled in and the references to results left in place, a step over a list param with one template an item. The outputs sentence joins each outcome. A plan past 1 MiB is refused `too_large`.

- [ ] **Step 7.1: Write the tests.**

Create `tests/routing-expand.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalDag, type Dag } from '../src/kanban/dag.js';
import type { Plan } from '../src/kanban/routing.js';
import { checkWorkflow, expand, type Workflow, type WorkflowFacts } from '../src/kanban/workflow.js';
import type { Result } from '../src/kanban/types.js';
import { role } from './helpers/dispatch.js';
import { VI_WORKFLOW, viRoles } from './helpers/routing.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * The expansion of a routed file (workflow routing spec §7): the plain steps'
 * tasks in the DAG as today, the plan with every step, its templates with the
 * params filled in and the references to results left in place, the outputs
 * sentence in `outcome`; and a file with no routing key expanded byte for byte as
 * before, with no plan.
 */

const ROLES = viRoles();
ROLES.set('worker', role('worker'));
ROLES.set('reviewer', role('reviewer'));
const FACTS: WorkflowFacts = { roles: ROLES, workspaces: new Set(['default', 'vi']), supervisedRoles: false };

function workflow(text: string, name = 'vi-workflow'): Workflow {
  const r = checkWorkflow(name, text, FACTS);
  if (!r.ok) throw new Error(r.problem);
  return r.workflow;
}

function expanded(r: Result<{ dag: Dag; plan: Plan | null }>): { dag: Dag; plan: Plan | null } {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return { dag: r.dag, plan: r.plan };
}

const CASE = { from: 'json', params: { case: 'CVE-2026-12345' } } as const;
const SENTENCE = 'Report in the metadata of your completion: kind (one of cve, supplychain); verify (true or false); patch (true or false); bnpm (true or false); packages (a list of at most 100 texts).';

describe('the expansion of a routed file', () => {
  it('puts the plain steps in the DAG and every step in the plan, in the file\'s order', () => {
    const { dag, plan } = expanded(expand(workflow(VI_WORKFLOW), CASE, 'vi'));
    expect(dag.tasks.map((t) => t.ref)).toEqual(['intake']);
    expect(dag.tasks[0]).toMatchObject({ title: 'CVE-2026-12345 · intake', assignee: 'vi-coordinator', contract: { outcome: SENTENCE }, parents: [] });
    expect(plan?.format).toBe(1);
    expect(plan?.steps.map((s) => [s.step, s.made])).toEqual([
      ['intake', 'start'],
      ['va', 'decide'],
      ['escalate', 'route'],
      ['verify', 'decide'],
      ['exposure', 'decide'],
      ['registry', 'decide'],
      ['report', 'decide'],
      ['patch', 'decide'],
    ]);
  });

  it('gives each step its parents, outputs, when, fan-out, routes and template, the params filled in and the results left in place', () => {
    const { plan } = expanded(expand(workflow(VI_WORKFLOW), CASE, 'vi'));
    const step = (name: string) => plan?.steps.find((s) => s.step === name);
    expect(step('intake')).toMatchObject({ parents: [], on_blocked: 'wait', on_gave_up: 'wait', template: { title: 'CVE-2026-12345 · intake', contract: { outcome: SENTENCE } } });
    expect(step('va')).toEqual({
      step: 'va',
      made: 'decide',
      parents: ['intake'],
      outputs: { reachable: 'boolean' },
      when: [{ step: 'intake', output: 'kind', equals: 'cve' }],
      on_blocked: 'wait',
      on_gave_up: { route: 'escalate' },
      template: {
        title: 'CVE-2026-12345 · va',
        body: null,
        assignee: 'vulnerability-analyst',
        reviewer: null,
        workspace: null,
        priority: 0,
        contract: { outcome: 'Report in the metadata of your completion: reachable (true or false).' },
        failure_limit: null,
        retry_on_crash: 'always',
        max_runtime_s: null,
        gates: [],
        wake: null,
      },
    });
    expect(step('escalate')).toMatchObject({ made: 'route', handler: true, stands_in_for: 'va', parents: [], template: { title: 'CVE-2026-12345 · va, escalated' } });
    expect(step('exposure')).toMatchObject({ for_each: { step: 'intake', output: 'packages' }, template: { title: 'CVE-2026-12345 · exposure of {{item}}' } });
    expect(step('report')).toMatchObject({ parents: ['va', 'verify', 'exposure', 'registry'], template: { reviewer: 'assessment-reviewer' } });
    expect(step('report')?.when).toBeUndefined();
  });

  it('leaves {{step.output}} in a template, and expands a pending step over a list param as one template an item', () => {
    const text = `params:
  vendors: { list: true, required: true }
steps:
  intake:
    title: intake
    assignee: worker
    outputs: { kind: string }
  evaluate:
    title: "evaluate {{item}} as {{intake.kind}}"
    body: "for {{intake.kind}}"
    assignee: worker
    parents: [intake]
    for_each: vendors
    when: [{ step: intake, output: kind, equals: vendor }]
`;
    const { dag, plan } = expanded(expand(workflow(text, 'eval'), { from: 'json', params: { vendors: ['acme', 'globex'] } }, 'default'));
    expect(dag.tasks.map((t) => t.ref)).toEqual(['intake']);
    const evaluate = plan?.steps.find((s) => s.step === 'evaluate');
    expect(evaluate?.for_each).toEqual({ param: 'vendors' });
    expect(evaluate?.template).toBeUndefined();
    expect(evaluate?.templates?.map((t) => [t.item, t.title, t.body])).toEqual([
      ['acme', 'evaluate acme as {{intake.kind}}', 'for {{intake.kind}}'],
      ['globex', 'evaluate globex as {{intake.kind}}', 'for {{intake.kind}}'],
    ]);
  });

  it('expands a file using no routing key byte for byte as before, with no plan', () => {
    const { dag, plan } = expanded(expand(workflow(VENDOR_EVAL, 'vendor-eval'), { from: 'json', params: { topic: 'log storage', vendors: ['acme', 'globex'] } }, 'default'));
    expect(plan).toBeNull();
    expect(createHash('sha256').update(canonicalDag(dag), 'utf8').digest('hex')).toBe('bf503f04081410c78a7dbb0967fc19971fce393fdb140815aa159c148c3bfb9a');
  });

  it("refuses {{item}} in a result fan-out's contract or name field, as a result fills only a title and a body", () => {
    const fanned = (keys: string) =>
      checkWorkflow(
        'x',
        `steps:\n  intake:\n    title: intake\n    assignee: worker\n    outputs: { packages: { list: string, max: 3 } }\n  each:\n    title: "each {{item}}"\n    assignee: worker\n    parents: [intake]\n    for_each: { step: intake, output: packages }\n${keys}`,
        FACTS,
      );
    expect(fanned('    outcome: "about {{item}}"\n')).toEqual({ ok: false, problem: "steps.each.outcome uses {{item}}, a result's: a result fills only a title and a body" });
    expect(fanned('    workspace: "{{item}}"\n')).toEqual({ ok: false, problem: "steps.each.workspace uses {{item}}, a result's: a result fills only a title and a body" });
    expect(fanned('    body: "about {{item}}"\n').ok).toBe(true);
  });

  it('refuses a plan past 1 MiB', () => {
    const text = `params:
  vendors: { list: true, required: true }
steps:
  intake:
    title: intake
    assignee: worker
    outputs: { go: boolean }
  evaluate:
    title: "evaluate {{item}}"
    body: "all of {{vendors}}"
    assignee: worker
    parents: [intake]
    for_each: vendors
    when: [{ step: intake, output: go, is: true }]
`;
    const vendors = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, '0')}${'v'.repeat(600)}`);
    const r = expand(workflow(text, 'eval'), { from: 'json', params: { vendors } }, 'default');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('too_large');
    expect(r.message).toMatch(/^workflow eval's plan is \d+ bytes with these params; it may be at most 1048576$/);
  });
});
```

- [ ] **Step 7.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-expand.test.ts`. Expected: `Tests  6 failed (6)`, the first as `AssertionError: expected [ 'intake', 'va', 'escalate', …(5) ] to deeply equal [ 'intake' ]`.

- [ ] **Step 7.3: Implement.**

In `src/kanban/workflow.ts`, replace:

```ts
import { outcomeWithOutputs, standInContract, type StepShape, type Clause, type ClauseValue, type OutputType, type Outputs, type RouteSpec, type ScalarType, type StepState, type WhenItem } from './routing.js';
```

with:

```ts
import { outcomeWithOutputs, PLAN_FORMAT, standInContract, type Plan, type PlanStep, type StepShape, type Template, type Clause, type ClauseValue, type OutputType, type Outputs, type RouteSpec, type ScalarType, type StepState, type WhenItem } from './routing.js';
```

In `src/kanban/workflow.ts`, replace:

```ts
  result: (step: string, output: string) => void,
```

with:

```ts
  result: (step: string, output: string) => void,
  lateItem = false,
```

In `src/kanban/workflow.ts`, replace:

```ts
      if (!forEach) fail(`${place} uses {{item}}, which only a for_each step has`);
```

with:

```ts
      if (!forEach) fail(`${place} uses {{item}}, which only a for_each step has`);
      // A result fan-out's item, and a handler's, is a result's (workflow routing spec §14).
      if (lateItem) fail(`${place} uses {{item}}, a result's: a result fills only a title and a body`);
```

In `src/kanban/workflow.ts`, replace:

```ts
    const forEach = s.forEach !== undefined || (s.handler && scope.routedFrom(s.name).length > 0 && scope.routedFrom(s.name).every(isFanOut));
```

with:

```ts
    const forEach = s.forEach !== undefined || (s.handler && scope.routedFrom(s.name).length > 0 && scope.routedFrom(s.name).every(isFanOut));
    const lateItem = typeof s.forEach === 'object' || s.handler;
```

In `src/kanban/workflow.ts`, replace:

```ts
      if (v !== undefined) references(v, at, params, forEach, (step, output) => fail(`${at} names {{${step}.${output}}}: a result fills only a title and a body`));
```

with:

```ts
      if (v !== undefined) references(v, at, params, forEach, (step, output) => fail(`${at} names {{${step}.${output}}}: a result fills only a title and a body`), lateItem);
    }
    for (const [key, spec] of [['assignee', s.assignee], ['reviewer', s.reviewer], ['workspace', s.workspace === undefined ? undefined : { value: s.workspace, must: undefined }]] as const) {
      const at = `${place}.${key}${spec?.must === undefined ? '' : `.${spec.must}`}`;
      if (lateItem && spec?.value === `{{${ITEM}}}`) fail(`${at} uses {{item}}, a result's: a result fills only a title and a body`);
```

In `src/kanban/workflow.ts`, replace:

```ts
export function expand(w: Workflow, given: GivenParams, board: string, personOf?: PersonOf, via?: CreatedVia['kind']): Result<{ dag: Dag }> {
```

with:

```ts
export function expand(
  w: Workflow,
  given: GivenParams,
  board: string,
  personOf?: PersonOf,
  via?: CreatedVia['kind'],
): Result<{ dag: Dag; plan: Plan | null }> {
```

In `src/kanban/workflow.ts`, replace:

```ts
  };
  const refsOf = new Map<string, string[]>();
```

with:

```ts
  };
  // A file using no routing key expands exactly as before, with no plan (workflow routing spec §7.1).
  const routing = usesRouting(w);
  const pending = routing ? pendingSteps(w.steps) : new Set<string>();
  const plain = (x: WorkflowStep): boolean => !x.handler && !pending.has(x.name);
  const refsOf = new Map<string, string[]>();
```

In `src/kanban/workflow.ts`, replace:

```ts
  const tasks: DagTask[] = [];
```

with:

```ts
  const tasks: DagTask[] = [];
  const planned: PlanStep[] = [];
```

In `src/kanban/workflow.ts`, replace:

```ts
    const over = paramFanOut(s);
    const items: Array<string | null> = over === undefined ? [null] : [...((values.get(over) as string[] | undefined) ?? [])];
```

with:

```ts
    const over = paramFanOut(s);
    // A result fan-out's item, and a handler's, is filled when its task is made (§7.4): left in place.
    const lateItem = typeof s.forEach === 'object' || s.handler;
    const items: Array<string | null> = over === undefined ? [null] : [...((values.get(over) as string[] | undefined) ?? [])];
```

In `src/kanban/workflow.ts`, replace:

```ts
    const refs: string[] = [];
    for (const [n, item] of items.entries()) {
      const sub = (t: string): string => t.replace(/\{\{([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)\}\}/g, (_m, name: string) => (name === ITEM ? (item ?? '') : textOf(name)));
```

with:

```ts
    const made: Array<{ item: string | null; template: Template }> = [];
    for (const item of items) {
      const sub = (t: string): string =>
        t.replace(/\{\{([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)\}\}/g, (m, name: string) => (name === ITEM ? (lateItem ? m : (item ?? '')) : textOf(name)));
```

In `src/kanban/workflow.ts`, replace:

```ts
      const ref = over === undefined ? s.name : `${s.name}:${n + 1}`;
      refs.push(ref);
```

with:

```ts
      // The agent is told what to report, in its outcome (§2.1).
      if (Object.keys(s.outputs).length > 0) contract.outcome = outcomeWithOutputs(contract.outcome, s.outputs);
```

In `src/kanban/workflow.ts`, replace:

```ts
      tasks.push({
        ref,
        step: s.name,
```

with:

```ts
      made.push({
```

In `src/kanban/workflow.ts`, replace:

```ts
        title: sub(s.title),
        body: body === '' ? null : body,
        assignee: assignee.value,
        reviewer: reviewer.value,
        workspace: workspace.value,
        priority: s.priority ?? 0,
        contract,
        failure_limit: s.failureLimit ?? null,
        retry_on_crash: s.retryOnCrash ?? 'always',
        max_runtime_s: s.maxRuntimeS ?? null,
        parents: s.parents.flatMap((p) => refsOf.get(p) ?? []),
        gates: s.gates.map((g) => ({ command: g.command, timeout_s: g.timeoutS })),
        ...(s.wake === true ? { wake: true as const } : s.wake === false ? {} : { wake: { role: s.wake.role } }),
```

with:

```ts
        template: {
          title: sub(s.title),
          body: body === '' ? null : body,
          assignee: assignee.value,
          reviewer: reviewer.value,
          workspace: workspace.value,
          priority: s.priority ?? 0,
          contract,
          failure_limit: s.failureLimit ?? null,
          retry_on_crash: s.retryOnCrash ?? 'always',
          max_runtime_s: s.maxRuntimeS ?? null,
          gates: s.gates.map((g) => ({ command: g.command, timeout_s: g.timeoutS })),
          wake: null,
        },
```

In `src/kanban/workflow.ts`, replace:

```ts
    refsOf.set(s.name, refs);
```

with:

```ts
    if (plain(s)) {
      const refs: string[] = [];
      for (const [n, { item, template: t }] of made.entries()) {
        const ref = over === undefined ? s.name : `${s.name}:${n + 1}`;
        refs.push(ref);
        tasks.push({
          ref,
          step: s.name,
          item,
          title: t.title,
          body: t.body,
          assignee: t.assignee,
          reviewer: t.reviewer,
          workspace: t.workspace,
          priority: t.priority,
          contract: t.contract,
          failure_limit: t.failure_limit,
          retry_on_crash: t.retry_on_crash,
          max_runtime_s: t.max_runtime_s,
          parents: s.parents.flatMap((p) => refsOf.get(p) ?? []),
          gates: t.gates,
          ...(s.wake === true ? { wake: true as const } : s.wake === false ? {} : { wake: { role: s.wake.role } }),
        });
      }
      refsOf.set(s.name, refs);
    }
    if (routing) planned.push(planStep(s, s.handler ? 'route' : plain(s) ? 'start' : 'decide', made, over));
```

In `src/kanban/workflow.ts`, replace:

```ts
      const total = w.steps.reduce((sum, x) => sum + (paramFanOut(x) === undefined ? 1 : ((values.get(paramFanOut(x) ?? '') as string[] | undefined)?.length ?? 0)), 0);
```

with:

```ts
      const total = w.steps
        .filter(plain)
        .reduce((sum, x) => sum + (paramFanOut(x) === undefined ? 1 : ((values.get(paramFanOut(x) ?? '') as string[] | undefined)?.length ?? 0)), 0);
```

In `src/kanban/workflow.ts`, replace:

```ts
  return { ok: true, dag: { format: DAG_FORMAT, workflow: w.name, params: Object.fromEntries(values), board, tasks } };
```

with:

```ts
  const dag: Dag = { format: DAG_FORMAT, workflow: w.name, params: Object.fromEntries(values), board, tasks };
  if (!routing) return { ok: true, dag, plan: null };
  const plan: Plan = { format: PLAN_FORMAT, steps: planned };
  // Measured as a start's DAG is (§7.3).
  const size = bytesOf(JSON.stringify(plan));
  if (size > DAG_LIMITS.bytes) return refuse('too_large', `workflow ${w.name}'s plan is ${size} bytes with these params; it may be at most ${DAG_LIMITS.bytes}`);
  return { ok: true, dag, plan };
}

/** A step of the plan (workflow routing spec §7.3): what decides it, and its one template, or one an item of a list param. */
function planStep(s: WorkflowStep, made: PlanStep['made'], built: ReadonlyArray<{ item: string | null; template: Template }>, over: string | undefined): PlanStep {
  return {
    step: s.name,
    made,
    parents: [...s.parents],
    outputs: s.outputs,
    ...(s.when === undefined ? {} : { when: s.when }),
    ...(s.forEach === undefined ? {} : { for_each: typeof s.forEach === 'string' ? { param: s.forEach } : s.forEach }),
    on_blocked: s.onBlocked,
    on_gave_up: s.onGaveUp,
    ...(s.handler ? { handler: true as const } : {}),
    ...(s.standsInFor === undefined ? {} : { stands_in_for: s.standsInFor }),
    ...(over === undefined
      ? { template: (built[0] as { template: Template }).template }
      : { templates: built.map((b) => ({ ...b.template, item: b.item ?? '' })) }),
  };
```

- [ ] **Step 7.4: Run them to verify they pass.** Run the same command. Expected: `Tests  6 passed (6)`.

- [ ] **Step 7.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3615 passed (3615)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 7.6: Commit.**

```bash
git add src/kanban/workflow.ts tests/routing-expand.test.ts
git commit -m "Expand a routed file into its plain steps' DAG and a plan of every step, with the outputs sentence in each outcome"
```

---

### Task 8: The plan stored at the start

**Files:**

- Create: `tests/routing-start.test.ts`
- Modify: `src/db/kanban.ts`, `src/kanban/routing.ts`, `src/kanban/service.ts`, `tests/helpers/routing.ts`

§7.2, §7.3, §6, §8. `applyDag` stores the plan, masked but for its gates and its clause and enum values, and one `waiting` row a pending step, none a handler, in the start's transaction. Before it, the service refuses a routed start on a database not yet at 15, a step with outputs whose assignee the params made a person, and any template `create` would refuse with each reference filled with its type's widest form, a stand-in checked with its step's reviewer, gates and contract. Each template's wake is the start's, resolved as `#members` resolves a member's, through `memberWake`. `tests/helpers/routing.ts` gains `viBoard` and `madeOf`.

- [ ] **Step 8.1: Write the tests.**

In `tests/helpers/routing.ts`, replace:

```ts
import type { Role } from '../../src/roles.js';
```

with:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBoard } from '../../src/db/kanban.js';
import { getBoard } from '../../src/db/kanban-read.js';
import { KanbanService, type KanbanServiceDeps, type WorkflowMade } from '../../src/kanban/service.js';
import type { Result } from '../../src/kanban/types.js';
import type { Role } from '../../src/roles.js';
```

In `tests/helpers/routing.ts`, replace:

```ts
import type { Role } from '../../src/roles.js';
```

with:

```ts
import type { Role } from '../../src/roles.js';
import type { TestDb } from './db.js';
```

In `tests/helpers/routing.ts`, replace:

```ts
}
```

with:

```ts
}

/** A service over a test database, reading a workflows directory that holds the vi file, on a board `vi` made for it. */
export interface ViBoard {
  service: KanbanService;
  dir: string;
  roles: Map<string, Role>;
  talks: Set<string>;
}

export function viBoard(h: TestDb, deps: Partial<KanbanServiceDeps> = {}): ViBoard {
  const dir = join(h.dir, 'workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'vi-workflow.yaml'), VI_WORKFLOW);
  if (getBoard(h.db, 'vi') === undefined) createBoard(h.db, 'vi', 'lark:on_alice', 1_760_000_000_000);
  const roles = viRoles();
  const talks = new Set<string>(['lark:on_bob']);
  const service = new KanbanService({
    db: h.db,
    roles,
    workspaces: new Set(['default', 'vi']),
    people: { canTalk: (p) => talks.has(p) },
    supervisedRoles: true,
    workflowsDir: dir,
    ...deps,
  });
  return { service, dir, roles, talks };
}

/** A start's answer, or a thrown refusal. */
export function madeOf(r: Result<object>): WorkflowMade {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r as unknown as WorkflowMade;
}
```

Create `tests/routing-start.test.ts`:

```ts
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBoard } from '../src/db/kanban.js';
import { getInstance, pendingOf } from '../src/db/kanban-read.js';
import { migrate, openDb } from '../src/db/open.js';
import { KanbanService } from '../src/kanban/service.js';
import type { CreatedVia } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA } from './helpers/kanban.js';
import { VI_WORKFLOW, madeOf, viBoard, viRoles, type ViBoard } from './helpers/routing.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * A start of a routed file (workflow routing spec §7.2, §7.3, §6, §8): the plain
 * steps' tasks made, the frozen plan stored, masked but for what decides and
 * what runs, its templates' wakes as the start resolved them, one waiting row a
 * pending step and none a handler; the templates checked with placeholders, a
 * person's outputs refused, and a database not yet at 015 refusing it.
 */

const SECRET = 'sk-live-1234567890';
let h: TestDb;
let b: ViBoard;

beforeEach(() => {
  clearSecrets();
  addSecrets([SECRET]);
  h = testDb();
  b = viBoard(h);
});
afterEach(() => {
  clearSecrets();
  h.close();
});

const CASE = { from: 'json', params: { case: 'CVE-2026-12345' } } as const;

function start(extra: Partial<Parameters<KanbanService['startWorkflow']>[0]> = {}) {
  return b.service.startWorkflow({ workflow: 'vi-workflow', params: CASE, createdBy: ALICE, createdVia: VIA, ...extra });
}

describe('a start of a routed file', () => {
  it('makes the plain steps, stores the plan, and writes one waiting row a pending step, none for the handler', () => {
    const r = madeOf(start());
    expect(r.tasks.map((t) => t.ref)).toEqual(['intake']);
    expect(r.instance.board).toBe('vi');
    const plan = getInstance(h.db, r.instance.instanceId)?.plan;
    expect(plan?.steps.map((s) => s.step)).toEqual(['intake', 'va', 'escalate', 'verify', 'exposure', 'registry', 'report', 'patch']);
    expect(plan?.steps.find((s) => s.step === 'verify')?.when).toEqual([
      { step: 'intake', output: 'verify', is: true },
      { step: 'va', output: 'reachable', is: true },
    ]);
    expect(pendingOf(h.db, r.instance.instanceId).map((p) => [p.step, p.state, p.decidedAt])).toEqual([
      ['exposure', 'waiting', null],
      ['patch', 'waiting', null],
      ['registry', 'waiting', null],
      ['report', 'waiting', null],
      ['va', 'waiting', null],
      ['verify', 'waiting', null],
    ]);
    expect(r.tasks[0]?.task.contract.outcome).toMatch(/^Report in the metadata of your completion: kind \(one of cve, supplychain\);/);
  });

  it('stores the templates masked, its gates and its clause and enum values as written', () => {
    writeFileSync(
      join(b.dir, 'vi-workflow.yaml'),
      VI_WORKFLOW.replace('    assignee: vulnerability-analyst\n', '    assignee: vulnerability-analyst\n    body: "see {{case}}"\n    gates:\n      - { command: "vi-workflow-gate result.json", timeout_s: 30 }\n'),
    );
    const r = madeOf(start({ params: { from: 'json', params: { case: `CVE ${SECRET}` } } }));
    const plan = getInstance(h.db, r.instance.instanceId)?.plan;
    const va = plan?.steps.find((s) => s.step === 'va');
    expect(va?.template).toMatchObject({ title: `CVE ${MASK} · va`, body: `see CVE ${MASK}`, gates: [{ command: 'vi-workflow-gate result.json', timeout_s: 30 }] });
    expect(va?.when).toEqual([{ step: 'intake', output: 'kind', equals: 'cve' }]);
    expect(plan?.steps[0]?.outputs).toEqual({
      kind: { enum: ['cve', 'supplychain'] },
      verify: 'boolean',
      patch: 'boolean',
      bnpm: 'boolean',
      packages: { list: 'string', max: 100 },
    });
  });

  it("gives each template its step's wake as the start resolved it, and none for a run's start", () => {
    const r = madeOf(start({ wake: { by: ALICE, depth: 0, all: true } }));
    const plan = getInstance(h.db, r.instance.instanceId)?.plan;
    expect(plan?.steps.find((s) => s.step === 'verify')?.template?.wake).toEqual({ by: ALICE, depth: 0 });
    expect(plan?.steps.find((s) => s.step === 'escalate')?.template?.wake).toEqual({ by: ALICE, depth: 0 });
    const none = madeOf(start({ idempotencyKey: 'lark:om_2' }));
    expect(getInstance(h.db, none.instance.instanceId)?.plan?.steps.find((s) => s.step === 'verify')?.template?.wake).toBeNull();
  });

  it('checks each template as create would, references filled with their widest form, refusing a title too long already', () => {
    // 501 bytes, a space and supplychain, the enum's longest value: 513.
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW.replace('title: "{{case}} · registry"', `title: "${'x'.repeat(501)} {{intake.kind}}"`));
    expect(start()).toEqual({ ok: false, code: 'too_large', message: 'registry: its title is 513 bytes; at most 512' });
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW.replace('title: "{{case}} · registry"', `title: "${'x'.repeat(500)} {{intake.kind}}"`));
    expect(start().ok).toBe(true);
  });

  it("refuses a template for a person without talk tier, and a step with outputs whose assignee param names a person", () => {
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW.replace('    assignee: verifier\n', '    assignee: "lark:on_carol"\n'));
    expect(start()).toMatchObject({ ok: false, code: 'person_not_assignable', message: expect.stringMatching(/^verify: "lark:on_carol" cannot be given work: /) });
    writeFileSync(
      join(b.dir, 'vi-workflow.yaml'),
      VI_WORKFLOW.replace('  case: { required', '  who: { required: true }\n  case: { required').replace('    assignee: vulnerability-analyst\n', '    assignee: "{{who}}"\n'),
    );
    expect(start({ params: { from: 'json', params: { case: 'CVE-1', who: 'lark:on_bob' } } })).toEqual({
      ok: false,
      code: 'invalid',
      message: "steps.va declares outputs, which a role's run reports in its metadata, and its assignee is a person: a person's done gives none",
    });
  });

  it('starts a file using no routing key as before: no plan and no row', () => {
    writeFileSync(join(b.dir, 'vendor-eval.yaml'), VENDOR_EVAL);
    for (const name of ['worker', 'reviewer']) b.roles.set(name, viRoles().get('verifier') as never);
    const r = madeOf(
      b.service.startWorkflow({ workflow: 'vendor-eval', params: { from: 'json', params: { topic: 't', vendors: ['a'] } }, createdBy: ALICE, createdVia: VIA }),
    );
    expect(getInstance(h.db, r.instance.instanceId)?.plan).toBeNull();
    expect(pendingOf(h.db, r.instance.instanceId)).toEqual([]);
  });

  it('refuses a routed start on a database not yet migrated to 015, and starts an old file there as before', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-routing-start-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) {
        if (/^01[0-4]_.*\.sql$/.test(f) || /^00[1-9]_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      }
      const d = openDb(join(dir, 'team.db'));
      try {
        expect(migrate(d, only)).toBe(14);
        createBoard(d, 'vi', ALICE, NOW);
        writeFileSync(join(b.dir, 'vendor-eval.yaml'), VENDOR_EVAL);
        const roles = viRoles();
        for (const name of ['worker', 'reviewer']) roles.set(name, viRoles().get('verifier') as never);
        const old = new KanbanService({ db: d, roles, workspaces: new Set(['default']), supervisedRoles: true, workflowsDir: b.dir });
        const via: CreatedVia = { kind: 'operator' };
        expect(old.startWorkflow({ workflow: 'vi-workflow', params: CASE, createdBy: 'operator:me', createdVia: via })).toEqual({
          ok: false,
          code: 'invalid',
          message: 'the database is not yet migrated to version 15: start the gateway once, so it is migrated',
        });
        expect(old.startWorkflow({ workflow: 'vendor-eval', params: { from: 'json', params: { topic: 't', vendors: ['a'] } }, createdBy: 'operator:me', createdVia: via }).ok).toBe(true);
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 8.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-start.test.ts`. Expected: `Tests  6 failed | 1 passed (7)`, the first as `AssertionError: expected undefined to deeply equal [ 'intake', 'va', 'escalate', …(5) ]`.

- [ ] **Step 8.3: Implement.**

In `src/db/kanban.ts`, replace:

```ts
import { canonicalDag, maskDag, type Dag } from '../kanban/dag.js';
```

with:

```ts
import { canonicalDag, maskDag, type Dag } from '../kanban/dag.js';
import { maskPlan, type Plan } from '../kanban/routing.js';
```

In `src/db/kanban.ts`, replace:

```ts
  gatesOf,
```

with:

```ts
  gatesOf,
  hasRouting,
```

In `src/db/kanban.ts`, replace:

```ts
  }
}

/** Why a wake is refused on a database the gateway has not yet migrated (wake spec §4.1). */
```

with:

```ts
  }
}

/** Why a routed start is refused on a database the gateway has not yet migrated (workflow routing spec §8). */
export const ROUTING_NOT_MIGRATED = 'the database is not yet migrated to version 15: start the gateway once, so it is migrated';

/** Why a wake is refused on a database the gateway has not yet migrated (wake spec §4.1). */
```

In `src/db/kanban.ts`, replace:

```ts
  follow?: Follow;
}
```

with:

```ts
  follow?: Follow;
  /** Its plan (workflow routing spec §7.3), for a start of a file using a routing key; absent or null for none. */
  plan?: Plan | null;
}
```

In `src/db/kanban.ts`, replace:

```ts
    }
    const instanceId = newWorkflowId();
```

with:

```ts
    }
    const plan = instance.plan ?? null;
    if (plan !== null && !hasRouting(d)) return refuse('invalid', ROUTING_NOT_MIGRATED);
    const instanceId = newWorkflowId();
```

In `src/db/kanban.ts`, replace:

```ts
    );
    const member = d.prepare(
```

with:

```ts
    );
    if (plan !== null) {
      // The plan, frozen, masked but for what decides and what runs; one waiting row a pending step, none a handler (workflow routing spec §7.2, §7.3).
      d.prepare('UPDATE kanban_workflow_instances SET plan = ? WHERE instance_id = ?').run(JSON.stringify(maskPlan(plan, mask)), instanceId);
      const waiting = d.prepare("INSERT INTO kanban_workflow_pending (instance_id, step, state) VALUES (?, ?, 'waiting')");
      for (const s of plan.steps) if (s.made === 'decide') waiting.run(instanceId, s.step);
    }
    const member = d.prepare(
```

In `src/kanban/routing.ts`, replace:

```ts
  };
}
```

with:

```ts
  };
}

// ---------------------------------------------------------------------------
// Templates: masking, and the references filled (§7.3, §7.4)
// ---------------------------------------------------------------------------

/** Every `{{<step>.<output>}}` and `{{item}}` in a template's text. */
const LATE_REFERENCE = /\{\{([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)(?:\.([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?))?\}\}/g;

/**
 * A template's text with its references to results filled, once, as params are
 * (§7.4): each `{{<step>.<output>}}` by `result`, and `{{item}}` by `item` when
 * given. A param's reference was filled at the start, so none is left; any
 * other `{{` is left as written.
 */
export function fillText(text: string, result: (step: string, output: string) => string, item?: string): string {
  return text.replace(LATE_REFERENCE, (m, name: string, output: string | undefined) => {
    if (output !== undefined) return result(name, output);
    return name === 'item' && item !== undefined ? item : m;
  });
}

/** The text a skipped step's output fills a title or a body with (§7.4): a display placeholder, which nothing reads as a value. */
export const SKIPPED_TEXT = '(skipped)';

/** The widest JSON number, as `JSON.stringify` writes one: what a start checks a number's reference with. */
const WIDEST_NUMBER = '-1.7976931348623157e+308';

/**
 * What a start fills a reference with to check a template (§6): its type's widest
 * form where that is bounded, a boolean's `false`, a number's widest, an enum's
 * longest value, or `(skipped)` where that is wider; text and lists, whose widest
 * would pass every title's bound, `(skipped)`, as they are cut at the making.
 */
export function placeholderOf(t: OutputType | undefined): string {
  const widest = (s: ScalarType): string => {
    if (s === 'boolean') return 'false';
    if (s === 'number') return WIDEST_NUMBER;
    if (s === 'string') return SKIPPED_TEXT;
    return s.enum.reduce((a, b) => (Buffer.byteLength(b) > Buffer.byteLength(a) ? b : a), '');
  };
  if (t === undefined || (typeof t === 'object' && 'list' in t)) return SKIPPED_TEXT;
  const w = widest(t);
  return Buffer.byteLength(w) > Buffer.byteLength(SKIPPED_TEXT) ? w : SKIPPED_TEXT;
}

/** A list output's item as a start checks a template with it: its item type's widest bounded form. */
export function itemPlaceholderOf(t: OutputType | undefined): string {
  if (t !== undefined && typeof t === 'object' && 'list' in t) return placeholderOf(t.list);
  return SKIPPED_TEXT;
}

/** A template with each text masked, as the stored DAG's are (§7.3); its gates as written. */
function maskTemplate<T extends Template>(t: T, mask: (text: string) => string): T {
  const contract: Contract = {};
  for (const field of CONTRACT_FIELDS) {
    const v = t.contract[field];
    if (v !== undefined) contract[field] = mask(v);
  }
  return { ...t, title: mask(t.title), body: t.body === null ? null : mask(t.body), contract };
}

/**
 * The plan as an instance stores it (§7.3): its templates' text masked, value by
 * value, titles, bodies, contract fields and items, as the stored DAG's are; but
 * not its gates' commands, nor the clause and enum values, which a reported value
 * must still equal.
 */
export function maskPlan(plan: Plan, mask: (text: string) => string): Plan {
  return {
    ...plan,
    steps: plan.steps.map((s) => ({
      ...s,
      ...(s.template === undefined ? {} : { template: maskTemplate(s.template, mask) }),
      ...(s.templates === undefined ? {} : { templates: s.templates.map((t) => ({ ...maskTemplate(t, mask), item: mask(t.item) })) }),
    })),
  };
}
```

In `src/kanban/service.ts`, replace:

```ts
  getTaskByKey,
```

with:

```ts
  getTaskByKey,
  hasRouting,
```

In `src/kanban/service.ts`, replace:

```ts
import { checkDagShape, checkDagTasks, type Dag, type DagTask, type ShapedDag } from './dag.js';
```

with:

```ts
import { checkDagShape, checkDagTasks, type Dag, type DagTask, type ShapedDag } from './dag.js';
import { fillText, itemPlaceholderOf, placeholderOf, standInContract, type Plan, type PlanStep, type Template } from './routing.js';
```

In `src/kanban/service.ts`, replace:

```ts
export const NOT_IN_WAKE = 'a woken turn reads only the tasks whose events woke it';
```

with:

```ts
export const NOT_IN_WAKE = 'a woken turn reads only the tasks whose events woke it';

/**
 * A member's wake, as a start resolves it (wake spec §3.1): every member's with
 * `all`, else only one whose step, or DAG task, asks, `ask`; the start's role,
 * else the member's own step's (§19.1), else the chat session; with no chat to
 * follow it, a member that would wake the chat session is notice-only (§19.16).
 */
function memberWake(ask: DagTask['wake'], wake: StartWakeOf | undefined): board.NewWake | undefined {
  if (wake === undefined || (!wake.all && ask === undefined)) return wake === undefined ? undefined : { by: null, depth: wake.depth };
  const role = wake.role ?? (typeof ask === 'object' ? ask.role : undefined);
  if (role === undefined && wake.rolesOnly === true) return { by: null, depth: wake.depth };
  return {
    by: wake.by,
    depth: wake.depth,
    ...(wake.tooDeep === true ? { tooDeep: true } : {}),
    ...(role === undefined ? {} : { role }),
  };
}
```

In `src/kanban/service.ts`, replace:

```ts
    const wakeOf = (t: DagTask): board.NewWake | undefined => {
      if (wake === undefined || (!wake.all && t.wake === undefined)) return wake === undefined ? undefined : { by: null, depth: wake.depth };
      // The start's role, else the member's own step's (wake spec §19.1), else the chat session.
      const role = wake.role ?? (typeof t.wake === 'object' ? t.wake.role : undefined);
      // With no chat to follow it, a member that would wake the chat session is notice-only (§19.16).
      if (role === undefined && wake.rolesOnly === true) return { by: null, depth: wake.depth };
      return {
        by: wake.by,
        depth: wake.depth,
        ...(wake.tooDeep === true ? { tooDeep: true } : {}),
        ...(role === undefined ? {} : { role }),
      };
    };
```

with:

```ts
    const wakeOf = (t: DagTask): board.NewWake | undefined => memberWake(t.wake, wake);
```

In `src/kanban/service.ts`, replace:

```ts
  #expanded(req: StartRequest, onBoard: string): Result<ShapedDag & { workflow: Workflow; board: string; fromFile: boolean }> {
```

with:

```ts
  #expanded(req: StartRequest, onBoard: string): Result<ShapedDag & { workflow: Workflow; board: string; fromFile: boolean; plan: Plan | null }> {
```

In `src/kanban/service.ts`, replace:

```ts
    return { ...shaped, workflow: read.workflow, board: routed.board, fromFile: routed.fromFile };
```

with:

```ts
    return { ...shaped, workflow: read.workflow, board: routed.board, fromFile: routed.fromFile, plan: expanded.plan };
  }

  /**
   * What a start checks of its plan beyond the file (workflow routing spec §6, §8):
   * a database migrated to 015; no step with outputs whose assignee, as the
   * params named it, is a person (§2.1); and each template of a step made later
   * checked as `create` would check it, every reference to a result filled with
   * its type's widest form, a stand-in with its step's reviewer, gates and
   * contract (§5.2), so a template too long already is refused now, not cut later.
   */
  #checkPlan(plan: Plan | null, createdBy: string, createdVia: CreatedVia): Refusal | undefined {
    if (plan === null) return undefined;
    if (!hasRouting(this.#db)) return board.refuse('invalid', board.ROUTING_NOT_MIGRATED);
    const byName = new Map(plan.steps.map((s) => [s.step, s]));
    const templatesOf = (s: PlanStep): Array<Template & { item: string | null }> => s.templates ?? (s.template === undefined ? [] : [{ ...s.template, item: null }]);
    const tasks: DagTask[] = [];
    for (const s of plan.steps) {
      for (const t of templatesOf(s)) {
        if (Object.keys(s.outputs).length > 0 && t.assignee !== null && t.assignee.includes(':')) {
          return board.refuse('invalid', `steps.${s.step} declares outputs, which a role's run reports in its metadata, and its assignee is a person: a person's done gives none`);
        }
      }
      if (s.made === 'start') continue;
      const source = s.for_each !== undefined && 'step' in s.for_each ? byName.get(s.for_each.step)?.outputs[s.for_each.output] : undefined;
      const item = s.for_each !== undefined && 'step' in s.for_each ? itemPlaceholderOf(source) : s.handler === true ? itemPlaceholderOf(undefined) : undefined;
      const fill = (text: string): string => fillText(text, (step, output) => placeholderOf(byName.get(step)?.outputs[output]), item);
      // A stand-in is checked with each template of its step: its reviewer, its gates before its own, its contract merged (§5.2).
      const stood = s.stands_in_for === undefined ? undefined : byName.get(s.stands_in_for);
      const against: Array<Template | undefined> = stood === undefined ? [undefined] : templatesOf(stood);
      for (const [n, t] of templatesOf(s).entries()) {
        for (const theirs of against) {
          tasks.push({
            ref: templatesOf(s).length > 1 ? `${s.step}:${n + 1}` : s.step,
            step: s.step,
            item: t.item,
            title: fill(t.title),
            body: t.body === null ? null : fill(t.body),
            assignee: t.assignee,
            reviewer: theirs === undefined ? t.reviewer : theirs.reviewer,
            workspace: t.workspace,
            priority: t.priority,
            contract: theirs === undefined ? t.contract : standInContract(s.stands_in_for ?? '', theirs.contract, t.contract),
            failure_limit: t.failure_limit,
            retry_on_crash: t.retry_on_crash,
            max_runtime_s: t.max_runtime_s,
            parents: [],
            gates: theirs === undefined ? t.gates : [...theirs.gates, ...t.gates],
          });
        }
      }
    }
    if (tasks.length === 0) return undefined;
    return checkDagTasks({ format: 1, workflow: null, params: {}, board: null, tasks }, { facts: this.#facts(), createdBy, createdVia });
  }

  /** The plan with each template's wake, as the start resolved it for its step (workflow routing spec §7.3); a run's start's late members inherit theirs at the making. */
  #plannedWakes(plan: Plan | null, w: Workflow, wake: StartWakeOf | undefined): Plan | null {
    if (plan === null) return null;
    const asks = new Map(w.steps.map((s) => [s.name, s.wake === true ? (true as const) : s.wake === false ? undefined : { role: s.wake.role }]));
    const withWake = <T extends Template>(t: T, step: string): T => {
      const resolved = memberWake(asks.get(step), wake);
      return {
        ...t,
        wake:
          resolved === undefined
            ? null
            : { by: resolved.by, depth: resolved.depth, ...(resolved.tooDeep === true ? { tooDeep: true as const } : {}), ...(resolved.role === undefined ? {} : { role: resolved.role }) },
      };
    };
    return {
      ...plan,
      steps: plan.steps.map((s) => ({
        ...s,
        ...(s.template === undefined ? {} : { template: withWake(s.template, s.step) }),
        ...(s.templates === undefined ? {} : { templates: s.templates.map((t) => withWake(t, s.step)) }),
      })),
    };
```

In `src/kanban/service.ts`, replace:

```ts
  previewWorkflow(req: StartRequest): Result<{ dag: Dag; workflow: Workflow }> {
```

with:

```ts
  previewWorkflow(req: StartRequest): Result<{ dag: Dag; workflow: Workflow; plan: Plan | null }> {
```

In `src/kanban/service.ts`, replace:

```ts
    const shaped = this.#expanded(req, on.board);
    if (!shaped.ok) return shaped;
    const refused = this.#checkDag(shaped.dag, shaped.board, req.createdBy, req.createdVia, shaped.fromFile ? shaped.workflow.name : undefined);
    if (refused !== undefined) return refused;
    return { ok: true, dag: shaped.dag, workflow: shaped.workflow };
```

with:

```ts
    const shaped = this.#expanded(req, on.board);
    if (!shaped.ok) return shaped;
    const refused =
      this.#checkDag(shaped.dag, shaped.board, req.createdBy, req.createdVia, shaped.fromFile ? shaped.workflow.name : undefined) ??
      this.#checkPlan(shaped.plan, req.createdBy, req.createdVia);
    if (refused !== undefined) return refused;
    return { ok: true, dag: shaped.dag, workflow: shaped.workflow, plan: shaped.plan };
```

In `src/kanban/service.ts`, replace:

```ts
    const refused = this.#checkDag(shaped.dag, shaped.board, req.createdBy, req.createdVia, shaped.fromFile ? shaped.workflow.name : undefined);
```

with:

```ts
    const refused =
      this.#checkDag(shaped.dag, shaped.board, req.createdBy, req.createdVia, shaped.fromFile ? shaped.workflow.name : undefined) ??
      this.#checkPlan(shaped.plan, req.createdBy, req.createdVia);
```

In `src/kanban/service.ts`, replace:

```ts
    if (!wake.ok) return wake;
    return this.#write(shaped, {
      ...(wake.wake === undefined ? {} : { wake: wake.wake }),
```

with:

```ts
    if (!wake.ok) return wake;
    return this.#write(shaped, {
      plan: this.#plannedWakes(shaped.plan, shaped.workflow, wake.wake),
      ...(wake.wake === undefined ? {} : { wake: wake.wake }),
```

In `src/kanban/service.ts`, replace:

```ts
      wakeNote?: string;
```

with:

```ts
      wakeNote?: string;
      plan?: Plan | null;
```

In `src/kanban/service.ts`, replace:

```ts
        ...(i.follow === undefined ? {} : { follow: i.follow }),
```

with:

```ts
        ...(i.follow === undefined ? {} : { follow: i.follow }),
        ...(i.plan === undefined || i.plan === null ? {} : { plan: i.plan }),
```

- [ ] **Step 8.4: Run them to verify they pass.** Run the same command. Expected: `Tests  7 passed (7)`.

- [ ] **Step 8.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3622 passed (3622)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 8.6: Commit.**

```bash
git add src/db/kanban.ts src/kanban/routing.ts src/kanban/service.ts tests/helpers/routing.ts tests/routing-start.test.ts
git commit -m "Store a routed start's plan, frozen, with one waiting row a pending step, after checking its templates as create would"
```

---

### Task 9: The output check at completion

**Files:**

- Create: `tests/routing-outputs.test.ts`
- Modify: `src/kanban/dag.ts`, `src/kanban/routing.ts`, `src/kanban/service.ts`

§2.2. `KanbanService.complete` and `requestReview` check a work report's metadata against its step's outputs, after `handoffRefused` and before the gates, `invalid` with the first problem, word for word; a reviewer's approval is not checked, nor a task of no instance with a plan. A list a fan-out reads is held to a list param's rules, and a value a later title reads to one line. `checkOutputs` and `outputBounds` are in `routing.ts`; `shown` is exported from `dag.ts`.

- [ ] **Step 9.1: Write the tests.**

Create `tests/routing-outputs.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { getRun, getTask } from '../src/db/kanban-read.js';
import { checkOutputs, type OutputBounds } from '../src/kanban/routing.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { VI_WORKFLOW, madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * A run's completion against its step's outputs (workflow routing spec §2.2):
 * each type's refusal, word for word, the first in the declared order; a list
 * a fan-out reads held to a list param's rules; checked on a work report, not
 * on an approval; a person's done refused; before the gates; and the run left
 * undecided, so its next report is taken.
 */

const SECRET = 'sk-live-1234567890';
const NONE: OutputBounds = { fanned: new Set(), titledItems: new Set(), titled: new Set() };

describe('checkOutputs', () => {
  it("refuses each type's wrong value, word for word, and a missing output", () => {
    expect(checkOutputs({ reachable: 'boolean' }, {}, NONE)).toBe('output reachable is missing');
    expect(checkOutputs({ reachable: 'boolean' }, undefined, NONE)).toBe('output reachable is missing');
    expect(checkOutputs({ reachable: 'boolean' }, { reachable: 'yes' }, NONE)).toBe('output reachable must be true or false; got "yes"');
    expect(checkOutputs({ score: 'number' }, { score: '7' }, NONE)).toBe('output score must be a number; got "7"');
    expect(checkOutputs({ note: 'string' }, { note: 3 }, NONE)).toBe('output note must be text; got 3');
    expect(checkOutputs({ note: 'string' }, { note: 'n'.repeat(9120) }, NONE)).toBe('output note is 9120 bytes; at most 8192');
    expect(checkOutputs({ kind: { enum: ['cve', 'supplychain'] } }, { kind: 'library' }, NONE)).toBe('output kind must be one of cve, supplychain; got "library"');
    const list = { packages: { list: 'string', max: 50 } } as const;
    expect(checkOutputs(list, { packages: Array.from({ length: 63 }, (_, i) => `p${i}`) }, NONE)).toBe('output packages must be a list of at most 50 strings; got 63');
    expect(checkOutputs(list, { packages: 'lodash' }, NONE)).toBe('output packages must be a list of at most 50 strings; got a string');
    expect(checkOutputs(list, { packages: ['a', 'b', 'c', 7] }, NONE)).toBe('item 4 of output packages must be text; got 7');
    expect(checkOutputs({ reachable: 'boolean', score: 'number' }, { score: 'x', reachable: 'y' }, NONE)).toBe('output reachable must be true or false; got "y"');
    expect(checkOutputs({ reachable: 'boolean', packages: list.packages }, { reachable: false, packages: [], other: { free: true } }, NONE)).toBeUndefined();
  });

  it('holds a list a fan-out reads to a list param\'s rules, and its items and a titled text to one line', () => {
    clearSecrets();
    addSecrets([SECRET]);
    try {
      const fanned: OutputBounds = { fanned: new Set(['packages']), titledItems: new Set(['packages']), titled: new Set(['note']) };
      const list = { packages: { list: 'string', max: 50 } } as const;
      expect(checkOutputs(list, { packages: ['lodash', ' '] }, fanned)).toBe('item 2 of output packages is empty');
      expect(checkOutputs(list, { packages: ['lodash', 'qs', 'lodash '] }, fanned)).toBe('output packages names "lodash" twice; each item labels its task');
      expect(checkOutputs(list, { packages: [`x ${SECRET}`] }, fanned)).toBe('an item of output packages holds a known secret');
      expect(checkOutputs(list, { packages: ['a', 'b', 'c', 'd', 'two\nlines'] }, fanned)).toBe(
        'item 5 of output packages holds a line break, a control character or a bidi control, and an item lands in a title',
      );
      expect(checkOutputs(list, { packages: ['a', 'a'] }, NONE)).toBeUndefined();
      expect(checkOutputs({ note: 'string' }, { note: 'two\nlines' }, fanned)).toBe('output note holds a line break, a control character or a bidi control, and it lands in a title');
      expect(checkOutputs({ note: 'string' }, { note: 'two\nlines' }, NONE)).toBeUndefined();
    } finally {
      clearSecrets();
    }
  });
});

describe('a completion checked against its outputs', () => {
  let h: TestDb;
  let b: ViBoard;
  beforeEach(() => {
    clearSecrets();
    h = testDb();
    b = viBoard(h);
  });
  afterEach(() => {
    clearSecrets();
    h.close();
  });

  const OUTPUTS = { kind: 'cve', verify: false, patch: false, bnpm: false, packages: ['lodash', 'minimist', 'qs'] };

  function intake() {
    const r = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
    return r.tasks[0]?.task.taskId ?? '';
  }

  it('refuses a work report missing an output before its gates run, the run left undecided, and takes the next', async () => {
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW.replace('    assignee: vi-coordinator\n    outputs:', '    assignee: vi-coordinator\n    gates:\n      - { command: "true", timeout_s: 5 }\n    outputs:'));
    const taskId = intake();
    const run = claimed(h.db, taskId);
    const { packages: _packages, ...rest } = OUTPUTS;
    // With no checks configured, a task with gates is refused gates_cannot_run: invalid means no gate ran.
    expect(await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'triaged', metadata: rest })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'output packages is missing',
    });
    expect(getRun(h.db, run.runId)?.outcome).toBeNull();
    expect(await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'triaged', metadata: OUTPUTS })).toMatchObject({ ok: false, code: 'gates_cannot_run' });
  });

  it('checks a complete from open and a review, and not an approval, nor a step with no outputs', async () => {
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW.replace('    assignee: vi-coordinator\n    outputs:', '    assignee: vi-coordinator\n    reviewer: verifier\n    outputs:'));
    const taskId = intake();
    const run = claimed(h.db, taskId);
    const by = { kind: 'run', runId: run.runId } as const;
    expect(await b.service.requestReview(taskId, by, { summary: 'x', metadata: { ...OUTPUTS, kind: 'library' } })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await b.service.complete(taskId, by, { summary: 'x', metadata: { ...OUTPUTS, kind: 'library' } })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'output kind must be one of cve, supplychain; got "library"',
    });
    expect(await b.service.complete(taskId, by, { summary: 'x', metadata: OUTPUTS })).toMatchObject({ ok: true, task: { phase: 'review' } });
    closeRun(h.db, run.runId, NOW);
    const review = claimed(h.db, taskId);
    expect(await b.service.complete(taskId, { kind: 'run', runId: review.runId }, { summary: 'LGTM' })).toMatchObject({ ok: true, task: { phase: 'done' } });
  });

  it("refuses a person's done on a step with outputs, as it carries no metadata", async () => {
    const taskId = intake();
    const r = await b.service.complete(taskId, { kind: 'person', principal: ALICE }, { summary: 'done by hand' });
    expect(r).toEqual({ ok: false, code: 'invalid', message: 'output kind is missing' });
    expect(getTask(h.db, taskId)?.phase).toBe('open');
  });
});
```

- [ ] **Step 9.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-outputs.test.ts`. Expected: `Tests  5 failed (5)`, the first as `TypeError: (0 , checkOutputs) is not a function`.

- [ ] **Step 9.3: Implement.**

In `src/kanban/dag.ts`, replace:

```ts
  /** Tasks in one DAG, and so in one instance. */
```

with:

```ts
  /** Tasks in one DAG, and so made at one start; an instance with a plan may make up to 500 in all. */
```

In `src/kanban/dag.ts`, replace:

```ts
/** A value a refusal quotes: masked, cut, and its invisible characters shown. */
function shown(text: string, max = 80): string {
```

with:

```ts
/** A value a refusal quotes: masked, cut, and its invisible characters shown; the routing's output check quotes a value by it too (workflow routing spec §2.2). */
export function shown(text: string, max = 80): string {
```

In `src/kanban/routing.ts`, replace:

```ts
import { CONTRACT_FIELDS, type Contract, type RetryOnCrash } from './types.js';
```

with:

```ts
import { redactKnownSecrets } from '../secrets.js';
import { DAG_LIMITS, shown, titleRefused } from './dag.js';
import { CONTRACT_FIELDS, type Contract, type RetryOnCrash } from './types.js';
```

In `src/kanban/routing.ts`, replace:

```ts
    })),
  };
}
```

with:

```ts
    })),
  };
}

// ---------------------------------------------------------------------------
// The check at completion (§2.2)
// ---------------------------------------------------------------------------

/** What else a step's outputs are held to, by what reads them later in the plan (§2.2, §4.1). */
export interface OutputBounds {
  /** The list outputs a fan-out reads: their items are a list param's (§4.1). */
  fanned: ReadonlySet<string>;
  /** Of those, the ones whose fan-out puts `{{item}}` in a title: each item is one line. */
  titledItems: ReadonlySet<string>;
  /** The outputs a later title reads by `{{step.output}}`: one line, a list's items each. */
  titled: ReadonlySet<string>;
}

/** Every `{{<step>.<output>}}` in a text, as `[step, output]`. */
function resultRefs(text: string): Array<[string, string]> {
  return [...text.matchAll(LATE_REFERENCE)].flatMap((m) => (m[2] === undefined ? [] : [[m[1] ?? '', m[2]] as [string, string]]));
}

/** A step's templates, whichever it has. */
function templatesOf(s: PlanStep): Template[] {
  return s.templates ?? (s.template === undefined ? [] : [s.template]);
}

/** What step `step`'s outputs are held to, from the steps of the plan that read them (§2.2). */
export function outputBounds(plan: Plan, step: string): OutputBounds {
  const fanned = new Set<string>();
  const titledItems = new Set<string>();
  const titled = new Set<string>();
  for (const s of plan.steps) {
    const f = s.for_each;
    if (f !== undefined && 'step' in f && f.step === step) {
      fanned.add(f.output);
      if (templatesOf(s).some((t) => t.title.includes('{{item}}'))) titledItems.add(f.output);
    }
    for (const t of templatesOf(s)) for (const [from, output] of resultRefs(t.title)) if (from === step) titled.add(output);
  }
  return { fanned, titledItems, titled };
}

/** A value a refusal quotes (§2.2): as JSON writes it, masked and cut at 80 characters. */
function said(value: unknown): string {
  if (typeof value === 'string') return shown(value);
  const text = redactKnownSecrets(JSON.stringify(value) ?? String(value));
  return text.length <= 80 ? text : `${text.slice(0, 80)}…`;
}

/** What a value is, as `got …` says it when it is no list. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'a boolean';
  return Array.isArray(value) ? 'a list' : 'an object';
}

/** A scalar's refusal, `<what> must be …; got …`, or undefined when the value is of its type. */
function scalarRefused(what: string, t: ScalarType, value: unknown): string | undefined {
  if (t === 'boolean') return typeof value === 'boolean' ? undefined : `${what} must be true or false; got ${said(value)}`;
  if (t === 'number') return typeof value === 'number' && Number.isFinite(value) ? undefined : `${what} must be a number; got ${said(value)}`;
  if (t === 'string') {
    if (typeof value !== 'string') return `${what} must be text; got ${said(value)}`;
    const size = Buffer.byteLength(value, 'utf8');
    return size > DAG_LIMITS.valueBytes ? `${what} is ${size} bytes; at most ${DAG_LIMITS.valueBytes}` : undefined;
  }
  return typeof value === 'string' && t.enum.includes(value) ? undefined : `${what} must be one of ${t.enum.join(', ')}; got ${said(value)}`;
}

/** A list's items as its refusal names them: `strings`, `numbers`, `booleans`, or an enum's values. */
function itemsNamed(t: ScalarType): string {
  if (typeof t === 'object') return `values of ${t.enum.join(', ')}`;
  return `${t}s`;
}

/** An item as the fan-out over it reads it (§4.1): text as given, numbers and booleans as JSON writes them, trimmed. */
export function itemText(value: boolean | number | string): string {
  return (typeof value === 'string' ? value : JSON.stringify(value)).trim();
}

/**
 * A report's metadata against the step's declared outputs (§2.2): every output a
 * top-level key, of its type; a list within its `max`, its items of their type;
 * a list a fan-out reads holding items as a list param's, none empty or twice or
 * holding a known secret, one line each when `{{item}}` lands in a title; a
 * value a later title reads one line. The first problem, in the declared
 * order, or undefined.
 */
export function checkOutputs(declared: Outputs, metadata: unknown, bounds: OutputBounds): string | undefined {
  const reported = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
  for (const [name, t] of Object.entries(declared)) {
    const what = `output ${name}`;
    if (!Object.hasOwn(reported, name)) return `${what} is missing`;
    const value = reported[name];
    if (typeof t === 'object' && 'list' in t) {
      if (!Array.isArray(value)) return `${what} must be a list of at most ${t.max} ${itemsNamed(t.list)}; got ${kindOf(value)}`;
      if (value.length > t.max) return `${what} must be a list of at most ${t.max} ${itemsNamed(t.list)}; got ${value.length}`;
      for (const [i, item] of value.entries()) {
        const bad = scalarRefused(`item ${i + 1} of ${what}`, t.list, item);
        if (bad !== undefined) return bad;
      }
      const items = (value as Array<boolean | number | string>).map(itemText);
      if (bounds.fanned.has(name)) {
        for (const [i, item] of items.entries()) {
          if (item === '') return `item ${i + 1} of ${what} is empty`;
          if (items.indexOf(item) !== i) return `${what} names ${shown(item)} twice; each item labels its task`;
          if (redactKnownSecrets(item) !== item) return `an item of ${what} holds a known secret`;
        }
      }
      if (bounds.titledItems.has(name) || bounds.titled.has(name)) {
        const n = items.findIndex((item) => titleRefused(item));
        if (n !== -1) return `item ${n + 1} of ${what} holds a line break, a control character or a bidi control, and an item lands in a title`;
      }
      continue;
    }
    const bad = scalarRefused(what, t, value);
    if (bad !== undefined) return bad;
    if (bounds.titled.has(name) && typeof value === 'string' && titleRefused(value)) {
      return `${what} holds a line break, a control character or a bidi control, and it lands in a title`;
    }
  }
  return undefined;
}
```

In `src/kanban/service.ts`, replace:

```ts
  phaseSince,
```

with:

```ts
  phaseSince,
  plannedMemberOf,
```

In `src/kanban/service.ts`, replace:

```ts
import { fillText, itemPlaceholderOf, placeholderOf, standInContract, type Plan, type PlanStep, type Template } from './routing.js';
```

with:

```ts
import { checkOutputs, fillText, itemPlaceholderOf, outputBounds, placeholderOf, standInContract, type Plan, type PlanStep, type Template } from './routing.js';
```

In `src/kanban/service.ts`, replace:

```ts
    opts: ReportOptions = {},
  ): Promise<Result<{ task: TaskRow; run: RunRow | undefined }>> {
    const refused = idsRefused(taskId) ?? handoffRefused(by, handoff);
    if (refused !== undefined) return refused;
    return this.#report(taskId, by, 'complete', undefined, opts, (seen) =>
```

with:

```ts
    opts: ReportOptions = {},
  ): Promise<Result<{ task: TaskRow; run: RunRow | undefined }>> {
    const refused = idsRefused(taskId) ?? handoffRefused(by, handoff) ?? this.#outputsRefused(taskId, 'complete', handoff.metadata);
    if (refused !== undefined) return refused;
    return this.#report(taskId, by, 'complete', undefined, opts, (seen) =>
```

In `src/kanban/service.ts`, replace:

```ts
    const refused = idsRefused(taskId) ?? handoffRefused(by, handoff);
```

with:

```ts
    const refused = idsRefused(taskId) ?? handoffRefused(by, handoff) ?? this.#outputsRefused(taskId, 'review', handoff.metadata);
```

In `src/kanban/service.ts`, replace:

```ts
      ),
    );
  }
```

with:

```ts
      ),
    );
  }

  /**
   * A work report's outputs (workflow routing spec §2.2), before its gates: on a
   * member of an instance with a plan whose step declares outputs, a `complete`
   * from `open` or a `review`, never a reviewer's approval, whose metadata is
   * checked against them, `invalid` naming the first problem, so the run
   * reports again. A stand-in's are its step's, and held to what reads its
   * step's. One indexed read for any task, nothing more for one with no plan.
   */
  #outputsRefused(taskId: string, kind: 'complete' | 'review', metadata: unknown): Refusal | undefined {
    const planned = plannedMemberOf(this.#db, taskId);
    const plan = planned?.instance.plan;
    if (planned === undefined || plan === null || plan === undefined) return undefined;
    const entry = plan.steps.find((s) => s.step === planned.member.step);
    if (entry === undefined || Object.keys(entry.outputs).length === 0) return undefined;
    if (kind === 'complete' && getTask(this.#db, taskId)?.phase !== 'open') return undefined;
    const problem = checkOutputs(entry.outputs, metadata, outputBounds(plan, entry.stands_in_for ?? entry.step));
    return problem === undefined ? undefined : board.refuse('invalid', problem);
  }
```

- [ ] **Step 9.4: Run them to verify they pass.** Run the same command. Expected: `Tests  5 passed (5)`.

- [ ] **Step 9.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3627 passed (3627)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 9.6: Commit.**

```bash
git add src/kanban/dag.ts src/kanban/routing.ts src/kanban/service.ts tests/routing-outputs.test.ts
git commit -m "Refuse a work report whose metadata misses one of its step's outputs or holds one of the wrong type, before its gates run"
```

---

### Task 10: The DAG paths refuse a routed file

**Files:**

- Create: `tests/routing-dag-paths.test.ts`
- Modify: `src/cli/operator.ts`, `src/kanban/service.ts`, `src/kanban/workflow.ts`

§13.5. `mt kanban workflow preview --json` of a file using a routing key is refused, naming the keys it uses; `apply` and `apply --dry-run` refuse a DAG labelled with such a file, by `workflowRouting`, a light read as `workflowBoard`'s, after a repeat by key is answered, and check nothing for a file that cannot be read.

- [ ] **Step 10.1: Write the tests.**

Create `tests/routing-dag-paths.test.ts`:

```ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { migrate, openDb } from '../src/db/open.js';
import { workflowRouting } from '../src/kanban/workflow.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';
import { VI_ROLES, VI_WORKFLOW, madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * Conditions are workflow starts' only (workflow routing spec §13.5): `preview
 * --json` refused for a file using any routing key, outputs alone included,
 * naming the keys; `apply` and `apply --dry-run` refusing a DAG labelled with
 * such a file, after a repeat by key is answered, and checking nothing for a file
 * that cannot be read.
 */

const REFUSED = 'workflow vi-workflow uses outputs, when, for_each over an output, on_gave_up, handler, which a DAG cannot carry: start it with workflow start';
/** The vi file with nothing but its first step, and no routing key. */
const PLAIN = 'board: vi\nparams:\n  case: { required: true }\nsteps:\n  intake:\n    title: "{{case}} · intake"\n    assignee: vi-coordinator\n';

const DAG = {
  format: 1,
  workflow: 'vi-workflow',
  params: { case: 'CVE-1' },
  board: 'vi',
  tasks: [{ ref: 'intake', title: 'CVE-1 · intake', assignee: 'vi-coordinator' }],
};

describe('a DAG labelled with a routed file', () => {
  let h: TestDb;
  let b: ViBoard;
  beforeEach(() => {
    clearSecrets();
    h = testDb();
    b = viBoard(h);
  });
  afterEach(() => h.close());

  const apply = (dag: unknown, extra: Record<string, unknown> = {}) =>
    b.service.applyDag({ dag, createdBy: 'operator:me', createdVia: { kind: 'operator' }, ...extra });

  it('is refused by apply and apply --dry-run, and applied with no label', () => {
    expect(apply(DAG)).toEqual({ ok: false, code: 'invalid', message: REFUSED });
    expect(apply(DAG, { dryRun: true })).toEqual({ ok: false, code: 'invalid', message: REFUSED });
    const made = madeOf(apply({ ...DAG, workflow: null }));
    expect(made.instance.name).toBeNull();
    expect(made.tasks.map((t) => t.task.title)).toEqual(['CVE-1 · intake']);
  });

  it('answers a repeat by key first, and checks nothing for a file that cannot be read', () => {
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), PLAIN);
    const first = madeOf(apply(DAG, { idempotencyKey: 'k' }));
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW);
    expect(madeOf(apply(DAG, { idempotencyKey: 'k' }))).toMatchObject({ existing: true, instance: { instanceId: first.instance.instanceId } });
    expect(apply(DAG, { idempotencyKey: 'k2' })).toEqual({ ok: false, code: 'invalid', message: REFUSED });
    rmSync(join(b.dir, 'vi-workflow.yaml'));
    expect(madeOf(apply(DAG, { idempotencyKey: 'k3' })).existing).toBe(false);
  });

  it("reads a file's routing keys alone, outputs alone included", () => {
    expect(workflowRouting(b.dir, 'vi-workflow')).toEqual({ file: 'read', keys: ['outputs', 'when', 'for_each over an output', 'on_gave_up', 'handler'] });
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), PLAIN.replace('assignee: vi-coordinator\n', 'assignee: vi-coordinator\n    outputs: { verify: boolean }\n'));
    expect(workflowRouting(b.dir, 'vi-workflow')).toEqual({ file: 'read', keys: ['outputs'] });
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), PLAIN);
    expect(workflowRouting(b.dir, 'vi-workflow')).toEqual({ file: 'read', keys: [] });
    expect(workflowRouting(b.dir, 'nope')).toEqual({ file: 'unreadable' });
  });
});

describe('mt kanban workflow preview --json of a routed file', () => {
  let f: MtFixture;
  beforeEach(() => {
    clearSecrets();
    f = mtFixture();
    for (const name of VI_ROLES) {
      mkdirSync(join(f.home, 'roles', name), { recursive: true });
      writeFileSync(join(f.home, 'roles', name, 'config.yaml'), 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
    }
    mkdirSync(join(f.home, 'workflows'));
    writeFileSync(join(f.home, 'workflows', 'vi-workflow.yaml'), VI_WORKFLOW);
    const d = openDb(join(f.home, 'team.db'));
    migrate(d, SCHEMA_DIR);
    d.close();
  });
  afterEach(() => {
    clearSecrets();
    f.cleanup();
  });

  async function preview(...extra: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMt(['kanban', 'workflow', 'preview', 'vi-workflow', '--param', 'case=CVE-1', ...extra], {
      env: { ...f.env, HOME: f.root },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      stdinIsTTY: false,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('is refused, naming the keys the file uses, outputs alone included', async () => {
    expect(await preview('--json')).toEqual({ code: 1, out: '', err: `mt: ${REFUSED}` });
    writeFileSync(join(f.home, 'workflows', 'vi-workflow.yaml'), PLAIN.replace('assignee: vi-coordinator\n', 'assignee: vi-coordinator\n    outputs: { verify: boolean }\n'));
    expect(await preview('--json')).toEqual({
      code: 1,
      out: '',
      err: 'mt: workflow vi-workflow uses outputs, which a DAG cannot carry: start it with workflow start',
    });
  });
});
```

- [ ] **Step 10.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-dag-paths.test.ts`. Expected: `Tests  4 failed (4)`, the first as `AssertionError: expected { ok: true, instance: { …(11) }, …(2) } to deeply equal { ok: false, code: 'invalid', …(1) }`.

- [ ] **Step 10.3: Implement.**

In `src/cli/operator.ts`, replace:

```ts
import { archivedBoardProblem, expand, listWorkflows, missingBoardProblem, paramsLine, readWorkflow, startBoard, usableMessage, withBoards } from '../kanban/workflow.js';
```

with:

```ts
import { archivedBoardProblem, expand, listWorkflows, missingBoardProblem, paramsLine, readWorkflow, routedDagProblem, routingKeys, startBoard, usableMessage, withBoards } from '../kanban/workflow.js';
```

In `src/cli/operator.ts`, replace:

```ts
  }
  const routed = startBoard(read.workflow, { kind: 'terminal', board: asked });
```

with:

```ts
  }
  // A DAG is a fixed graph: a file using routing keys has no DAG to give (workflow routing spec §13.5).
  const keys = routingKeys(read.workflow);
  if (json && keys.length > 0) return no('invalid', routedDagProblem(name, keys));
  const routed = startBoard(read.workflow, { kind: 'terminal', board: asked });
```

In `src/kanban/service.ts`, replace:

```ts
  readWorkflow,
```

with:

```ts
  readWorkflow,
  routedDagProblem,
```

In `src/kanban/service.ts`, replace:

```ts
  workflowBoard,
```

with:

```ts
  workflowBoard,
  workflowRouting,
```

In `src/kanban/service.ts`, replace:

```ts
    }
    // A DAG that names a workflow whose file names a board is held to it, by the file as it is now (workflows spec §19.3).
```

with:

```ts
    }
    // A DAG labelled with a file that uses routing keys is refused: only a start keeps its checks and routes (workflow routing spec §13.5).
    if (req.createdVia?.kind !== 'run' && shaped.dag.workflow !== null && this.#workflowsDir !== undefined) {
      const routed = workflowRouting(this.#workflowsDir, shaped.dag.workflow);
      if (routed.file === 'read' && routed.keys.length > 0) return board.refuse('invalid', routedDagProblem(shaped.dag.workflow, routed.keys));
    }
    // A DAG that names a workflow whose file names a board is held to it, by the file as it is now (workflows spec §19.3).
```

In `src/kanban/workflow.ts`, replace:

```ts

/** Why a workflow is not usable when its board does not exist (workflows spec §19.4). */
```

with:

```ts

/** The routing keys, as a refusal of a DAG path names them, in this order (workflow routing spec §13.5). */
const ROUTING_KEYS = ['outputs', 'when', 'for_each over an output', 'on_blocked', 'on_gave_up', 'handler'] as const;

/** Which routing keys a step uses, read from its YAML mapping as written: the same rules as `usesRouting`. */
function keysUsed(step: Record<string, unknown>): Set<string> {
  const used = new Set<string>();
  const set = (v: unknown): boolean => v !== undefined && v !== null;
  if (isRecord(step['outputs']) && Object.keys(step['outputs']).length > 0) used.add('outputs');
  if (set(step['when'])) used.add('when');
  if (isRecord(step['for_each'])) used.add('for_each over an output');
  if (set(step['on_blocked']) && step['on_blocked'] !== 'wait') used.add('on_blocked');
  if (set(step['on_gave_up']) && step['on_gave_up'] !== 'wait') used.add('on_gave_up');
  if (step['handler'] === true) used.add('handler');
  return used;
}

/** What the light read of a file's routing keys finds (workflow routing spec §13.5). */
export type WorkflowRoutingRead = { file: 'unreadable' } | { file: 'read'; keys: string[] };

/**
 * A workflow file's routing keys alone (workflow routing spec §13.5), by the light
 * read `workflowBoard` makes (workflows spec §19.3): the entry, the YAML parsed,
 * no team check; the keys its steps use, in the order a refusal names them.
 * Unreadable as `workflowBoard` finds one.
 */
export function workflowRouting(dir: string, name: string): WorkflowRoutingRead {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) return { file: 'unreadable' };
  const entry = `${name}.yaml`;
  if (statOf(join(dir, entry)) === undefined || notAWorkflow(dir, entry) !== undefined) return { file: 'unreadable' };
  const read = readFile(join(dir, entry));
  if (!read.ok) return { file: 'unreadable' };
  let parsed: unknown;
  try {
    parsed = parseYaml(read.text, { logLevel: 'error' });
  } catch {
    return { file: 'unreadable' };
  }
  const steps = isRecord(parsed) && isRecord(parsed['steps']) ? Object.values(parsed['steps']) : [];
  const used = new Set(steps.flatMap((st) => (isRecord(st) ? [...keysUsed(st)] : [])));
  return { file: 'read', keys: ROUTING_KEYS.filter((k) => used.has(k)) };
}

/** Why a DAG path refuses a file that uses routing keys (workflow routing spec §13.5): a DAG is a fixed graph. */
export function routedDagProblem(name: string, keys: readonly string[]): string {
  return `workflow ${name} uses ${keys.join(', ')}, which a DAG cannot carry: start it with workflow start`;
}

/** The routing keys a parsed file uses, in the order a refusal names them (workflow routing spec §13.5). */
export function routingKeys(w: Workflow): string[] {
  const used = new Set<string>();
  for (const s of w.steps) {
    if (Object.keys(s.outputs).length > 0) used.add('outputs');
    if (s.when !== undefined) used.add('when');
    if (typeof s.forEach === 'object') used.add('for_each over an output');
    if (s.onBlocked !== 'wait') used.add('on_blocked');
    if (s.onGaveUp !== 'wait') used.add('on_gave_up');
    if (s.handler) used.add('handler');
  }
  return ROUTING_KEYS.filter((k) => used.has(k));
}

/** Why a workflow is not usable when its board does not exist (workflows spec §19.4). */
```

- [ ] **Step 10.4: Run them to verify they pass.** Run the same command. Expected: `Tests  4 passed (4)`.

- [ ] **Step 10.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3631 passed (3631)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 10.6: Commit.**

```bash
git add src/cli/operator.ts src/kanban/service.ts src/kanban/workflow.ts tests/routing-dag-paths.test.ts
git commit -m "Refuse preview --json of a file using a routing key, and apply of a DAG labelled with one, after its key's repeat"
```

---

## Phase 2: decide() and conditions

Tasks 11 to 18. The pure `decide`, every clause and state, skipping and settling, the effective parents and archive spreading; the writer deciding in each settling transaction, settling and skipping, making a step late and checking it against the team, in a savepoint, with its fault mark and event; `workflow archive` cancelling a case; the dispatcher's retry; and the status. A step over a result's list waits for Phase 3; a block waits for a person, as before, for Phase 4. Phase 2 ends green, a checkpoint to review at.

---

### Task 11: decide() and conditions

**Files:**

- Create: `tests/routing-decide.test.ts`
- Modify: `src/kanban/routing.ts`

§3, §10. The pure `decide(plan, facts)` in `routing.ts`: each waiting step's `when` decided by §3.1's table, a state clause by its step's trigger events and an output clause by its settled winner's result; a step skipped at its first false clause, made once its `when` holds and its parents are settled, linked to its effective parents, skipped by archive when its parents all were, skipped past the cap; and a skipped step settled once its parents are.

- [ ] **Step 11.1: Write the tests.**

Create `tests/routing-decide.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decide, effectiveParents, INSTANCE_CAP, type Facts, type Plan, type PlanStep, type StepFact, type Template, type WhenItem } from '../src/kanban/routing.js';

/**
 * decide(plan, facts) on plans and facts written by hand (workflow routing spec
 * §3, §10): every clause and state, the any group, what a skipped or archived
 * step reads as, an early skip held until its parents settle, the effective
 * parents, archive spreading, the cap, and totality.
 */

const TEMPLATE: Template = {
  title: 't',
  body: null,
  assignee: 'worker',
  reviewer: null,
  workspace: null,
  priority: 0,
  contract: {},
  failure_limit: null,
  retry_on_crash: 'always',
  max_runtime_s: null,
  gates: [],
  wake: null,
};

function step(name: string, parents: string[] = [], extra: Partial<PlanStep> = {}): PlanStep {
  return { step: name, made: parents.length === 0 ? 'start' : 'decide', parents, outputs: {}, on_blocked: 'wait', on_gave_up: 'wait', template: { ...TEMPLATE }, ...extra };
}

/** a, a root with outputs; b, a child of a; c, a child of b. */
function plan(whenB?: WhenItem[], whenC?: WhenItem[]): Plan {
  return {
    format: 1,
    steps: [
      step('a', [], { outputs: { kind: { enum: ['cve', 'ghsa'] }, score: 'number', go: 'boolean', note: 'string', list: { list: 'string', max: 5 } } }),
      step('b', ['a'], whenB === undefined ? {} : { when: whenB }),
      step('c', ['b'], whenC === undefined ? {} : { when: whenC }),
    ],
  };
}

function fact(name: string, over: Partial<StepFact> = {}): StepFact {
  return { step: name, row: null, skippedBy: null, settled: null, items: new Map(), entered: { blocked: false, gaveUp: false }, result: null, ...over };
}

const DONE = (taskId: string, eventId: number) => ({ how: 'done' as const, taskId, eventId });

function facts(list: StepFact[], members = 1): Facts {
  return { steps: new Map(list.map((f) => [f.step, f])), due: [], members, cap: INSTANCE_CAP };
}

/** The decisions for b, given a's result and settling, with b and c waiting. */
function decideB(whenB: WhenItem[], a: Partial<StepFact>) {
  return decide(plan(whenB), facts([fact('a', { settled: DONE('k_a', 4), ...a }), fact('b', { row: 'waiting' }), fact('c', { row: 'waiting' })]));
}

const RESULT = { kind: 'cve', score: 7, go: true, note: 'hello', list: ['x', 'y'] };

describe('the clauses', () => {
  it('decides equals on text, an enum, a number and a boolean, and in', () => {
    expect(decideB([{ step: 'a', output: 'kind', equals: 'cve' }], { result: RESULT })).toEqual([{ step: 'b', outcome: 'made', parents: ['k_a'], why: 'a.kind is cve' }]);
    expect(decideB([{ step: 'a', output: 'kind', equals: 'ghsa' }], { result: RESULT })).toEqual([{ step: 'b', outcome: 'skipped', by: 'when', why: 'a.kind is cve' }]);
    expect(decideB([{ step: 'a', output: 'note', equals: 'hello' }], { result: RESULT })[0]?.outcome).toBe('made');
    expect(decideB([{ step: 'a', output: 'score', equals: 7 }], { result: RESULT })[0]?.outcome).toBe('made');
    expect(decideB([{ step: 'a', output: 'go', equals: false }], { result: RESULT })).toEqual([{ step: 'b', outcome: 'skipped', by: 'when', why: 'a.go is true' }]);
    expect(decideB([{ step: 'a', output: 'kind', in: ['ghsa', 'cve'] }], { result: RESULT })[0]?.outcome).toBe('made');
    expect(decideB([{ step: 'a', output: 'kind', in: ['ghsa'] }], { result: RESULT })[0]?.outcome).toBe('skipped');
  });

  it('decides is true and false, and at_least and at_most at, below and above the bound', () => {
    expect(decideB([{ step: 'a', output: 'go', is: true }], { result: RESULT })[0]?.outcome).toBe('made');
    expect(decideB([{ step: 'a', output: 'go', is: false }], { result: RESULT })[0]?.outcome).toBe('skipped');
    for (const [bound, made] of [[6, true], [7, true], [8, false]] as const) {
      expect(decideB([{ step: 'a', output: 'score', at_least: bound }], { result: RESULT })[0]?.outcome).toBe(made ? 'made' : 'skipped');
    }
    for (const [bound, made] of [[6, false], [7, true], [8, true]] as const) {
      expect(decideB([{ step: 'a', output: 'score', at_most: bound }], { result: RESULT })[0]?.outcome).toBe(made ? 'made' : 'skipped');
    }
    expect(decideB([{ step: 'a', output: 'score', at_least: 8 }], { result: RESULT })).toEqual([{ step: 'b', outcome: 'skipped', by: 'when', why: 'a.score is 7' }]);
  });

  it('decides each state, done and skipped once settled, and blocked and gave_up at the transition', () => {
    expect(decideB([{ step: 'a', state: 'done' }], {})[0]?.outcome).toBe('made');
    expect(decideB([{ step: 'a', state: 'skipped' }], {})).toEqual([{ step: 'b', outcome: 'skipped', by: 'when', why: 'a is done' }]);
    expect(decideB([{ step: 'a', state: 'done' }], { settled: { how: 'skipped', taskId: null, eventId: 4 } })).toEqual([
      { step: 'b', outcome: 'skipped', by: 'when', why: 'a was skipped' },
      // c is a child of b, decided by its parent once b settles.
    ]);
    expect(decideB([{ step: 'a', state: 'skipped' }], { settled: { how: 'skipped', taskId: null, eventId: 4 } })[0]?.outcome).toBe('made');
    // Its one parent archived undone: the clause holds, and the step is skipped by archive, never made with no link.
    expect(decideB([{ step: 'a', state: 'skipped' }], { settled: { how: 'archived', taskId: null, eventId: 4 } })).toEqual([
      { step: 'b', outcome: 'skipped', by: 'archive', why: 'its parents were archived' },
    ]);
    // Unsettled: a clause on its state is undecided, but blocked and gave_up hold at the transition.
    const running = (when: WhenItem[], entered = { blocked: false, gaveUp: false }) =>
      decide(plan(when), facts([fact('a', { entered }), fact('b', { row: 'waiting' }), fact('c', { row: 'waiting' })]));
    expect(running([{ step: 'a', state: 'done' }])).toEqual([]);
    expect(running([{ step: 'a', state: 'gave_up' }])).toEqual([]);
    expect(running([{ step: 'a', state: 'gave_up' }], { blocked: false, gaveUp: true })).toEqual([{ step: 'b', outcome: 'made', parents: [], why: 'a gave up' }]);
    expect(running([{ step: 'a', state: 'blocked' }], { blocked: true, gaveUp: false })).toEqual([{ step: 'b', outcome: 'made', parents: [], why: 'a blocked' }]);
    expect(running([{ step: 'a', state: 'blocked' }], { blocked: false, gaveUp: true })).toEqual([]);
    // Settled without having entered it: false.
    expect(decideB([{ step: 'a', state: 'gave_up' }], {})).toEqual([{ step: 'b', outcome: 'skipped', by: 'when', why: 'a did not give up' }]);
    expect(decideB([{ step: 'a', state: 'blocked' }], {})).toEqual([{ step: 'b', outcome: 'skipped', by: 'when', why: 'a did not block' }]);
  });

  it('holds an any group when one of three holds, not when none does, and a false clause before it skips first', () => {
    const any: WhenItem = { any: [{ step: 'a', output: 'score', at_least: 9 }, { step: 'a', output: 'kind', equals: 'cve' }, { step: 'a', output: 'go', is: false }] };
    expect(decideB([any], { result: RESULT })).toEqual([{ step: 'b', outcome: 'made', parents: ['k_a'], why: '(a.score is at least 9 or a.kind is cve or a.go is false)' }]);
    expect(decideB([any], { result: { ...RESULT, kind: 'ghsa' } })).toEqual([{ step: 'b', outcome: 'skipped', by: 'when', why: 'a.score is 7' }]);
    expect(decideB([{ step: 'a', output: 'go', is: false }, any], { result: RESULT })).toEqual([{ step: 'b', outcome: 'skipped', by: 'when', why: 'a.go is true' }]);
  });

  it('reads a clause on a skipped or undone archived step as false, and a done step archived later as done with its result', () => {
    expect(decideB([{ step: 'a', output: 'go', is: true }], { settled: { how: 'skipped', taskId: null, eventId: 4 }, result: RESULT })).toEqual([
      { step: 'b', outcome: 'skipped', by: 'when', why: 'a was skipped' },
    ]);
    expect(decideB([{ step: 'a', output: 'go', is: true }], { settled: { how: 'archived', taskId: null, eventId: 4 } })).toEqual([
      { step: 'b', outcome: 'skipped', by: 'when', why: 'a was archived' },
    ]);
    // Its settled row says done: the archive came after the accepted completion, and never wins.
    expect(decideB([{ step: 'a', output: 'go', is: true }], { result: RESULT })[0]?.outcome).toBe('made');
    expect(decideB([{ step: 'a', output: 'go', is: true }], { settled: { how: 'stood_in', taskId: 'k_s', eventId: 6 }, result: RESULT })).toEqual([
      { step: 'b', outcome: 'made', parents: ['k_s'], why: 'a.go is true' },
    ]);
  });

  it('reads a value of the wrong type as missing, and a step it does not know as unsettled', () => {
    expect(decideB([{ step: 'a', output: 'score', at_least: 1 }], { result: { score: '7' } })).toEqual([{ step: 'b', outcome: 'skipped', by: 'when', why: 'a.score is missing' }]);
    expect(decideB([{ step: 'a', output: 'kind', equals: 'cve' }], { result: { kind: 'library' } })[0]?.outcome).toBe('skipped');
    expect(decideB([{ step: 'nope', state: 'done' }], {})).toEqual([]);
  });
});

describe('skipping, settling and the effective parents', () => {
  it('skips a step whose when is false while its parent runs, settling it only once its parents are, and its child waits', () => {
    // c reads a, its grandparent, and b is still running.
    const p = plan(undefined, [{ step: 'a', output: 'go', is: false }]);
    const running = facts([fact('a', { settled: DONE('k_a', 4), result: RESULT }), fact('b', { row: 'made' }), fact('c', { row: 'waiting' })]);
    expect(decide(p, running)).toEqual([{ step: 'c', outcome: 'skipped', by: 'when', why: 'a.go is true' }]);
    const skipped = facts([fact('a', { settled: DONE('k_a', 4), result: RESULT }), fact('b', { row: 'made' }), fact('c', { row: 'skipped', skippedBy: 'when' })]);
    expect(decide(p, skipped)).toEqual([]);
    const through = facts([fact('a', { settled: DONE('k_a', 4), result: RESULT }), fact('b', { row: 'made', settled: DONE('k_b', 9) }), fact('c', { row: 'skipped', skippedBy: 'when' })]);
    expect(decide(p, through)).toEqual([{ step: 'c', outcome: 'settled', how: 'skipped', eventId: 9 }]);
  });

  it('links a child past a chain of two skips to the nearest done ancestor, never reading its outputs', () => {
    const p: Plan = { format: 1, steps: [...plan().steps, step('d', ['c'], { when: [{ step: 'c', state: 'skipped' }] })] };
    const f = facts([
      fact('a', { settled: DONE('k_a', 4), result: RESULT }),
      fact('b', { row: 'skipped', skippedBy: 'when', settled: { how: 'skipped', taskId: null, eventId: 4 } }),
      fact('c', { row: 'skipped', skippedBy: 'when', settled: { how: 'skipped', taskId: null, eventId: 4 } }),
      fact('d', { row: 'waiting' }),
    ]);
    expect(decide(p, f)).toEqual([{ step: 'd', outcome: 'made', parents: ['k_a'], why: 'c is skipped' }]);
    expect(effectiveParents(p, f, ['c'])).toEqual(['k_a']);
  });

  it('skips by archive a step whose parents were all archived undone, settles a skipped step so, and decides by the others when some are done', () => {
    const two: Plan = { format: 1, steps: [step('a'), step('x'), step('b', ['a', 'x'])] };
    const archived = { how: 'archived' as const, taskId: null, eventId: 5 };
    expect(decide(two, facts([fact('a', { settled: archived }), fact('x', { settled: { ...archived, eventId: 6 } }), fact('b', { row: 'waiting' })]))).toEqual([
      { step: 'b', outcome: 'skipped', by: 'archive', why: 'its parents were archived' },
    ]);
    expect(decide(two, facts([fact('a', { settled: archived }), fact('x', { settled: DONE('k_x', 6) }), fact('b', { row: 'waiting' })]))).toEqual([
      { step: 'b', outcome: 'made', parents: ['k_x'], why: 'its parents are settled' },
    ]);
    // A step skipped by its when whose parents all count as skipped by archive counts so itself.
    expect(decide(two, facts([fact('a', { settled: archived }), fact('x', { settled: { ...archived, eventId: 6 } }), fact('b', { row: 'skipped', skippedBy: 'when' })]))).toEqual([
      { step: 'b', outcome: 'settled', how: 'archived', eventId: 6 },
    ]);
  });

  it('links a done parent archived later, and never a parent read by a true blocked or gave_up clause', () => {
    expect(decideB([{ step: 'a', state: 'done' }], { result: RESULT })).toEqual([{ step: 'b', outcome: 'made', parents: ['k_a'], why: 'a is done' }]);
    const stuck = decide(plan([{ step: 'a', state: 'gave_up' }]), facts([fact('a', { entered: { blocked: false, gaveUp: true } }), fact('b', { row: 'waiting' }), fact('c', { row: 'waiting' })]));
    expect(stuck).toEqual([{ step: 'b', outcome: 'made', parents: [], why: 'a gave up' }]);
  });

  it('decides a clause on a grandparent once it settles, and makes the step only once its parents are', () => {
    const p = plan(undefined, [{ step: 'a', output: 'go', is: true }]);
    expect(decide(p, facts([fact('a'), fact('b', { row: 'made' }), fact('c', { row: 'waiting' })]))).toEqual([]);
    expect(decide(p, facts([fact('a', { settled: DONE('k_a', 4), result: RESULT }), fact('b', { row: 'made' }), fact('c', { row: 'waiting' })]))).toEqual([]);
    expect(decide(p, facts([fact('a', { settled: DONE('k_a', 4), result: RESULT }), fact('b', { row: 'made', settled: DONE('k_b', 8) }), fact('c', { row: 'waiting' })]))).toEqual([
      { step: 'c', outcome: 'made', parents: ['k_b'], why: 'a.go is true' },
    ]);
  });

  it('decides a step once: a made or skipped row is never decided again', () => {
    expect(decide(plan([{ step: 'a', state: 'blocked' }]), facts([fact('a', { settled: DONE('k_a', 9) }), fact('b', { row: 'made' }), fact('c', { row: 'made' })]))).toEqual([]);
  });

  it('skips a step whose making would pass the cap, counting what this decision made', () => {
    const two: Plan = { format: 1, steps: [step('a'), step('b', ['a']), step('c', ['a'])] };
    const f = (members: number) => facts([fact('a', { settled: DONE('k_a', 4) }), fact('b', { row: 'waiting' }), fact('c', { row: 'waiting' })], members);
    expect(decide(two, f(498)).map((d) => d.outcome)).toEqual(['made', 'made']);
    expect(decide(two, f(499))).toEqual([
      { step: 'b', outcome: 'made', parents: ['k_a'], why: 'its parents are settled' },
      { step: 'c', outcome: 'skipped', by: 'cap', why: 'the instance has 500 tasks' },
    ]);
  });
});
```

- [ ] **Step 11.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-decide.test.ts`. Expected: `Tests  13 failed (13)`, the first as `TypeError: (0 , decide) is not a function`.

- [ ] **Step 11.3: Implement.**

In `src/kanban/routing.ts`, replace:

```ts
  return undefined;
}
```

with:

```ts
  return undefined;
}

// ---------------------------------------------------------------------------
// decide(plan, facts) (§10)
// ---------------------------------------------------------------------------

/** The instance's most tasks, handlers included (§9.4, §19). */
export const INSTANCE_CAP = 500;

/** At most this many routes a routed task, counting only those made (§5.3). */
export const ROUTES_PER_TASK = 3;

/** A member's settling, as decide reads it: how, its winner, and the fact that settled it. */
export interface SettledFact {
  how: SettledHow;
  taskId: string | null;
  eventId: number;
}

/** One step, as the writer read it inside its transaction (§9.2 step 3). */
export interface StepFact {
  step: string;
  /** A pending step's row; null for a plain step or a handler. */
  row: PendingState | null;
  /** Why its row was skipped, when it was. */
  skippedBy: SkippedBy | null;
  /** The step's own settled row: its one member's, or a fan-out's own. */
  settled: SettledFact | null;
  /** A fan-out's item rows, by ref. */
  items: ReadonlyMap<string, SettledFact>;
  /** Whether its task entered `blocked` from its work, ever, by `on_blocked`'s or `on_gave_up`'s triggers (§3.2, §5.1). */
  entered: { blocked: boolean; gaveUp: boolean };
  /** Its settled winner's accepted metadata, as stored; null with no accepted result. */
  result: Readonly<Record<string, unknown>> | null;
}

/** A trigger event of a member's task, a route due for it (§5.1, §5.3). */
export interface RouteFact {
  taskId: string;
  step: string;
  ref: string;
  item: string | null;
  eventId: number;
  /** By §5.1's table, from the event: `blocked` routes by `on_blocked`, `gave_up` by `on_gave_up`. */
  kind: 'blocked' | 'gave_up';
  /** The transient limit's block, a `gave_up` the board's throttling stopped (§5.3's wording). */
  throttled: boolean;
  /** The block's reason, as the event recorded it. */
  reason: string;
  /** The routes made from the task so far (§5.3). */
  routes: number;
}

/** What decide reads (§10). */
export interface Facts {
  steps: ReadonlyMap<string, StepFact>;
  due: readonly RouteFact[];
  /** The instance's members, handlers included. */
  members: number;
  cap: number;
}

/** What decide finds due now (§10); waiting is the absence of a decision. */
export type Decision =
  | { step: string; outcome: 'made'; parents: string[]; why: string }
  | { step: string; outcome: 'skipped'; by: SkippedBy; why: string }
  | { step: string; outcome: 'fanned_out'; items: string[]; parents: string[]; why: string }
  | { step: string; outcome: 'settled'; how: 'skipped' | 'archived'; eventId: number }
  | { step: string; outcome: 'route'; handler: string; from: RouteFact; standsIn: boolean }
  | { step: string; outcome: 'over_limit' | 'over_cap'; handler: string; from: RouteFact };

type Truth = 'true' | 'false' | 'undecided';

/** A value as a reason says it: text as given, numbers and booleans as JSON writes them, a list as its items. */
export function valueSaid(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => valueSaid(v)).join(', ');
  return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
}

/** Whether a stored value is of its declared type (§2.3): anything else reads as missing. */
export function ofType(t: OutputType | undefined, value: unknown): boolean {
  if (t === undefined) return false;
  const scalar = (s: ScalarType, v: unknown): boolean => {
    if (s === 'boolean') return typeof v === 'boolean';
    if (s === 'number') return typeof v === 'number' && Number.isFinite(v);
    if (s === 'string') return typeof v === 'string';
    return typeof v === 'string' && s.enum.includes(v);
  };
  if (typeof t === 'object' && 'list' in t) return Array.isArray(value) && value.length <= t.max && value.every((v) => scalar(t.list, v));
  return scalar(t, value);
}

/** Whether a settled row is an accepted result (§2.3): its own task's or a stand-in's completion. */
function accepted(s: SettledFact | null): boolean {
  return s !== null && (s.how === 'done' || s.how === 'stood_in');
}

/** A step's accepted value of one output, of its declared type; undefined for none (§2.3, §3). */
export function resultOf(plan: Plan, facts: Facts, step: string, output: string): unknown {
  const fact = facts.steps.get(step);
  if (fact === undefined || !accepted(fact.settled) || fact.result === null) return undefined;
  const value = fact.result[output];
  const type = plan.steps.find((s) => s.step === step)?.outputs[output];
  return ofType(type, value) ? value : undefined;
}

/** One clause, as the facts decide it now (§3.1, §3.2), and why it is false when it is. */
function clause(plan: Plan, facts: Facts, c: Clause): { truth: Truth; why: string } {
  const fact = facts.steps.get(c.step);
  // A step decide does not know is unsettled: never an exception (§10).
  if (fact === undefined) return { truth: 'undecided', why: '' };
  const settled = fact.settled;
  if ('state' in c) {
    if (c.state === 'blocked' || c.state === 'gave_up') {
      const entered = c.state === 'blocked' ? fact.entered.blocked : fact.entered.gaveUp;
      if (entered) return { truth: 'true', why: '' };
      return settled === null ? { truth: 'undecided', why: '' } : { truth: 'false', why: c.state === 'blocked' ? `${c.step} did not block` : `${c.step} did not give up` };
    }
    if (settled === null) return { truth: 'undecided', why: '' };
    const done = accepted(settled);
    if (c.state === 'done') return done ? { truth: 'true', why: '' } : { truth: 'false', why: `${c.step} was ${settled.how === 'archived' ? 'archived' : 'skipped'}` };
    return done ? { truth: 'false', why: `${c.step} is done` } : { truth: 'true', why: '' };
  }
  if (settled === null) return { truth: 'undecided', why: '' };
  if (!accepted(settled)) return { truth: 'false', why: `${c.step} was ${settled.how === 'archived' ? 'archived' : 'skipped'}` };
  const ref = `${c.step}.${c.output}`;
  const value = resultOf(plan, facts, c.step, c.output);
  if (value === undefined) return { truth: 'false', why: `${ref} is missing` };
  const why = `${ref} is ${valueSaid(value)}`;
  let holds: boolean;
  if ('equals' in c) holds = value === c.equals;
  else if ('in' in c) holds = c.in.includes(value as ClauseValue);
  else if ('is' in c) holds = value === c.is;
  else if ('at_least' in c) holds = typeof value === 'number' && value >= c.at_least;
  else holds = typeof value === 'number' && value <= c.at_most;
  return holds ? { truth: 'true', why: '' } : { truth: 'false', why };
}

/** A step's `when`, decided now (§3.2): certainly false at its first false clause, true once every clause holds. */
function when(plan: Plan, facts: Facts, items: readonly WhenItem[] | undefined): { truth: Truth; why: string } {
  if (items === undefined) return { truth: 'true', why: '' };
  let undecided = false;
  for (const item of items) {
    if ('any' in item) {
      const each = item.any.map((c) => clause(plan, facts, c));
      if (each.some((r) => r.truth === 'true')) continue;
      if (each.every((r) => r.truth === 'false')) return { truth: 'false', why: each[0]?.why ?? '' };
      undecided = true;
      continue;
    }
    const r = clause(plan, facts, item);
    if (r.truth === 'false') return r;
    if (r.truth === 'undecided') undecided = true;
  }
  return undecided ? { truth: 'undecided', why: '' } : { truth: 'true', why: '' };
}

/** The steps a `when` reads by a `state: blocked` or `state: gave_up` clause that holds now: not waited for, not linked (§3.2). */
function stuckParents(facts: Facts, items: readonly WhenItem[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const item of items ?? []) {
    for (const c of 'any' in item ? item.any : [item]) {
      if (!('state' in c) || (c.state !== 'blocked' && c.state !== 'gave_up')) continue;
      const f = facts.steps.get(c.step);
      if (f !== undefined && (c.state === 'blocked' ? f.entered.blocked : f.entered.gaveUp)) out.add(c.step);
    }
  }
  return out;
}

/**
 * A step's effective parents (§3.2), as task ids: a done step's winning task, a
 * fan-out's items' winners, none archived undone; a step skipped otherwise, its
 * own effective parents, recursively; a step skipped by archive, none.
 */
export function effectiveParents(plan: Plan, facts: Facts, steps: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const fact = facts.steps.get(name);
    const settled = fact?.settled ?? null;
    if (fact === undefined || settled === null || settled.how === 'archived') return;
    if (settled.how === 'skipped') {
      for (const p of plan.steps.find((s) => s.step === name)?.parents ?? []) walk(p);
      return;
    }
    const winners = fact.items.size > 0 ? [...fact.items.values()].filter(accepted).map((i) => i.taskId) : [settled.taskId];
    for (const id of winners) if (id !== null && !out.includes(id)) out.push(id);
  };
  for (const s of steps) walk(s);
  return out;
}

/** The greatest event id of the steps' settled rows: the settling that let a skipped step count (§8). */
function latestOf(facts: Facts, steps: readonly string[]): number {
  return steps.reduce((most, s) => Math.max(most, facts.steps.get(s)?.settled?.eventId ?? 0), 0);
}

/** How many tasks a pending step's making is: its list param's items, or one. */
function tasksOf(s: PlanStep): number {
  return s.templates?.length ?? 1;
}

/**
 * What is due now (§10), in the plan's order: each waiting step decided once its
 * `when` is certain, made once its parents are settled, or skipped; each skipped
 * step settled once its parents are. Pure and total: a missing result, a value of
 * the wrong type, an unknown step read as false or unsettled, never thrown.
 */
export function decide(plan: Plan, facts: Facts): Decision[] {
  const out: Decision[] = [];
  let members = facts.members;
  for (const s of plan.steps) {
    const fact = facts.steps.get(s.step);
    if (fact === undefined) continue;
    if (fact.row === 'skipped' && fact.settled === null) {
      if (!s.parents.every((p) => facts.steps.get(p)?.settled != null)) continue;
      const archived = fact.skippedBy === 'archive' || (s.parents.length > 0 && s.parents.every((p) => facts.steps.get(p)?.settled?.how === 'archived'));
      out.push({ step: s.step, outcome: 'settled', how: archived ? 'archived' : 'skipped', eventId: latestOf(facts, s.parents) });
      continue;
    }
    if (fact.row !== 'waiting') continue;
    const w = when(plan, facts, s.when);
    if (w.truth === 'undecided') continue;
    if (w.truth === 'false') {
      out.push({ step: s.step, outcome: 'skipped', by: 'when', why: w.why });
      continue;
    }
    const stuck = stuckParents(facts, s.when);
    const waited = s.parents.filter((p) => !stuck.has(p));
    if (!waited.every((p) => facts.steps.get(p)?.settled != null)) continue;
    if (waited.length > 0 && waited.every((p) => facts.steps.get(p)?.settled?.how === 'archived')) {
      out.push({ step: s.step, outcome: 'skipped', by: 'archive', why: 'its parents were archived' });
      continue;
    }
    const why = s.when === undefined ? 'its parents are settled' : whenText(s.when);
    const parents = effectiveParents(plan, facts, waited);
    const count = tasksOf(s);
    if (members + count > facts.cap) {
      out.push({ step: s.step, outcome: 'skipped', by: 'cap', why: `the instance has ${facts.cap} tasks` });
      continue;
    }
    members += count;
    if (s.templates !== undefined) out.push({ step: s.step, outcome: 'fanned_out', items: s.templates.map((t) => t.item), parents, why });
    else out.push({ step: s.step, outcome: 'made', parents, why });
  }
  return out;
}
```

- [ ] **Step 11.4: Run them to verify they pass.** Run the same command. Expected: `Tests  13 passed (13)`.

- [ ] **Step 11.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3644 passed (3644)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 11.6: Commit.**

```bash
git add src/kanban/routing.ts tests/routing-decide.test.ts
git commit -m "Decide a routed instance's waiting steps from its facts: every clause and state, skipping, settling once the parents are, the effective parents and the cap"
```

---

### Task 12: The writer settles and skips in the settling transactions

**Files:**

- Create: `tests/routing-sweep.test.ts`
- Modify: `src/db/kanban-read.ts`, `src/db/kanban.ts`, `src/kanban/routing.ts`, `tests/helpers/routing.ts`

§9.1, §9.2. `routeAfter` runs in `complete` when the task becomes done, in `archive`, in a run's `block` from its work and in `endRun` when the task blocks from its work: the sweep writes each member's settled row, the facts are read, and each decision applied, a skip in its pending row; and one `workflow_routed` event lists the decisions. No other transition decides anything: a review request, a person's block, a stop, an unblock, changes asked, an assign. Until Task 13 a step whose parents are settled waits.

- [ ] **Step 12.1: Write the tests.**

In `tests/helpers/routing.ts`, replace:

```ts
import type { TestDb } from './db.js';
```

with:

```ts
import { ManualClock, type TestDb } from './db.js';
```

In `tests/helpers/routing.ts`, replace:

```ts
    workflowsDir: dir,
```

with:

```ts
    workflowsDir: dir,
    clock: new ManualClock(1_760_000_000_000),
```

Create `tests/routing-sweep.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, membersOf, pendingOf, settledOf } from '../src/db/kanban-read.js';
import type { WorkflowMade } from '../src/kanban/service.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * The writer's sweep and its hooks (workflow routing spec §8, §9.1, §9.2): a
 * completion and an archive write each member's settled row, its winner the
 * earliest settling fact, and decide what is due in their transaction, here the
 * skips and the settlings, said in one workflow_routed event; a run's block and
 * its give-up decide too; and the transitions that change nothing a step reads,
 * a review request, a person's block, a stop, an unblock, changes asked and an
 * assign, decide nothing.
 */

const FLOW = `board: vi
steps:
  intake:
    title: intake
    assignee: vi-coordinator
    outputs:
      kind: { enum: [cve, supplychain] }
      verify: boolean
  va:
    title: va
    assignee: vulnerability-analyst
    parents: [intake]
    when:
      - { step: intake, output: kind, equals: cve }
  verify:
    title: verify
    assignee: verifier
    parents: [va]
    when:
      - { step: intake, output: verify, is: true }
  help:
    title: help
    assignee: verifier
    parents: [va]
    when:
      - { step: va, state: gave_up }
`;

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  b = viBoard(h);
  writeFileSync(join(b.dir, 'flow.yaml'), FLOW);
});
afterEach(() => h.close());

function start(file = FLOW): WorkflowMade {
  writeFileSync(join(b.dir, 'flow.yaml'), file);
  return madeOf(b.service.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
}

const routed = (taskId: string) => eventsOf(h.db, taskId).filter((e) => e.kind === 'workflow_routed').map((e) => e.payload as Record<string, unknown>);

describe("the writer's sweep", () => {
  it("settles a plain member at its completion and skips, in its transaction, every step whose when is false, settling each once its parents are", async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    const run = claimed(h.db, intake);
    expect((await b.service.complete(intake, { kind: 'run', runId: run.runId }, { summary: 'x', metadata: { kind: 'supplychain', verify: false } })).ok).toBe(true);
    const completed = eventsOf(h.db, intake).find((e) => e.kind === 'completed')?.id;
    expect(settledOf(h.db, w.instance.instanceId).map((s) => [s.step, s.how, s.taskId, s.eventId])).toEqual([
      ['help', 'skipped', null, completed],
      ['intake', 'done', intake, completed],
      ['va', 'skipped', null, completed],
      ['verify', 'skipped', null, completed],
    ]);
    expect(routed(intake)).toEqual([
      {
        workflow: w.instance.instanceId,
        workflowName: 'flow',
        step: 'intake',
        cause: 'completed',
        decisions: [
          { step: 'va', outcome: 'skipped', why: 'intake.kind is supplychain', taskIds: [], by: 'when' },
          { step: 'verify', outcome: 'skipped', why: 'intake.verify is false', taskIds: [], by: 'when' },
          { step: 'help', outcome: 'skipped', why: 'va did not give up', taskIds: [], by: 'when' },
        ],
      },
    ]);
    expect(pendingOf(h.db, w.instance.instanceId).find((p) => p.step === 'va')).toMatchObject({ state: 'skipped', causeEvent: completed, decidedAt: NOW });
  });

  it("skips by archive every step below a root archived undone, in the archive's transaction", () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    expect(b.service.archive(intake, ALICE).ok).toBe(true);
    expect(membersOf(h.db, w.instance.instanceId).length).toBe(1);
    expect(settledOf(h.db, w.instance.instanceId).map((s) => [s.step, s.how])).toEqual([
      ['help', 'archived'],
      ['intake', 'archived'],
      ['va', 'archived'],
      ['verify', 'archived'],
    ]);
    expect(routed(intake)[0]).toMatchObject({ cause: 'archived' });
    expect((routed(intake)[0]?.['decisions'] as unknown[]).length).toBe(3);
  });

  it('decides nothing at a review request, a person\'s block, a stop, an unblock, changes asked or an assign', async () => {
    const w = start(FLOW.replace('    assignee: vi-coordinator\n', '    assignee: vi-coordinator\n    reviewer: verifier\n'));
    const intake = w.tasks[0]?.taskId ?? '';
    const nothing = () => {
      expect(routed(intake)).toEqual([]);
      expect(settledOf(h.db, w.instance.instanceId)).toEqual([]);
      expect(membersOf(h.db, w.instance.instanceId).length).toBe(1);
      expect(pendingOf(h.db, w.instance.instanceId).every((p) => p.state === 'waiting')).toBe(true);
    };
    const run = claimed(h.db, intake);
    expect(b.service.stop(intake, ALICE).ok).toBe(true);
    closeRun(h.db, run.runId, NOW);
    nothing();
    expect(b.service.unblock(intake, ALICE).ok).toBe(true);
    expect(b.service.block(intake, { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason: 'wait' }).ok).toBe(true);
    expect(b.service.unblock(intake, ALICE).ok).toBe(true);
    expect(b.service.assign(intake, 'verifier', ALICE).ok).toBe(true);
    expect(b.service.assign(intake, 'vi-coordinator', ALICE).ok).toBe(true);
    nothing();
    const work = claimed(h.db, intake);
    expect(await b.service.requestReview(intake, { kind: 'run', runId: work.runId }, { summary: 'x', metadata: { kind: 'cve', verify: true } })).toMatchObject({ ok: true, task: { phase: 'review' } });
    closeRun(h.db, work.runId, NOW);
    nothing();
    const review = claimed(h.db, intake);
    expect(b.service.requestChanges(intake, { kind: 'run', runId: review.runId }, 'say why').ok).toBe(true);
    closeRun(h.db, review.runId, NOW);
    nothing();
  });
});
```

- [ ] **Step 12.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-sweep.test.ts`. Expected: `Tests  2 failed | 1 passed (3)`, the first as `AssertionError: expected [] to deeply equal [ Array(4) ]`.

- [ ] **Step 12.3: Implement.**

In `src/db/kanban-read.ts`, replace:

```ts

/** One Unblock button of a recorded message, and the `unblocked` or `archived` event that lifted its block, if one has. */
```

with:

```ts

/**
 * A trigger event (workflow routing spec §5.1): what blocked a task from its work
 * by a run, read from the event, never from the task's `block_kind`. A run's own
 * `blocked`, of a kind but `dependency`, and a run's end that blocked it are
 * `blocked`, routed by `on_blocked`; the breaker's give-up and the transient
 * limit's block, the board's terminal failure endings, are `gave_up`, routed by
 * `on_gave_up`, the transient limit's `throttled`.
 */
export interface TriggerEvent {
  eventId: number;
  kind: 'blocked' | 'gave_up';
  throttled: boolean;
  reason: string;
}

/**
 * A task's trigger events, oldest first (§5.1): only a work run's, so a review's
 * block, a person's block or stop, and the gateway's own block of a task the
 * team check refused route nothing and enter no state a clause reads.
 */
export function triggersOf(db: Db, taskId: string): TriggerEvent[] {
  const rows = db
    .prepare<[string], EventRaw & { run_kind: string | null }>(
      `SELECT e.id, e.task_id, e.run_id, e.kind, e.actor, json(e.payload) AS payload, e.created_at, r.kind AS run_kind
         FROM kanban_events e JOIN kanban_runs r ON r.run_id = e.run_id
        WHERE e.task_id = ? AND (e.kind = 'blocked' OR (e.kind = 'run_ended' AND json_extract(e.payload, '$.next') = 'blocked'))
        ORDER BY e.id`,
    )
    .all(taskId);
  return rows.flatMap((r): TriggerEvent[] => {
    if (r.run_kind !== 'work') return [];
    const p = json(r.payload) as Record<string, unknown>;
    const text = (key: string): string => (typeof p[key] === 'string' ? (p[key] as string) : '');
    if (r.kind === 'blocked') {
      if (!r.actor.startsWith('run:') || text('kind') === '' || text('kind') === 'dependency') return [];
      return [{ eventId: r.id, kind: 'blocked', throttled: false, reason: text('reason') }];
    }
    const kind = text('blockKind');
    const gaveUp = kind === 'gave_up' || kind === 'transient';
    return [{ eventId: r.id, kind: gaveUp ? 'gave_up' : 'blocked', throttled: kind === 'transient', reason: text('blockReason') }];
  });
}

/** A task's first event of a kind, with its payload; undefined for none. */
export function firstEventOf(db: Db, taskId: string, kind: string): KanbanEvent | undefined {
  const row = db
    .prepare<[string, string], EventRaw>(
      `SELECT id, task_id, run_id, kind, actor, json(payload) AS payload, created_at FROM kanban_events WHERE task_id = ? AND kind = ? ORDER BY id LIMIT 1`,
    )
    .get(taskId, kind);
  return row === undefined ? undefined : decodeEvent(row);
}

/** One Unblock button of a recorded message, and the `unblocked` or `archived` event that lifted its block, if one has. */
```

In `src/db/kanban.ts`, replace:

```ts
import { maskPlan, type Plan } from '../kanban/routing.js';
```

with:

```ts
import { decide as decideRouting, INSTANCE_CAP, maskPlan, type Decision, type Facts, type Plan, type StepFact } from '../kanban/routing.js';
```

In `src/db/kanban.ts`, replace:

```ts
import { assignable, checkTask, type TaskFacts } from '../kanban/task-checks.js';
```

with:

```ts
import { assignable, checkTask, isRecord, type TaskFacts } from '../kanban/task-checks.js';
```

In `src/db/kanban.ts`, replace:

```ts
  gatesOf,
```

with:

```ts
  gatesOf,
  firstEventOf,
  latestCompletion,
  pendingOf,
  plannedMemberOf,
  settledOf,
  triggersOf,
```

In `src/db/kanban.ts`, replace:

```ts
  'from',
```

with:

```ts
  'from',
  // The task a handler was routed from, and a stand-in that archived the task it stood in for (workflow routing spec §7.4, §5.2).
  'routedFrom',
  'standIn',
```

In `src/db/kanban.ts`, replace:

```ts
): void {
  d.prepare(
    `INSERT INTO kanban_events (task_id, run_id, kind, actor, payload, created_at)
     VALUES (?, ?, ?, ?, jsonb(?), ?)`,
  ).run(e.taskId, e.runId ?? null, e.kind, e.actor, JSON.stringify(redactValues(e.payload, BOARD_KEYS)), now);
```

with:

```ts
): number {
  const { lastInsertRowid } = d
    .prepare(
      `INSERT INTO kanban_events (task_id, run_id, kind, actor, payload, created_at)
       VALUES (?, ?, ?, ?, jsonb(?), ?)`,
    )
    .run(e.taskId, e.runId ?? null, e.kind, e.actor, JSON.stringify(redactValues(e.payload, BOARD_KEYS)), now);
  return Number(lastInsertRowid);
```

In `src/db/kanban.ts`, replace:

```ts
    ).run(now, taskId);
    record(
```

with:

```ts
    ).run(now, taskId);
    const completed = record(
```

In `src/db/kanban.ts`, replace:

```ts
      },
      now,
    );
    return { ok: true, task: mustGet(d, taskId), run: r.run === undefined ? undefined : mustGetRun(d, r.run.runId) };
  });
```

with:

```ts
      },
      now,
    );
    // Done is a settling: what its plan's steps read may have changed (workflow routing spec §9.1).
    routeAfter(d, taskId, 'completed', completed, now);
    return { ok: true, task: mustGet(d, taskId), run: r.run === undefined ? undefined : mustGetRun(d, r.run.runId) };
  });
```

In `src/db/kanban.ts`, replace:

```ts
      const recurrences = enterBlocked(d, r.task, report.kind, report.reason);
      record(
```

with:

```ts
      const recurrences = enterBlocked(d, r.task, report.kind, report.reason);
      const blocked = record(
```

In `src/db/kanban.ts`, replace:

```ts
        now,
      );
    }
    return { ok: true, task: mustGet(d, taskId), run: r.run === undefined ? undefined : mustGetRun(d, r.run.runId) };
```

with:

```ts
        now,
      );
      // A run's block from its work is a trigger (workflow routing spec §5.1); a person's, or a review's, routes nothing.
      if (by.kind === 'run' && r.task.phase === 'open') routeAfter(d, taskId, 'blocked', blocked, now);
    }
    return { ok: true, task: mustGet(d, taskId), run: r.run === undefined ? undefined : mustGetRun(d, r.run.runId) };
```

In `src/db/kanban.ts`, replace:

```ts
    }
    record(
```

with:

```ts
    }
    const ended = record(
```

In `src/db/kanban.ts`, replace:

```ts
    );
    return { ok: true, task: mustGet(d, run.taskId), run: mustGetRun(d, runId), next };
```

with:

```ts
    );
    // A run's end that blocked the task from its work is a trigger (workflow routing spec §5.1).
    if (blockAs !== undefined && before.phase === 'open') {
      const cause: RouteCause = blockAs.kind === 'gave_up' ? 'gave_up' : blockAs.kind === 'transient' ? 'throttled' : 'blocked';
      routeAfter(d, run.taskId, cause, ended, now);
    }
    return { ok: true, task: mustGet(d, run.taskId), run: mustGetRun(d, runId), next };
```

In `src/db/kanban.ts`, replace:

```ts
    return { ok: true, ...archiveIn(d, task, by, now) };
```

with:

```ts
    const archived = archiveIn(d, task, by, now);
    // An archive settles: as done when it was done, or as skipped by archive (workflow routing spec §9.1).
    routeAfter(d, taskId, 'archived', archived.eventId, now);
    return { ok: true, task: mustGet(d, taskId), run: archived.run };
```

In `src/db/kanban.ts`, replace:

```ts
): { task: TaskRow; run: RunRow | undefined } {
```

with:

```ts
): { task: TaskRow; run: RunRow | undefined; eventId: number } {
```

In `src/db/kanban.ts`, replace:

```ts
  ).run(now, task.taskId);
  record(
```

with:

```ts
  ).run(now, task.taskId);
  const eventId = record(
```

In `src/db/kanban.ts`, replace:

```ts
  return { task: mustGet(d, task.taskId), run };
```

with:

```ts
  return { task: mustGet(d, task.taskId), run, eventId };
```

In `src/db/kanban.ts`, replace:

```ts
    return { ok: true, attempts: row.attempts };
  });
}
```

with:

```ts
    return { ok: true, attempts: row.attempts };
  });
}

// ---------------------------------------------------------------------------
// Workflow routing (workflow routing spec §9)
// ---------------------------------------------------------------------------


/** Which transition decided, for its notice (§12.2): a completion, a block, a give-up or the transient limit's block, an archive, or a reconciliation. */
export type RouteCause = 'completed' | 'blocked' | 'gave_up' | 'throttled' | 'archived' | 'reconciled';

/** One decision of a transaction, as `workflow_routed` lists it for its notice (§12.2). */
export interface RoutedLine {
  step: string;
  outcome: 'made' | 'skipped' | 'fanned_out';
  why: string;
  taskIds: string[];
  items?: string[];
  count?: number;
  by?: string;
}

/** An instance with a plan, as the routing reads it in its transaction: the row, the plan, and its members with their tasks. */
interface Routed {
  instance: InstanceRow;
  plan: Plan;
  members: Array<MemberRow & { task: TaskRow }>;
}

/** A step's facts, read inside the transaction (§9.2 step 3): its rows, its tasks' trigger events, and its winner's accepted result. */
function routingFacts(d: Db, r: Routed): Facts {
  const settled = settledOf(d, r.instance.instanceId);
  const pending = new Map(pendingOf(d, r.instance.instanceId).map((p) => [p.step, p]));
  const steps = new Map<string, StepFact>();
  // Only a `state` clause reads what a step's tasks entered: the others' events are not read. Every member is read,
  // settled or not, as a state clause holds for a task that entered the state ever (§3.2).
  const stated = new Set(
    r.plan.steps.flatMap((s) => (s.when ?? []).flatMap((w) => ('any' in w ? w.any : [w])).flatMap((c) => ('state' in c ? [c.step] : []))),
  );
  for (const s of r.plan.steps) {
    const own = settled.find((x) => x.step === s.step && x.ref === s.step);
    const items = new Map(settled.filter((x) => x.step === s.step && x.ref !== s.step).map((x) => [x.ref, { how: x.how, taskId: x.taskId, eventId: x.eventId }]));
    const triggers = stated.has(s.step) ? r.members.filter((m) => m.step === s.step).flatMap((m) => triggersOf(d, m.taskId)) : [];
    const row = pending.get(s.step);
    const winner = own?.taskId ?? null;
    const metadata = winner === null || (own?.how !== 'done' && own?.how !== 'stood_in') ? undefined : latestCompletion(d, winner)?.metadata;
    steps.set(s.step, {
      step: s.step,
      row: row?.state ?? null,
      skippedBy: row?.reason?.by ?? null,
      settled: own === undefined ? null : { how: own.how, taskId: own.taskId, eventId: own.eventId },
      items,
      entered: { blocked: triggers.some((t) => t.kind === 'blocked'), gaveUp: triggers.some((t) => t.kind === 'gave_up') },
      result: isRecord(metadata) ? metadata : null,
    });
  }
  return { steps, due: [], members: r.members.length, cap: INSTANCE_CAP };
}

/** Insert a settled row into its key (§8): a later attempt finds the key taken and changes nothing. True when it added the row. */
function settle(d: Db, instanceId: string, step: string, ref: string, how: string, taskId: string | null, eventId: number, now: number): boolean {
  return (
    d
      .prepare('INSERT OR IGNORE INTO kanban_workflow_settled (instance_id, step, ref, how, task_id, event_id, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(instanceId, step, ref, how, taskId, eventId, now).changes === 1
  );
}

/**
 * The sweep (§9.2 step 2): each member with a settling fact gets its settled row,
 * its winner the earliest fact by event id, its own task's `completed` event or
 * its `archived` event when that archive was not from `done`; each fan-out
 * whose items all have rows, its own, `archived` when every item was archived
 * undone. Plain steps included; a handler's task is no step's member here.
 */
function sweep(d: Db, r: Routed, now: number): void {
  const id = r.instance.instanceId;
  const handlers = new Set(r.plan.steps.filter((s) => s.handler === true).map((s) => s.step));
  const taken = new Set(settledOf(d, id).map((x) => `${x.step}\u0000${x.ref}`));
  for (const m of r.members) {
    if (handlers.has(m.step) || taken.has(`${m.step}\u0000${m.ref}`)) continue;
    const completed = firstEventOf(d, m.taskId, 'completed');
    const archived = firstEventOf(d, m.taskId, 'archived');
    const archive = archived !== undefined && isRecord(archived.payload) && archived.payload['from'] !== 'done' ? archived : undefined;
    const facts = [
      ...(completed === undefined ? [] : [{ how: 'done', taskId: m.taskId as string | null, eventId: completed.id }]),
      ...(archive === undefined ? [] : [{ how: 'archived', taskId: null, eventId: archive.id }]),
    ].sort((a, b) => a.eventId - b.eventId);
    const winner = facts[0];
    if (winner === undefined) continue;
    if (settle(d, id, m.step, m.ref, winner.how, winner.taskId, winner.eventId, now)) taken.add(`${m.step}\u0000${m.ref}`);
  }
  const pending = new Map(pendingOf(d, id).map((p) => [p.step, p]));
  for (const s of r.plan.steps) {
    if (s.for_each === undefined || taken.has(`${s.step}\u0000${s.step}`)) continue;
    if (s.made === 'decide' && pending.get(s.step)?.state !== 'made') continue;
    const items = settledOf(d, id).filter((x) => x.step === s.step && x.ref !== s.step);
    const all = r.members.filter((m) => m.step === s.step);
    if (all.length === 0 || items.length < all.length) continue;
    const how = items.every((x) => x.how === 'archived') ? 'archived' : 'done';
    settle(d, id, s.step, s.step, how, null, Math.max(...items.map((x) => x.eventId)), now);
  }
}

/** A pending row moved from `waiting`, once (§9.2): false when another attempt decided it first, and then nothing is made. */
function decided(d: Db, instanceId: string, step: string, state: 'made' | 'skipped', reason: Record<string, unknown>, causeEvent: number | null, now: number, items?: unknown): boolean {
  const masked = Object.fromEntries(Object.entries(reason).map(([k, v]) => [k, typeof v === 'string' ? mask(v) : v]));
  return (
    d
      .prepare(
        `UPDATE kanban_workflow_pending SET state = ?, reason = ?, items = ?, cause_event = ?, decided_at = ?
          WHERE instance_id = ? AND step = ? AND state = 'waiting'`,
      )
      .run(state, JSON.stringify(masked), items === undefined ? null : JSON.stringify(items), causeEvent, now, instanceId, step).changes === 1
  );
}

/** One decision applied (§9.2 step 4); answers its line for the notice, or undefined for one that is none. */
function apply(d: Db, r: Routed, dec: Decision, causeEvent: number | null, now: number): RoutedLine | undefined {
  const id = r.instance.instanceId;
  const s = r.plan.steps.find((x) => x.step === dec.step);
  if (s === undefined) return undefined;
  if (dec.outcome === 'settled') {
    settle(d, id, dec.step, dec.step, dec.how, null, dec.eventId, now);
    return undefined;
  }
  if (dec.outcome === 'skipped') {
    return decided(d, id, dec.step, 'skipped', { by: dec.by, why: dec.why }, causeEvent, now) ? { step: dec.step, outcome: 'skipped', why: dec.why, taskIds: [], by: dec.by } : undefined;
  }
  // A step to make waits: only skips and settlings are applied yet.
  return undefined;
}

/** An instance with a plan, its members read now. */
function routedOf(d: Db, instance: InstanceRow): Routed | undefined {
  return instance.plan === null ? undefined : { instance, plan: instance.plan, members: membersWithTasks(d, instance.instanceId) };
}

/**
 * Decide what is due, until nothing more is (§9.2 steps 2 to 5): the sweep, the
 * facts, `decide`, each decision applied, again on the new facts, at most once a
 * step of the plan; answers the lines of every decision made.
 */
function decideAll(d: Db, instance: InstanceRow, causeEvent: number | null, now: number): RoutedLine[] {
  const lines: RoutedLine[] = [];
  const first = routedOf(d, instance);
  if (first === undefined) return lines;
  for (let round = 0; round <= first.plan.steps.length; round += 1) {
    const r = routedOf(d, instance) as Routed;
    sweep(d, r, now);
    const facts = routingFacts(d, r);
    const decisions = decideRouting(r.plan, facts);
    if (decisions.length === 0) break;
    for (const dec of decisions) {
      const line = apply(d, r, dec, causeEvent, now);
      if (line !== undefined) lines.push(line);
    }
  }
  return lines;
}

/**
 * The routing of a transition (§9.2), inside its transaction, after its own rows
 * and event: one read finds the task's member row and its instance's plan, and a
 * task that is no member of an instance with a plan pays nothing more; then what
 * is due is decided, and one `workflow_routed` event on the task lists the
 * decisions, for the notice.
 */
function routeAfter(d: Db, taskId: string, cause: RouteCause, eventId: number, now: number): void {
  const planned = plannedMemberOf(d, taskId);
  if (planned === undefined) return;
  const lines = decideAll(d, planned.instance, eventId, now);
  if (lines.length === 0) return;
  record(
    d,
    {
      taskId,
      kind: 'workflow_routed',
      actor: 'gateway',
      payload: { workflow: planned.instance.instanceId, workflowName: planned.instance.name, step: planned.member.step, cause, decisions: lines },
    },
    now,
  );
}
```

In `src/kanban/routing.ts`, replace:

```ts
    if (fact.row !== 'waiting') continue;
```

with:

```ts
    if (fact.row !== 'waiting') continue;
    // A fan-out over a result waits: this build does not yet read its source's list.
    if (s.for_each !== undefined && 'step' in s.for_each) continue;
```

- [ ] **Step 12.4: Run them to verify they pass.** Run the same command. Expected: `Tests  3 passed (3)`.

- [ ] **Step 12.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3647 passed (3647)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 12.6: Commit.**

```bash
git add src/db/kanban-read.ts src/db/kanban.ts src/kanban/routing.ts tests/helpers/routing.ts tests/routing-sweep.test.ts
git commit -m "Settle each member of a routed instance in the transaction of its completion or archive, and of a run's block and give-up, skipping the steps whose when is false"
```

---

### Task 13: The writer makes a step late

**Files:**

- Create: `tests/routing-worktree-base.test.ts`, `tests/routing-writer.test.ts`
- Modify: `src/db/WRITERS.md`, `src/db/kanban.ts`

§3.2, §7.4. A step made is made through `insertTask` as the start would have: its title and body filled from the results and cut, its links to its effective parents, past a skipped step and to a parent done and then archived, its first member's subscriptions, its gates, its member row and its `created` event. Its worktree, in an isolated workspace, starts from its effective parents' branches, and leaves out an archived parent's. Until Task 19, a step over a result's list waits.

- [ ] **Step 13.1: Write the tests.**

Create `tests/routing-worktree-base.test.ts`:

```ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { getTask, membersOf } from '../src/db/kanban-read.js';
import { registerWorktree } from '../src/db/workspaces.js';
import { TaskDirectories, type GitResult, type GitRunner } from '../src/kanban/worktree.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA } from './helpers/kanban.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * Where a step made late starts in an isolated workspace (workflow routing spec
 * §3.2, kanban spec §18.5): from the branches of its effective parents, past a
 * skipped step; a parent done and then archived keeps its link and its
 * handoff, not its branch. Against a stand-in for git that answers what the
 * board asks and records it.
 */

const FLOW = `board: vi
steps:
  a:
    title: a
    assignee: vi-coordinator
    workspace: vi
    outputs: { go: boolean }
  b:
    title: b
    assignee: verifier
    workspace: vi
  s:
    title: s
    assignee: verifier
    workspace: vi
    parents: [a]
    when: [{ step: a, output: go, is: false }]
  c:
    title: c
    assignee: verifier
    workspace: vi
    parents: [s, b]
`;

let dir: string;
let base: string;
let root: string;
let h: TestDb;
let b: ViBoard;
let asked: string[][];
let refs: Map<string, string>;
let addedAt: string | undefined;

const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });
const no = (): GitResult => ({ code: 1, stdout: '', stderr: '' });

const git: GitRunner = async (args, opts) => {
  asked.push([...args]);
  const [verb, ...rest] = args;
  if (verb === 'rev-parse' && rest[0] === '--git-common-dir') return ok('.git');
  if (verb === 'rev-parse' && rest[0] === '--verify') {
    const commit = refs.get((rest.at(-1) ?? '').replace(/\^\{commit\}$/, ''));
    return commit === undefined ? no() : ok(commit);
  }
  if (verb === 'worktree' && rest[0] === 'add') {
    addedAt = rest.at(-1);
    mkdirSync(rest.find((a) => a.startsWith(root)) ?? '', { recursive: true });
    return ok();
  }
  if (verb === 'worktree' && rest[0] === 'list') return ok('');
  if (verb === 'symbolic-ref') return ok(`refs/heads/mt/${opts.cwd.split('/').at(-1) ?? ''}`);
  // Only the commit the worktree was added at is in it already: every other parent's branch is merged.
  if (verb === 'merge-base') return refs.get(rest[1] ?? '') === addedAt ? ok() : no();
  if (verb === 'merge') return ok();
  throw new Error(`unexpected git ${args.join(' ')}`);
};

beforeEach(() => {
  clearSecrets();
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-routed-base-')));
  base = join(dir, 'vi');
  mkdirSync(join(base, '.git'), { recursive: true });
  root = join(dir, 'worktrees');
  asked = [];
  refs = new Map([['HEAD', 'b'.repeat(40)]]);
  h = testDb();
  b = viBoard(h, { isolated: new Set(['vi']) });
  writeFileSync(join(b.dir, 'flow.yaml'), FLOW);
});
afterEach(() => {
  h.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A task done in its own worktree, on its branch at `commit`. */
async function doneOnBranch(taskId: string, commit: string, metadata: Record<string, unknown>): Promise<void> {
  const claim = b.service.claim(taskId);
  if (!claim.ok) throw new Error(claim.message);
  const run = claim.run;
  const id = getTask(h.db, taskId)?.worktree ?? '';
  registerWorktree(h.db, { id, kind: 'git-worktree', rootPath: join(root, 'vi', taskId), repoRoot: base, branch: `mt/${taskId}` }, NOW);
  refs.set(`refs/heads/mt/${taskId}`, commit);
  const r = await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'did it', metadata });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  closeRun(h.db, run.runId, NOW);
}

/** Where the task's worktree starts at its claim: the commit it is added at, and the branches merged into it. */
async function startFrom(taskId: string): Promise<{ from: string | undefined; merged: string[] }> {
  const claim = b.service.claim(taskId);
  if (!claim.ok) throw new Error(claim.message);
  const task = getTask(h.db, taskId);
  if (task === undefined) throw new Error('no task');
  asked = [];
  const d = new TaskDirectories({ db: h.db, root, workspaceDirs: new Map([['vi', base]]), isolated: { vi: {} }, env: {}, git });
  const r = await d.prepare(task);
  if (!r.ok) throw new Error(JSON.stringify(r));
  return { from: asked.find((a) => a[0] === 'worktree' && a[1] === 'add')?.at(-1), merged: asked.filter((a) => a[0] === 'merge').map((a) => a.at(-1) ?? '') };
}

describe("a late step's worktree", () => {
  it("starts from its effective parents' branches, past a skipped step", async () => {
    const w = madeOf(b.service.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
    const [a, bb] = [w.tasks[0]?.taskId ?? '', w.tasks[1]?.taskId ?? ''];
    await doneOnBranch(a, 'a'.repeat(40), { go: true });
    await doneOnBranch(bb, 'c'.repeat(40), {});
    const c = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'c')?.taskId ?? '';
    expect(await startFrom(c)).toEqual({ from: 'a'.repeat(40), merged: [`refs/heads/mt/${bb}`] });
  });

  it('leaves out the branch of a parent done and then archived', async () => {
    const w = madeOf(b.service.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
    const [a, bb] = [w.tasks[0]?.taskId ?? '', w.tasks[1]?.taskId ?? ''];
    await doneOnBranch(a, 'a'.repeat(40), { go: true });
    expect(b.service.archive(a, ALICE).ok).toBe(true);
    await doneOnBranch(bb, 'c'.repeat(40), {});
    const c = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'c')?.taskId ?? '';
    expect(await startFrom(c)).toEqual({ from: 'c'.repeat(40), merged: [] });
  });
});
```

Create `tests/routing-writer.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, gatesOf, getTask, membersOf, parentsOf, pendingOf, settledOf, subscriptionsOf } from '../src/db/kanban-read.js';
import type { WorkflowMade } from '../src/kanban/service.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { briefFor } from '../src/kanban/brief.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * The writer deciding inside the settling transaction (workflow routing spec §9):
 * a completion, an archive, a run's block and a give-up each decide what is now
 * due, making a step's task as the start would have, linked to its effective
 * parents, its references filled, its first member's subscriptions copied, its
 * gates, member row and created event; skipping, and settling once the parents
 * are; and one workflow_routed event listing the decisions. A parent done and
 * then archived is still a done parent, linked, its result read and its handoff
 * in the brief; a reviewed result is the work run's that was approved last.
 */

const PAIR = `board: vi
steps:
  a:
    title: a
    assignee: vi-coordinator
    outputs: { go: boolean }
  b:
    title: b
    assignee: verifier
  c:
    title: c
    assignee: verifier
    parents: [a, b]
    when: [{ step: a, output: go, is: true }]
`;

const REVIEWED = `board: vi
steps:
  a:
    title: a
    assignee: vi-coordinator
    reviewer: { role: verifier }
    outputs: { go: boolean }
  c:
    title: c
    assignee: verifier
    parents: [a]
    when: [{ step: a, output: go, is: true }]
`;

const FLOW = `board: vi
params:
  case: { required: true }
steps:
  intake:
    title: "{{case}} · intake"
    assignee: vi-coordinator
    outputs:
      kind: { enum: [cve, supplychain] }
      verify: boolean
      note: string
  va:
    title: "{{case}} · va"
    assignee: vulnerability-analyst
    parents: [intake]
    when:
      - { step: intake, output: kind, equals: cve }
    outputs:
      reachable: boolean
  verify:
    title: "{{case}} · verify of {{intake.kind}}"
    body: "reachable: {{va.reachable}}"
    assignee: verifier
    parents: [va]
    when:
      - { step: intake, output: verify, is: true }
  report:
    title: "{{case}} · report, {{intake.note}}"
    assignee: report-author
    parents: [va, verify]
    gates:
      - { command: "test -s report.md", timeout_s: 30 }
  help:
    title: "{{case}} · help"
    assignee: verifier
    parents: [va]
    when:
      - { step: va, state: gave_up }
`;

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  b = viBoard(h, { limits: { failureLimit: 1, transientLimit: 10, transientCooldownS: 300 } });
  writeFileSync(join(b.dir, 'flow.yaml'), FLOW);
});
afterEach(() => h.close());

function start(): WorkflowMade {
  return madeOf(b.service.startWorkflow({ workflow: 'flow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
}

/** A run of the task, claimed, completing with its outputs, and closed. */
async function done(taskId: string, metadata: Record<string, unknown>): Promise<void> {
  const run = claimed(h.db, taskId);
  const r = await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'did it', metadata });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  closeRun(h.db, run.runId, NOW);
}

function member(instanceId: string, step: string) {
  return membersOf(h.db, instanceId).find((m) => m.step === step);
}

const routed = (taskId: string) => eventsOf(h.db, taskId).filter((e) => e.kind === 'workflow_routed').map((e) => e.payload as Record<string, unknown>);

describe('the writer deciding at a settling', () => {
  it("makes a step whose when holds at its parent's completion, linked to it, as the start would have made it", async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    await done(intake, { kind: 'cve', verify: true, note: 'n' });
    const va = member(w.instance.instanceId, 'va');
    expect(va).toMatchObject({ ref: 'va', step: 'va', item: null, position: 1 });
    const task = getTask(h.db, va?.taskId ?? '');
    expect(task).toMatchObject({ title: 'CVE-1 · va', board: 'vi', createdBy: ALICE, assignee: { kind: 'role', name: 'vulnerability-analyst' } });
    expect(task?.contract.outcome).toBe('Report in the metadata of your completion: reachable (true or false).');
    expect(parentsOf(h.db, va?.taskId ?? '').map((p) => p.taskId)).toEqual([intake]);
    expect(eventsOf(h.db, va?.taskId ?? '')[0]).toMatchObject({
      kind: 'created',
      actor: ALICE,
      payload: { workflow: w.instance.instanceId, workflowName: 'flow', ref: 'va', step: 'va', item: null, parents: [intake] },
    });
    expect(subscriptionsOf(h.db, va?.taskId ?? '').map((s) => [s.conversationId, s.threadId])).toEqual([['oc_chat', '']]);
    expect(settledOf(h.db, w.instance.instanceId)).toEqual([
      { instanceId: w.instance.instanceId, step: 'intake', ref: 'intake', how: 'done', taskId: intake, eventId: expect.any(Number), settledAt: NOW },
    ]);
    expect(routed(intake)).toEqual([
      {
        workflow: w.instance.instanceId,
        workflowName: 'flow',
        step: 'intake',
        cause: 'completed',
        decisions: [{ step: 'va', outcome: 'made', why: 'intake.kind is cve', taskIds: [va?.taskId] }],
      },
    ]);
  });

  it('skips a step at once when its when is false, holding its children until its own parents settle, then links them past it', async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    await done(intake, { kind: 'cve', verify: false, note: 'n' });
    expect(routed(intake)[0]?.['decisions']).toEqual([
      { step: 'va', outcome: 'made', why: 'intake.kind is cve', taskIds: [member(w.instance.instanceId, 'va')?.taskId] },
      { step: 'verify', outcome: 'skipped', why: 'intake.verify is false', taskIds: [], by: 'when' },
    ]);
    // verify is skipped, but not settled while va runs: report waits.
    expect(pendingOf(h.db, w.instance.instanceId).map((p) => [p.step, p.state])).toEqual([
      ['help', 'waiting'],
      ['report', 'waiting'],
      ['va', 'made'],
      ['verify', 'skipped'],
    ]);
    expect(settledOf(h.db, w.instance.instanceId).map((s) => s.step)).toEqual(['intake']);
    const va = member(w.instance.instanceId, 'va')?.taskId ?? '';
    await done(va, { reachable: true });
    const report = member(w.instance.instanceId, 'report')?.taskId ?? '';
    expect(parentsOf(h.db, report).map((p) => p.taskId)).toEqual([va]);
    expect(settledOf(h.db, w.instance.instanceId).map((s) => [s.step, s.how])).toEqual([
      ['help', 'skipped'],
      ['intake', 'done'],
      ['va', 'done'],
      ['verify', 'skipped'],
    ]);
    expect(getTask(h.db, report)?.title).toBe('CVE-1 · report, n');
    expect(gatesOf(h.db, report).map((g) => [g.command, g.timeoutS, g.createdBy])).toEqual([['test -s report.md', 30, ALICE]]);
  });

  it("links a step past a skipped parent to its nearest done ancestor, and fills a skipped step's output with (skipped)", async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    await done(intake, { kind: 'supplychain', verify: true, note: 'n' });
    const verify = member(w.instance.instanceId, 'verify')?.taskId ?? '';
    expect(getTask(h.db, verify)).toMatchObject({ title: 'CVE-1 · verify of supplychain', body: 'reachable: (skipped)' });
    expect(parentsOf(h.db, verify).map((p) => p.taskId)).toEqual([intake]);
    expect(routed(intake)[0]?.['decisions']).toEqual([
      { step: 'va', outcome: 'skipped', why: 'intake.kind is supplychain', taskIds: [], by: 'when' },
      { step: 'verify', outcome: 'made', why: 'intake.verify is true', taskIds: [verify] },
      { step: 'help', outcome: 'skipped', why: 'va did not give up', taskIds: [], by: 'when' },
    ]);
  });

  it("makes a step on its ancestor's give-up, not linked to it, the decision staying made once it is done", async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    await done(intake, { kind: 'cve', verify: false, note: 'n' });
    const va = member(w.instance.instanceId, 'va')?.taskId ?? '';
    const run = claimed(h.db, va);
    const ended = b.service.endRun(run.runId, { outcome: 'crashed', error: 'boom' });
    expect(ended).toMatchObject({ ok: true, next: 'blocked', task: { blockKind: 'gave_up' } });
    const help = member(w.instance.instanceId, 'help')?.taskId ?? '';
    expect(parentsOf(h.db, help)).toEqual([]);
    expect(routed(va)[0]).toMatchObject({ cause: 'gave_up', decisions: [{ step: 'help', outcome: 'made', why: 'va gave up', taskIds: [help] }] });
    closeRun(h.db, run.runId, NOW);
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    await done(va, { reachable: true });
    expect(membersOf(h.db, w.instance.instanceId).filter((m) => m.step === 'help').length).toBe(1);
  });

  it("copies the first member's subscriptions as they are at the making, in its thread", async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    expect(b.service.threadSubscriptions([intake], { channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat' }, 'omt_topic', 'om_root').ok).toBe(true);
    await done(intake, { kind: 'cve', verify: false, note: 'n' });
    const va = member(w.instance.instanceId, 'va')?.taskId ?? '';
    expect(subscriptionsOf(h.db, va).map((s) => [s.conversationId, s.threadId, s.rootMessageId])).toEqual([['oc_chat', 'omt_topic', 'om_root']]);
  });

  it('makes a child of a parent done and then archived, linked to it, its clause and its handoff read', async () => {
    writeFileSync(join(b.dir, 'pair.yaml'), PAIR);
    const w = madeOf(b.service.startWorkflow({ workflow: 'pair', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
    const [a, bb] = [w.tasks[0]?.taskId ?? '', w.tasks[1]?.taskId ?? ''];
    await done(a, { go: true });
    expect(b.service.archive(a, ALICE).ok).toBe(true);
    await done(bb, {});
    expect(settledOf(h.db, w.instance.instanceId).find((s) => s.step === 'a')).toMatchObject({ how: 'done', taskId: a });
    const c = member(w.instance.instanceId, 'c')?.taskId ?? '';
    expect(parentsOf(h.db, c).map((p) => [p.taskId, p.phase])).toEqual([
      [a, 'archived'],
      [bb, 'done'],
    ]);
    expect(routed(bb)[0]?.['decisions']).toEqual([{ step: 'c', outcome: 'made', why: 'a.go is true', taskIds: [c] }]);
    const run = claimed(h.db, c);
    const task = getTask(h.db, c);
    if (task === undefined) throw new Error('no task');
    expect(briefFor(h.db, { run, task, roleMd: undefined, role: undefined }).parents).toContainEqual(
      expect.objectContaining({ summary: 'did it', metadata: { go: true }, task: expect.objectContaining({ taskId: a }) }),
    );
  });

  it("reads a reworked result, the run approved last, and an operator's approval reading the work run's", async () => {
    writeFileSync(join(b.dir, 'reviewed.yaml'), REVIEWED);
    const reviewed = () => madeOf(b.service.startWorkflow({ workflow: 'reviewed', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
    const first = reviewed();
    const a = first.tasks[0]?.taskId ?? '';
    await done(a, { go: true });
    const changes = claimed(h.db, a);
    expect(b.service.requestChanges(a, { kind: 'run', runId: changes.runId }, 'check again').ok).toBe(true);
    closeRun(h.db, changes.runId, NOW);
    await done(a, { go: false });
    await done(a, {});
    expect(getTask(h.db, a)?.phase).toBe('done');
    expect(pendingOf(h.db, first.instance.instanceId).find((p) => p.step === 'c')).toMatchObject({ state: 'skipped', reason: { by: 'when', why: 'a.go is false' } });
    const second = reviewed();
    const a2 = second.tasks[0]?.taskId ?? '';
    await done(a2, { go: true });
    expect((await b.service.complete(a2, { kind: 'person', principal: ALICE }, { summary: 'approved' })).ok).toBe(true);
    expect(routed(a2).at(-1)?.['decisions']).toEqual([{ step: 'c', outcome: 'made', why: 'a.go is true', taskIds: [member(second.instance.instanceId, 'c')?.taskId] }]);
  });

  it('cuts a title made long by a result to its limit, never refusing', async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    await done(intake, { kind: 'supplychain', verify: false, note: 'n'.repeat(600) });
    const report = member(w.instance.instanceId, 'report')?.taskId ?? '';
    expect(Buffer.byteLength(getTask(h.db, report)?.title ?? '')).toBe(512);
  });
});
```

- [ ] **Step 13.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-worktree-base.test.ts tests/routing-writer.test.ts`. Expected: `Tests  10 failed (10)`, the first as `Error: no task `.

- [ ] **Step 13.3: Implement.**

In `src/db/WRITERS.md`, replace:

```markdown
| `kanban_subscriptions` | `db/kanban.ts` | Added by `createTask`, in its transaction: the chat a task is created in, or the subscriptions of the task whose run created it (spec §9.4), or the chat a terminal named, `follow`, for this bot, at chat scope or in a thread with the root `threadRootOf` gave (kanban spec §22.1), which `applyDag` gives every member of an instance (workflows spec §18.1). `root_message_id` (migration 008) is written at the insert, for a task created in a thread, from `createdVia.rootId`, or copied with the creating task's subscription (spec §19.4). `cursor` is moved forward only, by `advanceSubscription`, which writes no event: it is the notifier's own cursor, as a binding's `cursor_seq` is the card writer's. `thread_id` and `root_message_id` are written once more, together, by `threadSubscriptions`, which moves each subscription of its tasks still at chat scope with no root into the thread their "Created" reply opened, in one transaction: one task's for `/kanban task new`, every member's for a workflow's start (workflows spec §9), writing no event either. No root is changed once written. `wake_cursor` (migration 013) is moved forward only, by `advanceWake`, `dropWake` and `liftedWake`, in the transaction that settles a wake, and by `passWake` for events the waker passes over; by `recordRoleWake`, in its transaction, for every subscription its batch covers; and set to the task's latest event by `setWake` when wake is turned on, in its transaction. It writes no event: it is the waker's own cursor, as `cursor` is the notifier's. `createTask` leaves it at 0. A reaction task's one subscription is added by `recordRoleWake`, in its transaction, a copy of its batch's conversation's subscription for this bot (channel, chat, thread, root and `chat_type`), with `cursor` and `wake_cursor` 0 (wake spec §19.3); a chatless batch's reaction task gets none (§19.16). `chat_type` (migration 013) is written at the insert, from `createdVia.chatType`, or copied with the creating task's subscription, and never changed (wake spec §4.3). Never deleted. |
```

with:

```markdown
| `kanban_subscriptions` | `db/kanban.ts` | Added by `createTask`, in its transaction: the chat a task is created in, or the subscriptions of the task whose run created it (spec §9.4), or the chat a terminal named, `follow`, for this bot, at chat scope or in a thread with the root `threadRootOf` gave (kanban spec §22.1), which `applyDag` gives every member of an instance (workflows spec §18.1). `root_message_id` (migration 008) is written at the insert, for a task created in a thread, from `createdVia.rootId`, or copied with the creating task's subscription (spec §19.4). `cursor` is moved forward only, by `advanceSubscription`, which writes no event: it is the notifier's own cursor, as a binding's `cursor_seq` is the card writer's. `thread_id` and `root_message_id` are written once more, together, by `threadSubscriptions`, which moves each subscription of its tasks still at chat scope with no root into the thread their "Created" reply opened, in one transaction: one task's for `/kanban task new`, every member's for a workflow's start (workflows spec §9), writing no event either. No root is changed once written. `wake_cursor` (migration 013) is moved forward only, by `advanceWake`, `dropWake` and `liftedWake`, in the transaction that settles a wake, and by `passWake` for events the waker passes over; by `recordRoleWake`, in its transaction, for every subscription its batch covers; and set to the task's latest event by `setWake` when wake is turned on, in its transaction. It writes no event: it is the waker's own cursor, as `cursor` is the notifier's. `createTask` leaves it at 0. A task a workflow's plan made late gets a copy of each of its instance's first member's subscriptions as they are then, added by the routing in the transaction that made it (workflow routing spec §7.4). A reaction task's one subscription is added by `recordRoleWake`, in its transaction, a copy of its batch's conversation's subscription for this bot (channel, chat, thread, root and `chat_type`), with `cursor` and `wake_cursor` 0 (wake spec §19.3); a chatless batch's reaction task gets none (§19.16). `chat_type` (migration 013) is written at the insert, from `createdVia.chatType`, or copied with the creating task's subscription, and never changed (wake spec §4.3). Never deleted. |
```

In `src/db/WRITERS.md`, replace:

```markdown
| `kanban_workflow_tasks` | `db/kanban.ts` | Added by `applyDag`, one row a task it made, in its transaction; never added later, changed or removed: a member is exactly what the apply made (workflows spec §7). `item` is masked on write. Read by the workflow commands and by `task show`'s one line, and by nothing in the kernel. |
```

with:

```markdown
| `kanban_workflow_tasks` | `db/kanban.ts` | Added by `applyDag`, one row a task it made, in its transaction; and, for an instance with a plan, by the routing, one row a task the plan made later, at the next position, in the transaction that decided it (workflow routing spec §7.4). Never changed or removed: a member is what the apply made, or what the instance's plan made later (workflows spec §7, as amended). `item` is masked on write. Read by the workflow commands and by `task show`'s one line, and by nothing in the kernel. |
```

In `src/db/kanban.ts`, replace:

```ts
import { decide as decideRouting, INSTANCE_CAP, maskPlan, type Decision, type Facts, type Plan, type StepFact } from '../kanban/routing.js';
```

with:

```ts
import { decide as decideRouting, fillText, INSTANCE_CAP, maskPlan, resultOf, SKIPPED_TEXT, valueSaid, type Decision, type Facts, type Plan, type PlanStep, type StepFact, type Template } from '../kanban/routing.js';
```

In `src/db/kanban.ts`, replace:

```ts
  /** A reaction task's subscription, copied from its batch's conversation's (wake spec §19.3). */
  copySubscription?: SubscriptionRow;
```

with:

```ts
  /**
   * Its subscriptions, copied as they are: a reaction task's one, from its batch's
   * conversation's (wake spec §19.3); a task a workflow's plan made late, its
   * instance's first member's (workflow routing spec §7.4). Given, they are the
   * task's only subscriptions.
   */
  copySubscriptions?: readonly SubscriptionRow[];
```

In `src/db/kanban.ts`, replace:

```ts
  subscribe(d, taskId, t.createdVia, createdFromTask, now, t.follow, t.copySubscription);
```

with:

```ts
  subscribe(d, taskId, t.createdVia, createdFromTask, now, t.follow, t.copySubscriptions);
```

In `src/db/kanban.ts`, replace:

```ts
  copy?: SubscriptionRow,
```

with:

```ts
  copy?: readonly SubscriptionRow[],
```

In `src/db/kanban.ts`, replace:

```ts
  // A reaction task follows its batch's conversation, a copy of its subscription (wake spec §19.3).
  if (via.kind === 'wake') {
    if (copy !== undefined) run(copy.channel, copy.appId, copy.conversationId, copy.threadId, copy.rootMessageId, copy.chatType);
```

with:

```ts
  // A reaction task follows its batch's conversation, a copy of its subscription (wake spec §19.3); a late
  // member of a workflow, its instance's first member's, as they are now (workflow routing spec §7.4).
  if (copy !== undefined || via.kind === 'wake') {
    for (const c of copy ?? []) run(c.channel, c.appId, c.conversationId, c.threadId, c.rootMessageId, c.chatType);
```

In `src/db/kanban.ts`, replace:

```ts
        ...(sub === undefined ? {} : { copySubscription: sub }),
```

with:

```ts
        ...(sub === undefined ? {} : { copySubscriptions: [sub] }),
```

In `src/db/kanban.ts`, replace:

```ts

/** An instance with a plan, as the routing reads it in its transaction: the row, the plan, and its members with their tasks. */
```

with:

```ts

/** The most items a `workflow_routed` line names; its count says the rest (§12.2). */
const ROUTED_ITEMS = 20;

/** An instance with a plan, as the routing reads it in its transaction: the row, the plan, and its members with their tasks. */
```

In `src/db/kanban.ts`, replace:

```ts
  members: Array<MemberRow & { task: TaskRow }>;
}
```

with:

```ts
  members: Array<MemberRow & { task: TaskRow }>;
}

/** A name a template gives, as the writer stores it: a person by their principal, else a role. */
function assigneeOf(name: string | null): Assignee | null {
  return name === null ? null : { kind: name.includes(':') ? 'human' : 'role', name };
}
```

In `src/db/kanban.ts`, replace:

```ts

/** A pending row moved from `waiting`, once (§9.2): false when another attempt decided it first, and then nothing is made. */
```

with:

```ts

/** The text a template's reference to a result fills (§7.4): the step's accepted value, a list's items joined, or `(skipped)`. */
function filled(plan: Plan, facts: Facts, text: string, item?: string): string {
  return fillText(
    text,
    (step, output) => {
      // A step not settled at the making, as the ancestor a `when: { state: gave_up }` step is made on, has no
      // accepted value yet: it fills `(skipped)` too, and the text is never filled again once it settles.
      const value = resultOf(plan, facts, step, output);
      return value === undefined ? SKIPPED_TEXT : valueSaid(value);
    },
    item,
  );
}

/**
 * Make one task of a step late (§7.4), as the start would have: through
 * `insertTask`, its fields from its template, the references filled, its title
 * and body cut to their limits; the instance's creator and board, and a run's
 * start's `created_from_task`; its links to its effective parents; its first
 * member's subscriptions; its gates by the instance's creator; its member row
 * at the next position; and its `created` event with the instance.
 */
function makeLate(
  d: Db,
  r: Routed,
  facts: Facts,
  made: { step: string; ref: string; item: string | null; template: Template; parents: readonly string[]; payload?: Record<string, unknown> },
  now: number,
): string {
  const t = made.template;
  const first = r.members[0];
  const title = cutToBytes(filled(r.plan, facts, t.title, made.item ?? undefined), WORKER_LIMITS.title);
  const body = t.body === null ? '' : cutToBytes(filled(r.plan, facts, t.body, made.item ?? undefined), WORKER_LIMITS.body);
  const assignee = assigneeOf(t.assignee);
  const reviewer = assigneeOf(t.reviewer);
  const wake = t.wake === null ? undefined : { by: t.wake.by, depth: t.wake.depth, ...(t.wake.tooDeep === true ? { tooDeep: true } : {}), ...(t.wake.role === undefined ? {} : { role: t.wake.role }) };
  const taskId = insertTask(
    d,
    {
      title,
      ...(body === '' ? {} : { body }),
      contract: t.contract,
      assignee,
      reviewer,
      workspace: t.workspace,
      priority: t.priority,
      failureLimit: t.failure_limit,
      retryOnCrash: t.retry_on_crash,
      maxRuntimeS: t.max_runtime_s,
      idempotencyKey: null,
      createdBy: r.instance.createdBy,
      createdVia: r.instance.createdVia,
      board: r.instance.board,
      createdFromTask: first?.task.createdFromTask ?? null,
      parents: made.parents,
      copySubscriptions: first === undefined ? [] : subscriptionsOf(d, first.taskId),
      ...(wake === undefined ? {} : { wake }),
    },
    now,
    { workflow: r.instance.instanceId, workflowName: r.instance.name, ref: made.ref, step: made.step, item: made.item, ...made.payload },
  );
  for (const gate of t.gates) {
    const added = insertGate(d, taskId, { command: gate.command, timeoutS: gate.timeout_s }, r.instance.createdBy, now, { workflow: r.instance.instanceId });
    if (!added.ok) throw new Error(`${made.ref}: ${added.message}`);
  }
  const position = (d.prepare<[string], { p: number | null }>('SELECT max(position) AS p FROM kanban_workflow_tasks WHERE instance_id = ?').get(r.instance.instanceId)?.p ?? -1) + 1;
  d.prepare('INSERT INTO kanban_workflow_tasks (task_id, instance_id, ref, step, item, position) VALUES (?, ?, ?, ?, ?, ?)').run(
    taskId,
    r.instance.instanceId,
    made.ref,
    made.step,
    made.item === null ? null : mask(made.item),
    position,
  );
  return taskId;
}

/** A step's templates, one an item of its list param, or its one. */
function templatesFor(s: PlanStep): Array<Template & { item: string | null }> {
  return s.templates ?? (s.template === undefined ? [] : [{ ...s.template, item: null }]);
}

/** A pending row moved from `waiting`, once (§9.2): false when another attempt decided it first, and then nothing is made. */
```

In `src/db/kanban.ts`, replace:

```ts
function apply(d: Db, r: Routed, dec: Decision, causeEvent: number | null, now: number): RoutedLine | undefined {
```

with:

```ts
function apply(d: Db, r: Routed, facts: Facts, dec: Decision, causeEvent: number | null, now: number): RoutedLine | undefined {
```

In `src/db/kanban.ts`, replace:

```ts
  // A step to make waits: only skips and settlings are applied yet.
  return undefined;
```

with:

```ts
  if (dec.outcome !== 'made' && dec.outcome !== 'fanned_out') return undefined;
  // The instance's board, live: an archived one skips the step, never refusing the transition (§13.1).
  const live = liveBoard(d, r.instance.board);
  if (!live.ok) {
    const why = `board ${r.instance.board} is archived`;
    return decided(d, id, dec.step, 'skipped', { by: 'board', why }, causeEvent, now) ? { step: dec.step, outcome: 'skipped', why, taskIds: [], by: 'board' } : undefined;
  }
  const templates = templatesFor(s);
  if (dec.outcome === 'made') {
    if (!decided(d, id, dec.step, 'made', { why: dec.why }, causeEvent, now)) return undefined;
    const t = templates[0];
    if (t === undefined) return undefined;
    const taskId = makeLate(d, r, facts, { step: dec.step, ref: dec.step, item: null, template: t, parents: dec.parents }, now);
    return { step: dec.step, outcome: 'made', why: dec.why, taskIds: [taskId] };
  }
  const made = dec.items.map((item, n) => ({ item, ref: `${dec.step}:${n + 1}`, template: templates.find((t) => t.item === item) ?? templates[0] }));
  if (!decided(d, id, dec.step, 'made', { why: dec.why }, causeEvent, now)) return undefined;
  const taskIds = made.flatMap((m) =>
    m.template === undefined ? [] : [makeLate(d, r, facts, { step: dec.step, ref: m.ref, item: m.item, template: m.template, parents: dec.parents }, now)],
  );
  const marker = made.map((m, n) => ({ item: mask(m.item), taskId: taskIds[n], ref: m.ref }));
  d.prepare('UPDATE kanban_workflow_pending SET items = ? WHERE instance_id = ? AND step = ?').run(JSON.stringify(marker), id, dec.step);
  return { step: dec.step, outcome: 'fanned_out', why: dec.why, taskIds, items: dec.items.slice(0, ROUTED_ITEMS), count: dec.items.length };
```

In `src/db/kanban.ts`, replace:

```ts
      const line = apply(d, r, dec, causeEvent, now);
```

with:

```ts
      const line = apply(d, r, facts, dec, causeEvent, now);
```

- [ ] **Step 13.4: Run them to verify they pass.** Run the same command. Expected: `Tests  10 passed (10)`.

- [ ] **Step 13.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3657 passed (3657)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 13.6: Commit.**

```bash
git add src/db/WRITERS.md src/db/kanban.ts tests/routing-worktree-base.test.ts tests/routing-writer.test.ts
git commit -m "Make a routed instance's step as the start would have when its parents settle, linked to its effective parents, with its first member's subscriptions"
```

---

### Task 14: The team check of a task made late

**Files:**

- Create: `tests/routing-team-check.test.ts`
- Modify: `src/db/kanban.ts`, `src/kanban/service.ts`

§7.4. The service passes the team it holds, `#facts()`, to `complete`, `block`, `endRun` and `archive`; a task made late for a role no longer configured is made, and blocked at once by the gateway, `needs_input`, in the routing's transaction.

- [ ] **Step 14.1: Write the tests.**

Create `tests/routing-team-check.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, getTask, membersOf } from '../src/db/kanban-read.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * A task made late checked against the team (workflow routing spec §7.4, §9.3):
 * the service hands the writer the team it holds, and a step's task whose role is
 * no longer configured is made, and blocked at once by the gateway as
 * `needs_input`, which routes nothing and is no state a clause reads.
 */

const FLOW = `board: vi
steps:
  intake:
    title: intake
    assignee: vi-coordinator
    outputs: { kind: { enum: [cve, supplychain] } }
  va:
    title: va
    assignee: vulnerability-analyst
    parents: [intake]
    when: [{ step: intake, output: kind, equals: cve }]
    on_blocked: { route: help }
  help:
    title: help
    assignee: verifier
    handler: true
`;

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  b = viBoard(h);
  writeFileSync(join(b.dir, 'flow.yaml'), FLOW);
});
afterEach(() => h.close());

describe('the team check of a task made late', () => {
  it('makes a task whose role is no longer configured, blocked at once by the gateway, which routes nothing', async () => {
    const w = madeOf(b.service.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
    const intake = w.tasks[0]?.taskId ?? '';
    b.roles.delete('vulnerability-analyst');
    const run = claimed(h.db, intake);
    expect((await b.service.complete(intake, { kind: 'run', runId: run.runId }, { summary: 'x', metadata: { kind: 'cve' } })).ok).toBe(true);
    closeRun(h.db, run.runId, NOW);
    const va = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'va')?.taskId ?? '';
    expect(getTask(h.db, va)).toMatchObject({
      phase: 'blocked',
      blockKind: 'needs_input',
      blockReason: `role vulnerability-analyst is not configured, so this step's task cannot be given to it: /kanban task assign ${va} <role>`,
    });
    expect(eventsOf(h.db, va).at(-1)).toMatchObject({ kind: 'blocked', actor: 'gateway' });
    expect(eventsOf(h.db, va).some((e) => e.kind === 'workflow_routed')).toBe(false);
    expect(membersOf(h.db, w.instance.instanceId).map((m) => m.step)).toEqual(['intake', 'va']);
  });
});
```

- [ ] **Step 14.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-team-check.test.ts`. Expected: `Tests  1 failed (1)`, the first as `AssertionError: expected { taskId: 'k_a3bn2x8t3bsz', …(33) } to match object { phase: 'blocked', …(2) }`.

- [ ] **Step 14.3: Implement.**

In `src/db/kanban.ts`, replace:

```ts
  handoff: Handoff,
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
```

with:

```ts
  handoff: Handoff,
  now: number,
  team?: RouteTeam,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
```

In `src/db/kanban.ts`, replace:

```ts
    routeAfter(d, taskId, 'completed', completed, now);
```

with:

```ts
    routeAfter(d, taskId, 'completed', completed, now, team);
```

In `src/db/kanban.ts`, replace:

```ts
  report: BlockReport,
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
```

with:

```ts
  report: BlockReport,
  now: number,
  team?: RouteTeam,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
```

In `src/db/kanban.ts`, replace:

```ts
      if (by.kind === 'run' && r.task.phase === 'open') routeAfter(d, taskId, 'blocked', blocked, now);
```

with:

```ts
      if (by.kind === 'run' && r.task.phase === 'open') routeAfter(d, taskId, 'blocked', blocked, now, team);
```

In `src/db/kanban.ts`, replace:

```ts
  now: number,
): Result<{ task: TaskRow; run: RunRow; next: NextStep }> {
```

with:

```ts
  now: number,
  team?: RouteTeam,
): Result<{ task: TaskRow; run: RunRow; next: NextStep }> {
```

In `src/db/kanban.ts`, replace:

```ts
      routeAfter(d, run.taskId, cause, ended, now);
```

with:

```ts
      routeAfter(d, run.taskId, cause, ended, now, team);
```

In `src/db/kanban.ts`, replace:

```ts
  taskId: string,
  by: string,
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return tx(db, (d) => {
```

with:

```ts
  taskId: string,
  by: string,
  now: number,
  team?: RouteTeam,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return tx(db, (d) => {
```

In `src/db/kanban.ts`, replace:

```ts
    routeAfter(d, taskId, 'archived', archived.eventId, now);
```

with:

```ts
    routeAfter(d, taskId, 'archived', archived.eventId, now, team);
```

In `src/db/kanban.ts`, replace:

```ts
// ---------------------------------------------------------------------------


```

with:

```ts
// ---------------------------------------------------------------------------

/** The team, as the service holds it, against which a task made late is checked (§7.4, §9.3); absent in the writer's own tests. */
export type RouteTeam = TaskFacts;

```

In `src/db/kanban.ts`, replace:

```ts
 * at the next position; and its `created` event with the instance.
```

with:

```ts
 * at the next position; and its `created` event with the instance. With the
 * team, a task whose assignee, reviewer or workspace no longer passes is made
 * and blocked at once, by the gateway, as `needs_input`.
```

In `src/db/kanban.ts`, replace:

```ts
  now: number,
): string {
```

with:

```ts
  now: number,
  team: RouteTeam | undefined,
): string {
```

In `src/db/kanban.ts`, replace:

```ts
  );
  return taskId;
```

with:

```ts
  );
  if (team !== undefined) {
    const refused = lateRefused(t, title, r.instance, team);
    if (refused !== undefined) {
      const reason = `${refused}, so this step's task cannot be given to it: /kanban task assign ${taskId} <role>`;
      const recurrences = enterBlocked(d, mustGet(d, taskId), 'needs_input', reason);
      record(d, { taskId, kind: 'blocked', actor: 'gateway', payload: { kind: 'needs_input', reason, blockRecurrences: recurrences } }, now);
    }
  }
  return taskId;
```

In `src/db/kanban.ts`, replace:

```ts
  }
  return taskId;
}
```

with:

```ts
  }
  return taskId;
}

/** Why a task made late no longer passes the team's checks (§7.4), or undefined: a role named not configured, said plainly, or `checkTask`'s words. */
function lateRefused(t: Template, title: string, instance: InstanceRow, team: RouteTeam): string | undefined {
  for (const name of [t.assignee, t.reviewer]) {
    if (name !== null && !name.includes(':') && !team.roles.has(name)) return `role ${name} is not configured`;
  }
  const checked = checkTask(
    {
      title,
      contract: t.contract,
      ...(t.assignee === null ? {} : { assignee: t.assignee }),
      ...(t.reviewer === null ? {} : { reviewer: t.reviewer }),
      ...(t.workspace === null ? {} : { workspace: t.workspace }),
      createdBy: instance.createdBy,
      createdVia: instance.createdVia,
    },
    team,
  );
  return checked.ok ? undefined : checked.message;
}
```

In `src/db/kanban.ts`, replace:

```ts
function apply(d: Db, r: Routed, facts: Facts, dec: Decision, causeEvent: number | null, now: number): RoutedLine | undefined {
```

with:

```ts
function apply(d: Db, r: Routed, facts: Facts, dec: Decision, causeEvent: number | null, now: number, team: RouteTeam | undefined): RoutedLine | undefined {
```

In `src/db/kanban.ts`, replace:

```ts
    const taskId = makeLate(d, r, facts, { step: dec.step, ref: dec.step, item: null, template: t, parents: dec.parents }, now);
```

with:

```ts
    const taskId = makeLate(d, r, facts, { step: dec.step, ref: dec.step, item: null, template: t, parents: dec.parents }, now, team);
```

In `src/db/kanban.ts`, replace:

```ts
    m.template === undefined ? [] : [makeLate(d, r, facts, { step: dec.step, ref: m.ref, item: m.item, template: m.template, parents: dec.parents }, now)],
```

with:

```ts
    m.template === undefined ? [] : [makeLate(d, r, facts, { step: dec.step, ref: m.ref, item: m.item, template: m.template, parents: dec.parents }, now, team)],
```

In `src/db/kanban.ts`, replace:

```ts
function decideAll(d: Db, instance: InstanceRow, causeEvent: number | null, now: number): RoutedLine[] {
```

with:

```ts
function decideAll(d: Db, instance: InstanceRow, causeEvent: number | null, now: number, team: RouteTeam | undefined): RoutedLine[] {
```

In `src/db/kanban.ts`, replace:

```ts
      const line = apply(d, r, facts, dec, causeEvent, now);
```

with:

```ts
      const line = apply(d, r, facts, dec, causeEvent, now, team);
```

In `src/db/kanban.ts`, replace:

```ts
function routeAfter(d: Db, taskId: string, cause: RouteCause, eventId: number, now: number): void {
```

with:

```ts
function routeAfter(d: Db, taskId: string, cause: RouteCause, eventId: number, now: number, team?: RouteTeam): void {
```

In `src/db/kanban.ts`, replace:

```ts
  const lines = decideAll(d, planned.instance, eventId, now);
```

with:

```ts
  const lines = decideAll(d, planned.instance, eventId, now, team);
```

In `src/kanban/service.ts`, replace:

```ts
    return board.endRun(this.#db, runId, ending, this.#limits, this.#clock.now());
```

with:

```ts
    return board.endRun(this.#db, runId, ending, this.#limits, this.#clock.now(), this.#facts());
```

In `src/kanban/service.ts`, replace:

```ts
      board.complete(this.#db, taskId, by, { ...handoff, ...seen }, this.#clock.now()),
```

with:

```ts
      board.complete(this.#db, taskId, by, { ...handoff, ...seen }, this.#clock.now(), this.#facts()),
```

In `src/kanban/service.ts`, replace:

```ts
      { kind, reason: report.reason, ...(report.parents === undefined ? {} : { parents: report.parents }) },
      this.#clock.now(),
    );
```

with:

```ts
      { kind, reason: report.reason, ...(report.parents === undefined ? {} : { parents: report.parents }) },
      this.#clock.now(),
      this.#facts(),
    );
```

In `src/kanban/service.ts`, replace:

```ts
    return board.archive(this.#db, taskId, by, this.#clock.now());
```

with:

```ts
    return board.archive(this.#db, taskId, by, this.#clock.now(), this.#facts());
```

- [ ] **Step 14.4: Run them to verify they pass.** Run the same command. Expected: `Tests  1 passed (1)`.

- [ ] **Step 14.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3658 passed (3658)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 14.6: Commit.**

```bash
git add src/db/kanban.ts src/kanban/service.ts tests/routing-team-check.test.ts
git commit -m "Check a routed instance's task made late against the team the service holds, making one it no longer passes blocked at once by the gateway"
```

---

### Task 15: The savepoint and the fault

**Files:**

- Create: `tests/routing-fault.test.ts`
- Modify: `src/db/kanban.ts`, `src/db/open.ts`

§9.4. The routing runs in a savepoint of its transition's transaction; a throw rolls the savepoint back alone, the transition commits, and the instance's `routing_failed_at` is set from null, with one `workflow_route_failed` event on the task, `first` only on the one that set it; a throw after SQLite rolled the whole transaction back is rethrown. The tests make faults with temporary triggers, `RAISE(ABORT)` for a fault and `RAISE(ROLLBACK)` for a transaction gone. A database found busy inside the savepoint is no fault: the error is rethrown, so `txImmediate` retries the whole transition.

- [ ] **Step 15.1: Write the tests.**

Create `tests/routing-fault.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, getInstance, getTask, membersOf, pendingOf, settledOf } from '../src/db/kanban-read.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * A fault in the routing (workflow routing spec §9.4): its savepoint rolled back
 * alone, the transition kept, the instance marked once, one workflow_route_failed
 * event a fault, `first` only on the one that set the mark; and, when SQLite
 * rolled the whole transaction back, the error rethrown and nothing committed.
 */

const FLOW = `board: vi
steps:
  a:
    title: a
    assignee: vi-coordinator
    outputs: { go: boolean }
  b:
    title: b
    assignee: verifier
    outputs: { go: boolean }
  c:
    title: c
    assignee: verifier
    parents: [a, b]
    when: [{ step: a, output: go, is: true }]
`;

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  b = viBoard(h);
  writeFileSync(join(b.dir, 'flow.yaml'), FLOW);
});
afterEach(() => h.close());

function start() {
  return madeOf(b.service.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
}

async function done(taskId: string): Promise<void> {
  const run = claimed(h.db, taskId);
  const r = await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'did it', metadata: { go: true } });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  closeRun(h.db, run.runId, NOW);
}

const failed = (taskId: string) => eventsOf(h.db, taskId).filter((e) => e.kind === 'workflow_route_failed').map((e) => e.payload);

describe('a fault in the routing', () => {
  it('rolls back its savepoint alone, keeping the completion, marking the instance once, one event a fault, first on the first only', async () => {
    const w = start();
    const [a, bb] = [w.tasks[0]?.taskId ?? '', w.tasks[1]?.taskId ?? ''];
    h.db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled BEGIN SELECT RAISE(ABORT, 'the settled rows cannot be written'); END;");
    await done(a);
    expect(getTask(h.db, a)?.phase).toBe('done');
    expect(settledOf(h.db, w.instance.instanceId)).toEqual([]);
    expect(getInstance(h.db, w.instance.instanceId)?.routingFailedAt).toBe(NOW);
    expect(failed(a)).toEqual([{ workflow: w.instance.instanceId, workflowName: 'flow', error: 'the settled rows cannot be written', first: true }]);
    await done(bb);
    expect(failed(bb)).toEqual([{ workflow: w.instance.instanceId, workflowName: 'flow', error: 'the settled rows cannot be written', first: false }]);
    expect(pendingOf(h.db, w.instance.instanceId).map((p) => p.state)).toEqual(['waiting']);
    expect(membersOf(h.db, w.instance.instanceId).length).toBe(2);
  });

  it('rethrows when SQLite rolled the whole transaction back, so nothing is committed', async () => {
    const w = start();
    const a = w.tasks[0]?.taskId ?? '';
    h.db.exec("CREATE TEMP TRIGGER gone BEFORE INSERT ON kanban_workflow_settled BEGIN SELECT RAISE(ROLLBACK, 'the transaction is gone'); END;");
    const run = claimed(h.db, a);
    await expect(b.service.complete(a, { kind: 'run', runId: run.runId }, { summary: 'did it', metadata: { go: true } })).rejects.toThrow('the transaction is gone');
    expect(getTask(h.db, a)?.phase).toBe('open');
    expect(eventsOf(h.db, a).some((e) => e.kind === 'completed' || e.kind === 'workflow_route_failed')).toBe(false);
    expect(getInstance(h.db, w.instance.instanceId)?.routingFailedAt).toBeNull();
  });

  it('lets txImmediate retry the whole transition when the routing finds the database busy, nothing marked', async () => {
    const w = start();
    const a = w.tasks[0]?.taskId ?? '';
    let busy = 1;
    h.db.function('busy_once', () => {
      if (busy-- > 0) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      return 0;
    });
    h.db.exec('CREATE TEMP TRIGGER busy BEFORE INSERT ON kanban_workflow_settled BEGIN SELECT busy_once(); END;');
    await done(a);
    expect(eventsOf(h.db, a).filter((e) => e.kind === 'completed').length).toBe(1);
    expect(failed(a)).toEqual([]);
    expect(settledOf(h.db, w.instance.instanceId).map((s) => s.step)).toEqual(['a']);
    expect(getInstance(h.db, w.instance.instanceId)?.routingFailedAt).toBeNull();
  });

  it.each([
    ['a', 'b'],
    ['b', 'a'],
  ])('decides as before once the fault is gone, %s settling before %s', async (first, second) => {
    const w = start();
    const task = (step: string) => w.tasks[step === 'a' ? 0 : 1]?.taskId ?? '';
    h.db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    await done(task(first));
    h.db.exec('DROP TRIGGER boom');
    await done(task(second));
    expect(settledOf(h.db, w.instance.instanceId).map((s) => [s.step, s.how])).toEqual([
      ['a', 'done'],
      ['b', 'done'],
    ]);
    expect(membersOf(h.db, w.instance.instanceId).map((m) => m.step)).toEqual(['a', 'b', 'c']);
  });
});
```

- [ ] **Step 15.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-fault.test.ts`. Expected: `Tests  3 failed | 2 passed (5)`, the first as `SqliteError: the settled rows cannot be written`.

- [ ] **Step 15.3: Implement.**

In `src/db/kanban.ts`, replace:

```ts
import { txImmediate } from './open.js';
```

with:

```ts
import { isBusy, txImmediate } from './open.js';
```

In `src/db/kanban.ts`, replace:

```ts
}

/**
 * The routing of a transition (§9.2), inside its transaction, after its own rows
```

with:

```ts
}

/** How long a fault's error may be in its event, in characters (§9.4). */
const FAULT_CHARS = 500;

/**
 * The routing of a transition (§9.2), inside its transaction, after its own rows
```

In `src/db/kanban.ts`, replace:

```ts
 * and event: one read finds the task's member row and its instance's plan, and a
 * task that is no member of an instance with a plan pays nothing more; then what
 * is due is decided, and one `workflow_routed` event on the task lists the
 * decisions, for the notice.
```

with:

```ts
 * and event, in a savepoint of its own (§9.4): one read finds the task's member
 * row and its instance's plan, and a task that is no member of an instance with
 * a plan pays nothing more; then what is due is decided, and one
 * `workflow_routed` event on the task lists the decisions, for the notice. A
 * fault never loses the transition: the savepoint rolls back alone, and the
 * instance's `routing_failed_at` and one `workflow_route_failed` event say so,
 * `first` when it set the mark; unless the transaction itself is gone, as
 * SQLite rolls one back on some errors, when the error is the transition's,
 * or the database is busy, when txImmediate retries the whole transition.
```

In `src/db/kanban.ts`, replace:

```ts
function routeAfter(d: Db, taskId: string, cause: RouteCause, eventId: number, now: number, team?: RouteTeam): void {
```

with:

```ts
function routeAfter(d: Db, taskId: string, cause: RouteCause, eventId: number, now: number, team?: RouteTeam): void {
  if (!hasRouting(d)) return;
  try {
    d.transaction(() => routeIn(d, taskId, cause, eventId, now, team))();
  } catch (err) {
    if (!d.inTransaction || isBusy(err)) throw err;
    routingFault(d, taskId, err, now);
  }
}

/** A routing fault recorded, outside the savepoint that rolled back (§9.4): the mark set from null, and its event, masked and cut. */
function routingFault(d: Db, taskId: string, err: unknown, now: number): void {
  const row = d
    .prepare<[string], { instance_id: string; name: string | null }>(
      `SELECT m.instance_id, i.name FROM kanban_workflow_tasks m JOIN kanban_workflow_instances i ON i.instance_id = m.instance_id WHERE m.task_id = ?`,
    )
    .get(taskId);
  if (row === undefined) return;
  const first = d.prepare('UPDATE kanban_workflow_instances SET routing_failed_at = ? WHERE instance_id = ? AND routing_failed_at IS NULL').run(now, row.instance_id).changes === 1;
  const said = mask(err instanceof Error ? err.message : String(err));
  record(
    d,
    {
      taskId,
      kind: 'workflow_route_failed',
      actor: 'gateway',
      payload: { workflow: row.instance_id, workflowName: row.name, error: said.length <= FAULT_CHARS ? said : said.slice(0, FAULT_CHARS), first },
    },
    now,
  );
}

/** The routing's body, inside its savepoint. */
function routeIn(d: Db, taskId: string, cause: RouteCause, eventId: number, now: number, team?: RouteTeam): void {
```

In `src/db/open.ts`, replace:

```ts
function isBusy(err: unknown): boolean {
```

with:

```ts
/** A lock another connection holds: txImmediate's to retry, whoever caught it first. */
export function isBusy(err: unknown): boolean {
```

- [ ] **Step 15.4: Run them to verify they pass.** Run the same command. Expected: `Tests  5 passed (5)`.

- [ ] **Step 15.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3663 passed (3663)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 15.6: Commit.**

```bash
git add src/db/kanban.ts src/db/open.ts tests/routing-fault.test.ts
git commit -m "Run the routing in a savepoint of its transition, so a fault marks the instance and says so once, and never loses the transition"
```

---

### Task 16: workflow archive skips every waiting step

**Files:**

- Create: `tests/routing-archive-workflow.test.ts`
- Modify: `src/db/kanban.ts`

§9.1. `archiveWorkflow` skips every waiting row of an instance with a plan, `the instance was archived`, in its transaction, deciding nothing and making nothing.

- [ ] **Step 16.1: Write the tests.**

Create `tests/routing-archive-workflow.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventsOf, membersOf, pendingOf, settledOf } from '../src/db/kanban-read.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA } from './helpers/kanban.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * Cancelling a case is `workflow archive` (workflow routing spec §9.1): every
 * member archived, every waiting step skipped, `the instance was archived`, and
 * nothing decided or made.
 */

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  b = viBoard(h);
});
afterEach(() => h.close());

describe('archiving a routed instance', () => {
  it('skips every waiting step without deciding, and makes nothing', () => {
    const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
    const r = b.service.archiveWorkflow(w.instance.instanceId, ALICE);
    expect(r.ok).toBe(true);
    const pending = pendingOf(h.db, w.instance.instanceId);
    expect(pending.map((p) => [p.step, p.state])).toEqual([
      ['exposure', 'skipped'],
      ['patch', 'skipped'],
      ['registry', 'skipped'],
      ['report', 'skipped'],
      ['va', 'skipped'],
      ['verify', 'skipped'],
    ]);
    expect(pending[0]).toMatchObject({ reason: { by: 'instance', why: 'the instance was archived' }, decidedAt: NOW, causeEvent: null });
    expect(membersOf(h.db, w.instance.instanceId).length).toBe(1);
    expect(settledOf(h.db, w.instance.instanceId)).toEqual([]);
    expect(eventsOf(h.db, w.tasks[0]?.taskId ?? '').some((e) => e.kind === 'workflow_routed')).toBe(false);
  });
});
```

- [ ] **Step 16.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-archive-workflow.test.ts`. Expected: `Tests  1 failed (1)`, the first as `AssertionError: expected [ [ 'exposure', 'waiting' ], …(5) ] to deeply equal [ [ 'exposure', 'skipped' ], …(5) ]`.

- [ ] **Step 16.3: Implement.**

In `src/db/kanban.ts`, replace:

```ts
 * instance. Answers the members it archived, and the runs it decided, whose
 * turns the caller cancels; none for an instance wholly archived already.
```

with:

```ts
 * instance; and, for one with a plan, every waiting step skipped, `the instance
 * was archived`, deciding nothing (workflow routing spec §9.1). Answers the
 * members it archived, and the runs it decided, whose turns the caller cancels;
 * none for an instance wholly archived already.
```

In `src/db/kanban.ts`, replace:

```ts
      if (r.run !== undefined) runs.push(r.run);
```

with:

```ts
      if (r.run !== undefined) runs.push(r.run);
    }
    // Cancelling a case (workflow routing spec §9.1): every waiting step skipped, without deciding, so nothing more is made.
    if (hasRouting(d)) {
      d.prepare(
        `UPDATE kanban_workflow_pending SET state = 'skipped', reason = ?, decided_at = ? WHERE instance_id = ? AND state = 'waiting'`,
      ).run(JSON.stringify({ by: 'instance', why: 'the instance was archived' }), now, instanceId);
```

- [ ] **Step 16.4: Run them to verify they pass.** Run the same command. Expected: `Tests  1 passed (1)`.

- [ ] **Step 16.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3664 passed (3664)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 16.6: Commit.**

```bash
git add src/db/kanban.ts tests/routing-archive-workflow.test.ts
git commit -m "Skip every waiting step when a routed instance is archived, deciding nothing"
```

---

### Task 17: The dispatcher's retry

**Files:**

- Create: `tests/routing-retry.test.ts`
- Modify: `src/db/kanban-read.ts`, `src/db/kanban.ts`, `src/kanban/dispatcher.ts`, `src/kanban/service.ts`

§9.4, §11. `reconcileWorkflow` in the writer is the routing given no transitioning task, in a transaction of its own, its `workflow_routed` on the latest-settled ancestor of its first decision's step, clearing the fault mark; the service's `reconcileWorkflow` and `retryRouting`, which reconciles each faulted instance at most once a minute, the times in memory; and the dispatcher's pass calling `retryRouting` once. A second reconciliation writes nothing, and one whose commit finds the database busy is retried whole.

- [ ] **Step 17.1: Write the tests.**

Create `tests/routing-retry.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, getInstance, membersOf } from '../src/db/kanban-read.js';
import { clearSecrets } from '../src/secrets.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { dispatchHarness } from './helpers/dispatch.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * A faulted routing retried (workflow routing spec §9.4, §11): the dispatcher's
 * pass calls the service's one hook, which reconciles every faulted instance at
 * most once a minute, clearing its mark on success, the reconciliation's
 * decisions in one workflow_routed event on the member whose settling decided.
 */

const FLOW = `board: vi
steps:
  a:
    title: a
    assignee: vi-coordinator
    outputs: { go: boolean }
  b:
    title: b
    assignee: verifier
    parents: [a]
    when: [{ step: a, output: go, is: true }]
`;

let h: TestDb;
let b: ViBoard;
let clock: ManualClock;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  clock = new ManualClock(NOW);
  b = viBoard(h, { clock });
  writeFileSync(join(b.dir, 'flow.yaml'), FLOW);
});
afterEach(() => h.close());

async function faulted(): Promise<{ instanceId: string; a: string }> {
  const w = madeOf(b.service.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
  const a = w.tasks[0]?.taskId ?? '';
  h.db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  const run = claimed(h.db, a);
  const r = await b.service.complete(a, { kind: 'run', runId: run.runId }, { summary: 'did it', metadata: { go: true } });
  if (!r.ok) throw new Error(r.message);
  closeRun(h.db, run.runId, NOW);
  return { instanceId: w.instance.instanceId, a };
}

describe('retrying a faulted routing', () => {
  it('reconciles a faulted instance, clearing its mark, its decisions on the member whose settling decided', async () => {
    const { instanceId, a } = await faulted();
    h.db.exec('DROP TRIGGER boom');
    expect(b.service.retryRouting()).toBe(1);
    expect(getInstance(h.db, instanceId)?.routingFailedAt).toBeNull();
    const made = membersOf(h.db, instanceId).find((m) => m.step === 'b');
    expect(eventsOf(h.db, a).filter((e) => e.kind === 'workflow_routed').map((e) => e.payload)).toEqual([
      { workflow: instanceId, workflowName: 'flow', step: 'a', cause: 'reconciled', decisions: [{ step: 'b', outcome: 'made', why: 'a.go is true', taskIds: [made?.taskId] }] },
    ]);
    expect(b.service.retryRouting()).toBe(0);
  });

  it('tries an instance still faulted at most once a minute, keeping its mark', async () => {
    const { instanceId } = await faulted();
    expect(b.service.retryRouting()).toBe(0);
    expect(getInstance(h.db, instanceId)?.routingFailedAt).toBe(NOW);
    h.db.exec('DROP TRIGGER boom');
    clock.advance(59_000);
    expect(b.service.retryRouting()).toBe(0);
    clock.advance(1_000);
    expect(b.service.retryRouting()).toBe(1);
    expect(getInstance(h.db, instanceId)?.routingFailedAt).toBeNull();
  });

  it('decides nothing twice: a second reconciliation writes no row and no event, and one whose commit found the database busy is retried whole', async () => {
    const { instanceId } = await faulted();
    h.db.exec('DROP TRIGGER boom');
    const count = (from: string) => (h.db.prepare(`SELECT count(*) AS n FROM ${from}`).get() as { n: number }).n;
    const counts = () => ['kanban_tasks', 'kanban_workflow_settled', 'kanban_workflow_pending', "kanban_events WHERE kind = 'workflow_routed'", 'kanban_events'].map(count);
    const exec = h.db.exec.bind(h.db);
    let busy = 1;
    const spy = vi.spyOn(h.db, 'exec').mockImplementation((sql: string) => {
      if (sql === 'COMMIT' && busy-- > 0) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      return exec(sql);
    });
    const before = counts();
    try {
      expect(b.service.reconcileWorkflow(instanceId)).toMatchObject({ ok: true, decisions: [{ step: 'b', outcome: 'made' }] });
    } finally {
      spy.mockRestore();
    }
    expect(busy).toBe(-1);
    // One task, one settled row, one routing event: what a single reconciliation writes, the task's own created event beside it.
    expect(counts().map((n, i) => n - (before[i] ?? 0))).toEqual([1, 1, 0, 1, 2]);
    const after = counts();
    expect(b.service.reconcileWorkflow(instanceId)).toMatchObject({ ok: true, decisions: [] });
    expect(counts()).toEqual(after);
  });

  it('reconciles an instance with nothing due to no decision, and refuses one that does not exist', () => {
    const w = madeOf(b.service.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
    expect(b.service.reconcileWorkflow(w.instance.instanceId)).toMatchObject({ ok: true, decisions: [] });
    expect(b.service.reconcileWorkflow('w_nope')).toEqual({ ok: false, code: 'not_found', message: 'no workflow instance w_nope' });
  });
});

describe("the dispatcher's pass", () => {
  it("calls the service's routing hook once a pass", () => {
    const d = dispatchHarness();
    try {
      const retry = vi.spyOn(d.service, 'retryRouting');
      d.dispatcher.pass();
      d.dispatcher.pass();
      expect(retry).toHaveBeenCalledTimes(2);
    } finally {
      d.close();
    }
  });
});
```

- [ ] **Step 17.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-retry.test.ts`. Expected: `Tests  5 failed (5)`, the first as `TypeError: b.service.retryRouting is not a function`.

- [ ] **Step 17.3: Implement.**

In `src/db/kanban-read.ts`, replace:

```ts
}

/**
 * A task's member row and its instance, for an instance with a plan (§9.2 step
```

with:

```ts
}

/** The instances whose routing faulted and no reconciliation has cleared since, oldest fault first (§9.4). */
export function routingFaulted(db: Db): string[] {
  if (!hasRouting(db)) return [];
  return db
    .prepare<[], { instance_id: string }>('SELECT instance_id FROM kanban_workflow_instances WHERE routing_failed_at IS NOT NULL ORDER BY routing_failed_at, instance_id')
    .all()
    .map((r) => r.instance_id);
}

/**
 * A task's member row and its instance, for an instance with a plan (§9.2 step
```

In `src/db/kanban.ts`, replace:

```ts
  membersWithTasks,
```

with:

```ts
  membersWithTasks,
  memberOf,
```

In `src/db/kanban.ts`, replace:

```ts
      payload: { workflow: planned.instance.instanceId, workflowName: planned.instance.name, step: planned.member.step, cause, decisions: lines },
    },
    now,
  );
}
```

with:

```ts
      payload: { workflow: planned.instance.instanceId, workflowName: planned.instance.name, step: planned.member.step, cause, decisions: lines },
    },
    now,
  );
}

/** A reconciliation's answer (§11): the instance, and each decision it made. */
export interface Reconciled {
  instance: InstanceRow;
  decisions: RoutedLine[];
}

/**
 * The member a reconciliation's `workflow_routed` goes on (§11): the
 * latest-settled ancestor its first decision's step reads, so the notice reaches
 * the instance's chat as any would; the first member when none has a task.
 */
function reconciledOn(d: Db, r: Routed, step: string): string | undefined {
  const parents = new Map(r.plan.steps.map((s) => [s.step, s.parents]));
  const ancestors = new Set<string>();
  const walk = (name: string): void => {
    for (const p of parents.get(name) ?? []) {
      if (ancestors.has(p)) continue;
      ancestors.add(p);
      walk(p);
    }
  };
  walk(step);
  const latest = settledOf(d, r.instance.instanceId)
    .filter((x) => ancestors.has(x.step) && x.taskId !== null)
    .sort((a, b) => b.eventId - a.eventId)[0];
  return latest?.taskId ?? r.members[0]?.taskId;
}

/**
 * Reconcile an instance (§11): the routing given no transitioning task, in one
 * transaction of its own, deciding what is due and making it, its
 * `workflow_routed` on the member whose settling decided the first decision;
 * and its fault mark cleared, as it succeeded. The keys of §9.2 make one that
 * races the gateway decide nothing twice. A fault is thrown: nothing is written,
 * and the mark stays.
 */
export function reconcileWorkflow(db: Db, instanceId: string, now: number, team?: RouteTeam): Result<Reconciled> {
  return tx(db, (d) => {
    const instance = getInstance(d, instanceId);
    if (instance === undefined) return refuse('not_found', `no workflow instance ${instanceId}`);
    const r = routedOf(d, instance);
    if (r === undefined) return { ok: true, instance, decisions: [] };
    const decisions = decideAll(d, instance, null, now, team);
    const first = decisions[0];
    const on = first === undefined ? undefined : reconciledOn(d, routedOf(d, instance) as Routed, first.step);
    if (on !== undefined) {
      record(
        d,
        {
          taskId: on,
          kind: 'workflow_routed',
          actor: 'gateway',
          payload: { workflow: instanceId, workflowName: instance.name, step: memberOf(d, on)?.step ?? null, cause: 'reconciled', decisions },
        },
        now,
      );
    }
    d.prepare('UPDATE kanban_workflow_instances SET routing_failed_at = NULL WHERE instance_id = ?').run(instanceId);
    return { ok: true, instance: getInstance(d, instanceId) as InstanceRow, decisions };
  });
}
```

In `src/kanban/dispatcher.ts`, replace:

```ts
    this.#cancelDecided();
```

with:

```ts
    this.#cancelDecided();
    // The routing's one hook (workflow routing spec §9.4): the dispatcher reads no workflow table itself.
    try {
      this.#deps.service.retryRouting();
    } catch (err) {
      this.#note(`kanban: retrying a workflow's routing failed: ${message(err)}`);
    }
```

In `src/kanban/service.ts`, replace:

```ts
  reactsTo,
```

with:

```ts
  reactsTo,
  routingFaulted,
```

In `src/kanban/service.ts`, replace:

```ts

/** How long `unknown_workflow`'s message may be, in bytes: a gate refusal's output's size (workflows spec §6). */
```

with:

```ts

/** How often a faulted instance's routing is retried, at most (workflow routing spec §9.4). */
export const RETRY_ROUTING_MS = 60_000;

/** How long `unknown_workflow`'s message may be, in bytes: a gate refusal's output's size (workflows spec §6). */
```

In `src/kanban/service.ts`, replace:

```ts
  readonly #reporting = new Map<string, { workspace: string | null; done: Promise<unknown> }>();
```

with:

```ts
  readonly #reporting = new Map<string, { workspace: string | null; done: Promise<unknown> }>();
  /** When each faulted instance's routing was last retried, in this process (workflow routing spec §9.4); not stored. */
  readonly #retried = new Map<string, number>();
```

In `src/kanban/service.ts`, replace:

```ts

  /** Who the next claim is for, resolved against the team as it is now. */
```

with:

```ts

  /**
   * Reconcile an instance (workflow routing spec §11): what is due decided and
   * made, in a transaction of its own, against the team as it is now.
   */
  reconcileWorkflow(instanceId: string): Result<board.Reconciled> {
    if (!isText(instanceId)) return board.refuse('invalid', 'an instance id is text');
    return board.reconcileWorkflow(this.#db, instanceId, this.#clock.now(), this.#facts());
  }

  /**
   * The dispatcher's hook (workflow routing spec §9.4): every instance whose routing
   * faulted reconciled, each at most once a minute; a reconciliation that faults
   * again leaves its mark for the next. Answers how many were reconciled. The
   * time each was last tried is this process's: after a restart, the startup's
   * reconciliation tries every one.
   */
  retryRouting(): number {
    const now = this.#clock.now();
    let reconciled = 0;
    for (const id of routingFaulted(this.#db)) {
      const last = this.#retried.get(id);
      if (last !== undefined && now - last < RETRY_ROUTING_MS) continue;
      this.#retried.set(id, now);
      try {
        if (this.reconcileWorkflow(id).ok) reconciled += 1;
      } catch {
        // Still faulted: its mark stays, and the next pass after a minute tries again.
      }
    }
    return reconciled;
  }

  /** Who the next claim is for, resolved against the team as it is now. */
```

- [ ] **Step 17.4: Run them to verify they pass.** Run the same command. Expected: `Tests  5 passed (5)`.

- [ ] **Step 17.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3669 passed (3669)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 17.6: Commit.**

```bash
git add src/db/kanban-read.ts src/db/kanban.ts src/kanban/dispatcher.ts src/kanban/service.ts tests/routing-retry.test.ts
git commit -m "Retry a faulted routing on the dispatcher's pass, at most once a minute an instance, by reconciling it"
```

---

### Task 18: The instance's status

**Files:**

- Create: `tests/routing-status.test.ts`
- Modify: `src/db/kanban-read.ts`, `src/kanban/service.ts`, `src/kanban/workflow.ts`

§12.4. `instanceStatus` takes the steps not made, a waiting step and a skipped step not yet settled one unfinished each, a skipped step settled finished; `instances` keeps its one aggregate query of phases and adds one over the pending rows, `unmadeSteps`; `instance` counts them with `unmadeOf`.

- [ ] **Step 18.1: Write the tests.**

Create `tests/routing-status.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { instanceStatus } from '../src/kanban/workflow.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * A routed instance's status (workflow routing spec §12.4): a waiting step, and
 * a skipped step not yet settled, one unfinished each, so the instance is never
 * done while one is; a skipped step, settled, finished; members and unmade steps
 * counted together; the same from `instances`' aggregate and from `instance`.
 */

describe('instanceStatus with steps not made', () => {
  it('counts a waiting step and an unsettled skip as unfinished, and a settled skip as finished', () => {
    expect(instanceStatus(['done'], { waiting: 1, skippedUnsettled: 0, skippedSettled: 0 })).toEqual({ status: 'running', done: 1, total: 2, blocked: 0 });
    expect(instanceStatus(['done'], { waiting: 0, skippedUnsettled: 1, skippedSettled: 0 })).toEqual({ status: 'running', done: 1, total: 2, blocked: 0 });
    expect(instanceStatus(['done', 'archived'], { waiting: 0, skippedUnsettled: 0, skippedSettled: 2 })).toEqual({ status: 'done', done: 4, total: 4, blocked: 0 });
    expect(instanceStatus(['blocked'], { waiting: 3, skippedUnsettled: 0, skippedSettled: 0 })).toEqual({ status: 'blocked', done: 0, total: 4, blocked: 1 });
    expect(instanceStatus(['done'])).toEqual({ status: 'done', done: 1, total: 1, blocked: 0 });
  });
});

describe("a routed instance's status", () => {
  let h: TestDb;
  let b: ViBoard;
  beforeEach(() => {
    clearSecrets();
    h = testDb();
    b = viBoard(h);
    writeFileSync(
      join(b.dir, 'flow.yaml'),
      'board: vi\nsteps:\n  a:\n    title: a\n    assignee: vi-coordinator\n    outputs: { go: boolean }\n  b:\n    title: b\n    assignee: verifier\n    parents: [a]\n    when: [{ step: a, output: go, is: true }]\n',
    );
  });
  afterEach(() => h.close());

  it('is running while a step waits, and done once it is skipped and settled, in instance and instances alike', async () => {
    const w = madeOf(b.service.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
    const id = w.instance.instanceId;
    expect(b.service.instance(id)).toMatchObject({ ok: true, view: { status: 'running', done: 0, total: 2 } });
    expect(b.service.instances('vi').instances.map((s) => [s.status, s.done, s.total])).toEqual([['running', 0, 2]]);
    const a = w.tasks[0]?.taskId ?? '';
    const run = claimed(h.db, a);
    expect((await b.service.complete(a, { kind: 'run', runId: run.runId }, { summary: 'no', metadata: { go: false } })).ok).toBe(true);
    closeRun(h.db, run.runId, NOW);
    expect(b.service.instance(id)).toMatchObject({ ok: true, view: { status: 'done', done: 2, total: 2 } });
    expect(b.service.instances('vi', true).instances.map((s) => [s.status, s.done, s.total])).toEqual([['done', 2, 2]]);
  });
});
```

- [ ] **Step 18.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-status.test.ts`. Expected: `Tests  2 failed (2)`, the first as `AssertionError: expected { status: 'done', done: 1, …(2) } to deeply equal { status: 'running', done: 1, …(2) }`.

- [ ] **Step 18.3: Implement.**

In `src/db/kanban-read.ts`, replace:

```ts
/**
 * The instance a task is a member of, with the instance's workflow name, for
```

with:

```ts
/**
 * The steps not made of a board's newest `limit` instances (workflow routing spec
 * §12.4), as `memberPhases` reads their members, in one aggregate query over the
 * pending rows: by instance, how many wait, and how many were skipped, settled
 * or not. An instance with no pending row is absent; none on a database before 015.
 */
export function unmadeSteps(db: Db, board: string, limit: number): Map<string, { waiting: number; skippedUnsettled: number; skippedSettled: number }> {
  const out = new Map<string, { waiting: number; skippedUnsettled: number; skippedSettled: number }>();
  if (!hasRouting(db)) return out;
  const rows = db
    .prepare<[string, number], { instance_id: string; waiting: number; unsettled: number; settled: number }>(
      `SELECT p.instance_id,
              sum(p.state = 'waiting') AS waiting,
              sum(p.state = 'skipped' AND s.ref IS NULL) AS unsettled,
              sum(p.state = 'skipped' AND s.ref IS NOT NULL) AS settled
         FROM kanban_workflow_pending p
         LEFT JOIN kanban_workflow_settled s ON s.instance_id = p.instance_id AND s.step = p.step AND s.ref = p.step
        WHERE p.instance_id IN (SELECT instance_id FROM kanban_workflow_instances WHERE board = ?
                                 ORDER BY created_at DESC, rowid DESC LIMIT ?)
        GROUP BY p.instance_id`,
    )
    .all(board, limit);
  for (const r of rows) out.set(r.instance_id, { waiting: r.waiting, skippedUnsettled: r.unsettled, skippedSettled: r.settled });
  return out;
}

/** An instance's steps not made, as `unmadeSteps` counts them, from its pending and settled rows. */
export function unmadeOf(pending: readonly PendingRow[], settled: readonly SettledRow[]): { waiting: number; skippedUnsettled: number; skippedSettled: number } {
  const own = new Set(settled.filter((s) => s.ref === s.step).map((s) => s.step));
  return {
    waiting: pending.filter((p) => p.state === 'waiting').length,
    skippedUnsettled: pending.filter((p) => p.state === 'skipped' && !own.has(p.step)).length,
    skippedSettled: pending.filter((p) => p.state === 'skipped' && own.has(p.step)).length,
  };
}

/**
 * The instance a task is a member of, with the instance's workflow name, for
```

In `src/kanban/service.ts`, replace:

```ts
  phaseSince,
```

with:

```ts
  phaseSince,
  pendingOf,
```

In `src/kanban/service.ts`, replace:

```ts
  routingFaulted,
```

with:

```ts
  routingFaulted,
  settledOf,
  unmadeOf,
  unmadeSteps,
```

In `src/kanban/service.ts`, replace:

```ts
    const phases = memberPhases(this.#db, onBoard, INSTANCES_READ);
```

with:

```ts
    const phases = memberPhases(this.#db, onBoard, INSTANCES_READ);
    // And one over the pending rows, for a routed instance's steps not made (workflow routing spec §12.4).
    const unmade = unmadeSteps(this.#db, onBoard, INSTANCES_READ);
```

In `src/kanban/service.ts`, replace:

```ts
      ...instanceStatus((phases.get(instance.instanceId) ?? []).flatMap(({ phase, n }) => Array<Phase>(n).fill(phase))),
```

with:

```ts
      ...instanceStatus(
        (phases.get(instance.instanceId) ?? []).flatMap(({ phase, n }) => Array<Phase>(n).fill(phase)),
        unmade.get(instance.instanceId),
      ),
```

In `src/kanban/service.ts`, replace:

```ts
        ...instanceStatus(members.map((m) => m.task.phase)),
```

with:

```ts
        ...instanceStatus(
          members.map((m) => m.task.phase),
          unmadeOf(pendingOf(this.#db, instanceId), settledOf(this.#db, instanceId)),
        ),
```

In `src/kanban/workflow.ts`, replace:

```ts
}

/**
 * An instance's status, derived from its members' phases, never stored (workflows spec
```

with:

```ts
}

/** A routed instance's steps not made (workflow routing spec §12.4): waiting, and skipped, before and after they settled. */
export interface UnmadeSteps {
  waiting: number;
  skippedUnsettled: number;
  skippedSettled: number;
}

const NONE_UNMADE: UnmadeSteps = { waiting: 0, skippedUnsettled: 0, skippedSettled: 0 };

/**
 * An instance's status, derived from its members' phases, never stored (workflows spec
```

In `src/kanban/workflow.ts`, replace:

```ts
 * running, as a blocked task is what a person must act on.
```

with:

```ts
 * running, as a blocked task is what a person must act on. A routed instance's
 * steps not made count too (workflow routing spec §12.4): a waiting step, and a
 * skipped one not yet settled, as one unfinished each, so it is never done while
 * one is; a skipped step settled, as finished; a handler never routed to, as
 * nothing.
```

In `src/kanban/workflow.ts`, replace:

```ts
export function instanceStatus(phases: readonly Phase[]): InstanceState {
  const total = phases.length;
  const done = phases.filter((p) => p === 'done' || p === 'archived').length;
```

with:

```ts
export function instanceStatus(phases: readonly Phase[], unmade: UnmadeSteps = NONE_UNMADE): InstanceState {
  const total = phases.length + unmade.waiting + unmade.skippedUnsettled + unmade.skippedSettled;
  const done = phases.filter((p) => p === 'done' || p === 'archived').length + unmade.skippedSettled;
```

- [ ] **Step 18.4: Run them to verify they pass.** Run the same command. Expected: `Tests  2 passed (2)`.

- [ ] **Step 18.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3671 passed (3671)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 18.6: Commit.**

```bash
git add src/db/kanban-read.ts src/kanban/service.ts src/kanban/workflow.ts tests/routing-status.test.ts
git commit -m "Count a routed instance's waiting and skipped steps in its status, so it is never done while a step waits"
```

---

## Phase 3: result-driven fan-out

Tasks 19 and 20. The fan-out over its source's accepted list, its join, an empty list and a skipped source; and the 500 cap, reserved at the reporting completion, a fan-out past it later skipped whole. Phase 3 ends green, a checkpoint to review at.

---

### Task 19: Result-driven fan-out and the join

**Files:**

- Create: `tests/routing-decide-fanout.test.ts`, `tests/routing-fanout-writer.test.ts`
- Modify: `src/kanban/routing.ts`

§4. `decide` fans a step out over its source's accepted list, once its source and parents are settled, one item a task in the list's order, trimmed; an empty list, a list of the wrong type, or a skipped or archived source skip it; a source stood in for fans out from the stand-in's list. The writer makes every item in one transaction, refs `<step>:<n>`, the pending row its join marker, and the sweep writes the fan-out's own row once every item has its own, `archived` when every item was archived undone; the join's child is decided then, linked to each item's winner. An item done and then archived is still linked, its row done.

- [ ] **Step 19.1: Write the tests.**

Create `tests/routing-decide-fanout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decide, INSTANCE_CAP, type Facts, type Plan, type PlanStep, type SettledFact, type StepFact, type Template } from '../src/kanban/routing.js';

/**
 * decide's result fan-out and its join (workflow routing spec §4): one task an
 * item of the source's accepted list, in its order; an empty list, or a skipped
 * or archived source, skipping it; a source stood in for fanning out from the
 * stand-in's list; the join's child decided only once the fan-out's own row is
 * there, linked to each item's winner and to none archived undone; and a
 * fan-out made whole or not at all at the cap.
 */

const TEMPLATE: Template = {
  title: 'each {{item}}',
  body: null,
  assignee: 'worker',
  reviewer: null,
  workspace: null,
  priority: 0,
  contract: {},
  failure_limit: null,
  retry_on_crash: 'always',
  max_runtime_s: null,
  gates: [],
  wake: null,
};

function step(name: string, parents: string[], extra: Partial<PlanStep> = {}): PlanStep {
  return { step: name, made: parents.length === 0 ? 'start' : 'decide', parents, outputs: {}, on_blocked: 'wait', on_gave_up: 'wait', template: TEMPLATE, ...extra };
}

/** intake, a root with a list; mid, its child; each, a fan-out over intake's list below mid; join, below each. */
const PLAN: Plan = {
  format: 1,
  steps: [
    step('intake', [], { outputs: { packages: { list: 'string', max: 100 }, scores: { list: 'number', max: 3 } } }),
    step('mid', ['intake']),
    step('each', ['mid'], { for_each: { step: 'intake', output: 'packages' } }),
    step('join', ['each']),
  ],
};

function fact(name: string, over: Partial<StepFact> = {}): StepFact {
  return { step: name, row: null, skippedBy: null, settled: null, items: new Map(), entered: { blocked: false, gaveUp: false }, result: null, ...over };
}

const DONE = (taskId: string, eventId: number): SettledFact => ({ how: 'done', taskId, eventId });

function facts(list: StepFact[], members = 2): Facts {
  return { steps: new Map(list.map((f) => [f.step, f])), due: [], members, cap: INSTANCE_CAP };
}

/** The facts once intake settled as given, and mid is done. */
function settledIntake(intake: Partial<StepFact>, members = 2): Facts {
  return facts([fact('intake', intake), fact('mid', { row: 'made', settled: DONE('k_mid', 9) }), fact('each', { row: 'waiting' }), fact('join', { row: 'waiting' })], members);
}

describe("a fan-out over a result", () => {
  it("makes one task an item, in the list's order, linked to its parents, once its source and parents are settled", () => {
    expect(decide(PLAN, settledIntake({ settled: DONE('k_i', 4), result: { packages: ['lodash', ' minimist ', 'qs'] } }))).toEqual([
      { step: 'each', outcome: 'fanned_out', items: ['lodash', 'minimist', 'qs'], parents: ['k_mid'], why: 'per item of intake.packages' },
    ]);
    const unsettledSource = facts([fact('intake'), fact('mid', { row: 'made', settled: DONE('k_mid', 9) }), fact('each', { row: 'waiting' }), fact('join', { row: 'waiting' })]);
    expect(decide(PLAN, unsettledSource)).toEqual([]);
  });

  it('writes numbers and booleans as JSON writes them', () => {
    const p: Plan = { ...PLAN, steps: PLAN.steps.map((s) => (s.step === 'each' ? { ...s, for_each: { step: 'intake', output: 'scores' } } : s)) };
    expect(decide(p, settledIntake({ settled: DONE('k_i', 4), result: { scores: [7, 9.5] } }))[0]).toMatchObject({ items: ['7', '9.5'] });
  });

  it('skips on an empty list, a skipped or archived source, and a list of the wrong type', () => {
    expect(decide(PLAN, settledIntake({ settled: DONE('k_i', 4), result: { packages: [] } }))).toEqual([
      { step: 'each', outcome: 'skipped', by: 'source', why: 'intake.packages is empty' },
    ]);
    expect(decide(PLAN, settledIntake({ settled: { how: 'skipped', taskId: null, eventId: 4 } }))).toEqual([
      { step: 'each', outcome: 'skipped', by: 'source', why: 'intake was skipped' },
    ]);
    expect(decide(PLAN, settledIntake({ settled: { how: 'archived', taskId: null, eventId: 4 } }))).toEqual([
      { step: 'each', outcome: 'skipped', by: 'source', why: 'intake was archived' },
    ]);
    expect(decide(PLAN, settledIntake({ settled: DONE('k_i', 4), result: { packages: 'lodash' } }))).toEqual([
      { step: 'each', outcome: 'skipped', by: 'source', why: 'intake.packages is missing' },
    ]);
  });

  it("fans out from a stand-in's accepted list, and from a source done and archived later", () => {
    expect(decide(PLAN, settledIntake({ settled: { how: 'stood_in', taskId: 'k_s', eventId: 6 }, result: { packages: ['qs'] } }))[0]).toMatchObject({
      outcome: 'fanned_out',
      items: ['qs'],
    });
    // Done, then archived: its row says done, as the archive came after its accepted completion.
    expect(decide(PLAN, settledIntake({ settled: DONE('k_i', 4), result: { packages: ['qs'] } }))[0]).toMatchObject({ outcome: 'fanned_out' });
  });

  it('makes none of its items past the cap, never a part', () => {
    expect(decide(PLAN, settledIntake({ settled: DONE('k_i', 4), result: { packages: Array.from({ length: 60 }, (_, i) => `p${i}`) } }, 450))).toEqual([
      { step: 'each', outcome: 'skipped', by: 'cap', why: 'the instance has 500 tasks' },
    ]);
    expect(decide(PLAN, settledIntake({ settled: DONE('k_i', 4), result: { packages: Array.from({ length: 50 }, (_, i) => `p${i}`) } }, 450))[0]?.outcome).toBe('fanned_out');
  });
});

describe('the join', () => {
  const items = (rows: Array<[string, SettledFact]>) => new Map(rows);

  it("decides the join's child only once the fan-out's own row is there, linked to each item's winner, none archived undone", () => {
    const partial = facts([
      fact('intake', { settled: DONE('k_i', 4) }),
      fact('mid', { row: 'made', settled: DONE('k_mid', 9) }),
      fact('each', { row: 'made', items: items([['each:1', DONE('k_1', 11)], ['each:2', { how: 'archived', taskId: null, eventId: 12 }]]) }),
      fact('join', { row: 'waiting' }),
    ]);
    expect(decide(PLAN, partial)).toEqual([]);
    const whole = facts([
      fact('intake', { settled: DONE('k_i', 4) }),
      fact('mid', { row: 'made', settled: DONE('k_mid', 9) }),
      fact('each', {
        row: 'made',
        settled: { how: 'done', taskId: null, eventId: 13 },
        items: items([
          ['each:1', DONE('k_1', 11)],
          ['each:2', { how: 'archived', taskId: null, eventId: 12 }],
          ['each:3', { how: 'stood_in', taskId: 'k_h', eventId: 13 }],
        ]),
      }),
      fact('join', { row: 'waiting' }),
    ]);
    expect(decide(PLAN, whole)).toEqual([{ step: 'join', outcome: 'made', parents: ['k_1', 'k_h'], why: 'its parents are settled' }]);
  });

  it('skips by archive the child of a fan-out whose items were all archived undone', () => {
    const archived = facts([
      fact('intake', { settled: DONE('k_i', 4) }),
      fact('mid', { row: 'made', settled: DONE('k_mid', 9) }),
      fact('each', { row: 'made', settled: { how: 'archived', taskId: null, eventId: 12 }, items: items([['each:1', { how: 'archived', taskId: null, eventId: 12 }]]) }),
      fact('join', { row: 'waiting' }),
    ]);
    expect(decide(PLAN, archived)).toEqual([{ step: 'join', outcome: 'skipped', by: 'archive', why: 'its parents were archived' }]);
  });
});
```

Create `tests/routing-fanout-writer.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, getTask, membersOf, parentsOf, pendingOf, settledOf } from '../src/db/kanban-read.js';
import type { WorkflowMade } from '../src/kanban/service.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * A result fan-out in the writer (workflow routing spec §4): its items made in
 * the transaction that settled their source, all at once, refs `<step>:<n>`,
 * each item in its member row and its title, the pending row their join marker;
 * the fan-out's own row written only once every item has its own; and the join's
 * child made then, linked to each item's winner and to none archived undone,
 * but to one done and then archived, its row done.
 */

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  b = viBoard(h);
});
afterEach(() => h.close());

const SUPPLY = { kind: 'supplychain', verify: false, patch: false, bnpm: true, packages: ['lodash', 'minimist', 'qs'] };

function start(): WorkflowMade {
  return madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
}

async function done(taskId: string, metadata: Record<string, unknown> = {}): Promise<void> {
  const run = claimed(h.db, taskId);
  const r = await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'did it', metadata });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  closeRun(h.db, run.runId, NOW);
}

const stepOf = (id: string, step: string) => membersOf(h.db, id).filter((m) => m.step === step);

describe('a result fan-out in the writer', () => {
  it("fans out one task an item of the intake's list in its transaction, with the join marker, and the items in one notice", async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    await done(intake, SUPPLY);
    const items = stepOf(w.instance.instanceId, 'exposure');
    expect(items.map((m) => [m.ref, m.item])).toEqual([
      ['exposure:1', 'lodash'],
      ['exposure:2', 'minimist'],
      ['exposure:3', 'qs'],
    ]);
    expect(items.map((m) => getTask(h.db, m.taskId)?.title)).toEqual(['CVE-1 · exposure of lodash', 'CVE-1 · exposure of minimist', 'CVE-1 · exposure of qs']);
    // va was skipped, and settled with intake: the items are linked to its effective parent, intake.
    expect(items.map((m) => parentsOf(h.db, m.taskId).map((p) => p.taskId))).toEqual([[intake], [intake], [intake]]);
    expect(pendingOf(h.db, w.instance.instanceId).find((p) => p.step === 'exposure')).toMatchObject({
      state: 'made',
      items: items.map((m) => ({ item: m.item, taskId: m.taskId, ref: m.ref })),
    });
    const routed = eventsOf(h.db, intake).find((e) => e.kind === 'workflow_routed')?.payload as { decisions: unknown[] };
    expect(routed.decisions).toContainEqual({
      step: 'exposure',
      outcome: 'fanned_out',
      why: 'per item of intake.packages',
      taskIds: items.map((m) => m.taskId),
      items: ['lodash', 'minimist', 'qs'],
      count: 3,
    });
  });

  it("writes the fan-out's own row only after every item's, and makes the join's child then, linked to each item but one archived undone", async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    await done(intake, SUPPLY);
    const id = w.instance.instanceId;
    const [one, two, three] = stepOf(id, 'exposure').map((m) => m.taskId);
    const registry = stepOf(id, 'registry')[0]?.taskId ?? '';
    await done(registry);
    await done(one ?? '');
    expect(b.service.archive(two ?? '', ALICE).ok).toBe(true);
    expect(settledOf(h.db, id).filter((s) => s.step === 'exposure').map((s) => [s.ref, s.how])).toEqual([
      ['exposure:1', 'done'],
      ['exposure:2', 'archived'],
    ]);
    expect(stepOf(id, 'report')).toEqual([]);
    await done(three ?? '');
    expect(settledOf(h.db, id).filter((s) => s.step === 'exposure').map((s) => [s.ref, s.how, s.taskId])).toEqual([
      ['exposure', 'done', null],
      ['exposure:1', 'done', one],
      ['exposure:2', 'archived', null],
      ['exposure:3', 'done', three],
    ]);
    const report = stepOf(id, 'report')[0]?.taskId ?? '';
    expect(parentsOf(h.db, report).map((p) => p.taskId).sort()).toEqual([intake, one, three, registry].sort());
  });

  it("links the join's child to an item done and then archived, its row done", async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    await done(intake, { ...SUPPLY, bnpm: false, packages: ['lodash', 'qs'] });
    const id = w.instance.instanceId;
    const [one, two] = stepOf(id, 'exposure').map((m) => m.taskId);
    await done(one ?? '');
    expect(b.service.archive(one ?? '', ALICE).ok).toBe(true);
    await done(two ?? '');
    expect(settledOf(h.db, id).filter((s) => s.step === 'exposure').map((s) => [s.ref, s.how, s.taskId])).toEqual([
      ['exposure', 'done', null],
      ['exposure:1', 'done', one],
      ['exposure:2', 'done', two],
    ]);
    const report = stepOf(id, 'report')[0]?.taskId ?? '';
    expect(parentsOf(h.db, report).map((p) => [p.taskId, p.phase]).sort()).toEqual(
      [
        [intake, 'done'],
        [one, 'archived'],
        [two, 'done'],
      ].sort(),
    );
  });

  it('skips the fan-out on an empty list, and its child is linked past it', async () => {
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    await done(intake, { ...SUPPLY, bnpm: false, packages: [] });
    const id = w.instance.instanceId;
    expect(pendingOf(h.db, id).find((p) => p.step === 'exposure')).toMatchObject({ state: 'skipped', reason: { by: 'source', why: 'intake.packages is empty' } });
    // Every parent of report was skipped, va's and exposure's back to intake: report is made, linked to it.
    const report = stepOf(id, 'report')[0]?.taskId ?? '';
    expect(parentsOf(h.db, report).map((p) => p.taskId)).toEqual([intake]);
  });
});
```

- [ ] **Step 19.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-decide-fanout.test.ts tests/routing-fanout-writer.test.ts`. Expected: `Tests  9 failed | 2 passed (11)`, the first as `AssertionError: expected [] to deeply equal [ { step: 'each', …(4) } ]`.

- [ ] **Step 19.3: Implement.**

In `src/kanban/routing.ts`, replace:

```ts

/** How many tasks a pending step's making is: its list param's items, or one. */
function tasksOf(s: PlanStep): number {
  return s.templates?.length ?? 1;
}

```

with:

```ts

```

In `src/kanban/routing.ts`, replace:

```ts
    if (fact.row !== 'waiting') continue;
    // A fan-out over a result waits: this build does not yet read its source's list.
    if (s.for_each !== undefined && 'step' in s.for_each) continue;
```

with:

```ts
    if (fact.row !== 'waiting') continue;
```

In `src/kanban/routing.ts`, replace:

```ts
    if (!waited.every((p) => facts.steps.get(p)?.settled != null)) continue;
```

with:

```ts
    if (!waited.every((p) => facts.steps.get(p)?.settled != null)) continue;
    // A fan-out over a result waits for its source too, which may be an ancestor above its parents (§4.1).
    const source = s.for_each !== undefined && 'step' in s.for_each ? s.for_each : undefined;
    const from = source === undefined ? undefined : facts.steps.get(source.step)?.settled;
    if (source !== undefined && (from === undefined || from === null)) continue;
```

In `src/kanban/routing.ts`, replace:

```ts
    const why = s.when === undefined ? 'its parents are settled' : whenText(s.when);
```

with:

```ts
    let items: string[] | undefined = s.templates?.map((t) => t.item);
    if (source !== undefined && from !== undefined && from !== null) {
      // The logical step's accepted list, its own task's or a stand-in's, never its task's phase (§4.1).
      if (!accepted(from)) {
        out.push({ step: s.step, outcome: 'skipped', by: 'source', why: `${source.step} was ${from.how === 'archived' ? 'archived' : 'skipped'}` });
        continue;
      }
      const list = resultOf(plan, facts, source.step, source.output);
      const ref = `${source.step}.${source.output}`;
      if (!Array.isArray(list)) {
        out.push({ step: s.step, outcome: 'skipped', by: 'source', why: `${ref} is missing` });
        continue;
      }
      if (list.length === 0) {
        out.push({ step: s.step, outcome: 'skipped', by: 'source', why: `${ref} is empty` });
        continue;
      }
      items = (list as Array<boolean | number | string>).map(itemText);
    }
    const why = s.when === undefined ? (source === undefined ? 'its parents are settled' : `per item of ${source.step}.${source.output}`) : whenText(s.when);
```

In `src/kanban/routing.ts`, replace:

```ts
    const count = tasksOf(s);
```

with:

```ts
    // A fan-out is made whole or not at all (§9.4).
    const count = items?.length ?? 1;
```

In `src/kanban/routing.ts`, replace:

```ts
    if (s.templates !== undefined) out.push({ step: s.step, outcome: 'fanned_out', items: s.templates.map((t) => t.item), parents, why });
```

with:

```ts
    if (items !== undefined) out.push({ step: s.step, outcome: 'fanned_out', items, parents, why });
```

- [ ] **Step 19.4: Run them to verify they pass.** Run the same command. Expected: `Tests  11 passed (11)`.

- [ ] **Step 19.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3682 passed (3682)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 19.6: Commit.**

```bash
git add src/kanban/routing.ts tests/routing-decide-fanout.test.ts tests/routing-fanout-writer.test.ts
git commit -m "Fan out a step over its source's accepted list, skipped for an empty list or a skipped source, and decide its join once every item is settled"
```

---

### Task 20: The cap

**Files:**

- Create: `tests/routing-cap.test.ts`
- Modify: `src/kanban/service.ts`

§2.2, §9.4. The service reserves the instance's 500 at the report whose list a fan-out reads, `too_large` naming the list's tasks and the instance's count; and `decide`'s cap, from Task 11, skips a fan-out whole when its making would pass 500 at an approval, the approval committed.

- [ ] **Step 20.1: Write the tests.**

Create `tests/routing-cap.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, getTask, membersOf, pendingOf } from '../src/db/kanban-read.js';
import type { WorkflowMade } from '../src/kanban/service.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { VI_WORKFLOW, madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * The instance's 500 tasks (workflow routing spec §2.2, §9.4): reserved at the
 * report whose list a fan-out will read, `too_large` while the agent can still
 * shorten it; and, past it later, at a reviewer's approval, the fan-out skipped
 * whole with its notice, the approval committed, never refused.
 */

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  b = viBoard(h);
});
afterEach(() => h.close());

function start(): WorkflowMade {
  return madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
}

/** `n` more members of the instance, written as rows: tasks the instance made, which nothing here reads but the count. */
function fill(instanceId: string, n: number): void {
  const task = h.db.prepare(
    `INSERT INTO kanban_tasks (task_id, title, contract, phase, created_by, created_via, created_at, board)
     VALUES (?, 'filler', jsonb('{}'), 'open', ?, jsonb('{"kind":"operator"}'), ?, 'vi')`,
  );
  const member = h.db.prepare("INSERT INTO kanban_workflow_tasks (task_id, instance_id, ref, step, item, position) VALUES (?, ?, ?, 'filler', NULL, ?)");
  const base = membersOf(h.db, instanceId).length;
  for (let i = 0; i < n; i += 1) {
    task.run(`k_fill${i}`, ALICE, NOW);
    member.run(`k_fill${i}`, instanceId, `filler:${i + 1}`, base + i);
  }
}

const packages = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
const OUTPUTS = { kind: 'supplychain', verify: false, patch: false, bnpm: false };

describe('the cap', () => {
  it('is reserved at the reporting completion, too_large while the list can be shortened', async () => {
    const w = start();
    fill(w.instance.instanceId, 470);
    const intake = w.tasks[0]?.taskId ?? '';
    const run = claimed(h.db, intake);
    const by = { kind: 'run', runId: run.runId } as const;
    expect(await b.service.complete(intake, by, { summary: 'x', metadata: { ...OUTPUTS, packages: packages(63) } })).toEqual({
      ok: false,
      code: 'too_large',
      message: `output packages would make 63 tasks, and instance ${w.instance.instanceId} has 471 of its 500`,
    });
    expect((await b.service.complete(intake, by, { summary: 'x', metadata: { ...OUTPUTS, packages: packages(3) } })).ok).toBe(true);
    expect(membersOf(h.db, w.instance.instanceId).filter((m) => m.step === 'exposure').length).toBe(3);
  });

  it('skips a fan-out whole past the cap at a reviewer\'s approval, with its notice, the approval committed', async () => {
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW.replace('    assignee: vi-coordinator\n    outputs:', '    assignee: vi-coordinator\n    reviewer: verifier\n    outputs:'));
    const w = start();
    const intake = w.tasks[0]?.taskId ?? '';
    const run = claimed(h.db, intake);
    expect((await b.service.complete(intake, { kind: 'run', runId: run.runId }, { summary: 'x', metadata: { ...OUTPUTS, packages: packages(30) } })).ok).toBe(true);
    closeRun(h.db, run.runId, NOW);
    fill(w.instance.instanceId, 479);
    const review = claimed(h.db, intake);
    expect(await b.service.complete(intake, { kind: 'run', runId: review.runId }, { summary: 'LGTM' })).toMatchObject({ ok: true, task: { phase: 'done' } });
    expect(getTask(h.db, intake)?.phase).toBe('done');
    expect(membersOf(h.db, w.instance.instanceId).filter((m) => m.step === 'exposure')).toEqual([]);
    expect(pendingOf(h.db, w.instance.instanceId).find((p) => p.step === 'exposure')).toMatchObject({ state: 'skipped', reason: { by: 'cap', why: 'the instance has 500 tasks' } });
    const routed = eventsOf(h.db, intake).find((e) => e.kind === 'workflow_routed')?.payload as { decisions: unknown[] };
    expect(routed.decisions).toContainEqual({ step: 'exposure', outcome: 'skipped', why: 'the instance has 500 tasks', taskIds: [], by: 'cap' });
  });
});
```

- [ ] **Step 20.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-cap.test.ts`. Expected: `Tests  1 failed | 1 passed (2)`, the first as `AssertionError: expected { ok: true, task: { …(34) }, …(1) } to deeply equal { ok: false, code: 'too_large', …(1) }`.

- [ ] **Step 20.3: Implement.**

In `src/kanban/service.ts`, replace:

```ts
  memberPhases,
```

with:

```ts
  memberPhases,
  membersOf,
```

In `src/kanban/service.ts`, replace:

```ts
import { checkOutputs, fillText, itemPlaceholderOf, outputBounds, placeholderOf, standInContract, type Plan, type PlanStep, type Template } from './routing.js';
```

with:

```ts
import { checkOutputs, fillText, INSTANCE_CAP, itemPlaceholderOf, outputBounds, placeholderOf, standInContract, type Plan, type PlanStep, type Template } from './routing.js';
```

In `src/kanban/service.ts`, replace:

```ts
    const problem = checkOutputs(entry.outputs, metadata, outputBounds(plan, entry.stands_in_for ?? entry.step));
    return problem === undefined ? undefined : board.refuse('invalid', problem);
```

with:

```ts
    const read = entry.stands_in_for ?? entry.step;
    const problem = checkOutputs(entry.outputs, metadata, outputBounds(plan, read));
    if (problem !== undefined) return board.refuse('invalid', problem);
    return this.#reserved(planned.instance.instanceId, plan, read, metadata as Record<string, unknown>);
  }

  /**
   * The instance's 500, reserved at the report whose list a fan-out will read
   * (workflow routing spec §2.2): its members, handlers among them, plus this
   * list's items for each fan-out over it still waiting, plus one for each other
   * step still waiting, at most 500, else `too_large`, while the agent can still
   * shorten its list. The writer never refuses for the cap; what passes it later
   * is skipped (§9.4).
   */
  #reserved(instanceId: string, plan: Plan, step: string, metadata: Record<string, unknown>): Refusal | undefined {
    const waiting = new Set(pendingOf(this.#db, instanceId).filter((p) => p.state === 'waiting').map((p) => p.step));
    const members = membersOf(this.#db, instanceId).length;
    let others = waiting.size;
    for (const s of plan.steps) {
      const f = s.for_each;
      if (f === undefined || !('step' in f) || f.step !== step || !waiting.has(s.step)) continue;
      const list = metadata[f.output];
      if (!Array.isArray(list)) continue;
      others -= 1;
      if (members + list.length + others > INSTANCE_CAP) {
        return board.refuse('too_large', `output ${f.output} would make ${list.length} tasks, and instance ${instanceId} has ${members} of its ${INSTANCE_CAP}`);
      }
      others += list.length;
    }
    return undefined;
```

- [ ] **Step 20.4: Run them to verify they pass.** Run the same command. Expected: `Tests  2 passed (2)`.

- [ ] **Step 20.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3684 passed (3684)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 20.6: Commit.**

```bash
git add src/kanban/service.ts tests/routing-cap.test.ts
git commit -m "Reserve an instance's 500 tasks at the report whose list a fan-out reads, and skip whatever passes them later, never refusing the transition"
```

---

## Phase 4: routes and handlers

Tasks 21 to 26. The trigger table; the route rows, `over_limit` and `over_cap`; a handler's task with its paragraph, and its source in the worker's show; the worker's `mt kanban unblock`; a stand-in's reviewer, gates and contract; its settling and the archive of the task it stood in for; and the runs that archive superseded, cancelled through the service. Phase 4 ends green, a checkpoint to review at.

---

### Task 21: The trigger table and the routes

**Files:**

- Create: `tests/routing-triggers.test.ts`
- Modify: `src/db/kanban-read.ts`, `src/kanban/routing.ts`

§5.1, §5.3, §10. `triggersOf` reads §5.1's table from the events, now with each block's kind; `decide` routes each due trigger by `on_blocked` or `on_gave_up`, by its key: `route`, standing in when the handler stands in for the step, `over_limit` once 3 were made from the task, `over_cap` at the cap, and nothing from a member already settled. `triggerWords` says a trigger as a notice does.

- [ ] **Step 21.1: Write the tests.**

Create `tests/routing-triggers.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { block, closeRun, endRun, requestReview, stop, type KanbanLimits } from '../src/db/kanban.js';
import { triggersOf } from '../src/db/kanban-read.js';
import { decide, INSTANCE_CAP, type Facts, type Plan, type PlanStep, type RouteFact, type StepFact, type Template } from '../src/kanban/routing.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, claimed, newTask } from './helpers/kanban.js';

/**
 * The trigger table (workflow routing spec §5.1), each row from the code: a run's
 * own block and the run endings that block route by `on_blocked`, the breaker's
 * give-up and the transient limit's block by `on_gave_up`; a person's block, a
 * stop, a review's block and a dependency route nothing. And decide's routes
 * (§5.3, §10): by the trigger's key, once a route is due, at most 3 a routed
 * task, at the cap `over_cap`, none from a member already settled.
 */

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

const LIMITS: KanbanLimits = { failureLimit: 1, transientLimit: 2, transientCooldownS: 300 };

/** A task's one trigger, after `act` on a fresh run of it; undefined for none. */
function trigger(act: (taskId: string, runId: string) => void, task = newTask(h.db)) {
  const run = claimed(h.db, task.taskId);
  act(task.taskId, run.runId);
  closeRun(h.db, run.runId, NOW);
  return triggersOf(h.db, task.taskId).map(({ eventId: _e, ...t }) => t);
}

describe('the trigger table', () => {
  it("reads a run's own block, of any kind but dependency, as blocked", () => {
    for (const kind of ['needs_input', 'capability', 'transient'] as const) {
      expect(trigger((t, r) => block(h.db, t, { kind: 'run', runId: r }, { kind, reason: 'stuck' }, NOW))).toEqual([
        { kind: 'blocked', throttled: false, blockKind: kind, reason: 'stuck' },
      ]);
    }
    const parent = newTask(h.db);
    expect(trigger((t, r) => block(h.db, t, { kind: 'run', runId: r }, { kind: 'dependency', reason: 'wait', parents: [parent.taskId] }, NOW))).toEqual([]);
  });

  it('reads the run endings that block as blocked, and the two terminal failure endings as gave_up', () => {
    expect(trigger((_t, r) => endRun(h.db, r, { outcome: 'terminal_provider', error: 'bad key' }, LIMITS, NOW))).toEqual([
      { kind: 'blocked', throttled: false, blockKind: 'capability', reason: 'bad key' },
    ]);
    const cautious = newTask(h.db, { retryOnCrash: 'if-no-side-effects', failureLimit: 5 });
    expect(trigger((_t, r) => endRun(h.db, r, { outcome: 'crashed', hadSideEffects: true }, LIMITS, NOW), cautious)).toEqual([
      { kind: 'blocked', throttled: false, blockKind: 'needs_input', reason: 'the run ended crashed after changing things; look before it is retried' },
    ]);
    expect(trigger((_t, r) => endRun(h.db, r, { outcome: 'failed', block: 'the directory could not be made' }, LIMITS, NOW))).toEqual([
      { kind: 'blocked', throttled: false, blockKind: 'needs_input', reason: 'the directory could not be made' },
    ]);
    expect(trigger((_t, r) => endRun(h.db, r, { outcome: 'crashed', error: 'boom' }, LIMITS, NOW))).toEqual([
      { kind: 'gave_up', throttled: false, blockKind: 'gave_up', reason: 'failed 1 times; last crashed: boom' },
    ]);
    const throttled = newTask(h.db);
    const first = claimed(h.db, throttled.taskId);
    endRun(h.db, first.runId, { outcome: 'rate_limited' }, LIMITS, NOW);
    closeRun(h.db, first.runId, NOW);
    h.db.prepare('UPDATE kanban_tasks SET cooldown_until = NULL WHERE task_id = ?').run(throttled.taskId);
    expect(trigger((_t, r) => endRun(h.db, r, { outcome: 'rate_limited' }, LIMITS, NOW), throttled)).toEqual([
      { kind: 'gave_up', throttled: true, blockKind: 'transient', reason: 'throttled 2 times in a row' },
    ]);
  });

  it("reads nothing from a person's block, a stop, or a review run's block", () => {
    const person = newTask(h.db);
    block(h.db, person.taskId, { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason: 'wait' }, NOW);
    expect(triggersOf(h.db, person.taskId)).toEqual([]);
    expect(trigger((t) => stop(h.db, t, ALICE, NOW))).toEqual([]);
    const reviewed = newTask(h.db, { reviewer: { kind: 'role', name: 'reviewer' } });
    const work = claimed(h.db, reviewed.taskId);
    requestReview(h.db, reviewed.taskId, { kind: 'run', runId: work.runId }, { summary: 'x' }, NOW);
    closeRun(h.db, work.runId, NOW);
    const review = claimed(h.db, reviewed.taskId);
    block(h.db, reviewed.taskId, { kind: 'run', runId: review.runId }, { kind: 'needs_input', reason: 'unsure' }, NOW);
    expect(triggersOf(h.db, reviewed.taskId)).toEqual([]);
  });
});

const TEMPLATE: Template = {
  title: 't',
  body: null,
  assignee: 'worker',
  reviewer: null,
  workspace: null,
  priority: 0,
  contract: {},
  failure_limit: null,
  retry_on_crash: 'always',
  max_runtime_s: null,
  gates: [],
  wake: null,
};

function step(name: string, extra: Partial<PlanStep> = {}): PlanStep {
  return { step: name, made: 'start', parents: [], outputs: {}, on_blocked: 'wait', on_gave_up: 'wait', template: TEMPLATE, ...extra };
}

const PLAN: Plan = {
  format: 1,
  steps: [
    step('va', { on_gave_up: { route: 'escalate' }, on_blocked: { route: 'help' } }),
    step('each', { for_each: { param: 'items' }, on_gave_up: { route: 'escalate' } }),
    step('quiet'),
    step('escalate', { made: 'route', handler: true, stands_in_for: 'va' }),
    step('help', { made: 'route', handler: true }),
  ],
};

function fact(name: string, over: Partial<StepFact> = {}): StepFact {
  return { step: name, row: null, skippedBy: null, settled: null, items: new Map(), entered: { blocked: false, gaveUp: false }, result: null, ...over };
}

function due(over: Partial<RouteFact> = {}): RouteFact {
  return { taskId: 'k_va', step: 'va', ref: 'va', item: null, eventId: 7, kind: 'gave_up', throttled: false, blockKind: 'gave_up', reason: 'failed', routes: 0, ...over };
}

function facts(routes: RouteFact[], extra: StepFact[] = [], members = 3): Facts {
  const list = [fact('va'), fact('each'), fact('quiet'), ...extra];
  return { steps: new Map(list.map((f) => [f.step, f])), due: routes, members, cap: INSTANCE_CAP };
}

describe("decide's routes", () => {
  it("routes a due trigger by its key, to a handler standing in or helping, and waits on wait", () => {
    expect(decide(PLAN, facts([due()]))).toEqual([{ step: 'va', outcome: 'route', handler: 'escalate', from: due(), standsIn: true }]);
    expect(decide(PLAN, facts([due({ kind: 'blocked', blockKind: 'capability' })]))).toEqual([
      { step: 'va', outcome: 'route', handler: 'help', from: due({ kind: 'blocked', blockKind: 'capability' }), standsIn: false },
    ]);
    expect(decide(PLAN, facts([due({ kind: 'gave_up', throttled: true, blockKind: 'transient' })]))[0]).toMatchObject({ handler: 'escalate' });
    expect(decide(PLAN, facts([due({ step: 'quiet', taskId: 'k_q', ref: 'quiet' })]))).toEqual([]);
  });

  it("routes a fan-out's item for its own transition, a handler for each, not standing in for another step", () => {
    const item = due({ step: 'each', taskId: 'k_e2', ref: 'each:2', item: 'qs' });
    expect(decide(PLAN, facts([item]))).toEqual([{ step: 'each', outcome: 'route', handler: 'escalate', from: item, standsIn: false }]);
    const settled = fact('each', { items: new Map([['each:2', { how: 'done', taskId: 'k_e2', eventId: 9 }]]) });
    expect(decide(PLAN, { ...facts([item]), steps: new Map([...facts([item]).steps, ['each', settled]]) })).toEqual([]);
  });

  it('falls back to wait past 3 routes a task, over_limit, and at the cap, over_cap, and routes nothing from a member settled', () => {
    expect(decide(PLAN, facts([due({ routes: 3 })]))).toEqual([{ step: 'va', outcome: 'over_limit', handler: 'escalate', from: due({ routes: 3 }) }]);
    expect(decide(PLAN, facts([due({ routes: 2 })]))[0]?.outcome).toBe('route');
    expect(decide(PLAN, facts([due()], [], 500))).toEqual([{ step: 'va', outcome: 'over_cap', handler: 'escalate', from: due() }]);
    const won = fact('va', { settled: { how: 'stood_in', taskId: 'k_s', eventId: 8 } });
    expect(decide(PLAN, { ...facts([due()]), steps: new Map([...facts([due()]).steps, ['va', won]]) })).toEqual([]);
  });
});
```

- [ ] **Step 21.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-triggers.test.ts`. Expected: `Tests  5 failed | 1 passed (6)`, the first as `AssertionError: expected [ { kind: 'blocked', …(2) } ] to deeply equal [ { kind: 'blocked', …(3) } ]`.

- [ ] **Step 21.3: Implement.**

In `src/db/kanban-read.ts`, replace:

```ts
  throttled: boolean;
```

with:

```ts
  throttled: boolean;
  /** The block's kind, as the event recorded it. */
  blockKind: string;
```

In `src/db/kanban-read.ts`, replace:

```ts
      return [{ eventId: r.id, kind: 'blocked', throttled: false, reason: text('reason') }];
```

with:

```ts
      return [{ eventId: r.id, kind: 'blocked', throttled: false, blockKind: text('kind'), reason: text('reason') }];
```

In `src/db/kanban-read.ts`, replace:

```ts
    return [{ eventId: r.id, kind: gaveUp ? 'gave_up' : 'blocked', throttled: kind === 'transient', reason: text('blockReason') }];
```

with:

```ts
    return [{ eventId: r.id, kind: gaveUp ? 'gave_up' : 'blocked', throttled: kind === 'transient', blockKind: kind, reason: text('blockReason') }];
```

In `src/kanban/routing.ts`, replace:

```ts
  throttled: boolean;
```

with:

```ts
  throttled: boolean;
  /** The block's kind, as the event recorded it: `capability`, `needs_input`, `transient`, `gave_up`. */
  blockKind: string;
```

In `src/kanban/routing.ts`, replace:

```ts
    else out.push({ step: s.step, outcome: 'made', parents, why });
  }
  return out;
```

with:

```ts
    else out.push({ step: s.step, outcome: 'made', parents, why });
  }
  for (const r of facts.due) {
    const s = plan.steps.find((x) => x.step === r.step);
    if (s === undefined) continue;
    const spec = r.kind === 'gave_up' ? s.on_gave_up : s.on_blocked;
    if (spec === 'wait') continue;
    const handler = plan.steps.find((x) => x.step === spec.route && x.handler === true);
    if (handler === undefined) continue;
    // No route from a member already settled: the first to complete wins (§5.1).
    const fact = facts.steps.get(r.step);
    const settled = r.ref === r.step ? fact?.settled : fact?.items.get(r.ref);
    if (settled !== undefined && settled !== null) continue;
    if (r.routes >= ROUTES_PER_TASK) {
      out.push({ step: r.step, outcome: 'over_limit', handler: handler.step, from: r });
      continue;
    }
    if (members + 1 > facts.cap) {
      out.push({ step: r.step, outcome: 'over_cap', handler: handler.step, from: r });
      continue;
    }
    members += 1;
    out.push({ step: r.step, outcome: 'route', handler: handler.step, from: r, standsIn: handler.stands_in_for === r.step });
  }
  return out;
```

In `src/kanban/routing.ts`, replace:

```ts
    out.push({ step: r.step, outcome: 'route', handler: handler.step, from: r, standsIn: handler.stands_in_for === r.step });
  }
  return out;
}
```

with:

```ts
    out.push({ step: r.step, outcome: 'route', handler: handler.step, from: r, standsIn: handler.stands_in_for === r.step });
  }
  return out;
}

/** What a routed task's transition was, as a notice and `show` say it (§5.3, §12): `gave up`, `stopped after 10 throttles`, `blocked`. */
export function triggerWords(r: Pick<RouteFact, 'kind' | 'throttled'>, throttles: number): string {
  if (r.kind === 'blocked') return 'blocked';
  return r.throttled ? `stopped after ${throttles} throttles` : 'gave up';
}
```

- [ ] **Step 21.4: Run them to verify they pass.** Run the same command. Expected: `Tests  6 passed (6)`.

- [ ] **Step 21.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3690 passed (3690)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 21.6: Commit.**

```bash
git add src/db/kanban-read.ts src/kanban/routing.ts tests/routing-triggers.test.ts
git commit -m "Read each trigger of the table by its event, and decide a due route by its key: routed, over the limit of 3 a task, or over the cap"
```

---

### Task 22: A handler's task

**Files:**

- Create: `tests/routing-handler-workspace.test.ts`, `tests/routing-handlers.test.ts`
- Modify: `src/db/kanban-read.ts`, `src/db/kanban.ts`, `src/kanban/routing.ts`, `src/kanban/worker.ts`, `tests/helpers/routing.ts`

§5.2, §5.3, §8. The writer reads the routes due, each member blocked now from its work by a trigger event with no route row for it, and applies a route: its row, keyed on the event; a handler's task made as any late task but with no link, its ref `<handler>:<n>`, its item the routed item's, its body gaining its paragraph, kept whole, in the routed task's fixed workspace when its step and role name none, its `created` event naming `routedFrom`; and `over_limit` and `over_cap` rows. The worker's `show` of a handler's task gives `routed_from`, from its route row. `tests/helpers/routing.ts` gains `workerRun`. The transient limit's block routes by `on_gave_up`, its paragraph saying the throttles; a run's own `transient` block routes by `on_blocked`. A route on a board found archived makes nothing.

- [ ] **Step 22.1: Write the tests.**

In `tests/helpers/routing.ts`, replace:

```ts
import { KanbanService, type KanbanServiceDeps, type WorkflowMade } from '../../src/kanban/service.js';
```

with:

```ts
import { KanbanService, type KanbanServiceDeps, type WorkflowMade } from '../../src/kanban/service.js';
import { hashToken, mintToken } from '../../src/kanban/token.js';
```

In `tests/helpers/routing.ts`, replace:

```ts
import type { Result } from '../../src/kanban/types.js';
```

with:

```ts
import type { Result } from '../../src/kanban/types.js';
import { WorkerApi, type WorkerResponse } from '../../src/kanban/worker.js';
```

In `tests/helpers/routing.ts`, replace:

```ts
  return r as unknown as WorkflowMade;
}
```

with:

```ts
  return r as unknown as WorkflowMade;
}

/** A run of a task claimed through the service with a token, and the worker API asking as it: what an agent's `mt kanban` does. */
export interface WorkerRun {
  runId: string;
  ask(command: string, input?: unknown): Promise<WorkerResponse>;
}

export function workerRun(service: KanbanService, db: TestDb['db'], taskId: string): WorkerRun {
  const token = mintToken();
  const claimed = service.claim(taskId, { tokenHash: hashToken(token) });
  if (!claimed.ok) throw new Error(`${claimed.code}: ${claimed.message}`);
  const api = new WorkerApi({ db, service });
  const runId = claimed.run.runId;
  return { runId, ask: (command, input = {}) => api.handle({ run: runId, token, command, input }) };
}
```

Create `tests/routing-handler-workspace.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { getTask, membersOf, parentsOf } from '../src/db/kanban-read.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA } from './helpers/kanban.js';
import { VI_WORKFLOW, madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * A handler in an isolated workspace (workflow routing spec §5.2, §13.4): made
 * with the routed task's fixed workspace when its step and role name none, with
 * no parent and, from chat, no creating task, so its worktree starts from the
 * workspace's base; its body naming the routed task's own directory.
 */

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  b = viBoard(h, { isolated: new Set(['vi']), limits: { failureLimit: 1, transientLimit: 10, transientCooldownS: 300 } });
  writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW.replace('    assignee: vulnerability-analyst\n', '    assignee: vulnerability-analyst\n    workspace: vi\n'));
});
afterEach(() => h.close());

describe('a handler in an isolated workspace', () => {
  it("is made in the routed task's workspace, with no parent and no creating task, its body naming the routed task's directory", async () => {
    const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
    const intake = w.tasks[0]?.taskId ?? '';
    const ir = b.service.claim(intake);
    if (!ir.ok) throw new Error(ir.message);
    await b.service.complete(intake, { kind: 'run', runId: ir.run.runId }, { summary: 'x', metadata: { kind: 'cve', verify: false, patch: false, bnpm: false, packages: [] } });
    closeRun(h.db, ir.run.runId, NOW);
    const va = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'va')?.taskId ?? '';
    const run = b.service.claim(va);
    if (!run.ok) throw new Error(run.message);
    expect(getTask(h.db, va)?.worktree).toBe(`wt:${va}`);
    // The directory the dispatcher would make before the run's first prompt.
    h.db.prepare("INSERT INTO workspaces (id, kind, root_path, created_at) VALUES (?, 'git-worktree', ?, ?)").run(`wt:${va}`, `/home/mt/worktrees/${va}`, NOW);
    b.service.endRun(run.run.runId, { outcome: 'crashed' });
    const escalate = getTask(h.db, membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'escalate')?.taskId ?? '');
    expect(escalate).toMatchObject({ workspace: 'vi', createdFromTask: null, worktree: null });
    expect(parentsOf(h.db, escalate?.taskId ?? '')).toEqual([]);
    expect(escalate?.body.split('\n')[1]).toBe(`Its directory: /home/mt/worktrees/${va}`);
  });
});
```

Create `tests/routing-handlers.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, getTask, membersOf, parentsOf, routesOf } from '../src/db/kanban-read.js';
import type { WorkflowMade } from '../src/kanban/service.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { VI_WORKFLOW, madeOf, viBoard, workerRun, type ViBoard } from './helpers/routing.js';

/**
 * A route made (workflow routing spec §5): a handler's task made for its routed
 * task's give-up, once for that event, with no link, its ref `<handler>:<n>`,
 * its body gaining its paragraph, kept whole, its created event naming the
 * routed task, in that task's workspace; a block routed to a helper; the fourth
 * give-up `over_limit`, said once; the cap's `over_cap`; and the worker's show of
 * a handler's task naming its source from the route row.
 */

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  b = viBoard(h, { limits: { failureLimit: 1, transientLimit: 10, transientCooldownS: 300 } });
});
afterEach(() => h.close());

const CVE = { kind: 'cve', verify: false, patch: false, bnpm: false, packages: [] };

function start(): WorkflowMade {
  return madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
}

async function done(taskId: string, metadata: Record<string, unknown> = {}): Promise<void> {
  const run = claimed(h.db, taskId);
  const r = await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'did it', metadata });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  closeRun(h.db, run.runId, NOW);
}

/** A crash of the task's next run, its failure limit 1: it gives up. */
function giveUp(taskId: string): void {
  const run = claimed(h.db, taskId);
  const r = b.service.endRun(run.runId, { outcome: 'crashed' });
  if (!r.ok) throw new Error(r.message);
  closeRun(h.db, run.runId, NOW);
}

async function vaOf(): Promise<{ w: WorkflowMade; va: string }> {
  const w = start();
  await done(w.tasks[0]?.taskId ?? '', CVE);
  return { w, va: membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'va')?.taskId ?? '' };
}

const handlers = (id: string) => membersOf(h.db, id).filter((m) => m.step === 'escalate');

describe('a route made', () => {
  it("makes the handler's task for the give-up, with no link, its paragraph after the file's body, naming the routed task", async () => {
    const { w, va } = await vaOf();
    giveUp(va);
    const [escalate] = handlers(w.instance.instanceId);
    expect(escalate).toMatchObject({ ref: 'escalate:1', step: 'escalate', item: null });
    const task = getTask(h.db, escalate?.taskId ?? '');
    expect(task?.title).toBe('CVE-1 · va, escalated');
    expect(task?.body).toBe(
      [
        `Routed from \`${va}\` (step va): it gave up: failed 1 times; last crashed.`,
        "This task stands in for it: your accepted completion is read in va's place, and archives it.",
        `\`mt kanban unblock\` with {"task_id": "${va}", "comment": "…"} returns it to work instead.`,
      ].join('\n'),
    );
    expect(parentsOf(h.db, escalate?.taskId ?? '')).toEqual([]);
    expect(eventsOf(h.db, escalate?.taskId ?? '')[0]?.payload).toMatchObject({ ref: 'escalate:1', step: 'escalate', routedFrom: va });
    const routes = routesOf(h.db, w.instance.instanceId);
    expect(routes.map((r) => [r.handler, r.fromTask, r.outcome, r.taskId])).toEqual([['escalate', va, 'made', escalate?.taskId]]);
    expect(eventsOf(h.db, va).find((e) => e.kind === 'workflow_routed')?.payload).toMatchObject({
      cause: 'gave_up',
      decisions: [{ step: 'va', outcome: 'routed', why: 'gave up', taskIds: [escalate?.taskId], handler: 'escalate', standsIn: true }],
    });
  });

  it('routes each give-up once, at most 3 a task, then falls back to wait with one over_limit', async () => {
    const { w, va } = await vaOf();
    for (let n = 1; n <= 4; n += 1) {
      giveUp(va);
      expect(b.service.unblock(va, ALICE).ok).toBe(true);
    }
    expect(handlers(w.instance.instanceId).map((m) => m.ref)).toEqual(['escalate:1', 'escalate:2', 'escalate:3']);
    expect(routesOf(h.db, w.instance.instanceId).map((r) => r.outcome)).toEqual(['made', 'made', 'made', 'over_limit']);
    const last = eventsOf(h.db, va).filter((e) => e.kind === 'workflow_routed').at(-1)?.payload;
    expect(last).toMatchObject({ decisions: [{ step: 'va', outcome: 'over_limit', why: 'gave up', taskIds: [va], handler: 'escalate' }] });
  });

  it("routes a run's block to a helper, made in the routed task's workspace, its paragraph saying it helps", async () => {
    writeFileSync(
      join(b.dir, 'vi-workflow.yaml'),
      `${VI_WORKFLOW.replace('    on_gave_up: { route: escalate }\n', '    on_gave_up: { route: escalate }\n    on_blocked: { route: help }\n    workspace: vi\n')}  help:\n    title: "{{case}} · help va, a {{intake.kind}}"\n    assignee: vi-coordinator\n    handler: true\n`,
    );
    const { w, va } = await vaOf();
    const run = b.service.claim(va);
    if (!run.ok) throw new Error(run.message);
    expect(b.service.block(va, { kind: 'run', runId: run.run.runId }, { kind: 'capability', reason: 'no network' }).ok).toBe(true);
    const help = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'help')?.taskId ?? '';
    expect(getTask(h.db, help)).toMatchObject({
      title: 'CVE-1 · help va, a cve',
      workspace: 'vi',
      body: [
        `Routed from \`${va}\` (step va): it blocked (capability): no network.`,
        'This task helps it: its dependents wait for it, not for you.',
        `\`mt kanban unblock\` with {"task_id": "${va}", "comment": "…"} returns it to work instead.`,
      ].join('\n'),
    });
  });

  it("routes the transient limit's block by on_gave_up, saying it stopped after the throttles, and a run's own transient block by on_blocked", async () => {
    b = viBoard(h, { limits: { failureLimit: 1, transientLimit: 2, transientCooldownS: 0 } });
    writeFileSync(
      join(b.dir, 'vi-workflow.yaml'),
      `${VI_WORKFLOW.replace('    on_gave_up: { route: escalate }\n', '    on_gave_up: { route: escalate }\n    on_blocked: { route: help }\n')}  help:\n    title: "{{case}} · help va"\n    assignee: vi-coordinator\n    handler: true\n`,
    );
    const { w, va } = await vaOf();
    for (let n = 1; n <= 2; n += 1) {
      const run = claimed(h.db, va);
      expect(b.service.endRun(run.runId, { outcome: 'rate_limited' }).ok).toBe(true);
      closeRun(h.db, run.runId, NOW);
    }
    expect(getTask(h.db, va)).toMatchObject({ phase: 'blocked', blockKind: 'transient' });
    const escalate = handlers(w.instance.instanceId)[0]?.taskId ?? '';
    expect(getTask(h.db, escalate)?.body).toBe(
      [
        `Routed from \`${va}\` (step va): it stopped after 2 throttles: throttled 2 times in a row.`,
        "This task stands in for it: your accepted completion is read in va's place, and archives it.",
        `\`mt kanban unblock\` with {"task_id": "${va}", "comment": "…"} returns it to work instead.`,
      ].join('\n'),
    );
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    const run = b.service.claim(va);
    if (!run.ok) throw new Error(run.message);
    expect(b.service.block(va, { kind: 'run', runId: run.run.runId }, { kind: 'transient', reason: 'the registry is down' }).ok).toBe(true);
    expect(getTask(h.db, va)).toMatchObject({ phase: 'blocked', blockKind: 'transient' });
    const help = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'help')?.taskId ?? '';
    expect(getTask(h.db, help)?.body.split('\n')[0]).toBe(`Routed from \`${va}\` (step va): it blocked (transient): the registry is down.`);
    expect(routesOf(h.db, w.instance.instanceId).map((r) => [r.handler, r.outcome])).toEqual([
      ['escalate', 'made'],
      ['help', 'made'],
    ]);
  });

  it("routes a fan-out's item for its own give-up, the handler made for that item", async () => {
    writeFileSync(
      join(b.dir, 'vi-workflow.yaml'),
      `${VI_WORKFLOW.replace('    for_each: { step: intake, output: packages }\n', '    for_each: { step: intake, output: packages }\n    on_gave_up: { route: fix }\n')}  fix:\n    title: "{{case}} · fix {{item}}"\n    assignee: vi-coordinator\n    handler: true\n`,
    );
    const w = start();
    await done(w.tasks[0]?.taskId ?? '', { ...CVE, packages: ['lodash', 'qs'] });
    const va = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'va')?.taskId ?? '';
    await done(va, { reachable: true });
    const qs = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'exposure' && m.item === 'qs')?.taskId ?? '';
    giveUp(qs);
    const fix = membersOf(h.db, w.instance.instanceId).filter((m) => m.step === 'fix');
    expect(fix.map((m) => [m.ref, m.item])).toEqual([['fix:1', 'qs']]);
    expect(getTask(h.db, fix[0]?.taskId ?? '')?.title).toBe('CVE-1 · fix qs');
    expect(routesOf(h.db, w.instance.instanceId).map((r) => [r.fromTask, r.outcome])).toEqual([[qs, 'made']]);
  });

  it('counts the handlers made in the cap: a route past 500 members records over_cap', async () => {
    const { w, va } = await vaOf();
    giveUp(va);
    expect(handlers(w.instance.instanceId).length).toBe(1);
    const task = h.db.prepare(
      `INSERT INTO kanban_tasks (task_id, title, contract, phase, created_by, created_via, created_at, board)
       VALUES (?, 'filler', jsonb('{}'), 'open', ?, jsonb('{"kind":"operator"}'), ?, 'vi')`,
    );
    const member = h.db.prepare("INSERT INTO kanban_workflow_tasks (task_id, instance_id, ref, step, item, position) VALUES (?, ?, ?, 'filler', NULL, ?)");
    const base = membersOf(h.db, w.instance.instanceId).length;
    // 499 members of the file's steps and one handler: the instance is at its cap.
    for (let i = 0; i < 500 - base; i += 1) {
      task.run(`k_fill${i}`, ALICE, NOW);
      member.run(`k_fill${i}`, w.instance.instanceId, `filler:${i + 1}`, base + i);
    }
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    giveUp(va);
    expect(handlers(w.instance.instanceId).length).toBe(1);
    expect(routesOf(h.db, w.instance.instanceId).map((r) => r.outcome)).toEqual(['made', 'over_cap']);
  });

  it('makes no handler on a board found archived, writing no route row', async () => {
    const { w, va } = await vaOf();
    h.db.prepare("UPDATE kanban_boards SET archived_at = ? WHERE name = 'vi'").run(NOW);
    giveUp(va);
    expect(handlers(w.instance.instanceId)).toEqual([]);
    expect(routesOf(h.db, w.instance.instanceId)).toEqual([]);
    expect(getTask(h.db, va)?.phase).toBe('blocked');
  });

  it("keeps the paragraph whole, cutting only the file's part of a body at 64 KiB", async () => {
    const eight = Array.from({ length: 8 }, () => '{{note}}').join('');
    writeFileSync(
      join(b.dir, 'vi-workflow.yaml'),
      VI_WORKFLOW.replace('  case: { required', '  note: { required: true }\n  case: { required').replace(
        '    title: "{{case}} · va, escalated"\n',
        `    title: "{{case}} · va, escalated"\n    body: "${eight}${'b'.repeat(1_500)}"\n`,
      ),
    );
    const w = madeOf(
      b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1', note: 'n'.repeat(8_000) } }, createdBy: ALICE, createdVia: VIA }),
    );
    await done(w.tasks[0]?.taskId ?? '', CVE);
    const va = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'va')?.taskId ?? '';
    giveUp(va);
    const body = getTask(h.db, handlers(w.instance.instanceId)[0]?.taskId ?? '')?.body ?? '';
    expect(Buffer.byteLength(body)).toBe(64 * 1024);
    expect(body).toMatch(/\n\nRouted from `k_[a-z0-9]+` \(step va\): it gave up: failed 1 times; last crashed\.\n/);
    expect(body.endsWith('returns it to work instead.')).toBe(true);
  });

  it("names the handler's source in the worker's show, from its route row", async () => {
    const { w, va } = await vaOf();
    giveUp(va);
    const escalate = handlers(w.instance.instanceId)[0]?.taskId ?? '';
    const run = workerRun(b.service, h.db, escalate);
    const event = routesOf(h.db, w.instance.instanceId)[0]?.eventId;
    expect(await run.ask('show')).toMatchObject({ ok: true, routed_from: { task_id: va, step: 'va', item: null, event_id: event } });
  });
});
```

- [ ] **Step 22.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-handler-workspace.test.ts tests/routing-handlers.test.ts`. Expected: `Tests  9 failed | 1 passed (10)`, the first as `AssertionError: expected undefined to match object { workspace: 'vi', …(2) }`.

- [ ] **Step 22.3: Implement.**

In `src/db/kanban-read.ts`, replace:

```ts

/** A task's first event of a kind, with its payload; undefined for none. */
```

with:

```ts

/** The event that blocked a task last (§5.3): a block of any kind but `dependency`, a stop, or a run's end that blocked it. */
export function latestBlockOf(db: Db, taskId: string): number | undefined {
  return (
    db
      .prepare<[string], { id: number | null }>(
        `SELECT max(id) AS id FROM kanban_events
          WHERE task_id = ? AND ((kind = 'blocked' AND json_extract(payload, '$.kind') <> 'dependency') OR kind = 'stopped'
                                 OR (kind = 'run_ended' AND json_extract(payload, '$.next') = 'blocked'))`,
      )
      .get(taskId)?.id ?? undefined
  );
}

/** A task's first event of a kind, with its payload; undefined for none. */
```

In `src/db/kanban.ts`, replace:

```ts
import { decide as decideRouting, fillText, INSTANCE_CAP, maskPlan, resultOf, SKIPPED_TEXT, valueSaid, type Decision, type Facts, type Plan, type PlanStep, type StepFact, type Template } from '../kanban/routing.js';
```

with:

```ts
import { decide as decideRouting, fillText, handlerParagraph, INSTANCE_CAP, maskPlan, resultOf, SKIPPED_TEXT, triggerWords, valueSaid, type Decision, type Facts, type Plan, type PlanStep, type RouteFact, type StepFact, type Template } from '../kanban/routing.js';
```

In `src/db/kanban.ts`, replace:

```ts
import { worktreeId } from './workspaces.js';
```

with:

```ts
import { worktreeId, worktreeOf } from './workspaces.js';
```

In `src/db/kanban.ts`, replace:

```ts
  firstEventOf,
```

with:

```ts
  firstEventOf,
  latestBlockOf,
```

In `src/db/kanban.ts`, replace:

```ts
  latestCompletion,
```

with:

```ts
  latestCompletion,
  routesOf,
```

In `src/db/kanban.ts`, replace:

```ts
  outcome: 'made' | 'skipped' | 'fanned_out';
```

with:

```ts
  outcome: 'made' | 'skipped' | 'fanned_out' | 'routed' | 'over_limit' | 'over_cap';
```

In `src/db/kanban.ts`, replace:

```ts
  by?: string;
```

with:

```ts
  by?: string;
  /** A route's handler, and whether it stands in. */
  handler?: string;
  standsIn?: boolean;
```

In `src/db/kanban.ts`, replace:

```ts
  return { steps, due: [], members: r.members.length, cap: INSTANCE_CAP };
```

with:

```ts
  return { steps, due: dueRoutes(d, r), members: r.members.length, cap: INSTANCE_CAP };
}

/**
 * The routes due (§5.3): each member's task blocked now from its work by a trigger
 * event, its latest block, with no route row for that event yet; and how many
 * routes were made from it. A block lifted before its route was made routes
 * nothing, as the task is no longer blocked by it.
 */
function dueRoutes(d: Db, r: Routed): RouteFact[] {
  const routes = routesOf(d, r.instance.instanceId);
  const handlers = new Set(r.plan.steps.filter((s) => s.handler === true).map((s) => s.step));
  return r.members.flatMap((m): RouteFact[] => {
    if (handlers.has(m.step) || m.task.phase !== 'blocked' || m.task.blockedFrom !== 'open') return [];
    const latest = latestBlockOf(d, m.taskId);
    const t = triggersOf(d, m.taskId).find((x) => x.eventId === latest);
    if (t === undefined || routes.some((x) => x.fromTask === m.taskId && x.eventId === t.eventId)) return [];
    return [
      {
        taskId: m.taskId,
        step: m.step,
        ref: m.ref,
        item: m.item,
        eventId: t.eventId,
        kind: t.kind,
        throttled: t.throttled,
        blockKind: t.blockKind,
        reason: t.reason,
        routes: routes.filter((x) => x.fromTask === m.taskId && x.outcome === 'made').length,
      },
    ];
  });
```

In `src/db/kanban.ts`, replace:

```ts
  made: { step: string; ref: string; item: string | null; template: Template; parents: readonly string[]; payload?: Record<string, unknown> },
```

with:

```ts
  made: { step: string; ref: string; item: string | null; template: Template; parents: readonly string[]; payload?: Record<string, unknown>; paragraph?: string },
```

In `src/db/kanban.ts`, replace:

```ts
  const body = t.body === null ? '' : cutToBytes(filled(r.plan, facts, t.body, made.item ?? undefined), WORKER_LIMITS.body);
```

with:

```ts
  // A handler's paragraph is kept whole: only the file's part of its body is cut (§5.2).
  const after = made.paragraph === undefined ? '' : made.paragraph;
  const room = WORKER_LIMITS.body - (after === '' ? 0 : Buffer.byteLength(after) + (t.body === null ? 0 : 2));
  const own = t.body === null ? '' : cutToBytes(filled(r.plan, facts, t.body, made.item ?? undefined), room);
  const body = after === '' ? own : own === '' ? after : `${own}\n\n${after}`;
```

In `src/db/kanban.ts`, replace:

```ts
  }
  if (dec.outcome !== 'made' && dec.outcome !== 'fanned_out') return undefined;
```

with:

```ts
  }
  if (dec.outcome === 'route' || dec.outcome === 'over_limit' || dec.outcome === 'over_cap') return route(d, r, facts, dec, now, team);
  if (dec.outcome !== 'made' && dec.outcome !== 'fanned_out') return undefined;
```

In `src/db/kanban.ts`, replace:

```ts
  return { step: dec.step, outcome: 'fanned_out', why: dec.why, taskIds, items: dec.items.slice(0, ROUTED_ITEMS), count: dec.items.length };
```

with:

```ts
  return { step: dec.step, outcome: 'fanned_out', why: dec.why, taskIds, items: dec.items.slice(0, ROUTED_ITEMS), count: dec.items.length };
}

/**
 * A route applied (§5.3): its row, keyed on the trigger event, so a replay makes
 * no second handler; for a route made, the handler's task, made as any late
 * task but with no link, its ref `<handler>:<n>`, its item the routed item's,
 * its body gaining its paragraph, in the routed task's fixed workspace when its
 * step and role name none, its `created` event naming the routed task. On a
 * board found archived nothing is made and no row written (§13.1): the board
 * takes no new task, and the routed task waits as with no route.
 */
function route(
  d: Db,
  r: Routed,
  facts: Facts,
  dec: Extract<Decision, { outcome: 'route' | 'over_limit' | 'over_cap' }>,
  now: number,
  team: RouteTeam | undefined,
): RoutedLine | undefined {
  const id = r.instance.instanceId;
  const from = dec.from;
  const taken = d.prepare('SELECT 1 FROM kanban_workflow_routes WHERE instance_id = ? AND handler = ? AND event_id = ?').get(id, dec.handler, from.eventId);
  if (taken !== undefined) return undefined;
  const routed = mustGet(d, from.taskId);
  const why = triggerWords(from, routed.consecutiveTransient);
  const row = d.prepare('INSERT INTO kanban_workflow_routes (instance_id, handler, event_id, from_task, outcome, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  if (dec.outcome !== 'route') {
    row.run(id, dec.handler, from.eventId, from.taskId, dec.outcome, null, now);
    return { step: from.step, outcome: dec.outcome, why, taskIds: [from.taskId], handler: dec.handler };
  }
  const hs = r.plan.steps.find((s) => s.step === dec.handler);
  const t = hs?.template;
  if (hs === undefined || t === undefined || !liveBoard(d, r.instance.board).ok) return undefined;
  const n = routesOf(d, id).filter((x) => x.handler === dec.handler && x.outcome === 'made').length + 1;
  // Where it works (§5.2): its step's, its role's, or else the routed task's, when that is fixed.
  const roleWorkspace = t.assignee === null || t.assignee.includes(':') ? undefined : team?.roles.get(t.assignee)?.workspace;
  const workspace = t.workspace ?? (roleWorkspace === undefined ? routed.workspace : null);
  const paragraph = handlerParagraph({
    taskId: from.taskId,
    step: from.step,
    item: from.item,
    from,
    throttles: routed.consecutiveTransient,
    dir: routed.worktree === null ? undefined : worktreeOf(d, routed.worktree)?.rootPath,
    standsIn: dec.standsIn,
  });
  const taskId = makeLate(
    d,
    r,
    facts,
    { step: dec.handler, ref: `${dec.handler}:${n}`, item: from.item, template: { ...t, workspace }, parents: [], payload: { routedFrom: from.taskId }, paragraph },
    now,
    team,
  );
  row.run(id, dec.handler, from.eventId, from.taskId, 'made', taskId, now);
  return { step: from.step, outcome: 'routed', why, taskIds: [taskId], handler: dec.handler, standsIn: dec.standsIn };
```

In `src/kanban/routing.ts`, replace:

```ts
  return r.throttled ? `stopped after ${throttles} throttles` : 'gave up';
}
```

with:

```ts
  return r.throttled ? `stopped after ${throttles} throttles` : 'gave up';
}

// ---------------------------------------------------------------------------
// A handler's paragraph (§5.2)
// ---------------------------------------------------------------------------

/** What a handler's paragraph says of the task it was routed from: read from the route row and the board's rows. */
export interface Routing {
  taskId: string;
  step: string;
  item: string | null;
  from: Pick<RouteFact, 'kind' | 'throttled' | 'blockKind' | 'reason'>;
  /** The transient limit's count, for its words. */
  throttles: number;
  /** The routed task's own directory, when it has one. */
  dir: string | undefined;
  standsIn: boolean;
}

/**
 * The fixed paragraph a handler's body gains at its making, after the file's
 * (§5.2): what it was routed from, and why; the routed task's directory when it
 * has one of its own; whether it stands in or helps; and the unblock it may make.
 * It only describes the records, which alone authorise anything.
 */
export function handlerParagraph(r: Routing): string {
  const why =
    r.from.kind === 'blocked'
      ? `it blocked (${r.from.blockKind}): ${r.from.reason}`
      : r.from.throttled
        ? `it stopped after ${r.throttles} throttles: ${r.from.reason}`
        : `it gave up: ${r.from.reason}`;
  return [
    `Routed from \`${r.taskId}\` (step ${r.step}${r.item === null ? '' : `, item ${r.item}`}): ${why}.`,
    ...(r.dir === undefined ? [] : [`Its directory: ${r.dir}`]),
    r.standsIn
      ? `This task stands in for it: your accepted completion is read in ${r.step}'s place, and archives it.`
      : 'This task helps it: its dependents wait for it, not for you.',
    `\`mt kanban unblock\` with {"task_id": "${r.taskId}", "comment": "…"} returns it to work instead.`,
  ].join('\n');
}
```

In `src/kanban/worker.ts`, replace:

```ts
import { getTask, runByTokenHash, taskView, wakeOfReaction, type ReviewRequest } from '../db/kanban-read.js';
```

with:

```ts
import { getTask, memberOf, routeOfHandler, runByTokenHash, taskView, wakeOfReaction, type ReviewRequest } from '../db/kanban-read.js';
```

In `src/kanban/worker.ts`, replace:

```ts
    const brief = briefFor(this.#db, { run, task, roleMd: undefined, role: undefined });
```

with:

```ts
    const brief = briefFor(this.#db, { run, task, roleMd: undefined, role: undefined });
    // A handler's task reads its source from the records, whatever its body says (workflow routing spec §5.2).
    const route = routeOfHandler(this.#db, task.taskId);
    const source = route === undefined ? undefined : memberOf(this.#db, route.fromTask);
```

In `src/kanban/worker.ts`, replace:

```ts
      ok: true,
```

with:

```ts
      ok: true,
      ...(route === undefined
        ? {}
        : { routed_from: { task_id: route.fromTask, step: source?.step ?? null, item: source?.item ?? null, event_id: route.eventId } }),
```

- [ ] **Step 22.4: Run them to verify they pass.** Run the same command. Expected: `Tests  10 passed (10)`.

- [ ] **Step 22.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3700 passed (3700)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 22.6: Commit.**

```bash
git add src/db/kanban-read.ts src/db/kanban.ts src/kanban/routing.ts src/kanban/worker.ts tests/helpers/routing.ts tests/routing-handler-workspace.test.ts tests/routing-handlers.test.ts
git commit -m "Make a handler's task for each due route, with no link and a paragraph naming what it was routed from, and name its source in the worker's show"
```

---

### Task 23: The worker's unblock

**Files:**

- Create: `tests/routing-unblock.test.ts`
- Modify: `README.md`, `src/db/kanban.ts`, `src/kanban/service.ts`, `src/kanban/worker.ts`, `tests/docs-wake.test.ts`, `tests/kanban-worker.test.ts`, `tests/mt-kanban-operator-tasks.test.ts`, `tests/mt-kanban.test.ts`, `tests/mt.test.ts`

§5.4. `unblock` is the worker API's thirteenth command, `{task_id, comment?}`: `KanbanService.unblockFromHandler` lets only a handler's work run lift the block of the task its route row names, while that block stands, its comment prefixed with the handler's ref; a repeat by the same run answers `changed: false`; anything else `wrong_task`, and `stale` once another lifted it. The usage lines, the README's list of the worker's commands, and the tests that list them gain it. A handler whose routed task's block was lifted already is refused `stale`, in words of its own.

- [ ] **Step 23.1: Write the tests.**

In `tests/docs-wake.test.ts`, replace:

```ts
    expect(text).toContain('start-workflow|apply-dag|wake-show|wake-unblock> < input.json');
```

with:

```ts
    expect(text).toContain('start-workflow|apply-dag|wake-show|wake-unblock|unblock> < input.json');
```

In `tests/kanban-worker.test.ts`, replace:

```ts
      message: 'no command "finish" (one of show, complete, review, changes, block, comment, create, link, start-workflow, apply-dag, wake-show, wake-unblock)',
```

with:

```ts
      message: 'no command "finish" (one of show, complete, review, changes, block, comment, create, link, start-workflow, apply-dag, wake-show, wake-unblock, unblock)',
```

In `tests/mt-kanban-operator-tasks.test.ts`, replace:

```ts
  it('answers the old form of a task command, without task, as an unknown command, and changes nothing', async () => {
    for (const verb of ['new', 'list', 'assign', 'unblock', 'stop', 'archive']) {
```

with:

```ts
  it('answers the old form of a task command, without task, as an unknown command, and changes nothing', async () => {
    for (const verb of ['new', 'list', 'assign', 'stop', 'archive']) {
```

In `tests/mt-kanban-operator-tasks.test.ts`, replace:

```ts
    // show, comment and link are the worker's names, here as in a run: outside one, they need one.
    for (const argv of [['show', 'k_1'], ['comment', 'k_1', 'hello'], ['link', 'k_1', 'k_2'], ['show', 'k_1', '--json']]) {
```

with:

```ts
    // show, comment, link and a handler's unblock are the worker's names, here as in a run: outside one, they need one.
    for (const argv of [['show', 'k_1'], ['comment', 'k_1', 'hello'], ['link', 'k_1', 'k_2'], ['show', 'k_1', '--json'], ['unblock', 'k_1']]) {
```

In `tests/mt-kanban-operator-tasks.test.ts`, replace:

```ts
    for (const verb of ['new', 'list', 'assign', 'unblock', 'stop', 'archive']) {
```

with:

```ts
    // unblock is the worker's now, a handler's run's (workflow routing spec §5.4).
    for (const verb of ['new', 'list', 'assign', 'stop', 'archive']) {
```

In `tests/mt-kanban.test.ts`, replace:

```ts
    expect(out.join('\n')).toContain('mt kanban <show|complete|review|changes|block|comment|create|link|start-workflow|apply-dag|wake-show|wake-unblock> < input.json');
```

with:

```ts
    expect(out.join('\n')).toContain('mt kanban <show|complete|review|changes|block|comment|create|link|start-workflow|apply-dag|wake-show|wake-unblock|unblock> < input.json');
```

In `tests/mt.test.ts`, replace:

```ts
    expect(usage).toContain('  mt kanban <show|complete|review|changes|block|comment|create|link|start-workflow|apply-dag|wake-show|wake-unblock> < input.json');
```

with:

```ts
    expect(usage).toContain('  mt kanban <show|complete|review|changes|block|comment|create|link|start-workflow|apply-dag|wake-show|wake-unblock|unblock> < input.json');
```

In `tests/mt.test.ts`, replace:

```ts
    for (const verb of ['new', 'list', 'assign', 'unblock', 'stop', 'archive']) {
```

with:

```ts
    for (const verb of ['new', 'list', 'assign', 'stop', 'archive']) {
```

In `tests/mt.test.ts`, replace:

```ts
    }
    const other = await fx.run(['kanban', 'finish']);
```

with:

```ts
    }
    // A handler's run's unblock is the worker's now (workflow routing spec §5.4): outside a run it says so, as show does.
    const unblock = await fx.run(['kanban', 'unblock', 'k_1']);
    expect(unblock.code).toBe(1);
    expect(JSON.parse(unblock.out)).toMatchObject({ ok: false, code: 'not_in_a_run', message: expect.stringMatching(/; the operator's is mt kanban task unblock$/) });
    const other = await fx.run(['kanban', 'finish']);
```

Create `tests/routing-unblock.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { commentsOf, eventsOf, getTask, membersOf } from '../src/db/kanban-read.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { VI_WORKFLOW, madeOf, viBoard, workerRun, type ViBoard } from './helpers/routing.js';

/**
 * The worker's `unblock` (workflow routing spec §5.4): a handler's work run lifts
 * the block of the task its route was made from, authorised by the route row
 * alone, its comment steering, prefixed with the handler's ref; a repeat by the
 * same run answers ok with nothing changed; any other task, a run that is no
 * handler's, and a review run of one refused `wrong_task`; `stale` once another
 * lifted the block.
 */

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  b = viBoard(h, { limits: { failureLimit: 1, transientLimit: 10, transientCooldownS: 300 } });
});
afterEach(() => h.close());

const CVE = { kind: 'cve', verify: false, patch: false, bnpm: false, packages: [] };

/** va given up and routed: its task, the handler's, and the intake's. */
async function routed(): Promise<{ va: string; escalate: string; intake: string }> {
  const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
  const intake = w.tasks[0]?.taskId ?? '';
  const run = claimed(h.db, intake);
  await b.service.complete(intake, { kind: 'run', runId: run.runId }, { summary: 'x', metadata: CVE });
  closeRun(h.db, run.runId, NOW);
  const va = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'va')?.taskId ?? '';
  const vaRun = claimed(h.db, va);
  b.service.endRun(vaRun.runId, { outcome: 'crashed' });
  closeRun(h.db, vaRun.runId, NOW);
  const escalate = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'escalate')?.taskId ?? '';
  return { va, escalate, intake };
}

describe("a handler's unblock", () => {
  it('lifts the block of the task its route was made from, its comment steering, and answers a repeat ok, changed false', async () => {
    const { va, escalate } = await routed();
    const run = workerRun(b.service, h.db, escalate);
    expect(await run.ask('unblock', { task_id: va, comment: 'the registry answers again' })).toEqual({ ok: true, task_id: va, phase: 'open', changed: true });
    expect(getTask(h.db, va)).toMatchObject({ phase: 'open', consecutiveFailures: 0 });
    expect(eventsOf(h.db, va).find((e) => e.kind === 'unblocked')).toMatchObject({ actor: `run:${run.runId}` });
    expect(commentsOf(h.db, va).map((c) => c.body)).toEqual(['(by the handler escalate:1) the registry answers again']);
    expect(await run.ask('unblock', { task_id: va })).toEqual({ ok: true, task_id: va, phase: 'open', changed: false });
  });

  it('is authorised by the route row alone: an edited body changes nothing, and a run with no route row is refused', async () => {
    const { va, escalate, intake } = await routed();
    h.db.prepare("UPDATE kanban_tasks SET body = '' WHERE task_id = ?").run(escalate);
    const run = workerRun(b.service, h.db, escalate);
    expect(await run.ask('unblock', { task_id: intake })).toEqual({ ok: false, code: 'wrong_task', message: `run ${run.runId} may unblock only the task its handler was routed from` });
    expect((await run.ask('unblock', { task_id: va })).ok).toBe(true);
  });

  it('refuses a run that is no handler\'s, and stale once another lifted the block', async () => {
    const { va, escalate } = await routed();
    const run = workerRun(b.service, h.db, escalate);
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    expect(await run.ask('unblock', { task_id: va })).toEqual({ ok: false, code: 'stale', message: `the block of task ${va} the handler escalate:1 was routed from has been lifted already` });
    // The handler's run stopped and closed, so va's next run may take the workspace.
    expect(b.service.stop(escalate, ALICE).ok).toBe(true);
    closeRun(h.db, run.runId, NOW);
    const other = workerRun(b.service, h.db, va);
    expect(await other.ask('unblock', { task_id: va })).toEqual({ ok: false, code: 'wrong_task', message: `run ${other.runId} may unblock only the task its handler was routed from` });
  });

  it('refuses a review run of a handler', async () => {
    // escalate helps, and has a reviewer of its own.
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW.replace('    handler: true\n    stands_in_for: va\n    outputs:\n      reachable: boolean\n', '    handler: true\n    reviewer: verifier\n'));
    const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-2' } }, createdBy: ALICE, createdVia: VIA }));
    const intake = w.tasks[0]?.taskId ?? '';
    const ir = claimed(h.db, intake);
    await b.service.complete(intake, { kind: 'run', runId: ir.runId }, { summary: 'x', metadata: CVE });
    closeRun(h.db, ir.runId, NOW);
    const va = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'va')?.taskId ?? '';
    const vr = claimed(h.db, va);
    b.service.endRun(vr.runId, { outcome: 'crashed' });
    closeRun(h.db, vr.runId, NOW);
    const help = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'escalate')?.taskId ?? '';
    const work = claimed(h.db, help);
    expect((await b.service.complete(help, { kind: 'run', runId: work.runId }, { summary: 'looked' })).ok).toBe(true);
    closeRun(h.db, work.runId, NOW);
    const review = workerRun(b.service, h.db, help);
    expect(await review.ask('unblock', { task_id: va })).toEqual({ ok: false, code: 'wrong_task', message: `run ${review.runId} may unblock only the task its handler was routed from` });
  });
});
```

- [ ] **Step 23.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/docs-wake.test.ts tests/kanban-worker.test.ts tests/mt-kanban-operator-tasks.test.ts tests/mt-kanban.test.ts tests/mt.test.ts tests/routing-unblock.test.ts`. Expected: `Tests  10 failed | 75 passed (85)`, the first as `AssertionError: expected '# manus-team\n\nmanus-team runs a tea…' to contain 'start-workflow|apply-dag|wake-show|wa…'`.

- [ ] **Step 23.3: Implement.**

In `README.md`, replace:

```markdown
mt kanban <show|complete|review|changes|block|comment|create|link|start-workflow|apply-dag|wake-show|wake-unblock> < input.json
```

with:

```markdown
mt kanban <show|complete|review|changes|block|comment|create|link|start-workflow|apply-dag|wake-show|wake-unblock|unblock> < input.json
```

In `src/db/kanban.ts`, replace:

```ts
  opts: { blockedAt?: number; wake?: number } = {},
```

with:

```ts
  opts: { blockedAt?: number; wake?: number; handler?: string } = {},
```

In `src/db/kanban.ts`, replace:

```ts
        return refuse('stale', `the block of task ${taskId} this button was for has been lifted already`);
```

with:

```ts
        // A handler's unblock is for the block it was routed from (workflow routing spec §5.4), not a button's.
        const whose = opts.handler === undefined ? 'this button was for' : `the handler ${opts.handler} was routed from`;
        return refuse('stale', `the block of task ${taskId} ${whose} has been lifted already`);
```

In `src/db/kanban.ts`, replace:

```ts
      insertComment(d, taskId, by, opts.wake === undefined ? comment : `(woken by the board) ${comment}`, now, true);
```

with:

```ts
      // A handler's says which, on the operator's file's authority (workflow routing spec §5.4).
      const prefix = opts.wake !== undefined ? '(woken by the board) ' : opts.handler !== undefined ? `(by the handler ${opts.handler}) ` : '';
      insertComment(d, taskId, by, `${prefix}${comment}`, now, true);
```

In `src/kanban/service.ts`, replace:

```ts
  reactsTo,
```

with:

```ts
  reactsTo,
  routeOfHandler,
```

In `src/kanban/service.ts`, replace:

```ts
  /**
   * A woken turn's `task show` (wake spec §9.2), given its delivered wake: a task
```

with:

```ts
  /**
   * A handler's run's `mt kanban unblock` (workflow routing spec §5.4): only its
   * work run, and only for the task its route was made from, found by its route
   * row, whatever its body says; while that task is still blocked by the route's
   * event, `stale` once anyone else lifted it. Its authority is the operator's
   * file, with no tier. A repeat of the same run's own unblock answers
   * `changed: false`. Its comment, if any, steers the next run, prefixed with
   * the handler's ref.
   */
  unblockFromHandler(run: RunRow, taskId: string, comment?: string): Result<{ task: TaskRow; changed: boolean }> {
    if (comment !== undefined && !isText(comment)) return board.refuse('invalid', 'a comment is text');
    const route = routeOfHandler(this.#db, run.taskId);
    if (route === undefined || run.kind !== 'work' || !isText(taskId) || route.fromTask !== taskId) {
      return board.refuse('wrong_task', `run ${run.runId} may unblock only the task its handler was routed from`);
    }
    const lifted = this.#db
      .prepare<[string, number], { actor: string }>("SELECT actor FROM kanban_events WHERE task_id = ? AND kind = 'unblocked' AND id > ? ORDER BY id LIMIT 1")
      .get(taskId, route.eventId);
    if (lifted?.actor === `run:${run.runId}`) {
      const task = getTask(this.#db, taskId);
      if (task === undefined) return board.refuse('not_found', `no task ${taskId}`);
      return { ok: true, task, changed: false };
    }
    const ref = memberOf(this.#db, run.taskId)?.ref ?? route.handler;
    const r = board.unblock(this.#db, taskId, `run:${run.runId}`, comment, this.#clock.now(), { blockedAt: route.eventId, handler: ref });
    return r.ok ? { ok: true, task: r.task, changed: true } : r;
  }

  /**
   * A woken turn's `task show` (wake spec §9.2), given its delivered wake: a task
```

In `src/kanban/worker.ts`, replace:

```ts
 * the tasks its own task created. It cannot move any other task.
```

with:

```ts
 * the tasks its own task created. It cannot move any other task, but for a
 * handler's work run, which may unblock the task its route was made from
 * (workflow routing spec §5.4).
```

In `src/kanban/worker.ts`, replace:

```ts
  'wake-unblock',
```

with:

```ts
  'wake-unblock',
  'unblock',
```

In `src/kanban/worker.ts`, replace:

```ts
  'wake-unblock': { task_id: name(), comment: text(WORKER_LIMITS.comment, false) },
```

with:

```ts
  'wake-unblock': { task_id: name(), comment: text(WORKER_LIMITS.comment, false) },
  // A handler's run's scope (workflow routing spec §5.4): the task its route was made from.
  unblock: { task_id: name(), comment: text(WORKER_LIMITS.comment, false) },
```

In `src/kanban/worker.ts`, replace:

```ts
      }
      case 'wake-show':
```

with:

```ts
      }
      case 'unblock': {
        const r = this.#service.unblockFromHandler(run, str('task_id') ?? '', str('comment'));
        return r.ok ? { ok: true, task_id: r.task.taskId, phase: r.task.phase, changed: r.changed } : refusal(r);
      }
      case 'wake-show':
```

- [ ] **Step 23.4: Run them to verify they pass.** Run the same command. Expected: `Tests  85 passed (85)`.

- [ ] **Step 23.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3704 passed (3704)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 23.6: Commit.**

```bash
git add README.md src/db/kanban.ts src/kanban/service.ts src/kanban/worker.ts tests/docs-wake.test.ts tests/kanban-worker.test.ts tests/mt-kanban-operator-tasks.test.ts tests/mt-kanban.test.ts tests/mt.test.ts tests/routing-unblock.test.ts
git commit -m "Let a handler's work run unblock the task its route was made from, authorised by the route row alone"
```

---

### Task 24: A stand-in's fields

**Files:**

- Create: `tests/routing-standin.test.ts`
- Modify: `src/db/kanban.ts`, `src/kanban/workflow.ts`

§5.2, §7.3. A stand-in's task is made with its step's reviewer, its step's gates before its own, and each contract field merged as the step's and then the handler's, all from the plan frozen at the start; its work report is checked against its step's outputs.

- [ ] **Step 24.1: Write the tests.**

Create `tests/routing-standin.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { gatesOf, getTask, membersOf } from '../src/db/kanban-read.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { VI_WORKFLOW, madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * A stand-in made (workflow routing spec §5.2): with its step's reviewer, its
 * step's gates first and then its own, each contract field merged as the step's
 * and then the handler's; all read from the plan frozen at the start, whatever
 * the file says now; and its work report checked against the step's outputs.
 */

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  b = viBoard(h, { limits: { failureLimit: 1, transientLimit: 10, transientCooldownS: 300 } });
});
afterEach(() => h.close());

const CVE = { kind: 'cve', verify: false, patch: false, bnpm: false, packages: [] };

/** va with a reviewer, a gate and a contract; escalate with a gate and a verification of its own. */
const FILE = VI_WORKFLOW.replace(
  '    assignee: vulnerability-analyst\n',
  '    assignee: vulnerability-analyst\n    reviewer: { role: assessment-reviewer }\n    outcome: a verdict on reachability\n    verify: cites the advisory\n    gates:\n      - { command: "vi-workflow-gate result.json", timeout_s: 30 }\n',
).replace('    stands_in_for: va\n', '    stands_in_for: va\n    verify: says who was asked\n    gates:\n      - { command: "test -s escalation.md", timeout_s: 10 }\n');

async function stoodIn(after?: () => void): Promise<string> {
  writeFileSync(join(b.dir, 'vi-workflow.yaml'), FILE);
  const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
  after?.();
  const intake = w.tasks[0]?.taskId ?? '';
  const ir = claimed(h.db, intake);
  await b.service.complete(intake, { kind: 'run', runId: ir.runId }, { summary: 'x', metadata: CVE });
  closeRun(h.db, ir.runId, NOW);
  const va = membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'va')?.taskId ?? '';
  const vr = claimed(h.db, va);
  b.service.endRun(vr.runId, { outcome: 'crashed' });
  closeRun(h.db, vr.runId, NOW);
  return membersOf(h.db, w.instance.instanceId).find((m) => m.step === 'escalate')?.taskId ?? '';
}

describe('a stand-in made', () => {
  it("takes its step's reviewer, its gates before its own, and each contract field merged", async () => {
    const escalate = await stoodIn();
    const task = getTask(h.db, escalate);
    expect(task?.reviewer).toEqual({ kind: 'role', name: 'assessment-reviewer' });
    expect(task?.contract).toEqual({
      outcome: "the step's (va): a verdict on reachability\n\nReport in the metadata of your completion: reachable (true or false).",
      verification: "the step's (va): cites the advisory\n\nthis handler's: says who was asked",
    });
    expect(gatesOf(h.db, escalate).map((g) => [g.command, g.timeoutS, g.createdBy])).toEqual([
      ['vi-workflow-gate result.json', 30, ALICE],
      ['test -s escalation.md', 10, ALICE],
    ]);
  });

  it('reads them from the plan frozen at the start, whatever the file says now', async () => {
    const escalate = await stoodIn(() => writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW));
    expect(getTask(h.db, escalate)?.reviewer).toEqual({ kind: 'role', name: 'assessment-reviewer' });
    expect(gatesOf(h.db, escalate).length).toBe(2);
  });

  it("checks its work report against its step's outputs", async () => {
    const escalate = await stoodIn();
    const run = claimed(h.db, escalate);
    expect(await b.service.complete(escalate, { kind: 'run', runId: run.runId }, { summary: 'asked upstream' })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'output reachable is missing',
    });
  });
});
```

- [ ] **Step 24.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-standin.test.ts`. Expected: `Tests  2 failed | 1 passed (3)`, the first as `AssertionError: expected null to deeply equal { kind: 'role', …(1) }`.

- [ ] **Step 24.3: Implement.**

In `src/db/kanban.ts`, replace:

```ts
import { decide as decideRouting, fillText, handlerParagraph, INSTANCE_CAP, maskPlan, resultOf, SKIPPED_TEXT, triggerWords, valueSaid, type Decision, type Facts, type Plan, type PlanStep, type RouteFact, type StepFact, type Template } from '../kanban/routing.js';
```

with:

```ts
import { decide as decideRouting, fillText, handlerParagraph, INSTANCE_CAP, maskPlan, resultOf, SKIPPED_TEXT, standInContract, triggerWords, valueSaid, type Decision, type Facts, type Plan, type PlanStep, type RouteFact, type StepFact, type Template } from '../kanban/routing.js';
```

In `src/db/kanban.ts`, replace:

```ts
  const workspace = t.workspace ?? (roleWorkspace === undefined ? routed.workspace : null);
```

with:

```ts
  const workspace = t.workspace ?? (roleWorkspace === undefined ? routed.workspace : null);
  // A stand-in takes its step's reviewer, gates and contract from the frozen plan, so its result is accepted as the step's would be (§5.2).
  const stood = dec.standsIn ? r.plan.steps.find((s) => s.step === from.step) : undefined;
  const theirs = stood === undefined ? undefined : (stood.templates?.find((x) => x.item === from.item) ?? stood.template);
  const fields =
    theirs === undefined
      ? { workspace }
      : { workspace, reviewer: theirs.reviewer, gates: [...theirs.gates, ...t.gates], contract: standInContract(from.step, theirs.contract, t.contract) };
```

In `src/db/kanban.ts`, replace:

```ts
    { step: dec.handler, ref: `${dec.handler}:${n}`, item: from.item, template: { ...t, workspace }, parents: [], payload: { routedFrom: from.taskId }, paragraph },
```

with:

```ts
    { step: dec.handler, ref: `${dec.handler}:${n}`, item: from.item, template: { ...t, ...fields }, parents: [], payload: { routedFrom: from.taskId }, paragraph },
```

In `src/kanban/workflow.ts`, replace:

```ts
      // The agent is told what to report, in its outcome (§2.1).
      if (Object.keys(s.outputs).length > 0) contract.outcome = outcomeWithOutputs(contract.outcome, s.outputs);
```

with:

```ts
      // The agent is told what to report, in its outcome (§2.1); a stand-in, in its step's, which its own merges with (§5.2).
      if (Object.keys(s.outputs).length > 0 && !(s.handler && s.standsInFor !== undefined)) contract.outcome = outcomeWithOutputs(contract.outcome, s.outputs);
```

- [ ] **Step 24.4: Run them to verify they pass.** Run the same command. Expected: `Tests  3 passed (3)`.

- [ ] **Step 24.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3707 passed (3707)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 24.6: Commit.**

```bash
git add src/db/kanban.ts src/kanban/workflow.ts tests/routing-standin.test.ts
git commit -m "Make a stand-in with its step's reviewer, its step's gates before its own, and each contract field merged, from the frozen plan"
```

---

### Task 25: A stand-in's settling

**Files:**

- Create: `tests/routing-standin-settle.test.ts`
- Modify: `src/db/kanban.ts`, `src/kanban/routing.ts`

§2.3, §5.2, §9.2. The sweep's facts for a member gain its stand-ins' completions: the earliest settling fact by event id wins, whichever transaction or reconciliation writes the row. A winning stand-in archives the routed task, unless it is already archived, from whatever phase, with its comment and the archive's `workflow` and `standIn`; a stand-in left open after the routed task's own completion is told once. A stand-in failing its step's gates settles nothing; one over a fan-out's source fans it out from its own list. The cap passed at a stand-in's completion skips what it would make, the completion kept.

- [ ] **Step 25.1: Write the tests.**

Create `tests/routing-standin-settle.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { commentsOf, eventsOf, getRun, getTask, membersOf, parentsOf, pendingOf, settledOf } from '../src/db/kanban-read.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { VI_WORKFLOW, madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * A stand-in's completion (workflow routing spec §5.2, §9.2, §9.5): the member
 * settled for the earliest settling fact by event id, whichever transaction or
 * reconciliation wrote it; a winning stand-in archiving its routed task, from
 * whatever phase, with its comment, unless it is archived already; one that
 * settles nothing archiving nothing; a stand-in left open after the routed
 * task's own completion told once; its review and its gates the step's; and the
 * cap passed at its completion skipping what it would make, the completion kept.
 */

let h: TestDb;
let b: ViBoard;
let workspace: string;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  workspace = mkdtempSync(join(h.dir, 'vi-'));
  b = viBoard(h, {
    limits: { failureLimit: 1, transientLimit: 10, transientCooldownS: 300 },
    // Gates run for real, in the workspace vi's directory (kanban spec §7.7).
    checks: { workspaceDirs: new Map([['vi', workspace]]), env: process.env },
  });
});
afterEach(() => h.close());

const CVE = { kind: 'cve', verify: true, patch: false, bnpm: false, packages: [] };

interface Routed {
  instanceId: string;
  intake: string;
  va: string;
}

async function report(taskId: string, metadata: Record<string, unknown>) {
  const run = claimed(h.db, taskId);
  const r = await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'done', metadata });
  closeRun(h.db, run.runId, NOW);
  return r;
}

function giveUp(taskId: string): string {
  const run = claimed(h.db, taskId);
  b.service.endRun(run.runId, { outcome: 'crashed' });
  closeRun(h.db, run.runId, NOW);
  return handlers().at(-1) ?? '';
}

let instance = '';
const handlers = () => membersOf(h.db, instance).filter((m) => m.step === 'escalate').map((m) => m.taskId);

async function routed(file = VI_WORKFLOW, intakeResult: Record<string, unknown> = CVE): Promise<Routed> {
  writeFileSync(join(b.dir, 'vi-workflow.yaml'), file);
  const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
  instance = w.instance.instanceId;
  const intake = w.tasks[0]?.taskId ?? '';
  await report(intake, intakeResult);
  return { instanceId: instance, intake, va: membersOf(h.db, instance).find((m) => m.step === 'va')?.taskId ?? '' };
}

const vaRow = () => settledOf(h.db, instance).find((s) => s.step === 'va');

describe("a stand-in's completion", () => {
  it('settles its step for it, archiving the routed task with its comment, and its dependents read its result', async () => {
    const { va } = await routed();
    const escalate = giveUp(va);
    expect((await report(escalate, { reachable: true })).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'stood_in', taskId: escalate });
    expect(getTask(h.db, va)?.phase).toBe('archived');
    expect(eventsOf(h.db, va).find((e) => e.kind === 'archived')).toMatchObject({ actor: 'gateway', payload: { from: 'blocked', workflow: instance, standIn: escalate } });
    expect(commentsOf(h.db, va).map((c) => c.body)).toEqual([`Stood in for by escalate:1 (${escalate}), whose result is read in va's place.`]);
    const verify = membersOf(h.db, instance).find((m) => m.step === 'verify')?.taskId ?? '';
    expect(parentsOf(h.db, verify).map((p) => p.taskId)).toEqual([escalate]);
    expect(eventsOf(h.db, escalate).find((e) => e.kind === 'workflow_routed')?.payload).toMatchObject({
      decisions: [
        { step: 'va', outcome: 'stood_in', why: 'reachable=true', taskIds: [va], handler: 'escalate' },
        { step: 'verify', outcome: 'made' },
        { step: 'exposure', outcome: 'skipped' },
      ],
    });
  });

  it('settles only once its review passes, its changes settling nothing', async () => {
    const { va } = await routed(
      VI_WORKFLOW.replace('    assignee: vulnerability-analyst\n', '    assignee: vulnerability-analyst\n    reviewer: { role: assessment-reviewer }\n'),
    );
    const escalate = giveUp(va);
    expect(await report(escalate, { reachable: true })).toMatchObject({ ok: true, task: { phase: 'review' } });
    expect(vaRow()).toBeUndefined();
    const review = claimed(h.db, escalate);
    expect(b.service.requestChanges(escalate, { kind: 'run', runId: review.runId }, 'cite the advisory').ok).toBe(true);
    closeRun(h.db, review.runId, NOW);
    expect(vaRow()).toBeUndefined();
    expect(await report(escalate, { reachable: false })).toMatchObject({ ok: true, task: { phase: 'review' } });
    const approve = claimed(h.db, escalate);
    expect((await b.service.complete(escalate, { kind: 'run', runId: approve.runId }, { summary: 'LGTM' })).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'stood_in', taskId: escalate });
  });

  it("lets the routed task's own completion win when it comes first, telling the stand-in left open, once", async () => {
    const { va } = await routed();
    const escalate = giveUp(va);
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    expect((await report(va, { reachable: false })).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'done', taskId: va });
    const told = `va was completed by its own task ${va}; this handler's result will not be read: finish or archive it`;
    expect(commentsOf(h.db, escalate).map((c) => c.body)).toEqual([told]);
    const routedPayload = eventsOf(h.db, va).filter((e) => e.kind === 'workflow_routed').at(-1)?.payload as { decisions: unknown[] };
    expect(routedPayload.decisions[0]).toEqual({ step: 'va', outcome: 'unread', why: 'va was completed by its own task', taskIds: [escalate], handler: 'escalate' });
    expect(b.service.reconcileWorkflow(instance).ok).toBe(true);
    expect(commentsOf(h.db, escalate).length).toBe(1);
    expect((await report(escalate, { reachable: true })).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'done', taskId: va });
    expect(getTask(h.db, va)?.phase).toBe('done');
  });

  it('settles a member once when two stand-ins are done, the lower completed id winning, the other archiving nothing', async () => {
    const { va } = await routed();
    const first = giveUp(va);
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    const second = giveUp(va);
    expect(second).not.toBe(first);
    expect((await report(second, { reachable: true })).ok).toBe(true);
    expect((await report(first, { reachable: false })).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'stood_in', taskId: second });
    expect(eventsOf(h.db, va).filter((e) => e.kind === 'archived').length).toBe(1);
  });

  it('gives the stand-in the row after its routing faulted and the routed task completed, with the event id the gateway would have written', async () => {
    const { va } = await routed();
    const escalate = giveUp(va);
    h.db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled WHEN NEW.step = 'va' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    expect((await report(escalate, { reachable: true })).ok).toBe(true);
    h.db.exec('DROP TRIGGER boom');
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    expect((await report(va, { reachable: false })).ok).toBe(true);
    const completed = eventsOf(h.db, escalate).find((e) => e.kind === 'completed')?.id;
    expect(vaRow()).toMatchObject({ how: 'stood_in', taskId: escalate, eventId: completed });
    expect(eventsOf(h.db, va).find((e) => e.kind === 'archived')?.payload).toMatchObject({ from: 'done', standIn: escalate });
    expect(b.service.reconcileWorkflow(instance).ok).toBe(true);
    expect(eventsOf(h.db, va).filter((e) => e.kind === 'archived').length).toBe(1);
  });

  it("gives an archive undone the row after its routing faulted, the stand-in done later settling nothing and archiving nothing", async () => {
    const { va } = await routed();
    const escalate = giveUp(va);
    h.db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled WHEN NEW.step = 'va' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    expect(b.service.archive(va, ALICE).ok).toBe(true);
    h.db.exec('DROP TRIGGER boom');
    expect((await report(escalate, { reachable: true })).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'archived', taskId: null });
    expect(eventsOf(h.db, va).filter((e) => e.kind === 'archived').length).toBe(1);
    expect(commentsOf(h.db, va)).toEqual([]);
  });

  it("settles nothing while a stand-in fails one of its step's gates, the run left undecided, and settles once it passes", async () => {
    const file = VI_WORKFLOW.replace(
      '    assignee: vulnerability-analyst\n',
      '    assignee: vulnerability-analyst\n    workspace: vi\n    gates:\n      - { command: "test -s result.json", timeout_s: 30 }\n',
    );
    const { va } = await routed(file);
    const vaRun = b.service.claim(va);
    if (!vaRun.ok) throw new Error(vaRun.message);
    b.service.endRun(vaRun.run.runId, { outcome: 'crashed' });
    closeRun(h.db, vaRun.run.runId, NOW);
    const escalate = handlers()[0] ?? '';
    expect(getTask(h.db, escalate)?.workspace).toBe('vi');
    const run = b.service.claim(escalate);
    if (!run.ok) throw new Error(run.message);
    const by = { kind: 'run', runId: run.run.runId } as const;
    expect(await b.service.complete(escalate, by, { summary: 'done', metadata: { reachable: true } })).toMatchObject({ ok: false, code: 'gate_failed' });
    expect(getRun(h.db, run.run.runId)?.outcome).toBeNull();
    expect(vaRow()).toBeUndefined();
    expect(getTask(h.db, va)?.phase).toBe('blocked');
    writeFileSync(join(workspace, 'result.json'), '{"reachable": true}\n');
    expect((await b.service.complete(escalate, by, { summary: 'done', metadata: { reachable: true } })).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'stood_in', taskId: escalate });
  });

  it("settles no item while an item's stand-in fails the fan-out step's gates, and the item once they pass", async () => {
    const file = `${VI_WORKFLOW.replace(
      '    for_each: { step: intake, output: packages }\n',
      '    for_each: { step: intake, output: packages }\n    workspace: vi\n    gates:\n      - { command: "test -s result.json", timeout_s: 30 }\n    on_gave_up: { route: redo }\n',
    )}  redo:\n    title: "{{case}} · exposure of {{item}}, redone"\n    assignee: vi-coordinator\n    handler: true\n    stands_in_for: exposure\n`;
    const { va } = await routed(file, { ...CVE, verify: false, packages: ['lodash', 'qs'] });
    expect((await report(va, { reachable: true })).ok).toBe(true);
    const qs = membersOf(h.db, instance).find((m) => m.step === 'exposure' && m.item === 'qs')?.taskId ?? '';
    const run = b.service.claim(qs);
    if (!run.ok) throw new Error(run.message);
    b.service.endRun(run.run.runId, { outcome: 'crashed' });
    closeRun(h.db, run.run.runId, NOW);
    const redo = membersOf(h.db, instance).find((m) => m.step === 'redo')?.taskId ?? '';
    const mine = b.service.claim(redo);
    if (!mine.ok) throw new Error(mine.message);
    const by = { kind: 'run', runId: mine.run.runId } as const;
    const itemRow = () => settledOf(h.db, instance).find((s) => s.step === 'exposure' && s.ref === 'exposure:2');
    expect(await b.service.complete(redo, by, { summary: 'done' })).toMatchObject({ ok: false, code: 'gate_failed' });
    expect(getRun(h.db, mine.run.runId)?.outcome).toBeNull();
    expect(itemRow()).toBeUndefined();
    expect(getTask(h.db, qs)?.phase).toBe('blocked');
    writeFileSync(join(workspace, 'result.json'), '{}\n');
    expect((await b.service.complete(redo, by, { summary: 'done' })).ok).toBe(true);
    expect(itemRow()).toMatchObject({ how: 'stood_in', taskId: redo });
    expect(getTask(h.db, qs)?.phase).toBe('archived');
  });

  it('skips what a stand-in would make past the cap at its completion, the completion and its settling kept', async () => {
    const { va } = await routed(VI_WORKFLOW, { ...CVE, verify: false, packages: ['a', 'b', 'c'] });
    const escalate = giveUp(va);
    // Members to one short of the cap: exposure over the intake's three packages would pass it.
    const task = h.db.prepare(
      `INSERT INTO kanban_tasks (task_id, title, contract, phase, created_by, created_via, created_at, board)
       VALUES (?, 'filler', jsonb('{}'), 'open', ?, jsonb('{"kind":"operator"}'), ?, 'vi')`,
    );
    const member = h.db.prepare("INSERT INTO kanban_workflow_tasks (task_id, instance_id, ref, step, item, position) VALUES (?, ?, ?, 'filler', NULL, ?)");
    const base = membersOf(h.db, instance).length;
    for (let i = 0; i < 499 - base; i += 1) {
      task.run(`k_fill${i}`, ALICE, NOW);
      member.run(`k_fill${i}`, instance, `filler:${i + 1}`, base + i);
    }
    expect((await report(escalate, { reachable: true })).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'stood_in', taskId: escalate });
    expect(pendingOf(h.db, instance).find((p) => p.step === 'exposure')).toMatchObject({ state: 'skipped', reason: { by: 'cap', why: 'the instance has 500 tasks' } });
    expect(membersOf(h.db, instance).filter((m) => m.step === 'exposure')).toEqual([]);
  });

  it("fans out over a stood-in source's list, each item's task linked to the stand-in, a list past the cap refused", async () => {
    const takeover = `  takeover:
    title: "{{case}} · intake, taken over"
    assignee: vi-coordinator
    handler: true
    stands_in_for: intake
    outputs:
      kind: { enum: [cve, supplychain] }
      verify: boolean
      patch: boolean
      bnpm: boolean
      packages: { list: string, max: 100 }
`;
    writeFileSync(
      join(b.dir, 'vi-workflow.yaml'),
      `${VI_WORKFLOW.replace('      packages: { list: string, max: 100 }\n  va:', '      packages: { list: string, max: 100 }\n    on_gave_up: { route: takeover }\n  va:')}${takeover}`,
    );
    const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
    instance = w.instance.instanceId;
    const intake = w.tasks[0]?.taskId ?? '';
    const run = claimed(h.db, intake);
    b.service.endRun(run.runId, { outcome: 'crashed' });
    closeRun(h.db, run.runId, NOW);
    const stand = membersOf(h.db, instance).find((m) => m.step === 'takeover')?.taskId ?? '';
    const result = { kind: 'supplychain', verify: false, patch: false, bnpm: false };
    const fill = h.db.prepare(
      `INSERT INTO kanban_tasks (task_id, title, contract, phase, created_by, created_via, created_at, board)
       VALUES (?, 'filler', jsonb('{}'), 'open', ?, jsonb('{"kind":"operator"}'), ?, 'vi')`,
    );
    const member = h.db.prepare("INSERT INTO kanban_workflow_tasks (task_id, instance_id, ref, step, item, position) VALUES (?, ?, ?, 'filler', NULL, ?)");
    const base = membersOf(h.db, instance).length;
    for (let i = 0; i < 450; i += 1) {
      fill.run(`k_fill${i}`, ALICE, NOW);
      member.run(`k_fill${i}`, instance, `filler:${i + 1}`, base + i);
    }
    const mine = claimed(h.db, stand);
    const by = { kind: 'run', runId: mine.runId } as const;
    const many = Array.from({ length: 60 }, (_, i) => `p${i}`);
    expect(await b.service.complete(stand, by, { summary: 'x', metadata: { ...result, packages: many } })).toMatchObject({ ok: false, code: 'too_large' });
    expect((await b.service.complete(stand, by, { summary: 'x', metadata: { ...result, packages: ['a', 'b'] } })).ok).toBe(true);
    const exposure = membersOf(h.db, instance).filter((m) => m.step === 'exposure');
    expect(exposure.map((m) => getTask(h.db, m.taskId)?.title)).toEqual(['CVE-1 · exposure of a', 'CVE-1 · exposure of b']);
    for (const m of exposure) expect(parentsOf(h.db, m.taskId).map((p) => p.taskId)).toEqual([stand]);
    expect(eventsOf(h.db, intake).find((e) => e.kind === 'archived')?.payload).toMatchObject({ workflow: instance, standIn: stand });
    expect(settledOf(h.db, instance).find((s) => s.step === 'intake')).toMatchObject({ how: 'stood_in', taskId: stand });
  });

  it('writes only the row for a stand-in winning over a routed task a person archived after its own done', async () => {
    const { va } = await routed();
    const escalate = giveUp(va);
    h.db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled WHEN NEW.step = 'va' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    expect((await report(escalate, { reachable: true })).ok).toBe(true);
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    expect((await report(va, { reachable: false })).ok).toBe(true);
    expect(b.service.archive(va, ALICE).ok).toBe(true);
    h.db.exec('DROP TRIGGER boom');
    expect(b.service.reconcileWorkflow(instance).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'stood_in', taskId: escalate });
    expect(eventsOf(h.db, va).filter((e) => e.kind === 'archived').map((e) => (e.payload as { from: string }).from)).toEqual(['done']);
    expect(commentsOf(h.db, va)).toEqual([]);
  });
});
```

- [ ] **Step 25.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-standin-settle.test.ts`. Expected: `Tests  10 failed | 1 passed (11)`, the first as `AssertionError: expected undefined to match object { how: 'stood_in', …(1) }`.

- [ ] **Step 25.3: Implement.**

In `src/db/kanban.ts`, replace:

```ts
import { decide as decideRouting, fillText, handlerParagraph, INSTANCE_CAP, maskPlan, resultOf, SKIPPED_TEXT, standInContract, triggerWords, valueSaid, type Decision, type Facts, type Plan, type PlanStep, type RouteFact, type StepFact, type Template } from '../kanban/routing.js';
```

with:

```ts
import { decide as decideRouting, fillText, handlerParagraph, INSTANCE_CAP, maskPlan, outputsText, resultOf, SKIPPED_TEXT, standInContract, triggerWords, valueSaid, type Decision, type Facts, type Plan, type PlanStep, type RouteFact, type StepFact, type Template } from '../kanban/routing.js';
```

In `src/db/kanban.ts`, replace:

```ts
  outcome: 'made' | 'skipped' | 'fanned_out' | 'routed' | 'over_limit' | 'over_cap';
```

with:

```ts
  outcome: 'made' | 'skipped' | 'fanned_out' | 'routed' | 'over_limit' | 'over_cap' | 'stood_in' | 'unread';
```

In `src/db/kanban.ts`, replace:

```ts
}

/**
 * The sweep (§9.2 step 2): each member with a settling fact gets its settled row,
```

with:

```ts
}

/** What a sweep did beyond its rows (§5.2, §9.5): its lines, and the runs its stand-ins' archives superseded. */
interface Swept {
  lines: RoutedLine[];
  superseded: RunRow[];
}

/**
 * The sweep (§9.2 step 2): each member with a settling fact gets its settled row,
```

In `src/db/kanban.ts`, replace:

```ts
 * its winner the earliest fact by event id, its own task's `completed` event or
 * its `archived` event when that archive was not from `done`; each fan-out
 * whose items all have rows, its own, `archived` when every item was archived
 * undone. Plain steps included; a handler's task is no step's member here.
```

with:

```ts
 * its winner the earliest fact by event id, among its own task's `completed`
 * event, each of its stand-ins' `completed` events, and its own `archived`
 * event when that archive was not from `done`; each fan-out whose items all have
 * rows, its own, `archived` when every item was archived undone. Plain steps
 * included; a handler's task is no step's member here. Only once a row is
 * written for a stand-in is the routed task archived, unless it is already, its
 * superseded run returned; and only when a row is written for the task's own
 * completion is each stand-in left open told its result will not be read.
```

In `src/db/kanban.ts`, replace:

```ts
function sweep(d: Db, r: Routed, now: number): void {
```

with:

```ts
function sweep(d: Db, r: Routed, now: number): Swept {
```

In `src/db/kanban.ts`, replace:

```ts
  const id = r.instance.instanceId;
  const handlers = new Set(r.plan.steps.filter((s) => s.handler === true).map((s) => s.step));
```

with:

```ts
  const id = r.instance.instanceId;
  const out: Swept = { lines: [], superseded: [] };
  const handlers = new Map(r.plan.steps.filter((s) => s.handler === true).map((s) => [s.step, s]));
  const routes = routesOf(d, id);
```

In `src/db/kanban.ts`, replace:

```ts
    const archive = archived !== undefined && isRecord(archived.payload) && archived.payload['from'] !== 'done' ? archived : undefined;
```

with:

```ts
    const archive = archived !== undefined && isRecord(archived.payload) && archived.payload['from'] !== 'done' ? archived : undefined;
    // Its stand-ins: the handlers routed from its task that stand in for its step (§5.2).
    const standIns = routes.filter((x) => x.fromTask === m.taskId && x.outcome === 'made' && x.taskId !== null && handlers.get(x.handler)?.stands_in_for === m.step);
```

In `src/db/kanban.ts`, replace:

```ts
      ...(completed === undefined ? [] : [{ how: 'done', taskId: m.taskId as string | null, eventId: completed.id }]),
      ...(archive === undefined ? [] : [{ how: 'archived', taskId: null, eventId: archive.id }]),
```

with:

```ts
      ...(completed === undefined ? [] : [{ how: 'done', taskId: m.taskId as string | null, eventId: completed.id, handler: undefined as string | undefined }]),
      ...(archive === undefined ? [] : [{ how: 'archived', taskId: null, eventId: archive.id, handler: undefined }]),
      ...standIns.flatMap((x) => {
        const done = firstEventOf(d, x.taskId as string, 'completed');
        return done === undefined ? [] : [{ how: 'stood_in', taskId: x.taskId, eventId: done.id, handler: x.handler }];
      }),
```

In `src/db/kanban.ts`, replace:

```ts
    if (settle(d, id, m.step, m.ref, winner.how, winner.taskId, winner.eventId, now)) taken.add(`${m.step}\u0000${m.ref}`);
```

with:

```ts
    if (!settle(d, id, m.step, m.ref, winner.how, winner.taskId, winner.eventId, now)) continue;
    taken.add(`${m.step}\u0000${m.ref}`);
    if (winner.how === 'stood_in' && winner.taskId !== null) standingIn(d, r, m, winner.taskId, winner.handler ?? '', now, out);
    if (winner.how === 'done') {
      for (const x of standIns) {
        const left = getTask(d, x.taskId as string);
        if (left === undefined || left.phase === 'done' || left.phase === 'archived') continue;
        insertComment(d, left.taskId, 'gateway', `${m.step} was completed by its own task ${m.taskId}; this handler's result will not be read: finish or archive it`, now, false);
        out.lines.push({ step: m.step, outcome: 'unread', why: `${m.step} was completed by its own task`, taskIds: [left.taskId], handler: x.handler });
      }
    }
```

In `src/db/kanban.ts`, replace:

```ts
    settle(d, id, s.step, s.step, how, null, Math.max(...items.map((x) => x.eventId)), now);
  }
}
```

with:

```ts
    settle(d, id, s.step, s.step, how, null, Math.max(...items.map((x) => x.eventId)), now);
  }
  return out;
}

/**
 * A stand-in won its member (§5.2): the routed task archived, unless it is
 * already, from whatever phase it is in, its undecided run superseded, the
 * archive naming the instance and the stand-in, with a comment that does not
 * steer; and the line saying it stood in, with its outputs.
 */
function standingIn(d: Db, r: Routed, m: MemberRow & { task: TaskRow }, standIn: string, handler: string, now: number, out: Swept): void {
  const ref = memberOf(d, standIn)?.ref ?? handler;
  const routed = mustGet(d, m.taskId);
  const outputs = r.plan.steps.find((s) => s.step === m.step)?.outputs ?? {};
  const metadata = latestCompletion(d, standIn)?.metadata;
  const said = outputsText(outputs, isRecord(metadata) ? metadata : null);
  out.lines.push({ step: m.step, outcome: 'stood_in', why: said, taskIds: [m.taskId], handler });
  if (routed.phase === 'archived') return;
  // Only a run the archive itself ended: one that had reported, and is finishing, is left to end its own turn.
  const undecided = openRunOf(d, routed.taskId)?.outcome === null;
  const archived = archiveIn(d, routed, 'gateway', now, { workflow: r.instance.instanceId, standIn });
  if (undecided && archived.run !== undefined) out.superseded.push(archived.run);
  insertComment(d, m.taskId, 'gateway', `Stood in for by ${ref} (${standIn}), whose result is read in ${m.step}'s place.`, now, false);
}
```

In `src/db/kanban.ts`, replace:

```ts
function decideAll(d: Db, instance: InstanceRow, causeEvent: number | null, now: number, team: RouteTeam | undefined): RoutedLine[] {
  const lines: RoutedLine[] = [];
```

with:

```ts
function decideAll(d: Db, instance: InstanceRow, causeEvent: number | null, now: number, team: RouteTeam | undefined): Swept {
  const out: Swept = { lines: [], superseded: [] };
```

In `src/db/kanban.ts`, replace:

```ts
  if (first === undefined) return lines;
```

with:

```ts
  if (first === undefined) return out;
```

In `src/db/kanban.ts`, replace:

```ts
    sweep(d, r, now);
```

with:

```ts
    const swept = sweep(d, r, now);
    out.lines.push(...swept.lines);
    out.superseded.push(...swept.superseded);
```

In `src/db/kanban.ts`, replace:

```ts
    if (decisions.length === 0) break;
```

with:

```ts
    if (decisions.length === 0 && swept.lines.length === 0) break;
```

In `src/db/kanban.ts`, replace:

```ts
      if (line !== undefined) lines.push(line);
```

with:

```ts
      if (line !== undefined) out.lines.push(line);
```

In `src/db/kanban.ts`, replace:

```ts
  return lines;
```

with:

```ts
  return out;
```

In `src/db/kanban.ts`, replace:

```ts
  const lines = decideAll(d, planned.instance, eventId, now, team);
```

with:

```ts
  const { lines } = decideAll(d, planned.instance, eventId, now, team);
```

In `src/db/kanban.ts`, replace:

```ts
    const decisions = decideAll(d, instance, null, now, team);
```

with:

```ts
    const { lines: decisions } = decideAll(d, instance, null, now, team);
```

In `src/kanban/routing.ts`, replace:

```ts
  ].join('\n');
}
```

with:

```ts
  ].join('\n');
}

/**
 * A step's accepted outputs as a line says them (§12.1, §12.2): each scalar as
 * `name=value`, a list as its count and name, `3 packages`; missing ones left
 * out; cut at `max` characters.
 */
export function outputsText(outputs: Outputs, result: Readonly<Record<string, unknown>> | null, max = 120): string {
  const parts = Object.entries(outputs).flatMap(([name, t]) => {
    const value = result?.[name];
    if (!ofType(t, value)) return [];
    return Array.isArray(value) ? [`${value.length} ${name}`] : [`${name}=${valueSaid(value)}`];
  });
  const text = parts.join(', ');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
```

- [ ] **Step 25.4: Run them to verify they pass.** Run the same command. Expected: `Tests  11 passed (11)`.

- [ ] **Step 25.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3718 passed (3718)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 25.6: Commit.**

```bash
git add src/db/kanban.ts src/kanban/routing.ts tests/routing-standin-settle.test.ts
git commit -m "Settle a member for its earliest settling fact, archiving the task a winning stand-in stood in for with its comment"
```

---

### Task 26: The runs a stand-in's archive supersedes

**Files:**

- Create: `tests/routing-superseded.test.ts`
- Modify: `src/db/kanban.ts`, `src/index.ts`, `src/kanban/service.ts`

§9.5. The runs a winning stand-in's archive ended `superseded` are returned as `superseded` by every deciding writer and the reconciliation, and cancelled by the service through the new `KanbanServiceDeps.cancelRun`, which `src/index.ts` gives as a late-bound closure over the dispatcher: on the stand-in's own completion, a reconciliation, the routing retry, and another member's archive, block or give-up; a run that had reported already is left to end its own turn.

- [ ] **Step 26.1: Write the tests.**

Create `tests/routing-superseded.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, getRun, membersOf, settledOf } from '../src/db/kanban-read.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { VI_WORKFLOW, madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * The runs a winning stand-in's archive supersedes (workflow routing spec
 * §9.5): the routed task's undecided run ended `superseded` and its turn
 * cancelled through the service, on every path a sweep runs by, from whatever
 * phase the routed task is in.
 */

let h: TestDb;
let b: ViBoard;
let cancelled: string[];
beforeEach(() => {
  clearSecrets();
  h = testDb();
  cancelled = [];
  b = viBoard(h, {
    limits: { failureLimit: 1, transientLimit: 10, transientCooldownS: 300 },
    cancelRun: (runId) => {
      cancelled.push(runId);
      return true;
    },
  });
});
afterEach(() => h.close());

// Registry is made with va, so another member is open beside it.
const CVE = { kind: 'cve', verify: true, patch: false, bnpm: true, packages: [] };

let instance = '';
const memberOf = (step: string) => membersOf(h.db, instance).find((m) => m.step === step)?.taskId ?? '';
const vaRow = () => settledOf(h.db, instance).find((s) => s.step === 'va');
const BOOM = "CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled WHEN NEW.step = 'va' BEGIN SELECT RAISE(ABORT, 'boom'); END;";

async function report(taskId: string, metadata: Record<string, unknown>) {
  const run = claimed(h.db, taskId);
  const r = await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'done', metadata });
  closeRun(h.db, run.runId, NOW);
  return r;
}

async function routed(file = VI_WORKFLOW): Promise<string> {
  writeFileSync(join(b.dir, 'vi-workflow.yaml'), file);
  const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
  instance = w.instance.instanceId;
  await report(w.tasks[0]?.taskId ?? '', CVE);
  return memberOf('va');
}

/** va given up, its stand-in done while the routing of va faults: va's row is still to write. */
async function stoodInUnwritten(va: string): Promise<string> {
  const run = claimed(h.db, va);
  b.service.endRun(run.runId, { outcome: 'crashed' });
  closeRun(h.db, run.runId, NOW);
  const escalate = memberOf('escalate');
  h.db.exec(BOOM);
  expect((await report(escalate, { reachable: true })).ok).toBe(true);
  expect(vaRow()).toBeUndefined();
  return escalate;
}

/** A claim of another member, in a workspace of its own: the default is held by va's rerun. */
function claimedApart(taskId: string) {
  h.db.prepare("UPDATE kanban_tasks SET workspace = 'vi' WHERE task_id = ?").run(taskId);
  const run = b.service.claim(taskId);
  if (!run.ok) throw new Error(run.message);
  return run.run;
}

const SWEEPS: [string, () => void][] = [
  ['its reconciliation', () => expect(b.service.reconcileWorkflow(instance).ok).toBe(true)],
  ['the routing retry', () => expect(b.service.retryRouting()).toBe(1)],
  ["another member's archive", () => expect(b.service.archive(memberOf('registry'), ALICE).ok).toBe(true)],
  [
    "a run's block of another member",
    () => {
      const run = claimedApart(memberOf('registry'));
      expect(b.service.block(memberOf('registry'), { kind: 'run', runId: run.runId }, { kind: 'capability', reason: 'no network' }).ok).toBe(true);
    },
  ],
  [
    "another member's give-up",
    () => {
      const run = claimedApart(memberOf('registry'));
      expect(b.service.endRun(run.runId, { outcome: 'crashed' }).ok).toBe(true);
    },
  ],
];

describe("a winning stand-in's superseded runs", () => {
  it("archives the routed task's rerun from open when the stand-in wins, its run superseded, returned and cancelled", async () => {
    const va = await routed();
    const run = claimed(h.db, va);
    b.service.endRun(run.runId, { outcome: 'crashed' });
    closeRun(h.db, run.runId, NOW);
    const escalate = memberOf('escalate');
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    const rerun = b.service.claim(va);
    if (!rerun.ok) throw new Error(rerun.message);
    // The stand-in's run, through the service: its workspace is the default's too, held by va's rerun, so it reports as a person's would not.
    const stand = claimedApart(escalate);
    const r = await b.service.complete(escalate, { kind: 'run', runId: stand.runId }, { summary: 'done', metadata: { reachable: true } });
    expect(r).toMatchObject({ ok: true, superseded: [{ runId: rerun.run.runId, outcome: 'superseded' }] });
    expect(getRun(h.db, rerun.run.runId)?.outcome).toBe('superseded');
    expect(eventsOf(h.db, va).find((e) => e.kind === 'archived')?.payload).toMatchObject({ from: 'open', standIn: escalate });
    expect(cancelled).toEqual([rerun.run.runId]);
  });

  it.each(SWEEPS)("ends the routed task's claimed rerun superseded and cancels its turn when %s writes the stand-in's row", async (_how, sweep) => {
    const va = await routed();
    const escalate = await stoodInUnwritten(va);
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    const rerun = b.service.claim(va);
    if (!rerun.ok) throw new Error(rerun.message);
    h.db.exec('DROP TRIGGER boom');
    sweep();
    expect(vaRow()).toMatchObject({ how: 'stood_in', taskId: escalate });
    expect(getRun(h.db, rerun.run.runId)?.outcome).toBe('superseded');
    expect(eventsOf(h.db, va).find((e) => e.kind === 'archived')?.payload).toMatchObject({ from: 'open', standIn: escalate });
    expect(cancelled).toEqual([rerun.run.runId]);
  });

  it("ends the routed task's review run superseded when the stand-in wins over it in review", async () => {
    const va = await routed(
      VI_WORKFLOW.replace('    assignee: vulnerability-analyst\n', '    assignee: vulnerability-analyst\n    reviewer: { role: assessment-reviewer }\n'),
    );
    const run = claimed(h.db, va);
    b.service.endRun(run.runId, { outcome: 'crashed' });
    closeRun(h.db, run.runId, NOW);
    const escalate = memberOf('escalate');
    h.db.exec(BOOM);
    expect(await report(escalate, { reachable: true })).toMatchObject({ ok: true, task: { phase: 'review' } });
    const approve = claimed(h.db, escalate);
    expect((await b.service.complete(escalate, { kind: 'run', runId: approve.runId }, { summary: 'LGTM' })).ok).toBe(true);
    closeRun(h.db, approve.runId, NOW);
    expect(vaRow()).toBeUndefined();
    expect(b.service.unblock(va, ALICE).ok).toBe(true);
    expect(await report(va, { reachable: false })).toMatchObject({ ok: true, task: { phase: 'review' } });
    const review = b.service.claim(va);
    if (!review.ok) throw new Error(review.message);
    h.db.exec('DROP TRIGGER boom');
    expect(b.service.reconcileWorkflow(instance).ok).toBe(true);
    expect(vaRow()).toMatchObject({ how: 'stood_in', taskId: escalate });
    expect(getRun(h.db, review.run.runId)?.outcome).toBe('superseded');
    expect(eventsOf(h.db, va).find((e) => e.kind === 'archived')?.payload).toMatchObject({ from: 'review', standIn: escalate });
    expect(cancelled).toEqual([review.run.runId]);
  });
});
```

- [ ] **Step 26.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-superseded.test.ts`. Expected: `Tests  7 failed (7)`, the first as `AssertionError: expected { ok: true, task: { …(34) }, …(1) } to match object { ok: true, superseded: [ { …(2) } ] }`.

- [ ] **Step 26.3: Implement.**

In `src/db/kanban.ts`, replace:

```ts
  now: number,
  team?: RouteTeam,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return tx(db, (d) => {
    const r = reporting(d, taskId, by, ['open', 'review'], 'be completed', { answer: true });
```

with:

```ts
  now: number,
  team?: RouteTeam,
): Result<{ task: TaskRow; run: RunRow | undefined; superseded?: RunRow[] }> {
  return tx(db, (d) => {
    const r = reporting(d, taskId, by, ['open', 'review'], 'be completed', { answer: true });
```

In `src/db/kanban.ts`, replace:

```ts
    routeAfter(d, taskId, 'completed', completed, now, team);
    return { ok: true, task: mustGet(d, taskId), run: r.run === undefined ? undefined : mustGetRun(d, r.run.runId) };
```

with:

```ts
    const superseded = routeAfter(d, taskId, 'completed', completed, now, team);
    return { ok: true, ...withSuperseded({ task: mustGet(d, taskId), run: r.run === undefined ? undefined : mustGetRun(d, r.run.runId) }, superseded) };
```

In `src/db/kanban.ts`, replace:

```ts
  now: number,
  team?: RouteTeam,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return tx(db, (d) => {
    const r = reporting(d, taskId, by, ['open', 'review'], 'be blocked');
```

with:

```ts
  now: number,
  team?: RouteTeam,
): Result<{ task: TaskRow; run: RunRow | undefined; superseded?: RunRow[] }> {
  return tx(db, (d) => {
    const r = reporting(d, taskId, by, ['open', 'review'], 'be blocked');
```

In `src/db/kanban.ts`, replace:

```ts
    const r = reporting(d, taskId, by, ['open', 'review'], 'be blocked');
```

with:

```ts
    const r = reporting(d, taskId, by, ['open', 'review'], 'be blocked');
    let superseded: RunRow[] = [];
```

In `src/db/kanban.ts`, replace:

```ts
      if (by.kind === 'run' && r.task.phase === 'open') routeAfter(d, taskId, 'blocked', blocked, now, team);
```

with:

```ts
      if (by.kind === 'run' && r.task.phase === 'open') superseded = routeAfter(d, taskId, 'blocked', blocked, now, team);
```

In `src/db/kanban.ts`, replace:

```ts
    }
    return { ok: true, task: mustGet(d, taskId), run: r.run === undefined ? undefined : mustGetRun(d, r.run.runId) };
```

with:

```ts
    }
    return { ok: true, ...withSuperseded({ task: mustGet(d, taskId), run: r.run === undefined ? undefined : mustGetRun(d, r.run.runId) }, superseded) };
```

In `src/db/kanban.ts`, replace:

```ts
): Result<{ task: TaskRow; run: RunRow; next: NextStep }> {
```

with:

```ts
): Result<{ task: TaskRow; run: RunRow; next: NextStep; superseded?: RunRow[] }> {
```

In `src/db/kanban.ts`, replace:

```ts
    // A run's end that blocked the task from its work is a trigger (workflow routing spec §5.1).
```

with:

```ts
    // A run's end that blocked the task from its work is a trigger (workflow routing spec §5.1).
    let superseded: RunRow[] = [];
```

In `src/db/kanban.ts`, replace:

```ts
      routeAfter(d, run.taskId, cause, ended, now, team);
```

with:

```ts
      superseded = routeAfter(d, run.taskId, cause, ended, now, team);
```

In `src/db/kanban.ts`, replace:

```ts
    return { ok: true, task: mustGet(d, run.taskId), run: mustGetRun(d, runId), next };
```

with:

```ts
    return { ok: true, ...withSuperseded({ task: mustGet(d, run.taskId), run: mustGetRun(d, runId), next }, superseded) };
```

In `src/db/kanban.ts`, replace:

```ts
  team?: RouteTeam,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
```

with:

```ts
  team?: RouteTeam,
): Result<{ task: TaskRow; run: RunRow | undefined; superseded?: RunRow[] }> {
```

In `src/db/kanban.ts`, replace:

```ts
    routeAfter(d, taskId, 'archived', archived.eventId, now, team);
    return { ok: true, task: mustGet(d, taskId), run: archived.run };
```

with:

```ts
    const superseded = routeAfter(d, taskId, 'archived', archived.eventId, now, team);
    return { ok: true, ...withSuperseded({ task: mustGet(d, taskId), run: archived.run }, superseded) };
```

In `src/db/kanban.ts`, replace:

```ts
function routeAfter(d: Db, taskId: string, cause: RouteCause, eventId: number, now: number, team?: RouteTeam): void {
  if (!hasRouting(d)) return;
```

with:

```ts
function routeAfter(d: Db, taskId: string, cause: RouteCause, eventId: number, now: number, team?: RouteTeam): RunRow[] {
  if (!hasRouting(d)) return [];
```

In `src/db/kanban.ts`, replace:

```ts
    d.transaction(() => routeIn(d, taskId, cause, eventId, now, team))();
```

with:

```ts
    return d.transaction(() => routeIn(d, taskId, cause, eventId, now, team))();
```

In `src/db/kanban.ts`, replace:

```ts
    routingFault(d, taskId, err, now);
```

with:

```ts
    routingFault(d, taskId, err, now);
    return [];
```

In `src/db/kanban.ts`, replace:

```ts
    return [];
  }
}
```

with:

```ts
    return [];
  }
}

/** A transition's result with the runs its routing superseded (§9.5), when there are any. */
function withSuperseded<T extends object>(result: T, superseded: readonly RunRow[]): T & { superseded?: RunRow[] } {
  return superseded.length === 0 ? result : { ...result, superseded: [...superseded] };
}
```

In `src/db/kanban.ts`, replace:

```ts
/** The routing's body, inside its savepoint. */
function routeIn(d: Db, taskId: string, cause: RouteCause, eventId: number, now: number, team?: RouteTeam): void {
```

with:

```ts
/** The routing's body, inside its savepoint: answers the runs it superseded. */
function routeIn(d: Db, taskId: string, cause: RouteCause, eventId: number, now: number, team?: RouteTeam): RunRow[] {
```

In `src/db/kanban.ts`, replace:

```ts
  if (planned === undefined) return;
  const { lines } = decideAll(d, planned.instance, eventId, now, team);
  if (lines.length === 0) return;
```

with:

```ts
  if (planned === undefined) return [];
  const { lines, superseded } = decideAll(d, planned.instance, eventId, now, team);
  if (lines.length === 0) return superseded;
```

In `src/db/kanban.ts`, replace:

```ts
    },
    now,
  );
}

/** A reconciliation's answer (§11): the instance, and each decision it made. */
```

with:

```ts
    },
    now,
  );
  return superseded;
}

/** A reconciliation's answer (§11): the instance, each decision it made, and the runs a stand-in's archive superseded. */
```

In `src/db/kanban.ts`, replace:

```ts
  decisions: RoutedLine[];
```

with:

```ts
  decisions: RoutedLine[];
  superseded?: RunRow[];
```

In `src/db/kanban.ts`, replace:

```ts
    const { lines: decisions } = decideAll(d, instance, null, now, team);
```

with:

```ts
    const { lines: decisions, superseded } = decideAll(d, instance, null, now, team);
```

In `src/db/kanban.ts`, replace:

```ts
    return { ok: true, instance: getInstance(d, instanceId) as InstanceRow, decisions };
```

with:

```ts
    return { ok: true, ...withSuperseded({ instance: getInstance(d, instanceId) as InstanceRow, decisions }, superseded) };
```

In `src/index.ts`, replace:

```ts
      wake: { enabled: config.kanban.wake.enabled, maxDepth: config.kanban.wake.maxDepth },
```

with:

```ts
      wake: { enabled: config.kanban.wake.enabled, maxDepth: config.kanban.wake.maxDepth },
      // A stand-in's archive supersedes its routed task's run; the dispatcher is built after the service (workflow routing spec §9.5).
      cancelRun: (runId) => dispatcher?.cancel(runId) ?? false,
```

In `src/kanban/service.ts`, replace:

```ts
  wake?: { enabled: boolean; maxDepth: number };
```

with:

```ts
  wake?: { enabled: boolean; maxDepth: number };
  /**
   * Cancel a run's turn, as the dispatcher's `cancel` does (workflow routing spec
   * §9.5): for the runs a stand-in's archive superseded, on every path that
   * routes. Answers whether a turn was asked to stop. Absent -- tests of the
   * board alone -- none is cancelled, and the dispatcher's pass is the backstop.
   */
  cancelRun?: (runId: string) => boolean;
```

In `src/kanban/service.ts`, replace:

```ts
  readonly #wake: { enabled: boolean; maxDepth: number };
```

with:

```ts
  readonly #wake: { enabled: boolean; maxDepth: number };
  readonly #cancelRun: ((runId: string) => boolean) | undefined;
```

In `src/kanban/service.ts`, replace:

```ts
    this.#wake = deps.wake ?? { enabled: true, maxDepth: 5 };
```

with:

```ts
    this.#wake = deps.wake ?? { enabled: true, maxDepth: 5 };
    this.#cancelRun = deps.cancelRun;
  }

  /**
   * The turns of the runs a routing superseded, cancelled (workflow routing spec
   * §9.5): one place for every caller, chat, the worker API, the dispatcher, the
   * reconciliations; a caller that cancels too cancels an already-cancelled run,
   * which does nothing.
   */
  #cancelled<T>(r: T): T {
    const superseded = (r as { ok?: boolean; superseded?: RunRow[] }).superseded;
    for (const run of superseded ?? []) {
      try {
        this.#cancelRun?.(run.runId);
      } catch {
        // Its turn is the dispatcher's: its pass cancels a superseded run's turn too.
      }
    }
    return r;
```

In `src/kanban/service.ts`, replace:

```ts
    return board.endRun(this.#db, runId, ending, this.#limits, this.#clock.now(), this.#facts());
```

with:

```ts
    return this.#cancelled(board.endRun(this.#db, runId, ending, this.#limits, this.#clock.now(), this.#facts()));
```

In `src/kanban/service.ts`, replace:

```ts
      board.complete(this.#db, taskId, by, { ...handoff, ...seen }, this.#clock.now(), this.#facts()),
```

with:

```ts
      this.#cancelled(board.complete(this.#db, taskId, by, { ...handoff, ...seen }, this.#clock.now(), this.#facts())),
```

In `src/kanban/service.ts`, replace:

```ts
    return board.block(
      this.#db,
      taskId,
      by,
      { kind, reason: report.reason, ...(report.parents === undefined ? {} : { parents: report.parents }) },
      this.#clock.now(),
      this.#facts(),
```

with:

```ts
    return this.#cancelled(
      board.block(
        this.#db,
        taskId,
        by,
        { kind, reason: report.reason, ...(report.parents === undefined ? {} : { parents: report.parents }) },
        this.#clock.now(),
        this.#facts(),
      ),
```

In `src/kanban/service.ts`, replace:

```ts
    return board.archive(this.#db, taskId, by, this.#clock.now(), this.#facts());
```

with:

```ts
    return this.#cancelled(board.archive(this.#db, taskId, by, this.#clock.now(), this.#facts()));
```

In `src/kanban/service.ts`, replace:

```ts
    return board.reconcileWorkflow(this.#db, instanceId, this.#clock.now(), this.#facts());
```

with:

```ts
    return this.#cancelled(board.reconcileWorkflow(this.#db, instanceId, this.#clock.now(), this.#facts()));
```

- [ ] **Step 26.4: Run them to verify they pass.** Run the same command. Expected: `Tests  7 passed (7)`.

- [ ] **Step 26.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3725 passed (3725)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 26.6: Commit.**

```bash
git add src/db/kanban.ts src/index.ts src/kanban/service.ts tests/routing-superseded.test.ts
git commit -m "End the runs a winning stand-in's archive superseded and cancel their turns through the service, on every path its routing runs by"
```

---

## Phase 5: what people see, and reconciliation

Tasks 27 to 32. `workflow show`'s step lines and its terminal flags; the notices; the preview, the start's reply and `waiting`; `mt kanban workflow reconcile` and the startup's reconciliation; the documents; and the end-to-end test through `createGateway`. Phase 5 ends green, and the branch is merged whole.

---

### Task 27: workflow show's step lines

**Files:**

- Create: `tests/routing-show.test.ts`
- Modify: `README.md`, `src/cli/mt.ts`, `src/cli/operator.ts`, `src/cli/plain.ts`, `src/db/kanban-read.ts`, `src/kanban/chat-render.ts`, `src/kanban/routing.ts`, `src/kanban/service.ts`

§12.1. `stepLines` in `routing.ts` makes every step's line, real or pending, in the plan's order; `KanbanService.instance` reads the pending, settled and route rows and the settled steps' results for it, and the failed-routing line's error; `renderInstance` and `instanceText` print each line with its tasks under it. At the terminal, `--json` gains `steps`, `--plan` prints the plan, masked, and `--dag` of an instance with a plan says on stderr that it holds only the steps made at the start.

- [ ] **Step 27.1: Write the tests.**

Create `tests/routing-show.test.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { closeRun, createBoard } from '../src/db/kanban.js';
import { membersOf } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { renderInstance } from '../src/kanban/chat-render.js';
import { stepLines, type Plan } from '../src/kanban/routing.js';
import { KanbanService } from '../src/kanban/service.js';
import { clearSecrets } from '../src/secrets.js';
import { ManualClock, SCHEMA_DIR } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';
import { VI_ROLES, VI_WORKFLOW, madeOf, viRoles } from './helpers/routing.js';

/**
 * What `workflow show` says of a routed instance (workflow routing spec §12.1):
 * every step, real or pending, in the plan's order, with where it is and why,
 * its tasks under it; a handler never routed to absent; the failed-routing line;
 * and at the terminal, `--json`'s steps, `--plan`, and `--dag`'s note.
 */

let f: MtFixture;
let db: Db;
let service: KanbanService;
beforeEach(() => {
  clearSecrets();
  f = mtFixture();
  for (const name of VI_ROLES) {
    mkdirSync(join(f.home, 'roles', name), { recursive: true });
    writeFileSync(join(f.home, 'roles', name, 'config.yaml'), 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
  }
  mkdirSync(join(f.home, 'workflows'));
  writeFileSync(join(f.home, 'workflows', 'vi-workflow.yaml'), VI_WORKFLOW);
  db = openDb(join(f.home, 'team.db'));
  migrate(db, SCHEMA_DIR);
  createBoard(db, 'vi', ALICE, NOW);
  service = new KanbanService({
    db,
    roles: viRoles(),
    workspaces: new Set(['default']),
    supervisedRoles: true,
    workflowsDir: join(f.home, 'workflows'),
    clock: new ManualClock(NOW),
    limits: { failureLimit: 1, transientLimit: 10, transientCooldownS: 300 },
  });
});
afterEach(() => {
  clearSecrets();
  db.close();
  f.cleanup();
});

async function done(taskId: string, metadata: Record<string, unknown> = {}): Promise<void> {
  const run = claimed(db, taskId);
  const r = await service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'did it', metadata });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  closeRun(db, run.runId, NOW);
}

/** The vi file's instance, its intake done, va stood in for by escalate, one exposure item done. */
async function staged(): Promise<string> {
  const w = madeOf(service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
  const id = w.instance.instanceId;
  await done(w.tasks[0]?.taskId ?? '', { kind: 'cve', verify: false, patch: false, bnpm: false, packages: ['lodash', 'minimist', 'qs'] });
  const step = (s: string) => membersOf(db, id).filter((m) => m.step === s).map((m) => m.taskId);
  const va = step('va')[0] ?? '';
  const run = claimed(db, va);
  service.endRun(run.runId, { outcome: 'crashed' });
  closeRun(db, run.runId, NOW);
  await done(step('escalate')[0] ?? '', { reachable: true });
  await done(step('exposure')[0] ?? '');
  return id;
}

const anon = (text: string) => text.replace(/k_[a-z0-9]+/g, 'k_…').replace(/w_[a-z0-9]+/g, 'w_…');

describe('workflow show of a routed instance', () => {
  it("says every step in the plan's order, where it is and why, its tasks under it", async () => {
    const id = await staged();
    const r = service.instance(id);
    if (!r.ok) throw new Error(r.message);
    const text = renderInstance(r.view, 'vi', (a) => (a === null ? 'nobody' : `role ${a.name}`), () => undefined);
    // Chat's markdown escapes the parentheses, as every label does.
    expect(anon(text).split('\n').slice(3)).toEqual([
      'Params: case: CVE-1',
      '✓ intake: done \\(kind=cve, verify=false, patch=false, bnpm=false, 3 packages\\)',
      '- `k_…` done · role vi-coordinator',
      '✓ va: done, stood in for by escalate \\(reachable=true\\)',
      '- `k_…` archived · role vulnerability-analyst',
      '↪ escalate: routed from va \\(gave up\\), standing in',
      '- `k_…` escalate:1 done · role vi-coordinator',
      '⏭ verify: skipped \\(intake.verify is false\\)',
      '▶ exposure: 3 items, 1 done',
      '- `k_…` lodash: done · role exposure-analyst',
      '- `k_…` minimist: ready · role exposure-analyst',
      '- `k_…` qs: ready · role exposure-analyst',
      '⏭ registry: skipped \\(intake.bnpm is false\\)',
      '⏳ report: waiting for exposure',
      '⏭ patch: skipped \\(intake.patch is false\\), waiting for report',
    ]);
    expect(anon(text).split('\n')[0]).toBe('**vi-workflow** `w_…`: running, 6 of 10 done · board: **vi**');
  });

  it('says a route the transient limit made by the throttles that stopped its task', async () => {
    const w = madeOf(service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
    await done(w.tasks[0]?.taskId ?? '', { kind: 'cve', verify: false, patch: false, bnpm: false, packages: [] });
    const va = membersOf(db, w.instance.instanceId).find((m) => m.step === 'va')?.taskId ?? '';
    for (let n = 1; n <= 10; n += 1) {
      // The cooldown lifted at once: the clock here does not move.
      db.prepare('UPDATE kanban_tasks SET cooldown_until = NULL WHERE task_id = ?').run(va);
      const run = claimed(db, va);
      service.endRun(run.runId, { outcome: 'rate_limited' });
      closeRun(db, run.runId, NOW);
    }
    const r = service.instance(w.instance.instanceId);
    if (!r.ok) throw new Error(r.message);
    const text = renderInstance(r.view, 'vi', () => 'x', () => undefined);
    expect(anon(text)).toContain('↪ escalate: routed from va \\(stopped after 10 throttles\\), standing in');
  });

  it('adds the failed-routing line while the fault is not reconciled', async () => {
    const w = madeOf(service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
    db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled BEGIN SELECT RAISE(ABORT, 'cannot write'); END;");
    await done(w.tasks[0]?.taskId ?? '', { kind: 'cve', verify: false, patch: false, bnpm: false, packages: [] });
    const r = service.instance(w.instance.instanceId);
    if (!r.ok) throw new Error(r.message);
    expect(r.view.routingFailed).toEqual({ at: NOW, error: 'cannot write' });
    const text = renderInstance(r.view, 'vi', () => 'x', () => undefined);
    expect(anon(text)).toContain('Routing failed at 08:53 UTC: cannot write. The gateway tries again; `mt kanban workflow reconcile w_…` tries now.');
  });

  it('leaves out a handler never routed to, and shows waiting and running steps', () => {
    const plan: Plan = {
      format: 1,
      steps: [
        { step: 'a', made: 'start', parents: [], outputs: {}, on_blocked: 'wait', on_gave_up: { route: 'h' } },
        { step: 'b', made: 'decide', parents: ['a'], outputs: {}, on_blocked: 'wait', on_gave_up: 'wait', when: [{ step: 'a', state: 'done' }] },
        { step: 'h', made: 'route', parents: [], outputs: {}, on_blocked: 'wait', on_gave_up: 'wait', handler: true },
      ],
    };
    expect(stepLines(plan, [{ step: 'a', ref: 'a', taskId: 'k_a', phase: 'open' }], [{ step: 'b', state: 'waiting', reason: null }], [], [], new Map())).toEqual([
      { step: 'a', mark: '▶', text: 'a: running', state: 'running', why: null, items: null, routes: 0 },
      { step: 'b', mark: '⏳', text: 'b: waiting for a', state: 'waiting', why: null, items: null, routes: 0 },
    ]);
    expect(stepLines(plan, [{ step: 'a', ref: 'a', taskId: 'k_a', phase: 'blocked' }], [{ step: 'b', state: 'waiting', reason: null }], [], [], new Map())[0]).toMatchObject({
      mark: '⛔',
      text: 'a: blocked',
    });
  });
});

describe('mt kanban workflow show of a routed instance', () => {
  async function mt(...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMt(['kanban', 'workflow', 'show', ...argv], { env: { ...f.env, HOME: f.root }, out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it("gives the step lines, --json's steps, --plan, and --dag with its note", async () => {
    const id = await staged();
    const plain = await mt(id);
    expect(plain.code).toBe(0);
    expect(anon(plain.out)).toContain('↪ escalate: routed from va (gave up), standing in\n  k_… escalate:1 done · role vi-coordinator');
    const json = JSON.parse((await mt(id, '--json')).out) as { steps: unknown[] };
    expect(json.steps).toContainEqual({ step: 'escalate', state: 'routed', why: 'gave up', items: null, routes: 1 });
    expect(json.steps).toContainEqual({ step: 'exposure', state: 'running', why: null, items: 3, routes: 0 });
    expect(json.steps).toContainEqual({ step: 'verify', state: 'skipped', why: 'intake.verify is false', items: null, routes: 0 });
    const plan = await mt(id, '--plan');
    expect((JSON.parse(plan.out) as Plan).steps.map((s) => s.step)).toEqual(['intake', 'va', 'escalate', 'verify', 'exposure', 'registry', 'report', 'patch']);
    const dag = await mt(id, '--dag');
    expect(dag.err).toBe(`mt: instance ${id} has a plan: its DAG holds only the steps made at the start, and mt kanban workflow show ${id} --plan prints the rest`);
    expect(JSON.parse(dag.out)).toMatchObject({ workflow: 'vi-workflow', tasks: [{ ref: 'intake' }] });
  });
});
```

- [ ] **Step 27.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-show.test.ts`. Expected: `Tests  5 failed (5)`, the first as `AssertionError: expected [ 'Params: case: CVE-1', …(10) ] to deeply equal [ 'Params: case: CVE-1', …(14) ]`.

- [ ] **Step 27.3: Implement.**

In `README.md`, replace:

```markdown
mt kanban workflow show <instance> [--board <name>] [--dag]
```

with:

```markdown
mt kanban workflow show <instance> [--board <name>] [--dag | --plan]
```

In `src/cli/mt.ts`, replace:

```ts
  '  mt kanban workflow show <instance> [--board <name>] [--dag | --json]',
```

with:

```ts
  '  mt kanban workflow show <instance> [--board <name>] [--dag | --plan | --json]',
```

In `src/cli/operator.ts`, replace:

```ts
/** `mt kanban workflow show <instance> [--board] [--dag] [--json]` (workflows spec §10): everything, uncut; `--dag` the stored DAG. */
```

with:

```ts
/**
 * `mt kanban workflow show <instance> [--board] [--dag | --plan] [--json]` (workflows spec §10): everything, uncut; `--dag` the
 * stored DAG, said on stderr to hold only the steps made at the start for an instance with a plan; `--plan` the stored plan,
 * masked (workflow routing spec §12.1).
 */
```

In `src/cli/operator.ts`, replace:

```ts
  const { values, positionals } = parse(rest, { ...BOARD_FLAGS, dag: { type: 'boolean' } });
```

with:

```ts
  const { values, positionals } = parse(rest, { ...BOARD_FLAGS, dag: { type: 'boolean' }, plan: { type: 'boolean' } });
```

In `src/cli/operator.ts`, replace:

```ts
  if (values.dag === true && values.json === true) throw new UsageError('kanban workflow show takes --dag or --json, not both');
```

with:

```ts
  if ([values.dag, values.plan, values.json].filter((v) => v === true).length > 1) throw new UsageError('kanban workflow show takes one of --dag, --plan and --json');
```

In `src/cli/operator.ts`, replace:

```ts
  let dagText: string | undefined;
```

with:

```ts
  let dagText: string | undefined;
  let dagNote: string | undefined;
```

In `src/cli/operator.ts`, replace:

```ts
      if (values.dag === true) dagText = jsonFile(v.instance.dag);
```

with:

```ts
      if (values.dag === true) dagText = jsonFile(v.instance.dag);
      if (values.dag === true && v.instance.plan !== null) {
        dagNote = `instance ${instanceId} has a plan: its DAG holds only the steps made at the start, and mt kanban workflow show ${instanceId} --plan prints the rest`;
      }
      if (values.plan === true) {
        if (v.instance.plan === null) return refused({ code: 'invalid', message: `instance ${instanceId} has no plan: its workflow uses no routing key, and --dag prints all it made` });
        dagText = jsonFile(v.instance.plan);
      }
```

In `src/cli/operator.ts`, replace:

```ts
        lines: values.dag === true ? [] : instanceText(v),
```

with:

```ts
        lines: values.dag === true || values.plan === true ? [] : instanceText(v),
```

In `src/cli/operator.ts`, replace:

```ts
          related_instances: v.relatedInstances.map((o) => ({ instance_id: o.instanceId, name: o.name, tasks: o.tasks })),
```

with:

```ts
          related_instances: v.relatedInstances.map((o) => ({ instance_id: o.instanceId, name: o.name, tasks: o.tasks })),
          ...(v.steps === undefined ? {} : { steps: v.steps.map((s) => ({ step: s.step, state: s.state, why: s.why, items: s.items, routes: s.routes })) }),
```

In `src/cli/operator.ts`, replace:

```ts
  ).then((code) => {
```

with:

```ts
  ).then((code) => {
    if (code === 0 && dagNote !== undefined) io.err(`mt: ${dagNote}`);
```

In `src/cli/plain.ts`, replace:

```ts
  members: readonly { step: string; item: string | null; task: { taskId: string; phase: string; blockKind: string | null; blockReason: string | null; assignee: Assignee | null; createdFromTask: string | null }; status: string }[];
```

with:

```ts
  members: readonly { step: string; item: string | null; ref?: string; task: { taskId: string; phase: string; blockKind: string | null; blockReason: string | null; assignee: Assignee | null; createdFromTask: string | null }; status: string }[];
```

In `src/cli/plain.ts`, replace:

```ts
  blocked: number;
```

with:

```ts
  blocked: number;
  /** A routed instance's step lines (workflow routing spec §12.1). */
  steps?: readonly { step: string; mark: string; text: string; state: string }[];
  routingFailed?: { at: number; error: string };
```

In `src/cli/plain.ts`, replace:

```ts
  let step: string | undefined;
  for (const m of view.members) {
    if (m.step !== step) {
      step = m.step;
      out.push(`${line(m.step, 64)}:`);
    }
```

with:

```ts
  if (view.routingFailed !== undefined) {
    out.push(`Routing failed at ${when(view.routingFailed.at)}: ${line(view.routingFailed.error, 500)}. The gateway tries again; mt kanban workflow reconcile ${instance.instanceId} tries now.`);
  }
  const member = (m: (typeof view.members)[number], handler: boolean): string => {
    const ref = handler && m.ref !== undefined ? ` ${line(m.ref, 64)}` : '';
```

In `src/cli/plain.ts`, replace:

```ts
    out.push(`  ${m.task.taskId}${item} ${m.status}${why} · ${who(m.task.assignee)}`);
```

with:

```ts
    return `  ${m.task.taskId}${ref}${item} ${m.status}${why} · ${who(m.task.assignee)}`;
  };
  if (view.steps !== undefined) {
    // Every step, real or pending, in the plan's order, its tasks under it (workflow routing spec §12.1).
    for (const s of view.steps) {
      out.push(`${s.mark} ${line(s.text, 400)}`);
      for (const m of view.members) if (m.step === s.step) out.push(member(m, s.state === 'routed'));
    }
  } else {
    let step: string | undefined;
    for (const m of view.members) {
      if (m.step !== step) {
        step = m.step;
        out.push(`${line(m.step, 64)}:`);
      }
      out.push(member(m, false));
    }
```

In `src/db/kanban-read.ts`, replace:

```ts

/** A task's first event of a kind, with its payload; undefined for none. */
```

with:

```ts

/** The error of an instance's latest routing fault (workflow routing spec §12.1), from its `workflow_route_failed` event; undefined for none. */
export function routeFailureOf(db: Db, instanceId: string): string | undefined {
  const row = db
    .prepare<[string], { error: string | null }>(
      `SELECT json_extract(payload, '$.error') AS error FROM kanban_events
        WHERE kind = 'workflow_route_failed' AND json_extract(payload, '$.workflow') = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(instanceId);
  return row?.error ?? undefined;
}

/** A task's first event of a kind, with its payload; undefined for none. */
```

In `src/kanban/chat-render.ts`, replace:

```ts
    members: readonly { step: string; item: string | null; task: TaskRow; status: DisplayStatus }[];
```

with:

```ts
    members: readonly { step: string; item: string | null; ref?: string; task: TaskRow; status: DisplayStatus }[];
```

In `src/kanban/chat-render.ts`, replace:

```ts
    blocked: number;
```

with:

```ts
    blocked: number;
    /** A routed instance's step lines (workflow routing spec §12.1). */
    steps?: readonly { step: string; mark: string; text: string; state: string }[];
    routingFailed?: { at: number; error: string };
```

In `src/kanban/chat-render.ts`, replace:

```ts
  if (params.length > 0) head.push(paramsLine(params, nameOf));
```

with:

```ts
  if (params.length > 0) head.push(paramsLine(params, nameOf));
  if (view.routingFailed !== undefined) {
    const at = new Date(view.routingFailed.at).toISOString().slice(11, 16);
    head.push(`Routing failed at ${at} UTC: ${label(view.routingFailed.error, 500)}. The gateway tries again; \`mt kanban workflow reconcile ${instance.instanceId}\` tries now.`);
  }
```

In `src/kanban/chat-render.ts`, replace:

```ts
  let step: string | undefined;
  for (const m of view.members) {
    if (m.step !== step) {
      step = m.step;
      lines.push(`**${label(m.step, 64)}**`);
    }
```

with:

```ts
  const member = (m: (typeof view.members)[number], handler: boolean): string => {
    const ref = handler && m.ref !== undefined ? ` ${label(m.ref, 64)}` : '';
```

In `src/kanban/chat-render.ts`, replace:

```ts
    lines.push(`- ${id(m.task.taskId)}${item} ${m.status}${why} · ${whom(m.task.assignee)}`);
```

with:

```ts
    return `- ${id(m.task.taskId)}${ref}${item} ${m.status}${why} · ${whom(m.task.assignee)}`;
  };
  if (view.steps !== undefined) {
    // Every step, real or pending, in the plan's order, its tasks under it (workflow routing spec §12.1).
    for (const s of view.steps) {
      lines.push(`${s.mark} ${label(s.text, 300)}`);
      for (const m of view.members) if (m.step === s.step) lines.push(member(m, s.state === 'routed'));
    }
  } else {
    let step: string | undefined;
    for (const m of view.members) {
      if (m.step !== step) {
        step = m.step;
        lines.push(`**${label(m.step, 64)}**`);
      }
      lines.push(member(m, false));
    }
```

In `src/kanban/routing.ts`, replace:

```ts
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
```

with:

```ts
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// `workflow show`'s step lines (§12.1)
// ---------------------------------------------------------------------------

/** A route as `show` reads it: its handler, the step and task it was routed from, and the trigger's words. */
export interface RouteView {
  handler: string;
  fromTask: string;
  fromStep: string;
  outcome: RouteOutcome;
  /** `gave up`, `stopped after 10 throttles`, `blocked`. */
  words: string;
}

/** One step's line in `show` (§12.1): its mark and words, and what `--json` says of it. */
export interface StepLine {
  step: string;
  mark: string;
  text: string;
  state: 'done' | 'stood_in' | 'skipped' | 'archived' | 'waiting' | 'running' | 'blocked' | 'routed';
  why: string | null;
  /** A fan-out's items, once made. */
  items: number | null;
  /** A handler's routes made; a step's, the routes made from its tasks. */
  routes: number;
}

/**
 * Every step's line, real or pending, in the plan's order (§12.1): done, with its
 * outputs; done, stood in for; skipped, with why, and what it still waits for
 * while not settled; waiting, for its unsettled parents and the steps it reads;
 * running, or a fan-out's items done; blocked; and a handler's, routed from its
 * step, only once it was routed to.
 */
export function stepLines(
  plan: Plan,
  members: readonly { step: string; ref: string; taskId: string; phase: string }[],
  pending: readonly { step: string; state: PendingState; reason: { why: string } | null }[],
  settled: readonly { step: string; ref: string; how: SettledHow; taskId: string | null }[],
  routes: readonly RouteView[],
  results: ReadonlyMap<string, Readonly<Record<string, unknown>> | null>,
): StepLine[] {
  const own = (step: string) => settled.find((s) => s.step === step && s.ref === step);
  const reads = (s: PlanStep): string[] => {
    const read = new Set<string>(s.parents);
    for (const item of s.when ?? []) for (const c of 'any' in item ? item.any : [item]) read.add(c.step);
    if (s.for_each !== undefined && 'step' in s.for_each) read.add(s.for_each.step);
    return [...read].filter((x) => own(x) === undefined);
  };
  const made = (step: string): number => routes.filter((r) => r.outcome === 'made' && (r.handler === step || r.fromStep === step)).length;
  const out: StepLine[] = [];
  for (const s of plan.steps) {
    const mine = members.filter((m) => m.step === s.step);
    if (s.handler === true) {
      const routed = routes.filter((r) => r.handler === s.step && r.outcome === 'made');
      const last = routed.at(-1);
      if (last === undefined) continue;
      const standing = s.stands_in_for === last.fromStep ? ', standing in' : '';
      out.push({ step: s.step, mark: '↪', text: `${s.step}: routed from ${last.fromStep} (${last.words})${standing}`, state: 'routed', why: last.words, items: null, routes: routed.length });
      continue;
    }
    const row = own(s.step);
    const p = pending.find((x) => x.step === s.step);
    const items = s.for_each === undefined || mine.length === 0 ? null : mine.length;
    if (row !== undefined && (row.how === 'done' || row.how === 'stood_in')) {
      const said = outputsText(s.outputs, results.get(s.step) ?? null);
      const by = row.how === 'stood_in' ? routes.find((r) => r.fromStep === s.step && r.outcome === 'made')?.handler : undefined;
      const text = `${s.step}: done${by === undefined ? '' : `, stood in for by ${by}`}${said === '' ? '' : ` (${said})`}`;
      out.push({ step: s.step, mark: '✓', text, state: row.how, why: null, items, routes: made(s.step) });
      continue;
    }
    if (row !== undefined || p?.state === 'skipped') {
      const why = p?.reason?.why ?? (row?.how === 'archived' ? 'archived' : 'skipped');
      const waiting = row === undefined ? s.parents.filter((x) => own(x) === undefined) : [];
      const text = `${s.step}: skipped (${why})${waiting.length === 0 ? '' : `, waiting for ${waiting.join(', ')}`}`;
      out.push({ step: s.step, mark: '⏭', text, state: row?.how === 'archived' ? 'archived' : 'skipped', why, items, routes: made(s.step) });
      continue;
    }
    if (p?.state === 'waiting') {
      out.push({ step: s.step, mark: '⏳', text: `${s.step}: waiting for ${reads(s).join(', ')}`, state: 'waiting', why: null, items: null, routes: 0 });
      continue;
    }
    if (mine.some((m) => m.phase === 'blocked')) {
      out.push({ step: s.step, mark: '⛔', text: `${s.step}: blocked`, state: 'blocked', why: null, items, routes: made(s.step) });
      continue;
    }
    const doneItems = settled.filter((x) => x.step === s.step && x.ref !== s.step && (x.how === 'done' || x.how === 'stood_in')).length;
    const text = items === null ? `${s.step}: running` : `${s.step}: ${items} item${items === 1 ? '' : 's'}, ${doneItems} done`;
    out.push({ step: s.step, mark: '▶', text, state: 'running', why: null, items, routes: made(s.step) });
  }
  return out;
}
```

In `src/kanban/service.ts`, replace:

```ts
  pendingOf,
```

with:

```ts
  pendingOf,
  latestCompletion,
```

In `src/kanban/service.ts`, replace:

```ts
  reactsTo,
```

with:

```ts
  reactsTo,
  routeFailureOf,
```

In `src/kanban/service.ts`, replace:

```ts
  routeOfHandler,
```

with:

```ts
  routeOfHandler,
  routesOf,
```

In `src/kanban/service.ts`, replace:

```ts
  routingFaulted,
```

with:

```ts
  routingFaulted,
  triggersOf,
```

In `src/kanban/service.ts`, replace:

```ts
import { checkOutputs, fillText, INSTANCE_CAP, itemPlaceholderOf, outputBounds, placeholderOf, standInContract, type Plan, type PlanStep, type Template } from './routing.js';
```

with:

```ts
import { checkOutputs, fillText, INSTANCE_CAP, itemPlaceholderOf, outputBounds, placeholderOf, standInContract, stepLines, triggerWords, type Plan, type PlanStep, type RouteView, type StepLine, type Template } from './routing.js';
```

In `src/kanban/service.ts`, replace:

```ts
  relatedInstances: Array<{ instanceId: string; name: string | null; tasks: number }>;
```

with:

```ts
  relatedInstances: Array<{ instanceId: string; name: string | null; tasks: number }>;
  /** For an instance with a plan, every step's line, real or pending, in the plan's order (workflow routing spec §12.1). */
  steps?: StepLine[];
  /** While its routing's fault is not reconciled: when, and the error (§9.4, §12.1). */
  routingFailed?: { at: number; error: string };
```

In `src/kanban/service.ts`, replace:

```ts
    const file = instance.name === null || this.#workflowsDir === undefined ? undefined : readWorkflow(this.#workflowsDir, instance.name, this.#workflowFacts());
```

with:

```ts
    const file = instance.name === null || this.#workflowsDir === undefined ? undefined : readWorkflow(this.#workflowsDir, instance.name, this.#workflowFacts());
    const steps = instance.plan === null ? undefined : this.#stepLines(instance.instanceId, instance.plan, members);
    const failed = instance.routingFailedAt === null ? undefined : { at: instance.routingFailedAt, error: routeFailureOf(this.#db, instanceId) ?? '' };
```

In `src/kanban/service.ts`, replace:

```ts
        relatedInstances: [...others.values()],
```

with:

```ts
        relatedInstances: [...others.values()],
        ...(steps === undefined ? {} : { steps }),
        ...(failed === undefined ? {} : { routingFailed: failed }),
```

In `src/kanban/service.ts`, replace:

```ts
        ),
      },
    };
  }

```

with:

```ts
        ),
      },
    };
  }

  /** A routed instance's step lines (workflow routing spec §12.1): from its pending, settled and route rows, and its settled steps' results. */
  #stepLines(instanceId: string, plan: Plan, members: ReadonlyArray<MemberRow & { task: TaskRow }>): StepLine[] {
    const settled = settledOf(this.#db, instanceId);
    const step = new Map(members.map((m) => [m.taskId, m.step]));
    const routes: RouteView[] = routesOf(this.#db, instanceId).map((r) => {
      const t = triggersOf(this.#db, r.fromTask).find((x) => x.eventId === r.eventId);
      const throttles = Number(/throttled (\d+) times/.exec(t?.reason ?? '')?.[1] ?? 0);
      return { handler: r.handler, fromTask: r.fromTask, fromStep: step.get(r.fromTask) ?? '', outcome: r.outcome, words: t === undefined ? 'blocked' : triggerWords(t, throttles) };
    });
    const results = new Map<string, Readonly<Record<string, unknown>> | null>();
    for (const s of settled) {
      if (s.ref !== s.step || s.taskId === null || Object.keys(plan.steps.find((p) => p.step === s.step)?.outputs ?? {}).length === 0) continue;
      const metadata = latestCompletion(this.#db, s.taskId)?.metadata;
      results.set(s.step, isRecord(metadata) ? metadata : null);
    }
    return stepLines(
      plan,
      members.map((m) => ({ step: m.step, ref: m.ref, taskId: m.taskId, phase: m.task.phase })),
      pendingOf(this.#db, instanceId),
      settled,
      routes,
      results,
    );
  }

```

- [ ] **Step 27.4: Run them to verify they pass.** Run the same command. Expected: `Tests  5 passed (5)`.

- [ ] **Step 27.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3730 passed (3730)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 27.6: Commit.**

```bash
git add README.md src/cli/mt.ts src/cli/operator.ts src/cli/plain.ts src/db/kanban-read.ts src/kanban/chat-render.ts src/kanban/routing.ts src/kanban/service.ts tests/routing-show.test.ts
git commit -m "Say every step of a routed instance in workflow show, where it is and why, with the failed-routing line, the steps in --json, --plan, and --dag's note"
```

---

### Task 28: The notices

**Files:**

- Create: `tests/routing-notices.test.ts`
- Modify: `src/db/kanban.ts`, `src/kanban/chat-render.ts`

§12.2. `renderNotice` renders `workflow_routed`, after the transition's title and its trigger, one line a decision, and `workflow_route_failed` only when `first`; both from their payloads alone. Neither wakes: `WAKE_KINDS` is unchanged.

- [ ] **Step 28.1: Write the tests.**

Create `tests/routing-notices.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { eventsOf, getTask, membersOf } from '../src/db/kanban-read.js';
import { renderNotice } from '../src/kanban/chat-render.js';
import type { KanbanEvent } from '../src/kanban/types.js';
import { WAKE_KINDS } from '../src/kanban/waker.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * The routing's notices (workflow routing spec §12.2): `workflow_routed`, after
 * the transition that decided, one line a decision, made, skipped, fanned out,
 * routed, stood in, over the limit, over the cap and left open, rendered from
 * its payload alone, masked; `workflow_route_failed` said once a fault; neither
 * an outcome that wakes.
 */

const SECRET = 'sk-live-1234567890';
let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  addSecrets([SECRET]);
  h = testDb();
  b = viBoard(h, { limits: { failureLimit: 1, transientLimit: 10, transientCooldownS: 300 } });
});
afterEach(() => {
  clearSecrets();
  h.close();
});

let instance = '';
const ids = (text: string) => text.replace(/k_[a-z0-9]+/g, 'k_…').replace(/w_[a-z0-9]+/g, 'w_…');
const step = (s: string) => membersOf(h.db, instance).filter((m) => m.step === s).map((m) => m.taskId);

async function report(taskId: string, metadata: Record<string, unknown> = {}): Promise<void> {
  const run = claimed(h.db, taskId);
  const r = await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'done', metadata });
  if (!r.ok) throw new Error(r.message);
  closeRun(h.db, run.runId, NOW);
}

function giveUp(taskId: string): void {
  const run = claimed(h.db, taskId);
  b.service.endRun(run.runId, { outcome: 'crashed' });
  closeRun(h.db, run.runId, NOW);
}

/** The notices of a task's routing events, as the chat hears them. */
function notices(taskId: string, kind = 'workflow_routed'): Array<string | undefined> {
  const task = getTask(h.db, taskId);
  if (task === undefined) throw new Error('no task');
  return eventsOf(h.db, taskId)
    .filter((e) => e.kind === kind)
    .map((e) => {
      const text = renderNotice(e, task, { blockRecurrenceLimit: 3 });
      return text === undefined ? undefined : ids(text);
    });
}

async function start(caseId = 'CVE-1'): Promise<string> {
  const w = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: caseId } }, createdBy: ALICE, createdVia: VIA }));
  instance = w.instance.instanceId;
  return w.tasks[0]?.taskId ?? '';
}

describe('the routing notices', () => {
  it('says each decision of a completion, after it, in one notice', async () => {
    const intake = await start();
    await report(intake, { kind: 'cve', verify: false, patch: false, bnpm: false, packages: ['lodash', 'minimist', 'qs'] });
    expect(notices(intake)).toEqual([
      ['After **CVE-1 · intake** `k_…`, in vi-workflow `w_…`:', '- ✓ va made: `k_…`', '- ⏭ verify skipped: intake.verify is false', '- ⏭ registry skipped: intake.bnpm is false', '- ⏭ patch skipped: intake.patch is false'].join('\n'),
    ]);
  });

  it("says a route after a give-up, a stand-in's settling and the fan-out it let through, and a stand-in left open", async () => {
    const intake = await start();
    await report(intake, { kind: 'cve', verify: false, patch: false, bnpm: false, packages: ['lodash', 'minimist', 'qs'] });
    const va = step('va')[0] ?? '';
    giveUp(va);
    expect(notices(va)).toEqual(['After **CVE-1 · va** `k_…` gave up, in vi-workflow `w_…`:\n- ↪ escalate routed from va: `k_…`, standing in']);
    const escalate = step('escalate')[0] ?? '';
    await report(escalate, { reachable: true });
    expect(notices(escalate)).toEqual([
      [
        'After **CVE-1 · va, escalated** `k_…`, in vi-workflow `w_…`:',
        '- ✓ escalate stands in for va: reachable=true; `k_…` va archived',
        '- ▶ exposure fanned out, 3 tasks: lodash, minimist, qs',
      ].join('\n'),
    ]);
  });

  it('says a route after the transient limit stopped its task, by its throttles', async () => {
    const intake = await start();
    await report(intake, { kind: 'cve', verify: false, patch: false, bnpm: false, packages: [] });
    const va = step('va')[0] ?? '';
    for (let n = 1; n <= 10; n += 1) {
      // The cooldown lifted at once: the clock here does not move.
      h.db.prepare('UPDATE kanban_tasks SET cooldown_until = NULL WHERE task_id = ?').run(va);
      const run = claimed(h.db, va);
      b.service.endRun(run.runId, { outcome: 'rate_limited' });
      closeRun(h.db, run.runId, NOW);
    }
    expect(notices(va)).toEqual(['After **CVE-1 · va** `k_…` stopped after 10 throttles, in vi-workflow `w_…`:\n- ↪ escalate routed from va: `k_…`, standing in']);
  });

  it("says a fourth give-up over the limit, and a stand-in left open once the routed task's own completion won", async () => {
    const intake = await start();
    await report(intake, { kind: 'cve', verify: false, patch: false, bnpm: false, packages: [] });
    const va = step('va')[0] ?? '';
    for (let n = 0; n < 4; n += 1) {
      giveUp(va);
      expect(b.service.unblock(va, ALICE).ok).toBe(true);
    }
    expect(notices(va)[3]).toBe(
      'After **CVE-1 · va** `k_…` gave up, in vi-workflow `w_…`:\n- `k_…` va gave up again, and has been routed to escalate 3 times: it waits for a person now (/kanban task unblock k_… [comment])',
    );
    await report(va, { reachable: false });
    expect(notices(va).at(-1)?.split('\n')[1]).toBe('- escalate `k_…` is left open: va was completed by its own task');
  });

  it('records a route past the cap over_cap, and says it waits for a person', async () => {
    const intake = await start();
    await report(intake, { kind: 'cve', verify: false, patch: false, bnpm: false, packages: [] });
    // Members to the cap, as rows: tasks the instance made, which nothing here reads but the count.
    const task = h.db.prepare(
      `INSERT INTO kanban_tasks (task_id, title, contract, phase, created_by, created_via, created_at, board)
       VALUES (?, 'filler', jsonb('{}'), 'open', ?, jsonb('{"kind":"operator"}'), ?, 'vi')`,
    );
    const member = h.db.prepare("INSERT INTO kanban_workflow_tasks (task_id, instance_id, ref, step, item, position) VALUES (?, ?, ?, 'filler', NULL, ?)");
    const base = membersOf(h.db, instance).length;
    for (let i = 0; i < 500 - base; i += 1) {
      task.run(`k_fill${i}`, ALICE, NOW);
      member.run(`k_fill${i}`, instance, `filler:${i + 1}`, base + i);
    }
    const va = step('va')[0] ?? '';
    giveUp(va);
    expect(step('escalate')).toEqual([]);
    expect(h.db.prepare('SELECT outcome FROM kanban_workflow_routes').all()).toEqual([{ outcome: 'over_cap' }]);
    expect(notices(va)).toEqual([
      'After **CVE-1 · va** `k_…` gave up, in vi-workflow `w_…`:\n- `k_…` va gave up, and is not routed to escalate: the instance has 500 tasks; it waits for a person (/kanban task unblock k_… [comment])',
    ]);
  });

  it('masks what a notice quotes, and says a routing fault once', async () => {
    const intake = await start(`CVE ${SECRET}`);
    h.db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled BEGIN SELECT RAISE(ABORT, 'cannot write'); END;");
    await report(intake, { kind: 'cve', verify: false, patch: false, bnpm: false, packages: [] });
    expect(notices(intake, 'workflow_route_failed')).toEqual([
      `Routing of vi-workflow \`w_…\` failed after **CVE ${MASK} · intake** \`k_…\`: cannot write. The gateway tries again; \`mt kanban workflow reconcile w_…\` tries now.`,
    ]);
    const task = getTask(h.db, intake);
    if (task === undefined) throw new Error('no task');
    const again: KanbanEvent = { id: 99, taskId: intake, runId: null, kind: 'workflow_route_failed', actor: 'gateway', payload: { workflow: instance, error: 'x', first: false }, createdAt: NOW };
    expect(renderNotice(again, task, { blockRecurrenceLimit: 3 })).toBeUndefined();
  });

  it('wakes nothing: neither kind is an outcome', () => {
    expect(WAKE_KINDS.has('workflow_routed')).toBe(false);
    expect(WAKE_KINDS.has('workflow_route_failed')).toBe(false);
  });
});
```

- [ ] **Step 28.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-notices.test.ts`. Expected: `Tests  6 failed | 1 passed (7)`, the first as `AssertionError: expected [ undefined ] to deeply equal [ Array(1) ]`.

- [ ] **Step 28.3: Implement.**

In `src/db/kanban.ts`, replace:

```ts
  if (lines.length === 0) return superseded;
```

with:

```ts
  if (lines.length === 0) return superseded;
  // What the transition was, for the notice's head (§12.2): `gave up`, `stopped after 10 throttles`, `blocked`.
  const task = mustGet(d, taskId);
  const after = cause === 'gave_up' ? 'gave up' : cause === 'throttled' ? `stopped after ${task.consecutiveTransient} throttles` : cause === 'blocked' ? 'blocked' : undefined;
```

In `src/db/kanban.ts`, replace:

```ts
      payload: { workflow: planned.instance.instanceId, workflowName: planned.instance.name, step: planned.member.step, cause, decisions: lines },
```

with:

```ts
      payload: {
        workflow: planned.instance.instanceId,
        workflowName: planned.instance.name,
        step: planned.member.step,
        cause,
        ...(after === undefined ? {} : { after }),
        decisions: lines,
      },
```

In `src/kanban/chat-render.ts`, replace:

```ts
}

/**
 * Whether the event left the task blocked, so that its notice offers Unblock
```

with:

```ts
}

/** How many of a fan-out's items a routing notice names; its count says the rest (workflow routing spec §12.2). */
const ROUTED_ITEMS = 20;

/** One decision of a `workflow_routed` payload as its notice's line (workflow routing spec §12.2), or undefined for one it does not know. */
function routedLine(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const d = raw as Record<string, unknown>;
  const step = label(text(d, 'step'), 64);
  const handler = label(text(d, 'handler'), 64);
  const why = label(text(d, 'why'), 300);
  const ids = Array.isArray(d['taskIds']) ? d['taskIds'].filter((x): x is string => typeof x === 'string') : [];
  const first = ids[0] === undefined ? '' : id(ids[0]);
  switch (d['outcome']) {
    case 'made':
      return `- ✓ ${step} made: ${first}`;
    case 'skipped':
      return `- ⏭ ${step} skipped: ${why}`;
    case 'fanned_out': {
      const items = Array.isArray(d['items']) ? d['items'].filter((x): x is string => typeof x === 'string').slice(0, ROUTED_ITEMS) : [];
      const count = typeof d['count'] === 'number' ? d['count'] : items.length;
      const more = count > items.length ? `, and ${count - items.length} more` : '';
      return `- ▶ ${step} fanned out, ${count} task${count === 1 ? '' : 's'}: ${items.map((i) => label(i, 80)).join(', ')}${more}`;
    }
    case 'routed':
      return `- ↪ ${handler} routed from ${step}: ${first}${d['standsIn'] === true ? ', standing in' : ''}`;
    case 'stood_in':
      return `- ✓ ${handler} stands in for ${step}${why === '' ? '' : `: ${why}`}; ${first} ${step} archived`;
    case 'over_limit':
      return `- ${first} ${step} ${why} again, and has been routed to ${handler} 3 times: it waits for a person now (/kanban task unblock ${ids[0] ?? ''} [comment])`;
    case 'over_cap':
      return `- ${first} ${step} ${why}, and is not routed to ${handler}: the instance has 500 tasks; it waits for a person (/kanban task unblock ${ids[0] ?? ''} [comment])`;
    case 'unread':
      return `- ${handler} ${first} is left open: ${why}`;
    default:
      return undefined;
  }
}

/** A `workflow_routed` event's notice (workflow routing spec §12.2), from its payload alone: what the transition decided, one line a decision. */
function routedNotice(p: Record<string, unknown>, name: string): string | undefined {
  const lines = (Array.isArray(p['decisions']) ? p['decisions'] : []).flatMap((d) => {
    const line = routedLine(d);
    return line === undefined ? [] : [line];
  });
  if (lines.length === 0) return undefined;
  const after = text(p, 'after');
  const workflow = workflowName(typeof p['workflowName'] === 'string' ? p['workflowName'] : null);
  return [`After ${name}${after === '' ? '' : ` ${label(after, 80)}`}, in ${label(workflow)} ${id(text(p, 'workflow'))}:`, ...lines].join('\n');
}

/**
 * Whether the event left the task blocked, so that its notice offers Unblock
```

In `src/kanban/chat-render.ts`, replace:

```ts
      return renderStarted(startedOf(p), opts.where ?? 'chat', (a) => who(a, opts.nameOf), opts.nameOf);
```

with:

```ts
      return renderStarted(startedOf(p), opts.where ?? 'chat', (a) => who(a, opts.nameOf), opts.nameOf);
    case 'workflow_routed':
      return routedNotice(p, name);
    case 'workflow_route_failed': {
      // Said once a fault (workflow routing spec §9.4): only the event that set the instance's mark is a notice.
      if (p['first'] !== true) return undefined;
      const workflow = text(p, 'workflow');
      return (
        `Routing of ${label(workflowName(typeof p['workflowName'] === 'string' ? p['workflowName'] : null))} ${id(workflow)} failed after ${name}: ` +
        `${label(text(p, 'error'), 500)}. The gateway tries again; \`mt kanban workflow reconcile ${workflow}\` tries now.`
      );
    }
```

- [ ] **Step 28.4: Run them to verify they pass.** Run the same command. Expected: `Tests  7 passed (7)`.

- [ ] **Step 28.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3737 passed (3737)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 28.6: Commit.**

```bash
git add src/db/kanban.ts src/kanban/chat-render.ts tests/routing-notices.test.ts
git commit -m "Say each routing decision in one notice after the transition that made it, and a routing fault once, from their payloads alone"
```

---

### Task 29: The preview, the start's reply and waiting

**Files:**

- Create: `tests/routing-preview.test.ts`
- Modify: `src/cli/operator.ts`, `src/cli/plain.ts`, `src/db/kanban.ts`, `src/kanban/chat-render.ts`, `src/kanban/chat.ts`, `src/kanban/routing.ts`, `src/kanban/service.ts`, `src/kanban/worker.ts`

§12.3, §13.2. The preview lists the plain tasks, then each step made later in §6's words, a result fan-out with its bound, its first line counting both, the most from the lists' `max` and 3 routes a routed task, `at most 500 in all` past the cap; chat's and the terminal's alike. The start's reply says the steps to come, from chat and, by `workflow_started`'s `waiting`, from the terminal. `WorkflowMade.waiting` names the steps still waiting, in the worker's `start-workflow` answer, `--json`, and a repeat's answer. An instance started before migration 015 is as it was: no plan and no rows, its completions writing nothing, and no `waiting` in a repeat's answer.

- [ ] **Step 29.1: Write the tests.**

Create `tests/routing-preview.test.ts`:

```ts
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun, createBoard } from '../src/db/kanban.js';
import { eventsOf, getInstance } from '../src/db/kanban-read.js';
import { migrate, openDb } from '../src/db/open.js';
import { KanbanService } from '../src/kanban/service.js';
import { previewLines, renderNotice, renderPreview, renderStarted, startedReply } from '../src/kanban/chat-render.js';
import { mostLater, type Plan } from '../src/kanban/routing.js';
import { previewText } from '../src/cli/plain.js';
import { clearSecrets } from '../src/secrets.js';
import { ManualClock, SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { madeOf, viBoard, viRoles, workerRun, type ViBoard } from './helpers/routing.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * A routed file's preview and start (workflow routing spec §12.3, §13.2): the
 * plain tasks, then each step made later in the words of a check, the first line
 * counting both, at most 500 in all; the start's reply's line of steps to come;
 * `waiting` in the worker's and the terminal's answers, and a repeat's answer
 * with every member now and the steps still waiting; an instance started before
 * migration 015 left as it was, with no plan, and no `waiting`.
 */

let h: TestDb;
let b: ViBoard;
beforeEach(() => {
  clearSecrets();
  h = testDb();
  b = viBoard(h);
});
afterEach(() => h.close());

const PARAMS = { from: 'json', params: { case: 'CVE-1' } } as const;

function preview() {
  const r = b.service.previewWorkflow({ workflow: 'vi-workflow', params: PARAMS, createdBy: ALICE, createdVia: VIA, board: 'vi' });
  if (!r.ok) throw new Error(r.message);
  return r;
}

describe('the preview of a routed file', () => {
  it('lists the plain tasks, then each step made later, the first line counting both', () => {
    const r = preview();
    expect(renderPreview('vi-workflow', r.dag, (n) => n, undefined, 'default', r.plan).split('\n')).toEqual([
      'vi-workflow would make 1 task now, and up to 108 more as results come, on board **vi**:',
      '- `intake` CVE-1 · intake, for vi-coordinator',
      '- va: when intake.kind is cve; on gave up, routed to escalate',
      '- escalate: handler for va, standing in',
      '- verify: when intake.verify is true and va.reachable is true',
      '- exposure: per item of intake.packages, at most 100',
      '- registry: when intake.bnpm is true',
      '- report: when its parents are settled',
      '- patch: when intake.patch is true',
      'Nothing was made: `/kanban workflow start vi-workflow`, with these params, makes it.',
    ]);
    expect(previewText('vi-workflow', 'vi', previewLines(r.dag), r.plan)).toEqual([
      'vi-workflow would make 1 task now, and up to 108 more as results come, on board vi:',
      '  intake  CVE-1 · intake  role vi-coordinator',
      '  va: when intake.kind is cve; on gave up, routed to escalate',
      '  escalate: handler for va, standing in',
      '  verify: when intake.verify is true and va.reachable is true',
      '  exposure: per item of intake.packages, at most 100',
      '  registry: when intake.bnpm is true',
      '  report: when its parents are settled',
      '  patch: when intake.patch is true',
      'nothing was made: mt kanban workflow start vi-workflow, with these params, makes it',
    ]);
  });

  it('says at most 500 in all past the cap', () => {
    const r = preview();
    const plan = r.plan as Plan;
    const wide: Plan = { ...plan, steps: plan.steps.map((s) => (s.step === 'intake' ? { ...s, outputs: { ...s.outputs, packages: { list: 'string', max: 100 } } } : s)) };
    const more: Plan = { ...wide, steps: [...wide.steps, ...[1, 2, 3, 4].map((n) => ({ ...(wide.steps[4] as Plan['steps'][number]), step: `exposure${n}` }))] };
    expect(mostLater(more)).toBe(508);
    expect(renderPreview('vi-workflow', r.dag, (n) => n, undefined, 'vi', more).split('\n')[0]).toBe('vi-workflow would make 1 task now, and up to 508 more as results come, at most 500 in all, on board **vi**:');
  });
});

describe('the start of a routed file', () => {
  it("says the steps to come in its reply, and gives waiting in the worker's answer and a repeat's", async () => {
    const made = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: PARAMS, createdBy: ALICE, createdVia: VIA, idempotencyKey: 'lark:om_1' }));
    expect(made.waiting).toEqual(['va', 'verify', 'exposure', 'registry', 'report', 'patch']);
    const reply = renderStarted(startedReply(made), 'thread', (a) => a.name);
    expect(reply).toContain(`6 more steps are made as results come: \`/kanban workflow show ${made.instance.instanceId}\` follows them.`);
    const intake = made.tasks[0]?.taskId ?? '';
    const run = claimed(h.db, intake);
    await b.service.complete(intake, { kind: 'run', runId: run.runId }, { summary: 'x', metadata: { kind: 'supplychain', verify: false, patch: true, bnpm: false, packages: [] } });
    closeRun(h.db, run.runId, NOW);
    const again = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: PARAMS, createdBy: ALICE, createdVia: VIA, idempotencyKey: 'lark:om_1' }));
    expect(again.existing).toBe(true);
    expect(again.tasks.map((t) => t.ref)).toEqual(['intake', 'report']);
    expect(again.waiting).toEqual(['patch']);
  });

  it("gives waiting in a run's start-workflow answer, and the terminal's start's reply its line too", async () => {
    const planner = b.service.create({ title: 'plan', assignee: 'vi-coordinator', createdBy: ALICE, createdVia: VIA, board: 'vi' });
    if (!planner.ok) throw new Error(planner.message);
    const run = workerRun(b.service, h.db, planner.task.taskId);
    expect(await run.ask('start-workflow', { workflow: 'vi-workflow', params: { case: 'CVE-2' } })).toMatchObject({
      ok: true,
      waiting: ['va', 'verify', 'exposure', 'registry', 'report', 'patch'],
    });
    const follow = { appId: 'cli_app', chatId: 'oc_team', threadId: '', rootId: null };
    const term = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: PARAMS, createdBy: 'operator:me', createdVia: { kind: 'operator' }, follow }));
    const first = term.tasks[0];
    const started = eventsOf(h.db, first?.taskId ?? '').find((e) => e.kind === 'workflow_started');
    expect(started?.payload).toMatchObject({ waiting: 6 });
    if (started === undefined || first === undefined) throw new Error('no start');
    expect(renderNotice(started, first.task, { blockRecurrenceLimit: 3 })).toContain('6 more steps are made as results come');
  });
});

describe('an instance started before migration 015', () => {
  it('has no plan and no rows, its completions write nothing, its show, list, archive and repeat as before', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-routing-old-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) {
        if (/^01[0-4]_.*\.sql$/.test(f) || /^00[1-9]_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      }
      const d = openDb(join(dir, 'team.db'));
      try {
        expect(migrate(d, only)).toBe(14);
        createBoard(d, 'vi', ALICE, NOW);
        writeFileSync(join(b.dir, 'vendor-eval.yaml'), VENDOR_EVAL);
        const roles = viRoles();
        for (const name of ['worker', 'reviewer']) roles.set(name, viRoles().get('verifier') as never);
        const service = () => new KanbanService({ db: d, roles, workspaces: new Set(['default']), supervisedRoles: true, workflowsDir: b.dir, clock: new ManualClock(NOW) });
        const old = service();
        const params = { from: 'json', params: { topic: 't', vendors: ['a'] } } as const;
        const start = (s: KanbanService) => s.startWorkflow({ workflow: 'vendor-eval', params, createdBy: ALICE, createdVia: VIA, idempotencyKey: 'lark:om_old' });
        const made = madeOf(start(old));
        const id = made.instance.instanceId;
        const shown = old.instance(id);
        const listed = old.instances('default', true);
        expect(shown.ok && listed.instances.map((i) => i.instance.instanceId)).toEqual([id]);
        expect(migrate(d, SCHEMA_DIR)).toBe(15);
        const now = service();
        expect(getInstance(d, id)).toMatchObject({ plan: null, routingFailedAt: null });
        expect(now.instance(id)).toEqual(shown);
        expect(now.instances('default', true)).toEqual(listed);
        const shortlist = made.tasks[0]?.taskId ?? '';
        const run = claimed(d, shortlist);
        expect((await now.complete(shortlist, { kind: 'run', runId: run.runId }, { summary: 'x' })).ok).toBe(true);
        closeRun(d, run.runId, NOW);
        expect(eventsOf(d, shortlist).filter((e) => e.kind.startsWith('workflow_route'))).toEqual([]);
        for (const table of ['kanban_workflow_pending', 'kanban_workflow_settled', 'kanban_workflow_routes']) {
          expect(d.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        }
        const again = madeOf(start(now));
        expect(again.existing).toBe(true);
        expect(again).not.toHaveProperty('waiting');
        expect(now.archiveWorkflow(id, ALICE).ok).toBe(true);
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 29.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/routing-preview.test.ts`. Expected: `Tests  4 failed | 1 passed (5)`, the first as `AssertionError: expected [ …(3) ] to deeply equal [ …(10) ]`.

- [ ] **Step 29.3: Implement.**

In `src/cli/operator.ts`, replace:

```ts
    tasks: made.tasks.map((t) => ({ task_id: t.taskId, ref: t.ref, step: t.step, item: t.item })),
```

with:

```ts
    tasks: made.tasks.map((t) => ({ task_id: t.taskId, ref: t.ref, step: t.step, item: t.item })),
    ...(made.waiting === undefined ? {} : { waiting: made.waiting }),
```

In `src/cli/operator.ts`, replace:

```ts
  else for (const l of previewText(name, boardName, previewLines(shaped.dag))) io.out(l);
```

with:

```ts
  else for (const l of previewText(name, boardName, previewLines(shaped.dag), expanded.plan)) io.out(l);
```

In `src/cli/plain.ts`, replace:

```ts
} from '../kanban/chat-render.js';
```

with:

```ts
} from '../kanban/chat-render.js';
import { laterCount, laterLines, type Plan } from '../kanban/routing.js';
```

In `src/cli/plain.ts`, replace:

```ts
export function previewText(name: string, board: string, lines: readonly PreviewLine[]): string[] {
```

with:

```ts
export function previewText(name: string, board: string, lines: readonly PreviewLine[], plan: Plan | null = null): string[] {
```

In `src/cli/plain.ts`, replace:

```ts
  ]);
  return [
```

with:

```ts
  ]);
  // A routed file's steps made later, in the words of a check, and how many it could make (workflow routing spec §12.3).
  const later = plan === null ? [] : laterLines(plan).map((l) => `  ${line(l.step, 64)}: ${line(l.words, 400)}`);
  return [
```

In `src/cli/plain.ts`, replace:

```ts
    `${line(name, 80)} would make ${n} task${n === 1 ? '' : 's'}, on board ${line(board, 80)}:`,
```

with:

```ts
    `${line(name, 80)} would make ${plan === null ? `${n} task${n === 1 ? '' : 's'}` : laterCount(plan, n)}, on board ${line(board, 80)}:`,
```

In `src/cli/plain.ts`, replace:

```ts
    ...table(rows).map((r) => `  ${r}`),
```

with:

```ts
    ...table(rows).map((r) => `  ${r}`),
    ...later,
```

In `src/cli/plain.ts`, replace:

```ts
  made: { instance: { instanceId: string; name: string | null; board: string; source: string }; tasks: readonly { taskId: string; ref: string; task: { title: string; assignee: Assignee | null } }[]; existing: boolean },
```

with:

```ts
  made: {
    instance: { instanceId: string; name: string | null; board: string; source: string };
    tasks: readonly { taskId: string; ref: string; task: { title: string; assignee: Assignee | null } }[];
    existing: boolean;
    waiting?: readonly string[];
  },
```

In `src/cli/plain.ts`, replace:

```ts
  return [head, ...table(rows).map((r) => `  ${r}`)];
```

with:

```ts
  const w = made.waiting?.length ?? 0;
  const later = w === 0 ? [] : [`${w} more step${w === 1 ? ' is' : 's are'} made as results come: mt kanban workflow show ${instance.instanceId} follows them`];
  return [head, ...table(rows).map((r) => `  ${r}`), ...later];
```

In `src/db/kanban.ts`, replace:

```ts
            people: members.some((m) => human(m.task.assignee) || human(m.task.reviewer)),
```

with:

```ts
            people: members.some((m) => human(m.task.assignee) || human(m.task.reviewer)),
            // The steps made as results come, for the reply's line (workflow routing spec §12.3).
            ...(plan === null ? {} : { waiting: plan.steps.filter((s) => s.made === 'decide').length }),
```

In `src/kanban/chat-render.ts`, replace:

```ts
import { describeReported } from './commit.js';
```

with:

```ts
import { describeReported } from './commit.js';
import { laterCount, laterLines, type Plan } from './routing.js';
```

In `src/kanban/chat-render.ts`, replace:

```ts
/** `/kanban workflow preview` (workflows spec §9): what a start would make, one line a task, and that nothing was made. */
```

with:

```ts
/**
 * `/kanban workflow preview` (workflows spec §9): what a start would make, one line a task, and that nothing was made;
 * for a routed file (workflow routing spec §12.3), then each step made later, in the words of a check, and how many it could make.
 */
```

In `src/kanban/chat-render.ts`, replace:

```ts
  chatBoard?: string,
```

with:

```ts
  chatBoard?: string,
  plan?: Plan | null,
```

In `src/kanban/chat-render.ts`, replace:

```ts
  });
  return fitted(
```

with:

```ts
  });
  const later = plan === undefined || plan === null ? [] : laterLines(plan).map((l) => `- ${label(l.step, 64)}: ${label(l.words, 300)}`);
  const counted = plan === undefined || plan === null ? `${n} task${n === 1 ? '' : 's'}` : laterCount(plan, n);
  return fitted(
```

In `src/kanban/chat-render.ts`, replace:

```ts
    [`${label(name)} would make ${n} task${n === 1 ? '' : 's'}${board}:`],
    lines,
```

with:

```ts
    [`${label(name)} would make ${counted}${board}:`],
    [...lines, ...later],
```

In `src/kanban/chat-render.ts`, replace:

```ts
  by?: string;
```

with:

```ts
  by?: string;
  /** How many steps wait to be made as results come (workflow routing spec §12.3). */
  waiting?: number;
```

In `src/kanban/chat-render.ts`, replace:

```ts
export function startedReply(made: { instance: { instanceId: string; name: string | null; board: string }; tasks: readonly { task: TaskRow }[] }): StartedReply {
```

with:

```ts
export function startedReply(made: { instance: { instanceId: string; name: string | null; board: string }; tasks: readonly { task: TaskRow }[]; waiting?: readonly string[] }): StartedReply {
```

In `src/kanban/chat-render.ts`, replace:

```ts
    people: made.tasks.some(({ task }) => task.assignee?.kind === 'human' || task.reviewer?.kind === 'human'),
```

with:

```ts
    people: made.tasks.some(({ task }) => task.assignee?.kind === 'human' || task.reviewer?.kind === 'human'),
    ...(made.waiting === undefined || made.waiting.length === 0 ? {} : { waiting: made.waiting.length }),
```

In `src/kanban/chat-render.ts`, replace:

```ts
    by: text(p, 'by') || 'the operator',
```

with:

```ts
    by: text(p, 'by') || 'the operator',
    ...(typeof p['waiting'] === 'number' && p['waiting'] > 0 ? { waiting: p['waiting'] } : {}),
```

In `src/kanban/chat-render.ts`, replace:

```ts
        : ' A person is sent their card by direct message once their task is ready.';
```

with:

```ts
        : ' A person is sent their card by direct message once their task is ready.';
  const w = reply.waiting ?? 0;
  const later = w === 0 ? [] : [`${w} more step${w === 1 ? ' is' : 's are'} made as results come: \`/kanban workflow show ${instance.instanceId}\` follows them.`];
```

In `src/kanban/chat-render.ts`, replace:

```ts
    [
      ...pointer,
```

with:

```ts
    [
      ...later,
      ...pointer,
```

In `src/kanban/chat.ts`, replace:

```ts
        return renderPreview(command.name, r.dag, (name) => this.#whom({ kind: name.includes(':') ? 'human' : 'role', name }), this.#nameOf, board.name);
```

with:

```ts
        return renderPreview(command.name, r.dag, (name) => this.#whom({ kind: name.includes(':') ? 'human' : 'role', name }), this.#nameOf, board.name, r.plan);
```

In `src/kanban/routing.ts`, replace:

```ts
    out.push({ step: s.step, mark: '▶', text, state: 'running', why: null, items, routes: made(s.step) });
  }
  return out;
}
```

with:

```ts
    out.push({ step: s.step, mark: '▶', text, state: 'running', why: null, items, routes: made(s.step) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Preview (§12.3)
// ---------------------------------------------------------------------------

/** A result fan-out's bound, its source's list `max`; undefined for any other step. */
export function fanOutMax(plan: Plan, s: StepShape): number | undefined {
  const f = s.for_each;
  if (f === undefined || !('step' in f)) return undefined;
  const t = plan.steps.find((x) => x.step === f.step)?.outputs[f.output];
  return t !== undefined && typeof t === 'object' && 'list' in t ? t.max : undefined;
}

/**
 * The most tasks a plan could make after its start (§12.3): each pending step's,
 * a result fan-out's list `max`, a list param's items, else one; and 3 routes
 * for each task a handler is routed from.
 */
export function mostLater(plan: Plan): number {
  const tasks = (s: PlanStep): number => fanOutMax(plan, s) ?? s.templates?.length ?? 1;
  let most = 0;
  for (const s of plan.steps) {
    if (s.made === 'decide') most += tasks(s);
    if (s.handler === true) for (const from of routedFrom(plan.steps, s.step)) most += ROUTES_PER_TASK * tasks(plan.steps.find((x) => x.step === from) as PlanStep);
  }
  return most;
}

/** A preview's lines of the steps made later (§12.3): each pending step and handler, in the words of §6, a fan-out with its bound. */
export function laterLines(plan: Plan): Array<{ step: string; words: string }> {
  return plan.steps.filter((s) => s.made !== 'start').map((s) => ({ step: s.step, words: stepWords(plan.steps, s, (x) => fanOutMax(plan, x)) }));
}

/** A preview's head for a plan (§12.3): `1 task now, and up to 108 more as results come`, and past the cap `, at most 500 in all`. */
export function laterCount(plan: Plan, now: number): string {
  const more = mostLater(plan);
  const capped = now + more > INSTANCE_CAP ? `, at most ${INSTANCE_CAP} in all` : '';
  return `${now} task${now === 1 ? '' : 's'} now, and up to ${more} more as results come${capped}`;
}
```

In `src/kanban/service.ts`, replace:

```ts
  wakeNote?: string;
```

with:

```ts
  wakeNote?: string;
  /** For an instance with a plan, the steps still waiting to be made, by name, handlers not among them (workflow routing spec §12.3, §13.2). */
  waiting?: string[];
```

In `src/kanban/service.ts`, replace:

```ts
    return { ok: true, instance: keyed.instance, tasks: membersWithTasks(this.#db, keyed.instance.instanceId), existing: true };
```

with:

```ts
    return { ok: true, instance: keyed.instance, tasks: membersWithTasks(this.#db, keyed.instance.instanceId), existing: true, ...this.#waitingOf(keyed.instance) };
  }

  /** An instance's steps still waiting, for one with a plan (workflow routing spec §12.3). */
  #waitingOf(instance: InstanceRow): { waiting?: string[] } {
    if (instance.plan === null) return {};
    const waiting = new Set(pendingOf(this.#db, instance.instanceId).filter((p) => p.state === 'waiting').map((p) => p.step));
    return { waiting: instance.plan.steps.filter((s) => waiting.has(s.step)).map((s) => s.step) };
```

In `src/kanban/service.ts`, replace:

```ts
    return { ok: true, instance: r.instance, tasks: r.members, existing: r.existing, ...(i.wakeNote === undefined ? {} : { wakeNote: i.wakeNote }) };
```

with:

```ts
    return {
      ok: true,
      instance: r.instance,
      tasks: r.members,
      existing: r.existing,
      ...(i.wakeNote === undefined ? {} : { wakeNote: i.wakeNote }),
      ...this.#waitingOf(r.instance),
    };
```

In `src/kanban/worker.ts`, replace:

```ts
    tasks: r.tasks.map((t) => ({ task_id: t.taskId, ref: t.ref, step: t.step, item: t.item })),
```

with:

```ts
    tasks: r.tasks.map((t) => ({ task_id: t.taskId, ref: t.ref, step: t.step, item: t.item })),
    // The steps made as results come (workflow routing spec §12.3).
    ...(r.waiting === undefined ? {} : { waiting: r.waiting }),
```

- [ ] **Step 29.4: Run them to verify they pass.** Run the same command. Expected: `Tests  5 passed (5)`.

- [ ] **Step 29.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3742 passed (3742)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 29.6: Commit.**

```bash
git add src/cli/operator.ts src/cli/plain.ts src/db/kanban.ts src/kanban/chat-render.ts src/kanban/chat.ts src/kanban/routing.ts src/kanban/service.ts src/kanban/worker.ts tests/routing-preview.test.ts
git commit -m "List a routed file's steps made later in its preview, counting what it could make, and say the steps to come in its start's reply and answers"
```

---

### Task 30: Reconciliation

**Files:**

- Create: `tests/routing-reconcile.test.ts`
- Modify: `README.md`, `src/cli/mt.ts`, `src/cli/operator.ts`, `src/db/kanban-read.ts`, `src/db/kanban.ts`, `src/index.ts`, `src/kanban/service.ts`, `tests/mt-kanban-workflow.test.ts`

§11. `mt kanban workflow reconcile w_… [--board] [--json]` reconciles an instance, answering each decision or `nothing was due`, then the nudge; `KanbanService.reconcileAll` reconciles every instance with something due, `routingDue`, which the gateway runs once it has built the service, saying `workflows: reconciled 2 instances, 3 steps decided` when one was decided. A blocked member makes its instance due only when its step routes and has a route due. A reconciliation that throws marks an instance not yet marked, says it once, and `mt` answers it in one line.

- [ ] **Step 30.1: Write the tests.**

In `tests/mt-kanban-workflow.test.ts`, replace:

```ts
    expect((await mt(['nonsense'])).err).toMatch(/^mt: kanban workflow takes list, instances, show, preview, start, apply or archive/);
```

with:

```ts
    expect((await mt(['nonsense'])).err).toMatch(/^mt: kanban workflow takes list, instances, show, preview, start, apply, archive or reconcile/);
```

Create `tests/routing-reconcile.test.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { loadConfig } from '../src/config.js';
import { createGateway } from '../src/index.js';
import { loadTeam } from '../src/team.js';
import { closeRun, createBoard } from '../src/db/kanban.js';
import { eventsOf, getInstance, membersOf, routingDue } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { KanbanService } from '../src/kanban/service.js';
import { clearSecrets } from '../src/secrets.js';
import { ManualClock, SCHEMA_DIR } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';
import { VI_ROLES, VI_WORKFLOW, madeOf, viRoles } from './helpers/routing.js';

/**
 * Reconciliation (workflow routing spec §11): `mt kanban workflow reconcile`,
 * its answers, `--json`, its refusals and its nudge; and the service's startup
 * reconciliation of every instance with something due, nothing for one with
 * nothing, a handler never making one due, nor a blocked member with no route
 * due; and a reconciliation's fault marked and said once, mt's error a line.
 */

let f: MtFixture;
let db: Db;
let service: KanbanService;
beforeEach(() => {
  clearSecrets();
  f = mtFixture((workspace) => `workspace: ${workspace}\nkanban:\n  enabled: true\nagent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n`);
  for (const name of VI_ROLES) {
    mkdirSync(join(f.home, 'roles', name), { recursive: true });
    writeFileSync(join(f.home, 'roles', name, 'config.yaml'), 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
  }
  mkdirSync(join(f.home, 'workflows'));
  writeFileSync(join(f.home, 'workflows', 'vi-workflow.yaml'), VI_WORKFLOW);
  db = openDb(join(f.home, 'team.db'));
  migrate(db, SCHEMA_DIR);
  createBoard(db, 'vi', ALICE, NOW);
  service = new KanbanService({ db, roles: viRoles(), workspaces: new Set(['default']), supervisedRoles: true, workflowsDir: join(f.home, 'workflows'), clock: new ManualClock(NOW) });
});
afterEach(() => {
  clearSecrets();
  db.close();
  f.cleanup();
});

/** An instance whose intake's completion faulted in its routing, the fault gone since: va is due. */
async function faulted(): Promise<string> {
  const w = madeOf(service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
  const intake = w.tasks[0]?.taskId ?? '';
  db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  const run = claimed(db, intake);
  await service.complete(intake, { kind: 'run', runId: run.runId }, { summary: 'x', metadata: { kind: 'cve', verify: false, patch: false, bnpm: false, packages: ['lodash', 'qs'] } });
  closeRun(db, run.runId, NOW);
  db.exec('DROP TRIGGER boom');
  return w.instance.instanceId;
}

async function mt(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMt(['kanban', 'workflow', 'reconcile', ...argv], { env: { ...f.env, HOME: f.root }, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('mt kanban workflow reconcile', () => {
  it('decides what is due, answering each decision, then nothing the second time', async () => {
    const id = await faulted();
    const first = await mt(id);
    expect(first.code).toBe(0);
    expect(first.out).toBe(
      `reconciled ${id}: va made; verify skipped (intake.verify is false); registry skipped (intake.bnpm is false); patch skipped (intake.patch is false)`,
    );
    expect(first.err).toMatch(/^mt: no gateway answered at /);
    expect(getInstance(db, id)?.routingFailedAt).toBeNull();
    expect(await mt(id)).toEqual({ code: 0, out: `${id}: nothing was due`, err: '' });
  });

  it('answers a fault in one line, the instance marked and the fault said once', async () => {
    const id = await faulted();
    db.prepare('UPDATE kanban_workflow_instances SET routing_failed_at = NULL').run();
    // Not a temporary trigger: mt opens the database on a connection of its own.
    db.exec("CREATE TRIGGER made BEFORE INSERT ON kanban_tasks BEGIN SELECT RAISE(ABORT, 'no task can be made'); END;");
    expect(await mt(id)).toEqual({ code: 1, out: '', err: `mt: the routing of ${id} failed: no task can be made; the gateway tries again` });
    expect(getInstance(db, id)?.routingFailedAt).not.toBeNull();
    expect(await mt(id)).toMatchObject({ code: 1 });
    db.exec('DROP TRIGGER made');
    const intake = membersOf(db, id)[0]?.taskId ?? '';
    const failed = eventsOf(db, intake).filter((e) => e.kind === 'workflow_route_failed').map((e) => e.payload);
    expect(failed.at(-1)).toEqual({ workflow: id, workflowName: 'vi-workflow', error: 'no task can be made', first: true });
    expect(failed.filter((p) => (p as { first: boolean }).first).length).toBe(2);
  });

  it('answers --json with each decision and its tasks, and refuses an unknown instance and another board', async () => {
    const id = await faulted();
    const r = JSON.parse((await mt(id, '--json')).out) as { ok: boolean; instance_id: string; decisions: Array<{ step: string; outcome: string; task_ids: string[] }> };
    const va = membersOf(db, id).find((m) => m.step === 'va')?.taskId;
    expect(r).toMatchObject({ ok: true, instance_id: id });
    expect(r.decisions[0]).toEqual({ step: 'va', outcome: 'made', task_ids: [va] });
    expect(await mt('w_nope')).toEqual({ code: 1, out: '', err: 'mt: no workflow instance w_nope' });
    expect((await mt(id, '--board', 'default')).err).toBe(`mt: instance ${id} is on board vi, not default`);
  });
});

describe("the startup's reconciliation", () => {
  it('reconciles every instance with something due, and says nothing for one with nothing', async () => {
    await faulted();
    expect(service.reconcileAll()).toEqual({ instances: 1, steps: 4 });
    expect(service.reconcileAll()).toEqual({ instances: 0, steps: 0 });
  });

  it('marks an instance whose reconciliation faults, and says it once', async () => {
    const id = await faulted();
    db.prepare('UPDATE kanban_workflow_instances SET routing_failed_at = NULL').run();
    db.exec("CREATE TEMP TRIGGER made BEFORE INSERT ON kanban_tasks BEGIN SELECT RAISE(ABORT, 'no task can be made'); END;");
    expect(service.reconcileAll()).toEqual({ instances: 0, steps: 0 });
    expect(getInstance(db, id)?.routingFailedAt).toBe(NOW);
    expect(service.retryRouting()).toBe(0);
    const intake = membersOf(db, id)[0]?.taskId ?? '';
    expect(eventsOf(db, intake).filter((e) => e.kind === 'workflow_route_failed' && (e.payload as { error: string }).error === 'no task can be made').length).toBe(1);
  });

  it('counts a blocked member only when its step routes and a route is due', () => {
    writeFileSync(
      join(f.home, 'workflows', 'blocks.yaml'),
      `board: vi
steps:
  a:
    title: a
    assignee: vi-coordinator
  b:
    title: b
    assignee: verifier
    on_blocked: { route: h }
  h:
    title: h
    assignee: vi-coordinator
    handler: true
`,
    );
    const w = madeOf(service.startWorkflow({ workflow: 'blocks', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
    const [a, bb] = [w.tasks[0]?.taskId ?? '', w.tasks[1]?.taskId ?? ''];
    const block = (taskId: string) => {
      const run = claimed(db, taskId);
      expect(service.block(taskId, { kind: 'run', runId: run.runId }, { kind: 'capability', reason: 'no network' }).ok).toBe(true);
      closeRun(db, run.runId, NOW);
    };
    block(a);
    expect(routingDue(db)).toEqual([]);
    db.exec("CREATE TEMP TRIGGER noroute BEFORE INSERT ON kanban_workflow_routes BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    block(bb);
    db.exec('DROP TRIGGER noroute');
    db.prepare('UPDATE kanban_workflow_instances SET routing_failed_at = NULL').run();
    expect(routingDue(db)).toEqual([w.instance.instanceId]);
    expect(service.reconcileAll()).toEqual({ instances: 1, steps: 1 });
    expect(routingDue(db)).toEqual([]);
  });

  it("is said in one note at the gateway's start, before its dispatcher's first pass", async () => {
    const id = await faulted();
    db.close();
    const env = {
      MT_HOME: f.home,
      MT_DB: join(f.home, 'team.db'),
      MT_WORKSPACE: f.workspace,
      MT_OWNER_OPEN_ID: 'ou_owner',
      LARK_APP_ID: 'cli_app',
      LARK_APP_SECRET: 'app-secret',
      MT_AGENT_COMMAND: 'bytesec',
      MT_AGENT_DRIVER: 'structured-cli',
      MT_AGENT_UNSUPERVISED: 'true',
    };
    const loaded = loadConfig(env, () => undefined);
    const config = { ...loaded, kanban: { ...loaded.kanban, enabled: true } };
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const gateway = await createGateway(config, loadTeam(config, env));
    try {
      expect(lines.filter((l) => l.includes('workflows: reconciled')).map((l) => l.replace(/^.*?workflows:/, 'workflows:'))).toEqual(['workflows: reconciled 1 instance, 4 steps decided\n']);
    } finally {
      await gateway.stop();
      vi.restoreAllMocks();
    }
    db = openDb(join(f.home, 'team.db'));
    expect(getInstance(db, id)?.routingFailedAt).toBeNull();
  });
});
```

- [ ] **Step 30.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-kanban-workflow.test.ts tests/routing-reconcile.test.ts`. Expected: `Tests  8 failed | 13 passed (21)`, the first as `AssertionError: expected 'mt: kanban workflow takes list, insta…' to match /^mt: kanban workflow takes list, inst…/`.

- [ ] **Step 30.3: Implement.**

In `README.md`, replace:

```markdown
mt kanban workflow archive <instance> [--board <name>]
```

with:

```markdown
mt kanban workflow archive <instance> [--board <name>]
mt kanban workflow reconcile <instance> [--board <name>]
```

In `src/cli/mt.ts`, replace:

```ts
  '  mt kanban workflow archive <instance> [--board <name>] [--json]',
```

with:

```ts
  '  mt kanban workflow archive <instance> [--board <name>] [--json]',
  '  mt kanban workflow reconcile <instance> [--board <name>] [--json]',
```

In `src/cli/mt.ts`, replace:

```ts
  workflow: ['list', 'instances', 'show', 'preview', 'start', 'apply', 'archive'],
```

with:

```ts
  workflow: ['list', 'instances', 'show', 'preview', 'start', 'apply', 'archive', 'reconcile'],
```

In `src/cli/operator.ts`, replace:

```ts
import { WAKES_OFF, WORKFLOW_MESSAGE_BYTES, type KanbanService, type StartWake, type WorkflowMade } from '../kanban/service.js';
```

with:

```ts
import { WAKES_OFF, WORKFLOW_MESSAGE_BYTES, type KanbanService, type RoutedLine, type StartWake, type WorkflowMade } from '../kanban/service.js';
```

In `src/cli/operator.ts`, replace:

```ts
export const WORKFLOW_COMMANDS: readonly string[] = ['list', 'instances', 'show', 'preview', 'start', 'apply', 'archive'];
```

with:

```ts
export const WORKFLOW_COMMANDS: readonly string[] = ['list', 'instances', 'show', 'preview', 'start', 'apply', 'archive', 'reconcile'];
```

In `src/cli/operator.ts`, replace:

```ts

/** `mt kanban workflow <verb> …`. */
```

with:

```ts

/** A reconciliation's decision as its answer says it (workflow routing spec §11): `verify skipped (intake.verify is false)`, `exposure: 3 tasks`. */
function decisionText(d: RoutedLine): string {
  switch (d.outcome) {
    case 'made':
      return `${d.step} made`;
    case 'skipped':
      return `${d.step} skipped (${d.why})`;
    case 'fanned_out':
      return `${d.step}: ${d.count ?? d.taskIds.length} task${(d.count ?? d.taskIds.length) === 1 ? '' : 's'}`;
    case 'routed':
      return `${d.handler ?? ''} routed from ${d.step}`;
    case 'stood_in':
      return `${d.handler ?? ''} stands in for ${d.step}`;
    case 'over_limit':
      return `${d.step} over the limit of routes`;
    case 'over_cap':
      return `${d.step} not routed: the instance has 500 tasks`;
    case 'unread':
      return `${d.handler ?? ''} left open`;
  }
}

/**
 * `mt kanban workflow reconcile <instance> [--board] [--json]` (workflow routing spec §11): the routing given no
 * transitioning task, deciding and making what is due, in one transaction; then the nudge, as after a start. Safe
 * against the gateway, whose keys make a reconciliation that races it decide nothing twice.
 */
function reconcileInstance(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, BOARD_FLAGS);
  const [instanceId, extra] = positionals;
  if (instanceId === undefined || extra !== undefined) throw new UsageError('kanban workflow reconcile takes an instance id');
  const board = boardFlag(values.board);
  return act(
    io,
    values.json === true,
    'mt kanban workflow reconcile',
    (service) => {
      const guard = instanceOffBoard(service, board, instanceId);
      if (guard !== undefined) return guard;
      let r: ReturnType<KanbanService['reconcileWorkflow']>;
      try {
        r = service.reconcileWorkflow(instanceId);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return refused({ code: 'routing_failed', message: `the routing of ${instanceId} failed: ${error}; the gateway tries again` });
      }
      if (!r.ok) return refused(r);
      const said = r.decisions.map((d) => line(decisionText(d), 400)).join('; ');
      return {
        ok: true,
        lines: [r.decisions.length === 0 ? `${instanceId}: nothing was due` : `reconciled ${instanceId}: ${said}`],
        json: { instance_id: instanceId, decisions: r.decisions.map((d) => ({ step: d.step, outcome: d.outcome, task_ids: d.taskIds })) },
        nudge: r.decisions.length > 0,
      };
    },
    { workflows: true },
  );
}

/** `mt kanban workflow <verb> …`. */
```

In `src/cli/operator.ts`, replace:

```ts
      return archiveInstance(rest, io);
```

with:

```ts
      return archiveInstance(rest, io);
    case 'reconcile':
      return reconcileInstance(rest, io);
```

In `src/db/kanban-read.ts`, replace:

```ts

/** The instances whose routing faulted and no reconciliation has cleared since, oldest fault first (§9.4). */
```

with:

```ts

/**
 * The instances a startup reconciles (§11): with a plan, and a waiting step, a
 * skipped step not yet settled, a member blocked from its work whose step routes
 * and has a route due, or a fault not reconciled. A handler has no row, so it
 * never makes an instance due.
 */
export function routingDue(db: Db): string[] {
  if (!hasRouting(db)) return [];
  return db
    .prepare<[], { instance_id: string; plan: string; blocked: number }>(
      `SELECT i.instance_id, json(i.plan) AS plan, (
          i.routing_failed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM kanban_workflow_pending p WHERE p.instance_id = i.instance_id AND p.state = 'waiting')
          AND NOT EXISTS (SELECT 1 FROM kanban_workflow_pending p WHERE p.instance_id = i.instance_id AND p.state = 'skipped'
                       AND NOT EXISTS (SELECT 1 FROM kanban_workflow_settled s WHERE s.instance_id = p.instance_id AND s.step = p.step AND s.ref = p.step))
        ) AS blocked
         FROM kanban_workflow_instances i
        WHERE i.plan IS NOT NULL AND (
          i.routing_failed_at IS NOT NULL
          OR EXISTS (SELECT 1 FROM kanban_workflow_pending p WHERE p.instance_id = i.instance_id AND p.state = 'waiting')
          OR EXISTS (SELECT 1 FROM kanban_workflow_pending p WHERE p.instance_id = i.instance_id AND p.state = 'skipped'
                       AND NOT EXISTS (SELECT 1 FROM kanban_workflow_settled s WHERE s.instance_id = p.instance_id AND s.step = p.step AND s.ref = p.step))
          OR EXISTS (SELECT 1 FROM kanban_workflow_tasks m JOIN kanban_tasks t ON t.task_id = m.task_id
                      WHERE m.instance_id = i.instance_id AND t.phase = 'blocked' AND t.blocked_from = 'open'))
        ORDER BY i.created_at, i.instance_id`,
    )
    .all()
    .filter((r) => r.blocked === 0 || routeDueIn(db, r.instance_id, JSON.parse(r.plan) as Plan))
    .map((r) => r.instance_id);
}

/** Whether a member blocked from its work has a route due (§5.1, §5.3): its latest block a trigger its step routes by, with no route row for it. */
function routeDueIn(db: Db, instanceId: string, plan: Plan): boolean {
  const routes = routesOf(db, instanceId);
  return db
    .prepare<[string], { task_id: string; step: string }>(
      `SELECT m.task_id, m.step FROM kanban_workflow_tasks m JOIN kanban_tasks t ON t.task_id = m.task_id
        WHERE m.instance_id = ? AND t.phase = 'blocked' AND t.blocked_from = 'open'`,
    )
    .all(instanceId)
    .some((m) => {
      const step = plan.steps.find((s) => s.step === m.step);
      const latest = latestBlockOf(db, m.task_id);
      const t = triggersOf(db, m.task_id).find((x) => x.eventId === latest);
      if (step === undefined || t === undefined) return false;
      const spec = t.kind === 'gave_up' ? step.on_gave_up : step.on_blocked;
      return spec !== 'wait' && !routes.some((x) => x.fromTask === m.task_id && x.eventId === t.eventId);
    });
}

/** The instances whose routing faulted and no reconciliation has cleared since, oldest fault first (§9.4). */
```

In `src/db/kanban.ts`, replace:

```ts
    return { ok: true, ...withSuperseded({ instance: getInstance(d, instanceId) as InstanceRow, decisions }, superseded) };
  });
}
```

with:

```ts
    return { ok: true, ...withSuperseded({ instance: getInstance(d, instanceId) as InstanceRow, decisions }, superseded) };
  });
}

/**
 * A reconciliation that threw (§9.4, §11), in a transaction of its own once its
 * own rolled back: an instance not marked is marked, and one
 * `workflow_route_failed` event, `first`, goes on its first member, so the fault
 * is said once and retried on the dispatcher's pass. One marked already is left
 * as it is, so a retry that faults again says nothing more.
 */
export function reconcileFailed(db: Db, instanceId: string, err: unknown, now: number): void {
  txImmediate(db, (d) => {
    if (getInstance(d, instanceId)?.routingFailedAt !== null) return;
    const first = membersOf(d, instanceId)[0];
    if (first !== undefined) routingFault(d, first.taskId, err, now);
  });
}
```

In `src/index.ts`, replace:

```ts
    boardService = service;
```

with:

```ts
    boardService = service;
    // What a stop left due, decided now, before the dispatcher's first pass (workflow routing spec §11).
    const reconciled = service.reconcileAll();
    if (reconciled.instances > 0) {
      note(`workflows: reconciled ${reconciled.instances} instance${reconciled.instances === 1 ? '' : 's'}, ${reconciled.steps} step${reconciled.steps === 1 ? '' : 's'} decided`);
    }
```

In `src/kanban/service.ts`, replace:

```ts
  routesOf,
```

with:

```ts
  routesOf,
  routingDue,
```

In `src/kanban/service.ts`, replace:

```ts
export type { CreateRequest } from './types.js';
```

with:

```ts
export type { CreateRequest } from './types.js';

/** A routing decision as the writer records it (workflow routing spec §12.2): exported here, as only the service reaches the writer. */
export type { RoutedLine } from '../db/kanban.js';
```

In `src/kanban/service.ts`, replace:

```ts
    return this.#cancelled(board.reconcileWorkflow(this.#db, instanceId, this.#clock.now(), this.#facts()));
```

with:

```ts
    try {
      return this.#cancelled(board.reconcileWorkflow(this.#db, instanceId, this.#clock.now(), this.#facts()));
    } catch (err) {
      // Its transaction rolled back: the fault is marked and said in one of its own, then thrown to the caller.
      try {
        board.reconcileFailed(this.#db, instanceId, err, this.#clock.now());
      } catch {
        // The database refused that too: the caller's error is the reconciliation's.
      }
      throw err;
    }
  }

  /**
   * The startup's reconciliation (workflow routing spec §11): every instance with a
   * plan that may have something due, a waiting step, a skipped step not yet
   * settled, a blocked member, or a fault not reconciled, reconciled once; a
   * handler never makes an instance due. Answers how many instances had a
   * decision, and how many decisions; one that faults keeps its mark.
   */
  reconcileAll(): { instances: number; steps: number } {
    let instances = 0;
    let steps = 0;
    for (const id of routingDue(this.#db)) {
      try {
        const r = this.reconcileWorkflow(id);
        if (r.ok && r.decisions.length > 0) {
          instances += 1;
          steps += r.decisions.length;
        }
      } catch {
        // Marked by reconcileWorkflow, if it was not: the dispatcher's pass retries it.
      }
    }
    return { instances, steps };
```

- [ ] **Step 30.4: Run them to verify they pass.** Run the same command. Expected: `Tests  21 passed (21)`.

- [ ] **Step 30.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3749 passed (3749)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 30.6: Commit.**

```bash
git add README.md src/cli/mt.ts src/cli/operator.ts src/db/kanban-read.ts src/db/kanban.ts src/index.ts src/kanban/service.ts tests/mt-kanban-workflow.test.ts tests/routing-reconcile.test.ts
git commit -m "Reconcile a routed instance at the terminal with mt kanban workflow reconcile, and every instance with something due at the gateway's start"
```

---

### Task 31: The documents

**Files:**

- Create: `tests/docs-routing.test.ts`
- Modify: `README.md`, `docs/kanban-guide.md`, `skills/mt-kanban/SKILL.md`, `tests/docs-examples.test.ts`

§16. The guide's §12 gains "Routing on results", with the folded vi file, how a step is shown, cancelling by `workflow archive`, `reconcile`, and what a handler's directory line needs; the README names the new keys, the commands and the spec; the board's skill tells an agent to report its outputs. The workflows spec already carries its two notes (§0, §17). The docs-examples home gains the vi file's roles, so the guide's file is checked as every documented one is.

- [ ] **Step 31.1: Write the tests.**

In `tests/docs-examples.test.ts`, replace:

```ts
 * A gateway home at `<root>/.manus-team`: the roles worker, reviewer and triage,
```

with:

```ts
 * A gateway home at `<root>/.manus-team`: the roles worker, reviewer and triage, and the routed assessment's,
```

In `tests/docs-examples.test.ts`, replace:

```ts
  const roles: Record<string, string> = { worker: 'workspace: worker\n', reviewer: '', triage: 'workspace: triage\n' };
```

with:

```ts
  const roles: Record<string, string> = { worker: 'workspace: worker\n', reviewer: '', triage: 'workspace: triage\n' };
  // The roles of the guide's routed assessment (workflow routing spec §1).
  for (const name of ['vi-coordinator', 'vulnerability-analyst', 'verifier', 'exposure-analyst', 'registry-analyst', 'report-author', 'assessment-reviewer', 'patch-author']) roles[name] = '';
```

Create `tests/docs-routing.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkWorkflow } from '../src/kanban/workflow.js';
import { VI_WORKFLOW, viRoles } from './helpers/routing.js';

/**
 * The documents of workflow routing (workflow routing spec §16): the guide's
 * section on routing on results, its file the one the tests start, and checked;
 * the board's skill telling an agent to report its outputs; the README's
 * commands; and the workflows spec's notes that this one extends it.
 */

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function example(doc: string, marker: string): string {
  const lines = read(doc).split('\n');
  const at = lines.findIndex((l) => l.trim() === `<!-- example: ${marker} -->`);
  if (at === -1) throw new Error(`${doc} has no example ${marker}`);
  const end = lines.findIndex((l, i) => i > at + 1 && l.trim() === '```');
  return `${lines.slice(at + 2, end).join('\n')}\n`;
}

function section(doc: string, heading: string): string {
  const lines = read(doc).split('\n');
  const at = lines.indexOf(heading);
  if (at === -1) throw new Error(`${doc} has no ${heading}`);
  const end = lines.findIndex((l, i) => i > at && /^#{1,3} /.test(l));
  return lines.slice(at, end === -1 ? undefined : end).join('\n');
}

describe('the documents of workflow routing', () => {
  it("gives the guide's file, which is the folded vi file and passes the check", () => {
    const file = example('docs/kanban-guide.md', 'workflow vi-workflow');
    expect(file).toBe(VI_WORKFLOW);
    expect(checkWorkflow('vi-workflow', file, { roles: viRoles(), workspaces: new Set(['default']), supervisedRoles: false }).ok).toBe(true);
  });

  it('says in the guide how a step is shown, how a case is cancelled, reconcile, and what the directory line needs', () => {
    const text = section('docs/kanban-guide.md', '### Routing on results');
    for (const said of [
      '⏭ verify: skipped (intake.verify is false)',
      '/kanban workflow archive w_…',
      'mt kanban workflow reconcile w_…',
      'mt kanban workflow show w_… --plan',
      'helps only if its agent may read outside its own worktree',
    ]) {
      expect(text).toContain(said);
    }
  });

  it("tells an agent in the board's skill to report its outputs in its metadata", () => {
    expect(read('skills/mt-kanban/SKILL.md').replace(/\s*\n\s*/g, ' ')).toContain(
      'When your task\'s outcome names outputs, report each as a top-level key of "metadata", of the type it names; a completion without them is refused, and you report again in the same run.',
    );
  });

  it("lists the README's commands and the spec, and the workflows spec's notes", () => {
    const readme = read('README.md');
    expect(readme).toContain('mt kanban workflow reconcile <instance> [--board <name>]');
    expect(readme).toContain('mt kanban workflow show <instance> [--board <name>] [--dag | --plan]');
    expect(readme).toContain('[workflow routing](docs/specs/2026-11-26-workflow-routing-design.md)');
    const spec = read('docs/specs/2026-11-16-workflows-design.md');
    expect(spec.split('*Extended by docs/specs/2026-11-26-workflow-routing-design.md*').length).toBe(3);
  });
});
```

- [ ] **Step 31.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/docs-examples.test.ts tests/docs-routing.test.ts`. Expected: `Tests  4 failed | 27 passed (31)`, the first as `Error: docs/kanban-guide.md has no example workflow vi-workflow`.

- [ ] **Step 31.3: Implement.**

In `README.md`, replace:

```markdown
  which board the tasks go on.
```

with:

```markdown
  which board the tasks go on. A step's reported outputs can decide the rest: `when` makes or
  skips a step, a fan-out runs over a result's list, and a step that gives up goes to a handler.
```

In `README.md`, replace:

```markdown
  [wake](docs/specs/2026-11-19-wake-design.md) and [progress cards](docs/specs/2026-11-24-progress-cards-design.md).
```

with:

```markdown
  [wake](docs/specs/2026-11-19-wake-design.md), [progress cards](docs/specs/2026-11-24-progress-cards-design.md)
  and [workflow routing](docs/specs/2026-11-26-workflow-routing-design.md).
```

In `README.md`, replace:

```markdown
preview` shows what a start would make. A workflow has no conditions: one that must branch has a
deciding step, whose agent reads its parents' handoffs and creates the branch it chose. Params
never reach a gate. `mt workflow check` checks the files, and the gateway says at startup which
```

with:

```markdown
preview` shows what a start would make. A step may declare `outputs`, which its run reports, and
the steps after it can be made or skipped by them (`when`), fanned out over a result's list
(`for_each: { step, output }`), or handed to a handler when it blocks or gives up; section 12 of
the guide has the file. Params, and results, never reach a gate. `mt workflow check` checks the files, and the gateway says at startup which
```

In `docs/kanban-guide.md`, replace:

```markdown

## 13. Recipes: graphs of tasks
```

with:

````markdown

### Routing on results

A step may report facts, and the steps after it may be made, skipped, fanned out or handed to
someone else by what it reported. One file then does what several did, as this assessment does,
routed by its intake:

<!-- example: workflow vi-workflow -->
```yaml
description: CVE or supply-chain assessment, routed by its intake
board: vi
params:
  case: { required: true, description: "a CVE id, or the absolute path of a package CSV" }
steps:
  intake:
    title: "{{case}} · intake"
    assignee: vi-coordinator
    outputs:
      kind: { enum: [cve, supplychain] }
      verify: boolean
      patch: boolean
      bnpm: boolean
      packages: { list: string, max: 100 }
  va:
    title: "{{case}} · va"
    assignee: vulnerability-analyst
    parents: [intake]
    when:
      - { step: intake, output: kind, equals: cve }
    on_gave_up: { route: escalate }
    outputs:
      reachable: boolean
  escalate:
    title: "{{case}} · va, escalated"
    assignee: vi-coordinator
    handler: true
    stands_in_for: va
    outputs:
      reachable: boolean
  verify:
    title: "{{case}} · verify"
    assignee: verifier
    parents: [va]
    when:
      - { step: intake, output: verify, is: true }
      - { step: va, output: reachable, is: true }
  exposure:
    title: "{{case}} · exposure of {{item}}"
    assignee: exposure-analyst
    parents: [va]
    for_each: { step: intake, output: packages }
  registry:
    title: "{{case}} · registry"
    assignee: registry-analyst
    parents: [intake]
    when:
      - { step: intake, output: bnpm, is: true }
  report:
    title: "{{case}} · report"
    assignee: report-author
    reviewer: { role: assessment-reviewer }
    parents: [va, verify, exposure, registry]
  patch:
    title: "{{case}} · patch"
    assignee: patch-author
    parents: [report]
    when:
      - { step: intake, output: patch, is: true }
```

- **`outputs`** are the facts a step's run reports, each a top-level key of its completion's
  `metadata`, of its type: `boolean`, `number`, `string`, `{ enum: [values] }`, or `{ list: <type>,
  max: <n> }`. Every one is required; a completion missing one, or with the wrong type, is refused,
  and the agent reports again in the same run. The step's outcome tells the agent what to report.
  Only a role's step declares outputs: a person's done carries no metadata.
- **`when`** makes a step only if every clause holds, and at least one of an `any` group's: a
  clause names an ancestor's output and one test, `equals`, `in`, `is`, `at_least` or
  `at_most`, or its state, `done`, `skipped`, `gave_up` or `blocked`. A step whose `when` is
  false is **skipped**, said at once in the thread; its children wait until its own parents are
  through, and are linked past it to the nearest done steps. A clause on a skipped step's output
  is false.
- **`for_each: { step, output }`** makes one task an item of an ancestor's list, once that
  ancestor is done; an empty list skips the step. The steps below it wait for every item.
- **`on_blocked` and `on_gave_up: { route: <handler> }`** hand a step whose run blocks, or gives
  up, to a **handler**, a step with `handler: true`, made for that block alone, at most 3 times a
  task. Its task's body ends with a paragraph naming the task it was routed from; it may unblock
  that task with `mt kanban unblock`. With `stands_in_for`, its accepted completion settles that
  step instead, with the step's reviewer, gates and outputs, and the stuck task is archived.
  A handler's "Its directory" line helps only if its agent may read outside its own worktree:
  its role's sandbox and tools decide that.

A start makes the steps that need no result at once, and keeps the rest in the instance's
**plan**, frozen: editing the file changes no running instance. `/kanban workflow preview` lists
the steps made later, and how many tasks they could make. `/kanban workflow show w_…` lists every
step in the file's order, with where it is and why:

```
✓ intake: done (kind=cve, verify=false, patch=false, bnpm=false, 3 packages)
✓ va: done, stood in for by escalate (reachable=true)
↪ escalate: routed from va (gave up), standing in
⏭ verify: skipped (intake.verify is false)
▶ exposure: 3 items, 1 done
⏳ report: waiting for exposure
```

`mt kanban workflow show w_… --plan` prints the plan. To cancel a case, archive the instance,
`/kanban workflow archive w_…`: every waiting step is skipped and nothing more is made; archiving
its tasks one by one is not a cancel, as each archive is decided on. A routing that failed is
said once in the thread and tried again by the gateway; `mt kanban workflow reconcile w_…` tries
it now. `preview --json` refuses a file that uses these keys, and `apply` a DAG labelled with
one: only a start keeps their checks and routes.

## 13. Recipes: graphs of tasks
````

In `skills/mt-kanban/SKILL.md`, replace:

```markdown
it. Put structured facts in "metadata". A good `mt kanban complete`:
```

with:

```markdown
it. Put structured facts in "metadata". When your task's outcome names outputs, report each as a
top-level key of "metadata", of the type it names; a completion without them is refused, and you
report again in the same run. A good `mt kanban complete`:
```

- [ ] **Step 31.4: Run them to verify they pass.** Run the same command. Expected: `Tests  32 passed (32)`.

- [ ] **Step 31.5: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3754 passed (3754)`. `npx vitest run --project e2e` gives `Tests  187 passed (187)`.

- [ ] **Step 31.6: Commit.**

```bash
git add README.md docs/kanban-guide.md skills/mt-kanban/SKILL.md tests/docs-examples.test.ts tests/docs-routing.test.ts
git commit -m "Document routing on results in the guide, the README and the board's skill"
```

---

### Task 32: End to end

**Files:**

- Create: `tests/routing-gateway.e2e.ts`
- Modify: `tests/fakes/cli-agent.mjs`

§17's end-to-end test, through `createGateway`, the fake chat and the fake CLI agent in a new `routing` mode that acts on its task's body: the intake's report without its packages refused and the next taken; verify and registry skipped and exposure fanned out in one notice; the items done; va giving up, escalate routed and standing in, va archived with its comment; report joining and reviewed; patch skipped; the instance done; and a restart in the middle deciding nothing twice. This task adds tests only, of what Tasks 1 to 31 built.

- [ ] **Step 32.1: Write the tests.**

In `tests/fakes/cli-agent.mjs`, replace:

```js
 *               MT_AGENT_SESSION, is appended to `cron-env.log` beside the log
```

with:

```js
 *               MT_AGENT_SESSION, is appended to `cron-env.log` beside the log
 *   routing     a board run that reads its task with `mt kanban show` and acts on its
 *               body's lines: CRASH exits without finishing; each `REPORT {…}` is
 *               a `mt kanban complete` input, tried in order until one is taken,
 *               each answer appended to `routing.log` beside the log; with none, a
 *               plain complete; a review run approves with `LGTM`
```

In `tests/fakes/cli-agent.mjs`, replace:

```js

  case 'staged': {
```

with:

```js

  case 'routing': {
    const beside = (name) => join(dirname(LOG ?? '.'), name);
    const shown = mt('show');
    let view = {};
    try {
      view = JSON.parse(shown.answer);
    } catch {
      process.stderr.write(`mt kanban show failed: ${shown.error} ${shown.answer}\n`);
    }
    const task = view.task ?? {};
    const body = task.body ?? '';
    if (view.run?.kind === 'review') {
      const approved = mt('complete', { summary: 'LGTM' });
      delta(`approve: ${approved.answer}`);
      summary('completed', 'approved');
      break;
    }
    if (body.split('\n').some((l) => l.trim() === 'CRASH')) {
      delta('starting');
      process.stderr.write('fake agent is going down mid-turn\n');
      process.exit(7);
    }
    const reports = body
      .split('\n')
      .filter((l) => l.startsWith('REPORT '))
      .map((l) => JSON.parse(l.slice('REPORT '.length)));
    let answer = '';
    for (const report of reports.length > 0 ? reports : [{ summary: `did: ${task.title}` }]) {
      answer = mt('complete', report).answer;
      appendFileSync(beside('routing.log'), `${JSON.stringify({ task: task.task_id, title: task.title, report, answer })}\n`);
      let ok = false;
      try {
        ok = JSON.parse(answer).ok === true;
      } catch {
        // An answer that is no JSON is a failure: the next report is tried.
      }
      if (ok) break;
    }
    delta(`complete: ${answer}`);
    summary('completed', 'reported');
    break;
  }

  case 'staged': {
```

Create `tests/routing-gateway.e2e.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LarkAdapter } from '../src/channel/lark/adapter.js';
import type { Channel } from '../src/channel/types.js';
import { loadConfig, type GatewayConfig } from '../src/config.js';
import { commentsOf, membersOf, parentsOf, pendingOf, settledOf } from '../src/db/kanban-read.js';
import { createGateway, type Gateway } from '../src/index.js';
import { clearSecrets } from '../src/secrets.js';
import { loadTeam } from '../src/team.js';
import { FakeChannel } from './helpers/channel.js';

/**
 * Workflow routing end to end (workflow routing spec §17): a vi-style instance
 * started from a fake chat, its steps run by the fake CLI agent through the real
 * socket. The intake's report without its packages is refused, and the next
 * taken; verify and registry are skipped and exposure fans out into three
 * tasks, in one notice; the items complete; va gives up, escalate is routed and
 * stands in, and va is archived with its comment; report joins the three items
 * and escalate, and is reviewed; patch is skipped; the instance ends done; and a
 * gateway restart in the middle decides nothing twice.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));

const FILE = `description: CVE or supply-chain assessment, routed by its intake
params:
  case: { required: true }
steps:
  intake:
    title: "{{case}} · intake"
    body: |
      REPORT {"summary": "triaged", "metadata": {"kind": "cve", "verify": false, "patch": false, "bnpm": false}}
      REPORT {"summary": "triaged", "metadata": {"kind": "cve", "verify": false, "patch": false, "bnpm": false, "packages": ["lodash", "minimist", "qs"]}}
    assignee: default
    outputs:
      kind: { enum: [cve, supplychain] }
      verify: boolean
      patch: boolean
      bnpm: boolean
      packages: { list: string, max: 100 }
  va:
    title: "{{case}} · va"
    body: CRASH
    assignee: default
    parents: [intake]
    failure_limit: 1
    when:
      - { step: intake, output: kind, equals: cve }
    on_gave_up: { route: escalate }
    outputs:
      reachable: boolean
  escalate:
    title: "{{case}} · va, escalated"
    body: 'REPORT {"summary": "asked upstream", "metadata": {"reachable": true}}'
    assignee: default
    handler: true
    stands_in_for: va
    outputs:
      reachable: boolean
  verify:
    title: "{{case}} · verify"
    assignee: default
    parents: [va]
    when:
      - { step: intake, output: verify, is: true }
      - { step: va, output: reachable, is: true }
  exposure:
    title: "{{case}} · exposure of {{item}}"
    assignee: default
    parents: [intake]
    for_each: { step: intake, output: packages }
  registry:
    title: "{{case}} · registry"
    assignee: default
    parents: [intake]
    when:
      - { step: intake, output: bnpm, is: true }
  report:
    title: "{{case}} · report"
    assignee: default
    reviewer: default
    parents: [va, verify, exposure, registry]
  patch:
    title: "{{case}} · patch"
    assignee: default
    parents: [report]
    when:
      - { step: intake, output: patch, is: true }
`;

let root: string;
let home: string;
let config: GatewayConfig;
let lark: FakeChannel;
let handlers: { message: (msg: unknown) => Promise<void> } | undefined;
let gateway: Gateway | undefined;
let lines: string[];
let seq = 0;

const CHANNEL_METHODS = ['sendText', 'openCard', 'sendApprovalCard', 'updateApprovalCard', 'sendCard', 'updateCard', 'react', 'unreact', 'chatMembers'] as const;
const OWNER = { openId: 'ou_owner', unionId: 'on_owner', name: 'Alice' };

beforeEach(() => {
  clearSecrets();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-routing-gw-')));
  home = join(root, 'home');
  mkdirSync(join(home, 'workflows'), { recursive: true });
  writeFileSync(join(home, 'workflows', 'vi-workflow.yaml'), FILE);
  mkdirSync(join(root, 'repo'));
  const env = {
    MT_HOME: home,
    MT_DB: join(home, 'team.db'),
    MT_WORKSPACE: join(root, 'repo'),
    MT_OWNER_OPEN_ID: OWNER.openId,
    LARK_APP_ID: 'cli_app',
    LARK_APP_SECRET: 'app-secret',
    MT_AGENT_COMMAND: process.execPath,
    MT_AGENT_ARGS: AGENT,
    MT_AGENT_DRIVER: 'structured-cli',
    MT_AGENT_UNSUPERVISED: 'true',
    MT_AGENT_ENV_FAKE_CLI_MODE: 'routing',
    MT_AGENT_ENV_FAKE_CLI_LOG: join(root, 'agent.log'),
  };
  writeFileSync(join(home, 'config.yaml'), 'kanban:\n  enabled: true\n');
  config = loadConfig(env);
  lark = new FakeChannel({ id: 'lark' });
  lines = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  vi.spyOn(LarkAdapter.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(LarkAdapter.prototype, 'disconnect').mockResolvedValue(undefined);
  vi.spyOn(LarkAdapter.prototype, 'botOpenId', 'get').mockReturnValue('ou_bot');
  vi.spyOn(LarkAdapter.prototype, 'raw', 'get').mockReturnValue({
    on: (h: typeof handlers) => {
      handlers = h;
      return () => {
        handlers = undefined;
      };
    },
  } as never);
  for (const method of CHANNEL_METHODS) {
    vi.spyOn(LarkAdapter.prototype as unknown as Channel, method).mockImplementation(((...args: unknown[]) =>
      (lark as unknown as Record<string, (...a: unknown[]) => unknown>)[method]?.apply(lark, args)) as never);
  }
});

afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
  vi.restoreAllMocks();
  clearSecrets();
  rmSync(root, { recursive: true, force: true });
});

async function start(): Promise<Gateway> {
  gateway = await createGateway(config, loadTeam(config, {}));
  await gateway.start();
  return gateway;
}

async function say(text: string): Promise<void> {
  if (handlers === undefined) throw new Error('the inbound side is not listening');
  await handlers.message({
    messageId: `om_routing_${++seq}`,
    chatId: 'oc_team',
    chatType: 'group',
    threadId: undefined,
    senderId: OWNER.openId,
    senderName: OWNER.name,
    content: text,
    mentionedBot: true,
    mentionAll: false,
    resources: [],
    createTime: Date.now(),
    raw: { sender: { sender_type: 'user', sender_id: { union_id: OWNER.unionId } }, message: { mentions: [{ key: '@_user_1', name: 'Bot', id: { open_id: 'ou_bot' } }] } },
  });
}

/** Wait for `ok`, polling, for up to about 90 s: a loaded machine starts the fake agent slowly. */
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 3600; i += 1) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`gave up waiting for ${what}`);
}

const texts = (): string => lark.texts.map((m) => m.text).join('\n');

function instanceId(): string {
  const id = /`(w_[0-9a-z]+)`/.exec(texts())?.[1];
  if (id === undefined) throw new Error('no instance started');
  return id;
}

const db = () => {
  if (gateway === undefined) throw new Error('no gateway');
  return gateway.db;
};
const steps = (id: string, step: string) => membersOf(db(), id).filter((m) => m.step === step);
const phase = (taskId: string) => (db().prepare('SELECT phase FROM kanban_tasks WHERE task_id = ?').get(taskId) as { phase: string } | undefined)?.phase;
const members = (id: string) => membersOf(db(), id).length;

describe('workflow routing through createGateway', () => {
  it('routes a vi-style instance from its intake to its report, a restart in the middle deciding nothing twice', { timeout: 180_000 }, async () => {
    await start();
    await say('/kanban workflow start vi-workflow case=CVE-2026-12345');
    const id = instanceId();
    expect(texts()).toContain(`6 more steps are made as results come: \`/kanban workflow show ${id}\` follows them.`);

    await until('the exposure items', () => steps(id, 'exposure').length === 3);
    const log = (): Array<{ title: string; answer: string }> => {
      try {
        return readFileSync(join(root, 'routing.log'), 'utf8')
          .split('\n')
          .filter((l) => l !== '')
          .map((l) => JSON.parse(l) as { title: string; answer: string });
      } catch {
        return [];
      }
    };
    // The agent writes its log once its report's answer is back, after the gateway made the items.
    await until("the intake's two reports", () => log().filter((l) => l.title === 'CVE-2026-12345 · intake').length === 2);
    const intake = log().filter((l) => l.title === 'CVE-2026-12345 · intake');
    expect(JSON.parse(intake[0]?.answer ?? '{}')).toEqual({ ok: false, code: 'invalid', message: 'output packages is missing' });
    expect(JSON.parse(intake[1]?.answer ?? '{}')).toMatchObject({ ok: true, phase: 'done' });
    await until('the intake notice', () => texts().includes('- ▶ exposure fanned out, 3 tasks: lodash, minimist, qs'));
    expect(texts()).toContain('- ⏭ verify skipped: intake.verify is false');
    expect(texts()).toContain('- ⏭ registry skipped: intake.bnpm is false');

    // A restart in the middle: nothing was due, so no reconciliation line, and nothing is made twice.
    const before = members(id);
    await gateway?.stop();
    lines.length = 0;
    await start();
    expect(lines.some((l) => l.includes('workflows: reconciled'))).toBe(false);
    expect(members(id)).toBe(before);

    await until('the instance to be done', () => {
      const row = db().prepare('SELECT 1 FROM kanban_workflow_settled WHERE instance_id = ? AND step = ? AND ref = ?').get(id, 'report', 'report');
      return row !== undefined && pendingOf(db(), id).every((p) => p.state !== 'waiting');
    });
    const va = steps(id, 'va')[0]?.taskId ?? '';
    const escalate = steps(id, 'escalate')[0]?.taskId ?? '';
    expect(phase(va)).toBe('archived');
    expect(commentsOf(db(), va).map((c) => c.body)).toContain(`Stood in for by escalate:1 (${escalate}), whose result is read in va's place.`);
    // The notifier sends on its own round, after the transaction that decided.
    await until('the stand-in notice', () => texts().includes(`- ✓ escalate stands in for va: reachable=true; \`${va}\` va archived`));
    const report = steps(id, 'report')[0]?.taskId ?? '';
    const items = steps(id, 'exposure').map((m) => m.taskId);
    // registry was skipped, so its effective parent, the intake, is linked in its place (workflow routing spec §3.2).
    const intakeTask = steps(id, 'intake')[0]?.taskId ?? '';
    expect(parentsOf(db(), report).map((p) => p.taskId).sort()).toEqual([...items, escalate, intakeTask].sort());
    expect(settledOf(db(), id).find((s) => s.step === 'report')).toMatchObject({ how: 'done', taskId: report });
    expect(pendingOf(db(), id).find((p) => p.step === 'patch')).toMatchObject({ state: 'skipped', reason: { by: 'when', why: 'intake.patch is false' } });
    expect(members(id)).toBe(7);
    await say(`/kanban workflow show ${id}`);
    expect(lark.texts.at(-1)?.text.split('\n')[0]).toBe(`**vi-workflow** \`${id}\`: done, 10 of 10 done`);
  });
});
```

- [ ] **Step 32.2: Run them.** Run `npx vitest run --project e2e tests/routing-gateway.e2e.ts`. Expected: `Tests  1 passed (1)`: this task adds tests only, of what Tasks 1 to 31 built, so they pass from the start.

- [ ] **Step 32.3: Run everything.** `npm run typecheck` reports no errors. `npx vitest run --project unit` gives `Tests  3754 passed (3754)`. `npx vitest run --project e2e` gives `Tests  188 passed (188)`.

- [ ] **Step 32.4: Commit.**

```bash
git add tests/fakes/cli-agent.mjs tests/routing-gateway.e2e.ts
git commit -m "Route a vi-style instance end to end through createGateway, a restart in the middle deciding nothing twice"
```

---
## Before relying on it: the smoke checklist

From §18, on a gateway of your own, not the live one:

1. Fold the real `vi-workflow`, `-verify`, `-patch`, `-verify-patch`, `vi-supplychain` and `-supplychain-bnpm` into one file as §1 does, with their bodies and gates whole, and run `mt workflow check vi-workflow`: `ok`, the step lines of §6.
2. Preview it in chat: one task now, and the pending steps and the handler with their words.
3. Start it for a CVE in the vi chat; the intake reports `verify: false`; see `verify` skipped in one notice in the thread, and `report` still waiting for `va`.
4. Report `packages` with 101 items: refused, the agent reports again; then three items: three exposure tasks, named in one notice.
5. Stop the gateway while an exposure runs; start it; no `workflows: reconciled …` line, as nothing was due, and the instance goes on; `mt kanban workflow reconcile w_…` answers `w_…: nothing was due`.
6. Make `va` give up: a role whose fake agent exits at once (`crashed`), or `max_runtime_s: 1`, with `failure_limit: 1`. `escalate` is routed; have it `mt kanban unblock` va once, va gives up again, `escalate:2` is made; its completion stands in, and `va` is archived with its comment.
7. Block an exposure item from chat, `/kanban task block k_… waiting on the vendor`: no handler, no routing notice.
8. Archive one exposure item mid-instance: the join goes on without it; `report` is not linked to it.
9. Edit the file mid-instance (remove `patch`): the running instance still decides `patch` from its plan; a new start has no `patch`.
10. `/kanban workflow show w_…` at each stage, against §12.1; `mt kanban workflow show w_… --plan`.
11. Start it again for a supply-chain CSV with `bnpm: true`: `va` and `verify` skipped, `registry` made, `report` joining `exposure` and `registry`; `escalate` never routed, no line, the instance `done`.
12. Start an old file, unchanged: the same DAG hash as before the build, no plan.
