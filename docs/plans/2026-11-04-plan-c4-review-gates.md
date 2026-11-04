# Plan C4 — Review, rework and gates: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task's gates decide whether it is done. An operator defines a task's gates; every report that would take it to done or to review — an agent's `mt kanban complete` or `review`, a reviewer's approval, a person's completion — first runs them in the task's workspace, as processes the gateway waits for without stopping, and is refused with the failing command, its exit and the end of its output while one fails. A gate whose command holds a known secret is refused when it is defined. When an agent reports, the gateway records the commit it reported on and whether the tree had uncommitted changes. A review run is given the handoff it reviews and what to review; a rework is given the reviewer's reason and the handoff it revises, and resumes the implementer's conversation only when it would run under the same instructions. A crash is printed masked. With `kanban.enabled` unset, nothing changes for chat but the way a crash is printed.

**Architecture:**
- **Defining gates** (`KanbanService.addGate`, `listGates`, `removeGate`; `db/kanban.ts` `addGate`, `removeGate`; `db/kanban-read.ts` `gatesOf`): an operator action, through the service. A command holding a known secret, in any form the shell would run it as, and gates past `GATE_LIMITS`, are refused; a gate is stored as written, with who defined it.
- **The `mt kanban gate` commands** (`src/cli/gate.ts`): `add`, `list` and `remove`, the operator's way in before plan D's chat command. They open the gateway's database and call the same service, beside a running gateway.
- **Reports are asynchronous** (`KanbanService.complete` and `requestReview`, `WorkerApi.handle` and `#act`): a gate is a process, awaited, so chat and other runs go on while a test suite runs.
- **The gate runner** (`src/kanban/gates.ts`): `runGates` runs a task's gates in order until one fails, masking each one's output before it keeps its end; `spawnGate` is the real runner, `/bin/sh -c` in its own process group; `gateEnv` is the agent allowlist plus the role's values, never a run's token or socket.
- **The reported commit** (`src/kanban/commit.ts`): `commitReader` reads `HEAD` and `git status --porcelain` asynchronously; `describeReported` says what a reviewer is to review.
- **A report's checks** (`KanbanService.#report`): the board's own checks first, without writing (`db/kanban.ts` `reportCheck`), so a report it would refuse runs nothing; then the commit, for an agent; then the gates, recorded as one `gates_ran` event (`recordGates`); then the transition, which checks again in its transaction. One report per task at a time, and no claim meanwhile.
- **The socket drains** (`src/kanban/socket.ts`): its handlers get an `AbortSignal`; `close()` aborts them, waits for their answers, and only then drops their connections.
- **The dispatcher waits for a report in flight** (`src/kanban/dispatcher.ts`): a turn that ends while its report runs the gates is neither nudged nor decided until the report is answered.
- **The rework's seed** (`db/kanban.ts` `recordRendering`): settled after the render, kept only for a work run given its role the same way.
- **The prompt** (`src/kanban/brief.ts`, `src/kanban/prompt.ts`, `db/kanban-read.ts`): the task's gates and their last run in the task section; for a review, the handoff it reviews; for a rework, the reviewer's reason and the previous handoff. `mt kanban show` gives the same.
- **The crash handler** (`src/crash.ts`, `src/main.ts`): an uncaught exception or unhandled rejection is printed through the masker, and the process exits 1.
- **Wiring** (`src/index.ts`, `src/cli/kanban.ts`): behind `kanban.enabled`, the service gets the workspaces' directories and the gateway's environment; `mt kanban` waits 15 minutes for an answer.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, better-sqlite3.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §3.3, §3.4, §5.3, §7.1, §7.7, §7.8, §8.3, §10, §10.1, §11 and the C4 row of §12, as amended in the same commit as this plan.

---

## Ground rules

- **Where to work.**
  - Use the worktree `/Users/x/Develop/manus/prime-gateway-work`, on branch `review-gates`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`: the live gateway runs there.
  - Never start the gateway, and never write to `~/.manus-team`.
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink.
  - Write plain-English commit messages: no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
  - The letters `p`,`g`,`w` in that order, in any case, must not appear in anything you write.
- **Secrets.** Never print secret values, and never print a run's token outside a test. Tests use made-up values only.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline.** `npm test` gives `Tests  1064 passed (1064)`. `npm run test:e2e` gives `Tests  53 passed (53)`. `npm run typecheck` reports no errors.
- **Finding edits.** Find each edit by its quoted text, not by line number. Every quoted text appears exactly once in its file at the point the step applies it. Apply a step's edits in the order given.
- **The secret registry is process-wide.** Every test file that adds secrets, or runs a dispatcher (which adds tokens), calls `clearSecrets()` in `beforeEach` and `afterEach`.
- **Tests use real SQLite** through `testDb()`, the real `SessionRegistry` and `SessionActor`, `FakeDriver` agents and a `ManualClock`. No mocks.
- **No real agent, no network, no real home.** No test runs bytesec or reaches the network. Sockets, homes and repositories are under fresh `mkdtemp` directories, realpath'd (on macOS `/tmp` is `/private/tmp`). No test reads `~/.manus-team`. Every git a test runs gets a made-up `HOME` and no `XDG_CONFIG_HOME`, so no user's git configuration is read: the tests' own setup calls pass that environment with `GIT_CONFIG_NOSYSTEM=1` too, and the reader under test gets `PATH` and the made-up `HOME` only. The gateway's reader passes its environment through `buildEnv`, which drops `GIT_CONFIG_NOSYSTEM`, so in production git may read the system's `/etc/gitconfig`, which is not the home. The `mt kanban gate` tests give `mt` a made-up `HOME` as well.
- **Unit tests start no process.** A gate and a commit read are processes, so the service takes its runner and its git as injectable functions (`ReportChecks.runGate`, `ReportChecks.readCommit`): the unit tests pass ones that start nothing, and the real ones are tested end to end (`tests/kanban-gates.e2e.ts`, `tests/kanban-commit.e2e.ts`, `tests/kanban-worker.e2e.ts`). So is the crash handler (`tests/crash.e2e.ts`).
- **Never `spawnSync` anything the gateway waits on.** A gate, a git read and `mt kanban` against this process's socket are all spawned asynchronously: a blocked event loop would freeze chat, or never answer.
- **The import guard.** `tests/kanban-service.test.ts` checks that only `src/kanban/service.ts` imports `src/db/kanban.js`. The prompt and the worker API read through `db/kanban-read.js`.

## Decisions the spec left open

Each is the reading most consistent with the rest of the spec. Decisions 1, 3, 11 and 12 change what an operator or an agent sees, and the user has decided them: Decision 1 as changed to `mt` commands and the service, the others as proposed. Decisions 1–14 and 16 are now in the spec (§3.3, §3.4, §5.3, §7.1, §7.7, §7.8, §10, §10.1), amended in the same commit as this plan.

1. **Operators define gates with `mt kanban gate`, and through the service.** *The user's decision.* `KanbanService.addGate(taskId, { command, timeoutS? }, by)`, `listGates(taskId)` and `removeGate(taskId, gateId, by)` are the board's operations; plan D's `/kanban gate`, with operator tier, will call them, and so do three `mt` commands now:
   - `mt kanban gate add <task_id> [--timeout <s>] -- <command…>`: the words after the task id are the command, joined with spaces as `ssh` joins them, so a command with its own quoting is passed quoted, as one word;
   - `mt kanban gate list <task_id>`: id, timeout, who defined it, command;
   - `mt kanban gate remove <task_id> <gate_id>`: removal is new, with a `gate_removed` event.

   **How they reach the service.** They are operator commands, not worker commands: the socket only takes run tokens, and these do not use it. Each loads the settings and the team as `mt role check` does (`loadTeamSettings`, then `loadTeam`, with `passEnv` names unset in the shell collected rather than refused), opens the gateway's database at the settings' `dbPath` with `openDb` — never migrating it, and refusing a missing database or one with no board yet — and calls the service over it. `src/kanban/service.ts` stays the only importer of `db/kanban.js`; the CLI is a second process using the same module. SQLite in WAL mode lets the two processes share the file: the gateway's reads never wait on the CLI's write, and a write that meets the other's lock waits (`busy_timeout`) and retries (`txImmediate`), as the gateway's own writers do. `tests/mt-gate.test.ts` opens the database twice to show both; a write that never gets the lock is refused as "the board is busy … try again", having written nothing.

   **The secrets they check.** The masker's registry is per process, so the CLI fills it as the gateway does, from what its shell can know: every role's environment values (`teamSecrets`, which `registerConfiguredSecrets` now uses too) and the Lark app secret when `LARK_APP_SECRET` is set — the gateway reads it from its environment only, never the file. A `passEnv` name unset in the shell is named on stderr as unchecked. Every other rule is the service's: the forms of Decision 2, the limits, the task's phase.

   **Who defined it** is `operator:<login>`, the OS user's name (`os.userInfo()`, else `USER`). The shell cannot say which person typed the command, only which account ran it, and on a gateway host that account is the operator's; the `operator:` prefix keeps it apart from chat's `lark:` principals and a run's `run:`.

   **The accident guard.** They refuse, exit 1, when `MT_KANBAN_RUN` or `MT_KANBAN_TOKEN` is set: "mt kanban gate add is an operator's command, not a board run's: …". It keeps an agent from defining gates by mistake. It is not a security boundary: every agent runs as the operator's user, and could unset the variables, as it could already edit `config.yaml` or a role's files. The README and spec §2.6 say so. Exit codes are `mt`'s: 0 done, 1 refused, 2 a wrong command line.

   Gates in the config file were rejected: a different model from the spec's per-task gates, in `kanban_gates`.
2. **What a gate may be** (`GATE_LIMITS`, in `src/kanban/types.ts`):
   - a command of non-empty text, at most 4 KiB, with no NUL;
   - a timeout, `timeout_s`, of 1 to 600 s, 300 when not given, as the schema's default;
   - at most 20 gates on a task, taking at most 600 s together;
   - only on a task that is not done or archived, where nothing would run it;
   - never a command that holds a known secret (spec §10.1) — as written, with its control characters stripped, as the escapers match it, or with the shell's quotes and backslashes taken out, so `sk\$x` and `'sk''x'`, which the shell runs as the secret, count too. It is refused, and not echoed, with: "the gate's command holds a known secret, and a gate is stored and run as written; pass the value through the agent's environment instead -- the role's .env, or agent.passEnv -- and name it in the command, as $NAME". A gate runs with its role's environment (Decision 8), so `$NAME` finds it.

   The command is stored as written, never masked (spec §10.1), with `created_by` and a `gate_added` event. The limits are checked inside the insert's transaction, so two operators adding at once cannot pass them.
3. **The timeouts.** *To confirm.* A gate runs for at most 600 s, 300 when its definition gives none, as the schema's default; a task's gates for at most 600 s together; and `mt kanban` waits 15 minutes for an answer, up from C3's 10, so a report's answer outlasts its gates and the commit read with minutes to spare. The prompt tells the agent how long its task's gates may take together, so it can give the command that long (Decision 14).
4. **Reports are asynchronous.** `KanbanService.complete` and `requestReview` return promises, and so do `WorkerApi.handle` and `#act`. The callers await them: the worker API, and the tests. Nothing else in `src` calls them before plan D. No gate, git read or report blocks the event loop.
5. **A report's checks run in this order** (`KanbanService.#report`):
   1. the input's shape, as before;
   2. no other report on the task running its gates (`report_in_progress`, Decision 6);
   3. the board's own checks, without writing (`db/kanban.ts` `reportCheck`, the checks `complete` and `requestReview` make): so a second report, a person's while an agent works, or a review with nobody to review runs no gate and reads no commit;
   4. the reported commit, for an agent's report (Decision 11);
   5. the gates, if the task has any;
   6. the transition, which checks everything again in its own transaction. A run decided while the gates ran — a sweep's `timed_out`, a supersession — is refused as any decided run is (`run_superseded`); the gate run is recorded all the same.
6. **One report per task at a time, and nothing new in its checkout meanwhile.** While a report's checks run:
   - a second report on the task is refused, `report_in_progress`, "task … is being reported on already, and its gates are running; wait for that answer, or see mt kanban show": an agent retrying after a lost answer would otherwise run the same gates twice at once in one checkout;
   - `claim` refuses the task, and any other task whose workspace is the report's, as `not_claimable`: the dispatcher would otherwise start an agent in a checkout whose tests are running — after a person's completion of a ready task, say;
   - the dispatcher does not follow up or decide a run of the task whose turn has ended (`KanbanService.settled`, Task 7). An agent's shell may give up on `mt kanban` while the gates run, and the agent end its turn; the report may yet decide the run, and the run holds the workspace the gates run in.

   The map is the service's, in memory: there is one service per gateway.
7. **How a gate runs** (`spawnGate`):
   - `/bin/sh -c <command>`, in the task's workspace, in its own process group, with stdin closed and stdout and stderr read together, keeping their last 64 KiB;
   - past its timeout, SIGTERM to the group, and SIGKILL two seconds later;
   - once the shell has exited, its timeout is cleared — it ended in time, and what follows is not its own running past it — and whatever it left in its group is killed, so a background process holding the output open cannot keep the report waiting; one that left the group is let go of a second later, its output with it;
   - one that cannot start, a missing directory say, is a failed gate: "the gate could not start: …";
   - every running gate's group is killed on the process's `exit`, a crash's included, so none is left changing a checkout the next boot hands to an agent.

   `runGates` runs a task's gates in the order they were defined, stops at the first that fails, and says how many it did not run. A gate's output is masked, then cut to its last 4 KiB (`GATE_OUTPUT_BYTES`), so a cut cannot leave the start of a secret showing.
8. **A gate's environment, workspace and role** (spec §7.7):
   - the environment is `buildEnv`'s allowlist of the gateway's own (`PATH`, `HOME` and the like, as every agent gets) plus the role's `agent.env` — its base environment, `.env` and `passEnv` values — with anything named `MT_KANBAN_*` removed (`gateEnv`). Never the gateway's own environment, and never built from `Dispatcher.envFor`, which holds the run's token and socket (C3's note);
   - the role is that of the task's latest agent run by attempt, the reporting run's if it is an agent's, else `default`; one no longer configured refuses the report, `gates_cannot_run`;
   - the workspace is the task's: a null one refuses with "… has gates and no workspace to run them in; set its workspace first", one no longer configured with its name. A task with no gates needs neither, so a person's task without a workspace still completes.
   - a workspace directory that is gone refuses the report with "task …'s workspace directory … does not exist", rather than leave the runner to fail on `/bin/sh` (`ReportChecks.isDirectory`, the filesystem by default with the real runner);
   - A service built without `checks` — the board's own tests — runs no gates: a task that has some cannot complete there, "… has gates, and this gateway runs none".
9. **Each run of a task's gates is one `gates_ran` event**, for spec §7.7's "each gate run is recorded as an event": one per report that ran them, with every result — command, exit code, signal, whether it timed out, its duration and its output — passed or not, stopped or not, and how many did not run. Its actor is the reporter, `run:<id>` or a person. Its string values are masked on write, as every payload is. `lastGateRun` reads the latest, for the prompt and `mt kanban show`.
10. **The refusal.** `gate_failed`: "gate "npm test" exited 1; the report was not applied: fix it and report again" — or "ran past its 120 s", "was ended by SIGTERM", "could not start". `Refusal` gains an optional `gate` with the command, exit code, signal, whether it timed out, and the output; the worker API answers it as `gate: { command, exit_code, signal, timed_out, output }`. `gates_cannot_run` covers the cases of Decision 8 and the gateway stopping (Decision 13). The run stays undecided either way.
11. **The gateway reads the reported commit itself.** *To confirm.* For an agent's `complete` or `review`, of either run kind, the service runs, in the run's workspace, `git rev-parse --verify --quiet HEAD^{commit}` and then `git --no-optional-locks status --porcelain`, each asynchronously, within 10 s, with only `buildEnv`'s allowlist of the gateway's environment and with `-c core.fsmonitor=false`, so a workspace's own configuration cannot make `git status` run a program, and before the gates, so a build a gate makes cannot make the tree look changed.
    - A whole commit id is `reported_commit`; a non-empty status, or a status that failed, makes `reported_dirty` true.
    - No `HEAD` — not a repository, no commit yet, git missing or failing — stores no commit and `reported_dirty` true. That is spec §7.8's "uncommitted; no commit to review", kept apart from both columns null, which is a report that recorded nothing: a person's, or one from before C4.
    - A person's report reads nothing. The service's check of a commit a caller passes in the handoff stays; one the gateway read replaces it.
    - `describeReported` gives spec §7.8's wording, with the whole commit id, for an agent reviewer to `git diff` against.
12. **The rework's seed is settled after the render.** *To confirm.* C1's claim chooses a seed from the agent alone — driver, command and arguments, and a provider session the work run observed — before the rework's role is rendered (plan R), so the claim cannot know the rework's package hash. `recordRendering`, which the dispatcher calls once the render is decided and before it creates the session, now keeps the seed only if the work run was given its role the same way: both native from the same package, or both in the prompt. A work run from before plan R recorded neither key, and counts as not native. Otherwise it sets `seeded_from_run` null and records `seedDropped: <run id>` in its `run_rendered` event; the dispatcher seeds the session from the run as `recordRendering` returns it. A `role.md` edited between the two runs gives the rework a new package, and so a fresh conversation, with the reviewer's reason and the previous handoff in its prompt (Decision 14). Comparing at the claim against the package the role would render to now was rejected: the service would need to know the render's layout, which plan R kept in the dispatcher. A refused `recordRendering`, which only a bug causes, leaves the claim's seed.
13. **The socket drains when it closes.** C3's `close()` dropped every connection, so a report could be applied while its client saw `unreachable`, and the retry the protocol asks for would get `already_reported`. Now:
    - `listenWorker`'s handler is given an `AbortSignal`, which `close()` aborts;
    - `close()` stops listening, drops every connection that has not sent a request, aborts the signal, waits up to 10 s (`drainMs`) for the requests being handled to be answered, then drops whatever is left, noting how many went unanswered;
    - a report whose gates are running when the gateway stops has them killed, applies nothing, and answers `gates_cannot_run`, "the gateway is stopping, so the gates did not finish and the report was not applied; report again once it is back".

    - the gateway's `stop()` closes the socket before it drains the dispatcher: the drain waits for a report in flight (Decision 6), and closing the socket is what stops it. A dispatcher that was stopped while it waited decides nothing; the next boot ends the run.

    The agent dies with the gateway anyway; what matters is that no client is left believing a report failed that was applied.
14. **The prompt's new sections** (spec §7.1):
    - **in the task section**, the task's gates, one line each, flattened and with their timeouts, and how long a report may wait for them together; then the last gate run: whom it was for, whether it passed, each gate's verdict, and a failing gate's output, its last 2 KiB, indented under it as data;
    - **for a review run**, `## For your review`: the implementer's handoff — summary, metadata, and what to review (Decision 11) — after the attempts and before the comments. The review protocol now says the handoff is "under For your review", not "in the earlier attempts";
    - **for a rework**, `## Changes requested`: who asked, the reason, and the previous handoff with its state.

    The reason is read from the `changes_requested` event, which holds it whether a review run or a person asked (C1 Decision 7). A work run is a rework while the latest of the task's `review_requested` and `changes_requested` events is a `changes_requested`, so a retry of a rework is still told why. The previous handoff is the latest `review_requested` event's: the asking run's summary, metadata and reported state, or a person's summary from the event. Both sections are bounded by the pieces' caps (a reason as a summary, 4 KiB) and sized before the attempts, so they are never cut out.
15. **`mt kanban show` gives the same**: `gates`, `last_gate_run`, `review`, `rework`, and each attempt's `reported_commit` and `reported_dirty`, in snake_case, uncut.
16. **The crash handler** (`src/crash.ts`): `installCrashHandlers()` is the first thing `src/main.ts` does, so it covers startup too. On `uncaughtException` and `unhandledRejection` it writes one line, "uncaught exception: …" or "unhandled rejection: …", with the error as `util.inspect` shows it — the stack and the error's own fields, as Node would — masked, then exits 1, the code Node uses for both. It drains and closes nothing: the process's state is unknown, and the next boot reconciles (spec §8.4). It changes only what a crash prints, for chat as for the board. Two things change with it, deliberately: the line drops Node's own frame showing the source line and its `Node.js vXX` footer, and the handler overrides `--unhandled-rejections=warn` or `none`, so an unhandled rejection always ends the process.
17. **No new settings.** The limits are constants, and `kanban.enabled` stays off. A report's checks are wired behind it, with the rest of the board, so merging C4 changes nothing for chat but the crash's line.

## Out of scope (later plans)

- **Plan D:**
  - `/kanban gate`, with operator tier, calling the same `addGate`, `listGates` and `removeGate` as `mt kanban gate`;
  - a person's `/kanban done`, `/kanban approve` and Done button through `complete`, showing a gate refusal's `gate` in chat, through the escapers;
  - the review card's "review commit …", from `describeReported`;
  - `dispatcher.pass()` after a person's successful report.
- **Plan E:** resuming a run natively by the same rule as the rework's seed: read `native` and `packageHash` from `agent_config`, as `recordRendering` now does.
- **Isolating gates from the network:** not done, deliberately (spec §7.7, §15).
- **Worktrees** (architecture milestone 9): a person's approval still runs gates against whatever the checkout holds (spec §6.3).

### Known limitations, not fixed here

- An agent whose shell tool kills `mt kanban` before its gates finish — some agents bound a command to a few minutes — never hears the answer. The report is still applied if they pass. Its retry gets `report_in_progress` while they run, and `already_reported` after; `mt kanban show` has the last gate run.
- A gate's process group is killed when the gateway exits, a crash included, but not when the gateway is killed with SIGKILL: it then runs on, detached, until it ends.
- A process a gate starts in a new session or process group escapes every kill; the report stops waiting for it a second after the gate's shell exits.
- The task cannot be claimed while a report's gates run, and nothing passes again when they finish without the report going through; the next sweep claims it.
- A claim is held back from a workspace whose gates are running only when the claimed task's workspace is already set. One whose workspace is still null, and resolves to that one at the claim, is not.
- A runtime limit can still end a run `timed_out` while its report's gates run; the report is then refused as `run_superseded`.
- A person's approval runs the gates against the checkout as it is now, which another agent may have changed since (spec §6.3).
- In production, git reads the gateway user's own git configuration, through `HOME`.
- A workspace's clean filters still run on `git status`, as the gateway's user with the allowlisted environment: no more than the agent itself could do.
- Some agents' shell tools cap a command at about 10 minutes — Claude Code's Bash tool, for example — which equals `totalTimeoutS`. A task at the full gate cap can outlast such a tool's wait; the report still lands, and the agent can see it in `mt kanban show`. The user kept the 600 s limit.
- `mt kanban gate add` checks only the secrets its shell can know: a `passEnv` value set for the gateway's service and not in this shell, or a Lark app secret not exported here, is not caught. It says which names it could not check.

### What later plans need

- **D:** `addGate` and `removeGate` take the operator's principal as `by`, and the operator-tier check is D's. A refusal's `gate` holds stored text: show it through the escapers. `describeReported(run)` is the card's line. `complete` and `requestReview` are asynchronous: await them, without a signal.
- **E:** seed a resume from `recordRendering`'s rule, or move the rule into a function both use.

## File structure

| File | Responsibility |
|---|---|
| `src/kanban/types.ts` (modify) | `GateRow`, `GATE_LIMITS`, `FailedGate`, `Refusal.gate`, the new refusal codes |
| `src/db/kanban-read.ts` (modify) | `gatesOf`, `lastGateRun`, `latestReviewRequest`, `changesAsked` |
| `src/db/kanban.ts` (modify) | `addGate`, `removeGate`, `reportCheck`, `recordGates`; `recordRendering` settles the seed |
| `src/db/WRITERS.md` (modify) | `kanban_gates`'s writer |
| `src/kanban/gates.ts` (create) | `runGates`, `spawnGate`, `gateEnv` |
| `src/kanban/commit.ts` (create) | `commitReader`, `execGit`, `describeReported` |
| `src/kanban/service.ts` (modify) | `addGate`, `listGates`, `removeGate`; asynchronous `complete` and `requestReview`, with their checks; `ReportChecks` |
| `src/kanban/worker.ts` (modify) | asynchronous `handle`; the signal; a refusal's `gate`; `show`'s new fields |
| `src/kanban/socket.ts` (modify) | the handler's signal; draining on close |
| `src/kanban/dispatcher.ts` (modify) | waiting for a report in flight; the session seeded from the run as `recordRendering` left it |
| `src/kanban/brief.ts`, `src/kanban/prompt.ts` (modify) | gates, their last run, the review's handoff, the rework's reason |
| `src/crash.ts` (create), `src/main.ts` (modify) | the masked crash handler |
| `src/index.ts` (modify) | the service's checks; the socket's signal; closing the socket before the dispatcher's drain |
| `src/team.ts` (modify) | `teamSecrets` |
| `src/cli/kanban.ts` (modify) | the 15-minute wait |
| `src/cli/gate.ts` (create), `src/cli/mt.ts` (modify) | `mt kanban gate add`, `list` and `remove` |
| `README.md` (modify) | gates, the gate commands and the reported commit |
| `tests/fakes/cli-agent.mjs` (modify) | the `kanban-gated` mode |
| `tests/helpers/dispatch.ts` (modify) | `reportComplete` asynchronous; `holds`' `first` awaited; `checks` |
| `tests/kanban-gates.test.ts`, `tests/kanban-commit.test.ts`, `tests/kanban-report-checks.test.ts`, `tests/kanban-dispatch-gates.test.ts`, `tests/mt-gate.test.ts`, `tests/crash.test.ts`, `tests/kanban-gates.e2e.ts`, `tests/kanban-commit.e2e.ts`, `tests/crash.e2e.ts` (create) | |
| `tests/kanban-service.test.ts`, `tests/kanban-worker.test.ts`, `tests/kanban-socket.test.ts`, `tests/kanban-rendering.test.ts`, `tests/kanban-dispatch-native.test.ts`, `tests/kanban-prompt.test.ts`, `tests/kanban-brief.test.ts`, `tests/mt-kanban.test.ts`, `tests/kanban-dispatcher.test.ts`, `tests/kanban-dispatch-sweep.test.ts`, `tests/kanban-dispatch-failure.test.ts`, `tests/kanban-dispatch-restart.test.ts`, `tests/kanban-token.test.ts`, `tests/kanban-nudge.test.ts`, `tests/kanban-worker.e2e.ts` (modify) | |

Running counts, unit then end to end: Task 1 1071 / 53, Task 2 1073, Task 3 1078 / 61, Task 4 1082 / 64, Task 5 1097, Task 6 1100, Task 7 1102, Task 8 1105, Task 9 1114, Task 10 1118 / 66, Task 11 1119, Task 12 1127, Task 13 1127 / 67, Task 14 1127; after the review follow-ups, 1144 / 69.

---

### Task 1: Defining a task's gates

**Files:**
- Create: `tests/kanban-gates.test.ts`
- Modify: `src/db/WRITERS.md`, `src/db/kanban-read.ts`, `src/db/kanban.ts`, `src/kanban/service.ts`, `src/kanban/types.ts`

Gates are an operator's (spec §7.7, §10; Decision 1), defined through the service, the one way in until plan D. `kanban_gates` exists since migration 003 and has had no writer: `db/kanban.ts` gains `addGate`, which checks the count and the timeouts together inside its transaction, and `db/kanban-read.ts` gains `gatesOf`. The service checks the command first: text, at most 4 KiB, no NUL, a timeout from 1 to 600 s, and no known secret, in the forms the shell would run it as (spec §10.1; Decisions 2 and 3). `listGates` and `removeGate` complete the operator's set; removing writes a `gate_removed` event.

- [ ] **Step 1.1: Write the failing tests.**

Create `tests/kanban-gates.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventsOf, gatesOf } from '../src/db/kanban-read.js';
import { KanbanService } from '../src/kanban/service.js';
import { GATE_LIMITS, type TaskRow } from '../src/kanban/types.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * Defining a task's gates (spec §7.7, §10, §10.1): an operator action, through
 * the service, stored as written with who defined it.
 */

let t: TestDb;
let s: KanbanService;

beforeEach(() => {
  clearSecrets();
  t = testDb();
  s = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
  });
});
afterEach(() => {
  clearSecrets();
  t.close();
});

function task(): TaskRow {
  const r = s.create({ title: 'a task', assignee: 'implementer', workspace: 'web', createdBy: ALICE, createdVia: VIA });
  if (!r.ok) throw new Error(r.message);
  return r.task;
}

function count(): number {
  return t.db.prepare<[], { n: number }>('SELECT count(*) AS n FROM kanban_gates').get()?.n ?? 0;
}

describe('defining gates', () => {
  it('stores a gate as written, with who defined it, in order, and records it', () => {
    const k = task();
    const first = s.addGate(k.taskId, { command: "npm test -- --grep 'parser'" }, ALICE);
    const second = s.addGate(k.taskId, { command: 'npm run lint', timeoutS: 60 }, 'lark:on_bob');
    expect(first).toMatchObject({ ok: true, gate: { command: "npm test -- --grep 'parser'", timeoutS: 300 } });
    expect(second).toMatchObject({ ok: true });
    expect(gatesOf(t.db, k.taskId)).toEqual([
      expect.objectContaining({ taskId: k.taskId, command: "npm test -- --grep 'parser'", timeoutS: 300, createdBy: ALICE }),
      expect.objectContaining({ command: 'npm run lint', timeoutS: 60, createdBy: 'lark:on_bob' }),
    ]);
    const added = eventsOf(t.db, k.taskId).filter((e) => e.kind === 'gate_added');
    expect(added.map((e) => [e.actor, e.payload])).toEqual([
      [ALICE, { gateId: first.ok ? first.gate.id : 0, command: "npm test -- --grep 'parser'", timeoutS: 300 }],
      ['lark:on_bob', { gateId: second.ok ? second.gate.id : 0, command: 'npm run lint', timeoutS: 60 }],
    ]);
  });

  it('refuses a command holding a known secret, saying where the value belongs, and stores nothing', () => {
    addSecrets(['sk-live-1234567890']);
    const k = task();
    const r = s.addGate(k.taskId, { command: 'curl -H "Authorization: sk-live-1234567890" https://ci' }, ALICE);
    expect(r).toEqual({
      ok: false,
      code: 'invalid',
      message:
        "the gate's command holds a known secret, and a gate is stored and run as written; " +
        "pass the value through the agent's environment instead -- the role's .env, or agent.passEnv -- " +
        'and name it in the command, as $NAME',
    });
    expect(count()).toBe(0);
    expect(eventsOf(t.db, k.taskId).map((e) => e.kind)).toEqual(['created']);
  });

  it('refuses a known secret the shell would run, written escaped, quoted apart or with a control character', () => {
    addSecrets(['sk-live-1234$567890']);
    const k = task();
    for (const command of [
      'curl -H "k: sk-live-1234\\$567890" https://ci',
      "curl -H 'k: sk-live-1234''$567890' https://ci",
      'curl -H "k: sk-live-1234\u0007$567890" https://ci',
    ]) {
      expect(s.addGate(k.taskId, { command }, ALICE)).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(count()).toBe(0);
  });

  it('lists and removes a gate, recording who removed it', () => {
    const k = task();
    const first = s.addGate(k.taskId, { command: 'npm test' }, ALICE);
    const second = s.addGate(k.taskId, { command: 'npm run lint' }, ALICE);
    if (!first.ok || !second.ok) throw new Error('not added');
    expect(s.listGates(k.taskId)).toMatchObject({ ok: true, gates: [{ command: 'npm test' }, { command: 'npm run lint' }] });
    expect(s.removeGate(k.taskId, first.gate.id, 'operator:alice')).toMatchObject({ ok: true, gate: { command: 'npm test' } });
    expect(s.listGates(k.taskId)).toMatchObject({ ok: true, gates: [{ command: 'npm run lint' }] });
    expect(eventsOf(t.db, k.taskId).at(-1)).toMatchObject({
      kind: 'gate_removed',
      actor: 'operator:alice',
      payload: { gateId: first.gate.id, command: 'npm test' },
    });
    expect(s.removeGate(k.taskId, first.gate.id, ALICE)).toEqual({
      ok: false,
      code: 'not_found',
      message: `task ${k.taskId} has no gate ${first.gate.id}`,
    });
    expect(s.removeGate(k.taskId, 0, ALICE)).toMatchObject({ ok: false, code: 'invalid' });
    expect(s.listGates('k_missing')).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('refuses what is not a gate, and writes nothing', () => {
    const k = task();
    const bad = (v: unknown): never => v as never;
    const cases: Array<[string, () => unknown]> = [
      ['a number', () => s.addGate(k.taskId, { command: bad(3) }, ALICE)],
      ['blank', () => s.addGate(k.taskId, { command: '  ' }, ALICE)],
      ['no gate', () => s.addGate(k.taskId, bad(null), ALICE)],
      ['a NUL', () => s.addGate(k.taskId, { command: 'true\0false' }, ALICE)],
      ['too large', () => s.addGate(k.taskId, { command: 'x'.repeat(GATE_LIMITS.commandBytes + 1) }, ALICE)],
      ['timeout 0', () => s.addGate(k.taskId, { command: 'true', timeoutS: 0 }, ALICE)],
      ['timeout over the most', () => s.addGate(k.taskId, { command: 'true', timeoutS: GATE_LIMITS.maxTimeoutS + 1 }, ALICE)],
      ['timeout a fraction', () => s.addGate(k.taskId, { command: 'true', timeoutS: 1.5 }, ALICE)],
      ['timeout text', () => s.addGate(k.taskId, { command: 'true', timeoutS: bad('300') }, ALICE)],
      ['by a number', () => s.addGate(k.taskId, { command: 'true' }, bad(3))],
      ['task id an object', () => s.addGate(bad({}), { command: 'true' }, ALICE)],
    ];
    for (const [what, call] of cases) expect([what, call()]).toEqual([what, expect.objectContaining({ ok: false, code: 'invalid' })]);
    expect(count()).toBe(0);
  });

  it('refuses a gate on a task that is archived, or missing', () => {
    const gone = task();
    expect(s.archive(gone.taskId, ALICE).ok).toBe(true);
    expect(s.addGate(gone.taskId, { command: 'true' }, ALICE)).toEqual({
      ok: false,
      code: 'illegal_transition',
      message: `task ${gone.taskId} is archived; a gate on it would never run`,
    });
    expect(s.addGate('k_missing', { command: 'true' }, ALICE)).toMatchObject({ ok: false, code: 'not_found' });
    expect(count()).toBe(0);
  });

  it('refuses gates past the most a task may have, and past their time together', () => {
    const k = task();
    expect(s.addGate(k.taskId, { command: 'npm test' }, ALICE).ok).toBe(true);
    expect(s.addGate(k.taskId, { command: 'npm run e2e' }, ALICE).ok).toBe(true);
    expect(s.addGate(k.taskId, { command: 'true', timeoutS: 1 }, ALICE)).toEqual({
      ok: false,
      code: 'invalid',
      message: `task ${k.taskId}'s gates would take up to 601 s together; at most 600 s, since a report waits for them`,
    });
    const many = task();
    for (let i = 0; i < GATE_LIMITS.perTask; i += 1) {
      expect(s.addGate(many.taskId, { command: `check ${i}`, timeoutS: 30 }, ALICE).ok).toBe(true);
    }
    expect(s.addGate(many.taskId, { command: 'one more', timeoutS: 1 }, ALICE)).toMatchObject({
      ok: false,
      message: `task ${many.taskId} has 20 gates, the most a task may have`,
    });
  });
});
```

- [ ] **Step 1.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-gates.test.ts`. Expected: all seven FAIL, with `TypeError: s.addGate is not a function`. `Tests  7 failed (7)`.

- [ ] **Step 1.3: Implement.**

In `src/db/WRITERS.md`, replace:

```md
| `kanban_comments` | `db/kanban.ts` | Rows are added, never updated. |
| `kanban_events` | `db/kanban.ts` | Append-only, written in the transaction of the change it records. String values in `payload` are masked on write (spec §10.1). |
| `kanban_gates`, `kanban_subscriptions` | `db/kanban.ts` | No writer until plans C4 (gates) and D (subscriptions); they add their functions to `db/kanban.ts`. |
| `schema_version`, `user_version` | `db/open.ts` (`migrate`) | Migration files own the `schema_version` row contents; the runner owns `user_version`. |

```

with:

```md
| `kanban_comments` | `db/kanban.ts` | Rows are added, never updated. |
| `kanban_events` | `db/kanban.ts` | Append-only, written in the transaction of the change it records. String values in `payload` are masked on write (spec §10.1). |
| `kanban_gates` | `db/kanban.ts` | Added by `addGate` and deleted by `removeGate`, never updated: the command is stored as written, never masked (spec §10.1). The gateway and the `mt kanban gate` commands both write it, each through `KanbanService`. |
| `kanban_subscriptions` | `db/kanban.ts` | No writer until plan D, which adds its functions to `db/kanban.ts`. |
| `schema_version`, `user_version` | `db/open.ts` (`migrate`) | Migration files own the `schema_version` row contents; the runner owns `user_version`. |

```

In `src/db/kanban-read.ts`, replace:

```ts
  Contract,
  CreatedVia,
  KanbanEvent,
  Phase,
```

with:

```ts
  Contract,
  CreatedVia,
  GateRow,
  KanbanEvent,
  Phase,
```

In `src/db/kanban-read.ts`, replace:

```ts
}

export function eventsOf(db: Db, taskId: string): KanbanEvent[] {
  return db
```

with:

```ts
}

interface GateRaw {
  id: number;
  task_id: string;
  command: string;
  timeout_s: number;
  created_by: string;
  created_at: number;
}

/** The task's gates, in the order they were defined: the order they run in (spec §7.7). */
export function gatesOf(db: Db, taskId: string): GateRow[] {
  return db
    .prepare<[string], GateRaw>(
      'SELECT id, task_id, command, timeout_s, created_by, created_at FROM kanban_gates WHERE task_id = ? ORDER BY id',
    )
    .all(taskId)
    .map((r) => ({
      id: r.id,
      taskId: r.task_id,
      command: r.command,
      timeoutS: r.timeout_s,
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
}

export function eventsOf(db: Db, taskId: string): KanbanEvent[] {
  return db
```

In `src/db/kanban.ts`, replace:

```ts
import { redactKnownSecrets, redactValues } from '../secrets.js';
import { resolveTaskWorkspace } from '../kanban/workspace.js';
import { ENDED_OUTCOMES, REPORTED_OUTCOMES } from '../kanban/types.js';
import type {
  ActivePhase,
```

with:

```ts
import { redactKnownSecrets, redactValues } from '../secrets.js';
import { resolveTaskWorkspace } from '../kanban/workspace.js';
import { ENDED_OUTCOMES, GATE_LIMITS, REPORTED_OUTCOMES } from '../kanban/types.js';
import type {
  ActivePhase,
```

In `src/db/kanban.ts`, replace:

```ts
  CreatedVia,
  EndedOutcome,
  Phase,
  Refusal,
```

with:

```ts
  CreatedVia,
  EndedOutcome,
  GateRow,
  Phase,
  Refusal,
```

In `src/db/kanban.ts`, replace:

```ts
  getTask,
  getTaskByKey,
  isFinished,
  openAgentRunIn,
```

with:

```ts
  getTask,
  getTaskByKey,
  gatesOf,
  isFinished,
  openAgentRunIn,
```

In `src/db/kanban.ts`, replace:

```ts
  record(d, { taskId, kind: 'commented', actor: author, payload: { body } }, now);
  return { id: Number(lastInsertRowid), taskId, author, body: masked, createdAt: now };
}

```

with:

```ts
  record(d, { taskId, kind: 'commented', actor: author, payload: { body } }, now);
  return { id: Number(lastInsertRowid), taskId, author, body: masked, createdAt: now };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * Define a gate on a task (spec §7.7), for an operator: the service has checked
 * the command. Refused on a task that is done or archived, where nothing will
 * run it, and past GATE_LIMITS -- the count, and the timeouts together, checked
 * here, inside the transaction, so two operators adding at once cannot pass them.
 *
 * The command is stored as written: never masked, since a masked command would
 * run broken (spec §10.1). Its event carries it, masked as every payload is,
 * which changes nothing for a command the service let through.
 */
export function addGate(
  db: Db,
  taskId: string,
  gate: { command: string; timeoutS: number },
  by: string,
  now: number,
): Result<{ gate: GateRow }> {
  return tx(db, (d) => {
    const task = getTask(d, taskId);
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    if (task.phase === 'done' || task.phase === 'archived') {
      return refuse('illegal_transition', `task ${taskId} is ${task.phase}; a gate on it would never run`);
    }
    const gates = gatesOf(d, taskId);
    if (gates.length >= GATE_LIMITS.perTask) {
      return refuse('invalid', `task ${taskId} has ${gates.length} gates, the most a task may have`);
    }
    const total = gates.reduce((sum, g) => sum + g.timeoutS, 0) + gate.timeoutS;
    if (total > GATE_LIMITS.totalTimeoutS) {
      return refuse(
        'invalid',
        `task ${taskId}'s gates would take up to ${total} s together; at most ${GATE_LIMITS.totalTimeoutS} s, ` +
          'since a report waits for them',
      );
    }
    const { lastInsertRowid } = d
      .prepare('INSERT INTO kanban_gates (task_id, command, timeout_s, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, gate.command, gate.timeoutS, by, now);
    const id = Number(lastInsertRowid);
    record(
      d,
      { taskId, kind: 'gate_added', actor: by, payload: { gateId: id, command: gate.command, timeoutS: gate.timeoutS } },
      now,
    );
    return {
      ok: true,
      gate: { id, taskId, command: gate.command, timeoutS: gate.timeoutS, createdBy: by, createdAt: now },
    };
  });
}

/**
 * Remove one of a task's gates, for an operator. The row goes; its `gate_removed`
 * event keeps what it was and who removed it.
 */
export function removeGate(db: Db, taskId: string, gateId: number, by: string, now: number): Result<{ gate: GateRow }> {
  return tx(db, (d) => {
    if (getTask(d, taskId) === undefined) return refuse('not_found', `no task ${taskId}`);
    const gate = gatesOf(d, taskId).find((g) => g.id === gateId);
    if (gate === undefined) return refuse('not_found', `task ${taskId} has no gate ${gateId}`);
    d.prepare('DELETE FROM kanban_gates WHERE id = ?').run(gateId);
    record(d, { taskId, kind: 'gate_removed', actor: by, payload: { gateId, command: gate.command } }, now);
    return { ok: true, gate };
  });
}

```

In `src/kanban/service.ts`, replace:

```ts
import type { Db } from '../db/open.js';
import * as board from '../db/kanban.js';
import { getRun, getTask, taskView, type TaskView } from '../db/kanban-read.js';
import { redactKnownSecrets } from '../secrets.js';
import type { Role } from '../roles.js';
import { systemClock, type Clock } from '../time.js';
import {
  BLOCK_KINDS,
  CONTRACT_FIELDS,
  type AgentSnapshot,
  type Assignee,
```

with:

```ts
import type { Db } from '../db/open.js';
import * as board from '../db/kanban.js';
import { gatesOf, getRun, getTask, taskView, type TaskView } from '../db/kanban-read.js';
import { redactKnownSecrets } from '../secrets.js';
import type { Role } from '../roles.js';
import { stripControl } from '../text.js';
import { systemClock, type Clock } from '../time.js';
import {
  BLOCK_KINDS,
  CONTRACT_FIELDS,
  GATE_LIMITS,
  type AgentSnapshot,
  type Assignee,
```

In `src/kanban/service.ts`, replace:

```ts
  type Contract,
  type CreatedVia,
  type Refusal,
  type Rendering,
```

with:

```ts
  type Contract,
  type CreatedVia,
  type GateRow,
  type Refusal,
  type Rendering,
```

In `src/kanban/service.ts`, replace:

```ts
function regularFile(path: string): void {
  if (!statSync(path).isFile()) throw new Error(`${path} is not a file`);
}

```

with:

```ts
function regularFile(path: string): void {
  if (!statSync(path).isFile()) throw new Error(`${path} is not a file`);
}

/**
 * Whether a gate command holds a known secret (spec §10.1): as written, with its
 * control characters stripped, as the escapers match it, and with the shell's
 * quotes and backslashes taken out, so `sk\$x` or `'sk''x'` -- which the shell
 * runs as the secret -- count as well.
 */
function holdsSecret(command: string): boolean {
  const forms = [command, stripControl(command), command.replace(/['"\\]/g, '')];
  return forms.some((form) => redactKnownSecrets(form) !== form);
}

```

In `src/kanban/service.ts`, replace:

```ts
  }

  comment(taskId: string, body: string, by: string): Result<{ comment: CommentRow }> {
    const ids = idsRefused(taskId);
```

with:

```ts
  }

  /**
   * Define a gate on a task (spec §7.7): a shell command that must exit 0 before
   * the task may complete or go to review. It is an operator action (spec §10):
   * the caller checks the tier, as it does for the board's other operator
   * actions. Plan D's chat command calls it; until then only tests do, as
   * nothing can create a task either.
   *
   * The command is stored and run as written, so one that holds a known secret is
   * refused rather than masked (spec §10.1): a masked command would run broken.
   * The value belongs in the environment of the role whose agent runs the task,
   * which is what gates run with, and the command names it.
   */
  addGate(taskId: string, gate: { command: string; timeoutS?: number }, by: string): Result<{ gate: GateRow }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (!isText(by)) return board.refuse('invalid', 'who defines a gate is text');
    if (!isRecord(gate) || !isText(gate.command) || gate.command.trim() === '') {
      return board.refuse('invalid', 'a gate is a command, as text');
    }
    const { command } = gate;
    if (command.includes('\0')) return board.refuse('invalid', 'a gate command cannot hold a NUL');
    const size = Buffer.byteLength(command, 'utf8');
    if (size > GATE_LIMITS.commandBytes) {
      return board.refuse('invalid', `a gate command is ${size} bytes; it may be at most ${GATE_LIMITS.commandBytes}`);
    }
    if (holdsSecret(command)) {
      // Not echoed: the refusal would carry the secret.
      return board.refuse(
        'invalid',
        "the gate's command holds a known secret, and a gate is stored and run as written; " +
          "pass the value through the agent's environment instead -- the role's .env, or agent.passEnv -- " +
          'and name it in the command, as $NAME',
      );
    }
    const timeoutS = gate.timeoutS ?? GATE_LIMITS.defaultTimeoutS;
    if (!Number.isSafeInteger(timeoutS) || timeoutS < 1 || timeoutS > GATE_LIMITS.maxTimeoutS) {
      return board.refuse('invalid', `a gate's timeout is a whole number of seconds, from 1 to ${GATE_LIMITS.maxTimeoutS}`);
    }
    return board.addGate(this.#db, taskId, { command, timeoutS }, by, this.#clock.now());
  }

  /** The task's gates, in the order they run. */
  listGates(taskId: string): Result<{ gates: GateRow[] }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (getTask(this.#db, taskId) === undefined) return board.refuse('not_found', `no task ${taskId}`);
    return { ok: true, gates: gatesOf(this.#db, taskId) };
  }

  /**
   * Remove one of a task's gates: an operator action, as defining one is. A report
   * already running the task's gates runs the ones it read.
   */
  removeGate(taskId: string, gateId: number, by: string): Result<{ gate: GateRow }> {
    const ids = idsRefused(taskId);
    if (ids !== undefined) return ids;
    if (!isText(by)) return board.refuse('invalid', 'who removes a gate is text');
    if (!Number.isSafeInteger(gateId) || gateId < 1) return board.refuse('invalid', 'a gate id is a whole number');
    return board.removeGate(this.#db, taskId, gateId, by, this.#clock.now());
  }

  comment(taskId: string, body: string, by: string): Result<{ comment: CommentRow }> {
    const ids = idsRefused(taskId);
```

In `src/kanban/types.ts`, replace:

```ts
}

export interface CommentRow {
  id: number;
```

with:

```ts
}

/**
 * A quality gate (spec §7.7): a shell command that must exit 0, in the task's
 * workspace, before the task may complete or go to review. Defined by an
 * operator, never by a run; stored as written, never masked, since a masked
 * command would run broken -- one that holds a known secret is refused instead
 * (spec §10.1).
 */
export interface GateRow {
  id: number;
  taskId: string;
  command: string;
  timeoutS: number;
  /** Who defined it (spec §10). */
  createdBy: string;
  createdAt: number;
}

/** What a task's gates may be: each command, timeout, and all of them together. */
export const GATE_LIMITS = {
  /** A command's size, in UTF-8 bytes. */
  commandBytes: 4 * 1024,
  /** A gate's timeout when none is given, as the schema's default. */
  defaultTimeoutS: 300,
  /** The longest one gate may run. */
  maxTimeoutS: 600,
  /**
   * The longest all of a task's gates may run, one after another: a report waits
   * for them, and `mt kanban` waits 15 minutes for its answer.
   */
  totalTimeoutS: 600,
  /** Gates on one task. */
  perTask: 20,
} as const;

export interface CommentRow {
  id: number;
```

- [ ] **Step 1.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1071 passed (1071)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 1.5: Commit.**

```bash
git add src/db/WRITERS.md src/db/kanban-read.ts src/db/kanban.ts src/kanban/service.ts src/kanban/types.ts tests/kanban-gates.test.ts
git commit -m "Let an operator define a task's gates, refusing a command that holds a known secret"
```

---

### Task 2: Reports are asynchronous

**Files:**
- Modify: `src/kanban/service.ts`, `src/kanban/worker.ts`, `tests/helpers/dispatch.ts`, `tests/kanban-dispatch-failure.test.ts`, `tests/kanban-dispatch-restart.test.ts`, `tests/kanban-dispatch-sweep.test.ts`, `tests/kanban-dispatcher.test.ts`, `tests/kanban-nudge.test.ts`, `tests/kanban-service.test.ts`, `tests/kanban-token.test.ts`, `tests/kanban-worker.test.ts`

C3's note: gates must not block the event loop, so `KanbanService.complete` and `requestReview` become asynchronous, and so do `WorkerApi.handle` and `#act`, which await them (Decision 4). Nothing changes yet in what they do. The tests that call them now await them — awaiting a value that is not a promise gives the value, so they still pass before the change — and two new tests say the answer is a promise. `reportComplete` in the dispatch harness becomes asynchronous, the fake agents' scripts that call it await it, and `holds` awaits its `first` callback.

- [ ] **Step 2.1: Write the failing tests.**

Run, from the worktree's root, this script. It puts `await` before each call of `complete`, `requestReview` and the worker API's `handle` in `tests/kanban-worker.test.ts` and `tests/kanban-service.test.ts` — in parentheses where a member access follows the call — and makes each test that now awaits `async`; it also types the worker test's `ask` as a promise, and awaits the malformed-input table's calls:

```bash
node --input-type=module <<'EOF'
// Make the tests await every report: each call named below gets an `await`, in
// parentheses when a member access follows it, and each test that now awaits is async.
import { readFileSync, writeFileSync } from 'node:fs';

const files = {
  'tests/kanban-worker.test.ts': ['ask', 'p.ask', 'work.ask', 'review.ask', 'b.api.handle', 'api.handle'],
  'tests/kanban-service.test.ts': ['s.complete', 's.requestReview'],
};

/** The index just past the call's closing parenthesis, skipping strings. */
function callEnd(s, open) {
  let depth = 0;
  for (let j = open; j < s.length; j += 1) {
    const c = s[j];
    if (c === "'" || c === '"' || c === '`') {
      for (j += 1; s[j] !== c; j += 1) if (s[j] === '\\') j += 1;
    } else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c) && --depth === 0) return j + 1;
  }
  throw new Error('unbalanced call');
}

for (const [file, names] of Object.entries(files)) {
  let s = readFileSync(file, 'utf8');
  const escaped = names.map((n) => n.replace(/[.$]/g, '\\$&')).join('|');
  const calls = [...s.matchAll(new RegExp(`(?<![\\w.$])(?:${escaped})\\(`, 'g'))]
    .filter((m) => !/(=>\s*|await\s*|function\s+)$/.test(s.slice(Math.max(0, m.index - 40), m.index)))
    .filter((m) => !/^\w+\((command|req|raw)\s*:/.test(s.slice(m.index)))
    .map((m) => {
      const end = callEnd(s, m.index + m[0].length - 1);
      return { start: m.index, end, wrap: '.['.includes(s[end]) };
    });
  for (const { start, end, wrap } of calls.reverse()) {
    const call = s.slice(start, end);
    s = s.slice(0, start) + (wrap ? `(await ${call})` : `await ${call}`) + s.slice(end);
  }
  // A test that now awaits becomes async; its body is up to the next test.
  s = s.replace(/(\n\s*it\((?:'[^'\n]*'|"[^"\n]*"|`[^`\n]*`), )\(\) => \{([\s\S]*?)(?=\n\s*it\(|\n\}\);?\n|$)/g, (all, head, body) =>
    body.includes('await ') ? `${head}async () => {${body}` : all,
  );
  s = s.replace('ask(command: string, input?: unknown): WorkerResponse };', 'ask(command: string, input?: unknown): Promise<WorkerResponse> };');
  s = s.replace('        r = call();', '        r = await call();');
  writeFileSync(file, s);
  console.log(`${file}: ${calls.length} calls awaited`);
}
EOF
```

Expected: it prints `tests/kanban-worker.test.ts: 58 calls awaited` and `tests/kanban-service.test.ts: 10 calls awaited`.

In `tests/helpers/dispatch.ts`, replace:

```ts
 * has one run at a time.
 */
export function reportComplete(h: DispatchHarness, from: FakeDriver | string, summary = 'done'): void {
  const run = typeof from === 'string' ? getRun(h.t.db, from) : h.runOf(from);
  if (run === undefined) throw new Error(`no run ${String(from)}`);
  const r = h.service.complete(run.taskId, { kind: 'run', runId: run.runId }, { summary });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
}
```

with:

```ts
 * has one run at a time.
 */
export async function reportComplete(h: DispatchHarness, from: FakeDriver | string, summary = 'done'): Promise<void> {
  const run = typeof from === 'string' ? getRun(h.t.db, from) : h.runOf(from);
  if (run === undefined) throw new Error(`no run ${String(from)}`);
  const r = await h.service.complete(run.taskId, { kind: 'run', runId: run.runId }, { summary });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
}
```

In `tests/helpers/dispatch.ts`, replace:

```ts
/** The next turn on this driver reports complete for its own run, then ends. */
export function completes(h: DispatchHarness, driver: FakeDriver, summary = 'done'): void {
  driver.scripts.push((ctl) => {
    const runId = ctl.env?.['MT_KANBAN_RUN'];
    if (runId === undefined) throw new Error(`a turn on driver ${driver.id} was started with no run`);
    reportComplete(h, runId, summary);
    ctl.end('completed');
  });
```

with:

```ts
/** The next turn on this driver reports complete for its own run, then ends. */
export function completes(h: DispatchHarness, driver: FakeDriver, summary = 'done'): void {
  driver.scripts.push(async (ctl) => {
    const runId = ctl.env?.['MT_KANBAN_RUN'];
    if (runId === undefined) throw new Error(`a turn on driver ${driver.id} was started with no run`);
    await reportComplete(h, runId, summary);
    ctl.end('completed');
  });
```

In `tests/helpers/dispatch.ts`, replace:

```ts
  started: boolean;
  /** End the turn: optionally do something first, as the agent, then end with `terminal`. */
  end(terminal?: TurnTerminal, first?: () => void): void;
}

```

with:

```ts
  started: boolean;
  /** End the turn: optionally do something first, as the agent, then end with `terminal`. */
  end(terminal?: TurnTerminal, first?: () => void | Promise<void>): void;
}

```

In `tests/helpers/dispatch.ts`, replace:

```ts
    release = resolve;
  });
  let ending: { terminal: TurnTerminal; first: (() => void) | undefined } = { terminal: 'completed', first: undefined };
  const held: Held = {
    started: false,
```

with:

```ts
    release = resolve;
  });
  let ending: { terminal: TurnTerminal; first: (() => void | Promise<void>) | undefined } = {
    terminal: 'completed',
    first: undefined,
  };
  const held: Held = {
    started: false,
```

In `tests/helpers/dispatch.ts`, replace:

```ts
    held.started = true;
    await gate;
    ending.first?.();
    ctl.end(ending.terminal);
  });
```

with:

```ts
    held.started = true;
    await gate;
    await ending.first?.();
    ctl.end(ending.terminal);
  });
```

In `tests/kanban-dispatch-failure.test.ts`, replace:

```ts
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    implementer.scripts.push((ctl) => {
      reportComplete(h, implementer);
      fails('Error: 429 Too Many Requests', 'ambiguous')(ctl);
    });
```

with:

```ts
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    implementer.scripts.push(async (ctl) => {
      await reportComplete(h, implementer);
      fails('Error: 429 Too Many Requests', 'ambiguous')(ctl);
    });
```

In `tests/kanban-dispatch-restart.test.ts`, replace:

```ts
  implementer.scripts.push(async (ctl: TurnControl) => {
    ctl.emit({ kind: 'tool-call', toolCallId: 'c1', title: 'edit', status: 'completed', raw: {} });
    if (report) reportComplete(h, implementer);
    running = true;
    await new Promise<void>(() => undefined);
```

with:

```ts
  implementer.scripts.push(async (ctl: TurnControl) => {
    ctl.emit({ kind: 'tool-call', toolCallId: 'c1', title: 'edit', status: 'completed', raw: {} });
    if (report) await reportComplete(h, implementer);
    running = true;
    await new Promise<void>(() => undefined);
```

In `tests/kanban-dispatch-sweep.test.ts`, replace:

```ts
    h.dispatcher.pass();
    await until(() => held.started, 'the run to start');
    reportComplete(h, h.driver('implementer'));

    h.clock.advance(120 * 1000);
```

with:

```ts
    h.dispatcher.pass();
    await until(() => held.started, 'the run to start');
    await reportComplete(h, h.driver('implementer'));

    h.clock.advance(120 * 1000);
```

In `tests/kanban-dispatch-sweep.test.ts`, replace:

```ts
describe('Dispatcher: stranded tasks (spec §4.2)', () => {
  /** A task whose parents finished in different workspaces: nobody may guess which to use. */
  function unclaimable(h: DispatchHarness): string {
    const web = h.create({ title: 'web half', workspace: 'web' });
    const api = h.create({ title: 'api half', workspace: 'api' });
    for (const parent of [web, api]) {
      expect(h.service.complete(parent.taskId, { kind: 'person', principal: ALICE }, { summary: 'done' }).ok).toBe(true);
    }
    return h.create({ title: 'join', parents: [web.taskId, api.taskId] }).taskId;
```

with:

```ts
describe('Dispatcher: stranded tasks (spec §4.2)', () => {
  /** A task whose parents finished in different workspaces: nobody may guess which to use. */
  async function unclaimable(h: DispatchHarness): Promise<string> {
    const web = h.create({ title: 'web half', workspace: 'web' });
    const api = h.create({ title: 'api half', workspace: 'api' });
    for (const parent of [web, api]) {
      expect((await h.service.complete(parent.taskId, { kind: 'person', principal: ALICE }, { summary: 'done' })).ok).toBe(true);
    }
    return h.create({ title: 'join', parents: [web.taskId, api.taskId] }).taskId;
```

In `tests/kanban-dispatch-sweep.test.ts`, replace:

```ts
  }

  it('reports a task nobody can be given once it has waited strandedAfterS, and only once', () => {
    const h = harness();
    const taskId = unclaimable(h);

    h.dispatcher.sweep();
```

with:

```ts
  }

  it('reports a task nobody can be given once it has waited strandedAfterS, and only once', async () => {
    const h = harness();
    const taskId = await unclaimable(h);

    h.dispatcher.sweep();
```

In `tests/kanban-dispatcher.test.ts`, replace:

```ts
    const implementer = h.driver('implementer');
    implementer.providerSessionId = 'prov_impl';
    implementer.scripts.push((ctl) => {
      const run = h.runOf(implementer);
      expect(h.service.requestReview(task.taskId, { kind: 'run', runId: run.runId }, { summary: 'please look' }).ok).toBe(
        true,
      );
      ctl.end('completed');
    });
```

with:

```ts
    const implementer = h.driver('implementer');
    implementer.providerSessionId = 'prov_impl';
    implementer.scripts.push(async (ctl) => {
      const run = h.runOf(implementer);
      expect(
        (await h.service.requestReview(task.taskId, { kind: 'run', runId: run.runId }, { summary: 'please look' })).ok,
      ).toBe(true);
      ctl.end('completed');
    });
```

In `tests/kanban-dispatcher.test.ts`, replace:

```ts
    implementer.scripts.push(async (ctl) => {
      const run = h.runOf(implementer);
      expect(h.service.complete(parent.taskId, { kind: 'run', runId: run.runId }, { summary: 'done' }).ok).toBe(true);
      reported = true;
      // Still going: summarising, committing, in the same checkout.
```

with:

```ts
    implementer.scripts.push(async (ctl) => {
      const run = h.runOf(implementer);
      expect((await h.service.complete(parent.taskId, { kind: 'run', runId: run.runId }, { summary: 'done' })).ok).toBe(true);
      reported = true;
      // Still going: summarising, committing, in the same checkout.
```

In `tests/kanban-dispatcher.test.ts`, replace:

```ts
    let reported = false;
    implementer.scripts.push(async (ctl) => {
      reportComplete(h, implementer);
      reported = true;
      await tidying;
```

with:

```ts
    let reported = false;
    implementer.scripts.push(async (ctl) => {
      await reportComplete(h, implementer);
      reported = true;
      await tidying;
```

In `tests/kanban-nudge.test.ts`, replace:

```ts
    const implementer = h.driver('implementer');
    says(implementer, 'Next I will run the tests.');
    implementer.scripts.push((ctl) => {
      reportComplete(h, ctl.env?.['MT_KANBAN_RUN'] ?? '', 'tests pass');
      ctl.end('completed');
    });
```

with:

```ts
    const implementer = h.driver('implementer');
    says(implementer, 'Next I will run the tests.');
    implementer.scripts.push(async (ctl) => {
      await reportComplete(h, ctl.env?.['MT_KANBAN_RUN'] ?? '', 'tests pass');
      ctl.end('completed');
    });
```

In `tests/kanban-nudge.test.ts`, replace:

```ts
    });
    says(implementer, 'Using v2.');
    implementer.scripts.push((ctl) => {
      reportComplete(h, ctl.env?.['MT_KANBAN_RUN'] ?? '');
      ctl.end('completed');
    });
```

with:

```ts
    });
    says(implementer, 'Using v2.');
    implementer.scripts.push(async (ctl) => {
      await reportComplete(h, ctl.env?.['MT_KANBAN_RUN'] ?? '');
      ctl.end('completed');
    });
```

In `tests/kanban-nudge.test.ts`, replace:

```ts
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    implementer.scripts.push((ctl) => {
      reportComplete(h, ctl.env?.['MT_KANBAN_RUN'] ?? '');
      h.service.comment(task.taskId, 'nice work', ALICE);
      ctl.end('completed');
```

with:

```ts
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    implementer.scripts.push(async (ctl) => {
      await reportComplete(h, ctl.env?.['MT_KANBAN_RUN'] ?? '');
      h.service.comment(task.taskId, 'nice work', ALICE);
      ctl.end('completed');
```

In `tests/kanban-service.test.ts`, replace:

```ts
    expect(importers).toEqual([join('kanban', 'service.ts')]);
  });
});

```

with:

```ts
    expect(importers).toEqual([join('kanban', 'service.ts')]);
  });
});

describe('KanbanService: reports are asynchronous', () => {
  it('answers complete and review with a promise, so their checks never hold up the event loop', async () => {
    const s = service();
    const a = ok(s.create(request())).task;
    const b = ok(s.create(request())).task;
    const done = s.complete(a.taskId, { kind: 'person', principal: ALICE }, { summary: 'done' });
    const review = s.requestReview(b.taskId, { kind: 'person', principal: ALICE }, { summary: 'v1', reviewer: 'reviewer' });
    expect(done).toBeInstanceOf(Promise);
    expect(review).toBeInstanceOf(Promise);
    expect(await done).toMatchObject({ ok: true, task: { phase: 'done' } });
    expect(await review).toMatchObject({ ok: true, task: { phase: 'review' } });
  });
});

```

In `tests/kanban-token.test.ts`, replace:

```ts
      ctl.end('completed');
    });
    implementer.scripts.push((ctl) => {
      tokens.push(ctl.env?.['MT_KANBAN_TOKEN'] ?? '');
      reportComplete(h, ctl.env?.['MT_KANBAN_RUN'] ?? '');
      ctl.end('completed');
    });
```

with:

```ts
      ctl.end('completed');
    });
    implementer.scripts.push(async (ctl) => {
      tokens.push(ctl.env?.['MT_KANBAN_TOKEN'] ?? '');
      await reportComplete(h, ctl.env?.['MT_KANBAN_RUN'] ?? '');
      ctl.end('completed');
    });
```

In `tests/kanban-worker.test.ts`, replace:

```ts
    }
  });
});

```

with:

```ts
    }
  });
});

describe('worker API: answers', () => {
  it('answers with a promise, as a report waits for its checks', async () => {
    const task = b.create();
    const { run, token } = b.claim(task.taskId);
    const answer = b.api.handle({ run: run.runId, token, command: 'complete', input: { summary: 'done' } });
    expect(answer).toBeInstanceOf(Promise);
    expect(await answer).toMatchObject({ ok: true, phase: 'done' });
  });
});

```

- [ ] **Step 2.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-service.test.ts tests/kanban-worker.test.ts`. Expected: the two new tests FAIL, with `AssertionError: expected { ok: true, task: { …(26) }, …(1) } to be an instance of Promise` and `AssertionError: expected { ok: true, …(3) } to be an instance of Promise`; every other test in both files passes, already awaiting. `Tests  2 failed | 49 passed (51)`.

- [ ] **Step 2.3: Implement.**

In `src/kanban/service.ts`, replace:

```ts
  }

  /** Every path to done (spec §5.1). Gates run here first, from plan C4. */
  complete(taskId: string, by: Reporter, handoff: board.Handoff): Result<{ task: TaskRow; run: RunRow | undefined }> {
    const refused = idsRefused(taskId) ?? handoffRefused(by, handoff);
    if (refused !== undefined) return refused;
```

with:

```ts
  }

  /**
   * Every path to done (spec §5.1). Asynchronous, as a report's checks run
   * processes -- the task's gates, and reading the reported commit -- and the
   * gateway must not stop for them: chat runs on the same event loop.
   */
  async complete(
    taskId: string,
    by: Reporter,
    handoff: board.Handoff,
  ): Promise<Result<{ task: TaskRow; run: RunRow | undefined }>> {
    const refused = idsRefused(taskId) ?? handoffRefused(by, handoff);
    if (refused !== undefined) return refused;
```

In `src/kanban/service.ts`, replace:

```ts
  }

  /** A reviewer the report names is checked like any assignee (spec §5.3, §12). */
  requestReview(
    taskId: string,
    by: Reporter,
    handoff: board.Handoff & { reviewer?: string },
  ): Result<{ task: TaskRow; run: RunRow | undefined }> {
    const refused = idsRefused(taskId) ?? handoffRefused(by, handoff);
    if (refused !== undefined) return refused;
```

with:

```ts
  }

  /**
   * A reviewer the report names is checked like any assignee (spec §5.3, §12).
   * Asynchronous, as complete is: an implementer's review runs the gates too.
   */
  async requestReview(
    taskId: string,
    by: Reporter,
    handoff: board.Handoff & { reviewer?: string },
  ): Promise<Result<{ task: TaskRow; run: RunRow | undefined }>> {
    const refused = idsRefused(taskId) ?? handoffRefused(by, handoff);
    if (refused !== undefined) return refused;
```

In `src/kanban/worker.ts`, replace:

```ts
  }

  /** One request, as the socket parsed it. Never throws. */
  handle(raw: unknown): WorkerResponse {
    try {
      return this.#handle(raw);
    } catch {
      // Not quoted: an error here can carry anything, the request included.
```

with:

```ts
  }

  /**
   * One request, as the socket parsed it. Never rejects. Asynchronous, since a
   * report waits for its task's gates (spec §7.7).
   */
  async handle(raw: unknown): Promise<WorkerResponse> {
    try {
      return await this.#handle(raw);
    } catch {
      // Not quoted: an error here can carry anything, the request included.
```

In `src/kanban/worker.ts`, replace:

```ts
  }

  #handle(raw: unknown): WorkerResponse {
    if (!isRecord(raw)) return refused('bad_request', 'a request is a JSON object');
    for (const key of Object.keys(raw)) {
```

with:

```ts
  }

  async #handle(raw: unknown): Promise<WorkerResponse> {
    if (!isRecord(raw)) return refused('bad_request', 'a request is a JSON object');
    for (const key of Object.keys(raw)) {
```

In `src/kanban/worker.ts`, replace:

```ts
    const bad = badInput(command, input);
    if (bad !== undefined) return bad;
    const r = this.#act(command, run, input);
    if (r.ok && command !== 'show') this.#changed();
    return r;
  }

  #act(command: WorkerCommand, run: RunRow, input: Record<string, unknown>): WorkerResponse {
    const by: Reporter = { kind: 'run', runId: run.runId };
    const actor = `run:${run.runId}`;
```

with:

```ts
    const bad = badInput(command, input);
    if (bad !== undefined) return bad;
    const r = await this.#act(command, run, input);
    if (r.ok && command !== 'show') this.#changed();
    return r;
  }

  async #act(command: WorkerCommand, run: RunRow, input: Record<string, unknown>): Promise<WorkerResponse> {
    const by: Reporter = { kind: 'run', runId: run.runId };
    const actor = `run:${run.runId}`;
```

In `src/kanban/worker.ts`, replace:

```ts
        return this.#show(run);
      case 'complete':
        return reported(this.#service.complete(run.taskId, by, { summary: str('summary') ?? '', ...metadata }));
      case 'review': {
        const reviewer = str('reviewer');
        return reported(
          this.#service.requestReview(run.taskId, by, {
            summary: str('summary') ?? '',
            ...metadata,
```

with:

```ts
        return this.#show(run);
      case 'complete':
        return reported(await this.#service.complete(run.taskId, by, { summary: str('summary') ?? '', ...metadata }));
      case 'review': {
        const reviewer = str('reviewer');
        return reported(
          await this.#service.requestReview(run.taskId, by, {
            summary: str('summary') ?? '',
            ...metadata,
```

- [ ] **Step 2.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1073 passed (1073)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 2.5: Commit.**

```bash
git add src/kanban/service.ts src/kanban/worker.ts tests/helpers/dispatch.ts tests/kanban-dispatch-failure.test.ts tests/kanban-dispatch-restart.test.ts tests/kanban-dispatch-sweep.test.ts tests/kanban-dispatcher.test.ts tests/kanban-nudge.test.ts tests/kanban-service.test.ts tests/kanban-token.test.ts tests/kanban-worker.test.ts
git commit -m "Make a report asynchronous, from the service to the worker API, so its checks never hold up the gateway"
```

---

### Task 3: The gate runner

**Files:**
- Create: `src/kanban/gates.ts`, `tests/kanban-gates.e2e.ts`
- Modify: `tests/kanban-gates.test.ts`

`src/kanban/gates.ts` (Decisions 7 and 8): `runGates` runs a task's gates in order through an injected runner, stops at the first that fails, and masks each one's output before it keeps its last 4 KiB; `gateEnv` builds a gate's environment from the agent allowlist and its role's values, dropping anything named `MT_KANBAN_*`; `spawnGate` is the real runner. It runs `/bin/sh -c` in its own process group, so a timeout or a stop kills what the gate started; once the shell exits it clears the timeout, since the gate ended in time, kills what is left in the group, and lets go of the output a second later if something that left the group still holds it; and a hook on the process's `exit` kills every running gate's group, so a crash leaves none running in a checkout the next boot hands to an agent. The unit tests use a runner that starts nothing; `tests/kanban-gates.e2e.ts` runs the real one.

- [ ] **Step 3.1: Write the failing tests.**

Create `tests/kanban-gates.e2e.ts`:

```ts
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnGate } from '../src/kanban/gates.js';

/**
 * The real gate runner (spec §7.7): `/bin/sh -c`, in its own process group, in
 * the workspace, with only the environment it is given. Real processes, so not a
 * unit test.
 */

let dir: string;
const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' };

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-gate-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('spawnGate', () => {
  it('passes a command that exits 0, in the workspace, with the environment given and nothing else', async () => {
    const r = await spawnGate('pwd; echo "key=$API_KEY token=${MT_KANBAN_TOKEN:-none}"', {
      cwd: dir,
      env: { ...env, API_KEY: 'from-the-role' },
      timeoutMs: 10_000,
    });
    expect(r).toEqual({ exitCode: 0, signal: null, timedOut: false, output: `${dir}\nkey=from-the-role token=none\n` });
  });

  it('fails a command that exits non-zero, with what it wrote to stdout and stderr', async () => {
    const r = await spawnGate('echo one; echo two >&2; exit 3', { cwd: dir, env, timeoutMs: 10_000 });
    expect(r).toMatchObject({ exitCode: 3, signal: null, timedOut: false });
    expect(r.output.split('\n').sort()).toEqual(['', 'one', 'two']);
  });

  it('kills a gate past its timeout, and what it started, promptly', async () => {
    const started = Date.now();
    const r = await spawnGate('echo begun; sleep 30 & sleep 30', { cwd: dir, env, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    // The shell is killed by the signal, or exits on it once its child is: either way, not 0.
    expect(r.signal === 'SIGTERM' || r.exitCode === 143).toBe(true);
    expect(r.output.startsWith('begun\n')).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('does not wait for a background process the gate left holding its output', async () => {
    const started = Date.now();
    const r = await spawnGate('sleep 30 & echo done', { cwd: dir, env, timeoutMs: 20_000 });
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, output: 'done\n' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("does not wait for a process that left the gate's group holding its output, nor count that against the gate", async () => {
    const started = Date.now();
    // A child that makes itself a session of its own, then says so, keeping the gate's output open.
    const escape = `perl -MPOSIX -e 'POSIX::setsid(); open(my $f, ">", "escaped.pid"); print $f $$; close($f); sleep 30' &`;
    // The timeout falls in the second the output is let go of: the gate itself ended in time.
    const r = await spawnGate(`${escape} while [ ! -s escaped.pid ]; do sleep 0.05; done; echo done`, {
      cwd: dir,
      env,
      timeoutMs: 700,
    });
    try {
      expect(r).toMatchObject({ exitCode: 0, timedOut: false, output: 'done\n' });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      process.kill(Number(readFileSync(join(dir, 'escaped.pid'), 'utf8')), 'SIGKILL');
    }
  });

  it('kills a running gate when the gateway exits', async () => {
    const code = [
      `import { spawnGate } from ${JSON.stringify(new URL('../src/kanban/gates.ts', import.meta.url).href)};`,
      `const opts = { cwd: ${JSON.stringify(dir)}, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 60_000 };`,
      "void spawnGate('echo $$ > gate.pid; exec sleep 30', opts);",
      'setTimeout(() => process.exit(1), 500);',
    ].join('\n');
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', loader, '--input-type=module', '-e', code], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('close', () => resolve());
    });
    const pid = Number(readFileSync(join(dir, 'gate.pid'), 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  it('stops a gate when the gateway stops', async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const started = Date.now();
    const r = await spawnGate('sleep 30', { cwd: dir, env, timeoutMs: 20_000, signal: stop.signal });
    expect(r.timedOut).toBe(false);
    expect(r.signal === 'SIGTERM' || r.exitCode === 143).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('fails a gate that cannot start, saying why', async () => {
    const r = await spawnGate('true', { cwd: join(dir, 'missing'), env, timeoutMs: 10_000 });
    expect(r).toMatchObject({ exitCode: null, timedOut: false });
    expect(r.output).toMatch(/^the gate could not start: spawn \/bin\/sh ENOENT/);
  });
});
```

In `tests/kanban-gates.test.ts`, replace:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventsOf, gatesOf } from '../src/db/kanban-read.js';
import { KanbanService } from '../src/kanban/service.js';
import { GATE_LIMITS, type TaskRow } from '../src/kanban/types.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * Defining a task's gates (spec §7.7, §10, §10.1): an operator action, through
```

with:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventsOf, gatesOf } from '../src/db/kanban-read.js';
import { GATE_OUTPUT_BYTES, gateEnv, runGates, type GateExit, type GateRunOptions } from '../src/kanban/gates.js';
import { KanbanService } from '../src/kanban/service.js';
import { GATE_LIMITS, type GateRow, type TaskRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES, role } from './helpers/dispatch.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * Defining a task's gates (spec §7.7, §10, §10.1): an operator action, through
```

In `tests/kanban-gates.test.ts`, replace:

```ts
      ['timeout text', () => s.addGate(k.taskId, { command: 'true', timeoutS: bad('300') }, ALICE)],
      ['by a number', () => s.addGate(k.taskId, { command: 'true' }, bad(3))],
      ['task id an object', () => s.addGate(bad({}), { command: 'true' }, ALICE)],
    ];
    for (const [what, call] of cases) expect([what, call()]).toEqual([what, expect.objectContaining({ ok: false, code: 'invalid' })]);
    expect(count()).toBe(0);
  });

  it('refuses a gate on a task that is archived, or missing', () => {
```

with:

```ts
      ['timeout text', () => s.addGate(k.taskId, { command: 'true', timeoutS: bad('300') }, ALICE)],
      ['by a number', () => s.addGate(k.taskId, { command: 'true' }, bad(3))],
      ['task id an object', () => s.addGate(bad({}), { command: 'true' }, ALICE)],
    ];
    for (const [what, call] of cases) {
      expect([what, call()]).toEqual([what, expect.objectContaining({ ok: false, code: 'invalid' })]);
    }
    expect(count()).toBe(0);
  });

  it('refuses a gate on a task that is archived, or missing', () => {
```

In `tests/kanban-gates.test.ts`, replace:

```ts
    });
  });
});

```

with:

```ts
    });
  });
});

/** Gates as rows, for runGates. */
function rows(...commands: string[]): GateRow[] {
  return commands.map((command, i) => ({ id: i + 1, taskId: 'k_1', command, timeoutS: 30 + i, createdBy: ALICE, createdAt: 0 }));
}

/** A runner that starts nothing: each command's exit, as scripted, and every call it was given. */
function scripted(exits: Record<string, Partial<GateExit>>) {
  const calls: Array<{ command: string } & GateRunOptions> = [];
  const runner = async (command: string, opts: GateRunOptions): Promise<GateExit> => {
    calls.push({ command, ...opts });
    return { exitCode: 0, signal: null, timedOut: false, output: '', ...exits[command] };
  };
  return { runner, calls };
}

describe('running gates', () => {
  it('runs each gate in order, in the workspace, with its timeout, and passes when each exits 0', async () => {
    const { runner, calls } = scripted({ 'npm test': { output: 'all green' } });
    const env = { PATH: '/usr/bin', API_KEY: 'k' };
    const run = await runGates(rows('npm run lint', 'npm test'), { cwd: '/ws/web', env, runner, clock: new ManualClock() });
    expect(calls.map((c) => [c.command, c.cwd, c.timeoutMs, c.env])).toEqual([
      ['npm run lint', '/ws/web', 30_000, env],
      ['npm test', '/ws/web', 31_000, env],
    ]);
    expect(run).toEqual({
      passed: true,
      aborted: false,
      notRun: 0,
      results: [
        { gateId: 1, command: 'npm run lint', exitCode: 0, signal: null, timedOut: false, durationMs: 0, output: '' },
        { gateId: 2, command: 'npm test', exitCode: 0, signal: null, timedOut: false, durationMs: 0, output: 'all green' },
      ],
    });
  });

  it('stops at the first gate that exits non-zero or times out, and says how many did not run', async () => {
    const failing = scripted({ b: { exitCode: 2, output: 'FAIL parser.test.ts' } });
    const failed = await runGates(rows('a', 'b', 'c', 'd'), { cwd: '/ws', env: {}, runner: failing.runner });
    expect(failing.calls.map((c) => c.command)).toEqual(['a', 'b']);
    expect(failed).toMatchObject({
      passed: false,
      aborted: false,
      notRun: 2,
      results: [{ exitCode: 0 }, { exitCode: 2, output: 'FAIL parser.test.ts' }],
    });

    const slow = scripted({ a: { exitCode: null, signal: 'SIGTERM', timedOut: true } });
    expect(await runGates(rows('a', 'b'), { cwd: '/ws', env: {}, runner: slow.runner })).toMatchObject({
      passed: false,
      notRun: 1,
      results: [{ exitCode: null, signal: 'SIGTERM', timedOut: true }],
    });
  });

  it('masks what a gate wrote before keeping its end', async () => {
    addSecrets(['sk-live-1234567890']);
    const long = `${'x'.repeat(GATE_OUTPUT_BYTES)}\nthe key is sk-live-1234567890`;
    const { runner } = scripted({ a: { exitCode: 1, output: long } });
    const [result] = (await runGates(rows('a'), { cwd: '/ws', env: {}, runner })).results;
    expect(result?.output.endsWith(`the key is ${MASK}`)).toBe(true);
    expect(result?.output).not.toContain('sk-live');
    expect(Buffer.byteLength(result?.output ?? '', 'utf8')).toBe(GATE_OUTPUT_BYTES);
  });

  it('runs nothing more once the gateway is stopping, and says the run was stopped', async () => {
    const stopping = new AbortController();
    const { runner, calls } = scripted({});
    const first = await runGates(rows('a', 'b'), {
      cwd: '/ws',
      env: {},
      runner: async (command, opts) => {
        stopping.abort();
        return runner(command, opts);
      },
      signal: stopping.signal,
    });
    expect(calls.map((c) => [c.command, c.signal?.aborted])).toEqual([['a', true]]);
    expect(first).toMatchObject({ passed: false, aborted: true, notRun: 1 });
    expect(await runGates(rows('a'), { cwd: '/ws', env: {}, runner, signal: stopping.signal })).toEqual({
      passed: false,
      aborted: true,
      results: [],
      notRun: 1,
    });
  });

  it("gives a gate its role's environment and the agent allowlist, never the gateway's secrets or a run's", () => {
    const implementer = role('implementer', {
      agent: { ...role('implementer').agent, env: { API_KEY: 'sk-role-1', MT_KANBAN_SOCKET: '/somewhere' } },
    });
    const parent = {
      PATH: '/usr/bin',
      HOME: '/home/mt',
      LARK_APP_SECRET: 'lark-secret',
      MT_KANBAN_TOKEN: 'a-token',
      SOMETHING_ELSE: 'x',
    };
    expect(gateEnv(implementer, parent)).toEqual({ PATH: '/usr/bin', HOME: '/home/mt', API_KEY: 'sk-role-1' });
  });
});

```

- [ ] **Step 3.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-gates.test.ts`. Expected: the file FAILS to load, with `Error: Cannot find module '../src/kanban/gates.js' imported from '…/tests/kanban-gates.test.ts'`, so Task 1's five tests do not run either. `Tests  no tests`.

- [ ] **Step 3.3: Implement.**

Create `src/kanban/gates.ts`:

```ts
import { spawn } from 'node:child_process';
import { buildEnv } from '../driver/env.js';
import type { Role } from '../roles.js';
import { redactKnownSecrets } from '../secrets.js';
import { systemClock, type Clock } from '../time.js';
import type { GateRow } from './types.js';

/**
 * Running a task's gates (spec §7.7): each command, in the order it was defined,
 * in the task's workspace, as the gateway's user, until one fails.
 *
 * **Never on the event loop.** A gate is a process, awaited: the gateway goes on
 * serving chat and other runs while a test suite runs. The runner is injected,
 * so the unit tests start no process; `spawnGate` is the real one.
 *
 * **Its environment is its role's** (`gateEnv`): the allowlist every agent gets
 * (driver/env.ts), and the role's own values -- its agent's base environment,
 * `.env` and `passEnv`. Never the gateway's own environment, which holds its Lark
 * secret, and never a run's: no `MT_KANBAN_TOKEN`, no `MT_KANBAN_SOCKET`. A test
 * suite has no business reporting on the board.
 *
 * **Its output is masked** (spec §10.1) before it is cut to its last
 * GATE_OUTPUT_BYTES, so a cut cannot leave the start of a secret showing.
 */

/** What one gate process did. */
export interface GateExit {
  /** Its exit code; null when a signal ended it, or it never started. */
  exitCode: number | null;
  /** The signal that ended it, if one did. */
  signal: string | null;
  /** It ran past its timeout, and was killed. */
  timedOut: boolean;
  /** The end of what it wrote, stdout and stderr together, as written: not yet masked. */
  output: string;
}

export interface GateRunOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  /** Aborted when the gateway stops: the gate is killed, and the report not applied. */
  signal?: AbortSignal;
}

/** Runs one gate's command. Never rejects: a gate that cannot start is a failed gate. */
export type GateRunner = (command: string, opts: GateRunOptions) => Promise<GateExit>;

/** One gate's result, as it is recorded and shown. */
export interface GateResult {
  gateId: number;
  command: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  /** Masked, then cut to its last GATE_OUTPUT_BYTES. */
  output: string;
}

/** A report's run of the task's gates. */
export interface GateRun {
  /** Every gate exited 0 in time. */
  passed: boolean;
  /** The gateway stopped while they ran. */
  aborted: boolean;
  /** Those that ran, in order: all of them, or up to the first that failed. */
  results: GateResult[];
  /** Gates not run, after the one that failed or the stop. */
  notRun: number;
}

/** What is kept of a gate's output, in UTF-8 bytes, after masking. */
export const GATE_OUTPUT_BYTES = 4 * 1024;
/** What is read of a gate's output before masking: its last bytes. */
const RAW_OUTPUT_BYTES = 64 * 1024;
/** How long a gate that was told to stop has before it is killed. */
const KILL_GRACE_MS = 2_000;
/**
 * How long a gate's output may stay open once its shell has exited and its
 * group been killed: whatever holds it then has left the group, and is not waited for.
 */
const OUTPUT_GRACE_MS = 1_000;

/** The process groups of the gates running now. */
const running = new Set<number>();
let killOnExit = false;

/**
 * Kill every running gate's group when the gateway exits, however it exits but
 * a SIGKILL: a crash's `process.exit` included. A gate left running would go on
 * changing a checkout the next boot hands to an agent.
 */
function tracked(pid: number): void {
  if (!killOnExit) {
    killOnExit = true;
    process.on('exit', () => {
      for (const group of running) {
        try {
          process.kill(-group, 'SIGKILL');
        } catch {
          // Gone already.
        }
      }
    });
  }
  running.add(pid);
}

/** The longest suffix of `text` that fits in `max` UTF-8 bytes, cut on a character. */
function tailBytes(text: string, max: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return text;
  return buf.subarray(buf.length - max).toString('utf8').replace(/^\uFFFD+/, '');
}

/**
 * A gate's environment: the allowlist an agent gets from the gateway's own
 * environment, and its role's values. Nothing named `MT_KANBAN_*`, whatever put
 * it there.
 */
export function gateEnv(role: Role, parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env = buildEnv(parent, role.agent.env);
  for (const key of Object.keys(env)) if (key.startsWith('MT_KANBAN_')) delete env[key];
  return env;
}

export interface GateContext {
  cwd: string;
  env: Readonly<Record<string, string>>;
  runner: GateRunner;
  clock?: Clock;
  signal?: AbortSignal;
}

/** Whether the gateway has asked for the gates to stop. A function: a narrowed property would not see it change. */
function stopping(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Run the gates in order, stopping at the first that fails, or when the gateway stops. */
export async function runGates(gates: readonly GateRow[], ctx: GateContext): Promise<GateRun> {
  const clock = ctx.clock ?? systemClock;
  const results: GateResult[] = [];
  for (const [i, gate] of gates.entries()) {
    if (stopping(ctx.signal)) {
      return { passed: false, aborted: true, results, notRun: gates.length - i };
    }
    const started = clock.now();
    const exit = await ctx.runner(gate.command, {
      cwd: ctx.cwd,
      env: ctx.env,
      timeoutMs: gate.timeoutS * 1000,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    const result: GateResult = {
      gateId: gate.id,
      command: gate.command,
      exitCode: exit.exitCode,
      signal: exit.signal,
      timedOut: exit.timedOut,
      durationMs: clock.now() - started,
      output: tailBytes(redactKnownSecrets(exit.output), GATE_OUTPUT_BYTES),
    };
    results.push(result);
    const aborted = stopping(ctx.signal);
    if (aborted || exit.timedOut || exit.exitCode !== 0) {
      return { passed: false, aborted, results, notRun: gates.length - i - 1 };
    }
  }
  return { passed: true, aborted: false, results, notRun: 0 };
}

/**
 * The real runner: `/bin/sh -c <command>`, in its own process group, so that a
 * timeout or a stop kills what the gate started too. stdin is closed; stdout and
 * stderr are read together, keeping their last RAW_OUTPUT_BYTES.
 *
 * Once the shell has exited, whatever it left running in its group is killed: a
 * background process holding the gate's output open would otherwise keep the
 * report waiting until the timeout. One that left the group is not waited for:
 * the output is let go of OUTPUT_GRACE_MS after the shell exited.
 */
export const spawnGate: GateRunner = (command, opts) =>
  new Promise<GateExit>((resolve) => {
    const chunks: Buffer[] = [];
    let kept = 0;
    let timedOut = false;
    let settled = false;
    let exited: { code: number | null; signal: string | null } | undefined;
    let killer: NodeJS.Timeout | undefined;
    let letGo: NodeJS.Timeout | undefined;

    const keep = (chunk: Buffer): void => {
      chunks.push(chunk);
      kept += chunk.length;
      while (chunks.length > 1 && kept - (chunks[0]?.length ?? 0) >= RAW_OUTPUT_BYTES) kept -= chunks.shift()?.length ?? 0;
    };
    const text = (): string => {
      const all = Buffer.concat(chunks);
      return all.subarray(Math.max(0, all.length - RAW_OUTPUT_BYTES)).toString('utf8').replace(/^\uFFFD+/, '');
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('/bin/sh', ['-c', command], {
        cwd: opts.cwd,
        env: { ...opts.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      resolve({ exitCode: null, signal: null, timedOut: false, output: `the gate could not start: ${(err as Error).message}` });
      return;
    }
    const pid = child.pid;
    if (pid !== undefined) tracked(pid);
    const group = (sig: NodeJS.Signals): void => {
      try {
        if (pid !== undefined) process.kill(-pid, sig);
      } catch {
        // Gone already.
      }
    };
    const stop = (): void => {
      group('SIGTERM');
      killer ??= setTimeout(() => group('SIGKILL'), KILL_GRACE_MS);
    };
    const finish = (extra?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killer);
      clearTimeout(letGo);
      opts.signal?.removeEventListener('abort', stop);
      group('SIGKILL');
      if (pid !== undefined) running.delete(pid);
      resolve({
        exitCode: exited?.code ?? null,
        signal: exited?.signal ?? null,
        timedOut,
        output: extra === undefined ? text() : `${text()}${extra}`,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs);
    opts.signal?.addEventListener('abort', stop, { once: true });
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.once('error', (err) => finish(`the gate could not start: ${err.message}`));
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      // It ended in time: what follows is not its own running past the timeout.
      clearTimeout(timer);
      // What the gate left behind in its group, holding its output open.
      group('SIGKILL');
      letGo = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, OUTPUT_GRACE_MS);
    });
    child.once('close', () => finish());
  });
```

- [ ] **Step 3.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1078 passed (1078)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  61 passed (61)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 3.5: Commit.**

```bash
git add src/kanban/gates.ts tests/kanban-gates.e2e.ts tests/kanban-gates.test.ts
git commit -m "Run a task's gates as processes, in order, in the workspace, with their role's environment and never a run's"
```

---

### Task 4: The reported commit

**Files:**
- Create: `src/kanban/commit.ts`, `tests/kanban-commit.e2e.ts`, `tests/kanban-commit.test.ts`

`src/kanban/commit.ts` (spec §7.8; Decision 11): `commitReader` reads `HEAD` and `git status --porcelain` through an injected `GitExec`, asynchronously; `execGit` is the real one, `execFile` with a 10 s timeout and `-c core.fsmonitor=false`, so a workspace's own configuration cannot make `git status` run a program. No `HEAD` is no commit and uncommitted; a status that fails is uncommitted. `describeReported` is spec §7.8's wording. `tests/kanban-commit.e2e.ts` runs real git in temporary repositories, with a made-up home.

- [ ] **Step 4.1: Write the failing tests.**

Create `tests/kanban-commit.e2e.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitReader } from '../src/kanban/commit.js';

/** The reported commit against real git (spec §7.8, §11): clean, dirty, and not a repository. */

let dir: string;
/** git's environment: a made-up home, so no test reads the real one's configuration. */
let env: Record<string, string>;

function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-commit-')));
  env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: dir };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('commitReader with git', () => {
  it('reads a clean tree as its commit, and a changed one as uncommitted changes on top of it', async () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    sh(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    sh(repo, 'add', 'a.txt');
    sh(repo, 'commit', '-q', '-m', 'first');
    const head = sh(repo, 'rev-parse', 'HEAD');
    const read = commitReader();
    expect(await read(repo, { env })).toEqual({ commit: head, dirty: false });
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    expect(await read(repo, { env })).toEqual({ commit: head, dirty: true });
  });

  it("never runs the workspace's fsmonitor hook", async () => {
    const repo = join(dir, 'hooked');
    mkdirSync(repo);
    sh(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    sh(repo, 'add', 'a.txt');
    sh(repo, 'commit', '-q', '-m', 'first');
    const marker = join(dir, 'fsmonitor-ran');
    const hook = join(dir, 'fsmonitor.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    sh(repo, 'config', 'core.fsmonitor', hook);
    expect(await commitReader()(repo, { env })).toMatchObject({ dirty: false });
    expect(existsSync(marker)).toBe(false);
  });

  it('reads a directory that is not a repository, or one with no commit yet, as uncommitted with no commit', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    sh(empty, 'init', '-q');
    // Never the repository above the temporary directory, if there is one.
    const outside = { ...env, GIT_CEILING_DIRECTORIES: dir };
    expect(await commitReader()(plain, { env: outside })).toEqual({ commit: null, dirty: true });
    expect(await commitReader()(empty, { env: outside })).toEqual({ commit: null, dirty: true });
  });
});
```

Create `tests/kanban-commit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { commitReader, describeReported, type GitExec, type GitOptions } from '../src/kanban/commit.js';

/** Reading the reported commit (spec §7.8), over a git that starts nothing: each command's answer, as scripted. */

const SHA = '0123456789abcdef0123456789abcdef01234567';

function git(answers: Record<string, { code: number | null; stdout: string }>) {
  const calls: Array<{ args: readonly string[] } & GitOptions> = [];
  const exec: GitExec = async (args, opts) => {
    calls.push({ args, ...opts });
    return answers[args.join(' ')] ?? { code: 1, stdout: '' };
  };
  return { exec, calls };
}

const HEAD = 'rev-parse --verify --quiet HEAD^{commit}';
const STATUS = '--no-optional-locks status --porcelain';

describe('the reported commit', () => {
  it('records HEAD and a clean tree, reading in the workspace with the environment given', async () => {
    const { exec, calls } = git({ [HEAD]: { code: 0, stdout: `${SHA}\n` }, [STATUS]: { code: 0, stdout: '' } });
    const env = { PATH: '/usr/bin' };
    expect(await commitReader(exec)('/ws/web', { env })).toEqual({ commit: SHA, dirty: false });
    expect(calls.map((c) => [c.args.join(' '), c.cwd, c.env, c.timeoutMs])).toEqual([
      [HEAD, '/ws/web', env, 10_000],
      [STATUS, '/ws/web', env, 10_000],
    ]);
  });

  it('records uncommitted changes on top of HEAD', async () => {
    const { exec } = git({ [HEAD]: { code: 0, stdout: SHA }, [STATUS]: { code: 0, stdout: ' M src/a.ts\n?? b.ts\n' } });
    expect(await commitReader(exec)('/ws', { env: {} })).toEqual({ commit: SHA, dirty: true });
  });

  it('records no commit, and uncommitted, outside a repository or when git fails', async () => {
    const outside = git({ [HEAD]: { code: 128, stdout: '' } });
    expect(await commitReader(outside.exec)('/ws', { env: {} })).toEqual({ commit: null, dirty: true });
    expect(outside.calls).toHaveLength(1);
    const odd = git({ [HEAD]: { code: 0, stdout: 'HEAD' } });
    expect(await commitReader(odd.exec)('/ws', { env: {} })).toEqual({ commit: null, dirty: true });
    const noStatus = git({ [HEAD]: { code: 0, stdout: SHA }, [STATUS]: { code: null, stdout: '' } });
    expect(await commitReader(noStatus.exec)('/ws', { env: {} })).toEqual({ commit: SHA, dirty: true });
  });

  it('says what a reviewer reviews', () => {
    expect(describeReported({ reportedCommit: SHA, reportedDirty: false })).toBe(`review commit ${SHA}`);
    expect(describeReported({ reportedCommit: SHA, reportedDirty: true })).toBe(`uncommitted changes on top of ${SHA}`);
    expect(describeReported({ reportedCommit: null, reportedDirty: true })).toBe('uncommitted; no commit to review');
    expect(describeReported({ reportedCommit: null, reportedDirty: null })).toBeUndefined();
  });
});
```

- [ ] **Step 4.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-commit.test.ts`. Expected: the file FAILS to load, with `Error: Cannot find module '../src/kanban/commit.js' imported from '…/tests/kanban-commit.test.ts'`. `Tests  no tests`.

- [ ] **Step 4.3: Implement.**

Create `src/kanban/commit.ts`:

```ts
import { execFile } from 'node:child_process';

/**
 * The reported commit (spec §7.8): when an agent reports `complete` or `review`,
 * the gateway reads, in the run's workspace, `HEAD` and whether the working tree
 * has uncommitted changes, before the transaction that decides the run, so they
 * describe the state the report was made in. They are facts the gateway
 * observes, not the agent's word: its summary can say what it changed, not
 * reliably which state it left.
 *
 * A workspace that is not a git repository, or where git fails, has no commit,
 * and counts as uncommitted.
 */

/** What a report recorded of its workspace: `HEAD`, or null when there is none; and uncommitted changes. */
export interface ReportedState {
  commit: string | null;
  dirty: boolean;
}

export interface GitOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Runs one git command: its exit code, null when it did not exit by itself, and its stdout. Never rejects. */
export type GitExec = (args: readonly string[], opts: GitOptions) => Promise<{ code: number | null; stdout: string }>;

/** Reads a workspace's state. Never rejects. */
export type CommitReader = (
  cwd: string,
  opts: { env: Readonly<Record<string, string>>; signal?: AbortSignal },
) => Promise<ReportedState>;

/** How long one git command may take: a report waits for it. */
const GIT_TIMEOUT_MS = 10_000;
/** A whole commit id, SHA-1 or SHA-256. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The real `git`, asynchronously: a report must not hold up the gateway. */
export const execGit: GitExec = (args, opts) =>
  new Promise((resolve) => {
    execFile(
      'git',
      // A workspace's own configuration must not run a program: no fsmonitor hook.
      ['-c', 'core.fsmonitor=false', ...args],
      {
        cwd: opts.cwd,
        env: { ...opts.env },
        timeout: opts.timeoutMs,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      },
      (err, stdout) => {
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : null;
        resolve({ code, stdout: typeof stdout === 'string' ? stdout : '' });
      },
    );
  });

/**
 * A reader over `exec`: `git rev-parse` for HEAD, then `git status --porcelain`,
 * which takes no lock (`--no-optional-locks`), so reading never gets in the way
 * of the agent's own git. No HEAD -- not a repository, no commit yet, git
 * missing or failing -- is no commit, and uncommitted. A status that fails
 * counts as uncommitted too: nobody can say the tree is clean.
 */
export function commitReader(exec: GitExec = execGit): CommitReader {
  return async (cwd, opts) => {
    const git = (args: readonly string[]) =>
      exec(args, {
        cwd,
        env: opts.env,
        timeoutMs: GIT_TIMEOUT_MS,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
    const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    const commit = head.stdout.trim();
    if (head.code !== 0 || !COMMIT_ID.test(commit)) return { commit: null, dirty: true };
    const status = await git(['--no-optional-locks', 'status', '--porcelain']);
    return { commit, dirty: status.code !== 0 || status.stdout.trim() !== '' };
  };
}

/**
 * What a reviewer is told to review (spec §7.8), from what the report recorded;
 * undefined when nothing was: a person's report, or a run from before plan C4.
 */
export function describeReported(state: { reportedCommit: string | null; reportedDirty: boolean | null }): string | undefined {
  const { reportedCommit: commit, reportedDirty: dirty } = state;
  if (commit === null) return dirty === true ? 'uncommitted; no commit to review' : undefined;
  return dirty === true ? `uncommitted changes on top of ${commit}` : `review commit ${commit}`;
}
```

- [ ] **Step 4.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1082 passed (1082)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  64 passed (64)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 4.5: Commit.**

```bash
git add src/kanban/commit.ts tests/kanban-commit.e2e.ts tests/kanban-commit.test.ts
git commit -m "Read the commit a report was made on, and whether the tree had uncommitted changes, without blocking"
```

---

### Task 5: A report's checks: the commit, then the gates

**Files:**
- Create: `tests/kanban-report-checks.test.ts`
- Modify: `src/db/kanban-read.ts`, `src/db/kanban.ts`, `src/kanban/service.ts`, `src/kanban/types.ts`, `src/kanban/worker.ts`

The heart of C4 (spec §7.7, §7.8; Decisions 5, 6, 8–11). `KanbanService` gains `checks` (`ReportChecks`): the workspaces' directories, the gateway's environment, and the injectable runner and git. `complete` and `requestReview` go through `#report`: the board's checks without writing (`reportCheck`, new in `db/kanban.ts`), the commit for an agent's report, the gates, recorded as a `gates_ran` event (`recordGates`), and then the transition, which checks everything again. A report in flight is held in a map with its task's workspace, which refuses a second report on the task, a claim of the task, and a claim of another task in that workspace; `settled(taskId)` waits for it (Task 7 uses it). A refusal carries the failing gate (`Refusal.gate`), and the worker API answers it in snake_case. A workspace directory that is gone refuses the report by name, rather than let the runner fail on `/bin/sh`. The worker API also passes an abort signal through to the service, which Task 6's socket gives it.

- [ ] **Step 5.1: Write the failing tests.**

Create `tests/kanban-report-checks.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventsOf, getRun, getTask, lastGateRun } from '../src/db/kanban-read.js';
import type { CommitReader, ReportedState } from '../src/kanban/commit.js';
import type { GateExit, GateRunOptions } from '../src/kanban/gates.js';
import { KanbanService, type CreateRequest } from '../src/kanban/service.js';
import { hashToken, mintToken } from '../src/kanban/token.js';
import type { Reporter, RunRow, TaskRow } from '../src/kanban/types.js';
import { WorkerApi } from '../src/kanban/worker.js';
import type { Role } from '../src/roles.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * A report's checks (spec §7.7, §7.8): the task's gates, run before complete or
 * review is accepted, whoever reports; and, for an agent's report, the state of
 * its workspace. Over a runner and a git that start no process.
 */

const SHA = '0123456789abcdef0123456789abcdef01234567';
const PARENT_ENV = { PATH: '/usr/bin', HOME: '/home/mt', LARK_APP_SECRET: 'lark-secret-123', MT_KANBAN_TOKEN: 'tok' };

function withKey(name: string, key: string): Role {
  const base = role(name);
  return { ...base, agent: { ...base.agent, env: { API_KEY: key } } };
}

const ROLES = new Map(
  [withKey('default', 'key-default'), withKey('implementer', 'key-implementer'), withKey('reviewer', 'key-reviewer')].map(
    (r) => [r.name, r],
  ),
);
const DIRS = new Map([...WORKSPACES].map((w) => [w, `/ws/${w}`]));

interface Gated {
  t: TestDb;
  s: KanbanService;
  /** Every gate run: its command, where, and the role's key it had. */
  ran: Array<{ command: string; cwd: string; key: string | undefined; env: Readonly<Record<string, string>> }>;
  /** Every workspace read for a commit. */
  read: Array<{ cwd: string; env: Readonly<Record<string, string>> }>;
  /** How the next gates exit, by command; a command missing exits 0. */
  exits: Map<string, Partial<GateExit>>;
  /** A gate held until the test lets it go. */
  hold(command: string): { started: Promise<void>; release(exit?: Partial<GateExit>): void };
  state: ReportedState;
  /** Called as a commit is read. */
  onRead?: () => void;
  create(req?: Partial<CreateRequest>): TaskRow;
  claim(taskId: string): RunRow;
}

let g: Gated;

function gated(): Gated {
  const t = testDb();
  const held = new Map<string, { started: () => void; gate: Promise<Partial<GateExit>> }>();
  const out: Gated = {
    t,
    s: undefined as unknown as KanbanService,
    ran: [],
    read: [],
    exits: new Map(),
    hold(command) {
      let started!: () => void;
      let release!: (exit: Partial<GateExit>) => void;
      const startedP = new Promise<void>((resolve) => (started = resolve));
      held.set(command, { started, gate: new Promise((resolve) => (release = resolve)) });
      return { started: startedP, release: (exit = {}) => release(exit) };
    },
    state: { commit: SHA, dirty: false },
    create(req = {}) {
      const r = out.s.create({ title: 'a task', assignee: 'implementer', workspace: 'web', createdBy: ALICE, createdVia: VIA, ...req });
      if (!r.ok) throw new Error(r.message);
      return r.task;
    },
    claim(taskId) {
      const r = out.s.claim(taskId);
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      return r.run;
    },
  };
  const runGate = async (command: string, opts: GateRunOptions): Promise<GateExit> => {
    out.ran.push({ command, cwd: opts.cwd, key: opts.env['API_KEY'], env: opts.env });
    const h = held.get(command);
    let exit: Partial<GateExit> = out.exits.get(command) ?? {};
    if (h !== undefined) {
      held.delete(command);
      h.started();
      exit = await h.gate;
    }
    return { exitCode: 0, signal: null, timedOut: false, output: '', ...exit };
  };
  const readCommit: CommitReader = async (cwd, opts) => {
    out.read.push({ cwd, env: opts.env });
    out.onRead?.();
    return out.state;
  };
  out.s = new KanbanService({
    db: t.db,
    roles: ROLES,
    workspaces: WORKSPACES,
    clock: new ManualClock(),
    checks: { workspaceDirs: DIRS, env: PARENT_ENV, runGate, readCommit },
  });
  return out;
}

const person: Reporter = { kind: 'person', principal: ALICE };
const as = (run: RunRow): Reporter => ({ kind: 'run', runId: run.runId });

beforeEach(() => {
  clearSecrets();
  g = gated();
});
afterEach(() => {
  clearSecrets();
  g.t.close();
});

describe('gates on complete and review', () => {
  it("runs an agent's gates in the workspace, as its role, and records the run and the commit", async () => {
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const run = g.claim(task.taskId);

    expect(await g.s.complete(task.taskId, as(run), { summary: 'done' })).toMatchObject({
      ok: true,
      task: { phase: 'done' },
      run: { outcome: 'completed', reportedCommit: SHA, reportedDirty: false },
    });
    expect(g.ran).toEqual([
      {
        command: 'npm test',
        cwd: '/ws/web',
        key: 'key-implementer',
        env: { PATH: '/usr/bin', HOME: '/home/mt', API_KEY: 'key-implementer' },
      },
    ]);
    // The commit is read with what an agent is given of the gateway's environment, and no more.
    expect(g.read).toEqual([{ cwd: '/ws/web', env: { PATH: '/usr/bin', HOME: '/home/mt' } }]);
    expect(lastGateRun(g.t.db, task.taskId)).toMatchObject({
      runId: run.runId,
      actor: `run:${run.runId}`,
      for: 'complete',
      passed: true,
      aborted: false,
      notRun: 0,
      results: [{ command: 'npm test', exitCode: 0, timedOut: false }],
    });
  });

  it('refuses a report whose gate fails, with the gate, its exit and its output, and leaves the run undecided', async () => {
    addSecrets(['sk-live-1234567890']);
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    g.s.addGate(task.taskId, { command: 'npm run lint' }, ALICE);
    const run = g.claim(task.taskId);
    g.exits.set('npm test', { exitCode: 1, output: 'FAIL parser.test.ts with sk-live-1234567890' });

    expect(await g.s.complete(task.taskId, as(run), { summary: 'done' })).toEqual({
      ok: false,
      code: 'gate_failed',
      message: 'gate "npm test" exited 1; the report was not applied: fix it and report again',
      gate: { command: 'npm test', exitCode: 1, signal: null, timedOut: false, output: `FAIL parser.test.ts with ${MASK}` },
    });
    expect(g.ran.map((r) => r.command)).toEqual(['npm test']);
    expect(getRun(g.t.db, run.runId)?.outcome).toBeNull();
    expect(getTask(g.t.db, task.taskId)?.phase).toBe('open');
    expect(lastGateRun(g.t.db, task.taskId)).toMatchObject({
      passed: false,
      notRun: 1,
      results: [{ exitCode: 1, output: `FAIL parser.test.ts with ${MASK}` }],
    });

    g.exits.clear();
    expect(await g.s.complete(task.taskId, as(run), { summary: 'fixed' })).toMatchObject({ ok: true, task: { phase: 'done' } });
    expect(eventsOf(g.t.db, task.taskId).filter((e) => e.kind === 'gates_ran')).toHaveLength(2);
  });

  it('says how a gate that timed out or could not start refused the report', async () => {
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test', timeoutS: 120 }, ALICE);
    const run = g.claim(task.taskId);
    g.exits.set('npm test', { exitCode: null, signal: 'SIGTERM', timedOut: true });
    expect(await g.s.complete(task.taskId, as(run), { summary: 'done' })).toMatchObject({
      code: 'gate_failed',
      message: 'gate "npm test" ran past its 120 s; the report was not applied: fix it and report again',
    });
    g.exits.set('npm test', { exitCode: null, signal: null, output: 'the gate could not start: spawn /bin/sh ENOENT' });
    expect(await g.s.complete(task.taskId, as(run), { summary: 'done' })).toMatchObject({
      code: 'gate_failed',
      message: 'gate "npm test" could not start; the report was not applied: fix it and report again',
    });
  });

  it("runs gates for an implementer's review as the implementer, and for a reviewer's approval as the reviewer", async () => {
    const task = g.create({ reviewer: 'reviewer' });
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const work = g.claim(task.taskId);
    expect(await g.s.requestReview(task.taskId, as(work), { summary: 'have a look' })).toMatchObject({
      ok: true,
      run: { outcome: 'review_requested', reportedCommit: SHA },
    });
    g.s.closeRun(work.runId);
    const review = g.claim(task.taskId);
    g.state = { commit: null, dirty: true };
    expect(await g.s.complete(task.taskId, as(review), { summary: 'LGTM' })).toMatchObject({
      ok: true,
      run: { kind: 'review', outcome: 'completed', reportedCommit: null, reportedDirty: true },
    });
    expect(g.ran.map((r) => r.key)).toEqual(['key-implementer', 'key-reviewer']);
    expect(lastGateRun(g.t.db, task.taskId)).toMatchObject({ for: 'complete', runId: review.runId });
  });

  it("runs a person's gates as the latest agent run's role, or default, and reads no commit for them", async () => {
    const reviewed = g.create({ reviewer: 'reviewer' });
    g.s.addGate(reviewed.taskId, { command: 'npm test' }, ALICE);
    const work = g.claim(reviewed.taskId);
    expect((await g.s.requestReview(reviewed.taskId, as(work), { summary: 'v1' })).ok).toBe(true);
    g.s.closeRun(work.runId);
    expect(await g.s.complete(reviewed.taskId, person, { summary: 'approved' })).toMatchObject({ ok: true, run: undefined });

    const untouched = g.create();
    g.s.addGate(untouched.taskId, { command: 'make check' }, ALICE);
    expect((await g.s.complete(untouched.taskId, person, { summary: 'done by hand' })).ok).toBe(true);

    expect(g.ran.map((r) => [r.command, r.key])).toEqual([
      ['npm test', 'key-implementer'],
      ['npm test', 'key-implementer'],
      ['make check', 'key-default'],
    ]);
    expect(g.read).toHaveLength(1);
    expect(lastGateRun(g.t.db, untouched.taskId)).toMatchObject({ runId: null, actor: ALICE });
  });

  it('runs nothing for a report the board would refuse anyway', async () => {
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const run = g.claim(task.taskId);
    expect(await g.s.complete(task.taskId, person, { summary: 'done' })).toMatchObject({ code: 'agent_run_open' });
    expect(await g.s.requestReview(task.taskId, as(run), { summary: 'v1' })).toMatchObject({ code: 'no_reviewer' });
    expect((await g.s.complete(task.taskId, as(run), { summary: 'done' })).ok).toBe(true);
    expect(await g.s.complete(task.taskId, as(run), { summary: 'again' })).toMatchObject({ code: 'already_reported' });
    expect(g.ran).toHaveLength(1);
    expect(g.read).toHaveLength(1);
  });

  it('refuses a report whose gates cannot run, saying why, rather than run them elsewhere or as someone else', async () => {
    const made = g.s.create({ title: 'no workspace yet', assignee: 'implementer', createdBy: ALICE, createdVia: VIA });
    if (!made.ok) throw new Error(made.message);
    const nowhere = made.task;
    g.s.addGate(nowhere.taskId, { command: 'npm test' }, ALICE);
    expect(await g.s.complete(nowhere.taskId, person, { summary: 'done' })).toEqual({
      ok: false,
      code: 'gates_cannot_run',
      message: `task ${nowhere.taskId} has gates and no workspace to run them in; set its workspace first`,
    });

    // The same board, as a gateway whose configuration has changed would see it.
    const changed = (roles: ReadonlyMap<string, Role>, dirs: ReadonlyMap<string, string>) =>
      new KanbanService({ db: g.t.db, roles, workspaces: WORKSPACES, checks: { workspaceDirs: dirs, env: PARENT_ENV } });
    const onlyDefault = new Map([['default', withKey('default', 'k')]]);
    const gone = g.create({ workspace: 'api' });
    g.s.addGate(gone.taskId, { command: 'npm test' }, ALICE);
    expect(await changed(onlyDefault, new Map([['web', '/ws/web']])).complete(gone.taskId, person, { summary: 'done' })).toEqual({
      ok: false,
      code: 'gates_cannot_run',
      message: `task ${gone.taskId}'s workspace "api" is no longer configured, so its gates cannot run`,
    });

    const worked = g.create();
    g.s.addGate(worked.taskId, { command: 'npm test' }, ALICE);
    const run = g.claim(worked.taskId);
    expect(await changed(onlyDefault, DIRS).complete(worked.taskId, as(run), { summary: 'done' })).toMatchObject({
      code: 'gates_cannot_run',
      message: `task ${worked.taskId}'s gates run with the environment of role "implementer", which is no longer configured`,
    });

    const unchecked = new KanbanService({ db: g.t.db, roles: ROLES, workspaces: WORKSPACES });
    expect(await unchecked.complete(worked.taskId, as(run), { summary: 'done' })).toMatchObject({
      code: 'gates_cannot_run',
      message: `task ${worked.taskId} has gates, and this gateway runs none`,
    });
    expect(getRun(g.t.db, run.runId)?.outcome).toBeNull();
  });
});

describe('a report while its gates run', () => {
  it('refuses a second report on the task, and a claim, until the first has its answer', async () => {
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const run = g.claim(task.taskId);
    const held = g.hold('npm test');
    const first = g.s.complete(task.taskId, as(run), { summary: 'done' });
    await held.started;

    expect(await g.s.complete(task.taskId, as(run), { summary: 'done' })).toEqual({
      ok: false,
      code: 'report_in_progress',
      message:
        `task ${task.taskId} is being reported on already, and its gates are running; ` +
        'wait for that answer, or see mt kanban show',
    });
    const other = g.create();
    g.s.addGate(other.taskId, { command: 'npm test' }, ALICE);
    const otherHeld = g.hold('npm test');
    const person1 = g.s.complete(other.taskId, person, { summary: 'done' });
    await otherHeld.started;
    expect(g.s.claim(other.taskId)).toEqual({
      ok: false,
      code: 'not_claimable',
      message: `task ${other.taskId} is being reported on: its gates are running`,
    });
    otherHeld.release();
    expect((await person1).ok).toBe(true);

    held.release();
    expect(await first).toMatchObject({ ok: true, task: { phase: 'done' } });
  });

  it('claims no other task in the workspace whose gates are running, and any in another', async () => {
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const held = g.hold('npm test');
    const report = g.s.complete(task.taskId, person, { summary: 'done' });
    await held.started;
    const same = g.create({ title: 'same checkout' });
    const other = g.create({ title: 'another checkout', workspace: 'api' });
    expect(g.s.claim(same.taskId)).toEqual({
      ok: false,
      code: 'not_claimable',
      message: `workspace web is running the gates of a report on task ${task.taskId}`,
    });
    expect(g.s.claim(other.taskId).ok).toBe(true);
    held.release();
    expect((await report).ok).toBe(true);
    expect(g.s.claim(same.taskId).ok).toBe(true);
  });

  it('settles once the report is answered', async () => {
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const run = g.claim(task.taskId);
    await g.s.settled(task.taskId);
    const held = g.hold('npm test');
    const report = g.s.complete(task.taskId, as(run), { summary: 'done' });
    await held.started;
    let settled = false;
    const waiting = g.s.settled(task.taskId).then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    held.release();
    await waiting;
    expect(getRun(g.t.db, run.runId)?.outcome).toBe('completed');
    expect((await report).ok).toBe(true);
  });

  it('applies nothing for a run decided while its gates ran: the board checks again after them', async () => {
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const run = g.claim(task.taskId);
    const held = g.hold('npm test');
    const report = g.s.complete(task.taskId, as(run), { summary: 'done' });
    await held.started;
    expect(g.s.endRun(run.runId, { outcome: 'timed_out', error: 'past its limit' }).ok).toBe(true);
    held.release();
    expect(await report).toMatchObject({ ok: false, code: 'run_superseded' });
    expect(getRun(g.t.db, run.runId)?.outcome).toBe('timed_out');
    expect(lastGateRun(g.t.db, task.taskId)).toMatchObject({ passed: true });
  });

  it('applies nothing once the gateway stops while the gates run', async () => {
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    g.s.addGate(task.taskId, { command: 'npm run lint' }, ALICE);
    const run = g.claim(task.taskId);
    const held = g.hold('npm test');
    const stopping = new AbortController();
    const report = g.s.complete(task.taskId, as(run), { summary: 'done' }, { signal: stopping.signal });
    await held.started;
    stopping.abort();
    held.release({ exitCode: null, signal: 'SIGTERM' });
    expect(await report).toEqual({
      ok: false,
      code: 'gates_cannot_run',
      message: 'the gateway is stopping, so the gates did not finish and the report was not applied; report again once it is back',
    });
    expect(getRun(g.t.db, run.runId)?.outcome).toBeNull();
    expect(lastGateRun(g.t.db, task.taskId)).toMatchObject({ passed: false, aborted: true, notRun: 1 });
  });
});

describe('a report while the gateway stops', () => {
  it('applies nothing when the stop comes as the commit is read, with no gate to notice it', async () => {
    const task = g.create();
    const run = g.claim(task.taskId);
    const stopping = new AbortController();
    g.onRead = () => stopping.abort();
    expect(await g.s.complete(task.taskId, as(run), { summary: 'done' }, { signal: stopping.signal })).toEqual({
      ok: false,
      code: 'gates_cannot_run',
      message: 'the gateway is stopping, so the gates did not finish and the report was not applied; report again once it is back',
    });
    expect(getRun(g.t.db, run.runId)?.outcome).toBeNull();
  });
});

describe("a workspace's directory that is gone", () => {
  it('refuses the report, naming the directory, rather than run a gate that cannot start', async () => {
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const message = `task ${task.taskId}'s workspace directory /ws/web does not exist`;
    const missing = new KanbanService({
      db: g.t.db,
      roles: ROLES,
      workspaces: WORKSPACES,
      checks: {
        workspaceDirs: DIRS,
        env: PARENT_ENV,
        runGate: async () => ({ exitCode: 0, signal: null, timedOut: false, output: '' }),
        isDirectory: () => false,
      },
    });
    const refused = { ok: false, code: 'gates_cannot_run', message };
    expect(await missing.complete(task.taskId, person, { summary: 'done' })).toEqual(refused);
    // The real runner's default: the filesystem, which has no /ws/web. Nothing is started.
    const real = new KanbanService({
      db: g.t.db,
      roles: ROLES,
      workspaces: WORKSPACES,
      checks: { workspaceDirs: DIRS, env: PARENT_ENV },
    });
    expect(await real.complete(task.taskId, person, { summary: 'done' })).toEqual(refused);
    expect(getTask(g.t.db, task.taskId)?.phase).toBe('open');
  });
});

describe('a gate refusal through the worker API', () => {
  it('carries the failing command, its exit code and the end of its output', async () => {
    const api = new WorkerApi({ db: g.t.db, service: g.s });
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const token = mintToken();
    const claimed = g.s.claim(task.taskId, { tokenHash: hashToken(token) });
    if (!claimed.ok) throw new Error(claimed.message);
    g.exits.set('npm test', { exitCode: 1, output: '1 failing' });
    const input = { summary: 'v1', reviewer: 'reviewer' };
    expect(await api.handle({ run: claimed.run.runId, token, command: 'review', input })).toEqual({
      ok: false,
      code: 'gate_failed',
      message: 'gate "npm test" exited 1; the report was not applied: fix it and report again',
      gate: { command: 'npm test', exit_code: 1, signal: null, timed_out: false, output: '1 failing' },
    });
  });
});
```

- [ ] **Step 5.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-report-checks.test.ts`. Expected: all fifteen FAIL. The reports are accepted without their gates — `AssertionError: expected { ok: true, task: { …(26) }, …(1) } to deeply equal { ok: false, …(2) }` and the like — nothing is run (`AssertionError: expected [] to have a length of 1 but got +0`), `TypeError: g.s.settled is not a function`, and the four tests that hold a gate time out, `Error: Test timed out in 10000ms.`, since no gate ever runs to be released. `Tests  15 failed (15)`; the run takes about 40 s.

- [ ] **Step 5.3: Implement.**

In `src/db/kanban-read.ts`, replace:

```ts
}

/** The task as `/kanban show` and `mt kanban show` present it. */
export interface TaskView {
```

with:

```ts
}

/** A report's run of the task's gates, as its `gates_ran` event recorded it (spec §7.7). */
export interface LastGateRun {
  /** The run that reported; null for a person. */
  runId: string | null;
  actor: string;
  for: 'complete' | 'review';
  passed: boolean;
  aborted: boolean;
  notRun: number;
  results: Array<{
    gateId: number;
    command: string;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    durationMs: number;
    output: string;
  }>;
  at: number;
}

/** The latest run of the task's gates, if they ever ran: the prompt's "last gate run" (spec §7.1). */
export function lastGateRun(db: Db, taskId: string): LastGateRun | undefined {
  const row = db
    .prepare<[string], EventRaw>(
      `SELECT id, task_id, run_id, kind, actor, json(payload) AS payload, created_at
         FROM kanban_events WHERE task_id = ? AND kind = 'gates_ran' ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId);
  if (row === undefined) return undefined;
  const payload = json(row.payload) as Omit<LastGateRun, 'runId' | 'actor' | 'at'>;
  return { ...payload, runId: row.run_id, actor: row.actor, at: row.created_at };
}

/** The task as `/kanban show` and `mt kanban show` present it. */
export interface TaskView {
```

In `src/db/kanban.ts`, replace:

```ts
import { newRunId, newTaskId } from '../core/ids.js';
import { redactKnownSecrets, redactValues } from '../secrets.js';
import { resolveTaskWorkspace } from '../kanban/workspace.js';
import { ENDED_OUTCOMES, GATE_LIMITS, REPORTED_OUTCOMES } from '../kanban/types.js';
```

with:

```ts
import { newRunId, newTaskId } from '../core/ids.js';
import { redactKnownSecrets, redactValues } from '../secrets.js';
import type { GateRun } from '../kanban/gates.js';
import { resolveTaskWorkspace } from '../kanban/workspace.js';
import { ENDED_OUTCOMES, GATE_LIMITS, REPORTED_OUTCOMES } from '../kanban/types.js';
```

In `src/db/kanban.ts`, replace:

```ts

/**
 * The one way to `done` (spec §5.1): an agent's or reviewer's `complete`, a
 * person's done or approval. Gates run before it, from plan C4.
 *
 * Completion resets the breaker's counters, and is the only report that does
```

with:

```ts

/**
 * Whether a report would be accepted now, checked as complete() and
 * requestReview() check it, and writing nothing: the service asks before it runs
 * a report's gates, so that a report the board would refuse -- a second report, a
 * person's while an agent works -- runs none. The transition checks it all again
 * in its own transaction, after the gates, since anything can change while they
 * run: the run may be decided, the task archived.
 */
export function reportCheck(
  db: Db,
  taskId: string,
  by: Reporter,
  kind: 'complete' | 'review',
  reviewer?: Assignee,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  const r =
    kind === 'complete'
      ? reporting(db, taskId, by, ['open', 'review'], 'be completed')
      : reporting(db, taskId, by, ['open'], 'ask for review');
  if (!r.ok) return r;
  if (!parentsOf(db, taskId).every((p) => isFinished(p.phase))) {
    return refuse('parents_unfinished', `task ${taskId} has a parent that is not done`);
  }
  if (kind === 'review' && (reviewer ?? r.task.reviewer) === null) {
    return refuse('no_reviewer', `nobody is named to review task ${taskId}`);
  }
  return r;
}

/**
 * Record a report's run of the task's gates (spec §7.7), passed or not: each is
 * an event, whether the report then goes through or not. The output is masked,
 * as every payload is.
 */
export function recordGates(
  db: Db,
  taskId: string,
  by: { runId: string | null; actor: string },
  kind: 'complete' | 'review',
  ran: GateRun,
  now: number,
): void {
  txImmediate(db, (d) =>
    record(
      d,
      {
        taskId,
        runId: by.runId,
        kind: 'gates_ran',
        actor: by.actor,
        payload: { for: kind, passed: ran.passed, aborted: ran.aborted, notRun: ran.notRun, results: ran.results },
      },
      now,
    ),
  );
}

/**
 * The one way to `done` (spec §5.1): an agent's or reviewer's `complete`, a
 * person's done or approval. The service runs the task's gates before it.
 *
 * Completion resets the breaker's counters, and is the only report that does
```

In `src/db/kanban.ts`, replace:

```ts
 * nobody to review it is stranded under another label. A task whose parents are
 * not all finished is refused, as complete() refuses it: the work being reviewed
 * was meant to wait for them. Gates run before it, from plan C4.
 */
export function requestReview(
```

with:

```ts
 * nobody to review it is stranded under another label. A task whose parents are
 * not all finished is refused, as complete() refuses it: the work being reviewed
 * was meant to wait for them. The service runs the task's gates before it.
 */
export function requestReview(
```

In `src/kanban/service.ts`, replace:

```ts
import type { Db } from '../db/open.js';
import * as board from '../db/kanban.js';
import { gatesOf, getRun, getTask, taskView, type TaskView } from '../db/kanban-read.js';
import { redactKnownSecrets } from '../secrets.js';
import type { Role } from '../roles.js';
import { stripControl } from '../text.js';
import { systemClock, type Clock } from '../time.js';
import {
  BLOCK_KINDS,
```

with:

```ts
import type { Db } from '../db/open.js';
import * as board from '../db/kanban.js';
import { gatesOf, getRun, getTask, runsOf, taskView, type TaskView } from '../db/kanban-read.js';
import { buildEnv } from '../driver/env.js';
import { redactKnownSecrets } from '../secrets.js';
import type { Role } from '../roles.js';
import { stripControl } from '../text.js';
import { systemClock, type Clock } from '../time.js';
import { commitReader, type CommitReader } from './commit.js';
import { gateEnv, runGates, spawnGate, type GateResult, type GateRunner } from './gates.js';
import {
  BLOCK_KINDS,
```

In `src/kanban/service.ts`, replace:

```ts
}

export interface KanbanServiceDeps {
  db: Db;
```

with:

```ts
}

/**
 * What a report's checks need (spec §7.7, §7.8): where each workspace is, and the
 * gateway's own environment, of which a gate and git get only what an agent
 * would. The runner and the reader are injected so the unit tests start no
 * process; absent, they are the real ones.
 */
export interface ReportChecks {
  /** Each configured workspace's directory, by name. */
  workspaceDirs: ReadonlyMap<string, string>;
  env: Readonly<Record<string, string | undefined>>;
  runGate?: GateRunner;
  readCommit?: CommitReader;
  /**
   * Whether a workspace's directory is there to run gates in. Absent, the
   * filesystem says, for the real runner; a runner given in its place stands in
   * for the filesystem too.
   */
  isDirectory?: (dir: string) => boolean;
}

function directoryExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export interface KanbanServiceDeps {
  db: Db;
```

In `src/kanban/service.ts`, replace:

```ts
  /** Accept roles whose agent asks for approval. Plan D's, once approvals reach a subscriber. */
  supervisedRoles?: boolean;
}

```

with:

```ts
  /** Accept roles whose agent asks for approval. Plan D's, once approvals reach a subscriber. */
  supervisedRoles?: boolean;
  /**
   * How a report's gates run and its commit is read. Absent -- tests of the board
   * alone -- no commit is read, and a task with gates cannot complete.
   */
  checks?: ReportChecks;
}

/** A report's options: aborted when the gateway stops, which kills its gates and applies nothing. */
export interface ReportOptions {
  signal?: AbortSignal;
}

/** Whose environment a task's gates run with when no agent has run on it (spec §7.7). */
const DEFAULT_ROLE = 'default';

/** A report the gateway stopped in the middle of: nothing was applied. */
const STOPPING =
  'the gateway is stopping, so the gates did not finish and the report was not applied; report again once it is back';

/** Why a gate refused the report, in a few words. */
function verdict(r: GateResult, timeoutS: number): string {
  if (r.timedOut) return `ran past its ${timeoutS} s`;
  if (r.exitCode !== null) return `exited ${r.exitCode}`;
  return r.signal === null ? 'could not start' : `was ended by ${r.signal}`;
}

```

In `src/kanban/service.ts`, replace:

```ts
  readonly #people: People | undefined;
  readonly #supervisedRoles: boolean;

  constructor(deps: KanbanServiceDeps) {
```

with:

```ts
  readonly #people: People | undefined;
  readonly #supervisedRoles: boolean;
  readonly #checks: ReportChecks | undefined;
  /**
   * Tasks a report is running its checks for, with the task's workspace and the
   * report's end. One at a time per task: a second report would run the same
   * gates again, at once, in the same checkout. And no claim meanwhile, of the
   * task or of another in that workspace, which would start an agent in a
   * checkout being tested.
   */
  readonly #reporting = new Map<string, { workspace: string | null; done: Promise<unknown> }>();

  constructor(deps: KanbanServiceDeps) {
```

In `src/kanban/service.ts`, replace:

```ts
    this.#people = deps.people;
    this.#supervisedRoles = deps.supervisedRoles ?? false;
  }

```

with:

```ts
    this.#people = deps.people;
    this.#supervisedRoles = deps.supervisedRoles ?? false;
    this.#checks = deps.checks;
  }

```

In `src/kanban/service.ts`, replace:

```ts
      return board.refuse('illegal_transition', `task ${taskId} is ${task.phase}, so it cannot be claimed`);
    }
    const resolved = this.#claimant(task);
    const r = resolved.ok
```

with:

```ts
      return board.refuse('illegal_transition', `task ${taskId} is ${task.phase}, so it cannot be claimed`);
    }
    if (this.#reporting.has(taskId)) {
      return board.refuse('not_claimable', `task ${taskId} is being reported on: its gates are running`);
    }
    const testing = task.workspace === null ? undefined : this.#reportingIn(task.workspace);
    if (testing !== undefined) {
      return board.refuse(
        'not_claimable',
        `workspace ${task.workspace ?? ''} is running the gates of a report on task ${testing}`,
      );
    }
    const resolved = this.#claimant(task);
    const r = resolved.ok
```

In `src/kanban/service.ts`, replace:

```ts
      role: resolved.ok ? resolved.role : undefined,
    };
  }

```

with:

```ts
      role: resolved.ok ? resolved.role : undefined,
    };
  }

  /**
   * Once no report on the task is running its checks: at once, if none is. The
   * dispatcher waits for it before it decides a run whose turn ended, since the
   * report may be about to decide it.
   */
  async settled(taskId: string): Promise<void> {
    await this.#reporting.get(taskId)?.done.catch(() => undefined);
  }

  /** A task whose report is running its checks in this workspace, if any. */
  #reportingIn(workspace: string): string | undefined {
    for (const [taskId, r] of this.#reporting) if (r.workspace === workspace) return taskId;
    return undefined;
  }

```

In `src/kanban/service.ts`, replace:

```ts
    by: Reporter,
    handoff: board.Handoff,
  ): Promise<Result<{ task: TaskRow; run: RunRow | undefined }>> {
    const refused = idsRefused(taskId) ?? handoffRefused(by, handoff);
    if (refused !== undefined) return refused;
    return board.complete(this.#db, taskId, by, handoff, this.#clock.now());
  }

```

with:

```ts
    by: Reporter,
    handoff: board.Handoff,
    opts: ReportOptions = {},
  ): Promise<Result<{ task: TaskRow; run: RunRow | undefined }>> {
    const refused = idsRefused(taskId) ?? handoffRefused(by, handoff);
    if (refused !== undefined) return refused;
    return this.#report(taskId, by, 'complete', undefined, opts, (seen) =>
      board.complete(this.#db, taskId, by, { ...handoff, ...seen }, this.#clock.now()),
    );
  }

```

In `src/kanban/service.ts`, replace:

```ts
    by: Reporter,
    handoff: board.Handoff & { reviewer?: string },
  ): Promise<Result<{ task: TaskRow; run: RunRow | undefined }>> {
    const refused = idsRefused(taskId) ?? handoffRefused(by, handoff);
    if (refused !== undefined) return refused;
    const { reviewer, ...rest } = handoff;
    if (reviewer === undefined) return board.requestReview(this.#db, taskId, by, rest, this.#clock.now());
    const who = this.#assignable(reviewer);
    if (!who.ok) return who;
    return board.requestReview(this.#db, taskId, by, { ...rest, reviewer: who.assignee }, this.#clock.now());
  }

```

with:

```ts
    by: Reporter,
    handoff: board.Handoff & { reviewer?: string },
    opts: ReportOptions = {},
  ): Promise<Result<{ task: TaskRow; run: RunRow | undefined }>> {
    const refused = idsRefused(taskId) ?? handoffRefused(by, handoff);
    if (refused !== undefined) return refused;
    const { reviewer, ...rest } = handoff;
    let named: Assignee | undefined;
    if (reviewer !== undefined) {
      const who = this.#assignable(reviewer);
      if (!who.ok) return who;
      named = who.assignee;
    }
    return this.#report(taskId, by, 'review', named, opts, (seen) =>
      board.requestReview(
        this.#db,
        taskId,
        by,
        { ...rest, ...seen, ...(named === undefined ? {} : { reviewer: named }) },
        this.#clock.now(),
      ),
    );
  }

  /**
   * A report's checks, then the report (spec §7.7, §7.8). First whether the board
   * would take it now, so a report it would refuse runs nothing; then, for an
   * agent's report, the state of its workspace, read before anything else can
   * change it; then the task's gates, each recorded, and any failure refusing the
   * report with the run left undecided, so the agent can fix it and report again.
   * Then the transition, which checks everything again in its own transaction:
   * the run may have been decided while the gates ran.
   */
  async #report<T extends object>(
    taskId: string,
    by: Reporter,
    kind: 'complete' | 'review',
    reviewer: Assignee | undefined,
    opts: ReportOptions,
    apply: (seen: { reportedCommit?: string | null; reportedDirty?: boolean | null }) => Result<T>,
  ): Promise<Result<T>> {
    if (this.#reporting.has(taskId)) {
      return board.refuse(
        'report_in_progress',
        `task ${taskId} is being reported on already, and its gates are running; wait for that answer, or see mt kanban show`,
      );
    }
    const now = board.reportCheck(this.#db, taskId, by, kind, reviewer);
    if (!now.ok) return now;
    const checked = (async (): Promise<Result<T>> => {
      const seen = await this.#observe(now.run, opts.signal);
      const gates = await this.#gates(now.task, by, now.run, kind, opts.signal);
      if (!gates.ok) return gates;
      // Stopped while the commit was read, with no gate to notice: what was read may be cut short.
      if (opts.signal?.aborted === true) return board.refuse('gates_cannot_run', STOPPING);
      return apply(seen);
    })();
    this.#reporting.set(taskId, { workspace: now.task.workspace, done: checked });
    try {
      return await checked;
    } finally {
      this.#reporting.delete(taskId);
    }
  }

  /**
   * The reported commit (spec §7.8): for an agent's report, its workspace's HEAD
   * and whether the tree had uncommitted changes. A person's report records
   * neither: there is no agent state to pin.
   */
  async #observe(
    run: RunRow | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ reportedCommit?: string | null; reportedDirty?: boolean | null }> {
    const checks = this.#checks;
    if (checks === undefined || run === undefined || run.agentConfig === null || run.workspace === null) return {};
    const dir = checks.workspaceDirs.get(run.workspace);
    if (dir === undefined) return {};
    const read = checks.readCommit ?? commitReader();
    const state = await read(dir, { env: buildEnv(checks.env), ...(signal === undefined ? {} : { signal }) });
    return { reportedCommit: state.commit, reportedDirty: state.dirty };
  }

  /**
   * Run the task's gates, if it has any (spec §7.7): in its workspace, with the
   * environment of the role of its latest agent run -- the reporting run's, if it
   * is an agent's -- or of the role default if no agent has run on it. A gate that
   * cannot run -- no workspace, a workspace or role no longer configured -- refuses
   * the report with the reason, rather than running elsewhere or as someone else.
   */
  async #gates(
    task: TaskRow,
    by: Reporter,
    run: RunRow | undefined,
    kind: 'complete' | 'review',
    signal: AbortSignal | undefined,
  ): Promise<Result<object>> {
    const gates = gatesOf(this.#db, task.taskId);
    if (gates.length === 0) return { ok: true };
    const id = task.taskId;
    const checks = this.#checks;
    if (checks === undefined) return board.refuse('gates_cannot_run', `task ${id} has gates, and this gateway runs none`);
    if (task.workspace === null) {
      return board.refuse('gates_cannot_run', `task ${id} has gates and no workspace to run them in; set its workspace first`);
    }
    const cwd = checks.workspaceDirs.get(task.workspace);
    if (cwd === undefined) {
      return board.refuse(
        'gates_cannot_run',
        `task ${id}'s workspace ${JSON.stringify(task.workspace)} is no longer configured, so its gates cannot run`,
      );
    }
    const latest = runsOf(this.#db, id).findLast((r) => r.agentConfig !== null);
    const name = latest?.assignee.name ?? DEFAULT_ROLE;
    const role = this.#roles.get(name);
    if (role === undefined) {
      return board.refuse(
        'gates_cannot_run',
        `task ${id}'s gates run with the environment of role ${JSON.stringify(name)}, which is no longer configured`,
      );
    }
    const isDirectory = checks.isDirectory ?? (checks.runGate === undefined ? directoryExists : () => true);
    if (!isDirectory(cwd)) {
      // Said plainly: the runner would only report /bin/sh missing.
      return board.refuse('gates_cannot_run', `task ${id}'s workspace directory ${cwd} does not exist`);
    }
    const ran = await runGates(gates, {
      cwd,
      env: gateEnv(role, checks.env),
      runner: checks.runGate ?? spawnGate,
      clock: this.#clock,
      ...(signal === undefined ? {} : { signal }),
    });
    board.recordGates(
      this.#db,
      id,
      { runId: run?.runId ?? null, actor: by.kind === 'run' ? `run:${by.runId}` : by.principal },
      kind,
      ran,
      this.#clock.now(),
    );
    if (ran.passed) return { ok: true };
    if (ran.aborted) return board.refuse('gates_cannot_run', STOPPING);
    const failed = ran.results.at(-1);
    if (failed === undefined) throw new Error('gates that did not pass ran none');
    const timeoutS = gates.find((g) => g.id === failed.gateId)?.timeoutS ?? 0;
    return {
      ok: false,
      code: 'gate_failed',
      message:
        `gate ${JSON.stringify(failed.command)} ${verdict(failed, timeoutS)}; ` +
        'the report was not applied: fix it and report again',
      gate: {
        command: failed.command,
        exitCode: failed.exitCode,
        signal: failed.signal,
        timedOut: failed.timedOut,
        output: failed.output,
      },
    };
  }

```

In `src/kanban/types.ts`, replace:

```ts
  | 'undecided'
  | 'already_closed'
  | 'no_open_run';

export interface Refusal {
```

with:

```ts
  | 'undecided'
  | 'already_closed'
  | 'no_open_run'
  /** A gate exited non-zero or ran past its timeout: the report was not applied (spec §7.7). */
  | 'gate_failed'
  /** The task has gates that cannot run now: no workspace, or no role to run them as, or the gateway stopping. */
  | 'gates_cannot_run'
  /** A report on the task is still running its gates. */
  | 'report_in_progress';

/** The gate that refused a report, as the reporter is shown it (spec §7.7). */
export interface FailedGate {
  command: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** The end of its output, masked. */
  output: string;
}

export interface Refusal {
```

In `src/kanban/types.ts`, replace:

```ts
  code: RefusalCode;
  message: string;
}

```

with:

```ts
  code: RefusalCode;
  message: string;
  /** For `gate_failed`: the gate, its exit and the end of its output. */
  gate?: FailedGate;
}

```

In `src/kanban/worker.ts`, replace:

```ts
import type { KanbanService } from './service.js';
import { hashToken, sameHash, TOKEN_PATTERN } from './token.js';
import { REPORTED_OUTCOMES, type Assignee, type RefusalCode, type Reporter, type Result, type RunRow } from './types.js';

/**
```

with:

```ts
import type { KanbanService } from './service.js';
import { hashToken, sameHash, TOKEN_PATTERN } from './token.js';
import {
  REPORTED_OUTCOMES,
  type Assignee,
  type FailedGate,
  type RefusalCode,
  type Reporter,
  type Result,
  type RunRow,
} from './types.js';

/**
```

In `src/kanban/worker.ts`, replace:

```ts
  | 'internal';

export type WorkerResponse = ({ ok: true } & Record<string, unknown>) | { ok: false; code: WorkerCode; message: string };

export interface WorkerApiDeps {
```

with:

```ts
  | 'internal';

export type WorkerResponse =
  | ({ ok: true } & Record<string, unknown>)
  | {
      ok: false;
      code: WorkerCode;
      message: string;
      /** For `gate_failed` (spec §7.7): the failing command, its exit, and the end of its output. */
      gate?: { command: string; exit_code: number | null; signal: string | null; timed_out: boolean; output: string };
    };

/** A request's options: aborted when the gateway stops, as the socket closes. */
export interface HandleOptions {
  signal?: AbortSignal;
}

export interface WorkerApiDeps {
```

In `src/kanban/worker.ts`, replace:

```ts
   * report waits for its task's gates (spec §7.7).
   */
  async handle(raw: unknown): Promise<WorkerResponse> {
    try {
      return await this.#handle(raw);
    } catch {
      // Not quoted: an error here can carry anything, the request included.
```

with:

```ts
   * report waits for its task's gates (spec §7.7).
   */
  async handle(raw: unknown, opts: HandleOptions = {}): Promise<WorkerResponse> {
    try {
      return await this.#handle(raw, opts);
    } catch {
      // Not quoted: an error here can carry anything, the request included.
```

In `src/kanban/worker.ts`, replace:

```ts
  }

  async #handle(raw: unknown): Promise<WorkerResponse> {
    if (!isRecord(raw)) return refused('bad_request', 'a request is a JSON object');
    for (const key of Object.keys(raw)) {
```

with:

```ts
  }

  async #handle(raw: unknown, opts: HandleOptions): Promise<WorkerResponse> {
    if (!isRecord(raw)) return refused('bad_request', 'a request is a JSON object');
    for (const key of Object.keys(raw)) {
```

In `src/kanban/worker.ts`, replace:

```ts
    const bad = badInput(command, input);
    if (bad !== undefined) return bad;
    const r = await this.#act(command, run, input);
    if (r.ok && command !== 'show') this.#changed();
    return r;
  }

  async #act(command: WorkerCommand, run: RunRow, input: Record<string, unknown>): Promise<WorkerResponse> {
    const by: Reporter = { kind: 'run', runId: run.runId };
    const actor = `run:${run.runId}`;
```

with:

```ts
    const bad = badInput(command, input);
    if (bad !== undefined) return bad;
    const r = await this.#act(command, run, input, opts);
    if (r.ok && command !== 'show') this.#changed();
    return r;
  }

  async #act(
    command: WorkerCommand,
    run: RunRow,
    input: Record<string, unknown>,
    opts: HandleOptions,
  ): Promise<WorkerResponse> {
    const by: Reporter = { kind: 'run', runId: run.runId };
    const actor = `run:${run.runId}`;
```

In `src/kanban/worker.ts`, replace:

```ts
    const ids = (key: string): readonly string[] | undefined => input[key] as readonly string[] | undefined;
    const metadata = input['metadata'] === undefined || input['metadata'] === null ? {} : { metadata: input['metadata'] };
    switch (command) {
      case 'show':
        return this.#show(run);
      case 'complete':
        return reported(await this.#service.complete(run.taskId, by, { summary: str('summary') ?? '', ...metadata }));
      case 'review': {
        const reviewer = str('reviewer');
        return reported(
          await this.#service.requestReview(run.taskId, by, {
            summary: str('summary') ?? '',
            ...metadata,
            ...(reviewer === undefined ? {} : { reviewer }),
          }),
        );
      }
```

with:

```ts
    const ids = (key: string): readonly string[] | undefined => input[key] as readonly string[] | undefined;
    const metadata = input['metadata'] === undefined || input['metadata'] === null ? {} : { metadata: input['metadata'] };
    const signal = opts.signal === undefined ? {} : { signal: opts.signal };
    switch (command) {
      case 'show':
        return this.#show(run);
      case 'complete':
        return reported(
          await this.#service.complete(run.taskId, by, { summary: str('summary') ?? '', ...metadata }, signal),
        );
      case 'review': {
        const reviewer = str('reviewer');
        return reported(
          await this.#service.requestReview(
            run.taskId,
            by,
            { summary: str('summary') ?? '', ...metadata, ...(reviewer === undefined ? {} : { reviewer }) },
            signal,
          ),
        );
      }
```

In `src/kanban/worker.ts`, replace:

```ts
}

function refusal(r: { ok: false; code: RefusalCode; message: string }): WorkerResponse {
  return { ok: false, code: r.code, message: r.message };
}

```

with:

```ts
}

function refusal(r: { ok: false; code: RefusalCode; message: string; gate?: FailedGate }): WorkerResponse {
  if (r.gate === undefined) return { ok: false, code: r.code, message: r.message };
  const g = r.gate;
  return {
    ok: false,
    code: r.code,
    message: r.message,
    gate: { command: g.command, exit_code: g.exitCode, signal: g.signal, timed_out: g.timedOut, output: g.output },
  };
}

```

- [ ] **Step 5.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1097 passed (1097)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 5.5: Commit.**

```bash
git add src/db/kanban-read.ts src/db/kanban.ts src/kanban/service.ts src/kanban/types.ts src/kanban/worker.ts tests/kanban-report-checks.test.ts
git commit -m "Run a task's gates, and read the reported commit, before every complete and review, and refuse a report whose gate fails"
```

---

### Task 6: The socket drains on close

**Files:**
- Modify: `src/index.ts`, `src/kanban/socket.ts`, `tests/kanban-report-checks.test.ts`, `tests/kanban-socket.test.ts`

C3's note (Decision 13): `close()` dropped every connection, so a report could be applied while its client saw `unreachable`. `listenWorker`'s handler now gets an `AbortSignal`; `close()` stops listening, drops the connections that have sent no request, aborts the signal, waits up to `drainMs` for the requests being handled, then drops the rest and says how many went unanswered. The gateway passes the signal to the worker API, so a report whose gates are running is stopped, applies nothing, and is answered; and its `stop()` now closes the socket before it drains the dispatcher, since that drain waits for such a report (Decision 13). The new test in `tests/kanban-report-checks.test.ts` passes already: the worker API took the signal in Task 5.

- [ ] **Step 6.1: Write the failing tests.**

In `tests/kanban-report-checks.test.ts`, replace:

```ts
    });
  });
});

```

with:

```ts
    });
  });
});

describe('a report through the worker API while the gateway stops', () => {
  it('is told so, and applies nothing', async () => {
    const api = new WorkerApi({ db: g.t.db, service: g.s });
    const task = g.create();
    g.s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const token = mintToken();
    const claimed = g.s.claim(task.taskId, { tokenHash: hashToken(token) });
    if (!claimed.ok) throw new Error(claimed.message);
    const stopping = new AbortController();
    stopping.abort();
    const request = { run: claimed.run.runId, token, command: 'complete', input: { summary: 'done' } };
    expect(await api.handle(request, { signal: stopping.signal })).toMatchObject({ ok: false, code: 'gates_cannot_run' });
    expect(g.ran).toEqual([]);
    expect(getRun(g.t.db, claimed.run.runId)?.outcome).toBeNull();
  });
});

```

In `tests/kanban-socket.test.ts`, replace:

```ts
});

describe('worker socket: its path', () => {
  it('removes a stale socket of its own, and refuses a live one, a file, or a directory that is a symlink', async () => {
```

with:

```ts
});

describe('worker socket: closing', () => {
  /** A connection that has sent nothing: whether the server has dropped it. */
  function idle(path: string): Promise<'closed'> {
    return new Promise((resolve) => {
      const socket = createConnection(path);
      socket.on('error', () => undefined);
      socket.on('close', () => resolve('closed'));
    });
  }

  it('answers a request still being handled before it goes: the handler is told the gateway is stopping', async () => {
    let started: () => void = () => undefined;
    const handling = new Promise<void>((resolve) => (started = resolve));
    const server = await listenWorker(sockPath(), async (_req, signal) => {
      started();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      return { ok: false, code: 'gates_cannot_run', message: 'stopping' };
    });
    const reply = send(server.path, '{"command":"complete"}\n');
    await handling;
    const waiting = idle(server.path);
    await server.close();
    expect(JSON.parse(await reply)).toEqual({ ok: false, code: 'gates_cannot_run', message: 'stopping' });
    expect(await waiting).toBe('closed');
    expect(existsSync(server.path)).toBe(false);
  });

  it('drops a request whose handler does not answer within the drain, and says so', async () => {
    const notes: string[] = [];
    let started: () => void = () => undefined;
    const handling = new Promise<void>((resolve) => (started = resolve));
    const server = await listenWorker(
      sockPath(),
      async () => {
        started();
        await new Promise<void>(() => undefined);
      },
      { drainMs: 50, note: (line) => notes.push(line) },
    );
    const reply = send(server.path, '{}\n');
    await handling;
    await server.close();
    expect(await reply).toBe('');
    expect(notes).toEqual(['kanban: the worker socket closed with 1 request(s) unanswered']);
  });
});

describe('worker socket: its path', () => {
  it('removes a stale socket of its own, and refuses a live one, a file, or a directory that is a symlink', async () => {
```

- [ ] **Step 6.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-socket.test.ts tests/kanban-report-checks.test.ts`. Expected: the two new socket tests FAIL: the handler's answer is lost, `SyntaxError: Unexpected end of JSON input`, and nothing says a request went unanswered, `AssertionError: expected [] to deeply equal [ Array(1) ]`. `Tests  2 failed | 33 passed (35)`.

- [ ] **Step 6.3: Implement.**

In `src/index.ts`, replace:

```ts
      if (worker !== undefined) {
        const { api, socket } = worker;
        workerServer = await listenWorker(socket, (request) => api.handle(request), { note });
        note(`kanban: runs report through ${socket}`);
      }
```

with:

```ts
      if (worker !== undefined) {
        const { api, socket } = worker;
        // A report still running its gates when the gateway stops is told so, and answered.
        workerServer = await listenWorker(socket, (request, signal) => api.handle(request, { signal }), { note });
        note(`kanban: runs report through ${socket}`);
      }
```

In `src/index.ts`, replace:

```ts
      // survives it; a failed final write is logged, not fatal.
      await registry.closeAll();
      // Then what the dispatcher still has running -- an archive, a close -- so
      // none of it touches the database after it is closed. Bounded: a start that
```

with:

```ts
      // survives it; a failed final write is logged, not fatal.
      await registry.closeAll();
      // No agent is left to report. A report still running its gates is stopped
      // and answered here, before the dispatcher's drain, which waits for it.
      await workerServer?.close();
      // Then what the dispatcher still has running -- an archive, a close -- so
      // none of it touches the database after it is closed. Bounded: a start that
```

In `src/index.ts`, replace:

```ts
        note('kanban: stopped with run work still pending; the next boot ends those runs');
      }
      // No agent is left to report; and none may reach a closed database.
      await workerServer?.close();
      db.close();
      // Last: until here, this gateway still had the home's sessions and runs.
```

with:

```ts
        note('kanban: stopped with run work still pending; the next boot ends those runs');
      }
      db.close();
      // Last: until here, this gateway still had the home's sessions and runs.
```

In `src/kanban/socket.ts`, replace:

```ts
 * value by value (spec §10.1), so neither a live token nor a known secret leaves
 * in a response, whatever the handler put in it.
 */

```

with:

```ts
 * value by value (spec §10.1), so neither a live token nor a known secret leaves
 * in a response, whatever the handler put in it.
 *
 * **Closing drains.** A request being handled when the socket closes -- a report
 * waiting for its gates -- is told the gateway is stopping, through the signal
 * its handler was given, and its answer is sent before the connection goes. A
 * client that saw only a dropped connection would try again, and could be told
 * `already_reported` about a report it never heard was applied.
 */

```

In `src/kanban/socket.ts`, replace:

```ts
  /** Connections served at once; more wait in the kernel's backlog. */
  maxConnections?: number;
  /** Metadata only. */
  note?: (line: string) => void;
```

with:

```ts
  /** Connections served at once; more wait in the kernel's backlog. */
  maxConnections?: number;
  /** How long closing waits for the requests being handled to be answered. */
  drainMs?: number;
  /** Metadata only. */
  note?: (line: string) => void;
```

In `src/kanban/socket.ts`, replace:

```ts
export interface WorkerServer {
  readonly path: string;
  /** Stop listening, drop every open connection, and remove the socket. */
  close(): Promise<void>;
}
```

with:

```ts
export interface WorkerServer {
  readonly path: string;
  /**
   * Stop listening, drop every connection that has not sent a request, tell the
   * handlers of the rest the gateway is stopping, wait up to `drainMs` for their
   * answers, then drop whatever is left, and remove the socket.
   */
  close(): Promise<void>;
}
```

In `src/kanban/socket.ts`, replace:

```ts
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONNECTIONS = 64;

function bytes(s: string): number {
```

with:

```ts
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_DRAIN_MS = 10_000;

function bytes(s: string): number {
```

In `src/kanban/socket.ts`, replace:

```ts
}

/** Listen at `path` and answer each request with what `handle` returns. */
export async function listenWorker(
  path: string,
  handle: (request: unknown) => unknown,
  opts: WorkerServerOptions = {},
): Promise<WorkerServer> {
  const maxBytes = opts.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const note = opts.note ?? (() => undefined);
  await claimSocketPath(path);

  const sockets = new Set<Socket>();
  // Half-open, so a client that ends its side after the request still gets the answer.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // A client that goes away is its own business; an error must not reach the process.
    socket.on('error', () => undefined);
```

with:

```ts
}

/**
 * Listen at `path` and answer each request with what `handle` returns. `signal`
 * is aborted when the socket closes, so a handler still at work can stop and say so.
 */
export async function listenWorker(
  path: string,
  handle: (request: unknown, signal: AbortSignal) => unknown,
  opts: WorkerServerOptions = {},
): Promise<WorkerServer> {
  const maxBytes = opts.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const drainMs = opts.drainMs ?? DEFAULT_DRAIN_MS;
  const note = opts.note ?? (() => undefined);
  await claimSocketPath(path);

  const sockets = new Set<Socket>();
  /** Connections whose request is with the handler, or whose answer is going out. */
  const busy = new Set<Socket>();
  let drained: (() => void) | undefined;
  const stopping = new AbortController();
  // Half-open, so a client that ends its side after the request still gets the answer.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
      busy.delete(socket);
      if (busy.size === 0) drained?.();
    });
    // A client that goes away is its own business; an error must not reach the process.
    socket.on('error', () => undefined);
```

In `src/kanban/socket.ts`, replace:

```ts
      if (nl === -1) return;
      read = true;
      // Read; what is left is the handler's, however long it takes. Once it has
      // answered, the linger bounds the connection again.
```

with:

```ts
      if (nl === -1) return;
      read = true;
      busy.add(socket);
      // Read; what is left is the handler's, however long it takes. Once it has
      // answered, the linger bounds the connection again.
```

In `src/kanban/socket.ts`, replace:

```ts
      }
      Promise.resolve()
        .then(() => handle(request))
        .then(
          (response) => reply(response),
```

with:

```ts
      }
      Promise.resolve()
        .then(() => handle(request, stopping.signal))
        .then(
          (response) => reply(response),
```

In `src/kanban/socket.ts`, replace:

```ts
    path,
    close() {
      closing ??= new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        // Node removes the socket file when it stops listening.
        server.close(() => resolve());
      });
      return closing;
    },
```

with:

```ts
    path,
    close() {
      closing ??= (async () => {
        // Node removes the socket file when it stops listening, once every connection has gone.
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const socket of sockets) if (!busy.has(socket)) socket.destroy();
        stopping.abort();
        if (busy.size > 0) {
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([
            new Promise<void>((resolve) => (drained = resolve)),
            new Promise<void>((resolve) => (timer = setTimeout(resolve, drainMs))),
          ]);
          clearTimeout(timer);
          if (busy.size > 0) note(`kanban: the worker socket closed with ${busy.size} request(s) unanswered`);
        }
        for (const socket of sockets) socket.destroy();
        await closed;
      })();
      return closing;
    },
```

- [ ] **Step 6.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1100 passed (1100)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 6.5: Commit.**

```bash
git add src/index.ts src/kanban/socket.ts tests/kanban-report-checks.test.ts tests/kanban-socket.test.ts
git commit -m "Drain the worker socket on close: a report still running its gates is told the gateway is stopping, and answered"
```

---

### Task 7: A turn that ends while its report runs

**Files:**
- Create: `tests/kanban-dispatch-gates.test.ts`
- Modify: `src/kanban/dispatcher.ts`, `tests/helpers/dispatch.ts`

An agent's shell may give up on `mt kanban` while the gates run — some agents bound a command to two minutes — and the agent may then end its turn. C3's dispatcher would nudge it, or end the run `protocol_violation` and free its workspace while the gates still run there. Now the dispatcher waits for the service to settle the task's report before it follows a turn up or decides the run (spec §7.7): the report may yet decide it. A dispatcher stopped while it waited decides nothing: the next boot ends the run. The dispatch harness takes `checks`, so a test can hold a gate.

- [ ] **Step 7.1: Write the failing tests.**

In `tests/helpers/dispatch.ts`, replace:

```ts
import { getRun } from '../../src/db/kanban-read.js';
import { Dispatcher, type DispatcherSettings, type WorkerAccess } from '../../src/kanban/dispatcher.js';
import { KanbanService, type CreateRequest } from '../../src/kanban/service.js';
import { KanbanSink } from '../../src/kanban/sink.js';
import type { RunRow, TaskRow } from '../../src/kanban/types.js';
```

with:

```ts
import { getRun } from '../../src/db/kanban-read.js';
import { Dispatcher, type DispatcherSettings, type WorkerAccess } from '../../src/kanban/dispatcher.js';
import { KanbanService, type CreateRequest, type ReportChecks } from '../../src/kanban/service.js';
import { KanbanSink } from '../../src/kanban/sink.js';
import type { RunRow, TaskRow } from '../../src/kanban/types.js';
```

In `tests/helpers/dispatch.ts`, replace:

```ts
  /** The socket and the mt directory a run is given; absent, neither is. */
  worker?: WorkerAccess;
}

```

with:

```ts
  /** The socket and the mt directory a run is given; absent, neither is. */
  worker?: WorkerAccess;
  /** How the service runs gates and reads commits; absent, it does neither. */
  checks?: ReportChecks;
}

```

In `tests/helpers/dispatch.ts`, replace:

```ts
  const drivers = new Map([...roles.keys(), 'default'].map((name) => [name, new FakeDriver(name)]));
  const workspaces = new Map(['default', 'web', 'api', 'docs'].map((name) => [name, `/tmp/ws-${name}`]));
  const service = new KanbanService({ db: t.db, roles, workspaces: new Set(workspaces.keys()), clock });
  const lark = new FakeChannel({ id: 'lark', clock });
  const notes: string[] = [];
```

with:

```ts
  const drivers = new Map([...roles.keys(), 'default'].map((name) => [name, new FakeDriver(name)]));
  const workspaces = new Map(['default', 'web', 'api', 'docs'].map((name) => [name, `/tmp/ws-${name}`]));
  const service = new KanbanService({
    db: t.db,
    roles,
    workspaces: new Set(workspaces.keys()),
    clock,
    ...(opts.checks === undefined ? {} : { checks: opts.checks }),
  });
  const lark = new FakeChannel({ id: 'lark', clock });
  const notes: string[] = [];
```

Create `tests/kanban-dispatch-gates.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import type { GateExit } from '../src/kanban/gates.js';
import { clearSecrets } from '../src/secrets.js';
import { ALICE } from './helpers/kanban.js';
import { dispatchHarness, role, until, type DispatchHarness } from './helpers/dispatch.js';

/**
 * A run whose turn ends while its report is running the task's gates (spec
 * §7.7): its agent's shell gave up on `mt kanban` waiting for them. The
 * dispatcher waits for the report before it nudges or decides the run.
 */

const open: DispatchHarness[] = [];

beforeEach(() => clearSecrets());
afterEach(() => {
  clearSecrets();
  while (open.length > 0) open.pop()?.close();
});

/** A harness whose gates are held until the test lets them go. */
function gated(nudgeLimit: number) {
  let started = false;
  let release: (exit: Partial<GateExit>) => void = () => undefined;
  const gate = new Promise<Partial<GateExit>>((resolve) => (release = resolve));
  const h = dispatchHarness({
    roles: [role('default'), role('implementer')],
    settings: { nudgeLimit },
    checks: {
      workspaceDirs: new Map([['web', '/tmp/ws-web']]),
      env: {},
      runGate: async () => {
        started = true;
        return { exitCode: 0, signal: null, timedOut: false, output: '', ...(await gate) };
      },
      readCommit: async () => ({ commit: null, dirty: true }),
    },
  });
  open.push(h);
  return { h, started: () => started, release };
}

describe('a turn that ends while its report runs the gates', () => {
  it('sends no nudge, and decides nothing, until the report is answered: here it is applied', async () => {
    const { h, started, release } = gated(1);
    const task = h.create({ workspace: 'web' });
    expect(h.service.addGate(task.taskId, { command: 'npm test' }, ALICE).ok).toBe(true);
    const implementer = h.driver('implementer');
    implementer.scripts.push((ctl) => {
      const runId = ctl.env?.['MT_KANBAN_RUN'] ?? '';
      // The agent's shell gave up on the command; the report goes on.
      void h.service.complete(task.taskId, { kind: 'run', runId }, { summary: 'done' });
      ctl.end('completed');
    });

    h.dispatcher.pass();
    await until(started, 'the gates to run');
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(implementer.lastRuntime?.prompts).toHaveLength(1);
    expect(runsOf(h.t.db, task.taskId)[0]?.outcome).toBeNull();

    release({});
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, task.taskId).map((r) => [r.outcome, r.submissions])).toEqual([['completed', 1]]);
    expect(getTask(h.t.db, task.taskId)?.phase).toBe('done');
  });

  it('nudges once the report is refused, as for any turn that ended without a report', async () => {
    const { h, started, release } = gated(1);
    const task = h.create({ workspace: 'web' });
    expect(h.service.addGate(task.taskId, { command: 'npm test' }, ALICE).ok).toBe(true);
    const implementer = h.driver('implementer');
    implementer.scripts.push((ctl) => {
      const runId = ctl.env?.['MT_KANBAN_RUN'] ?? '';
      void h.service.complete(task.taskId, { kind: 'run', runId }, { summary: 'done' });
      ctl.end('completed');
    });

    h.dispatcher.pass();
    await until(started, 'the gates to run');
    release({ exitCode: 1, output: 'FAIL' });
    await h.dispatcher.idle();
    const [run] = runsOf(h.t.db, task.taskId);
    expect(run).toMatchObject({ outcome: 'protocol_violation', submissions: 2 });
    expect(implementer.lastRuntime?.prompts[1]?.text).toContain('(reminder 1 of 1)');
  });
});
```

- [ ] **Step 7.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-dispatch-gates.test.ts`. Expected: the first test FAILS, with `AssertionError: expected [ { …(2) }, { …(2) } ] to have a length of 1 but got 2`: a nudge went out while the gates ran. The second passes already. `Tests  1 failed | 1 passed (2)`.

- [ ] **Step 7.3: Implement.**

In `src/kanban/dispatcher.ts`, replace:

```ts
      // the same session, until the run reports or the nudges run out (spec §7.5).
      while (terminal === 'completed') {
        const next = this.#followUp(open);
        if (next === undefined) break;
```

with:

```ts
      // the same session, until the run reports or the nudges run out (spec §7.5).
      while (terminal === 'completed') {
        // A report still running its gates may yet decide the run (spec §7.7).
        await this.#deps.service.settled(run.taskId);
        const next = this.#followUp(open);
        if (next === undefined) break;
```

In `src/kanban/dispatcher.ts`, replace:

```ts
    // run was decided before it, and the release closes it.
    if (open.released) return;
    const run = getRun(this.#deps.db, open.runId);
    if (run !== undefined && run.outcome === null) {
```

with:

```ts
    // run was decided before it, and the release closes it.
    if (open.released) return;
    // A turn can end while its report runs the task's gates: its agent's shell
    // gave up on `mt kanban` waiting for them. The report may yet decide the run,
    // and the run holds the workspace the gates run in, so it is waited for.
    await this.#deps.service.settled(open.key.conversationId);
    // Stopped while it waited: the next boot ends the run.
    if (this.#stopped) return;
    const run = getRun(this.#deps.db, open.runId);
    if (run !== undefined && run.outcome === null) {
```

- [ ] **Step 7.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1102 passed (1102)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 7.5: Commit.**

```bash
git add src/kanban/dispatcher.ts tests/helpers/dispatch.ts tests/kanban-dispatch-gates.test.ts
git commit -m "Wait for a report still running its gates before nudging or deciding a run whose turn has ended"
```

---

### Task 8: A rework's seed, settled after the render

**Files:**
- Modify: `src/db/kanban.ts`, `src/kanban/dispatcher.ts`, `tests/kanban-dispatch-native.test.ts`, `tests/kanban-rendering.test.ts`

Plan R's note (spec §5.3; Decision 12): seed a rework only from a run with the same native-ness and package hash. The claim cannot know the rework's package, so `recordRendering`, which the dispatcher calls once the render is decided and before it creates the session, drops a seed whose work run was given its role another way, and says so in its event. The dispatcher seeds the session from the run `recordRendering` returns.

- [ ] **Step 8.1: Write the failing tests.**

In `tests/kanban-dispatch-native.test.ts`, replace:

```ts
  });

  it("copies a role's imported skills into its package, or lists them in the prompt when it is not rendered", async () => {
    // A made-up home's user skill, imported by name, as startup would load it.
```

with:

```ts
  });

  it("resumes a native rework's conversation only from the package the work ran: an edited role.md starts fresh", async () => {
    for (const edited of [false, true]) {
      const r = implementer();
      const h = harness({ roles: [r, role('reviewer')], renderRoot: root });
      const task = h.create({ workspace: 'web', reviewer: 'reviewer' });
      const agent = h.driver('implementer');
      agent.providerSessionId = 'prov_impl';
      agent.scripts.push(async (ctl) => {
        const run = h.runOf(agent);
        expect((await h.service.requestReview(task.taskId, { kind: 'run', runId: run.runId }, { summary: 'v1' })).ok).toBe(true);
        ctl.end('completed');
      });
      h.driver('reviewer').scripts.push((ctl) => {
        // Edited while the review runs: the rework's package is a new one.
        if (edited) writeFileSync(r.roleMdPath ?? '', 'You change code, and you test it.\n');
        const run = h.runOf(h.driver('reviewer'));
        expect(h.service.requestChanges(task.taskId, { kind: 'run', runId: run.runId }, 'add a test').ok).toBe(true);
        ctl.end('completed');
      });
      completes(h, agent);
      h.dispatcher.pass();
      await h.dispatcher.idle();

      const runs = runsOf(h.t.db, task.taskId);
      expect(runs.map((x) => x.outcome)).toEqual(['review_requested', 'changes_requested', 'completed']);
      const [work, , again] = runs;
      expect(again?.seededFromRun).toBe(edited ? null : work?.runId);
      expect(agent.starts.map((x) => x.providerSessionId)).toEqual([undefined, edited ? undefined : 'prov_impl']);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("copies a role's imported skills into its package, or lists them in the prompt when it is not rendered", async () => {
    // A made-up home's user skill, imported by name, as startup would load it.
```

In `tests/kanban-rendering.test.ts`, replace:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun, endRun, DEFAULT_LIMITS } from '../src/db/kanban.js';
import { eventsOf, getRun } from '../src/db/kanban-read.js';
import { KanbanService } from '../src/kanban/service.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { AGENT, NOW, WORKSPACES, claimed, newTask } from './helpers/kanban.js';

/**
 * Whether a run ran natively (plan R) is recorded on the run, in its
```

with:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachSession, closeRun, endRun, requestChanges, requestReview, DEFAULT_LIMITS } from '../src/db/kanban.js';
import { eventsOf, getRun } from '../src/db/kanban-read.js';
import { createSession } from '../src/db/sessions.js';
import { KanbanService } from '../src/kanban/service.js';
import type { Rendering, RunRow } from '../src/kanban/types.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { AGENT, ALICE, NOW, WORKSPACES, claimed, newTask } from './helpers/kanban.js';

/**
 * Whether a run ran natively (plan R) is recorded on the run, in its
```

In `tests/kanban-rendering.test.ts`, replace:

```ts
  });
});

```

with:

```ts
  });
});

describe("recordRendering settles a rework's seed (spec §5.3)", () => {
  const spaces = [...WORKSPACES];
  let used = 0;

  /**
   * A work run given its role one way, reviewed, changes asked; then the rework,
   * claimed seeded from it. Each in a workspace of its own, as the rework stays open.
   */
  function rework(work: Rendering | undefined): { work: RunRow; rework: RunRow } {
    const task = newTask(h.db, { reviewer: { kind: 'role', name: 'reviewer' }, workspace: spaces[used++ % spaces.length] ?? null });
    const first = claimed(h.db, task.taskId);
    createSession(
      h.db,
      {
        id: `s_${first.runId}`,
        agentId: 'implementer',
        workspaceId: 'default',
        ownerPrincipal: ALICE,
        providerSessionId: 'prov_1',
      },
      NOW,
    );
    if (attachSession(h.db, first.runId, `s_${first.runId}`, NOW).ok !== true) throw new Error('not attached');
    if (work !== undefined && !service.recordRendering(first.runId, work).ok) throw new Error('not recorded');
    requestReview(h.db, task.taskId, { kind: 'run', runId: first.runId }, { summary: 'v1' }, NOW);
    closeRun(h.db, first.runId, NOW);
    const review = claimed(h.db, task.taskId);
    requestChanges(h.db, task.taskId, { kind: 'run', runId: review.runId }, 'add a test', NOW);
    closeRun(h.db, review.runId, NOW);
    const again = claimed(h.db, task.taskId);
    expect(again.seededFromRun).toBe(first.runId);
    return { work: first, rework: again };
  }

  const OTHER = 'a'.repeat(64);

  it('keeps the seed when the rework is given its role as the work was: the same package, or both in the prompt', () => {
    for (const how of [{ native: true, packageHash: HASH }, { native: false }] as const) {
      const r = rework(how);
      expect(service.recordRendering(r.rework.runId, how)).toMatchObject({ ok: true, run: { seededFromRun: r.work.runId } });
      expect(eventsOf(h.db, r.rework.taskId).at(-1)?.payload).toEqual(how);
    }
    // A work run from before plan R recorded neither key: it was not native.
    const old = rework(undefined);
    expect(service.recordRendering(old.rework.runId, { native: false })).toMatchObject({
      run: { seededFromRun: old.work.runId },
    });
  });

  it('drops the seed when the rework is given its role another way, and says so', () => {
    const cases: Array<[Rendering | undefined, Rendering]> = [
      [{ native: true, packageHash: HASH }, { native: true, packageHash: OTHER }],
      [{ native: true, packageHash: HASH }, { native: false }],
      [{ native: false }, { native: true, packageHash: HASH }],
      [undefined, { native: true, packageHash: HASH }],
    ];
    for (const [then, now] of cases) {
      const r = rework(then);
      expect(service.recordRendering(r.rework.runId, now)).toMatchObject({ ok: true, run: { seededFromRun: null } });
      expect(getRun(h.db, r.rework.runId)?.seededFromRun).toBeNull();
      expect(eventsOf(h.db, r.rework.taskId).at(-1)).toMatchObject({
        kind: 'run_rendered',
        payload: { ...now, seedDropped: r.work.runId },
      });
    }
  });
});

```

- [ ] **Step 8.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-rendering.test.ts tests/kanban-dispatch-native.test.ts`. Expected: one test in each file FAILS: the seed is kept whatever the rendering, `AssertionError: expected { ok: true, run: { …(21) } } to match object { ok: true, …(1) }`, and the edited role's rework still resumes the conversation, `AssertionError: expected 'r_…' to be null // Object.is equality`. `Tests  2 failed | 10 passed (12)`.

- [ ] **Step 8.3: Implement.**

In `src/db/kanban.ts`, replace:

```ts
  'workspace',
  'packageHash',
]);

```

with:

```ts
  'workspace',
  'packageHash',
  'seedDropped',
]);

```

In `src/db/kanban.ts`, replace:

```ts
 * Record how an agent run's role reached its agent (plan R): as a native
 * package, by its content hash, or in the prompt. It goes into the run's
 * `agent_config`, beside the agent it ran, since it is part of what ran: C4
 * and E will seed only from a run with the same native-ness and package hash.
 * Written once, on an open agent run.
 */
export function recordRendering(db: Db, runId: string, rendering: Rendering, now: number): Result<{ run: RunRow }> {
```

with:

```ts
 * Record how an agent run's role reached its agent (plan R): as a native
 * package, by its content hash, or in the prompt. It goes into the run's
 * `agent_config`, beside the agent it ran, since it is part of what ran.
 * Written once, on an open agent run.
 *
 * It also settles a rework's seed (spec §5.3). The claim chose it before the
 * render, from the agent alone; a conversation resumes only under the same
 * system prompt, so the seed is kept only if the work run it resumes ran the
 * same way -- natively from the same package, or both in the prompt -- and
 * dropped otherwise, so that `seeded_from_run` names a run whose provider session
 * is really resumed. A run from before plan R records neither key, and counts as
 * not native. The dispatcher creates the session after this, from the run as it
 * is now.
 */
export function recordRendering(db: Db, runId: string, rendering: Rendering, now: number): Result<{ run: RunRow }> {
```

In `src/db/kanban.ts`, replace:

```ts
    }
    const recorded = rendering.native ? { native: true, packageHash: rendering.packageHash } : { native: false };
    d.prepare('UPDATE kanban_runs SET agent_config = jsonb(?) WHERE run_id = ?').run(
      JSON.stringify({ ...run.agentConfig, ...recorded }),
      runId,
    );
    record(d, { taskId: run.taskId, runId, kind: 'run_rendered', actor: 'gateway', payload: recorded }, now);
    return { ok: true, run: mustGetRun(d, runId) };
  });
```

with:

```ts
    }
    const recorded = rendering.native ? { native: true, packageHash: rendering.packageHash } : { native: false };
    const seed = run.seededFromRun === null ? undefined : getRun(d, run.seededFromRun)?.agentConfig;
    const sameWay =
      seed !== undefined &&
      seed !== null &&
      (seed.native === true) === rendering.native &&
      (!rendering.native || seed.packageHash === rendering.packageHash);
    const dropped = run.seededFromRun !== null && !sameWay ? run.seededFromRun : undefined;
    d.prepare('UPDATE kanban_runs SET agent_config = jsonb(?), seeded_from_run = ? WHERE run_id = ?').run(
      JSON.stringify({ ...run.agentConfig, ...recorded }),
      dropped === undefined ? run.seededFromRun : null,
      runId,
    );
    record(
      d,
      {
        taskId: run.taskId,
        runId,
        kind: 'run_rendered',
        actor: 'gateway',
        payload: dropped === undefined ? recorded : { ...recorded, seedDropped: dropped },
      },
      now,
    );
    return { ok: true, run: mustGetRun(d, runId) };
  });
```

In `src/kanban/dispatcher.ts`, replace:

```ts
    // the sweep of another run's render sees this one's package as in use.
    const rendered = this.#render(claimed);
    // On the run, once decided: C4 and E will seed only from a run with the
    // same native-ness and package hash. A refusal is noted, and the run goes on.
    const recorded = this.#deps.service.recordRendering(
      run.runId,
```

with:

```ts
    // the sweep of another run's render sees this one's package as in use.
    const rendered = this.#render(claimed);
    // On the run, once decided; it also drops a rework's seed from a work run
    // given its role another way (spec §5.3). A refusal is noted, and the run
    // goes on with the seed the claim chose.
    const recorded = this.#deps.service.recordRendering(
      run.runId,
```

In `src/kanban/dispatcher.ts`, replace:

```ts
    try {
      if (run.workspace === null) throw new Error(`run ${run.runId} has no workspace`);
      const seed = this.#seed(run);
      sessionId = this.#deps.sessions.create(key, KANBAN_OWNER, {
        role: run.assignee.name,
```

with:

```ts
    try {
      if (run.workspace === null) throw new Error(`run ${run.runId} has no workspace`);
      const seed = this.#seed(recorded.ok ? recorded.run : run);
      sessionId = this.#deps.sessions.create(key, KANBAN_OWNER, {
        role: run.assignee.name,
```

- [ ] **Step 8.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1105 passed (1105)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 8.5: Commit.**

```bash
git add src/db/kanban.ts src/kanban/dispatcher.ts tests/kanban-dispatch-native.test.ts tests/kanban-rendering.test.ts
git commit -m "Seed a rework only from a work run given its role the same way: the same native package, or both in the prompt"
```

---

### Task 9: Gates, the review's handoff and the rework's reason in the prompt

**Files:**
- Modify: `src/db/kanban-read.ts`, `src/kanban/brief.ts`, `src/kanban/prompt.ts`, `src/kanban/worker.ts`, `tests/kanban-brief.test.ts`, `tests/kanban-prompt.test.ts`, `tests/kanban-worker.test.ts`

C1's and C2's notes (spec §7.1; Decisions 14 and 15). `db/kanban-read.ts` gains `lastGateRun`, `latestReviewRequest` and `changesAsked`, which reads the reviewer's reason from the `changes_requested` event whether a run or a person asked. `briefFor` gathers the gates, their last run, and the review's or the rework's handoff; `composePrompt` puts the gates and their last run in the task section, and `## For your review` or `## Changes requested` after the attempts; the review protocol points at its section. `mt kanban show` gives the same fields.

- [ ] **Step 9.1: Write the failing tests.**

In `tests/kanban-brief.test.ts`, replace:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent } from '../src/db/events.js';
import {
  addComment,
  archive,
  attachSession,
  block,
  closeRun,
  complete,
  DEFAULT_LIMITS,
  endRun,
  unblock,
} from '../src/db/kanban.js';
import { createSession } from '../src/db/sessions.js';
import { briefFor, endedUnreported } from '../src/kanban/brief.js';
```

with:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent } from '../src/db/events.js';
import {
  addComment,
  addGate,
  archive,
  attachSession,
  block,
  closeRun,
  complete,
  DEFAULT_LIMITS,
  endRun,
  recordGates,
  requestChanges,
  requestReview,
  unblock,
} from '../src/db/kanban.js';
import { createSession } from '../src/db/sessions.js';
import { briefFor, endedUnreported } from '../src/kanban/brief.js';
```

In `tests/kanban-brief.test.ts`, replace:

```ts
    }
  });
});

```

with:

```ts
    }
  });
});

describe('briefFor: gates, review and rework', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const REVIEWER = { kind: 'role', name: 'reviewer' } as const;

  it("gathers the task's gates and their latest run", () => {
    const task = newTask(h.db);
    expect(addGate(h.db, task.taskId, { command: 'npm test', timeoutS: 60 }, ALICE, NOW).ok).toBe(true);
    const result = { gateId: 1, command: 'npm test', exitCode: 1, signal: null, timedOut: false, durationMs: 3, output: 'FAIL' };
    const by = { runId: null, actor: ALICE };
    recordGates(h.db, task.taskId, by, 'complete', { passed: false, aborted: false, notRun: 0, results: [result] }, NOW);
    const passed = { passed: true, aborted: false, notRun: 0, results: [{ ...result, exitCode: 0, output: '' }] };
    recordGates(h.db, task.taskId, by, 'complete', passed, NOW + 1);
    const run = claimed(h.db, task.taskId);
    const brief = briefFor(h.db, { run, task, roleMd: undefined, role: ROLE });
    expect(brief.gates).toEqual([expect.objectContaining({ command: 'npm test', timeoutS: 60, createdBy: ALICE })]);
    expect(brief.lastGateRun).toMatchObject({ passed: true, actor: ALICE, at: NOW + 1, results: [{ exitCode: 0 }] });
    expect(brief.review).toBeUndefined();
    expect(brief.rework).toBeUndefined();
  });

  it('gives a review run the handoff it reviews, and a rework the reason and the handoff it revises', () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const work = claimed(h.db, task.taskId);
    const handoff = { summary: 'Parser written.', metadata: { pr: 7 }, reportedCommit: SHA, reportedDirty: false };
    expect(requestReview(h.db, task.taskId, { kind: 'run', runId: work.runId }, handoff, NOW).ok).toBe(true);
    expect(closeRun(h.db, work.runId, NOW).ok).toBe(true);
    const review = claimed(h.db, task.taskId);
    const asked = { runId: work.runId, actor: `run:${work.runId}`, ...handoff };
    expect(briefFor(h.db, { run: review, task, roleMd: undefined, role: ROLE }).review).toEqual(asked);

    expect(requestChanges(h.db, task.taskId, { kind: 'run', runId: review.runId }, 'Handle an empty file.', NOW).ok).toBe(true);
    expect(closeRun(h.db, review.runId, NOW).ok).toBe(true);
    const rework = claimed(h.db, task.taskId);
    const brief = briefFor(h.db, { run: rework, task, roleMd: undefined, role: ROLE });
    expect(brief.rework).toEqual({ reason: 'Handle an empty file.', actor: `run:${review.runId}`, handoff: asked });
    expect(brief.review).toBeUndefined();
  });

  it("reads a person's request and changes from their events, and no rework once a review is asked for again", () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const person = { kind: 'person', principal: ALICE } as const;
    expect(requestReview(h.db, task.taskId, person, { summary: 'Have a look.' }, NOW).ok).toBe(true);
    expect(requestChanges(h.db, task.taskId, person, 'Rename it.', NOW).ok).toBe(true);
    const rework = claimed(h.db, task.taskId);
    expect(briefFor(h.db, { run: rework, task, roleMd: undefined, role: ROLE }).rework).toEqual({
      reason: 'Rename it.',
      actor: ALICE,
      handoff: { runId: null, actor: ALICE, summary: 'Have a look.', metadata: null, reportedCommit: null, reportedDirty: null },
    });
    expect(requestReview(h.db, task.taskId, { kind: 'run', runId: rework.runId }, { summary: 'Renamed.' }, NOW).ok).toBe(true);
    expect(closeRun(h.db, rework.runId, NOW).ok).toBe(true);
    const later = claimed(h.db, task.taskId);
    expect(later.kind).toBe('review');
    expect(briefFor(h.db, { run: later, task, roleMd: undefined, role: ROLE }).review).toMatchObject({ summary: 'Renamed.' });
  });
});

```

In `tests/kanban-prompt.test.ts`, replace:

```ts
  });
});

```

with:

```ts
  });
});

describe('composePrompt: gates, review and rework', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const gate = (id: number, command: string, timeoutS = 300) => ({
    id,
    taskId: 'k_task',
    command,
    timeoutS,
    createdBy: 'lark:on_alice',
    createdAt: NOW,
  });

  it("lists the task's gates and their last run, the failing gate's output masked and set off as data", () => {
    addSecrets(['sk-live-1234567890']);
    const prompt = composePrompt(
      brief({
        gates: [gate(1, 'npm run lint', 60), gate(2, 'npm test')],
        lastGateRun: {
          runId: 'r_1',
          actor: 'run:r_1',
          for: 'review',
          passed: false,
          aborted: false,
          notRun: 0,
          results: [
            { gateId: 1, command: 'npm run lint', exitCode: 0, signal: null, timedOut: false, durationMs: 5, output: 'ok' },
            {
              gateId: 2,
              command: 'npm test',
              exitCode: 1,
              signal: null,
              timedOut: false,
              durationMs: 9,
              output: '# FAIL parser\n- expected 2 with sk-live-1234567890',
            },
          ],
          at: NOW,
        },
      }),
    );
    expect(prompt).toContain(
      [
        'Gates: `mt kanban complete` and `review` run these commands first, in the workspace, ' +
          'and are refused unless each exits 0. A report waits for them, up to 360 s together, ' +
          'so give the command that long to answer.',
        '- npm run lint (up to 60 s)',
        '- npm test (up to 300 s)',
        '',
        'Last gate run, for review by run:r_1: failed',
        '- npm run lint: passed',
        '- npm test: exited 1',
        '    Output:',
        '        # FAIL parser',
        `        - expected 2 with ${MASK}`,
      ].join('\n'),
    );
    expect(at(prompt, 'Gates:')).toBeLessThan(at(prompt, '# Context'));
    expect(prompt).not.toContain('sk-live');
  });

  it('says how a last gate run that timed out, or was stopped, ended', () => {
    const result = { gateId: 1, command: 'npm test', exitCode: null, signal: 'SIGTERM', durationMs: 1, output: '' };
    const last = { runId: null, actor: 'lark:on_alice', for: 'complete' as const, passed: false, at: NOW };
    const timedOut = composePrompt(
      brief({ lastGateRun: { ...last, aborted: false, notRun: 2, results: [{ ...result, timedOut: true }] } }),
    );
    expect(timedOut).toContain(
      'Last gate run, for complete by lark:on_alice: failed; 2 not run\n- npm test: ran past its timeout',
    );
    const stopped = composePrompt(
      brief({ lastGateRun: { ...last, aborted: true, notRun: 0, results: [{ ...result, timedOut: false }] } }),
    );
    expect(stopped).toContain('stopped, as the gateway stopped\n- npm test: was ended by SIGTERM');
  });

  it('gives a review run the handoff it reviews and what to review, after the attempts and before the comments', () => {
    const prompt = composePrompt(
      brief({
        kind: 'review',
        task: task({ phase: 'review' }),
        attempts: [{ run: run({ outcome: 'review_requested', summary: 'Parser written.' }), toolCalls: undefined }],
        comments: [{ id: 1, taskId: 'k_task', author: 'lark:on_alice', body: 'Looks close.', createdAt: NOW }],
        review: {
          runId: 'r_1',
          actor: 'run:r_1',
          summary: 'Parser written.\nTests added.',
          metadata: { files: ['src/parser.ts'] },
          reportedCommit: SHA,
          reportedDirty: true,
        },
      }),
    );
    expect(prompt).toContain("Review the implementer's handoff, under For your review, and the workspace");
    expect(prompt).toContain(
      [
        '## For your review',
        "The implementer's handoff, from run:r_1:",
        'Summary:',
        '    Parser written.',
        '    Tests added.',
        'Metadata: {"files":["src/parser.ts"]}',
        `State: uncommitted changes on top of ${SHA}`,
      ].join('\n'),
    );
    expect(at(prompt, '## Attempt 1')).toBeLessThan(at(prompt, '## For your review'));
    expect(at(prompt, '## For your review')).toBeLessThan(at(prompt, '## Comments'));
  });

  it("gives a rework the reviewer's reason and the handoff it revises, each capped", () => {
    const prompt = composePrompt(
      brief({
        rework: {
          reason: 'Handle an empty file.',
          actor: 'run:r_2',
          handoff: {
            runId: 'r_1',
            actor: 'run:r_1',
            summary: 'x'.repeat(PIECE_BYTES.summary + 10),
            metadata: null,
            reportedCommit: SHA,
            reportedDirty: false,
          },
        },
      }),
    );
    expect(prompt).toContain(
      [
        '## Changes requested',
        'run:r_2 reviewed this task and asked for changes. Make them, then report again:',
        'Reason: Handle an empty file.',
        '',
        'The previous handoff, which they reviewed:',
        'Summary:',
        `    ${'x'.repeat(PIECE_BYTES.summary)}`,
        '    [cut; mt kanban show has all of it]',
        `State: review commit ${SHA}`,
      ].join('\n'),
    );
    // Neither section where it does not apply: a rework is a work run, a review a review run.
    expect(composePrompt(brief({ kind: 'review', rework: { reason: 'r', actor: 'a', handoff: undefined } }))).not.toContain(
      '## Changes requested',
    );
  });
});

```

In `tests/kanban-worker.test.ts`, replace:

```ts
    expect(await answer).toMatchObject({ ok: true, phase: 'done' });
  });
});

```

with:

```ts
    expect(await answer).toMatchObject({ ok: true, phase: 'done' });
  });
});

describe('worker API: show, for gates, review and rework', () => {
  it('shows the gates and their last run', async () => {
    // A board whose gates run, over a runner that starts nothing: this one fails.
    const service = new KanbanService({
      db: b.t.db,
      roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
      workspaces: WORKSPACES,
      clock: new ManualClock(),
      checks: {
        workspaceDirs: new Map([['web', '/ws/web']]),
        env: {},
        runGate: async () => ({ exitCode: 2, signal: null, timedOut: false, output: 'FAIL parser' }),
        readCommit: async () => ({ commit: null, dirty: true }),
      },
    });
    const api = new WorkerApi({ db: b.t.db, service });
    const task = b.create();
    expect(service.addGate(task.taskId, { command: 'npm test', timeoutS: 30 }, ALICE).ok).toBe(true);
    const token = mintToken();
    const claimed = service.claim(task.taskId, { tokenHash: hashToken(token) });
    if (!claimed.ok) throw new Error(claimed.message);
    const ask = (command: string, input: unknown = {}) => api.handle({ run: claimed.run.runId, token, command, input });
    expect(await ask('complete', { summary: 'done' })).toMatchObject({ ok: false, code: 'gate_failed' });
    expect(await ask('show')).toMatchObject({
      ok: true,
      gates: [{ gate_id: expect.any(Number), command: 'npm test', timeout_s: 30 }],
      last_gate_run: {
        for: 'complete',
        by: `run:${claimed.run.runId}`,
        passed: false,
        aborted: false,
        not_run: 0,
        results: [{ command: 'npm test', exit_code: 2, signal: null, timed_out: false, duration_ms: 0, output: 'FAIL parser' }],
      },
      review: null,
      rework: null,
    });
  });

  it('shows the commit each attempt reported, and a rework its reason and previous handoff', async () => {
    const task = b.create({ reviewer: 'reviewer' });
    const work = b.claim(task.taskId);
    expect(await work.ask('review', { summary: 'v1' })).toMatchObject({ ok: true });
    b.service.closeRun(work.run.runId);
    const review = b.claim(task.taskId);
    expect(await review.ask('show')).toMatchObject({
      review: { by: `run:${work.run.runId}`, run_id: work.run.runId, summary: 'v1', reported_commit: null, reported_dirty: null },
      rework: null,
    });
    expect(await review.ask('changes', { reason: 'add a test' })).toMatchObject({ ok: true });
    b.service.closeRun(review.run.runId);
    const rework = b.claim(task.taskId);
    expect(await rework.ask('show')).toMatchObject({
      attempts: [
        { attempt: 1, outcome: 'review_requested', reported_commit: null, reported_dirty: null },
        { attempt: 2, outcome: 'changes_requested' },
      ],
      review: null,
      rework: { by: `run:${review.run.runId}`, reason: 'add a test', handoff: { summary: 'v1' } },
    });
  });
});

```

- [ ] **Step 9.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-prompt.test.ts tests/kanban-brief.test.ts tests/kanban-worker.test.ts`. Expected: nine FAIL: the brief has none of the new fields (`AssertionError: expected undefined to deeply equal [ ObjectContaining{…} ]` and the like), the prompt none of the new sections (`AssertionError: expected '# How to work\n\nYou have one task, b…' to contain 'Gates: `mt kanban complete` and `revi…'`, and the review protocol's old wording, `… to contain 'Review the implementer\'s handoff, un…'`), and `show` none of its new fields. `Tests  9 failed | 43 passed (52)`.

- [ ] **Step 9.3: Implement.**

In `src/db/kanban-read.ts`, replace:

```ts
}

/** The task as `/kanban show` and `mt kanban show` present it. */
export interface TaskView {
```

with:

```ts
}

/** A request for same-task review (spec §5.3): the handoff a reviewer reviews, and a rework revises. */
export interface ReviewRequest {
  /** The work run that asked; null for a person. */
  runId: string | null;
  actor: string;
  summary: string;
  metadata: unknown;
  /** What the run's report recorded of its workspace (spec §7.8); null for a person's. */
  reportedCommit: string | null;
  reportedDirty: boolean | null;
}

/**
 * The task's latest request for review: its `review_requested` event, and the
 * work run's handoff when a run asked. A person's request has only the event's
 * summary.
 */
export function latestReviewRequest(db: Db, taskId: string): ReviewRequest | undefined {
  const event = latestOf(db, taskId, ['review_requested']);
  if (event === undefined) return undefined;
  const run = event.run_id === null ? undefined : getRun(db, event.run_id);
  if (run !== undefined) {
    return {
      runId: run.runId,
      actor: event.actor,
      summary: run.summary ?? '',
      metadata: run.metadata,
      reportedCommit: run.reportedCommit,
      reportedDirty: run.reportedDirty,
    };
  }
  const payload = json(event.payload) as { summary?: unknown };
  return {
    runId: null,
    actor: event.actor,
    summary: typeof payload.summary === 'string' ? payload.summary : '',
    metadata: null,
    reportedCommit: null,
    reportedDirty: null,
  };
}

/** Changes a reviewer asked for and nobody has yet answered with another review request: what a rework is for. */
export interface ChangesAsked {
  reason: string;
  /** Who asked: a review run (`run:<id>`) or a person. */
  actor: string;
}

/**
 * The changes the task's next work run is to make (spec §5.3), if its latest
 * review ended in them: the latest `changes_requested` event, unless a review
 * was asked for since. Read from the event, which has the reason whether a review
 * run or a person asked (C1 Decision 7).
 */
export function changesAsked(db: Db, taskId: string): ChangesAsked | undefined {
  const event = latestOf(db, taskId, ['review_requested', 'changes_requested']);
  if (event?.kind !== 'changes_requested') return undefined;
  const payload = json(event.payload) as { reason?: unknown };
  return { reason: typeof payload.reason === 'string' ? payload.reason : '', actor: event.actor };
}

/** The task's latest event of one of these kinds. */
function latestOf(db: Db, taskId: string, kinds: readonly string[]): EventRaw | undefined {
  return db
    .prepare<string[], EventRaw>(
      `SELECT id, task_id, run_id, kind, actor, json(payload) AS payload, created_at
         FROM kanban_events WHERE task_id = ? AND kind IN (${kinds.map(() => '?').join(', ')})
        ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId, ...kinds);
}

/** The task as `/kanban show` and `mt kanban show` present it. */
export interface TaskView {
```

In `src/kanban/brief.ts`, replace:

```ts
import type { Db } from '../db/open.js';
import { childrenOf, commentsOf, latestCompletion, parentsOf, runsOf } from '../db/kanban-read.js';
import type { Attempt, ParentHandoff, RunBrief } from './prompt.js';
import type { Claimed } from './service.js';
```

with:

```ts
import type { Db } from '../db/open.js';
import {
  changesAsked,
  childrenOf,
  commentsOf,
  gatesOf,
  lastGateRun,
  latestCompletion,
  latestReviewRequest,
  parentsOf,
  runsOf,
} from '../db/kanban-read.js';
import type { Attempt, ParentHandoff, RunBrief } from './prompt.js';
import type { Claimed } from './service.js';
```

In `src/kanban/brief.ts`, replace:

```ts
 * Gather what a run's prompt is composed from (spec §7.1), as the board holds it
 * when the run is claimed: each parent's latest handoff, every earlier attempt,
 * the comment thread and the children.
 */

```

with:

```ts
 * Gather what a run's prompt is composed from (spec §7.1), as the board holds it
 * when the run is claimed: each parent's latest handoff, every earlier attempt,
 * the comment thread and the children; the task's gates and their last run; and
 * for a review the handoff it reviews, for a rework the reviewer's reason and the
 * handoff it revises (spec §5.3).
 */

```

In `src/kanban/brief.ts`, replace:

```ts
      toolCalls: endedUnreported(run) && run.sessionId !== null ? toolCallsOf(db, run.sessionId) : undefined,
    }));
  return {
    kind: c.run.kind,
```

with:

```ts
      toolCalls: endedUnreported(run) && run.sessionId !== null ? toolCallsOf(db, run.sessionId) : undefined,
    }));
  const last = lastGateRun(db, taskId);
  const review = c.run.kind === 'review' ? latestReviewRequest(db, taskId) : undefined;
  const changes = c.run.kind === 'work' ? changesAsked(db, taskId) : undefined;
  return {
    kind: c.run.kind,
```

In `src/kanban/brief.ts`, replace:

```ts
    comments: commentsOf(db, taskId),
    children: childrenOf(db, taskId),
  };
}
```

with:

```ts
    comments: commentsOf(db, taskId),
    children: childrenOf(db, taskId),
    gates: gatesOf(db, taskId),
    ...(last === undefined ? {} : { lastGateRun: last }),
    ...(review === undefined ? {} : { review }),
    ...(changes === undefined ? {} : { rework: { ...changes, handoff: latestReviewRequest(db, taskId) } }),
  };
}
```

In `src/kanban/prompt.ts`, replace:

```ts
import { redactKnownSecrets } from '../secrets.js';
import type { Skill } from '../roles.js';
import type { ToolCall } from './session-log.js';
import { CONTRACT_FIELDS, type CommentRow, type RunKind, type RunRow, type TaskRow } from './types.js';

/**
 * A run's task prompt (spec §7.1), composed in this order: the role, its skills,
 * the protocol for the run's kind, the task, and the worker context. A run whose
 * role was rendered as a native agent package (plan R) has its role.md as the
 * agent's system prompt and its skills loaded by the agent, so its prompt leaves
 * both out rather than send them twice; the rest is the same.
```

with:

```ts
import type { LastGateRun, ReviewRequest } from '../db/kanban-read.js';
import { redactKnownSecrets } from '../secrets.js';
import type { Skill } from '../roles.js';
import { describeReported } from './commit.js';
import type { ToolCall } from './session-log.js';
import { CONTRACT_FIELDS, type CommentRow, type GateRow, type RunKind, type RunRow, type TaskRow } from './types.js';

/**
 * A run's task prompt (spec §7.1), composed in this order: the role, its skills,
 * the protocol for the run's kind, the task -- with its gates and their last run
 * -- and the worker context, which for a review holds the handoff it reviews, and
 * for a rework the reviewer's reason and the handoff it revises. A run whose
 * role was rendered as a native agent package (plan R) has its role.md as the
 * agent's system prompt and its skills loaded by the agent, so its prompt leaves
 * both out rather than send them twice; the rest is the same.
```

In `src/kanban/prompt.ts`, replace:

```ts
  toolCalls: readonly ToolCall[] | undefined;
}

/** Everything a run's prompt is composed from. */
export interface RunBrief {
  kind: RunKind;
```

with:

```ts
  toolCalls: readonly ToolCall[] | undefined;
}

/** A rework's reason to be (spec §5.3): what the reviewer asked, and the handoff they reviewed. */
export interface Rework {
  reason: string;
  /** Who asked: a review run (`run:<id>`) or a person. */
  actor: string;
  /** The implementer's previous handoff; undefined if none can be found. */
  handoff: ReviewRequest | undefined;
}

/** Everything a run's prompt is composed from. */
export interface RunBrief {
  kind: RunKind;
```

In `src/kanban/prompt.ts`, replace:

```ts
  attempts: readonly Attempt[];
  comments: readonly CommentRow[];
  children: readonly TaskRow[];
}

/** An assignee or a reviewer, as KanbanService takes one: a role name, or a person's principal. */
```

with:

```ts
  attempts: readonly Attempt[];
  comments: readonly CommentRow[];
  children: readonly TaskRow[];
  /** The task's gates, in the order they run (spec §7.7). */
  gates?: readonly GateRow[];
  /** Their latest run, if they have run (spec §7.1, item 4). */
  lastGateRun?: LastGateRun;
  /** For a review run: the handoff it reviews. */
  review?: ReviewRequest;
  /** For a work run after a reviewer's changes: the rework's reason, and what it revises. */
  rework?: Rework;
}

/** An assignee or a reviewer, as KanbanService takes one: a role name, or a person's principal. */
```

In `src/kanban/prompt.ts`, replace:

```ts

Block only on genuine ambiguity, and say why. If one of the task's children below reviews this task, report complete rather than review. If you find follow-up work, create a task for it with \`mt kanban create\` rather than doing it. Never put a secret in a summary, metadata or comment. Stop once you have reported.`;

const REVIEW_PROTOCOL = `You are reviewing one task, below. Review the implementer's handoff, in the earlier attempts, and the workspace -- the current directory -- against the task and its contract. Do not change the workspace.

Report through the \`mt kanban\` command, which reads JSON on stdin and answers in JSON (if it answers "unreachable", the gateway may be busy: try once more). Exactly one terminal report ends your run:
- \`mt kanban complete < handoff.json\`, with {"summary": "..."}, to approve;
```

with:

```ts

Block only on genuine ambiguity, and say why. If one of the task's children below reviews this task, report complete rather than review. If you find follow-up work, create a task for it with \`mt kanban create\` rather than doing it. Never put a secret in a summary, metadata or comment. Stop once you have reported.`;

const REVIEW_PROTOCOL = `You are reviewing one task, below. Review the implementer's handoff, under For your review, and the workspace -- the current directory -- against the task and its contract. Do not change the workspace.

Report through the \`mt kanban\` command, which reads JSON on stdin and answers in JSON (if it answers "unreachable", the gateway may be busy: try once more). Exactly one terminal report ends your run:
- \`mt kanban complete < handoff.json\`, with {"summary": "..."}, to approve;
```

In `src/kanban/prompt.ts`, replace:

```ts
  return Buffer.byteLength(lines.join('\n'), 'utf8') + 1;
}

function taskSection(task: TaskRow): string[] {
  const lines = ['# The task', '', `${task.taskId}: ${flat(task.title)}`];
  if (task.body !== '') lines.push('', ...indent(piece(task.body, PIECE_BYTES.body)));
  const contract = CONTRACT_FIELDS.filter((f) => task.contract[f] !== undefined);
```

with:

```ts
  return Buffer.byteLength(lines.join('\n'), 'utf8') + 1;
}

function taskSection(b: RunBrief): string[] {
  const { task } = b;
  const lines = ['# The task', '', `${task.taskId}: ${flat(task.title)}`];
  if (task.body !== '') lines.push('', ...indent(piece(task.body, PIECE_BYTES.body)));
  const contract = CONTRACT_FIELDS.filter((f) => task.contract[f] !== undefined);
```

In `src/kanban/prompt.ts`, replace:

```ts
      lines.push(...labelled(`- ${CONTRACT_LABELS[field]}`, piece(task.contract[field] ?? '', PIECE_BYTES.contractField)));
    }
  }
  return lines;
}

function attemptLines(a: Attempt): string[] {
```

with:

```ts
      lines.push(...labelled(`- ${CONTRACT_LABELS[field]}`, piece(task.contract[field] ?? '', PIECE_BYTES.contractField)));
    }
  }
  return [...lines, ...gateLines(b)];
}

/** How one gate's run ended, in a few words. */
function gateVerdict(r: LastGateRun['results'][number]): string {
  if (r.timedOut) return 'ran past its timeout';
  if (r.exitCode === 0) return 'passed';
  if (r.exitCode !== null) return `exited ${r.exitCode}`;
  return r.signal === null ? 'could not start' : `was ended by ${r.signal}`;
}

/**
 * The task's gates and their last run (spec §7.1 item 4, §7.7): what will be run
 * when the run reports, so the agent can run them first, and what failed last
 * time, with the end of its output. Commands are one line each here; the output
 * is stored text, set off as data.
 */
function gateLines(b: RunBrief): string[] {
  const gates = b.gates ?? [];
  const last = b.lastGateRun;
  if (gates.length === 0 && last === undefined) return [];
  const lines: string[] = [];
  if (gates.length > 0) {
    const total = gates.reduce((sum, g) => sum + g.timeoutS, 0);
    lines.push(
      '',
      'Gates: `mt kanban complete` and `review` run these commands first, in the workspace, ' +
        `and are refused unless each exits 0. A report waits for them, up to ${total} s together, ` +
        'so give the command that long to answer.',
    );
    for (const g of gates) lines.push(`- ${flat(g.command)} (up to ${g.timeoutS} s)`);
  }
  if (last !== undefined) {
    const status = last.passed ? 'passed' : last.aborted ? 'stopped, as the gateway stopped' : 'failed';
    const notRun = last.notRun > 0 ? `; ${last.notRun} not run` : '';
    lines.push('', `Last gate run, for ${last.for} by ${flat(last.actor)}: ${status}${notRun}`);
    for (const r of last.results) {
      lines.push(`- ${flat(r.command)}: ${gateVerdict(r)}`);
      if (r.exitCode === 0 || r.output === '') continue;
      lines.push(...indent(labelled('Output', piece(r.output, PIECE_BYTES.lastOutput, 'tail')).join('\n')));
    }
  }
  return lines;
}

/** A handoff for review: its summary, metadata, and the state its report recorded (spec §7.8). */
function handoffOf(h: ReviewRequest): string[] {
  const lines = labelled('Summary', piece(h.summary, PIECE_BYTES.summary));
  if (h.metadata !== null && h.metadata !== undefined) lines.push(...labelled('Metadata', json(h.metadata)));
  const state = describeReported(h);
  if (state !== undefined) lines.push(`State: ${state}`);
  return lines;
}

/**
 * For a review run, the handoff it reviews; for a rework, why it is one and the
 * handoff it revises (spec §5.3, §7.1). Bounded by the pieces' caps.
 */
function handoffSection(b: RunBrief): string[] {
  if (b.kind === 'review' && b.review !== undefined) {
    return ['', '## For your review', `The implementer's handoff, from ${flat(b.review.actor)}:`, ...handoffOf(b.review)];
  }
  if (b.kind === 'work' && b.rework !== undefined) {
    const lines = [
      '',
      '## Changes requested',
      `${flat(b.rework.actor)} reviewed this task and asked for changes. Make them, then report again:`,
      ...labelled('Reason', piece(b.rework.reason, PIECE_BYTES.summary)),
    ];
    if (b.rework.handoff !== undefined) {
      lines.push('', 'The previous handoff, which they reviewed:', ...handoffOf(b.rework.handoff));
    }
    return lines;
  }
  return [];
}

function attemptLines(a: Attempt): string[] {
```

In `src/kanban/prompt.ts`, replace:

```ts
 * handoffs, can push the attempts, the thread or the children out.
 */
function told(b: RunBrief): string {
  const task = taskSection(b.task);
  const children = childLines(b);
  const frame = ['', '# Context'];
  const parentHeader = b.parents.length === 0 ? [] : ['', 'The tasks this one depends on, and what each handed off:'];
  // The omission lines' own sizes are kept back, at their longest.
```

with:

```ts
 * handoffs, can push the attempts, the thread or the children out.
 */
function told(b: RunBrief): string {
  const task = taskSection(b);
  const children = childLines(b);
  const handoff = handoffSection(b);
  const frame = ['', '# Context'];
  const parentHeader = b.parents.length === 0 ? [] : ['', 'The tasks this one depends on, and what each handed off:'];
  // The omission lines' own sizes are kept back, at their longest.
```

In `src/kanban/prompt.ts`, replace:

```ts
  const commentHeader = ['', '## Comments', `${b.comments.length} earlier comments omitted; ${SHOW}`];
  const commentShare =
    b.comments.length === 0 ? 0 : bytes(commentHeader) + share(b.comments.flatMap(commentLines), COMMENT_RESERVE_BYTES);
  let left = CONTEXT_BUDGET_BYTES - bytes(task) - bytes(frame) - bytes(children);

  // The latest attempts first, leaving the thread and the parents their shares.
  const recent = b.attempts.slice(-MAX_ATTEMPTS);
```

with:

```ts
  const commentHeader = ['', '## Comments', `${b.comments.length} earlier comments omitted; ${SHOW}`];
  const commentShare =
    b.comments.length === 0 ? 0 : bytes(commentHeader) + share(b.comments.flatMap(commentLines), COMMENT_RESERVE_BYTES);
  let left =
    CONTEXT_BUDGET_BYTES - bytes(task) - bytes(frame) - bytes(children) - (handoff.length === 0 ? 0 : bytes(handoff));

  // The latest attempts first, leaving the thread and the parents their shares.
  const recent = b.attempts.slice(-MAX_ATTEMPTS);
```

In `src/kanban/prompt.ts`, replace:

```ts
    if (omitted > 0) parentBlock.push(...parentsOmitted(omitted));
  }

  const context = [...parentBlock, ...attemptBlock, ...commentBlock, ...children];
  if (context.length === 0) context.push('', 'Nothing yet: no parents, earlier attempts, comments or children.');
  const text = redactKnownSecrets([...task, ...frame, ...context].join('\n'));
  if (Buffer.byteLength(text, 'utf8') <= CONTEXT_BUDGET_BYTES) return text;
```

with:

```ts
    if (omitted > 0) parentBlock.push(...parentsOmitted(omitted));
  }

  const context = [...parentBlock, ...attemptBlock, ...handoff, ...commentBlock, ...children];
  if (context.length === 0) context.push('', 'Nothing yet: no parents, earlier attempts, comments or children.');
  const text = redactKnownSecrets([...task, ...frame, ...context].join('\n'));
  if (Buffer.byteLength(text, 'utf8') <= CONTEXT_BUDGET_BYTES) return text;
```

In `src/kanban/worker.ts`, replace:

```ts
import type { Db } from '../db/open.js';
import { getTask, runByTokenHash, taskView } from '../db/kanban-read.js';
import { redactKnownSecrets } from '../secrets.js';
import { briefFor } from './brief.js';
```

with:

```ts
import type { Db } from '../db/open.js';
import { getTask, runByTokenHash, taskView, type ReviewRequest } from '../db/kanban-read.js';
import { redactKnownSecrets } from '../secrets.js';
import { briefFor } from './brief.js';
```

In `src/kanban/worker.ts`, replace:

```ts
}

export class WorkerApi {
  readonly #db: Db;
```

with:

```ts
}

/** A handoff for review, as show gives it, in snake_case like the input. */
function handoffShown(h: ReviewRequest): Record<string, unknown> {
  return {
    by: h.actor,
    run_id: h.runId,
    summary: h.summary,
    metadata: h.metadata,
    reported_commit: h.reportedCommit,
    reported_dirty: h.reportedDirty,
  };
}

export class WorkerApi {
  readonly #db: Db;
```

In `src/kanban/worker.ts`, replace:

```ts
        error: a.run.error,
        last_output: a.run.lastOutput,
        ...(a.toolCalls === undefined ? {} : { tool_calls: a.toolCalls.map((c) => ({ title: c.title, status: c.status })) }),
      })),
      comments: brief.comments.map((c) => ({ author: c.author, body: c.body, created_at: c.createdAt })),
      children: brief.children.map((c) => ({
```

with:

```ts
        error: a.run.error,
        last_output: a.run.lastOutput,
        reported_commit: a.run.reportedCommit,
        reported_dirty: a.run.reportedDirty,
        ...(a.toolCalls === undefined ? {} : { tool_calls: a.toolCalls.map((c) => ({ title: c.title, status: c.status })) }),
      })),
      gates: (brief.gates ?? []).map((g) => ({ gate_id: g.id, command: g.command, timeout_s: g.timeoutS })),
      last_gate_run:
        brief.lastGateRun === undefined
          ? null
          : {
              for: brief.lastGateRun.for,
              by: brief.lastGateRun.actor,
              passed: brief.lastGateRun.passed,
              aborted: brief.lastGateRun.aborted,
              not_run: brief.lastGateRun.notRun,
              results: brief.lastGateRun.results.map((r) => ({
                command: r.command,
                exit_code: r.exitCode,
                signal: r.signal,
                timed_out: r.timedOut,
                duration_ms: r.durationMs,
                output: r.output,
              })),
            },
      review: brief.review === undefined ? null : handoffShown(brief.review),
      rework:
        brief.rework === undefined
          ? null
          : {
              by: brief.rework.actor,
              reason: brief.rework.reason,
              handoff: brief.rework.handoff === undefined ? null : handoffShown(brief.rework.handoff),
            },
      comments: brief.comments.map((c) => ({ author: c.author, body: c.body, created_at: c.createdAt })),
      children: brief.children.map((c) => ({
```

- [ ] **Step 9.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1114 passed (1114)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 9.5: Commit.**

```bash
git add src/db/kanban-read.ts src/kanban/brief.ts src/kanban/prompt.ts src/kanban/worker.ts tests/kanban-brief.test.ts tests/kanban-prompt.test.ts tests/kanban-worker.test.ts
git commit -m "Give a run its task's gates and their last run, a review the handoff it reviews, and a rework the reviewer's reason"
```

---

### Task 10: A crash is printed masked

**Files:**
- Create: `src/crash.ts`, `tests/crash.e2e.ts`, `tests/crash.test.ts`
- Modify: `src/main.ts`

Plan F's note (spec §10.1; Decision 16). Node prints an uncaught exception or an unhandled rejection after startup itself, unmasked. `src/crash.ts` installs handlers that print it through `redactKnownSecrets` and exit 1, and `src/main.ts` installs them first. The unit tests use a stand-in for the process; `tests/crash.e2e.ts` crashes a real one.

- [ ] **Step 10.1: Write the failing tests.**

Create `tests/crash.e2e.ts`:

```ts
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The crash handlers in a real process (spec §10.1): a secret in an error that
 * nothing caught is printed masked, and the process exits 1, as Node would.
 */

const LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const SECRETS = new URL('../src/secrets.ts', import.meta.url).href;
const CRASH = new URL('../src/crash.ts', import.meta.url).href;

/** Run a module that registers a secret, installs the handlers, then does `then`. */
function crash(then: string): Promise<{ code: number | null; stderr: string }> {
  const code = [
    `import { addSecrets } from ${JSON.stringify(SECRETS)};`,
    `import { installCrashHandlers } from ${JSON.stringify(CRASH)};`,
    "addSecrets(['sk-crash-1234567890']);",
    'installCrashHandlers();',
    then,
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', LOADER, '--input-type=module', '-e', code], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => (stderr += d));
    child.once('error', reject);
    child.once('close', (status) => resolve({ code: status, stderr }));
  });
}

describe('a crash, in a real process', () => {
  it('prints an uncaught exception masked, and exits 1', async () => {
    const r = await crash("setTimeout(() => { throw new Error('key sk-crash-1234567890 rejected'); }, 10);");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^uncaught exception: Error: key •••• rejected\n {4}at /);
    expect(r.stderr).not.toContain('sk-crash');
  });

  it('prints an unhandled rejection masked, and exits 1', async () => {
    const r = await crash("Promise.reject(new Error('token sk-crash-1234567890'));");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^unhandled rejection: Error: token ••••\n/);
    expect(r.stderr).not.toContain('sk-crash');
  });
});
```

Create `tests/crash.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crashReport, installCrashHandlers } from '../src/crash.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';

/** The crash handlers (spec §10.1), on a stand-in for the process: nothing exits here. */

beforeEach(() => clearSecrets());
afterEach(() => clearSecrets());

function installed() {
  const source = new EventEmitter();
  const written: string[] = [];
  const exits: number[] = [];
  installCrashHandlers(source, (text) => written.push(text), (code) => exits.push(code));
  return { source, written, exits };
}

describe('crash handlers', () => {
  it('print an uncaught exception, its stack included, masked, and exit 1', () => {
    addSecrets(['sk-live-1234567890']);
    const { source, written, exits } = installed();
    source.emit('uncaughtException', new Error('request failed with key sk-live-1234567890'));
    expect(exits).toEqual([1]);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(new RegExp(`^uncaught exception: Error: request failed with key ${MASK}\\n    at `));
    expect(written[0]).not.toContain('sk-live');
    expect(written[0]?.endsWith('\n')).toBe(true);
  });

  it('print an unhandled rejection of anything, masked, and exit 1', () => {
    addSecrets(['sk-live-1234567890']);
    const { source, written, exits } = installed();
    source.emit('unhandledRejection', { status: 401, key: 'sk-live-1234567890' });
    source.emit('unhandledRejection', 'just sk-live-1234567890');
    expect(exits).toEqual([1, 1]);
    expect(written).toEqual([
      `unhandled rejection: { status: 401, key: '${MASK}' }\n`,
      `unhandled rejection: 'just ${MASK}'\n`,
    ]);
  });

  it('exit even when the report cannot be written', () => {
    const source = new EventEmitter();
    const exits: number[] = [];
    installCrashHandlers(
      source,
      () => {
        throw new Error('stderr is gone');
      },
      (code) => exits.push(code),
    );
    source.emit('uncaughtException', new Error('boom'));
    expect(exits).toEqual([1]);
  });

  it('show an error as Node would, its own fields too', () => {
    const err = Object.assign(new Error('spawn bytesec ENOENT'), { code: 'ENOENT' });
    expect(crashReport('uncaught exception', err)).toContain("code: 'ENOENT'");
  });
});
```

- [ ] **Step 10.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/crash.test.ts`. Expected: the file FAILS to load, with `Error: Cannot find module '../src/crash.js' imported from '…/tests/crash.test.ts'`. `Tests  no tests`.

- [ ] **Step 10.3: Implement.**

Create `src/crash.ts`:

```ts
import { inspect } from 'node:util';
import { redactKnownSecrets } from './secrets.js';

/**
 * A crash's last words, masked (spec §10.1). Left to itself, Node prints an
 * uncaught exception or an unhandled rejection with its message and stack, as
 * they are -- and an error can carry anything: an agent's stderr, a key in a
 * failed request, a run's token. These handlers print it through the masker
 * instead, then exit with 1, the code Node itself exits with for both.
 *
 * Nothing is drained and nothing is closed: after an uncaught error the
 * process's state is unknown, and the next boot reconciles what was running
 * (spec §8.4).
 */

/** What the handlers are installed on: the process, or a test's stand-in. */
export interface CrashSource {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (err: unknown) => void): unknown;
}

/** The one line a crash prints: what happened, and the error as Node would show it, masked. */
export function crashReport(what: string, err: unknown): string {
  return `${what}: ${redactKnownSecrets(inspect(err))}\n`;
}

export function installCrashHandlers(
  source: CrashSource = process,
  write: (text: string) => void = (text) => process.stderr.write(text),
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  const crash = (what: string) => (err: unknown) => {
    try {
      write(crashReport(what, err));
    } catch {
      // Nowhere left to say it; the exit still says something went wrong.
    } finally {
      exit(1);
    }
  };
  source.on('uncaughtException', crash('uncaught exception'));
  source.on('unhandledRejection', crash('unhandled rejection'));
}
```

In `src/main.ts`, replace:

```ts
import { ConfigError } from './config.js';
import { main } from './index.js';
import { redactKnownSecrets } from './secrets.js';
```

with:

```ts
import { ConfigError } from './config.js';
import { installCrashHandlers } from './crash.js';
import { main } from './index.js';
import { redactKnownSecrets } from './secrets.js';
```

In `src/main.ts`, replace:

```ts
 * them once loadTeam has returned, so an error from loadConfig or loadTeam itself
 * comes before any is known.
 */
try {
  await main();
```

with:

```ts
 * them once loadTeam has returned, so an error from loadConfig or loadTeam itself
 * comes before any is known.
 *
 * So is a crash, from the first line: an uncaught exception or an unhandled
 * rejection is printed through the masker, not by Node, and exits 1.
 */
installCrashHandlers();
try {
  await main();
```

- [ ] **Step 10.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1118 passed (1118)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  66 passed (66)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 10.5: Commit.**

```bash
git add src/crash.ts src/main.ts tests/crash.e2e.ts tests/crash.test.ts
git commit -m "Print a crash through the masker, and exit 1, instead of leaving Node to print it unmasked"
```

---

### Task 11: Wiring it into the gateway

**Files:**
- Modify: `src/cli/kanban.ts`, `src/index.ts`, `tests/mt-kanban.test.ts`

Behind `kanban.enabled`, the gateway's service gets the workspaces' directories and the gateway's environment, so its reports run gates and read the commit (Decision 17); Task 6 already passes the socket's signal. `mt kanban` waits 15 minutes for an answer, up from 10, so it outlasts a task's gates together (Decision 3); the wait is exported, and a test holds it to that. The wiring itself is checked by the type checker and, end to end, by Task 13's stack, which is built the same way.

- [ ] **Step 11.1: Write the failing tests.**

In `tests/mt-kanban.test.ts`, replace:

```ts
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { getRun } from '../src/db/kanban-read.js';
import { KanbanService } from '../src/kanban/service.js';
import { listenWorker, type WorkerServer } from '../src/kanban/socket.js';
import { hashToken, mintToken } from '../src/kanban/token.js';
import type { RunRow } from '../src/kanban/types.js';
import { WorkerApi } from '../src/kanban/worker.js';
import { clearSecrets } from '../src/secrets.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
```

with:

```ts
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANSWER_TIMEOUT_MS } from '../src/cli/kanban.js';
import { runMt } from '../src/cli/mt.js';
import { getRun } from '../src/db/kanban-read.js';
import { KanbanService } from '../src/kanban/service.js';
import { listenWorker, type WorkerServer } from '../src/kanban/socket.js';
import { hashToken, mintToken } from '../src/kanban/token.js';
import { GATE_LIMITS, type RunRow } from '../src/kanban/types.js';
import { WorkerApi } from '../src/kanban/worker.js';
import { clearSecrets } from '../src/secrets.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
```

In `tests/mt-kanban.test.ts`, replace:

```ts
  });
});

```

with:

```ts
  });
});

describe('mt kanban: waiting for a report', () => {
  it("waits longer than a task's gates may take together, with a few minutes to spare", () => {
    expect(ANSWER_TIMEOUT_MS).toBeGreaterThanOrEqual(GATE_LIMITS.totalTimeoutS * 1000 + 5 * 60_000);
  });
});

```

- [ ] **Step 11.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-kanban.test.ts`. Expected: the new test FAILS, with `TypeError: actual value must be number or bigint, received "undefined"`: the wait is not exported yet. `Tests  1 failed | 10 passed (11)`.

- [ ] **Step 11.3: Implement.**

In `src/cli/kanban.ts`, replace:

```ts
 */

/** How long to wait for the gateway's answer. A report runs the task's gates from plan C4. */
const ANSWER_TIMEOUT_MS = 10 * 60_000;

const USAGE = `usage: mt kanban <${WORKER_COMMANDS.join('|')}>, with its input as JSON on stdin`;
```

with:

```ts
 */

/**
 * How long to wait for the gateway's answer. A report runs the task's gates first,
 * which may take up to 10 minutes together (GATE_LIMITS.totalTimeoutS), and reads
 * the commit; this leaves room for both.
 */
export const ANSWER_TIMEOUT_MS = 15 * 60_000;

const USAGE = `usage: mt kanban <${WORKER_COMMANDS.join('|')}>, with its input as JSON on stdin`;
```

In `src/index.ts`, replace:

```ts
      workspaces: new Set(team.workspaces.keys()),
      limits: { failureLimit, transientLimit, transientCooldownS },
    });
    const socket = workerSocketPath(config.home);
```

with:

```ts
      workspaces: new Set(team.workspaces.keys()),
      limits: { failureLimit, transientLimit, transientCooldownS },
      // A report runs its task's gates in the workspace, and reads the commit there
      // (spec §7.7, §7.8). They get only what an agent gets of this environment.
      checks: { workspaceDirs: team.workspaces, env: process.env },
    });
    const socket = workerSocketPath(config.home);
```

- [ ] **Step 11.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1119 passed (1119)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 11.5: Commit.**

```bash
git add src/cli/kanban.ts src/index.ts tests/mt-kanban.test.ts
git commit -m "Run gates and read the reported commit in the gateway, and have mt kanban wait 15 minutes for a report's answer"
```

---

### Task 12: The `mt kanban gate` commands

**Files:**
- Create: `src/cli/gate.ts`, `tests/mt-gate.test.ts`
- Modify: `src/cli/mt.ts`, `src/index.ts`, `src/team.ts`

The operator's way to define gates before plan D (Decision 1): `mt kanban gate add <task_id> [--timeout <s>] -- <command…>`, `list <task_id>` and `remove <task_id> <gate_id>`, in `src/cli/gate.ts`. They are not worker commands, and do not use the socket. Each loads the team the way `mt role check` does (`loadTeamSettings`, then `loadTeam`, tolerating `passEnv` names unset in the shell and saying so), registers the secrets this shell can know as the gateway registers them (every role's values, through the new `teamSecrets`, and `LARK_APP_SECRET` if set), opens the gateway's database at the settings' `dbPath` without migrating it, and calls `KanbanService.addGate`, `listGates` or `removeGate`, recording the operator as `operator:<login>`. They refuse in a board run's shell (`MT_KANBAN_RUN` or `MT_KANBAN_TOKEN` set). Two tests open the database twice, as the gateway and the shell would, and show WAL and the busy retry sharing it.

- [ ] **Step 12.1: Write the failing tests.**

Create `tests/mt-gate.test.ts`:

```ts
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTask } from '../src/db/kanban.js';
import { eventsOf, gatesOf } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { KanbanService } from '../src/kanban/service.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { ALICE, NOW, VIA } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * `mt kanban gate`: an operator defining gates from a shell, in the gateway's
 * own database, through the board's service, beside a gateway that has it open.
 */

let f: MtFixture;
/** The gateway's connection to its database. */
let gateway: Db;
let taskId: string;
const ME = `operator:${userInfo().username}`;

beforeEach(() => {
  clearSecrets();
  f = mtFixture((workspace) =>
    [
      `workspace: ${workspace}`,
      'agent:',
      '  driver: structured-cli',
      '  command: bytesec',
      '  unsupervised: true',
      '  passEnv: [API_KEY]',
      '',
    ].join('\n'),
  );
  gateway = openDb(join(f.home, 'gateway.db'));
  migrate(gateway, SCHEMA_DIR);
  const r = createTask(gateway, { title: 'a task', workspace: 'default', createdBy: ALICE, createdVia: VIA }, NOW);
  if (!r.ok) throw new Error(r.message);
  taskId = r.task.taskId;
});
afterEach(() => {
  clearSecrets();
  gateway.close();
  f.cleanup();
});

/** As the operator's shell runs it: a made-up home, and the role's key set. */
function mt(argv: string[], env: Record<string, string | undefined> = {}) {
  return f.run(['kanban', 'gate', ...argv], { env: { HOME: f.root, API_KEY: 'sk-live-1234567890', ...env } });
}

describe('mt kanban gate', () => {
  it('adds, lists and removes a gate, as the operator, in the database the gateway has open', async () => {
    const added = await mt(['add', taskId, '--timeout', '120', '--', 'npm', 'test', '--', '--grep', 'parser']);
    expect(added).toMatchObject({ code: 0, err: '' });
    const [gate] = gatesOf(gateway, taskId);
    expect(gate).toMatchObject({ command: 'npm test -- --grep parser', timeoutS: 120, createdBy: ME });
    expect(added.out).toBe(`added gate ${gate?.id}: npm test -- --grep parser (up to 120 s) to task ${taskId}`);

    expect(await mt(['list', taskId])).toEqual({
      code: 0,
      out: [
        `id  timeout  defined by${' '.repeat(ME.length - 10)}  command`,
        `${gate?.id}   120 s    ${ME}  npm test -- --grep parser`,
      ].join('\n'),
      err: '',
    });
    expect(await mt(['remove', taskId, String(gate?.id)])).toMatchObject({
      code: 0,
      out: `removed gate ${gate?.id}: npm test -- --grep parser (up to 120 s) from task ${taskId}`,
    });
    expect(gatesOf(gateway, taskId)).toEqual([]);
    expect(eventsOf(gateway, taskId).map((e) => [e.kind, e.actor])).toEqual([
      ['created', ALICE],
      ['gate_added', ME],
      ['gate_removed', ME],
    ]);
    expect(await mt(['list', taskId])).toMatchObject({ code: 0, out: `task ${taskId} has no gates` });
  });

  it("refuses a command holding a secret the gateway knows: a role's value, or the Lark app secret", async () => {
    expect(await mt(['add', taskId, '--', 'curl', '-H', 'k:sk-live-1234567890'])).toMatchObject({
      code: 1,
      err: expect.stringContaining("mt: the gate's command holds a known secret"),
    });
    const lark = await mt(['add', taskId, '--', 'echo', 'lark-secret-123'], { LARK_APP_SECRET: 'lark-secret-123' });
    expect(lark).toMatchObject({ code: 1 });
    expect(gatesOf(gateway, taskId)).toEqual([]);
  });

  it('says which of the role environment it could not check, when a passEnv name is unset in this shell', async () => {
    const r = await mt(['add', taskId, '--', 'npm', 'test'], { API_KEY: undefined });
    expect(r).toMatchObject({ code: 0 });
    expect(r.err).toBe('mt: default: API_KEY not set in this shell, so a gate holding those values cannot be refused here');
  });

  it("refuses in a board run's shell: gates are an operator's", async () => {
    for (const name of ['MT_KANBAN_RUN', 'MT_KANBAN_TOKEN']) {
      expect(await mt(['add', taskId, '--', 'true'], { [name]: 'set' })).toEqual({
        code: 1,
        out: '',
        err:
          "mt: mt kanban gate add is an operator's command, not a board run's: this shell has MT_KANBAN_RUN or " +
          'MT_KANBAN_TOKEN set. Run it from your own shell',
      });
    }
    expect(gatesOf(gateway, taskId)).toEqual([]);
  });

  it("refuses what the board refuses, and a missing board, with exit 1", async () => {
    expect(await mt(['add', taskId, '--timeout', '601', '--', 'true'])).toMatchObject({ code: 1 });
    expect(await mt(['add', 'k_missing', '--', 'true'])).toMatchObject({ code: 1, err: 'mt: no task k_missing' });
    expect(await mt(['remove', taskId, '7'])).toMatchObject({ code: 1, err: `mt: task ${taskId} has no gate 7` });
    gateway.close();
    f.cleanup();
    f = mtFixture();
    gateway = openDb(join(f.root, 'unused.db'));
    expect(await mt(['list', 'k_1'])).toMatchObject({
      code: 1,
      err: `mt: there is no board at ${join(f.home, 'gateway.db')}: the gateway creates its database when it first starts`,
    });
  });

  it('answers a wrong command line with exit 2', async () => {
    for (const argv of [
      ['add', taskId],
      ['add', taskId, '--timeout', 'soon', '--', 'true'],
      ['remove', taskId, 'one'],
      ['list'],
      ['rename', taskId],
    ]) {
      expect((await mt(argv)).code).toBe(2);
    }
  });
});

describe('the board shared with a running gateway', () => {
  it("writes beside the gateway's reads, which see it at once", () => {
    const shell = openDb(join(f.home, 'gateway.db'));
    try {
      gateway.exec('BEGIN');
      expect(gatesOf(gateway, taskId)).toEqual([]);
      const s = new KanbanService({ db: shell, roles: new Map(), workspaces: new Set(['default']) });
      expect(s.addGate(taskId, { command: 'npm test' }, ME).ok).toBe(true);
      gateway.exec('COMMIT');
      expect(gatesOf(gateway, taskId).map((g) => g.command)).toEqual(['npm test']);
    } finally {
      shell.close();
    }
  });

  it("waits out the gateway's write, retrying, and writes nothing if it never ends", () => {
    const shell = openDb(join(f.home, 'gateway.db'));
    try {
      shell.pragma('busy_timeout = 5');
      const s = new KanbanService({ db: shell, roles: new Map(), workspaces: new Set(['default']) });
      gateway.exec('BEGIN IMMEDIATE');
      expect(() => s.addGate(taskId, { command: 'npm test' }, ME)).toThrow(/database is locked/);
      gateway.exec('COMMIT');
      expect(gatesOf(gateway, taskId)).toEqual([]);
      expect(s.addGate(taskId, { command: 'npm test' }, ME).ok).toBe(true);
    } finally {
      shell.close();
    }
  });
});
```

- [ ] **Step 12.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-gate.test.ts`. Expected: the five that run a gate command FAIL, each with exit 2 where it expects 0 or 1 (`AssertionError: expected { code: 2, …(2) } to match object { code: +0, err: '' }` and the like): `mt` does not know `kanban gate` yet, and the worker CLI answers it as a wrong command line. The exit-2 test and the two that use the service directly pass already. `Tests  5 failed | 3 passed (8)`.

- [ ] **Step 12.3: Implement.**

Create `src/cli/gate.ts`:

```ts
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { loadTeamSettings } from '../config.js';
import { openDb } from '../db/open.js';
import { KanbanService } from '../kanban/service.js';
import type { GateRow } from '../kanban/types.js';
import { addSecrets } from '../secrets.js';
import { loadTeam, teamSecrets } from '../team.js';
import { refuse, table, type MtIo } from './mt.js';

/**
 * `mt kanban gate add|list|remove` (spec §2.6, §7.7): an operator defining a
 * task's gates, from a shell, before the board is in chat.
 *
 * The one exception to "mt only writes files": these write the board's database,
 * as a second process beside a running gateway, and always through
 * `KanbanService`, the same calls chat's `/kanban gate` makes (plan D), so every
 * rule holds -- the limits, and the refusal of a command holding a known secret.
 * SQLite in WAL mode lets the two share the file: the gateway's reads never wait
 * on this, and a write that meets the gateway's waits and retries, as the
 * gateway's own writers do (`txImmediate`).
 *
 * The secrets checked are the ones this shell can know, registered as the
 * gateway registers them: every role's environment values, and the Lark app
 * secret when `LARK_APP_SECRET` is set here. A `passEnv` name unset in this shell
 * is said to be unchecked.
 *
 * **Not a security boundary.** They refuse a board run's environment
 * (`MT_KANBAN_RUN`, `MT_KANBAN_TOKEN`), so an agent does not define gates by
 * accident. An agent runs as the operator's user and could unset those, as it
 * could already edit config.yaml or a role's files.
 */

/** Who defined a gate from a shell: the operator, by their login. */
export function operatorName(io: MtIo): string {
  let login: string | undefined;
  try {
    login = userInfo().username;
  } catch {
    login = io.env['USER'];
  }
  return `operator:${login === undefined || login === '' ? 'unknown' : login}`;
}

interface Board {
  service: KanbanService;
  close(): void;
}

/** The board, as the gateway's own service over its database; or why not, already said. */
function openBoard(io: MtIo, what: string): Board | number {
  if (io.env['MT_KANBAN_RUN'] !== undefined || io.env['MT_KANBAN_TOKEN'] !== undefined) {
    return refuse(
      io,
      `${what} is an operator's command, not a board run's: this shell has MT_KANBAN_RUN or MT_KANBAN_TOKEN set. ` +
        'Run it from your own shell',
    );
  }
  const unset: string[] = [];
  const settings = loadTeamSettings(io.env, undefined, { unsetPassEnv: unset });
  const team = loadTeam(settings, io.env, { unsetPassEnv: unset });
  const lark = io.env['LARK_APP_SECRET'];
  addSecrets([...(lark === undefined || lark === '' ? [] : [lark]), ...teamSecrets(team)]);
  if (unset.length > 0) {
    io.err(`mt: ${unset.join(', ')} not set in this shell, so a gate holding those values cannot be refused here`);
  }
  if (!existsSync(settings.dbPath)) {
    return refuse(io, `there is no board at ${settings.dbPath}: the gateway creates its database when it first starts`);
  }
  const db = openDb(settings.dbPath);
  const migrated = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kanban_gates'").get();
  if (migrated === undefined) {
    db.close();
    return refuse(io, `the database at ${settings.dbPath} has no board yet: start the gateway once, so it is migrated`);
  }
  const service = new KanbanService({ db, roles: team.roles, workspaces: new Set(team.workspaces.keys()) });
  return { service, close: () => db.close() };
}

/** A write the gateway held the lock through, every retry: not this command's fault. */
function busy(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'SQLITE_BUSY' || (err instanceof Error && err.message.startsWith('write contention'));
}

function withBoard(io: MtIo, what: string, fn: (b: Board) => number): number {
  const board = openBoard(io, what);
  if (typeof board === 'number') return board;
  try {
    return fn(board);
  } catch (err) {
    if (busy(err)) return refuse(io, 'the board is busy: the gateway kept its database locked; try again');
    throw err;
  } finally {
    board.close();
  }
}

function describe(g: GateRow): string {
  return `gate ${g.id}: ${g.command} (up to ${g.timeoutS} s)`;
}

/** `mt kanban gate add <task_id> [--timeout <s>] -- <command…>`. */
export function gateAdd(taskId: string, command: string, timeoutS: number | undefined, io: MtIo): number {
  return withBoard(io, 'mt kanban gate add', ({ service }) => {
    const r = service.addGate(taskId, { command, ...(timeoutS === undefined ? {} : { timeoutS }) }, operatorName(io));
    if (!r.ok) return refuse(io, r.message);
    io.out(`added ${describe(r.gate)} to task ${taskId}`);
    return 0;
  });
}

/** `mt kanban gate list <task_id>`. */
export function gateList(taskId: string, io: MtIo): number {
  return withBoard(io, 'mt kanban gate list', ({ service }) => {
    const r = service.listGates(taskId);
    if (!r.ok) return refuse(io, r.message);
    if (r.gates.length === 0) {
      io.out(`task ${taskId} has no gates`);
      return 0;
    }
    const rows = r.gates.map((g) => [String(g.id), `${g.timeoutS} s`, g.createdBy, g.command]);
    for (const line of table([['id', 'timeout', 'defined by', 'command'], ...rows])) io.out(line);
    return 0;
  });
}

/** `mt kanban gate remove <task_id> <gate_id>`. */
export function gateRemove(taskId: string, gateId: number, io: MtIo): number {
  return withBoard(io, 'mt kanban gate remove', ({ service }) => {
    const r = service.removeGate(taskId, gateId, operatorName(io));
    if (!r.ok) return refuse(io, r.message);
    io.out(`removed ${describe(r.gate)} from task ${taskId}`);
    return 0;
  });
}
```

In `src/cli/mt.ts`, replace:

```ts
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { ConfigError, type Env } from '../config.js';
import { kanbanCommand } from './kanban.js';
import { roleCheck, roleCreate, roleList } from './role.js';
```

with:

```ts
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { ConfigError, type Env } from '../config.js';
import { gateAdd, gateList, gateRemove } from './gate.js';
import { kanbanCommand } from './kanban.js';
import { roleCheck, roleCreate, roleList } from './role.js';
```

In `src/cli/mt.ts`, replace:

```ts
 * `mt kanban` is the one that talks to the gateway, through its socket, and only
 * with the authority of a run's token, from the run's environment.
 */

```

with:

```ts
 * `mt kanban` is the one that talks to the gateway, through its socket, and only
 * with the authority of a run's token, from the run's environment.
 *
 * `mt kanban gate` is the operator's, and the one exception to writing files
 * only: it writes the board's database, through the board's own service (spec §7.7).
 */

```

In `src/cli/mt.ts`, replace:

```ts
  '  mt workspace list',
  '  mt kanban <show|complete|review|changes|block|comment|create|link> < input.json',
].join('\n');

```

with:

```ts
  '  mt workspace list',
  '  mt kanban <show|complete|review|changes|block|comment|create|link> < input.json',
  '  mt kanban gate add <task_id> [--timeout <s>] -- <command...>',
  '  mt kanban gate list <task_id>',
  '  mt kanban gate remove <task_id> <gate_id>',
].join('\n');

```

In `src/cli/mt.ts`, replace:

```ts
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd());
}

```

with:

```ts
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd());
}

/** `mt kanban gate …`: the operator's gate commands. A command's words are joined with spaces, as ssh joins them. */
function gate(argv: readonly string[], io: MtIo): number {
  const [sub, ...args] = argv;
  if (sub === 'add') {
    const { values, positionals } = parse(args, { timeout: { type: 'string' } });
    const [taskId, ...words] = positionals;
    if (taskId === undefined || words.length === 0) {
      throw new UsageError('kanban gate add takes a task id, then -- and the command');
    }
    const timeout = values.timeout;
    if (timeout !== undefined && !/^[0-9]+$/.test(timeout)) throw new UsageError('--timeout is a whole number of seconds');
    return gateAdd(taskId, words.join(' '), timeout === undefined ? undefined : Number(timeout), io);
  }
  if (sub === 'list') {
    const [taskId, extra] = parse(args, {}).positionals;
    if (taskId === undefined || extra !== undefined) throw new UsageError('kanban gate list takes a task id');
    return gateList(taskId, io);
  }
  if (sub === 'remove') {
    const [taskId, gateId, extra] = parse(args, {}).positionals;
    if (taskId === undefined || gateId === undefined || extra !== undefined || !/^[0-9]+$/.test(gateId)) {
      throw new UsageError('kanban gate remove takes a task id and a gate id');
    }
    return gateRemove(taskId, Number(gateId), io);
  }
  throw new UsageError('kanban gate takes add, list or remove');
}

```

In `src/cli/mt.ts`, replace:

```ts
      return await workspaceAdd(name, path === undefined ? { cloneUrl: values.clone ?? '' } : { path }, io);
    }
    if (group === 'kanban') return await kanbanCommand(command, rest, io);
    if (group === 'workspace' && command === 'list') {
```

with:

```ts
      return await workspaceAdd(name, path === undefined ? { cloneUrl: values.clone ?? '' } : { path }, io);
    }
    if (group === 'kanban' && command === 'gate') return gate(rest, io);
    if (group === 'kanban') return await kanbanCommand(command, rest, io);
    if (group === 'workspace' && command === 'list') {
```

In `src/index.ts`, replace:

```ts
import { dirname, join } from 'node:path';
import { ConfigError, loadConfig, type GatewayConfig } from './config.js';
import { loadTeam, type Team } from './team.js';
import { migrate, openDb, type Db } from './db/open.js';
import { sweepSeen } from './db/dedup.js';
```

with:

```ts
import { dirname, join } from 'node:path';
import { ConfigError, loadConfig, type GatewayConfig } from './config.js';
import { loadTeam, teamSecrets, type Team } from './team.js';
import { migrate, openDb, type Db } from './db/open.js';
import { sweepSeen } from './db/dedup.js';
```

In `src/index.ts`, replace:

```ts
 */
export function registerConfiguredSecrets(config: GatewayConfig, team: Team): void {
  addSecrets([config.lark.appSecret, ...[...team.roles.values()].flatMap((role) => role.secretValues)]);
}

```

with:

```ts
 */
export function registerConfiguredSecrets(config: GatewayConfig, team: Team): void {
  addSecrets([config.lark.appSecret, ...teamSecrets(team)]);
}

```

In `src/team.ts`, replace:

```ts
  /** For the operator's log: entries under roles/ that were ignored, and why. */
  notes: readonly string[];
}

```

with:

```ts
  /** For the operator's log: entries under roles/ that were ignored, and why. */
  notes: readonly string[];
}

/**
 * Every secret value the team gives its agents, for the masker (spec §10.1): each
 * role's, less its maskExempt names. The gateway adds its Lark secret to these.
 */
export function teamSecrets(team: Team): string[] {
  return [...team.roles.values()].flatMap((role) => role.secretValues);
}

```

- [ ] **Step 12.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1127 passed (1127)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 12.5: Commit.**

```bash
git add src/cli/gate.ts src/cli/mt.ts src/index.ts src/team.ts tests/mt-gate.test.ts
git commit -m "Let an operator add, list and remove a task's gates with mt kanban gate, through the board's own service"
```

---

### Task 13: End to end: a real gate refuses a report, then passes

**Files:**
- Modify: `tests/fakes/cli-agent.mjs`, `tests/kanban-worker.e2e.ts`

C4's proof (spec §11, "Worker CLI" and "Reported commit"): the real dispatcher runs a task whose agent is a real process, the fake CLI agent through the real CLI driver, in a workspace that is a real git repository. The task has a real gate, `test -f gate-ok && echo …`. The agent runs `mt kanban complete` by name, through the shim and the real socket; the gate refuses it with its command and exit code; the agent writes `gate-ok` and reports again; the gate passes. The gate's output shows it had its role's key, neither the run's token nor its socket, and the gateway's own `PATH` without the `mt` shim's directory; and the run records the repository's `HEAD` and that the tree had uncommitted changes, the file the agent wrote.

- [ ] **Step 13.1: Write the test.**

In `tests/fakes/cli-agent.mjs`, replace:

```js
 *   kanban-late the same, but only once it has been nudged; before that it
 *               narrates its next step and stops without reporting
 *
 * Every invocation appends its argv to `FAKE_CLI_LOG` as one JSON line. That file
```

with:

```js
 *   kanban-late the same, but only once it has been nudged; before that it
 *               narrates its next step and stops without reporting
 *   kanban-gated report `mt kanban complete`, which the task's gate refuses until a
 *               file `gate-ok` is in the workspace; then write it and report again
 *
 * Every invocation appends its argv to `FAKE_CLI_LOG` as one JSON line. That file
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

  case 'kanban-gated': {
    const first = mt('complete', { summary: 'first try' });
    // The agent's cwd is the task's workspace.
    writeFileSync('gate-ok', '');
    const second = mt('complete', { summary: 'gate fixed' });
    delta(`first: ${first.answer}\nsecond: ${second.answer}`);
    summary('completed', 'reported twice');
    break;
  }

  case 'kanban-late': {
    if (prompt.includes('reminder 1 of')) {
```

In `tests/kanban-worker.e2e.ts`, replace:

```ts
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

with:

```ts
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

In `tests/kanban-worker.e2e.ts`, replace:

```ts
import { createCliDriver } from '../src/driver/cli/driver.js';
import type { Driver } from '../src/driver/types.js';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import { Dispatcher } from '../src/kanban/dispatcher.js';
import { KanbanService } from '../src/kanban/service.js';
```

with:

```ts
import { createCliDriver } from '../src/driver/cli/driver.js';
import type { Driver } from '../src/driver/types.js';
import { eventsOf, getTask, runsOf } from '../src/db/kanban-read.js';
import { Dispatcher } from '../src/kanban/dispatcher.js';
import { KanbanService } from '../src/kanban/service.js';
```

In `tests/kanban-worker.e2e.ts`, replace:

```ts
});

async function build(mode: string): Promise<Stack> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-e2e-')));
  const home = join(dir, 'home');
```

with:

```ts
});

/** `gated`: the service runs gates and reads commits, for real, and the role's agent has a key a gate can see. */
async function build(mode: string, opts: { gated?: boolean } = {}): Promise<Stack> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-e2e-')));
  const home = join(dir, 'home');
```

In `tests/kanban-worker.e2e.ts`, replace:

```ts
  const log = join(dir, 'invocations.log');
  const t = testDb();
  const roles = new Map([['implementer', role('implementer')]]);
  const service = new KanbanService({ db: t.db, roles, workspaces: new Set(['default']) });
  const drivers = new Map<string, Driver>([
    ['implementer', createCliDriver({ command: process.execPath, args: [AGENT], env: { FAKE_CLI_MODE: mode, FAKE_CLI_LOG: log } })],
```

with:

```ts
  const log = join(dir, 'invocations.log');
  const t = testDb();
  const implementer = role('implementer');
  const roles = new Map([
    [
      'implementer',
      opts.gated === true ? { ...implementer, agent: { ...implementer.agent, env: { GATE_KEY: 'from-the-role' } } } : implementer,
    ],
  ]);
  const service = new KanbanService({
    db: t.db,
    roles,
    workspaces: new Set(['default']),
    // A made-up home, so git reads no configuration of the real one.
    ...(opts.gated === true
      ? { checks: { workspaceDirs: new Map([['default', workspace]]), env: { PATH: process.env['PATH'], HOME: home } } }
      : {}),
  });
  const drivers = new Map<string, Driver>([
    ['implementer', createCliDriver({ command: process.execPath, args: [AGENT], env: { FAKE_CLI_MODE: mode, FAKE_CLI_LOG: log } })],
```

In `tests/kanban-worker.e2e.ts`, replace:

```ts
  const d = dispatcher;
  const api = new WorkerApi({ db: t.db, service, changed: () => d.pass() });
  const server = await listenWorker(socket, (request) => api.handle(request));
  stack = {
    t,
```

with:

```ts
  const d = dispatcher;
  const api = new WorkerApi({ db: t.db, service, changed: () => d.pass() });
  const server = await listenWorker(socket, (request, signal) => api.handle(request, { signal }));
  stack = {
    t,
```

In `tests/kanban-worker.e2e.ts`, replace:

```ts
  });

  it('an agent that stops without reporting is nudged in its own session, and then reports', async () => {
    const s = await build('kanban-late');
```

with:

```ts
  });

  it("an agent's report runs the task's gate in the workspace, and is refused until it passes", async () => {
    const s = await build('kanban-gated', { gated: true });
    const env = { PATH: process.env['PATH'], HOME: join(s.dir, 'home'), GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: s.workspace, env, encoding: 'utf8' })
        .stdout.trim();
    git('init', '-q');
    writeFileSync(join(s.workspace, 'README'), 'a repository\n');
    git('add', 'README');
    git('commit', '-q', '-m', 'first');
    const head = git('rev-parse', 'HEAD');
    const taskId = create(s, 'Make the gate pass');
    const gate =
      'test -f gate-ok && echo "key=$GATE_KEY token=${MT_KANBAN_TOKEN:-none} socket=${MT_KANBAN_SOCKET:-none}" && echo "path=$PATH"';
    expect(s.service.addGate(taskId, { command: gate, timeoutS: 30 }, ALICE).ok).toBe(true);

    s.dispatcher.pass();
    await s.dispatcher.idle();

    const [run] = runsOf(s.t.db, taskId);
    expect(getTask(s.t.db, taskId)?.phase).toBe('done');
    // The commit it reported on, and the file the agent left uncommitted.
    expect(run).toMatchObject({ outcome: 'completed', summary: 'gate fixed', reportedCommit: head, reportedDirty: true });
    // What the agent was told, each time.
    const [first, second] = lastTurnOf(s.t.db, run?.sessionId ?? '')
      .output.split('\n')
      .map((line) => JSON.parse(line.slice(line.indexOf(' ') + 1)) as unknown);
    expect(first).toEqual({
      ok: false,
      code: 'gate_failed',
      message: `gate ${JSON.stringify(gate)} exited 1; the report was not applied: fix it and report again`,
      gate: { command: gate, exit_code: 1, signal: null, timed_out: false, output: '' },
    });
    expect(second).toEqual({ ok: true, task_id: taskId, phase: 'done', outcome: 'completed' });
    // Each run of the gate recorded; the one that passed had the role's key, and neither the token nor the socket.
    const ran = eventsOf(s.t.db, taskId).filter((e) => e.kind === 'gates_ran');
    expect(ran.map((e) => (e.payload as { passed: boolean }).passed)).toEqual([false, true]);
    const [passed] = (ran[1]?.payload as { results: Array<{ exitCode: number; output: string }> }).results;
    expect(passed?.exitCode).toBe(0);
    const [said, path] = (passed?.output ?? '').split('\n');
    expect(said).toBe('key=from-the-role token=none socket=none');
    // The gateway's own PATH, never a run's: the mt shim's directory is not on it.
    expect(path).toBe(`path=${process.env['PATH'] ?? ''}`);
    expect(path?.split(':')).not.toContain(join(s.dir, 'home', 'bin'));
  });

  it('an agent that stops without reporting is nudged in its own session, and then reports', async () => {
    const s = await build('kanban-late');
```

- [ ] **Step 13.2: Run it to verify it passes.** Every piece it uses exists after Task 12, so this test is the integration check rather than a driver of new code. Run `npx vitest run --project e2e tests/kanban-worker.e2e.ts`. Expected: `Tests  3 passed (3)`. To see it fail first, give the stack's service no workspace directories: in `build`, change `workspaceDirs: new Map([['default', workspace]])` to `workspaceDirs: new Map()`. Expected: the new test FAILS, with `AssertionError: expected 'blocked' to be 'done' // Object.is equality`: both reports are refused as `gates_cannot_run`, the nudges run out and the task gives up. `Tests  1 failed | 2 passed (3)`. Change it back.

- [ ] **Step 13.3: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1127 passed (1127)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  67 passed (67)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 13.4: Commit.**

```bash
git add tests/fakes/cli-agent.mjs tests/kanban-worker.e2e.ts
git commit -m "End to end: a fake agent's report is refused by a real gate, and accepted once it passes"
```

---

### Task 14: The README

**Files:**
- Modify: `README.md`

Gates, what they run with, their limits, the secret refusal, the reported commit and the longer wait, in the `mt kanban` section; and the `mt kanban gate` commands, the one exception to `mt` writing files only, with the accident guard and why it is not a security boundary.

- [ ] **Step 14.1: Edit.**

In `README.md`, replace:

````md
mt workspace list
mt kanban <show|complete|review|changes|block|comment|create|link> < input.json
```

The role and workspace commands find the home, config file and database the way the gateway
does (`MT_HOME`, `MT_CONFIG`, `MT_DB`), from the shell they run in, and need no Lark settings.
They only write files and never contact the gateway; changes take effect at the next start.

- `role create` writes `config.yaml` (from the role `default`, or `--clone-from`), a starter
````

with:

````md
mt workspace list
mt kanban <show|complete|review|changes|block|comment|create|link> < input.json
mt kanban gate add <task_id> [--timeout <s>] -- <command...>
mt kanban gate list <task_id>
mt kanban gate remove <task_id> <gate_id>
```

The role, workspace and gate commands find the home, config file and database the way the
gateway does (`MT_HOME`, `MT_CONFIG`, `MT_DB`), from the shell they run in, and need no Lark
settings. The role and workspace commands only write files and never contact the gateway;
changes take effect at the next start. The gate commands are the one exception: they write the
board's database, beside a running gateway, through the board's own service, and take effect
at once.

- `role create` writes `config.yaml` (from the role `default`, or `--clone-from`), a starter
````

In `README.md`, replace:

```md
  With `kanban.enabled`, the gateway also holds `$MT_HOME/run/gateway.pid` while it runs, and
  refuses to start on a home whose lock names another live process.

### Chat commands
```

with:

```md
  With `kanban.enabled`, the gateway also holds `$MT_HOME/run/gateway.pid` while it runs, and
  refuses to start on a home whose lock names another live process.
- A task may have **gates**: shell commands that must exit 0, in the task's workspace, before
  `complete` or `review` is accepted. A failing gate refuses the report with its command, exit
  code and the end of its output, masked, and the agent can fix it and report again. Gates run
  as the gateway's user with the environment of the role of the task's latest agent run, never
  with a run's token or socket, for up to 600 s each and 600 s together, so `mt kanban` waits
  up to 15 minutes for an answer. A gate whose command holds a known secret is refused: put
  the value in the role's `.env` or `agent.passEnv`, and name it in the command. Defining gates
  is an operator's action: `mt kanban gate add` (the command's words after `--` are joined with
  spaces; quote it to keep its own quoting), `list` and `remove`, which record you as
  `operator:<your login>`. They check the secrets this shell knows: every role's values, and
  the Lark app secret if `LARK_APP_SECRET` is set here. They refuse to run in a board run's
  shell, where `MT_KANBAN_RUN` or `MT_KANBAN_TOKEN` is set, so an agent does not define gates by
  accident; that is not a security boundary, since an agent runs as your user and could unset
  them, as it could edit `config.yaml` or a role's files. When an agent reports
  `complete` or `review`, the gateway also records its workspace's `HEAD`, and whether the tree
  had uncommitted changes.

### Chat commands
```

- [ ] **Step 14.2: Check.** Run `git grep -n -i "p[g]w" -- . ':!package-lock.json'`. Expected: no output. Run `npm test 2>&1 | tail -4`. Expected: `Tests  1127 passed (1127)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  67 passed (67)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 14.3: Commit.**

```bash
git add README.md
git commit -m "Document gates, the reported commit and the longer wait in the README"
```

---

## Review follow-ups

The review of the finished plan found the following, fixed after Task 14, each test first. The task steps above show the code as first written; the code and tests in the tree are the corrected ones.

- **A gate's output is safe at the raw window's cut** (I1). `spawnGate` keeps the last 64 KiB of a gate's output before masking, and a cut through a secret left its end unmasked. `rawTail` (`src/kanban/gates.ts`) now drops, when the window was cut, leading text that is the end of a known secret, through `withholdSecretSuffix`, the mirror of `withholdSecretPrefix` in `src/secrets.ts`, and starts the window with `[earlier output cut]`. Tests: a 1000-byte secret printed 70 times, so the edge falls inside one, leaves no 8-byte fragment of it in the stored output, through a runner that starts nothing (`tests/kanban-gates.test.ts`) and through the real one (`tests/kanban-gates.e2e.ts`); `withholdSecretSuffix` has its own cases in `tests/secrets.test.ts`.
- **A backslash-newline cannot hide a secret in a gate** (I2). `holdsSecret` takes `\` and a newline out before the quotes and backslashes, and checks that form with control characters stripped as well. The "escaped, quoted apart or with a control character" test gains a continuation inside double quotes, between single-quoted parts, and with a CRLF and a control character.
- **A claim whose workspace resolves to one running gates is refused** (I3). A task with no workspace of its own skipped the service's check, and its workspace is only resolved inside `board.claim`. The service now passes `reportingIn`, each workspace with a report running its checks and the task reported on, and `board.claim` refuses `not_claimable` once the workspace is resolved, in its transaction (`tests/kanban-report-checks.test.ts`, a person's report in `default` and a task with no workspace).
- **The prompt's last cut keeps the handoff** (I4). The rework's reason and the handoff it revises, or the handoff under review, now come first in the context, before the parents and the attempts, so the cut at the budget, which keeps the start, cannot drop them. Test: 20 gates of 4 KiB commands, the last failing with 64 KiB of output; the body and every contract field past their caps; three attempts, the newest a crashed retry with 40 tool calls. "## Changes requested" survives in the rework prompt, "## For your review" in the review prompt, and both stay within the budget. The existing review test now expects the handoff before the attempts. Spec §7.1 says so.
- **Gate commands are shown masked** (I5, M6). `mt kanban gate list` and the `add`/`remove` lines, and `gates[].command` and `last_gate_run.results[].command` in the worker API's `show`, go through `redactKnownSecrets`: a secret may be registered after its gate was defined (`tests/mt-gate.test.ts`, `tests/kanban-worker.test.ts`, each defining the gate through the service while the registry is empty).
- **A blank author is refused** (M1). `addGate` and `removeGate` refuse a `by` that is blank (`tests/kanban-gates.test.ts`).
- **A signal already aborted stops a gate** (M2). `spawnGate` calls `stop()` after spawning when the signal was aborted before its listener was added (`tests/kanban-gates.e2e.ts`).
- **One report per workspace** (M3). `#report` refuses, `report_in_progress`, a report on another task in a workspace whose report is running its checks: "workspace web is running the gates of a report on another task, k_…; wait for that answer, then report again". The test that ran two reports' gates at once now puts the second task in another workspace. Spec §7.7 says one report per workspace.
- **A runner that throws fails its gate** (M4). `runGates` turns a rejected runner into a failed gate, "the gate could not run: …", which is masked and recorded in `gates_ran` like any other, so the report is refused `gate_failed` and earlier gates' results are kept. It is done in `runGates` rather than `#gates`, so that the gates that had already run keep their results (`tests/kanban-report-checks.test.ts`).
- **The shutdown order** (M5). `registry.closeAll()` ran before `workerServer.close()`. That decided no run already, as `dispatcher.stop()` comes first and `#turnEnded` returns once the dispatcher is stopped; but the report was told of the stop only after its agent was gone. `stop()` now closes the worker socket, aborting and answering reports, right after the dispatcher and inbound stop, then disconnects, closes the sessions, drains the dispatcher and closes the database. The dispatcher's drain was not moved before the sessions' close, as suggested: its in-flight work includes every live turn, so it would wait out its whole bound on every shutdown with a run open. `tests/kanban-dispatch-gates.test.ts` stops a dispatcher while a report holds the gates, in both orders, with the agent's turn ending `failed` as a killed process's does, and the run stays undecided for the next boot; it fails if `#turnEnded` stops checking `#stopped`. The gateway's own `stop()` is not tested at unit level: it needs a live worker socket, real sessions and a channel.
- **A rework whose rendering cannot be recorded starts fresh** (M7). The dispatcher used the claim's seed when `recordRendering` was refused; it now starts without one (`tests/kanban-dispatch-native.test.ts`, a trigger making `recordRendering` refuse a rework's run).
- **The dispatcher waits on a report by task id** (M8). `RunHandle` carries `taskId`, and `#turnEnded` waits on `open.taskId` as `#drive` waits on `run.taskId`, instead of the binding key's `conversationId`, which holds the same id.
- **A reviewer with no handoff is told what to review** (M9). The review protocol says to review the latest attempts and the workspace when there is no For your review section (`tests/kanban-prompt.test.ts`); spec §7.1 says so.
- **A crash still says what happened** (M10). If formatting the report throws, `${what}: (the error could not be shown)` is written, in its own `try`. The report is written with `fs.writeSync(2, …)`, looping until all of it is taken, and what a synchronous write cannot take goes through `process.stderr.write` (`stderrWriter`, `tests/crash.test.ts`).
- **`mt kanban gate` refuses a database failure in a line** (M11). A failure other than "busy", opening the database or using it, is refused as "the board's database failed: …", masked, exit 1, with no stack (`tests/mt-gate.test.ts`, a trigger whose error holds a role's value).
- **Documented** (README, spec §7.7, §7.8): gates are not a containment boundary, since a gate that detaches with `setsid` can outlive its timeout and go on changing the checkout; a gate added while a report's gates are running is not part of that report, as one removed meanwhile still is; a bare repository reads as having uncommitted changes, a directory inside a repository that is not one itself reports the outer repository's `HEAD`, and the git timeout signals git only, not its children; in `mt kanban gate add`, words before `--` join the command too, so write it after `--`.
- **Known follow-up for plan D:** chat must mask a gate command when it shows one, as `mt kanban gate list` and `show` now do (spec §7.7).
- **Not done:** the "Last gate run" list repeats the commands of the gates that passed, which the gate list above it already shows. Trimming it to the failing gate and a count is a possible later trim.

Counts after the review: `Tests  1144 passed (1144)` unit, `Tests  69 passed (69)` end to end.

The final review found the following Minor items, fixed after those, each behaviour fix test first:

- **A failed gate's command is masked before it is quoted.** The `gate_failed` message quoted the raw command with `JSON.stringify`, and the escaping of a `"` or `\` in a secret stopped the masking of the message from matching it. `#gates` now quotes `redactKnownSecrets(failed.command)` (`tests/kanban-report-checks.test.ts`, a secret holding `"` and `\` registered after its gate was defined: no 8-byte fragment of it, as written or escaped, is in the message).
- **A crash report leaves no part of a secret.** `inspect` cut a string at 10 000 characters before the masking, and escaped `\` and quotes, so a secret could show in part. `crashReport` (`src/crash.ts`) now masks the error's strings value by value first (`maskDeep`: strings, the own enumerable properties of arrays, plain objects and errors, and an error's `message`, `stack`, `cause` and `errors`, recursively, with a cycle mapped to its copy, a getter that inspect would not call copied as it is, and an error field whose getter throws left out), calls `inspect` with `maxStringLength: Infinity`, masks the text again, and only then cuts it at `CRASH_REPORT_CHARS` (64 Ki characters), through `withholdSecretPrefix`, ending it with ` [cut]`. Other objects, a `Map` or a class's instance, are not copied, so only the second masking and the cut cover them. Tests (`tests/crash.test.ts`): a property and a message of 9 990 bytes followed by a secret; a secret holding `\` and both kinds of quotes in a message, a cause, a property, an `AggregateError`'s errors, an object and a bare string; neither leaves an 8-byte fragment, as written or as `inspect` or JSON escapes it. Also a report past the cap whose cut falls inside an escaped secret, and a cycle, a throwing getter and a throwing `stack`. Spec §10.1 says so.
- **Documented** (README, spec §7.7): a task has at most 20 gates, and a gate's command at most 4 KiB (`GATE_LIMITS`). The README now says gates run as the role of the task's latest agent run, or the role `default` if no agent has run, as `#gates` does.
- **The test that kills a gate when the gateway exits waits on what it checks.** The child exits once the gate's pid file is written, polling with a 10 s deadline, instead of after a fixed 500 ms, and the test then polls for `ESRCH` with a 5 s deadline instead of waiting a fixed 200 ms (`tests/kanban-gates.e2e.ts`).
- **Known follow-up for plan D or later: a person's report beside another task's agent.** A person's run does not hold the workspace, so a person's report, from plan D's chat, can run gates in a workspace while another task's agent run is open in it. Plan D must refuse it, for example with `workspace_busy` (spec §7.7).
- **Known follow-up for plan D or later: a run decided while its gates run.** A stop, a timeout, a reassignment or an archive that decides the run does not abort its report's gates: they run on, up to 600 s, holding the workspace, and the report is then refused; a claim refused meanwhile waits for the next sweep (spec §7.7).

Counts after the final review: `Tests  1149 passed (1149)` unit, `Tests  69 passed (69)` end to end.

---


## Done when

- `npm test` gives `Tests  1149 passed (1149)`, after the review follow-ups and those of the final review. `npm run test:e2e` gives `Tests  69 passed (69)`. `npm run typecheck` reports no errors. All of these run under Node 22, in the worktree.
- Only `src/db/kanban.ts` writes a `kanban_` table, and only `src/kanban/service.ts` imports it (the guard in `tests/kanban-service.test.ts`). `src/kanban/worker.ts` and `src/kanban/gates.ts` write nothing.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing.
- No `spawnSync` or `execSync` in `src/kanban/gates.ts`, `src/kanban/commit.ts` or `src/kanban/service.ts` (`git grep -n "Sync(" -- src/kanban/gates.ts src/kanban/commit.ts src/kanban/service.ts` lists only `readFileSync`, `accessSync` and `statSync`).
- A fake agent process, started by the real dispatcher through the real CLI driver, reports `complete` through the real socket; the task's real gate refuses it with its command and exit; the agent fixes the workspace and reports again; the gate passes, with the role's key, neither the run's token nor its socket, and no `mt` shim directory on its `PATH`; and the run records the repository's `HEAD` and that the tree was dirty (`tests/kanban-worker.e2e.ts`).
- An operator adds, lists and removes gates with `mt kanban gate`, beside a running gateway, recorded as `operator:<login>`; a board run's shell is refused (`tests/mt-gate.test.ts`).
- A gate whose command holds a known secret, in any form the shell would run, is refused at creation, through the service and through `mt`. A gate's output is masked where it is stored, prompted and answered.
- A rework resumes the work run's provider session only when both ran from the same native package, or both in the prompt.
- A turn that ends while its report runs the gates is neither nudged nor decided until the report is answered (`tests/kanban-dispatch-gates.test.ts`).
- An uncaught exception and an unhandled rejection are printed masked, and exit 1 (`tests/crash.e2e.ts`).
- With `kanban.enabled` unset, the gateway builds no service, runs no gate and opens no socket.
